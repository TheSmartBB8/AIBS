// props.h - fire spread simulation and loose/grabbable voxel debris.
// Both systems are simulated locally per-client (like the barrel-reuse trick weapons.h
// already uses for nitroglycerin): every peer that applies a given DestructionOp — whether
// it originated locally or arrived over the network — independently rolls its own fire
// ignition and spawns its own loose-debris props. The only thing that has to agree between
// clients is the actual destroyed-voxel world state, and that still flows exclusively
// through the standard networked DestructionOp path, so multiplayer convergence holds.
#pragma once
#include "vmath.h"
#include "world.h"
#include "particles.h"
#include "weapons.h"
#include <vector>
#include <algorithm>

constexpr int MAX_FIRES = 100;              // matches Teardown's base-game default cap
constexpr float FIRE_BURN_TIME = 3.5f;      // seconds a voxel burns before being consumed
constexpr float FIRE_SPREAD_INTERVAL = 0.4f;
constexpr int MAX_LOOSE_VOXELS = 80;

struct FireVoxel {
    int x = 0, y = 0, z = 0;
    float life = 0;
    float nextSpread = 0;
    bool alive = true;
};

// Only M_MED (wood, drywall, brick-ish structural material in this engine's 5-material
// model) burns — the closest available analog to Teardown's "wood/plastic are flammable"
// rule given this engine doesn't subdivide materials as finely as the real game's palette.
struct FireSystem {
    std::vector<FireVoxel> fires;
    Rng rng{0xF12E1234u};

    bool isFlammable(const World& w, int x, int y, int z) const {
        uint8_t p = w.get(x, y, z);
        return p != 0 && w.palette[p].mat == M_MED;
    }
    bool isBurning(int x, int y, int z) const {
        for (auto& f : fires)
            if (f.alive && f.x == x && f.y == y && f.z == z) return true;
        return false;
    }
    bool ignite(const World& w, int x, int y, int z) {
        if ((int)fires.size() >= MAX_FIRES) return false;
        if (!isFlammable(w, x, y, z) || isBurning(x, y, z)) return false;
        FireVoxel f;
        f.x = x; f.y = y; f.z = z;
        f.nextSpread = FIRE_SPREAD_INTERVAL * (0.6f + rng.uf() * 0.8f);
        fires.push_back(f);
        return true;
    }
    void clearAll() { fires.clear(); }

