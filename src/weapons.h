// weapons.h - the Teardown-style tool roster: destructive tools (sledge, blowtorch, firearms,
// explosives) and utility tools (spray can, extinguisher, leaf blower). Explosions and barrel
// chains. All world edits flow through DestructionOp so they replicate over the network.
// Plank and Cable (Teardown's constructive tools) are intentionally not implemented here: both
// rely on a rigid-body constraint physics system this engine doesn't have, and bolting one on
// without the ability to visually test it would be too high-risk to ship blind.
#pragma once
#include "vmath.h"
#include "world.h"
#include "particles.h"
#include <vector>
#include <functional>
#include <algorithm>

enum Tool : uint8_t {
    TOOL_SLEDGE = 0, TOOL_SPRAYCAN, TOOL_EXTINGUISHER, TOOL_LEAFBLOWER, TOOL_BLOWTORCH,
    TOOL_SHOTGUN, TOOL_GUN, TOOL_RIFLE,
    TOOL_PIPEBOMB, TOOL_BOMB, TOOL_NITRO, TOOL_ROCKET, TOOL_MINIGUN,
    TOOL_COUNT
};
static const char* TOOL_NAMES[TOOL_COUNT] = {
    "SLEDGEHAMMER", "SPRAY CAN", "FIRE EXTINGUISHER", "LEAF BLOWER", "BLOWTORCH",
    "SHOTGUN", "PISTOL", "HUNTING RIFLE",
    "PIPE BOMB", "BOMB", "NITROGLYCERIN", "ROCKET LAUNCHER", "MINIGUN",
};
// true for tools meant to be held down (continuous tick) rather than click-once
static inline bool toolIsContinuous(Tool t) {
    return t == TOOL_SPRAYCAN || t == TOOL_EXTINGUISHER || t == TOOL_LEAFBLOWER ||
           t == TOOL_BLOWTORCH || t == TOOL_MINIGUN;
}

// a networked destruction operation: destroy sphere (+ visual push dir for debris)
struct DestructionOp {
    float x, y, z;
    float radius;
    uint32_t matMask;
    float px, py, pz;      // debris push direction
    uint8_t big;           // 1 = explosion (fireball fx + shake), 0 = impact
};

// visual-only fire event for remote players (muzzle flash, tracer, projectile spawn)
struct FireEvent {
    uint8_t tool;
    float ox, oy, oz;
    float dx, dy, dz;
};

// covers both the rocket (impact-triggered, low drop) and the pipe bomb (arcing throw,
// bounces/settles, timed fuse) — same struct, a flag switches the simulation mode.
struct Rocket {
    vec3 pos, vel;
    float life = 0;
    bool local = false;    // only local projectiles produce authoritative explosions
    bool alive = true;
    bool grenade = false;  // true = pipe bomb behavior (arc + bounce + timer, not impact)
    float fuse = 0;
    float radius = 2.3f;
    bool resting = false;
};

// a placed, timed explosive (Bomb)
struct PlacedProp {
    vec3 pos;
    float fuse = 3.0f;
    float radius = 3.0f;
    bool alive = true;
};

struct WeaponsState {
    Tool current = TOOL_SLEDGE;
    float cooldown = 0;
    float swingAnim = 0;       // sledge swing 1->0
    float recoilAnim = 0;      // firearm/rocket recoil 1->0
    float pumpAnim = 0;
    std::vector<Rocket> rockets;
    std::vector<PlacedProp> placedBombs;

    float sprayR = 1.f, sprayG = 0.15f, sprayB = 0.6f;
    int sprayColorIdx = 0;
    void cycleSprayColor() {
        static const float cols[4][3] = {{1.f, 0.15f, 0.6f}, {0.15f, 0.55f, 1.f}, {1.f, 0.85f, 0.1f}, {0.15f, 0.9f, 0.35f}};
        sprayColorIdx = (sprayColorIdx + 1) % 4;
        sprayR = cols[sprayColorIdx][0]; sprayG = cols[sprayColorIdx][1]; sprayB = cols[sprayColorIdx][2];
    }

