// particles.h - CPU particle system (smoke, fire, sparks, debris, dust), multithreaded update
#pragma once
#include "vmath.h"
#include "world.h"
#include "render.h"
#include "threadpool.h"
#include <vector>

enum PartType : uint8_t { PT_SMOKE, PT_FIRE, PT_SPARK, PT_DEBRIS, PT_DUST, PT_FLASH, PT_TRAIL, PT_SPLASH };

struct Particle {
    vec3 pos, vel;
    float life = 0, maxLife = 1;
    float size = 0.1f, growth = 0;
    float r = 1, g = 1, b = 1;
    float rot = 0, rotVel = 0;
    uint8_t type = PT_SMOKE;
    bool alive = false;
    bool collide = false;
};

struct ParticleSystem {
    std::vector<Particle> pool;
    int cursor = 0;
    Rng rng{20260720};

    ParticleSystem() { pool.resize(10000); }

    Particle& spawn() {
        for (int tries = 0; tries < 16; tries++) {
            cursor = (cursor + 1) % (int)pool.size();
            if (!pool[cursor].alive) break;
        }
        Particle& p = pool[cursor];
        p = Particle();
        p.alive = true;
        return p;
    }

    void clearAll() { for (auto& p : pool) p.alive = false; }

    // ---- emitters
    void voxelDebris(vec3 pos, uint8_t pr, uint8_t pg, uint8_t pb, vec3 push, float speed) {
        Particle& p = spawn();
        p.type = PT_DEBRIS;
        p.pos = pos;
        p.vel = push * speed + vec3(rng.sf(), rng.uf() * 0.8f + 0.3f, rng.sf()) * speed * 0.6f;
        p.maxLife = 1.8f + rng.uf() * 1.6f;
        p.size = 0.10f + rng.uf() * 0.13f;
        p.r = pr / 255.f; p.g = pg / 255.f; p.b = pb / 255.f;
        p.rot = rng.uf() * 6.28f; p.rotVel = rng.sf() * 12.f;
        p.collide = true;
    }
    void smoke(vec3 pos, vec3 vel, float size, float life, float shade) {
        Particle& p = spawn();
        p.type = PT_SMOKE;
        p.pos = pos; p.vel = vel;
        p.maxLife = life;
        p.size = size; p.growth = size * 1.4f;
        p.r = p.g = p.b = shade;
        p.rot = rng.uf() * 6.28f; p.rotVel = rng.sf() * 0.8f;
    }
    void fire(vec3 pos, vec3 vel, float size, float life) {
        Particle& p = spawn();
        p.type = PT_FIRE;
        p.pos = pos; p.vel = vel;
        p.maxLife = life;
        p.size = size; p.growth = size * 0.6f;
        p.r = 1.0f; p.g = 0.55f; p.b = 0.15f;
        p.rot = rng.uf() * 6.28f;
    }
    void spark(vec3 pos, vec3 vel) {
        Particle& p = spawn();
        p.type = PT_SPARK;
        p.pos = pos; p.vel = vel;
        p.maxLife = 0.35f + rng.uf() * 0.45f;
        p.size = 0.05f + rng.uf() * 0.04f;
        p.r = 1.0f; p.g = 0.8f; p.b = 0.35f;
        p.collide = true;
    }
    void dust(vec3 pos, vec3 vel, float size, float life, float r, float g, float b) {
        Particle& p = spawn();
        p.type = PT_DUST;
        p.pos = pos; p.vel = vel;
        p.maxLife = life;
        p.size = size; p.growth = size * 0.8f;
        p.r = r; p.g = g; p.b = b;
        p.rot = rng.uf() * 6.28f; p.rotVel = rng.sf() * 1.2f;
    }
    void flash(vec3 pos, float size) {
        Particle& p = spawn();
        p.type = PT_FLASH;
        p.pos = pos;
        p.maxLife = 0.09f;
        p.size = size;
        p.r = 1.0f; p.g = 0.85f; p.b = 0.55f;
    }
    void trail(vec3 pos, vec3 vel) {
        Particle& p = spawn();
        p.type = PT_TRAIL;
        p.pos = pos; p.vel = vel;
        p.maxLife = 0.5f + rng.uf() * 0.4f;
        p.size = 0.12f; p.growth = 0.5f;
        p.r = 0.85f; p.g = 0.82f; p.b = 0.78f;
    }

