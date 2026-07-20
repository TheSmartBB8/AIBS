// audio.h - fully synthesized sound effects + software mixer.
// Windows: waveOut on a dedicated mixer thread. Other platforms: silent stub (selftest builds).
#pragma once
#include "vmath.h"
#include <vector>
#include <mutex>
#include <thread>
#include <atomic>
#include <cstring>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#endif

#define AUDIO_RATE 44100

struct Sound { std::vector<float> samples; };   // mono

struct AudioVoice {
    int soundId = -1;
    size_t playhead = 0;
    float gain = 1.f;
    vec3 pos;
    bool positional = false;
    bool active = false;
};

struct AudioSystem {
    std::vector<Sound> sounds;
    AudioVoice voices[24];
    std::mutex mtx;
    vec3 listenerPos, listenerRight;
    float masterVolume = 0.8f;
    std::atomic<bool> quit{false};
    bool ok = false;
#ifdef _WIN32
    std::thread mixThread;
#endif

    // ---------------- synthesis helpers
    static float noise(Rng& r) { return r.sf(); }

    void synthAll() {
        Rng rng(777);
        sounds.resize(9);
        auto& S = sounds;
        // 0 SLEDGE_SWING: whoosh
        {
            int n = AUDIO_RATE / 4;
            S[0].samples.resize(n);
            float lp = 0;
            for (int i = 0; i < n; i++) {
                float t = (float)i / n;
                float env = sinf(t * 3.14159f);
                env *= env;
                float cutoff = 0.04f + 0.10f * (1.f - t);
                lp += cutoff * (noise(rng) - lp);
                S[0].samples[i] = lp * env * 1.6f;
            }
        }
        // 1 SLEDGE_HIT: thud
        {
            int n = AUDIO_RATE / 6;
            S[1].samples.resize(n);
            float lp = 0, br = 0;
            for (int i = 0; i < n; i++) {
                float t = (float)i / n;
                float env = expf(-t * 9.f);
                br = clampf(br + noise(rng) * 0.25f, -1.f, 1.f);
                lp += 0.10f * (br - lp);
                float thump = sinf(6.28318f * 82.f * i / AUDIO_RATE * (1.f - t * 0.4f)) * expf(-t * 14.f);
                S[1].samples[i] = (lp * 1.1f + thump * 0.9f) * env * 2.2f;
            }
        }
        // 2 SHOTGUN: crack + thump
        {
            int n = AUDIO_RATE / 3;
            S[2].samples.resize(n);
            float lp = 0;
            for (int i = 0; i < n; i++) {
                float t = (float)i / n;
                float crack = noise(rng) * expf(-t * 26.f);
                lp += 0.35f * (crack - lp);
                float body = noise(rng) * expf(-t * 8.f) * 0.5f;
                float thump = sinf(6.28318f * 95.f * i / AUDIO_RATE) * expf(-t * 11.f) * 0.8f;
                float v = crack * 0.9f + (crack - lp) * 0.6f + body + thump;
                S[2].samples[i] = clampf(v * 1.9f, -1.4f, 1.4f);
            }
        }
        // 3 ROCKET_FIRE: launch whoosh
        {
            int n = AUDIO_RATE / 2;
            S[3].samples.resize(n);
            float lp = 0;
            for (int i = 0; i < n; i++) {
                float t = (float)i / n;
                float env = expf(-t * 4.5f);
                lp += (0.25f - t * 0.18f) * (noise(rng) - lp);
                float ign = noise(rng) * expf(-t * 30.f) * 0.8f;
                S[3].samples[i] = (lp * 1.5f + ign) * env * 1.8f;
            }
        }
        // 4 EXPLOSION: big rumble
        {
            int n = (int)(AUDIO_RATE * 1.5f);
            S[4].samples.resize(n);
            float br = 0, lp = 0;
            for (int i = 0; i < n; i++) {
                float t = (float)i / n;
                float env = expf(-t * 3.6f) * (t < 0.012f ? t / 0.012f : 1.f);
                br = clampf(br + noise(rng) * 0.4f, -1.f, 1.f);
                float cutoff = 0.16f * expf(-t * 2.6f) + 0.012f;
                lp += cutoff * (br - lp);
                float f = 58.f * expf(-t * 1.8f) + 26.f;
                float sub = sinf(6.28318f * f * i / AUDIO_RATE) * expf(-t * 3.f);
                float crackle = noise(rng) * expf(-t * 7.f) * 0.35f * (noise(rng) > 0.6f ? 1.f : 0.2f);
                float v = (lp * 2.6f + sub * 1.2f + crackle) * env;
                S[4].samples[i] = clampf(v * 1.7f, -1.5f, 1.5f);
            }
        }
        // 5 GLASS: shatter partials
        {
            int n = AUDIO_RATE / 2;
            S[5].samples.resize(n, 0.f);
            for (int p = 0; p < 9; p++) {
                float f = 900.f + rng.uf() * 3800.f;
                float st = rng.uf() * 0.12f;
                float dk = 6.f + rng.uf() * 18.f;
                float ph = rng.uf() * 6.28f;
                for (int i = (int)(st * AUDIO_RATE); i < n; i++) {
                    float t = (float)i / AUDIO_RATE - st;
                    S[5].samples[i] += sinf(6.28318f * f * t + ph) * expf(-t * dk) * 0.16f;
                }
            }
            for (int i = 0; i < n / 20; i++) {
                float t = (float)i / (n / 20.f);
                S[5].samples[i] += noise(rng) * (1.f - t) * 0.4f;
            }
        }
        // 6 DEBRIS: rubble tick
        {
            int n = AUDIO_RATE / 7;
            S[6].samples.resize(n);
            float lp = 0;
            for (int i = 0; i < n; i++) {
                float t = (float)i / n;
                lp += 0.12f * (noise(rng) - lp);
                S[6].samples[i] = lp * expf(-t * 10.f) * 1.5f;
            }
        }
        // 7 CLICK: UI
        {
            int n = AUDIO_RATE / 30;
            S[7].samples.resize(n);
            for (int i = 0; i < n; i++) {
                float t = (float)i / n;
                S[7].samples[i] = sinf(6.28318f * 1900.f * i / (float)AUDIO_RATE) * expf(-t * 18.f) * 0.5f;
            }
        }
        // 8 RELOAD/PUMP: shk-shk
        {
            int n = AUDIO_RATE / 4;
            S[8].samples.resize(n, 0.f);
            for (int c = 0; c < 2; c++) {
                int off = c * AUDIO_RATE / 9;
                float lp = 0;
                for (int i = 0; i < AUDIO_RATE / 24 && off + i < n; i++) {
                    float t = (float)i / (AUDIO_RATE / 24.f);
                    lp += 0.4f * (noise(rng) - lp);
                    S[8].samples[off + i] += (lp + noise(rng) * 0.2f) * expf(-t * 12.f) * 0.9f;
                }
            }
        }
    }

