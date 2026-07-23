// game.h - state machine (menus/HUD), remote player avatars, and P2P glue.
// Ties world+player+weapons+particles+audio+net+renderer into one Game object.
#pragma once
#include "vmath.h"
#include "world.h"
#include "mapgen.h"
#include "player.h"
#include "weapons.h"
#include "particles.h"
#include "props.h"
#include "audio.h"
#include "net.h"
#include "render.h"
#include "platform.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>

enum GameState {
    ST_MAIN_MENU, ST_MAP_SELECT, ST_MP_MENU, ST_MP_JOIN_INPUT, ST_OPTIONS, ST_LOADING, ST_PLAYING, ST_PAUSE, ST_DISCONNECTED
};
enum NetRole { NET_OFFLINE, NET_HOST, NET_CLIENT };

struct RemotePlayer {
    int id = -1;
    bool used = false;
    std::string name = "PLAYER";
    vec3 pos, renderPos;
    float yaw = 0, pitch = 0, renderYaw = 0;
    Tool tool = TOOL_SLEDGE;
    bool moving = false;
    float animPhase = 0;
    float lastSeen = 0;
    vec3 colorTint = vec3(0.8f, 0.8f, 0.85f);
};

struct Game {
    Platform* plat = nullptr;
    Renderer ren;
    World world;
    MapInfo mapInfo;
    Player player;
    WeaponsState weapons;
    ParticleSystem particles;
    FireSystem fires;
    LooseVoxelSystem loose;
    AudioSystem audio;
    WeaponContext wctx;
    int grabbedProp = -1;     // index into loose.props, or -1 if not carrying anything
    bool despawnLooseProps = true;
    bool wasInWater = false;  // edge-detects water entry/exit for splash fx

    GameState state = ST_MAIN_MENU;
    int selectedMap = 0;
    double simTime = 0;
    float shakeAmp = 0, shakeT = 0;
    int frameCounter = 0;

    // networking
    NetRole role = NET_OFFLINE;
    NetHost host;
    NetClient client;
    std::vector<DestructionOp> opLog;              // host authoritative log (for late joiners)
    RemotePlayer remotes[NET_MAX_PLAYERS];
    int localId = 0;
    float stateSendTimer = 0;
    std::string joinIpBuf = "127.0.0.1";
    std::string statusMsg;
    float statusTimer = 0;
    bool netSyncing = false;

    // UI text-entry
    bool typingJoinIp = false;

    // pause / options
    bool paused = false;

    void init(Platform* p) {
        plat = p;
        audio.init();
        wctx.world = &world;
        wctx.particles = &particles;
        wctx.emitOp = [this](const DestructionOp& op) { onLocalOp(op); };
        wctx.emitFire = [this](const FireEvent& fe) { onLocalFire(fe); };
        wctx.addShake = [this](vec3, float amt) { shakeAmp = std::max(shakeAmp, amt); };
        wctx.playSound = [this](int id) { audio.play(id, 0.9f); };
        wctx.addLight = [this](vec3 pos, vec3 col, float radius, float) {
            if (ren.lights.size() < 16) ren.lights.push_back({pos, radius, col});
        };
        wctx.tryIgnite = [this](int x, int y, int z) { fires.ignite(world, x, y, z); };
        wctx.extinguishFireCone = [this](vec3 eye, vec3 dir, float range, float cosHalf) {
            fires.extinguishCone(eye, dir, range, cosHalf);
        };
        wctx.spawnLooseDebris = [this](vec3 pos, uint8_t pal, vec3 vel) { loose.spawn(pos, pal, vel); };
    }

    void shutdown() {
        stopNet();
        audio.shutdown();
    }

    // ---------------------------------------------------------------- map lifecycle
    void loadMap(int id) {
        mapInfo = generateMap(world, id);
        wctx.hasWater = mapInfo.hasWater;
        wctx.waterLevel = mapInfo.waterLevel;
        wasInWater = false;
        world.markAllDirty();
        // full remesh across all cores before first frame
        while (world.anyDirty()) world.remeshDirty(NUM_CHUNKS);
        for (auto& c : world.chunks) c.gpuDirty = true;
        if (ren.occTex) ren.uploadFullOccupancy(world);
        player.pos = mapInfo.spawn;
        player.vel = vec3(0, 0, 0);
        player.yaw = mapInfo.spawnYaw;
        player.pitch = 0;
        weapons = WeaponsState();
        particles.clearAll();
        fires.clearAll();
        loose.props.clear();
        grabbedProp = -1;
        ren.lights.clear();
        for (auto& r : remotes) r = RemotePlayer();
        opLog.clear();
    }

    void startSingleplayer(int mapId) {
        stopNet();
        role = NET_OFFLINE;
        selectedMap = mapId;
        loadMap(mapId);
        state = ST_PLAYING;
        if (plat) plat->setCapture(true);
    }

    void startHost(int mapId) {
        stopNet();
        selectedMap = mapId;
        loadMap(mapId);
        if (!host.start()) {
            statusMsg = "FAILED TO START HOST (PORT IN USE?)";
            statusTimer = 4.f;
            state = ST_MP_MENU;
            return;
        }
        role = NET_HOST;
        localId = 0;
        state = ST_PLAYING;
        if (plat) plat->setCapture(true);
    }

    void startJoin(const std::string& ip) {
        stopNet();
        statusMsg = "CONNECTING...";
        statusTimer = 999.f;
        state = ST_LOADING;
        bool ok = client.connectTo(ip.c_str(), NET_PORT, 3500);
        if (!ok) {
            statusMsg = "COULD NOT CONNECT TO " + ip;
            statusTimer = 4.f;
            state = ST_MP_MENU;
            return;
        }
        role = NET_CLIENT;
        WireHello hello{};
        std::snprintf(hello.name, sizeof hello.name, "PLAYER");
        client.send(MSG_HELLO, &hello, sizeof hello);
        client.flush();
        netSyncing = true;
        // world is generated locally once we learn the mapId from WELCOME
    }

    void stopNet() {
        if (role == NET_HOST) host.stop();
        if (role == NET_CLIENT) client.stop();
        role = NET_OFFLINE;
        netSyncing = false;
    }

    void returnToMenu() {
        stopNet();
        state = ST_MAIN_MENU;
        if (plat) plat->setCapture(false);
    }