    // water impact: a crown of droplets kicked up and out, plus a low mist of foam puffs
    // drifting along the surface. scale ~1 for a bullet/melee hit, larger for explosions.
    void splash(vec3 pos, float scale = 1.f) {
        Rng& R = rng;
        for (int i = 0; i < (int)(14 * scale); i++) {
            vec3 d = vnorm(vec3(R.sf(), R.uf() * 1.4f + 0.5f, R.sf()));
            Particle& p = spawn();
            p.type = PT_SPLASH;
            p.pos = pos;
            p.vel = d * (2.2f + R.uf() * 3.4f) * (0.6f + scale * 0.4f);
            p.maxLife = 0.4f + R.uf() * 0.4f;
            p.size = (0.045f + R.uf() * 0.05f) * (0.7f + scale * 0.3f);
            p.r = 0.62f; p.g = 0.76f; p.b = 0.92f;
        }
        for (int i = 0; i < (int)(7 * scale); i++) {
            vec3 d = vnorm(vec3(R.sf(), R.uf() * 0.25f, R.sf()));
            dust(pos + d * 0.15f * scale, d * (1.0f + R.uf() * 1.6f) * scale + vec3(0, 0.5f, 0),
                 (0.3f + R.uf() * 0.35f) * (0.6f + scale * 0.4f), 0.55f + R.uf() * 0.45f,
                 0.80f, 0.87f, 0.94f);
        }
    }

    // big boom visual
    void explosionBurst(vec3 pos, float radius) {
        Rng& R = rng;
        flash(pos, radius * 2.6f);
        for (int i = 0; i < 34; i++) {
            vec3 d = vnorm(vec3(R.sf(), R.sf() * 0.8f + 0.25f, R.sf()));
            fire(pos + d * (radius * 0.2f), d * (5.5f + R.uf() * 7.f), 0.5f + R.uf() * 0.8f, 0.35f + R.uf() * 0.4f);
        }
        for (int i = 0; i < 26; i++) {
            vec3 d = vnorm(vec3(R.sf(), R.sf() * 0.9f + 0.35f, R.sf()));
            smoke(pos + d * (radius * 0.3f), d * (2.5f + R.uf() * 3.5f) + vec3(0, 1.4f, 0),
                  0.7f + R.uf() * 1.0f, 1.6f + R.uf() * 1.8f, 0.16f + R.uf() * 0.12f);
        }
        for (int i = 0; i < 40; i++) {
            vec3 d = vnorm(vec3(R.sf(), R.uf() * 0.9f + 0.1f, R.sf()));
            spark(pos + d * 0.2f, d * (9.f + R.uf() * 14.f));
        }
    }

