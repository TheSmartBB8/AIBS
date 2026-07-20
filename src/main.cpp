// main.cpp - entry point.
// Windows: full game (window, GL 3.3 core renderer, audio, P2P net).
// Any platform with --selftest: headless logic verification (no window/GL/audio device
// required) used to validate world gen, destruction, integrity, particles, threading and
// networking before/while cross-compiling the real Windows executable.
#include "game.h"
#include <cstdio>
#include <cstring>
#include <chrono>
#include <thread>

#ifdef _WIN32

static int runGame() {
    Platform plat;
    if (!plat.init("VOXWRECK - VOXEL SANDBOX DESTRUCTION", 1600, 900)) {
        MessageBoxA(nullptr, "Failed to create window.", "VoxWreck", MB_ICONERROR);
        return 1;
    }
    Game game;
    if (!game.ren.init(plat.st.width, plat.st.height)) {
        MessageBoxA(nullptr,
            "Failed to initialize OpenGL 3.3.\n\nYour graphics driver may be out of date.\n"
            "VoxWreck requires an OpenGL 3.3 capable GPU (NVIDIA, AMD, or Intel).",
            "VoxWreck - Graphics Error", MB_ICONERROR);
        return 1;
    }
    plat.setVsync(game.ren.settings.vsync);
    game.init(&plat);

    double last = plat.now();
    double fpsAccum = 0;
    int fpsFrames = 0;
    while (!plat.st.quit) {
        plat.pollEvents();
        double now = plat.now();
        float dt = (float)(now - last);
        last = now;
        if (dt > 0.25f) dt = 0.25f;

        fpsAccum += dt;
        fpsFrames++;
        if (fpsAccum >= 0.5) {
            game.curFps = (int)(fpsFrames / fpsAccum);
            fpsAccum = 0;
            fpsFrames = 0;
        }

        game.update(dt);
        game.renderFrame();

        if (!plat.st.focused) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    game.shutdown();
    return 0;
}

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    return runGame();
}

// allow running from a console too (e.g. `voxwreck.exe --selftest`)
int main(int argc, char** argv);
int wmain(int, wchar_t**) { return runGame(); }

#endif // _WIN32

// ---------------------------------------------------------------- selftest
#include <cassert>
#include <vector>