    // ---------------------------------------------------------------- op application
    void onLocalOp(const DestructionOp& op) {
        applyDestructionOp(wctx, op, true);
        if (role == NET_HOST) {
            opLog.push_back(op);
            WireOp w{op.x, op.y, op.z, op.radius, op.matMask, op.px, op.py, op.pz, op.big};
            host.broadcast(MSG_OP, &w, sizeof w);
        } else if (role == NET_CLIENT) {
            WireOp w{op.x, op.y, op.z, op.radius, op.matMask, op.px, op.py, op.pz, op.big};
            client.send(MSG_OP, &w, sizeof w);
        }
    }
    void onLocalFire(const FireEvent& fe) {
        WireFire w{fe.tool, fe.ox, fe.oy, fe.oz, fe.dx, fe.dy, fe.dz};
        if (role == NET_HOST) host.broadcast(MSG_FIRE, &w, sizeof w);
        else if (role == NET_CLIENT) client.send(MSG_FIRE, &w, sizeof w);
    }
    void applyRemoteOp(const WireOp& w, bool asRocketExplosion = false) {
        DestructionOp op{w.x, w.y, w.z, w.radius, w.matMask, w.px, w.py, w.pz, w.big};
        applyDestructionOp(wctx, op, true);
        (void)asRocketExplosion;
    }
    // Cosmetic-only visual feedback for another player's tool use — the actual world edit
    // (voxels destroyed, painted, etc.) always arrives separately via MSG_OP and is applied
    // identically on every peer, so nothing here needs to be gameplay-authoritative.
    void applyRemoteFire(int fromId, const WireFire& w) {
        RemotePlayer* rp = findRemote(fromId);
        vec3 origin(w.ox, w.oy, w.oz), dir(w.dx, w.dy, w.dz);
        switch (w.tool) {
            case TOOL_SLEDGE:
                particles.smoke(origin + dir * 0.5f, dir * 0.4f, 0.1f, 0.3f, 0.4f);
                break;
            case TOOL_SHOTGUN:
            case TOOL_MINIGUN:
                particles.flash(origin + dir * 0.6f, 0.4f);
                for (int i = 0; i < 4; i++) particles.smoke(origin + dir * 0.6f, dir * 1.8f, 0.14f, 0.5f, 0.32f);
                if (ren.lights.size() < 16) ren.lights.push_back({origin + dir * 0.6f, 5.f, vec3(1.f, 0.75f, 0.4f) * 8.f});
                break;
            case TOOL_GUN:
            case TOOL_RIFLE:
                particles.flash(origin + dir * 0.6f, 0.25f);
                particles.smoke(origin + dir * 0.6f, dir * 1.6f, 0.08f, 0.3f, 0.3f);
                break;
            case TOOL_BLOWTORCH:
                particles.fire(origin + dir * 2.f, dir * 0.3f, 0.08f, 0.1f);
                break;
            case TOOL_SPRAYCAN:
                particles.dust(origin + dir * 1.f, dir * 0.3f, 0.06f, 0.4f, 0.8f, 0.4f, 0.6f);
                break;
            case TOOL_EXTINGUISHER:
            case TOOL_LEAFBLOWER:
                particles.dust(origin + dir * 0.6f, dir * 3.5f, 0.14f, 0.3f, 0.8f, 0.8f, 0.8f);
                break;
            case TOOL_PIPEBOMB: {
                Rocket r;
                r.pos = origin + dir * 0.6f;
                r.vel = dir * 16.f + vec3(0, 3.f, 0);
                r.local = false;
                r.grenade = true;
                r.fuse = 2.4f;
                weapons.rockets.push_back(r);
                break;
            }
            case TOOL_ROCKET: {
                Rocket r;
                r.pos = origin + dir * 0.8f;
                r.vel = dir * 30.f;
                r.local = false;
                weapons.rockets.push_back(r);
                break;
            }
            case TOOL_BOMB:
            case TOOL_NITRO:
                particles.flash(origin + dir * 0.6f, 0.2f);
                break;
            default: break;
        }
        if (rp) rp->tool = (Tool)w.tool;
    }
    RemotePlayer* findRemote(int id) {
        for (auto& r : remotes) if (r.used && r.id == id) return &r;
        return nullptr;
    }
    RemotePlayer* addRemote(int id) {
        for (auto& r : remotes) if (r.used && r.id == id) return &r;
        for (auto& r : remotes)
            if (!r.used) {
                r = RemotePlayer();
                r.used = true; r.id = id;
                r.pos = mapInfo.spawn; r.renderPos = r.pos;
                static const vec3 tints[8] = {
                    {0.85f,0.4f,0.35f},{0.35f,0.55f,0.9f},{0.4f,0.85f,0.45f},{0.9f,0.75f,0.3f},
                    {0.75f,0.4f,0.85f},{0.35f,0.8f,0.8f},{0.9f,0.55f,0.7f},{0.6f,0.6f,0.6f}
                };
                r.colorTint = tints[id % 8];
                return &r;
            }
        return nullptr;
    }

    // ---------------------------------------------------------------- networking pump
    void pumpNet(float dt) {
        std::vector<NetMsg> msgs;
        if (role == NET_HOST) {
            int slot;
            while ((slot = host.acceptNew()) >= 0) {
                statusMsg = "A PLAYER IS CONNECTING...";
                statusTimer = 2.f;
            }
            host.poll(msgs);
            for (auto& m : msgs) handleHostMsg(m);
            // detect disconnects
            for (int i = 1; i < NET_MAX_PLAYERS; i++) {
                if (!host.conns[i].alive && remotes[i].used) {
                    remotes[i] = RemotePlayer();
                    uint8_t id = (uint8_t)i;
                    host.broadcast(MSG_LEAVE, &id, 1);
                }
            }
            stateSendTimer += dt;
            if (stateSendTimer > 0.05f) {
                stateSendTimer = 0;
                WireState ws{(uint8_t)localId, player.pos.x, player.pos.y, player.pos.z,
                             player.yaw, player.pitch, (uint8_t)weapons.current,
                             (uint8_t)(vlen(vec3(player.vel.x, 0, player.vel.z)) > 0.4f)};
                host.broadcast(MSG_STATE, &ws, sizeof ws);
            }
            host.flush();
        } else if (role == NET_CLIENT) {
            client.poll(msgs);
            for (auto& m : msgs) handleClientMsg(m);
            if (!client.alive() && state == ST_PLAYING) {
                statusMsg = "LOST CONNECTION TO HOST";
                statusTimer = 5.f;
                state = ST_DISCONNECTED;
            }
            stateSendTimer += dt;
            if (stateSendTimer > 0.05f && state == ST_PLAYING) {
                stateSendTimer = 0;
                WireState ws{(uint8_t)localId, player.pos.x, player.pos.y, player.pos.z,
                             player.yaw, player.pitch, (uint8_t)weapons.current,
                             (uint8_t)(vlen(vec3(player.vel.x, 0, player.vel.z)) > 0.4f)};
                client.send(MSG_STATE, &ws, sizeof ws);
            }
            client.flush();
        }
        // remote interpolation
        for (auto& r : remotes) {
            if (!r.used) continue;
            r.renderPos = vlerp(r.renderPos, r.pos, clampf(dt * 12.f, 0, 1));
            float dyaw = r.yaw - r.renderYaw;
            while (dyaw > 3.14159f) dyaw -= 6.28318f;
            while (dyaw < -3.14159f) dyaw += 6.28318f;
            r.renderYaw += dyaw * clampf(dt * 12.f, 0, 1);
            if (r.moving) r.animPhase += dt * 6.f;
        }
    }

