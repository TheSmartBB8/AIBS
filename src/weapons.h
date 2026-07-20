// weapons.h - sledgehammer, pump shotgun, rocket launcher; explosions; barrel chains.
// All world edits flow through DestructionOp so they can be replicated over the network.
#pragma once
#include "vmath.h"
#include "world.h"
#include "particles.h"
#include <vector>
#include <functional>

enum Tool : uint8_t { TOOL_SLEDGE = 0, TOOL_SHOTGUN = 1, TOOL_ROCKET = 2, TOOL_COUNT = 3 };
static const char* TOOL_NAMES[TOOL_COUNT] = {"SLEDGEHAMMER", "SHOTGUN", "ROCKET LAUNCHER"};

// a networked destruction operation: destroy sphere (+ visual push dir for debris)
struct DestructionOp {
    float x, y, z;
    float radius;
    uint32_t matMask;
    float px, py, pz;      // debris push direction
    uint8_t big;           // 1 = explosion (fireball fx + shake), 0 = impact
};

// visual-only fire event for remote players (muzzle flash, tracer, rocket spawn)
struct FireEvent {
    uint8_t tool;
    float ox, oy, oz;
    float dx, dy, dz;
};

struct Rocket {
    vec3 pos, vel;
    float life = 0;
    bool local = false;    // only local rockets produce authoritative explosions
    bool alive = true;
};

struct WeaponsState {
    Tool current = TOOL_SLEDGE;
    float cooldown = 0;
    float swingAnim = 0;       // sledge swing 1->0
    float recoilAnim = 0;      // shotgun/rocket recoil 1->0
    float pumpAnim = 0;
    std::vector<Rocket> rockets;

    static constexpr uint32_t MASK_SLEDGE = (1u << M_LIGHT) | (1u << M_MED) | (1u << M_BARREL);
    static constexpr uint32_t MASK_SHOT = (1u << M_LIGHT) | (1u << M_MED) | (1u << M_BARREL);
    static constexpr uint32_t MASK_EXPLOSION = (1u << M_LIGHT) | (1u << M_MED) | (1u << M_HEAVY) | (1u << M_BARREL);

    float cooldownFor(Tool t) const {
        switch (t) {
            case TOOL_SLEDGE: return 0.55f;
            case TOOL_SHOTGUN: return 0.95f;
            default: return 1.6f;
        }
    }
};

// The game supplies these callbacks; ops are applied locally AND queued to the network.
struct WeaponContext {
    World* world;
    ParticleSystem* particles;
    std::function<void(const DestructionOp&)> emitOp;      // apply + replicate
    std::function<void(const FireEvent&)> emitFire;        // replicate visuals
    std::function<void(vec3, float)> addShake;             // pos, amount
    std::function<void(int)> playSound;                    // sound id
    std::function<void(vec3, vec3, float, float)> addLight; // pos, color, radius, life
};

// sound ids (must match audio.h)
enum : int { SND_SLEDGE_SWING = 0, SND_SLEDGE_HIT, SND_SHOTGUN, SND_ROCKET_FIRE, SND_EXPLOSION,
             SND_GLASS, SND_DEBRIS, SND_CLICK, SND_RELOAD, SND_COUNT };