    void play(int id, float gain = 1.f) {
        if (!ok || id < 0 || id >= (int)sounds.size()) return;
        std::lock_guard<std::mutex> lk(mtx);
        for (auto& v : voices)
            if (!v.active) {
                v.active = true; v.soundId = id; v.playhead = 0; v.gain = gain; v.positional = false;
                return;
            }
    }
    void playAt(int id, vec3 pos, float gain = 1.f) {
        if (!ok || id < 0 || id >= (int)sounds.size()) return;
        std::lock_guard<std::mutex> lk(mtx);
        for (auto& v : voices)
            if (!v.active) {
                v.active = true; v.soundId = id; v.playhead = 0; v.gain = gain;
                v.positional = true; v.pos = pos;
                return;
            }
    }
    void setListener(vec3 pos, vec3 right) {
        std::lock_guard<std::mutex> lk(mtx);
        listenerPos = pos; listenerRight = right;
    }

    // mix 'frames' stereo frames into out (interleaved s16)
    void mix(int16_t* out, int frames) {
        std::lock_guard<std::mutex> lk(mtx);
        for (int i = 0; i < frames * 2; i++) out[i] = 0;
        for (auto& v : voices) {
            if (!v.active) continue;
            const Sound& snd = sounds[v.soundId];
            float gl = v.gain, gr = v.gain;
            if (v.positional) {
                vec3 d = v.pos - listenerPos;
                float dist = vlen(d);
                float att = 1.f / (1.f + dist * 0.09f);
                if (dist > 120.f) att = 0.f;
                float pan = dist > 0.01f ? vdot(d / dist, listenerRight) : 0.f;
                gl = v.gain * att * (0.5f - 0.42f * pan + 0.08f);
                gr = v.gain * att * (0.5f + 0.42f * pan + 0.08f);
            } else { gl *= 0.6f; gr *= 0.6f; }
            for (int i = 0; i < frames; i++) {
                if (v.playhead >= snd.samples.size()) { v.active = false; break; }
                float s = snd.samples[v.playhead++];
                int l = out[i * 2] + (int)(s * gl * masterVolume * 20000.f);
                int r = out[i * 2 + 1] + (int)(s * gr * masterVolume * 20000.f);
                out[i * 2] = (int16_t)clampf((float)l, -32700.f, 32700.f);
                out[i * 2 + 1] = (int16_t)clampf((float)r, -32700.f, 32700.f);
            }
        }
    }

#ifdef _WIN32
    HWAVEOUT hwo = nullptr;
    static constexpr int BUF_FRAMES = 1024;
    static constexpr int NUM_BUFS = 4;
    WAVEHDR hdrs[NUM_BUFS] = {};
    int16_t bufs[NUM_BUFS][BUF_FRAMES * 2] = {};
    HANDLE evt = nullptr;