    void handleHostMsg(const NetMsg& m) {
        int from = m.from;
        if (m.type == MSG_HELLO) {
            RemotePlayer* rp = addRemote(from);
            WireWelcome ww{(uint8_t)from, (uint8_t)world.mapId, (uint32_t)opLog.size()};
            host.sendTo(from, MSG_WELCOME, &ww, sizeof ww);
            for (auto& op : opLog) {
                WireOp w{op.x, op.y, op.z, op.radius, op.matMask, op.px, op.py, op.pz, op.big};
                host.sendTo(from, MSG_OP, &w, sizeof w);
            }
            host.sendTo(from, MSG_SYNC_DONE, nullptr, 0);
            // tell the new player about existing players (including host)
            WireJoin selfJoin{(uint8_t)localId, "HOST"};
            host.sendTo(from, MSG_JOIN, &selfJoin, sizeof selfJoin);
            for (auto& r : remotes)
                if (r.used && r.id != from) {
                    WireJoin j{(uint8_t)r.id, {}};
                    std::snprintf(j.name, sizeof j.name, "PLAYER%d", r.id);
                    host.sendTo(from, MSG_JOIN, &j, sizeof j);
                }
            // tell everyone else about the new player
            WireJoin nj{(uint8_t)from, {}};
            std::snprintf(nj.name, sizeof nj.name, "PLAYER%d", from);
            host.broadcast(MSG_JOIN, &nj, sizeof nj, from);
            statusMsg = "PLAYER JOINED";
            statusTimer = 2.5f;
            (void)rp;
        } else if (m.type == MSG_OP && m.data.size() == sizeof(WireOp)) {
            WireOp w; memcpy(&w, m.data.data(), sizeof w);
            applyRemoteOp(w);
            opLog.push_back({w.x, w.y, w.z, w.radius, w.matMask, w.px, w.py, w.pz, w.big});
            host.broadcast(MSG_OP, &w, sizeof w, from);
        } else if (m.type == MSG_FIRE && m.data.size() == sizeof(WireFire)) {
            WireFire w; memcpy(&w, m.data.data(), sizeof w);
            applyRemoteFire(from, w);
            host.broadcast(MSG_FIRE, &w, sizeof w, from);
        } else if (m.type == MSG_STATE && m.data.size() == sizeof(WireState)) {
            WireState w; memcpy(&w, m.data.data(), sizeof w);
            RemotePlayer* rp = addRemote(from);
            if (rp) {
                rp->pos = vec3(w.x, w.y, w.z); rp->yaw = w.yaw; rp->pitch = w.pitch;
                rp->tool = (Tool)w.tool; rp->moving = w.moving != 0;
            }
            host.broadcast(MSG_STATE, &w, sizeof w, from);
        }
    }

    void handleClientMsg(const NetMsg& m) {
        if (m.type == MSG_WELCOME && m.data.size() == sizeof(WireWelcome)) {
            WireWelcome w; memcpy(&w, m.data.data(), sizeof w);
            localId = w.id;
            selectedMap = w.mapId;
            loadMap(w.mapId);
        } else if (m.type == MSG_OP && m.data.size() == sizeof(WireOp)) {
            WireOp w; memcpy(&w, m.data.data(), sizeof w);
            applyDestructionOp(wctx, {w.x, w.y, w.z, w.radius, w.matMask, w.px, w.py, w.pz, w.big}, !netSyncing);
        } else if (m.type == MSG_SYNC_DONE) {
            netSyncing = false;
            state = ST_PLAYING;
            player.pos = mapInfo.spawn;
            player.yaw = mapInfo.spawnYaw;
            if (plat) plat->setCapture(true);
        } else if (m.type == MSG_FIRE && m.data.size() == sizeof(WireFire)) {
            WireFire w; memcpy(&w, m.data.data(), sizeof w);
            applyRemoteFire(-1, w);
        } else if (m.type == MSG_STATE && m.data.size() == sizeof(WireState)) {
            WireState w; memcpy(&w, m.data.data(), sizeof w);
            if (w.id == localId) return;
            RemotePlayer* rp = addRemote(w.id);
            if (rp) {
                rp->pos = vec3(w.x, w.y, w.z); rp->yaw = w.yaw; rp->pitch = w.pitch;
                rp->tool = (Tool)w.tool; rp->moving = w.moving != 0;
            }
        } else if (m.type == MSG_JOIN && m.data.size() == sizeof(WireJoin)) {
            WireJoin w; memcpy(&w, m.data.data(), sizeof w);
            if (w.id != localId) {
                RemotePlayer* rp = addRemote(w.id);
                if (rp) rp->name = w.name;
            }
        } else if (m.type == MSG_LEAVE && m.data.size() == 1) {
            uint8_t id = m.data[0];
            RemotePlayer* rp = findRemote(id);
            if (rp) *rp = RemotePlayer();
        }
    }

    // ---------------------------------------------------------------- per-frame update
    void update(float dt) {
        dt = std::min(dt, 1.f / 20.f);
        simTime += dt;
        ren.time = (float)simTime;
        frameCounter++;

        if (state == ST_PLAYING) updatePlaying(dt);
        if (role != NET_OFFLINE) pumpNet(dt);
        if (statusTimer > 0) statusTimer -= dt;
    }