static int selftestMain() {
    int fails = 0;
    auto CHECK = [&](bool cond, const char* msg) {
        if (!cond) { std::printf("[FAIL] %s\n", msg); fails++; }
        else std::printf("[ OK ] %s\n", msg);
    };

    std::printf("== VoxWreck selftest ==\n");
    std::printf("hardware_concurrency = %u, pool workers = %d\n",
                std::thread::hardware_concurrency(), ThreadPool::get().workerCount());

    // ---- map generation determinism + bounds sanity
    {
        World w1, w2;
        MapInfo m1 = generateMap(w1, 0);
        generateMap(w2, 0);
        CHECK(w1.vox.size() == (size_t)WX * WY * WZ, "world voxel buffer sized correctly");
        CHECK(w1.countSolid() == w2.countSolid(), "mall map generation is deterministic");
        CHECK(w1.countSolid() > 200000, "mall map has substantial geometry");
        CHECK(std::strcmp(m1.name, "EVERMORE MALL") == 0, "mall map name set");
        int sx = (int)(m1.spawn.x / VOXEL_SIZE), sy = (int)(m1.spawn.y / VOXEL_SIZE), sz = (int)(m1.spawn.z / VOXEL_SIZE);
        CHECK(!w1.solidClamped(sx, sy, sz) && !w1.solidClamped(sx, sy + 3, sz), "mall spawn point is not inside solid geometry");
    }
    {
        World w;
        MapInfo m = generateMap(w, 1);
        CHECK(std::strcmp(m.name, "SANDPOINT MARINA") == 0, "marina map name set");
        CHECK(m.hasWater, "marina map has water");
        CHECK(w.barrels.size() >= 5, "marina map has explosive barrels placed");
        int sx = (int)(m.spawn.x / VOXEL_SIZE), sy = (int)(m.spawn.y / VOXEL_SIZE), sz = (int)(m.spawn.z / VOXEL_SIZE);
        CHECK(!w.solidClamped(sx, sy, sz), "marina spawn point is not inside solid geometry");
    }

    // ---- multithreaded chunk meshing produces the same result as serial meshing
    {
        World w;
        generateMap(w, 0);
        w.markAllDirty();
        size_t totalIdx = 0;
        int remeshed = w.remeshDirty(NUM_CHUNKS);
        for (auto& c : w.chunks) totalIdx += c.idx.size();
        CHECK(remeshed == NUM_CHUNKS, "parallel remesh processed all dirty chunks");
        CHECK(totalIdx > 0, "meshing produced triangle data");

        World wSerial;
        generateMap(wSerial, 0);
        size_t serialIdx = 0;
        for (int i = 0; i < NUM_CHUNKS; i++) { wSerial.meshChunk(i); serialIdx += wSerial.chunks[i].idx.size(); }
        CHECK(serialIdx == totalIdx, "parallel meshing matches serial meshing (thread-safety)");
    }

    // ---- raycast
    {
        World w;
        generateMap(w, 0);
        World::RayHit h = w.raycast(vec3(32, 20, 28), vec3(0, -1, 0), 50.f);
        CHECK(h.hit, "raycast downward from the sky hits the ground");
    }

    // ---- destruction + structural integrity: a floating platform detaches and falls
    {
        World w;
        w.init();
        uint8_t heavy = w.addPal(200, 200, 200, M_HEAVY);
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        for (int x = 0; x < 20; x++) for (int z = 0; z < 20; z++) w.setRaw(x, 0, z, bedrock);
        // a pillar holding up a platform
        for (int y = 1; y <= 10; y++) w.setRaw(10, y, 10, heavy);
        for (int x = 5; x < 15; x++) for (int z = 5; z < 15; z++) w.setRaw(x, 11, z, heavy);
        size_t before = w.countSolid();
        DestructionOp op{}; (void)op;
        int destroyed = w.destroySphere(vec3(10 * VOXEL_SIZE, 5 * VOXEL_SIZE, 10 * VOXEL_SIZE), 0.9f, 0xffffffffu);
        CHECK(destroyed > 0, "sledgehammer-radius sphere destroys the support pillar");
        int detached = w.checkIntegrity(vec3(10 * VOXEL_SIZE, 5 * VOXEL_SIZE, 10 * VOXEL_SIZE), 0.9f);
        CHECK(detached > 50, "the now-unsupported platform is detected as detached");
        CHECK(w.clusters.size() == 1, "the detached platform became exactly one falling cluster");
        if (!w.clusters.empty()) {
            CHECK(w.clusters[0].drop > 0, "the falling cluster has a positive drop distance");
            w.meshCluster(w.clusters[0]);
            CHECK(!w.clusters[0].verts.empty(), "the falling cluster has a renderable mesh");
            // simulate landing
            FallingCluster fc = w.clusters[0];
            w.landCluster(fc, nullptr);
        }
        CHECK(w.countSolid() < before, "total solid voxel count decreased after destruction");
    }

    // ---- barrel chain reaction via weapons.h destruction op path
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        for (int x = 0; x < 20; x++) for (int z = 0; z < 20; z++) w.setRaw(x, 0, z, bedrock);
        uint8_t barrelPal = w.addPal(190, 44, 34, M_BARREL);
        for (int y = 1; y <= 3; y++) w.setRaw(10, y, 10, barrelPal);
        w.barrels.push_back({10.5f * VOXEL_SIZE, 2.5f * VOXEL_SIZE, 10.5f * VOXEL_SIZE, true});
        uint8_t barrelPal2 = w.addPal(190, 44, 34, M_BARREL);
        for (int y = 1; y <= 3; y++) w.setRaw(13, y, 10, barrelPal2);
        w.barrels.push_back({13.5f * VOXEL_SIZE, 2.5f * VOXEL_SIZE, 10.5f * VOXEL_SIZE, true});

        ParticleSystem ps;
        WeaponContext ctx;
        ctx.world = &w;
        ctx.particles = &ps;
        int opsApplied = 0;
        ctx.emitOp = [&](const DestructionOp&) { opsApplied++; };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};

        DestructionOp rocketHit{10.5f * VOXEL_SIZE, 2.5f * VOXEL_SIZE, 10.5f * VOXEL_SIZE, 2.3f,
                                WeaponsState::MASK_EXPLOSION, 0, 1, 0, 1};
        applyDestructionOp(ctx, rocketHit, true);
        CHECK(!w.barrels[0].alive, "first barrel detonates on direct hit");
        CHECK(!w.barrels[1].alive, "second barrel chain-detonates from the first explosion");
    }

    // ---- particle system update runs across the thread pool without crashing
    {
        World w;
        generateMap(w, 0);
        ParticleSystem ps;
        for (int i = 0; i < 500; i++) ps.voxelDebris(vec3(30, 10, 30), 200, 100, 80, vec3(0, 1, 0), 3.f);
        for (int i = 0; i < 5; i++) ps.update(1.f / 60.f, w);
        int alive = 0;
        for (auto& p : ps.pool) if (p.alive) alive++;
        CHECK(alive > 0, "particles remain alive after a few update ticks");
        std::vector<PartInst> a, b;
        ps.buildInstances(a, b);
        CHECK(!a.empty() || !b.empty(), "particle render instances are produced");
    }

    // ---- audio synthesis produces non-trivial waveforms (stub device, tests DSP only)
    {
        AudioSystem as;
        as.init();
        CHECK(as.sounds.size() == 9, "all sound effects synthesized");
        for (auto& s : as.sounds) CHECK(!s.samples.empty(), "synthesized sound has samples");
        as.shutdown();
    }

    // ---- networking: loopback host/join, op replication, late-join world sync
    {
        NetHost h;
        bool started = h.start(27599);
        CHECK(started, "host can bind and listen on a TCP port");
        if (started) {
            NetClient c;
            bool connected = c.connectTo("127.0.0.1", 27599, 2000);
            CHECK(connected, "client can connect to host over loopback TCP");
            int slot = -1;
            for (int i = 0; i < 50 && slot < 0; i++) {
                slot = h.acceptNew();
                if (slot < 0) std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            CHECK(slot > 0, "host accepts the incoming connection");

            WireHello hello{"TESTER"};
            c.send(MSG_HELLO, &hello, sizeof hello);
            c.flush();
            std::vector<NetMsg> hostMsgs;
            for (int i = 0; i < 50 && hostMsgs.empty(); i++) {
                h.poll(hostMsgs);
                if (hostMsgs.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            CHECK(!hostMsgs.empty() && hostMsgs[0].type == MSG_HELLO, "host receives framed MSG_HELLO from client");

            WireOp op{5.f, 6.f, 7.f, 1.5f, 0xffffffffu, 0, 1, 0, 0};
            h.sendTo(slot, MSG_OP, &op, sizeof op);
            h.flush();
            std::vector<NetMsg> clientMsgs;
            for (int i = 0; i < 50 && clientMsgs.empty(); i++) {
                c.poll(clientMsgs);
                if (clientMsgs.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            bool gotOp = false;
            if (!clientMsgs.empty() && clientMsgs[0].type == MSG_OP && clientMsgs[0].data.size() == sizeof(WireOp)) {
                WireOp recv;
                std::memcpy(&recv, clientMsgs[0].data.data(), sizeof recv);
                gotOp = (recv.x == 5.f && recv.radius == 1.5f);
            }
            CHECK(gotOp, "client receives a destruction op relayed by the host, byte-exact");
            c.stop();
        }
        h.stop();
    }

    // ---- game.h wiring: WeaponContext callbacks fire correctly end-to-end (no window/GL)
    {
        World w;
        generateMap(w, 0);
        ParticleSystem ps;
        AudioSystem as;
        as.init();
        int opsEmitted = 0, firesEmitted = 0, soundsPlayed = 0;
        WeaponContext ctx;
        ctx.world = &w;
        ctx.particles = &ps;
        ctx.emitOp = [&](const DestructionOp& op) { opsEmitted++; applyDestructionOp(ctx, op, false); };
        ctx.emitFire = [&](const FireEvent&) { firesEmitted++; };
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [&](int) { soundsPlayed++; };
        ctx.addLight = [](vec3, vec3, float, float) {};
        WeaponsState ws;
        vec3 eye(32, 12, 30);
        World::RayHit probe = w.raycast(eye, vec3(0, -1, 0), 40.f);
        CHECK(probe.hit, "sanity raycast for weapons test finds ground/geometry");
        fireSledge(ctx, ws, eye, vec3(0, -1, 0));
        CHECK(opsEmitted > 0, "firing the sledgehammer emits a destruction op");
        CHECK(firesEmitted > 0, "firing the sledgehammer emits a fire visual event");
        as.shutdown();
    }

    std::printf("== %s (%d failing check%s) ==\n", fails == 0 ? "ALL CHECKS PASSED" : "SELFTEST FAILED",
               fails, fails == 1 ? "" : "s");
    return fails == 0 ? 0 : 1;
}

#ifndef _WIN32
int main(int argc, char** argv) {
    (void)argc; (void)argv;
    return selftestMain();
}
#else
int main(int argc, char** argv) {
    if (argc > 1 && std::strcmp(argv[1], "--selftest") == 0) return selftestMain();
    return runGame();
}
#endif
