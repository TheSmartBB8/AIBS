// threadpool.h - persistent worker pool + parallel_for (used for chunk meshing, particles)
// claiming is mutex-batched: correctness-first, overhead negligible for >=0.1ms jobs
#pragma once
#include <thread>
#include <mutex>
#include <condition_variable>
#include <functional>
#include <vector>
#include <cstdint>

class ThreadPool {
public:
    static ThreadPool& get() {
        static ThreadPool tp;
        return tp;
    }
    int workerCount() const { return (int)workers.size(); }

    // run fn(i) for i in [0, count) across workers + calling thread; blocks until done
    void parallelFor(int count, const std::function<void(int)>& fn) {
        if (count <= 0) return;
        if (count == 1 || workers.empty()) {
            for (int i = 0; i < count; i++) fn(i);
            return;
        }
        {
            std::lock_guard<std::mutex> lk(mtx);
            job = &fn;
            jobCount = count;
            nextIndex = 0;
            pending = count;
            generation++;
        }
        cv.notify_all();
        work();                              // calling thread helps
        std::unique_lock<std::mutex> lk(mtx);
        doneCv.wait(lk, [&] { return pending == 0; });
        job = nullptr;
    }

private:
    ThreadPool() {
        int n = (int)std::thread::hardware_concurrency();
        n = n > 1 ? n - 1 : 0;               // main thread participates too
        if (n > 15) n = 15;
        for (int i = 0; i < n; i++)
            workers.emplace_back([this] { workerLoop(); });
    }
    ~ThreadPool() {
        {
            std::lock_guard<std::mutex> lk(mtx);
            quit = true;
        }
        cv.notify_all();
        for (auto& w : workers) w.join();
    }
    void workerLoop() {
        uint64_t seenGen = 0;
        for (;;) {
            {
                std::unique_lock<std::mutex> lk(mtx);
                cv.wait(lk, [&] { return quit || generation != seenGen; });
                if (quit) return;
                seenGen = generation;
            }
            work();
        }
    }
    void work() {
        const int BATCH = 4;
        for (;;) {
            int i0, i1;
            const std::function<void(int)>* fn;
            {
                std::lock_guard<std::mutex> lk(mtx);
                if (!job || nextIndex >= jobCount) return;
                i0 = nextIndex;
                i1 = std::min(jobCount, i0 + BATCH);
                nextIndex = i1;
                fn = job;
            }
            for (int i = i0; i < i1; i++) (*fn)(i);
            {
                std::lock_guard<std::mutex> lk(mtx);
                pending -= (i1 - i0);
                if (pending == 0) doneCv.notify_all();
            }
        }
    }

    std::vector<std::thread> workers;
    std::mutex mtx;
    std::condition_variable cv, doneCv;
    const std::function<void(int)>* job = nullptr;
    int jobCount = 0, nextIndex = 0, pending = 0;
    uint64_t generation = 0;
    bool quit = false;
};

static inline void parallelFor(int count, const std::function<void(int)>& fn) {
    ThreadPool::get().parallelFor(count, fn);
}