    void update(float dt, const World& world) {
        int n = (int)pool.size();
        const int STRIDE = 512;
        int jobs = (n + STRIDE - 1) / STRIDE;
        parallelFor(jobs, [&](int j) {
            int i0 = j * STRIDE, i1 = std::min(n, i0 + STRIDE);
            for (int i = i0; i < i1; i++) {
                Particle& p = pool[i];
                if (!p.alive) continue;
                p.life += dt;
                if (p.life >= p.maxLife) { p.alive = false; continue; }
                switch (p.type) {
                    case PT_SMOKE: case PT_DUST:
                        p.vel *= (1.f - 1.6f * dt);
                        p.vel.y += 0.9f * dt;
                        break;
                    case PT_FIRE:
                        p.vel *= (1.f - 2.4f * dt);
                        p.vel.y += 2.6f * dt;
                        break;
                    case PT_SPARK:
                        p.vel.y -= 16.f * dt;
                        break;
                    case PT_DEBRIS:
                        p.vel.y -= 22.f * dt;
                        p.vel.x *= (1.f - 0.12f * dt);
                        p.vel.z *= (1.f - 0.12f * dt);
                        break;
                    case PT_TRAIL:
                        p.vel *= (1.f - 2.2f * dt);
                        p.vel.y += 0.6f * dt;
                        break;
                    case PT_FLASH:
                        break;
                    case PT_SPLASH:
                        p.vel.y -= 13.f * dt;
                        p.vel.x *= (1.f - 0.6f * dt);
                        p.vel.z *= (1.f - 0.6f * dt);
                        break;
                }
                vec3 np = p.pos + p.vel * dt;
                if (p.collide) {
                    int vx = (int)floorf(np.x / VOXEL_SIZE);
                    int vy = (int)floorf(np.y / VOXEL_SIZE);
                    int vz = (int)floorf(np.z / VOXEL_SIZE);
                    if (world.solidClamped(vx, vy, vz)) {
                        // bounce: axis-wise reflect on strongest velocity component
                        if (p.type == PT_SPARK) { p.alive = (p.life < p.maxLife * 0.5f); p.vel *= -0.3f; }
                        else {
                            // debris: settle
                            float sp = vlen(p.vel);
                            if (sp < 1.0f) { p.vel = vec3(0, 0, 0); }
                            else {
                                int hy = (int)floorf(p.pos.y / VOXEL_SIZE);
                                if (world.solidClamped(vx, hy, vz)) { p.vel.x *= -0.35f; p.vel.z *= -0.35f; }
                                else p.vel.y = -p.vel.y * 0.35f;
                                p.vel *= 0.7f;
                                p.rotVel *= 0.6f;
                            }
                        }
                        np = p.pos;
                    }
                }
                p.pos = np;
                p.rot += p.rotVel * dt;
            }
        });
    }

    void buildInstances(std::vector<PartInst>& alphaOut, std::vector<PartInst>& addOut) {
        for (auto& p : pool) {
            if (!p.alive) continue;
            float t = p.life / p.maxLife;
            PartInst in;
            in.x = p.pos.x; in.y = p.pos.y; in.z = p.pos.z;
            in.size = p.size + p.growth * t;
            in.rot = p.rot;
            in.u0 = in.u1 = 0;
            switch (p.type) {
                case PT_SMOKE: case PT_DUST:
                    in.r = p.r; in.g = p.g; in.b = p.b;
                    in.a = (1.f - t) * 0.55f;
                    in.shape = 0;
                    alphaOut.push_back(in);
                    break;
                case PT_DEBRIS:
                    in.r = p.r; in.g = p.g; in.b = p.b;
                    in.a = t > 0.8f ? (1.f - t) * 5.f : 1.f;
                    in.shape = 1;
                    alphaOut.push_back(in);
                    break;
                case PT_FIRE: {
                    float fade = 1.f - t;
                    in.r = p.r * (2.2f + 1.5f * fade); in.g = p.g * (1.6f * fade + 0.5f); in.b = p.b * fade;
                    in.a = fade * 0.85f;
                    in.shape = 0;
                    addOut.push_back(in);
                    break;
                }
                case PT_SPARK:
                    in.r = 2.5f; in.g = 1.7f; in.b = 0.6f;
                    in.a = (1.f - t);
                    in.shape = 0;
                    addOut.push_back(in);
                    break;
                case PT_FLASH:
                    in.r = 4.f; in.g = 3.2f; in.b = 2.f;
                    in.a = (1.f - t) * 0.9f;
                    in.shape = 0;
                    addOut.push_back(in);
                    break;
                case PT_TRAIL:
                    in.r = p.r; in.g = p.g; in.b = p.b;
                    in.a = (1.f - t) * 0.4f;
                    in.shape = 0;
                    alphaOut.push_back(in);
                    break;
                case PT_SPLASH:
                    in.r = p.r; in.g = p.g; in.b = p.b;
                    in.a = (1.f - t) * 0.85f;
                    in.shape = 0;
                    alphaOut.push_back(in);
                    break;
            }
        }
    }
};