    void updatePlaying(float dt) {
        PlatformState& in = plat->st;
        if (in.keyPressed[VK_ESCAPE]) {
            paused = !paused;
            plat->setCapture(!paused);
        }
        if (paused) return;

        // mouse look
        player.applyMouseLook(in.mouseDX, in.mouseDY, 0.0022f);

        float mz = (in.keyDown['W'] ? 1.f : 0.f) - (in.keyDown['S'] ? 1.f : 0.f);
        float mx = (in.keyDown['D'] ? 1.f : 0.f) - (in.keyDown['A'] ? 1.f : 0.f);
        bool jump = in.keyDown[VK_SPACE];
        bool sprint = in.keyDown[VK_SHIFT];
        bool crouch = in.keyDown[VK_CONTROL];
        player.update(world, dt, mx, mz, jump, sprint, crouch, mapInfo.waterLevel, mapInfo.hasWater);
        if (player.inWater != wasInWater) {
            float speed = vlen(player.vel);
            particles.splash(vec3(player.pos.x, mapInfo.waterLevel, player.pos.z), clampf(0.4f + speed * 0.12f, 0.4f, 1.6f));
            audio.play(SND_SPLASH, 0.6f);
            wasInWater = player.inWater;
        }

        // weapon switch: scroll wheel + number keys
        if (in.wheelDelta != 0) {
            int t = (int)weapons.current;
            t = (t - in.wheelDelta) % TOOL_COUNT;
            if (t < 0) t += TOOL_COUNT;
            weapons.current = (Tool)t;
            audio.play(SND_CLICK, 0.5f);
        }
        for (int k = 0; k < 10 && k < TOOL_COUNT; k++) {
            char key = (char)(k < 9 ? '1' + k : '0');
            if (in.keyPressed[(unsigned char)key]) { weapons.current = (Tool)k; audio.play(SND_CLICK, 0.5f); }
        }

        vec3 eye = player.eye();
        vec3 dir = player.forward();

        // loose-voxel pickup: hold right-click to grab and carry a piece of debris. The
        // spray can already uses right-click for its own color-cycle, so grabbing is
        // unavailable while it's the equipped tool — a small, honest simplification rather
        // than a real per-tool "off-hand" system.
        if (weapons.current != TOOL_SPRAYCAN) {
            if (grabbedProp < 0 && in.mousePressed[1]) {
                int idx = loose.findGrabbable(eye, dir, 2.5f);
                if (idx >= 0) {
                    grabbedProp = idx;
                    loose.props[idx].held = true;
                    audio.play(SND_CLICK, 0.3f);
                }
            }
            if (grabbedProp >= 0 && grabbedProp < (int)loose.props.size()) {
                if (!in.mouseDown[1]) {
                    LooseVoxel& lv = loose.props[grabbedProp];
                    lv.held = false;
                    lv.resting = false;
                    lv.vel = player.forwardFlat() * 1.0f;
                    grabbedProp = -1;
                } else {
                    LooseVoxel& lv = loose.props[grabbedProp];
                    vec3 carryPos = eye + dir * 1.1f;
                    lv.pos = vlerp(lv.pos, carryPos, clampf(dt * 14.f, 0.f, 1.f));
                    lv.vel = vec3(0, 0, 0);
                }
            } else grabbedProp = -1;
        } else if (grabbedProp >= 0) {
            if (grabbedProp < (int)loose.props.size()) loose.props[grabbedProp].held = false;
            grabbedProp = -1;
        }

        // fire (suppressed while carrying an object — one prop occupies both hands here)
        weapons.cooldown = std::max(0.f, weapons.cooldown - dt);
        static Rng shotRng(9001);
        if (weapons.current == TOOL_SPRAYCAN && in.mousePressed[1]) {
            weapons.cycleSprayColor();
            audio.play(SND_CLICK, 0.4f);
        }
        if (grabbedProp < 0 && in.mouseDown[0] && weapons.cooldown <= 0.f) {
            weapons.cooldown = weapons.cooldownFor(weapons.current);
            switch (weapons.current) {
                case TOOL_SLEDGE: fireSledge(wctx, weapons, eye, dir); break;
                case TOOL_SPRAYCAN: fireSpraycan(wctx, weapons, eye, dir); break;
                case TOOL_EXTINGUISHER: fireExtinguisher(wctx, eye, dir); break;
                case TOOL_LEAFBLOWER: fireLeafblower(wctx, eye, dir); break;
                case TOOL_BLOWTORCH: fireBlowtorch(wctx, eye, dir); break;
                case TOOL_SHOTGUN: fireShotgun(wctx, weapons, eye, dir, shotRng.next()); break;
                case TOOL_GUN: fireGun(wctx, weapons, eye, dir); break;
                case TOOL_RIFLE: fireRifle(wctx, weapons, eye, dir); break;
                case TOOL_PIPEBOMB: firePipeBomb(wctx, weapons, eye, dir, true); break;
                case TOOL_BOMB: fireBomb(wctx, weapons, eye, dir); break;
                case TOOL_NITRO: fireNitro(wctx, eye, dir); break;
                case TOOL_ROCKET: fireRocket(wctx, weapons, eye, dir, true); break;
                case TOOL_MINIGUN: fireMinigun(wctx, weapons, eye, dir, shotRng.next()); break;
                default: break;
            }
        }

        // anim decay
        weapons.swingAnim = std::max(0.f, weapons.swingAnim - dt * 2.4f);
        weapons.recoilAnim = std::max(0.f, weapons.recoilAnim - dt * 5.5f);
        weapons.pumpAnim = std::max(0.f, weapons.pumpAnim - dt * 3.2f);
        shakeAmp = std::max(0.f, shakeAmp - dt * 2.2f);
        shakeT += dt;

        updateRockets(wctx, weapons, dt);
        updatePlacedBombs(wctx, weapons, dt);
        particles.update(dt, world);
        fires.update(dt, wctx, mapInfo.waterLevel, mapInfo.hasWater);
        loose.update(dt, world);

        // falling clusters
        for (auto& fc : world.clusters) {
            fc.t += dt;
            float g = 22.f;
            float d = 0.5f * g * fc.t * fc.t;
            if (d >= fc.drop * VOXEL_SIZE && !fc.landed) {
                fc.landed = true;
                Rng lr((uint32_t)(fc.center.x * 97.f) + (uint32_t)(fc.center.z * 131.f) + 1);
                world.landCluster(fc, [&](int x, int y, int z, uint8_t pal) {
                    const PalEntry& pe = world.palette[pal];
                    vec3 vp((x + 0.5f) * VOXEL_SIZE, (y + 0.5f) * VOXEL_SIZE, (z + 0.5f) * VOXEL_SIZE);
                    particles.voxelDebris(vp, pe.r, pe.g, pe.b, vec3(lr.sf(), 0.3f, lr.sf()), 2.f);
                    if (lr.uf() < 0.12f) loose.spawn(vp, pal, vec3(lr.sf(), lr.uf() * 0.5f, lr.sf()) * 1.5f);
                });
                if (fc.drop >= 6) {
                    shakeAmp = std::max(shakeAmp, 0.35f);
                    audio.playAt(SND_DEBRIS, fc.center, 1.2f);
                    for (int i = 0; i < 10; i++)
                        particles.dust(fc.center, vec3(lr.sf(), 0.6f, lr.sf()) * 2.f, 0.9f, 1.4f, 0.5f, 0.48f, 0.44f);
                }
                ren.destroyClusterMesh(fc);
            }
        }
        world.clusters.erase(std::remove_if(world.clusters.begin(), world.clusters.end(),
                             [](const FallingCluster& fc) { return fc.landed; }), world.clusters.end());

        // chunk remesh budget (multi-threaded across cores)
        world.remeshDirty(24);
        ren.uploadDirtyOccupancy(world);

        // audio listener
        audio.setListener(eye, player.rightFlat());

        if (in.keyPressed[VK_F11]) plat->toggleFullscreen();
    }

    // ---------------------------------------------------------------- render
    void renderFrame() {
        ren.resize(plat->st.width, plat->st.height);
        if (state == ST_PLAYING || state == ST_PAUSE) {
            renderWorld();
        } else {
            glDisable(GL_DEPTH_TEST);
            glClearColor(0.05f, 0.06f, 0.09f, 1.f);
            glClear(GL_COLOR_BUFFER_BIT);
            glViewport(0, 0, plat->st.width, plat->st.height);
        }
        renderUI();
        ren.uiFlush();
        plat->swap();
    }

    void renderWorld() {
        ren.lights.clear();
        vec3 eye = player.eye() + vec3(0, sinf(player.bobPhase * 2.f) * 0.03f * player.bobAmp, 0);
        ren.setCamera(eye, player.yaw, player.pitch, shakeAmp, shakeT);
        ren.settings.fov = 75.f;

        ren.beginScene(mapInfo);
        ren.drawSky(mapInfo);
        ren.beginChunks(mapInfo, mapInfo.ambient);
        ren.drawChunks(world);
        ren.drawWater(mapInfo);

        // remote players (simple blocky avatars)
        for (auto& r : remotes) {
            if (!r.used) continue;
            drawAvatar(r);
        }

        // loose grabbable debris props (the one currently held is drawn with the viewmodel)
        if (!loose.props.empty()) {
            ren.modelBegin();
            for (auto& lv : loose.props) {
                if (lv.held) continue;
                const PalEntry& pe = world.palette[lv.pal];
                ren.modelBox(lv.pos, vec3(0.11f, 0.11f, 0.11f), pe.r, pe.g, pe.b);
            }
            ren.modelDraw(mat4::identity(), mapInfo, mapInfo.ambient);
        }

        // particles
        static std::vector<PartInst> alphaP, addP;
        alphaP.clear(); addP.clear();
        particles.buildInstances(alphaP, addP);
        ren.drawParticles(alphaP, addP);

        // viewmodel
        drawViewmodel();

        ren.endScene();
    }