    void update(float dt, WeaponContext& ctx, float waterLevel, bool hasWater) {
        World& w = *ctx.world;
        for (auto& f : fires) {
            if (!f.alive) continue;
            uint8_t p = w.get(f.x, f.y, f.z);
            if (p == 0) { f.alive = false; continue; }   // already destroyed by something else
            vec3 center((f.x + 0.5f) * VOXEL_SIZE, (f.y + 0.5f) * VOXEL_SIZE, (f.z + 0.5f) * VOXEL_SIZE);
            if (hasWater && center.y < waterLevel) { f.alive = false; continue; }
            f.life += dt;
            if (ctx.particles) {
                if (rng.uf() < dt * 14.f)
                    ctx.particles->fire(center, vec3(rng.sf(), 1.2f, rng.sf()) * 0.4f, 0.13f + rng.uf() * 0.08f, 0.4f);
                if (rng.uf() < dt * 5.f)
                    ctx.particles->smoke(center, vec3(0, 1.f, 0), 0.3f, 1.6f, 0.14f);
            }
            if (ctx.addLight) ctx.addLight(center, vec3(1.f, 0.55f, 0.2f) * 5.f, 3.2f, 0.06f);
            f.nextSpread -= dt;
            if (f.nextSpread <= 0.f) {
                f.nextSpread = FIRE_SPREAD_INTERVAL * (0.6f + rng.uf() * 0.8f);
                static const int NB[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
                int start = (int)(rng.uf() * 6.f);
                for (int k = 0; k < 6; k++) {
                    const int* d = NB[(start + k) % 6];
                    if (ignite(w, f.x + d[0], f.y + d[1], f.z + d[2])) break;
                }
            }
            if (f.life > FIRE_BURN_TIME) {
                f.alive = false;
                DestructionOp op;
                op.x = center.x; op.y = center.y; op.z = center.z;
                op.radius = 0.55f;
                op.matMask = 1u << M_MED;
                op.px = 0; op.py = 1; op.pz = 0;
                op.big = 0;
                if (ctx.emitOp) ctx.emitOp(op);
            }
        }
        fires.erase(std::remove_if(fires.begin(), fires.end(), [](const FireVoxel& f) { return !f.alive; }), fires.end());
    }

    // Fire Extinguisher: kills every fire within a forward cone (mirrors fireExtinguisher's
    // particle-killing cone in weapons.h so both effects feel consistent).
    void extinguishCone(vec3 eye, vec3 dir, float range, float cosHalfAngle) {
        for (auto& f : fires) {
            if (!f.alive) continue;
            vec3 c((f.x + 0.5f) * VOXEL_SIZE, (f.y + 0.5f) * VOXEL_SIZE, (f.z + 0.5f) * VOXEL_SIZE);
            vec3 to = c - eye;
            float d = vlen(to);
            if (d > range || d < 0.01f) continue;
            if (vdot(to / d, dir) < cosHalfAngle) continue;
            f.alive = false;
        }
        fires.erase(std::remove_if(fires.begin(), fires.end(), [](const FireVoxel& f) { return !f.alive; }), fires.end());
    }
};

// A physical, grabbable piece of debris. Not re-merged into the voxel grid when dropped —
// it stays a small standalone prop, same as loose debris in the real game.
struct LooseVoxel {
    vec3 pos, vel;
    uint8_t pal = 0;
    float sinceSettled = 0;
    bool resting = false;
    bool held = false;
    bool alive = true;
    bool thrown = false;    // hurled by the player: fires the hard-impact hook on collision
    bool floating = false;  // riding the surface rather than falling
    float bobPhase = 0;     // so a raft of debris does not bob in unison
};

/**
 * Relative density against water. Below 1 floats, above 1 sinks.
 *
 * These are roughly the real numbers, because the real numbers are already the interesting
 * ones: pine is about 0.5 and rides high with half its bulk clear, most plastics sit a
 * whisker under 1 and float almost awash, and everything structural is two to eight times
 * water and goes straight down. Getting this from the material rather than picking which
 * props bob means a blown-up boathouse scatters timber across the harbour while its fixings
 * sink, without anything having been authored to do that.
 */
static inline float materialDensity(uint8_t mat) {
    switch (mat) {
        case M_LIGHT:  return 2.5f;    // glass
        case M_MED:    return 0.55f;   // timber, crates, planking — floats high
        case M_HEAVY:  return 2.4f;    // masonry, concrete
        case M_BEDROCK:return 8.0f;
        default:       return 1.6f;
    }
}

struct LooseVoxelSystem {
    std::vector<LooseVoxel> props;
    // seconds after settling before despawn; <= 0 disables despawn entirely (Options toggle)
    float despawnTime = 30.f;

    bool spawn(vec3 pos, uint8_t pal, vec3 vel) {
        if ((int)props.size() >= MAX_LOOSE_VOXELS) {
            int oldest = -1;
            float oldestT = -1.f;
            for (int i = 0; i < (int)props.size(); i++)
                if (props[i].resting && !props[i].held && props[i].sinceSettled > oldestT) {
                    oldestT = props[i].sinceSettled;
                    oldest = i;
                }
            if (oldest < 0) return false;   // everything is mid-air or held; drop the new piece
            props.erase(props.begin() + oldest);
        }
        LooseVoxel lv;
        lv.pos = pos; lv.pal = pal; lv.vel = vel;
        props.push_back(lv);
        return true;
    }