// ---------------- destruction application (shared by local actions and network ops)
// Applies the op to the world with particles/fx; runs integrity; chains barrels via emitOp.
static void applyDestructionOp(WeaponContext& ctx, const DestructionOp& op, bool withFx = true) {
    World& w = *ctx.world;
    vec3 c(op.x, op.y, op.z);
    vec3 push = vnorm(vec3(op.px, op.py, op.pz));
    ParticleSystem* ps = ctx.particles;

    // find barrels triggered before voxels vanish
    std::vector<int> triggered;
    w.findTriggeredBarrels(c, op.radius, op.matMask, triggered);

    int glassCount = 0;
    Rng fxRng((uint32_t)(fabsf(op.x * 133.7f) + fabsf(op.z * 77.7f)) + 1);
    int destroyed = w.destroySphere(c, op.radius, op.matMask,
        [&](int x, int y, int z, uint8_t pal) {
            const PalEntry& pe = w.palette[pal];
            if (pe.mat == M_LIGHT) glassCount++;
            if (!ps) return;
            // spawn debris for a fraction of destroyed voxels
            if (fxRng.uf() < (op.big ? 0.10f : 0.35f)) {
                vec3 vp((x + 0.5f) * VOXEL_SIZE, (y + 0.5f) * VOXEL_SIZE, (z + 0.5f) * VOXEL_SIZE);
                ps->voxelDebris(vp, pe.r, pe.g, pe.b, push, op.big ? 7.5f : 2.8f);
            }
            if (fxRng.uf() < 0.05f) {
                vec3 vp((x + 0.5f) * VOXEL_SIZE, (y + 0.5f) * VOXEL_SIZE, (z + 0.5f) * VOXEL_SIZE);
                ps->dust(vp, push * 1.2f + vec3(0, 0.8f, 0), 0.35f, 1.1f,
                         pe.r / 400.f + 0.25f, pe.g / 400.f + 0.25f, pe.b / 400.f + 0.25f);
            }
        });

    if (withFx && ps) {
        if (op.big) {
            ps->explosionBurst(c, op.radius);
            if (ctx.addShake) ctx.addShake(c, 1.0f);
            if (ctx.playSound) ctx.playSound(SND_EXPLOSION);
            if (ctx.addLight) ctx.addLight(c, vec3(1.f, 0.6f, 0.25f) * 30.f, op.radius * 6.f, 0.4f);
        } else if (destroyed > 0) {
            if (ctx.playSound) ctx.playSound(glassCount > destroyed / 3 ? SND_GLASS : SND_DEBRIS);
        }
    }

    // structural integrity around the edit
    if (destroyed > 0) {
        w.checkIntegrity(c, op.radius, [&](int x, int y, int z, uint8_t pal) {
            if (!ps) return;
            const PalEntry& pe = w.palette[pal];
            vec3 vp((x + 0.5f) * VOXEL_SIZE, (y + 0.5f) * VOXEL_SIZE, (z + 0.5f) * VOXEL_SIZE);
            if (fxRng.uf() < 0.4f)
                ps->voxelDebris(vp, pe.r, pe.g, pe.b, vec3(0, -0.3f, 0), 1.2f);
        });
        // mesh any new clusters
        for (auto& fc : w.clusters)
            if (fc.verts.empty() && !fc.landed) w.meshCluster(fc);
    }

    // chain-detonate barrels (delayed emission handled by caller storing pending)
    for (int bi : triggered) {
        if (bi < 0 || bi >= (int)w.barrels.size()) continue;
        Barrel& b = w.barrels[bi];
        if (!b.alive) continue;
        b.alive = false;
        DestructionOp bop;
        bop.x = b.x; bop.y = b.y; bop.z = b.z;
        bop.radius = 2.4f;
        bop.matMask = WeaponsState::MASK_EXPLOSION;
        bop.px = 0; bop.py = 1; bop.pz = 0;
        bop.big = 1;
        // recursive: apply locally right away (deterministic given same initial op)
        applyDestructionOp(ctx, bop, withFx);
    }
}