    void drawAvatar(RemotePlayer& r) {
        mat4 model = mat4_translate(r.renderPos) * mat4_roty(r.renderYaw);
        ren.modelBegin();
        uint8_t cr = (uint8_t)(r.colorTint.x * 255), cg = (uint8_t)(r.colorTint.y * 255), cb = (uint8_t)(r.colorTint.z * 255);
        float bob = r.moving ? sinf(r.animPhase) * 0.06f : 0.f;
        ren.modelBox(vec3(0, 0.55f + bob, 0), vec3(0.22f, 0.42f, 0.14f), cr, cg, cb);       // torso
        ren.modelBox(vec3(0, 1.05f + bob, 0), vec3(0.16f, 0.16f, 0.16f), 224, 190, 160);   // head
        float sw = r.moving ? sinf(r.animPhase) * 0.35f : 0.f;
        ren.modelBox(vec3(0.28f, 0.55f + bob, sw * 0.2f), vec3(0.08f, 0.32f, 0.08f), cr, cg, cb);
        ren.modelBox(vec3(-0.28f, 0.55f + bob, -sw * 0.2f), vec3(0.08f, 0.32f, 0.08f), cr, cg, cb);
        ren.modelBox(vec3(0.11f, 0.14f, -sw * 0.25f), vec3(0.09f, 0.30f, 0.09f), 50, 52, 58);
        ren.modelBox(vec3(-0.11f, 0.14f, sw * 0.25f), vec3(0.09f, 0.30f, 0.09f), 50, 52, 58);
        ren.modelDraw(model, mapInfo, mapInfo.ambient);
    }

    void drawViewmodel() {
        vec3 eye = player.eye();
        vec3 fwd = player.forward();
        vec3 right = vnorm(vcross(fwd, vec3(0, 1, 0)));
        vec3 up = vcross(right, fwd);
        float bob = sinf(player.bobPhase * 2.f) * 0.012f * player.bobAmp;
        float bobX = sinf(player.bobPhase) * 0.008f * player.bobAmp;
        vec3 base = eye + fwd * 0.42f + right * 0.20f + up * (-0.20f + bob) + right * bobX;

        // roty(yaw)*rotx(-pitch) maps local +Z to exactly player.forward() -- using -yaw here
        // (as this used to) rotates the gun the opposite way from the camera on turns, so the
        // barrel visibly swings away from the crosshair instead of tracking it.
        mat4 model = mat4_translate(base) * mat4_roty(player.yaw) * mat4_rotx(-player.pitch);
        ren.modelBegin();

        if (grabbedProp >= 0 && grabbedProp < (int)loose.props.size()) {
            // hand gripping the carried piece of debris, instead of the equipped tool
            const PalEntry& pe = world.palette[loose.props[grabbedProp].pal];
            ren.modelBox(vec3(0, -0.04f, 0.02f), vec3(0.11f, 0.11f, 0.11f), pe.r, pe.g, pe.b);
            ren.modelBox(vec3(0.06f, -0.13f, -0.02f), vec3(0.03f, 0.05f, 0.06f), 224, 190, 160);
            ren.modelBox(vec3(-0.06f, -0.13f, -0.02f), vec3(0.03f, 0.05f, 0.06f), 224, 190, 160);
            ren.modelDraw(model, mapInfo, 1.0f);
            return;
        }

        float rec = weapons.recoilAnim;
        switch (weapons.current) {
            case TOOL_SLEDGE: {
                float ang = -weapons.swingAnim * 1.5f;
                ren.modelBox(vec3(0, -0.02f, 0.05f), vec3(0.025f, 0.22f, 0.025f), 120, 84, 52);
                vec3 headC(0, -0.02f - 0.24f * cosf(ang * 0.4f), 0.05f + 0.24f * sinf(ang * 0.4f));
                ren.modelBox(headC, vec3(0.09f, 0.045f, 0.045f), 90, 92, 96);
                break;
            }
            case TOOL_SPRAYCAN:
                ren.modelBox(vec3(0, -0.02f, -0.02f), vec3(0.035f, 0.09f, 0.035f), 40, 40, 44);
                ren.modelBox(vec3(0, 0.07f, -0.02f), vec3(0.038f, 0.015f, 0.038f),
                             (uint8_t)(weapons.sprayR * 255), (uint8_t)(weapons.sprayG * 255), (uint8_t)(weapons.sprayB * 255));
                break;
            case TOOL_EXTINGUISHER:
                ren.modelBox(vec3(0, -0.03f, -0.02f), vec3(0.045f, 0.13f, 0.045f), 190, 40, 30);
                ren.modelBox(vec3(0.02f, 0.03f, -0.15f), vec3(0.012f, 0.012f, 0.08f), 40, 40, 44);
                break;
            case TOOL_LEAFBLOWER:
                ren.modelBox(vec3(0, -0.02f, -0.05f), vec3(0.05f, 0.05f, 0.22f), 220, 160, 40);
                ren.modelBox(vec3(0, -0.09f, 0.05f), vec3(0.02f, 0.06f, 0.03f), 40, 40, 44);
                break;
            case TOOL_BLOWTORCH:
                ren.modelBox(vec3(0, -0.02f, 0.02f), vec3(0.03f, 0.03f, 0.16f), 60, 120, 150);
                ren.modelBox(vec3(0, -0.06f, -0.10f), vec3(0.035f, 0.08f, 0.05f), 200, 200, 60);
                ren.modelBox(vec3(0, -0.01f, 0.16f), vec3(0.012f, 0.012f, 0.05f), 90, 92, 96);
                break;
            case TOOL_SHOTGUN:
                ren.modelBox(vec3(0, -0.01f, -0.05f - rec * 0.05f), vec3(0.03f, 0.03f, 0.28f), 60, 46, 34);
                ren.modelBox(vec3(0, -0.05f, 0.05f - rec * 0.05f), vec3(0.02f, 0.05f, 0.10f), 30, 30, 32);
                ren.modelBox(vec3(0, 0.0f, -0.30f - rec * 0.05f), vec3(0.022f, 0.022f, 0.10f), 40, 40, 44);
                break;
            case TOOL_GUN:
                ren.modelBox(vec3(0, -0.01f, -0.03f - rec * 0.03f), vec3(0.025f, 0.03f, 0.14f), 50, 52, 58);
                ren.modelBox(vec3(0, -0.07f, 0.02f - rec * 0.03f), vec3(0.02f, 0.05f, 0.05f), 40, 32, 28);
                break;
            case TOOL_RIFLE:
                ren.modelBox(vec3(0, 0.0f, -0.10f - rec * 0.06f), vec3(0.025f, 0.025f, 0.34f), 70, 60, 45);
                ren.modelBox(vec3(0, -0.03f, 0.14f - rec * 0.06f), vec3(0.03f, 0.05f, 0.12f), 90, 70, 50);
                ren.modelBox(vec3(0, 0.045f, -0.05f - rec * 0.06f), vec3(0.018f, 0.018f, 0.08f), 30, 30, 34);
                break;
            case TOOL_PIPEBOMB:
                ren.modelBox(vec3(0, -0.02f, -0.02f), vec3(0.03f, 0.03f, 0.11f), 70, 72, 66);
                ren.modelBox(vec3(0, 0.02f, 0.06f), vec3(0.006f, 0.05f, 0.006f), 200, 60, 40);
                break;
            case TOOL_BOMB:
                ren.modelBox(vec3(0, -0.02f, -0.02f), vec3(0.06f, 0.05f, 0.07f), 40, 42, 46);
                ren.modelBox(vec3(0, 0.04f, -0.02f), vec3(0.015f, 0.01f, 0.015f), 200, 40, 30, 3);
                break;
            case TOOL_NITRO:
                ren.modelBox(vec3(0, -0.02f, -0.02f), vec3(0.04f, 0.09f, 0.04f), 230, 120, 20);
                ren.modelBox(vec3(0, 0.05f, -0.02f), vec3(0.042f, 0.012f, 0.042f), 222, 168, 30);
                break;
            case TOOL_MINIGUN:
                ren.modelBox(vec3(0, -0.02f, -0.05f - rec * 0.03f), vec3(0.06f, 0.06f, 0.30f), 60, 62, 66);
                ren.modelBox(vec3(0.02f, 0.0f, 0.20f - rec * 0.03f), vec3(0.012f, 0.012f, 0.08f), 90, 92, 96);
                ren.modelBox(vec3(-0.02f, 0.0f, 0.20f - rec * 0.03f), vec3(0.012f, 0.012f, 0.08f), 90, 92, 96);
                ren.modelBox(vec3(0, -0.08f, 0.02f - rec * 0.03f), vec3(0.025f, 0.06f, 0.06f), 40, 40, 44);
                break;
            case TOOL_ROCKET:
            default:
                ren.modelBox(vec3(0, -0.01f, -0.05f - rec * 0.08f), vec3(0.06f, 0.06f, 0.34f), 60, 66, 58);
                ren.modelBox(vec3(0, -0.08f, 0.02f - rec * 0.08f), vec3(0.025f, 0.06f, 0.10f), 30, 30, 32);
                ren.modelBox(vec3(0, 0.02f, -0.36f - rec * 0.08f), vec3(0.08f, 0.08f, 0.03f), 200, 60, 40);
                break;
        }
        ren.modelDraw(model, mapInfo, 1.0f);

        // rocket bodies in flight
        for (auto& r : weapons.rockets) {
            ren.modelBegin();
            ren.modelBox(r.pos, vec3(0.05f, 0.05f, 0.2f), 200, 60, 40, 2);
            mat4 rm = mat4_translate(r.pos);
            ren.modelDraw(rm, mapInfo, 1.0f);
        }
    }