    // onHardImpact(pos, vel): a THROWN prop slammed into something at speed -- the game layer
    // uses it to break glass at the impact point (via the normal networked op path)
    /**
     * @param surfaceAt  height of the water surface at (x,z), or nullptr for a dry map. Taken
     *                   as a callback so props ride the *simulated* surface — a plank sitting
     *                   in the harbour lifts when a blast wave reaches it rather than resting
     *                   at a fixed sea level.
     */
    void update(float dt, const World& w,
                const std::function<void(vec3, vec3)>& onHardImpact = nullptr,
                const std::function<float(float, float)>& surfaceAt = nullptr) {
        for (auto& lv : props) {
            if (!lv.alive || lv.held) continue;
            bool submerged = false;

            // ---- buoyancy
            if (surfaceAt) {
                float surf = surfaceAt(lv.pos.x, lv.pos.z);
                float sub = surf - lv.pos.y;                 // how deep it is under the surface
                if (sub > -0.05f) {
                    float density = materialDensity(w.palette[lv.pal].mat);
                    lv.bobPhase += dt * 1.7f;
                    if (density < 1.0f) {
                        // Archimedes, roughly: the displaced volume grows with submersion, so
                        // the restoring force does too and the piece settles at the draught
                        // its density implies rather than popping out of the water.
                        float draught = 0.16f * density;      // waterline offset for this bulk
                        float err = sub - draught;
                        lv.vel.y += err * 34.f * dt;          // spring toward the waterline
                        lv.vel.y *= powf(0.02f, dt);          // heavy vertical damping
                        lv.vel.x *= powf(0.35f, dt);          // and drag sideways
                        lv.vel.z *= powf(0.35f, dt);
                        // Ride the surface, plus a little bob so a field of flotsam is alive.
                        lv.pos.y += sinf(lv.bobPhase) * 0.012f;
                        lv.pos = lv.pos + lv.vel * dt;
                        lv.floating = true;
                        lv.resting = false;
                        lv.thrown = false;
                        lv.sinceSettled += dt;
                        if (despawnTime > 0.f && lv.sinceSettled > despawnTime * 2.f) lv.alive = false;
                        continue;
                    }
                    // Denser than water: sinks, but slowly, and water kills its momentum.
                    // Gravity is *not* applied here — the fall path below still runs and
                    // would apply it a second time. Only the drag and terminal speed that
                    // being submerged adds belong in this branch.
                    lv.floating = false;
                    lv.vel.x *= powf(0.06f, dt);
                    lv.vel.z *= powf(0.06f, dt);
                    submerged = true;
                }
            }

            if (!lv.resting) {
                vec3 np = lv.pos + lv.vel * dt;
                // Buoyancy cancels part of the weight, and water caps how fast it can sink.
                lv.vel.y -= 18.f * dt * (submerged ? 0.35f : 1.f);
                if (submerged) lv.vel.y = std::max(lv.vel.y, -2.2f);
                int vx = (int)floorf(np.x / VOXEL_SIZE), vy = (int)floorf(np.y / VOXEL_SIZE), vz = (int)floorf(np.z / VOXEL_SIZE);
                if (w.solidClamped(vx, vy, vz)) {
                    if (lv.thrown && vlen(lv.vel) > 7.f && onHardImpact) {
                        onHardImpact(lv.pos, lv.vel);
                        lv.thrown = false;
                    }
                    lv.vel = lv.vel * 0.2f;
                    if (vlen(lv.vel) < 0.6f) { lv.resting = true; lv.thrown = false; lv.vel = vec3(0, 0, 0); }
                } else lv.pos = np;
            } else {
                lv.sinceSettled += dt;
                if (despawnTime > 0.f && lv.sinceSettled > despawnTime) lv.alive = false;
            }
        }
        props.erase(std::remove_if(props.begin(), props.end(), [](const LooseVoxel& lv) { return !lv.alive; }), props.end());
    }

    // nearest grabbable prop within a narrow aim cone, or -1
    int findGrabbable(vec3 eye, vec3 dir, float range) const {
        int best = -1;
        float bestD = range;
        for (int i = 0; i < (int)props.size(); i++) {
            const LooseVoxel& lv = props[i];
            if (!lv.alive || lv.held) continue;
            vec3 to = lv.pos - eye;
            float d = vlen(to);
            if (d > range || d < 0.02f) continue;
            if (vdot(to / d, dir) < 0.92f) continue;
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }
};