    static constexpr uint32_t MASK_SLEDGE = (1u << M_LIGHT) | (1u << M_MED) | (1u << M_BARREL);
    static constexpr uint32_t MASK_SHOT = (1u << M_LIGHT) | (1u << M_MED) | (1u << M_BARREL);
    static constexpr uint32_t MASK_TORCH = (1u << M_LIGHT) | (1u << M_MED) | (1u << M_HEAVY) | (1u << M_BARREL);
    static constexpr uint32_t MASK_EXPLOSION = (1u << M_LIGHT) | (1u << M_MED) | (1u << M_HEAVY) | (1u << M_BARREL);

    float cooldownFor(Tool t) const {
        switch (t) {
            case TOOL_SLEDGE: return 0.55f;
            case TOOL_SPRAYCAN: return 0.04f;
            case TOOL_EXTINGUISHER: return 0.05f;
            case TOOL_LEAFBLOWER: return 0.05f;
            case TOOL_BLOWTORCH: return 0.05f;
            case TOOL_SHOTGUN: return 0.95f;
            case TOOL_GUN: return 0.22f;
            case TOOL_RIFLE: return 0.85f;
            case TOOL_PIPEBOMB: return 1.1f;
            case TOOL_BOMB: return 1.3f;
            case TOOL_NITRO: return 1.3f;
            case TOOL_ROCKET: return 1.6f;
            case TOOL_MINIGUN: return 0.09f;
            default: return 0.5f;
        }
    }
};

// The game supplies these callbacks; ops are applied locally AND queued to the network.
// Fire/loose-debris hooks are plain callbacks (not a FireSystem*/LooseVoxelSystem* pointer)
// so this header stays fully decoupled from props.h — weapons.h has no idea those systems
// exist, it just calls the hook if the caller (game.h) wired one up. All are optional: an
// unset std::function is fine to leave uncalled, used by tests that don't need fire/debris.
struct WeaponContext {
    World* world;
    ParticleSystem* particles;
    std::function<void(const DestructionOp&)> emitOp;      // apply + replicate
    std::function<void(const FireEvent&)> emitFire;        // replicate visuals
    std::function<void(vec3, float)> addShake;             // pos, amount
    std::function<void(int)> playSound;                    // sound id
    std::function<void(vec3, vec3, float, float)> addLight; // pos, color, radius, life
    std::function<void(int, int, int)> tryIgnite;                     // voxel coords
    std::function<void(vec3, vec3, float, float)> extinguishFireCone; // eye, dir, range, cosHalfAngle
    std::function<void(vec3, uint8_t, vec3)> spawnLooseDebris;        // pos, palette index, initial vel
};

// sound ids (must match audio.h)
enum : int { SND_SLEDGE_SWING = 0, SND_SLEDGE_HIT, SND_SHOTGUN, SND_ROCKET_FIRE, SND_EXPLOSION,
             SND_GLASS, SND_DEBRIS, SND_CLICK, SND_RELOAD,
             SND_TORCH, SND_HISS, SND_GUNSHOT, SND_RIFLESHOT, SND_BEEP, SND_COUNT };

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
            // explosions "sometimes" start fires (per Teardown's own tool documentation)
            if (ctx.tryIgnite) {
                for (int i = 0; i < 4; i++) {
                    if (fxRng.uf() > 0.35f) continue;
                    vec3 jp = c + vec3(fxRng.sf(), fxRng.uf(), fxRng.sf()) * op.radius;
                    ctx.tryIgnite((int)floorf(jp.x / VOXEL_SIZE), (int)floorf(jp.y / VOXEL_SIZE), (int)floorf(jp.z / VOXEL_SIZE));
                }
            }
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
            if (ctx.spawnLooseDebris && fxRng.uf() < 0.15f)
                ctx.spawnLooseDebris(vp, pal, vec3(fxRng.sf(), fxRng.uf() * 0.5f, fxRng.sf()) * 1.5f);
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

// ---------------- unlimited tools ----------------
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