// ---------------- firing
static void fireSledge(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir) {
    ws.swingAnim = 1.f;
    if (ctx.playSound) ctx.playSound(SND_SLEDGE_SWING);
    if (ctx.emitFire) ctx.emitFire({TOOL_SLEDGE, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    World::RayHit h = ctx.world->raycast(eye, dir, 3.6f);
    if (!h.hit) return;
    if (ctx.playSound) ctx.playSound(SND_SLEDGE_HIT);
    DestructionOp op;
    vec3 p = h.pos - h.normal * 0.05f;
    op.x = p.x; op.y = p.y; op.z = p.z;
    op.radius = 0.38f;
    op.matMask = WeaponsState::MASK_SLEDGE;
    op.px = dir.x; op.py = dir.y + 0.4f; op.pz = dir.z;
    op.big = 0;
    if (ctx.emitOp) ctx.emitOp(op);
    if (ctx.addShake) ctx.addShake(eye, 0.15f);
}

static void fireShotgun(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir, uint32_t seed) {
    ws.recoilAnim = 1.f;
    ws.pumpAnim = 1.f;
    if (ctx.playSound) ctx.playSound(SND_SHOTGUN);
    if (ctx.emitFire) ctx.emitFire({TOOL_SHOTGUN, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    // muzzle fx
    vec3 muzzle = eye + dir * 0.7f;
    if (ctx.particles) {
        ctx.particles->flash(muzzle, 0.5f);
        for (int i = 0; i < 5; i++)
            ctx.particles->smoke(muzzle, dir * 2.2f + vec3(0, 0.5f, 0), 0.16f, 0.55f, 0.32f);
    }
    if (ctx.addLight) ctx.addLight(muzzle, vec3(1.f, 0.75f, 0.4f) * 10.f, 5.f, 0.08f);
    if (ctx.addShake) ctx.addShake(eye, 0.28f);

    Rng rng(seed ? seed : 1);
    vec3 right = vnorm(vcross(dir, vec3(0, 1, 0)));
    vec3 up = vcross(right, dir);
    for (int i = 0; i < 8; i++) {
        float a = rng.uf() * 6.28318f, r = rng.uf() * 0.055f;
        vec3 pd = vnorm(dir + right * cosf(a) * r + up * sinf(a) * r);
        World::RayHit h = ctx.world->raycast(eye, pd, 60.f);
        if (!h.hit) continue;
        const PalEntry& pe = ctx.world->palette[h.pal];
        if (pe.mat == M_HEAVY || pe.mat == M_BEDROCK) {
            // sparks ricochet, tiny chip
            if (ctx.particles)
                for (int s = 0; s < 3; s++)
                    ctx.particles->spark(h.pos, h.normal * (3.f + rng.uf() * 4.f) +
                                         vec3(rng.sf(), rng.uf(), rng.sf()) * 2.f);
        }
        DestructionOp op;
        vec3 p = h.pos - h.normal * 0.04f;
        op.x = p.x; op.y = p.y; op.z = p.z;
        op.radius = 0.17f;
        op.matMask = WeaponsState::MASK_SHOT;
        op.px = pd.x; op.py = pd.y; op.pz = pd.z;
        op.big = 0;
        if (ctx.emitOp) ctx.emitOp(op);
    }
}

static void fireRocket(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir, bool local) {
    ws.recoilAnim = 1.f;
    if (ctx.playSound) ctx.playSound(SND_ROCKET_FIRE);
    if (local && ctx.emitFire) ctx.emitFire({TOOL_ROCKET, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    Rocket r;
    r.pos = eye + dir * 0.8f;
    r.vel = dir * 30.f;
    r.local = local;
    ws.rockets.push_back(r);
    if (ctx.particles) ctx.particles->flash(r.pos, 0.4f);
    if (ctx.addShake && local) ctx.addShake(eye, 0.2f);
}

// rocket simulation; local rockets emit an explosion op at impact
static void updateRockets(WeaponContext& ctx, WeaponsState& ws, float dt) {
    for (auto& r : ws.rockets) {
        if (!r.alive) continue;
        r.life += dt;
        if (r.life > 8.f) { r.alive = false; continue; }
        vec3 np = r.pos + r.vel * dt;
        r.vel.y -= 1.8f * dt;
        // trail
        if (ctx.particles) {
            ctx.particles->trail(r.pos, vec3(0, 0, 0));
            ctx.particles->fire(r.pos, -r.vel * 0.05f, 0.14f, 0.16f);
        }
        if (ctx.addLight) ctx.addLight(r.pos, vec3(1.f, 0.6f, 0.3f) * 4.f, 4.f, 0.05f);
        // collision along path
        World::RayHit h = ctx.world->raycast(r.pos, vnorm(np - r.pos), vlen(np - r.pos) + 0.05f);
        bool boom = false;
        vec3 bp;
        if (h.hit) { boom = true; bp = h.pos + h.normal * 0.1f; }
        else if (np.y < -2.f) { boom = true; bp = np; }
        if (boom) {
            r.alive = false;
            if (r.local) {
                DestructionOp op;
                op.x = bp.x; op.y = bp.y; op.z = bp.z;
                op.radius = 2.3f;
                op.matMask = WeaponsState::MASK_EXPLOSION;
                op.px = r.vel.x; op.py = 0.6f; op.pz = r.vel.z;
                op.big = 1;
                if (ctx.emitOp) ctx.emitOp(op);
            }
            // remote rockets: fx only (the owner's op will arrive over the network)
        } else r.pos = np;
    }
    ws.rockets.erase(std::remove_if(ws.rockets.begin(), ws.rockets.end(),
                     [](const Rocket& r) { return !r.alive; }), ws.rockets.end());
}