    bool init() {
        synthAll();
        evt = CreateEventA(nullptr, FALSE, FALSE, nullptr);
        WAVEFORMATEX wf = {};
        wf.wFormatTag = WAVE_FORMAT_PCM;
        wf.nChannels = 2;
        wf.nSamplesPerSec = AUDIO_RATE;
        wf.wBitsPerSample = 16;
        wf.nBlockAlign = 4;
        wf.nAvgBytesPerSec = AUDIO_RATE * 4;
        if (waveOutOpen(&hwo, WAVE_MAPPER, &wf, (DWORD_PTR)evt, 0, CALLBACK_EVENT) != MMSYSERR_NOERROR)
            return false;                     // no audio device: stay silent, game still runs
        for (int i = 0; i < NUM_BUFS; i++) {
            hdrs[i].lpData = (LPSTR)bufs[i];
            hdrs[i].dwBufferLength = BUF_FRAMES * 4;
            waveOutPrepareHeader(hwo, &hdrs[i], sizeof(WAVEHDR));
            hdrs[i].dwFlags |= WHDR_DONE;
        }
        ok = true;
        mixThread = std::thread([this] { mixLoop(); });
        return true;
    }
    void mixLoop() {
        while (!quit.load()) {
            bool wrote = false;
            for (int i = 0; i < NUM_BUFS; i++) {
                if (hdrs[i].dwFlags & WHDR_DONE) {
                    hdrs[i].dwFlags &= ~WHDR_DONE;
                    mix(bufs[i], BUF_FRAMES);
                    waveOutWrite(hwo, &hdrs[i], sizeof(WAVEHDR));
                    wrote = true;
                }
            }
            if (!wrote) WaitForSingleObject(evt, 40);
        }
    }
    void shutdown() {
        quit.store(true);
        if (mixThread.joinable()) mixThread.join();
        if (hwo) {
            waveOutReset(hwo);
            for (int i = 0; i < NUM_BUFS; i++) waveOutUnprepareHeader(hwo, &hdrs[i], sizeof(WAVEHDR));
            waveOutClose(hwo);
            hwo = nullptr;
        }
        if (evt) { CloseHandle(evt); evt = nullptr; }
    }
#else
    bool init() { synthAll(); ok = false; return true; }   // silent stub for selftest
    void shutdown() {}
#endif
};