    // ---------------------------------------------------------------- UI
    void renderUI() {
        glViewport(0, 0, plat->st.width, plat->st.height);
        switch (state) {
            case ST_MAIN_MENU: uiMainMenu(); break;
            case ST_MAP_SELECT: uiMapSelect(); break;
            case ST_MP_MENU: uiMpMenu(); break;
            case ST_OPTIONS: uiOptions(); break;
            case ST_LOADING: uiLoading(); break;
            case ST_DISCONNECTED: uiDisconnected(); break;
            case ST_PLAYING: uiHud(); if (paused) uiPauseOverlay(); break;
            default: break;
        }
        if (statusTimer > 0 && (state == ST_MP_MENU || state == ST_MAIN_MENU))
            ren.uiTextCentered(statusMsg.c_str(), plat->st.width * 0.5f, 96, 2.2f, 1.f, 0.85f, 0.3f, std::min(1.f, statusTimer));
    }

    // Flat, minimal, dark-with-one-amber-accent styling — matching Teardown's own UI, which
    // (per its renderer breakdown) is "only a few quads... blended straight onto the
    // framebuffer": sharp corners, thin borders, no drop shadows or heavy gradients.
    static constexpr float UI_ACCENT_R = 0.95f, UI_ACCENT_G = 0.62f, UI_ACCENT_B = 0.15f;

    bool btn(float x, float y, float w, float h, const char* label, bool highlight = false) {
        PlatformState& in = plat->st;
        bool hover = in.mouseX >= x && in.mouseX <= x + w && in.mouseY >= y && in.mouseY <= y + h;
        vec3 base = hover ? vec3(0.145f, 0.15f, 0.175f) : vec3(0.09f, 0.095f, 0.11f);
        ren.uiRect(x, y, w, h, base.x, base.y, base.z, 0.95f, 2.f);
        bool accented = highlight || hover;
        vec3 bc = accented ? vec3(UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B) : vec3(0.34f, 0.36f, 0.40f);
        float ba = accented ? 0.95f : 0.45f, bt = 1.5f;
        ren.uiRect(x, y, w, bt, bc.x, bc.y, bc.z, ba);
        ren.uiRect(x, y + h - bt, w, bt, bc.x, bc.y, bc.z, ba);
        ren.uiRect(x, y, bt, h, bc.x, bc.y, bc.z, ba);
        ren.uiRect(x + w - bt, y, bt, h, bc.x, bc.y, bc.z, ba);
        if (highlight) ren.uiRect(x, y, 4.f, h, bc.x, bc.y, bc.z, 1.f);
        vec3 tc = highlight ? bc : vec3(0.93f, 0.94f, 0.96f);
        ren.uiTextCentered(label, x + w * 0.5f, y + h * 0.5f - 7, 2.0f, tc.x, tc.y, tc.z, 1);
        return hover && in.mousePressed[0];
    }

    void panelBg() {
        ren.uiRect(0, 0, (float)plat->st.width, (float)plat->st.height, 0.035f, 0.038f, 0.045f, 1.f);
        // thin amber baseline near the bottom, a small recurring Teardown-HUD motif
        ren.uiRect(0, (float)plat->st.height - 3, (float)plat->st.width, 1.5f, UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B, 0.5f);
    }

    void uiMainMenu() {
        panelBg();
        float cx = plat->st.width * 0.5f;
        ren.uiTextCentered("VOXWRECK", cx, 90, 6.5f, 1.f, 0.55f, 0.18f, 1.f);
        ren.uiTextCentered("SANDBOX DESTRUCTION", cx, 155, 2.0f, 0.7f, 0.72f, 0.78f, 0.85f);
        float bw = 380, bh = 56, x = cx - bw * 0.5f, y = 260, gap = 68;
        if (btn(x, y, bw, bh, "SANDBOX MODE", true)) { audio.play(SND_CLICK); state = ST_MAP_SELECT; }
        if (btn(x, y + gap, bw, bh, "MULTIPLAYER")) { audio.play(SND_CLICK); state = ST_MP_MENU; }
        if (btn(x, y + gap * 2, bw, bh, "OPTIONS")) { audio.play(SND_CLICK); state = ST_OPTIONS; }
        if (btn(x, y + gap * 3, bw, bh, "QUIT")) { plat->st.quit = true; }
        ren.uiTextCentered("WASD MOVE  MOUSE LOOK  SCROLL WEAPON  LMB FIRE  ESC PAUSE",
                           cx, (float)plat->st.height - 40, 1.4f, 0.55f, 0.57f, 0.62f, 0.8f);
    }

    void uiMapSelect() {
        panelBg();
        float cx = plat->st.width * 0.5f;
        ren.uiTextCentered("SELECT MAP", cx, 60, 3.6f, 1, 1, 1, 1);
        const char* names[MAP_COUNT] = {"EVERMORE MALL", "SANDPOINT MARINA", "WRECKER HQ"};
        const char* descs[MAP_COUNT] = {"TWO-STOREY MALL: ATRIUM, SHOPS, PARKING LOT.",
                                         "SUNSET HARBOR: WAREHOUSE, CRANE, FUEL DEPOT, BOATS.",
                                         "HOME BASE: WOODEN HQ HOUSE, WORKSHOP, YARD, SHORE."};
        float gap = 40, ch = 260;
        float cw = std::min(420.f, (plat->st.width - 120.f - gap * (MAP_COUNT - 1)) / MAP_COUNT);
        float totalW = cw * MAP_COUNT + gap * (MAP_COUNT - 1);
        float startX = cx - totalW * 0.5f;
        for (int i = 0; i < MAP_COUNT; i++) {
            float x = startX + i * (cw + gap), y = 140;
            PlatformState& in = plat->st;
            bool hover = in.mouseX >= x && in.mouseX <= x + cw && in.mouseY >= y && in.mouseY <= y + ch;
            ren.uiRect(x, y, cw, ch, hover ? 0.13f : 0.09f, hover ? 0.135f : 0.095f, hover ? 0.155f : 0.11f, 0.95f, 2.f);
            vec3 bc = hover ? vec3(UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B) : vec3(0.3f, 0.32f, 0.36f);
            ren.uiRect(x, y, cw, 1.5f, bc.x, bc.y, bc.z, hover ? 0.9f : 0.4f);
            vec3 tint = i == 0 ? vec3(0.35f, 0.55f, 0.9f)
                      : i == 1 ? vec3(0.95f, 0.55f, 0.25f) : vec3(0.45f, 0.70f, 0.35f);
            ren.uiRect(x + 16, y + 16, cw - 32, 120, tint.x, tint.y, tint.z, 0.35f, 2.f);
            ren.uiTextCentered(names[i], x + cw * 0.5f, y + 152, 2.4f, 1, 1, 1, 1);
            // wrap desc into ~2 lines manually by splitting on spaces roughly
            ren.uiTextCentered(descs[i], x + cw * 0.5f, y + 190, 1.3f, 0.75f, 0.78f, 0.82f, 0.9f);
            if (hover && in.mousePressed[0]) { audio.play(SND_CLICK); startSingleplayer(i); }
        }
        if (btn(cx - 100, (float)plat->st.height - 90, 200, 50, "BACK"))
            { audio.play(SND_CLICK); state = ST_MAIN_MENU; }
    }

