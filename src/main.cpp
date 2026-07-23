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
    {
        World w1, w2;
        MapInfo m = generateMap(w1, 2);
        generateMap(w2, 2);
        CHECK(MAP_COUNT == 3, "map roster includes the hub map");
        CHECK(w1.countSolid() == w2.countSolid(), "hub map generation is deterministic");
        CHECK(w1.countSolid() > 400000, "hub map has substantial geometry");
        CHECK(std::strcmp(m.name, "WRECKER HQ") == 0, "hub map name set");
        CHECK(m.hasWater, "hub map has water at its shoreline");
        CHECK(w1.barrels.size() >= 3, "hub map has explosive barrels placed");
        int sx = (int)(m.spawn.x / VOXEL_SIZE), sy = (int)(m.spawn.y / VOXEL_SIZE), sz = (int)(m.spawn.z / VOXEL_SIZE);
        CHECK(!w1.solidClamped(sx, sy, sz) && !w1.solidClamped(sx, sy + 3, sz), "hub spawn point is not inside solid geometry");
        // the spawn faces the house: a forward raycast must actually hit the HQ building
        World::RayHit h = w1.raycast(m.spawn + vec3(0, 0.6f, 0), vec3(sinf(m.spawnYaw), 0, cosf(m.spawnYaw)), 30.f);
        CHECK(h.hit, "hub spawn faces the HQ house (forward raycast hits the building)");
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

    // ---- raycast: exact axis-aligned ray from an origin exactly on a voxel grid boundary
    // must not drift off-axis (regression test for the tx/ty tie-break bug fixed above)
    {
        World w;
        w.init();
        uint8_t solid = w.addPal(100, 100, 100, M_HEAVY);
        // a single isolated target voxel; a drifted ray would sail past it and miss entirely
        w.setRaw(5, 3, 8, solid);
        vec3 eye(5 * VOXEL_SIZE, 3 * VOXEL_SIZE, 2 * VOXEL_SIZE);
        World::RayHit h = w.raycast(eye, vec3(0, 0, 1), 3.f);
        CHECK(h.hit && h.x == 5 && h.y == 3 && h.z == 8,
              "axis-aligned raycast from a grid-boundary origin hits the exact target voxel, no drift");
    }

    // ---- player camera basis: strafe direction and viewmodel aim must track the camera's
    // actual forward/right vectors (render.h's camFwd/camRight), or movement and the gun both
    // visibly diverge from where the crosshair is pointing.
    {
        Player p;
        for (float yaw : {0.f, 0.7f, 1.9f, -1.2f, 3.0f}) {
            p.yaw = yaw;
            vec3 fwd = p.forwardFlat();
            vec3 right = p.rightFlat();
            // the true camera-right vector, computed exactly as render.h's setCamera() does
            vec3 camRight = vnorm(vcross(fwd, vec3(0, 1, 0)));
            CHECK(vlen(right - camRight) < 1e-4f, "rightFlat() matches the camera's true right vector (strafe direction)");
        }
        for (float yaw : {0.f, 0.7f, -2.1f}) {
            for (float pitch : {0.f, 0.5f, -0.9f}) {
                p.yaw = yaw; p.pitch = pitch;
                vec3 trueFwd = p.forward();
                // exactly the matrix drawViewmodel() builds: translate * roty(yaw) * rotx(-pitch)
                mat4 model = mat4_roty(p.yaw) * mat4_rotx(-p.pitch);
                vec3 gunFwd = mat4_mulpoint(model, vec3(0, 0, 1));
                CHECK(vlen(gunFwd - trueFwd) < 1e-4f, "viewmodel rotation matrix points the gun exactly where the camera looks");
            }
        }
        // mouse look: moving the mouse right (dx > 0, platform.h's screen-X-increases-
        // rightward convention) must turn the camera toward its own right side, not left
        for (float startYaw : {0.f, 1.1f, -2.4f}) {
            Player mp; mp.yaw = startYaw;
            vec3 camRightBefore = vnorm(vcross(mp.forwardFlat(), vec3(0, 1, 0)));
            vec3 fwdBefore = mp.forwardFlat();
            mp.applyMouseLook(6.f, 0.f, 0.01f);
            vec3 fwdAfter = mp.forwardFlat();
            CHECK(vdot(fwdAfter - fwdBefore, camRightBefore) > 0.f,
                  "moving the mouse right turns the camera toward its own right vector, not left");
        }
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

    // ---- landCluster: a hard impact should only shatter voxels near the cluster's own
    // bottom, not the entire structure (regression test for a reference-frame bug: the
    // crumble check compared the landed height against the cluster's *original* lowest y
    // without adjusting for the drop distance, so for any cluster that fell farther than its
    // own height -- true for nearly every real drop -- every single voxel satisfied the
    // condition and the whole thing turned into short-lived debris particles instead of
    // resettling as solid rubble)
    {
        World w;
        w.init();
        uint8_t wood = w.addPal(150, 112, 70, M_MED);
        // a 5x5x6 solid block, well clear of the ground, dropped from far higher than its own
        // 6-voxel height
        FallingCluster fc;
        for (int y = 20; y < 26; y++)
            for (int z = 5; z < 10; z++)
                for (int x = 5; x < 10; x++)
                    fc.voxels.push_back({(int16_t)x, (int16_t)y, (int16_t)z, wood});
        fc.drop = 20;
        int total = (int)fc.voxels.size();
        int crumbled = 0;
        w.landCluster(fc, [&](int, int, int, uint8_t) { crumbled++; });
        CHECK(crumbled > 0 && crumbled < total / 2,
              "a hard landing shatters only the bottom of a tall cluster, not the whole thing");
        CHECK(w.countSolid() > 0, "the surviving part of the cluster resettles as real solid geometry");
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
        CHECK(as.sounds.size() == SND_COUNT, "all sound effects synthesized");
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

        opsEmitted = 0;
        fireGun(ctx, ws, eye, vec3(0, -1, 0));
        CHECK(opsEmitted > 0, "firing the pistol emits a destruction op");

        opsEmitted = 0;
        fireMinigun(ctx, ws, eye, vec3(0, -1, 0), 42);
        CHECK(opsEmitted > 0, "firing the minigun emits a destruction op");

        // blowtorch's op-emission is covered more rigorously below (short 3.2m range makes
        // this eye position, chosen for long-range weapon tests 12m above the mall roof, an
        // unreliable fit for it specifically)
        CHECK((int)TOOL_COUNT == 13, "tool roster has all 13 implemented tools");
        as.shutdown();
    }

    // ---- blowtorch can cut heavy material that the sledgehammer cannot
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        uint8_t heavy = w.addPal(150, 150, 155, M_HEAVY);
        for (int x = 0; x < 10; x++) for (int z = 0; z < 10; z++) w.setRaw(x, 0, z, bedrock);
        for (int x = 3; x < 7; x++) for (int y = 1; y < 5; y++) w.setRaw(x, y, 5, heavy);
        ParticleSystem ps;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.emitOp = [&](const DestructionOp& op) { applyDestructionOp(ctx, op, false); };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};
        WeaponsState ws;
        // offset off the exact voxel-center grid so the destroy-sphere radius check isn't a
        // floating-point tie against every candidate voxel (dist^2 == r^2 exactly)
        vec3 eye(5.3f * VOXEL_SIZE, 3.3f * VOXEL_SIZE, 2 * VOXEL_SIZE);
        vec3 dir = vnorm(vec3(0, 0, 1));
        size_t before = w.countSolid();
        fireSledge(ctx, ws, eye, dir);
        CHECK(w.countSolid() == before, "sledgehammer cannot dent heavy material");
        fireBlowtorch(ctx, eye, dir);
        CHECK(w.countSolid() < before, "blowtorch cuts through heavy material the sledgehammer can't touch");
    }

    // ---- hunting rifle penetrates through multiple thin walls in one shot
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        uint8_t wood = w.addPal(150, 112, 70, M_MED);
        for (int x = 0; x < 10; x++) for (int z = 0; z < 30; z++) w.setRaw(x, 0, z, bedrock);
        for (int x = 3; x < 7; x++) for (int y = 1; y < 5; y++) { w.setRaw(x, y, 5, wood); w.setRaw(x, y, 10, wood); }
        ParticleSystem ps;
        int opsSeen = 0;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.emitOp = [&](const DestructionOp& op) { opsSeen++; applyDestructionOp(ctx, op, false); };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};
        WeaponsState ws;
        vec3 eye(5 * VOXEL_SIZE, 3 * VOXEL_SIZE, 2 * VOXEL_SIZE);
        fireRifle(ctx, ws, eye, vnorm(vec3(0, 0, 1)));
        CHECK(opsSeen >= 2, "a single rifle shot penetrates and damages both walls in its path");
    }

    // ---- pipe bomb: thrown, arcs, and detonates on its timer rather than on impact
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        for (int x = 0; x < 20; x++) for (int z = 0; z < 20; z++) w.setRaw(x, 0, z, bedrock);
        ParticleSystem ps;
        int opsSeen = 0; bool sawBigExplosion = false;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.emitOp = [&](const DestructionOp& op) { opsSeen++; if (op.big) sawBigExplosion = true; };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};
        WeaponsState ws;
        firePipeBomb(ctx, ws, vec3(2, 3, 2), vnorm(vec3(1, 0.3f, 0)), true);
        CHECK(ws.rockets.size() == 1 && ws.rockets[0].grenade, "pipe bomb is thrown as a grenade-mode projectile");
        for (int i = 0; i < 400 && !ws.rockets.empty(); i++) updateRockets(ctx, ws, 1.f / 60.f);
        CHECK(sawBigExplosion, "pipe bomb eventually detonates via its fuse timer");
        CHECK(ws.rockets.empty(), "the pipe bomb projectile is cleaned up after detonating");
    }

    // ---- bomb: placeable, sticks to a surface, detonates after its countdown
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        for (int x = 0; x < 20; x++) for (int z = 0; z < 20; z++) w.setRaw(x, 0, z, bedrock);
        ParticleSystem ps;
        bool sawBigExplosion = false;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.emitOp = [&](const DestructionOp& op) { if (op.big) sawBigExplosion = true; };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};
        WeaponsState ws;
        fireBomb(ctx, ws, vec3(3, 3, 3), vec3(0, -1, 0));
        CHECK(ws.placedBombs.size() == 1, "the bomb sticks to the surface it's placed on");
        for (int i = 0; i < 300 && !ws.placedBombs.empty(); i++) updatePlacedBombs(ctx, ws, 1.f / 60.f);
        CHECK(sawBigExplosion, "the placed bomb detonates after its countdown");
    }

    // ---- nitroglycerin: placed canister reuses the barrel chain-reaction trigger
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        for (int x = 0; x < 20; x++) for (int z = 0; z < 20; z++) w.setRaw(x, 0, z, bedrock);
        ParticleSystem ps;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.emitOp = [&](const DestructionOp& op) { applyDestructionOp(ctx, op, false); };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};
        size_t barrelsBefore = w.barrels.size();
        fireNitro(ctx, vec3(3, 3, 3), vec3(0, -1, 0));
        CHECK(w.barrels.size() == barrelsBefore + 1, "placing nitroglycerin adds a barrel-style trigger entity");
        Barrel& placed = w.barrels.back();
        DestructionOp nearbyBlast{placed.x, placed.y, placed.z, 1.0f, WeaponsState::MASK_EXPLOSION, 0, 1, 0, 1};
        applyDestructionOp(ctx, nearbyBlast, false);
        CHECK(!w.barrels.back().alive, "the nitroglycerin canister chain-detonates when damaged nearby");
    }

    // ---- spray can: recolors surface voxels without changing their material/destructibility
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        uint8_t concrete = w.addPal(180, 176, 168, M_HEAVY);
        for (int x = 0; x < 10; x++) for (int z = 0; z < 10; z++) w.setRaw(x, 0, z, bedrock);
        for (int x = 3; x < 7; x++) for (int y = 1; y < 5; y++) w.setRaw(x, y, 5, concrete);
        ParticleSystem ps;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.emitOp = [](const DestructionOp&) {};
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};
        WeaponsState ws;
        uint8_t before = w.get(5, 3, 5);
        fireSpraycan(ctx, ws, vec3(5 * VOXEL_SIZE, 3 * VOXEL_SIZE, 2 * VOXEL_SIZE), vnorm(vec3(0, 0, 1)));
        uint8_t after = w.get(5, 3, 5);
        CHECK(before != after, "spray can changes the palette index of painted voxels");
        CHECK(w.palette[after].mat == M_HEAVY, "spray can preserves the underlying material (still concrete, not destructible by hand)");
    }

    // ---- fire extinguisher kills nearby fire particles; leaf blower pushes debris
    {
        ParticleSystem ps;
        Particle& fireP = ps.spawn();
        fireP.type = PT_FIRE; fireP.pos = vec3(1, 1, 3); fireP.maxLife = 5.f;
        WeaponContext ctx; ctx.particles = &ps;
        ctx.emitFire = [](const FireEvent&) {};
        ctx.playSound = [](int) {};
        fireExtinguisher(ctx, vec3(1, 1, 0), vnorm(vec3(0, 0, 1)));
        CHECK(!fireP.alive, "fire extinguisher extinguishes a fire particle in its cone");

        Particle& debrisP = ps.spawn();
        debrisP.type = PT_DEBRIS; debrisP.pos = vec3(1, 1, 3); debrisP.vel = vec3(0, 0, 0); debrisP.maxLife = 5.f;
        vec3 velBefore = debrisP.vel;
        fireLeafblower(ctx, vec3(1, 1, 0), vnorm(vec3(0, 0, 1)));
        CHECK(vlen(debrisP.vel - velBefore) > 0.01f, "leaf blower pushes debris particles in its cone");
    }

    // ---- fire system: ignites only flammable material, spreads, burns voxels away, capped
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        uint8_t wood = w.addPal(150, 112, 70, M_MED);
        uint8_t heavy = w.addPal(150, 150, 155, M_HEAVY);
        for (int x = 0; x < 20; x++) for (int z = 0; z < 20; z++) w.setRaw(x, 0, z, bedrock);
        for (int x = 0; x < 10; x++) w.setRaw(x, 1, 5, wood);   // a wooden row that fire can travel along
        w.setRaw(15, 1, 5, heavy);

        FireSystem fs;
        CHECK(!fs.ignite(w, 15, 1, 5), "fire cannot ignite non-flammable (heavy) material");
        CHECK(fs.ignite(w, 0, 1, 5), "fire ignites flammable (wood) material");
        CHECK(!fs.ignite(w, 0, 1, 5), "the same voxel can't be ignited twice");

        ParticleSystem ps;
        int burnOps = 0;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.emitOp = [&](const DestructionOp& op) { burnOps++; applyDestructionOp(ctx, op, false); };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [](int) {};
        ctx.addLight = [](vec3, vec3, float, float) {};
        for (int i = 0; i < 600; i++) fs.update(1.f / 30.f, ctx, -1000.f, false);
        CHECK(burnOps > 0, "a burned-out voxel is destroyed via the normal networked op path");
        CHECK(w.get(0, 1, 5) == 0, "the originally ignited voxel is gone after it finishes burning");

        // spread + cap: a long flammable run should hit the MAX_FIRES ceiling, not runaway
        World big;
        big.init();
        uint8_t bedrock2 = big.addPal(50, 50, 50, M_BEDROCK);
        uint8_t wood2 = big.addPal(150, 112, 70, M_MED);
        for (int x = 0; x < 200; x++) for (int z = 0; z < 5; z++) big.setRaw(x, 0, z, bedrock2);
        for (int x = 0; x < 190; x++) big.setRaw(x, 1, 2, wood2);
        FireSystem fsBig;
        fsBig.ignite(big, 0, 1, 2);
        WeaponContext ctxBig; ctxBig.world = &big; ctxBig.particles = &ps;
        ctxBig.emitOp = [&](const DestructionOp& op) { applyDestructionOp(ctxBig, op, false); };
        ctxBig.emitFire = [](const FireEvent&) {};
        ctxBig.addShake = [](vec3, float) {};
        ctxBig.playSound = [](int) {};
        ctxBig.addLight = [](vec3, vec3, float, float) {};
        int maxSeen = 0;
        for (int i = 0; i < 300; i++) {
            fsBig.update(1.f / 20.f, ctxBig, -1000.f, false);
            maxSeen = std::max(maxSeen, (int)fsBig.fires.size());
        }
        CHECK(maxSeen <= MAX_FIRES, "concurrent fire count never exceeds the cap");

        // submersion in water extinguishes
        FireSystem fsWater;
        fsWater.ignite(w, 3, 1, 5);
        WeaponContext ctxW; ctxW.world = &w; ctxW.particles = &ps;
        ctxW.emitOp = [](const DestructionOp&) {};
        ctxW.emitFire = [](const FireEvent&) {};
        ctxW.addShake = [](vec3, float) {};
        ctxW.playSound = [](int) {};
        ctxW.addLight = [](vec3, vec3, float, float) {};
        fsWater.update(0.01f, ctxW, 100.f, true);   // water level far above the fire -> submerged
        CHECK(fsWater.fires.empty(), "a fire submerged in water is extinguished");

        // extinguisher cone
        FireSystem fsCone;
        fsCone.ignite(w, 3, 1, 5);
        vec3 fireCenter(3.5f * VOXEL_SIZE, 1.5f * VOXEL_SIZE, 5.5f * VOXEL_SIZE);
        fsCone.extinguishCone(fireCenter - vnorm(vec3(0, 0, 1)) * 2.f, vnorm(vec3(0, 0, 1)), 6.f, 0.5f);
        CHECK(fsCone.fires.empty(), "the extinguisher cone puts out a fire in its path");
    }

    // ---- loose voxel props: spawn, settle under gravity, and are grabbable within a cone
    {
        World w;
        w.init();
        uint8_t bedrock = w.addPal(50, 50, 50, M_BEDROCK);
        uint8_t wood = w.addPal(150, 112, 70, M_MED);
        for (int x = 0; x < 10; x++) for (int z = 0; z < 10; z++) w.setRaw(x, 0, z, bedrock);

        LooseVoxelSystem lvs;
        vec3 dropPos(5 * VOXEL_SIZE, 3 * VOXEL_SIZE, 5 * VOXEL_SIZE);
        CHECK(lvs.spawn(dropPos, wood, vec3(0, 0, 0)), "a loose voxel prop can be spawned");
        for (int i = 0; i < 300 && !lvs.props[0].resting; i++) lvs.update(1.f / 60.f, w);
        CHECK(lvs.props[0].resting, "a dropped loose voxel settles under gravity onto solid ground");
        CHECK(lvs.props[0].pos.y < dropPos.y, "the settled voxel ended up lower than where it was dropped");

        vec3 eye = lvs.props[0].pos - vec3(0, 0, 1.5f);
        int found = lvs.findGrabbable(eye, vnorm(vec3(0, 0, 1)), 3.f);
        CHECK(found == 0, "a nearby loose voxel prop is found by an aim-cone grab check");
        int notFound = lvs.findGrabbable(eye, vnorm(vec3(1, 0, 0)), 3.f);
        CHECK(notFound == -1, "a loose voxel prop outside the aim cone is not found");

        // cap + recycle: filling past MAX_LOOSE_VOXELS reuses the oldest settled prop
        // rather than growing unbounded
        LooseVoxelSystem cap;
        for (int i = 0; i < MAX_LOOSE_VOXELS; i++) {
            cap.spawn(vec3(1, 3, 1), wood, vec3(0, 0, 0));
            cap.props.back().resting = true;
        }
        CHECK((int)cap.props.size() == MAX_LOOSE_VOXELS, "loose voxel pool fills up to its cap");
        bool spawnedOneMore = cap.spawn(vec3(1, 3, 1), wood, vec3(0, 0, 0));
        CHECK(spawnedOneMore && (int)cap.props.size() == MAX_LOOSE_VOXELS,
              "spawning past the cap recycles an old settled prop instead of growing unbounded");
    }

    // ---- water splashes: shooting into open water (no voxel there to hit at all) still
    // produces a reaction instead of the shot silently doing nothing
    {
        World w;
        w.init();
        // no solid geometry anywhere below the shot: a downward ray crosses the water
        // plane with nothing solid to stop it first
        ParticleSystem ps;
        int opsSeen = 0, splashSounds = 0;
        WeaponContext ctx; ctx.world = &w; ctx.particles = &ps;
        ctx.hasWater = true;
        ctx.waterLevel = 2.5f * VOXEL_SIZE;
        ctx.emitOp = [&](const DestructionOp&) { opsSeen++; };
        ctx.emitFire = [](const FireEvent&) {};
        ctx.addShake = [](vec3, float) {};
        ctx.playSound = [&](int id) { if (id == SND_SPLASH) splashSounds++; };
        ctx.addLight = [](vec3, vec3, float, float) {};
        WeaponsState ws;
        vec3 eye(5 * VOXEL_SIZE, 8 * VOXEL_SIZE, 5 * VOXEL_SIZE);
        fireGun(ctx, ws, eye, vec3(0, -1, 0));
        CHECK(splashSounds == 1, "shooting straight down into open water plays a splash sound");
        CHECK(opsSeen == 0, "a shot that only hits water (no voxel below it) emits no destruction op");
        bool sawSplashParticle = std::any_of(ps.pool.begin(), ps.pool.end(),
            [](const Particle& p) { return p.alive && p.type == PT_SPLASH; });
        CHECK(sawSplashParticle, "a splash particle is spawned at the water surface");

        // a solid voxel between the muzzle and the water must take priority: no splash
        uint8_t wood = w.addPal(150, 112, 70, M_MED);
        for (int x = 3; x < 7; x++) for (int z = 3; z < 7; z++) w.setRaw(x, 3, z, wood);
        splashSounds = 0; opsSeen = 0;
        fireGun(ctx, ws, eye, vec3(0, -1, 0));
        CHECK(splashSounds == 0, "a solid voxel above the water line blocks the shot before it reaches the water");
        CHECK(opsSeen > 0, "that shot instead hits the voxel it actually struck");

        // an explosion detonating at/under the water line also splashes
        ParticleSystem ps2;
        WeaponContext ectx; ectx.world = &w; ectx.particles = &ps2;
        ectx.hasWater = true; ectx.waterLevel = 2.5f * VOXEL_SIZE;
        int explosionSplashes = 0;
        ectx.emitOp = [](const DestructionOp&) {};
        ectx.emitFire = [](const FireEvent&) {};
        ectx.addShake = [](vec3, float) {};
        ectx.playSound = [&](int id) { if (id == SND_SPLASH) explosionSplashes++; };
        ectx.addLight = [](vec3, vec3, float, float) {};
        DestructionOp boom;
        boom.x = 1.f; boom.y = ectx.waterLevel - 0.1f; boom.z = 1.f;
        boom.radius = 2.f; boom.matMask = WeaponsState::MASK_EXPLOSION;
        boom.px = 0; boom.py = 1; boom.pz = 0; boom.big = 1;
        applyDestructionOp(ectx, boom, true);
        CHECK(explosionSplashes == 1, "an explosion detonating at/under the water line also splashes");

        // no water on the map: never splashes, regardless of what's below the shot
        WeaponContext dctx; dctx.world = &w; dctx.particles = &ps2;
        dctx.hasWater = false;
        int drySplashes = 0;
        dctx.emitOp = [](const DestructionOp&) {};
        dctx.emitFire = [](const FireEvent&) {};
        dctx.addShake = [](vec3, float) {};
        dctx.playSound = [&](int id) { if (id == SND_SPLASH) drySplashes++; };
        dctx.addLight = [](vec3, vec3, float, float) {};
        fireGun(dctx, ws, vec3(1 * VOXEL_SIZE, 8 * VOXEL_SIZE, 1 * VOXEL_SIZE), vec3(0, -1, 0));
        CHECK(drySplashes == 0, "maps without water never produce a splash");
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