// Spray can: purely cosmetic recolor, preserves whatever material each voxel already is
// (a painted concrete wall is still concrete) — matches Teardown's separation of color from
// physical material. Local-only (not replicated): a reasonable simplification since the tool
// is fundamentally a route-marking aid, not something that needs to affect other players'
// destruction physics.
static void fireSpraycan(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir) {
    if (ctx.emitFire) ctx.emitFire({TOOL_SPRAYCAN, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    World::RayHit h = ctx.world->raycast(eye, dir, 12.f);
    if (ctx.playSound) ctx.playSound(SND_HISS);
    if (!h.hit) return;
    float falloff = clampf(1.f - h.dist / 12.f, 0.2f, 1.f);
    if (ctx.particles) {
        int n = (int)(6 * falloff);
        for (int i = 0; i < n; i++)
            ctx.particles->dust(h.pos, h.normal * 0.3f, 0.05f, 0.4f, ws.sprayR, ws.sprayG, ws.sprayB);
    }
    World& w = *ctx.world;
    float r = 0.35f + (1.f - falloff) * 0.5f;
    int rv = (int)ceilf(r / VOXEL_SIZE);
    int cx = (int)floorf(h.pos.x / VOXEL_SIZE), cy = (int)floorf(h.pos.y / VOXEL_SIZE), cz = (int)floorf(h.pos.z / VOXEL_SIZE);
    for (int dz = -rv; dz <= rv; dz++)
        for (int dyv = -rv; dyv <= rv; dyv++)
            for (int dx = -rv; dx <= rv; dx++) {
                if (dx * dx + dyv * dyv + dz * dz > rv * rv) continue;
                int x = cx + dx, y = cy + dyv, z = cz + dz;
                if (!World::inBounds(x, y, z)) continue;
                uint8_t oldPal = w.vox[World::vidx(x, y, z)];
                if (oldPal == 0) continue;
                const PalEntry& old = w.palette[oldPal];
                uint8_t paintPal = w.addPal((int)(ws.sprayR * 255), (int)(ws.sprayG * 255),
                                            (int)(ws.sprayB * 255), (Material)old.mat, old.emissive);
                w.set(x, y, z, paintPal);
            }
}

// Fire extinguisher: extinguishes nearby fire particles in a forward cone, sprays mist.
// Purely a particle-pool effect — there's no persistent world fire state to put out (fire in
// this engine is a one-shot explosion effect, not a spreading simulation).
static void fireExtinguisher(WeaponContext& ctx, vec3 eye, vec3 dir) {
    if (ctx.emitFire) ctx.emitFire({TOOL_EXTINGUISHER, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    if (ctx.playSound) ctx.playSound(SND_HISS);
    if (!ctx.particles) return;
    for (int i = 0; i < 3; i++)
        ctx.particles->dust(eye + dir * 0.6f, dir * 4.f + vec3(0, 0.3f, 0), 0.18f, 0.35f, 0.9f, 0.92f, 0.95f);
    for (auto& p : ctx.particles->pool) {
        if (!p.alive || p.type != PT_FIRE) continue;
        vec3 to = p.pos - eye;
        float d = vlen(to);
        if (d > 6.f || d < 0.01f) continue;
        if (vdot(to / d, dir) < 0.85f) continue;
        p.alive = false;
        ctx.particles->dust(p.pos, vec3(0, 0.5f, 0), 0.12f, 0.4f, 0.85f, 0.87f, 0.9f);
    }
    if (ctx.extinguishFireCone) ctx.extinguishFireCone(eye, dir, 6.f, 0.85f);
}

// Leaf blower: pushes nearby debris/dust/smoke particles away in a forward cone.
static void fireLeafblower(WeaponContext& ctx, vec3 eye, vec3 dir) {
    if (ctx.emitFire) ctx.emitFire({TOOL_LEAFBLOWER, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    if (ctx.playSound) ctx.playSound(SND_HISS);
    if (!ctx.particles) return;
    for (int i = 0; i < 2; i++)
        ctx.particles->dust(eye + dir * 0.5f, dir * 3.5f, 0.12f, 0.3f, 0.75f, 0.7f, 0.55f);
    for (auto& p : ctx.particles->pool) {
        if (!p.alive) continue;
        if (p.type != PT_DEBRIS && p.type != PT_DUST && p.type != PT_SMOKE) continue;
        vec3 to = p.pos - eye;
        float d = vlen(to);
        if (d > 7.f || d < 0.05f) continue;
        vec3 tod = to / d;
        if (vdot(tod, dir) < 0.7f) continue;
        float force = (1.f - d / 7.f) * 14.f;
        p.vel += tod * force * 0.15f;
    }
}

// Blowtorch: the only unlimited tool that can cut metal, at short range and a narrow radius.
static void fireBlowtorch(WeaponContext& ctx, vec3 eye, vec3 dir) {
    if (ctx.emitFire) ctx.emitFire({TOOL_BLOWTORCH, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    World::RayHit h = ctx.world->raycast(eye, dir, 3.2f);
    vec3 tip = h.hit ? h.pos : eye + dir * 3.2f;
    if (ctx.particles) {
        ctx.particles->fire(tip, dir * 0.3f, 0.08f, 0.1f);
        Rng sparkRng((uint32_t)(fabsf(tip.x * 971.f) + fabsf(tip.z * 613.f)) + 1);
        for (int i = 0; i < 2; i++)
            ctx.particles->spark(tip, h.normal * (1.5f + sparkRng.uf() * 2.f) +
                                 vec3(sparkRng.sf(), sparkRng.uf(), sparkRng.sf()));
    }
    if (ctx.addLight) ctx.addLight(tip, vec3(1.f, 0.6f, 0.25f) * 3.f, 2.5f, 0.06f);
    if (ctx.playSound) ctx.playSound(SND_TORCH);
    if (!h.hit) return;
    // the blowtorch consistently starts fires on flammable material — try the touched voxel
    // and its immediate neighbors just past it, so a spreading fire can take hold even
    // though this same touch also chips a small amount of material away below
    if (ctx.tryIgnite) {
        ctx.tryIgnite(h.x, h.y, h.z);
        ctx.tryIgnite(h.x - (int)h.normal.x, h.y - (int)h.normal.y, h.z - (int)h.normal.z);
    }
    DestructionOp op;
    vec3 p = h.pos - h.normal * 0.05f;
    op.x = p.x; op.y = p.y; op.z = p.z;
    op.radius = 0.15f;
    op.matMask = WeaponsState::MASK_TORCH;
    op.px = dir.x; op.py = dir.y; op.pz = dir.z;
    op.big = 0;
    if (ctx.emitOp) ctx.emitOp(op);
}

// ---------------- firearms ----------------
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

// Pistol: precision hitscan, weak but fast follow-up, long range.
static void fireGun(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir) {
    ws.recoilAnim = 0.6f;
    if (ctx.playSound) ctx.playSound(SND_GUNSHOT);
    if (ctx.emitFire) ctx.emitFire({TOOL_GUN, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    vec3 muzzle = eye + dir * 0.6f;
    if (ctx.particles) {
        ctx.particles->flash(muzzle, 0.22f);
        ctx.particles->smoke(muzzle, dir * 1.6f, 0.08f, 0.3f, 0.3f);
    }
    if (ctx.addLight) ctx.addLight(muzzle, vec3(1.f, 0.8f, 0.5f) * 5.f, 3.f, 0.05f);
    if (ctx.addShake) ctx.addShake(eye, 0.08f);
    World::RayHit h = ctx.world->raycast(eye, dir, 80.f);
    if (!h.hit) return;
    DestructionOp op;
    vec3 p = h.pos - h.normal * 0.04f;
    op.x = p.x; op.y = p.y; op.z = p.z;
    op.radius = 0.12f;
    op.matMask = WeaponsState::MASK_SHOT;
    op.px = dir.x; op.py = dir.y; op.pz = dir.z;
    op.big = 0;
    if (ctx.emitOp) ctx.emitOp(op);
}

// Hunting rifle: penetrates through multiple weak/medium obstacles in a line, stopped only by
// heavy material or bedrock — matches "the special ability to penetrate through multiple
// obstacles at once."
static void fireRifle(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir) {
    ws.recoilAnim = 1.f;
    if (ctx.playSound) ctx.playSound(SND_RIFLESHOT);
    if (ctx.emitFire) ctx.emitFire({TOOL_RIFLE, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    vec3 muzzle = eye + dir * 0.7f;
    if (ctx.particles) {
        ctx.particles->flash(muzzle, 0.3f);
        ctx.particles->trail(muzzle, dir * 40.f);
    }
    if (ctx.addLight) ctx.addLight(muzzle, vec3(1.f, 0.8f, 0.5f) * 6.f, 3.f, 0.05f);
    if (ctx.addShake) ctx.addShake(eye, 0.18f);
    vec3 pos = eye;
    float remaining = 55.f;
    for (int i = 0; i < 6 && remaining > 0.5f; i++) {
        World::RayHit h = ctx.world->raycast(pos, dir, remaining);
        if (!h.hit) break;
        const PalEntry& pe = ctx.world->palette[h.pal];
        DestructionOp op;
        vec3 p = h.pos - h.normal * 0.04f;
        op.x = p.x; op.y = p.y; op.z = p.z;
        op.radius = 0.13f;
        op.matMask = WeaponsState::MASK_SHOT;
        op.px = dir.x; op.py = dir.y; op.pz = dir.z;
        op.big = 0;
        if (ctx.emitOp) ctx.emitOp(op);
        remaining -= h.dist;
        if (pe.mat == M_HEAVY || pe.mat == M_BEDROCK) break;
        pos = h.pos + dir * 0.35f;
        remaining -= 0.35f;
    }
}

// Minigun: fully automatic, weak per shot, high fire rate, tiny random spread.
static void fireMinigun(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir, uint32_t seed) {
    ws.recoilAnim = 0.35f;
    if (ctx.playSound) ctx.playSound(SND_GUNSHOT);
    if (ctx.emitFire) ctx.emitFire({TOOL_MINIGUN, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    Rng rng(seed ? seed : 1);
    vec3 spread = vnorm(dir + vec3(rng.sf(), rng.sf(), rng.sf()) * 0.02f);
    vec3 muzzle = eye + spread * 0.6f;
    if (ctx.particles) {
        ctx.particles->flash(muzzle, 0.2f);
        ctx.particles->smoke(muzzle, spread * 1.4f, 0.07f, 0.25f, 0.3f);
    }
    if (ctx.addLight) ctx.addLight(muzzle, vec3(1.f, 0.8f, 0.5f) * 4.f, 2.5f, 0.04f);
    if (ctx.addShake) ctx.addShake(eye, 0.05f);
    World::RayHit h = ctx.world->raycast(eye, spread, 70.f);
    if (!h.hit) return;
    DestructionOp op;
    vec3 p = h.pos - h.normal * 0.04f;
    op.x = p.x; op.y = p.y; op.z = p.z;
    op.radius = 0.10f;
    op.matMask = WeaponsState::MASK_SHOT;
    op.px = spread.x; op.py = spread.y; op.pz = spread.z;
    op.big = 0;
    if (ctx.emitOp) ctx.emitOp(op);
}

// ---------------- explosives ----------------
static void fireRocket(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir, bool local) {
    ws.recoilAnim = 1.f;
    if (ctx.playSound) ctx.playSound(SND_ROCKET_FIRE);
    if (local && ctx.emitFire) ctx.emitFire({TOOL_ROCKET, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    Rocket r;
    r.pos = eye + dir * 0.8f;
    r.vel = dir * 30.f;
    r.local = local;
    r.radius = 2.3f;
    ws.rockets.push_back(r);
    if (ctx.particles) ctx.particles->flash(r.pos, 0.4f);
    if (ctx.addShake && local) ctx.addShake(eye, 0.2f);
}

// Pipe bomb: thrown in an arc, bounces/settles, detonates on a timed fuse rather than impact.
static void firePipeBomb(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir, bool local) {
    ws.recoilAnim = 0.5f;
    if (ctx.playSound) ctx.playSound(SND_ROCKET_FIRE);
    if (local && ctx.emitFire) ctx.emitFire({TOOL_PIPEBOMB, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    Rocket r;
    r.pos = eye + dir * 0.6f;
    r.vel = dir * 16.f + vec3(0, 3.f, 0);
    r.local = local;
    r.grenade = true;
    r.fuse = 2.4f;
    r.radius = 2.0f;
    ws.rockets.push_back(r);
    if (ctx.particles) ctx.particles->flash(r.pos, 0.25f);
}

// Bomb: placeable, sticks to the surface aimed at, ~3s fuse then a large precise explosion.
static void fireBomb(WeaponContext& ctx, WeaponsState& ws, vec3 eye, vec3 dir) {
    if (ctx.emitFire) ctx.emitFire({TOOL_BOMB, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    World::RayHit h = ctx.world->raycast(eye, dir, 6.f);
    if (!h.hit) { if (ctx.playSound) ctx.playSound(SND_CLICK); return; }
    if (ctx.playSound) ctx.playSound(SND_BEEP);
    PlacedProp b;
    b.pos = h.pos + h.normal * 0.12f;
    b.fuse = 3.0f;
    b.radius = 3.0f;
    ws.placedBombs.push_back(b);
}

// Nitroglycerin: placeable canister that doesn't have a timer — it detonates only when
// damaged nearby, reusing the exact same barrel chain-reaction mechanism the map's fuel
// depot barrels already use (findTriggeredBarrels / applyDestructionOp), so the trigger
// logic is the same code path already exercised by the selftest suite.
static void fireNitro(WeaponContext& ctx, vec3 eye, vec3 dir) {
    if (ctx.emitFire) ctx.emitFire({TOOL_NITRO, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z});
    World::RayHit h = ctx.world->raycast(eye, dir, 6.f);
    if (!h.hit) { if (ctx.playSound) ctx.playSound(SND_CLICK); return; }
    if (ctx.playSound) ctx.playSound(SND_DEBRIS);
    World& w = *ctx.world;
    vec3 p = h.pos + h.normal * 0.05f;
    int cx = (int)floorf(p.x / VOXEL_SIZE), cy = (int)floorf(p.y / VOXEL_SIZE), cz = (int)floorf(p.z / VOXEL_SIZE);
    uint8_t canBody = w.addPal(230, 120, 20, M_BARREL);
    uint8_t canBand = w.addPal(222, 168, 30, M_BARREL);
    for (int dz = -1; dz <= 1; dz++)
        for (int dyv = 0; dyv <= 2; dyv++)
            for (int dx = -1; dx <= 1; dx++) {
                bool edgeMid = ((dx == 1 || dx == -1) && dz == 0) || ((dz == 1 || dz == -1) && dx == 0);
                if (dx == 0 && dz == 0) w.set(cx + dx, cy + dyv, cz + dz, dyv == 1 ? canBand : canBody);
                else if (edgeMid && dyv == 1) w.set(cx + dx, cy + dyv, cz + dz, canBody);
            }
    w.barrels.push_back({(cx + 0.5f) * VOXEL_SIZE, (cy + 1.5f) * VOXEL_SIZE, (cz + 0.5f) * VOXEL_SIZE, true});
}

// projectile simulation: rockets (impact-triggered) and pipe bombs (arc + timed fuse) share
// this update, distinguished by Rocket::grenade.
static void updateRockets(WeaponContext& ctx, WeaponsState& ws, float dt) {
    for (auto& r : ws.rockets) {
        if (!r.alive) continue;
        r.life += dt;
        if (r.life > 10.f) { r.alive = false; continue; }

        if (r.grenade) {
            r.fuse -= dt;
            if (!r.resting) {
                vec3 np = r.pos + r.vel * dt;
                r.vel.y -= 15.f * dt;
                World::RayHit h = ctx.world->raycast(r.pos, vnorm(np - r.pos), vlen(np - r.pos) + 0.05f);
                if (h.hit) {
                    vec3 reflected = r.vel - h.normal * (2.f * vdot(r.vel, h.normal));
                    r.vel = reflected * 0.35f;
                    r.pos = h.pos + h.normal * 0.05f;
                    if (vlen(r.vel) < 2.f) r.resting = true;
                } else if (np.y < -2.f) { r.resting = true; r.pos = np; }
                else r.pos = np;
            }
            if (ctx.particles) ctx.particles->trail(r.pos, vec3(0, 0, 0));
            if (r.fuse <= 0.f) {
                r.alive = false;
                if (r.local && ctx.emitOp) {
                    DestructionOp op;
                    op.x = r.pos.x; op.y = r.pos.y; op.z = r.pos.z;
                    op.radius = r.radius;
                    op.matMask = WeaponsState::MASK_EXPLOSION;
                    op.px = 0; op.py = 1; op.pz = 0;
                    op.big = 1;
                    ctx.emitOp(op);
                }
            }
            continue;
        }

        // rocket-style (impact-triggered)
        vec3 np = r.pos + r.vel * dt;
        r.vel.y -= 1.8f * dt;
        if (ctx.particles) {
            ctx.particles->trail(r.pos, vec3(0, 0, 0));
            ctx.particles->fire(r.pos, -r.vel * 0.05f, 0.14f, 0.16f);
        }
        if (ctx.addLight) ctx.addLight(r.pos, vec3(1.f, 0.6f, 0.3f) * 4.f, 4.f, 0.05f);
        World::RayHit h = ctx.world->raycast(r.pos, vnorm(np - r.pos), vlen(np - r.pos) + 0.05f);
        bool boom = false;
        vec3 bp;
        if (h.hit) { boom = true; bp = h.pos + h.normal * 0.1f; }
        else if (np.y < -2.f) { boom = true; bp = np; }
        if (boom) {
            r.alive = false;
            if (r.local && ctx.emitOp) {
                DestructionOp op;
                op.x = bp.x; op.y = bp.y; op.z = bp.z;
                op.radius = r.radius;
                op.matMask = WeaponsState::MASK_EXPLOSION;
                op.px = r.vel.x; op.py = 0.6f; op.pz = r.vel.z;
                op.big = 1;
                ctx.emitOp(op);
            }
        } else r.pos = np;
    }
    ws.rockets.erase(std::remove_if(ws.rockets.begin(), ws.rockets.end(),
                     [](const Rocket& r) { return !r.alive; }), ws.rockets.end());
}

// placed-bomb countdown: pulses a light and beeps as the fuse ticks down, then detonates.
static void updatePlacedBombs(WeaponContext& ctx, WeaponsState& ws, float dt) {
    for (auto& b : ws.placedBombs) {
        if (!b.alive) continue;
        float prevFuse = b.fuse;
        b.fuse -= dt;
        if (ctx.addLight) ctx.addLight(b.pos, vec3(1.f, 0.15f, 0.1f) * 3.f, 1.5f, 0.05f);
        if ((int)(prevFuse * 3.f) != (int)(b.fuse * 3.f) && ctx.playSound) ctx.playSound(SND_BEEP);
        if (b.fuse <= 0.f) {
            b.alive = false;
            if (ctx.emitOp) {
                DestructionOp op;
                op.x = b.pos.x; op.y = b.pos.y; op.z = b.pos.z;
                op.radius = b.radius;
                op.matMask = WeaponsState::MASK_EXPLOSION;
                op.px = 0; op.py = 1; op.pz = 0;
                op.big = 1;
                ctx.emitOp(op);
            }
        }
    }
    ws.placedBombs.erase(std::remove_if(ws.placedBombs.begin(), ws.placedBombs.end(),
                         [](const PlacedProp& b) { return !b.alive; }), ws.placedBombs.end());
}