    void uiMpMenu() {
        panelBg();
        float cx = plat->st.width * 0.5f;
        ren.uiTextCentered("MULTIPLAYER", cx, 70, 3.4f, 1, 1, 1, 1);
        float bw = 420, bh = 56, x = cx - bw * 0.5f, y = 190, gap = 68;
        ren.uiTextCentered("HOST A GAME", cx, y - 24, 1.6f, 0.7f, 0.75f, 0.85f, 0.8f);
        const char* mapNames[MAP_COUNT] = {"HOST: EVERMORE MALL", "HOST: SANDPOINT MARINA", "HOST: WRECKER HQ"};
        for (int i = 0; i < MAP_COUNT; i++)
            if (btn(x, y + i * gap, bw, bh, mapNames[i], true)) { audio.play(SND_CLICK); startHost(i); }

        float jy = y + gap * MAP_COUNT + 30;
        ren.uiTextCentered("JOIN A GAME (ENTER HOST IP)", cx, jy - 22, 1.6f, 0.7f, 0.75f, 0.85f, 0.8f);
        // IP input box
        PlatformState& in = plat->st;
        float ix = x, iy = jy, iw = bw, ih = bh;
        bool hover = in.mouseX >= ix && in.mouseX <= ix + iw && in.mouseY >= iy && in.mouseY <= iy + ih;
        if (hover && in.mousePressed[0]) typingJoinIp = true;
        if (typingJoinIp) {
            for (int i = 0; i < in.textLen; i++) {
                char c = in.textInput[i];
                if ((c >= '0' && c <= '9') || c == '.') { if (joinIpBuf.size() < 15) joinIpBuf += c; }
            }
            if (in.keyPressed[VK_BACK] && !joinIpBuf.empty()) joinIpBuf.pop_back();
        }
        ren.uiRect(ix, iy, iw, ih, 0.08f, 0.085f, 0.10f, 0.95f, 2.f);
        ren.uiRect(ix, iy, iw, 1.5f, UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B, typingJoinIp ? 0.9f : 0.4f);
        std::string shown = joinIpBuf + (typingJoinIp && ((int)(simTime * 2) % 2 == 0) ? "_" : "");
        ren.uiText(shown.c_str(), ix + 16, iy + ih * 0.5f - 7, 2.0f, 1, 1, 1, 1);

        if (btn(x, jy + gap, bw, bh, "CONNECT")) {
            audio.play(SND_CLICK);
            typingJoinIp = false;
            startJoin(joinIpBuf);
        }
        if (btn(cx - 100, (float)plat->st.height - 70, 200, 50, "BACK"))
            { audio.play(SND_CLICK); typingJoinIp = false; state = ST_MAIN_MENU; }
    }

    void uiOptions() {
        panelBg();
        float cx = plat->st.width * 0.5f;
        ren.uiTextCentered("OPTIONS", cx, 70, 3.4f, 1, 1, 1, 1);
        float x = cx - 220, y = 200, gap = 78, bw = 440, bh = 56;
        const char* shadowLbl[3] = {"SHADOWS: LOW", "SHADOWS: MEDIUM", "SHADOWS: HIGH"};
        if (btn(x, y, bw, bh, shadowLbl[ren.settings.shadowQuality]))
            { audio.play(SND_CLICK); ren.settings.shadowQuality = (ren.settings.shadowQuality + 1) % 3; }
        const char* aoLbl[3] = {"AMBIENT OCCLUSION: LOW", "AMBIENT OCCLUSION: MEDIUM", "AMBIENT OCCLUSION: HIGH"};
        if (btn(x, y + gap, bw, bh, aoLbl[ren.settings.aoQuality]))
            { audio.play(SND_CLICK); ren.settings.aoQuality = (ren.settings.aoQuality + 1) % 3; }
        char vsyncLbl[32];
        std::snprintf(vsyncLbl, sizeof vsyncLbl, "VSYNC: %s", ren.settings.vsync ? "ON" : "OFF");
        if (btn(x, y + gap * 2, bw, bh, vsyncLbl)) {
            audio.play(SND_CLICK);
            ren.settings.vsync = !ren.settings.vsync;
            plat->setVsync(ren.settings.vsync);
        }
        char bloomLbl[32];
        std::snprintf(bloomLbl, sizeof bloomLbl, "BLOOM: %d%%", (int)(ren.settings.bloom * 100));
        if (btn(x, y + gap * 3, bw, bh, bloomLbl)) {
            audio.play(SND_CLICK);
            ren.settings.bloom += 0.25f;
            if (ren.settings.bloom > 1.01f) ren.settings.bloom = 0.f;
        }
        char scaleLbl[48];
        std::snprintf(scaleLbl, sizeof scaleLbl, "RENDER SCALE: %.0f%%", ren.settings.renderScale * 100.f);
        if (btn(x, y + gap * 4, bw, bh, scaleLbl)) {
            audio.play(SND_CLICK);
            static const float scales[4] = {1.0f, 1.25f, 1.5f, 2.0f};
            int idx = 0;
            for (int i = 0; i < 4; i++) if (fabsf(ren.settings.renderScale - scales[i]) < 0.01f) idx = i;
            ren.settings.renderScale = scales[(idx + 1) % 4];
        }
        char despawnLbl[40];
        std::snprintf(despawnLbl, sizeof despawnLbl, "LOOSE DEBRIS: %s", despawnLooseProps ? "DESPAWNS" : "NEVER DESPAWNS");
        if (btn(x, y + gap * 5, bw, bh, despawnLbl)) {
            audio.play(SND_CLICK);
            despawnLooseProps = !despawnLooseProps;
            loose.despawnTime = despawnLooseProps ? 30.f : -1.f;
        }
        ren.uiTextCentered("HIGHER RENDER SCALE = SHARPER IMAGE, MORE GPU LOAD",
                           cx, y + gap * 6 - 12, 1.3f, 0.55f, 0.6f, 0.65f, 0.75f);
        ren.uiTextCentered("GL 3.3 CORE - RUNS ON NVIDIA / AMD / INTEL",
                           cx, y + gap * 6 + 20, 1.4f, 0.55f, 0.6f, 0.65f, 0.8f);
        char coreLbl[48];
        std::snprintf(coreLbl, sizeof coreLbl, "WORKER THREADS: %d", ThreadPool::get().workerCount());
        ren.uiTextCentered(coreLbl, cx, y + gap * 6 + 44, 1.4f, 0.55f, 0.6f, 0.65f, 0.8f);
        if (btn(cx - 100, (float)plat->st.height - 90, 200, 50, "BACK"))
            { audio.play(SND_CLICK); state = ST_MAIN_MENU; }
    }

    void uiLoading() {
        panelBg();
        float cx = plat->st.width * 0.5f, cy = plat->st.height * 0.5f;
        ren.uiTextCentered("CONNECTING...", cx, cy - 20, 3.0f, 1, 1, 1, 1);
        float ang = (float)simTime * 4.f;
        for (int i = 0; i < 8; i++) {
            float a = ang + i * 0.785f;
            float r = 1.f - (i / 8.f);
            ren.uiRect(cx + cosf(a) * 40 - 6, cy + 40 + sinf(a) * 40 - 6, 12, 12, 1, 0.6f, 0.2f, r);
        }
    }

    void uiDisconnected() {
        panelBg();
        float cx = plat->st.width * 0.5f, cy = plat->st.height * 0.5f;
        ren.uiTextCentered("DISCONNECTED", cx, cy - 60, 3.2f, 1, 0.4f, 0.35f, 1);
        ren.uiTextCentered(statusMsg.c_str(), cx, cy - 10, 1.6f, 0.8f, 0.8f, 0.82f, 0.9f);
        if (btn(cx - 130, cy + 40, 260, 54, "MAIN MENU")) { audio.play(SND_CLICK); returnToMenu(); }
    }

    void uiPauseOverlay() {
        ren.uiRect(0, 0, (float)plat->st.width, (float)plat->st.height, 0, 0, 0, 0.55f);
        float cx = plat->st.width * 0.5f;
        ren.uiTextCentered("PAUSED", cx, 130, 4.0f, 1, 1, 1, 1);
        float bw = 340, bh = 56, x = cx - bw * 0.5f, y = 260, gap = 68;
        if (btn(x, y, bw, bh, "RESUME", true)) { audio.play(SND_CLICK); paused = false; plat->setCapture(true); }
        if (btn(x, y + gap, bw, bh, "OPTIONS")) { audio.play(SND_CLICK); state = ST_OPTIONS; paused = false; }
        if (btn(x, y + gap * 2, bw, bh, "DISCONNECT / MENU")) { audio.play(SND_CLICK); paused = false; returnToMenu(); }
        if (role == NET_HOST) {
            char ipLbl[64];
            std::snprintf(ipLbl, sizeof ipLbl, "HOSTING ON PORT %d", NET_PORT);
            ren.uiTextCentered(ipLbl, cx, y + gap * 3 + 20, 1.6f, 0.7f, 0.85f, 0.7f, 0.9f);
        }
    }

    void uiHud() {
        int w = plat->st.width, h = plat->st.height;
        float cx = w * 0.5f, cy = h * 0.5f;
        // crosshair: small gapped cross + center dot, Teardown-style (not a bold solid plus)
        {
            float cs = 6.f, gap = 3.f, th = 1.5f;
            ren.uiRect(cx - gap - cs, cy - th * 0.5f, cs, th, 1, 1, 1, 0.85f);
            ren.uiRect(cx + gap, cy - th * 0.5f, cs, th, 1, 1, 1, 0.85f);
            ren.uiRect(cx - th * 0.5f, cy - gap - cs, th, cs, 1, 1, 1, 0.85f);
            ren.uiRect(cx - th * 0.5f, cy + gap, th, cs, 1, 1, 1, 0.85f);
            ren.uiRect(cx - 1, cy - 1, 2, 2, 1, 1, 1, 0.55f);
        }
        // grip hint: corner-bracket reticle when aiming at a grabbable piece of debris
        // (stands in for a hand-grip cursor icon, which this UI system has no bitmap for)
        {
            bool showGrab = false;
            if (weapons.current != TOOL_SPRAYCAN && grabbedProp < 0)
                showGrab = loose.findGrabbable(player.eye(), player.forward(), 2.5f) >= 0;
            if (showGrab) {
                float bs = 14.f, bl = 5.f, bt = 1.5f;
                float gr = UI_ACCENT_R, gg = UI_ACCENT_G, gb = UI_ACCENT_B;
                ren.uiRect(cx - bs, cy - bs, bl, bt, gr, gg, gb, 0.9f);
                ren.uiRect(cx - bs, cy - bs, bt, bl, gr, gg, gb, 0.9f);
                ren.uiRect(cx + bs - bl, cy - bs, bl, bt, gr, gg, gb, 0.9f);
                ren.uiRect(cx + bs - bt, cy - bs, bt, bl, gr, gg, gb, 0.9f);
                ren.uiRect(cx - bs, cy + bs - bt, bl, bt, gr, gg, gb, 0.9f);
                ren.uiRect(cx - bs, cy + bs - bl, bt, bl, gr, gg, gb, 0.9f);
                ren.uiRect(cx + bs - bl, cy + bs - bt, bl, bt, gr, gg, gb, 0.9f);
                ren.uiRect(cx + bs - bt, cy + bs - bl, bt, bl, gr, gg, gb, 0.9f);
            }
            if (grabbedProp >= 0) {
                const char* lbl = "CARRYING";
                ren.uiTextCentered(lbl, cx, cy + 22, 1.4f, UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B, 0.85f);
            }
        }
        // tool indicator: minimal corner tag, no panel — name + underline + a tick per tool
        {
            const char* nm = TOOL_NAMES[weapons.current];
            ren.uiText(nm, 28, h - 46, 1.8f, UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B, 1);
            float tw = ren.uiTextWidth(nm, 1.8f);
            ren.uiRect(28, h - 28, tw, 1.5f, UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B, 0.7f);
            for (int i = 0; i < TOOL_COUNT; i++) {
                float bx = 28 + i * 16;
                bool sel = (int)weapons.current == i;
                vec3 c = sel ? vec3(UI_ACCENT_R, UI_ACCENT_G, UI_ACCENT_B) : vec3(0.4f, 0.42f, 0.46f);
                ren.uiRect(bx, h - 20, 12, 3, c.x, c.y, c.z, sel ? 1.f : 0.5f);
            }
        }
        // map name
        char mapLbl[64];
        std::snprintf(mapLbl, sizeof mapLbl, "%s", mapInfo.name);
        ren.uiText(mapLbl, 24, 24, 1.6f, 0.85f, 0.87f, 0.92f, 0.85f);
        // players (mp)
        if (role != NET_OFFLINE) {
            int count = 1;
            for (auto& r : remotes) if (r.used) count++;
            char plLbl[32];
            std::snprintf(plLbl, sizeof plLbl, "PLAYERS: %d", count);
            ren.uiText(plLbl, 24, 48, 1.4f, 0.7f, 0.85f, 0.7f, 0.85f);
            if (role == NET_HOST) ren.uiText("HOSTING", (float)w - 160, 24, 1.4f, 1.f, 0.75f, 0.3f, 0.85f);
        }
        // fps
        char fpsLbl[16];
        std::snprintf(fpsLbl, sizeof fpsLbl, "%d FPS", curFps);
        ren.uiText(fpsLbl, (float)w - 110, 24, 1.4f, 0.6f, 0.9f, 0.6f, 0.8f);
    }

    int curFps = 0;
};
