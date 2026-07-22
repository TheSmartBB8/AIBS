// player.h - first-person controller: WASD, jump, sprint, AABB voxel collision with auto-step
#pragma once
#include "vmath.h"
#include "world.h"

struct Player {
    vec3 pos;                 // center of AABB
    vec3 vel;
    float yaw = 0, pitch = 0;
    bool onGround = false;
    bool flying = false;
    bool inWater = false;
    float halfW = 0.32f, halfH = 0.88f;
    float eyeOffset = 0.72f;
    float bobPhase = 0, bobAmp = 0;

    vec3 eye() const { return {pos.x, pos.y + eyeOffset, pos.z}; }
    vec3 forward() const {
        return {sinf(yaw) * cosf(pitch), sinf(pitch), cosf(yaw) * cosf(pitch)};
    }
    vec3 forwardFlat() const { return {sinf(yaw), 0, cosf(yaw)}; }
    // must equal cross(forwardFlat(), worldUp) to match the camera's actual right vector
    // (render.h's camRight) -- getting this backwards silently mirrors strafe input.
    vec3 rightFlat() const { return {-cosf(yaw), 0, sinf(yaw)}; }

    // dx/dy: raw mouse delta in screen pixels (dx > 0 = mouse moved right, dy > 0 = moved
    // down -- platform.h's convention). yaw must DEcrease as dx increases: forward(yaw)
    // rotates away from cross(forward, up) as yaw increases, so +yaw turns the camera left.
    void applyMouseLook(float dx, float dy, float sens) {
        yaw -= dx * sens;
        pitch -= dy * sens;
        pitch = clampf(pitch, -1.5f, 1.5f);
    }

    bool boxSolid(const World& w, vec3 c, float hw, float hh) const {
        int x0 = (int)floorf((c.x - hw) / VOXEL_SIZE), x1 = (int)floorf((c.x + hw) / VOXEL_SIZE);
        int y0 = (int)floorf((c.y - hh) / VOXEL_SIZE), y1 = (int)floorf((c.y + hh) / VOXEL_SIZE);
        int z0 = (int)floorf((c.z - hw) / VOXEL_SIZE), z1 = (int)floorf((c.z + hw) / VOXEL_SIZE);
        for (int y = y0; y <= y1; y++)
            for (int z = z0; z <= z1; z++)
                for (int x = x0; x <= x1; x++)
                    if (w.solidClamped(x, y, z)) return true;
        return false;
    }

    void update(const World& w, float dt, float mx, float mz, bool jump, bool sprint, bool crouch, float waterLevel, bool hasWater) {
        // move intent in world space
        vec3 wish = forwardFlat() * mz + rightFlat() * mx;
        float wl = vlen(wish);
        if (wl > 1.f) wish = wish / wl;
        float speed = sprint ? 8.6f : 5.4f;
        if (crouch) speed *= 0.5f;

        inWater = hasWater && (pos.y - halfH) < waterLevel - 0.15f;

        if (flying) {
            vec3 want = wish * speed * 2.2f;
            want.y = (jump ? 8.f : 0.f) + (crouch ? -8.f : 0.f);
            vel = vlerp(vel, want, clampf(10.f * dt, 0, 1));
        } else {
            float accel = onGround ? 11.f : 2.6f;
            if (inWater) { speed *= 0.55f; accel = 4.f; }
            vel.x = lerpf(vel.x, wish.x * speed, clampf(accel * dt, 0, 1));
            vel.z = lerpf(vel.z, wish.z * speed, clampf(accel * dt, 0, 1));
            vel.y -= (inWater ? 8.f : 22.f) * dt;
            if (inWater) {
                vel.y = std::max(vel.y, -2.2f);
                if (jump) vel.y = 3.6f;
            } else if (jump && onGround) {
                vel.y = 7.6f;
                onGround = false;
            }
        }

        // integrate with axis-separated collision
        vec3 d = vel * dt;
        // X
        {
            vec3 np = pos; np.x += d.x;
            if (!boxSolid(w, np, halfW, halfH)) pos = np;
            else {
                // try step-up (2 voxels max)
                bool stepped = false;
                if (onGround || inWater) {
                    for (float lift : {0.22f, 0.42f}) {
                        vec3 sp = np; sp.y += lift;
                        if (!boxSolid(w, sp, halfW, halfH)) { pos = sp; stepped = true; break; }
                    }
                }
                if (!stepped) vel.x = 0;
            }
        }
        // Z
        {
            vec3 np = pos; np.z += d.z;
            if (!boxSolid(w, np, halfW, halfH)) pos = np;
            else {
                bool stepped = false;
                if (onGround || inWater) {
                    for (float lift : {0.22f, 0.42f}) {
                        vec3 sp = np; sp.y += lift;
                        if (!boxSolid(w, sp, halfW, halfH)) { pos = sp; stepped = true; break; }
                    }
                }
                if (!stepped) vel.z = 0;
            }
        }
        // Y
        {
            vec3 np = pos; np.y += d.y;
            if (!boxSolid(w, np, halfW, halfH)) {
                pos = np;
                onGround = false;
            } else {
                if (d.y < 0) onGround = true;
                vel.y = 0;
            }
        }
        // keep inside map horizontally
        float mxb = WX * VOXEL_SIZE - 0.5f, mzb = WZ * VOXEL_SIZE - 0.5f;
        pos.x = clampf(pos.x, 0.5f, mxb);
        pos.z = clampf(pos.z, 0.5f, mzb);
        if (pos.y < -30.f) pos.y = 40.f;      // fell out somehow: drop back in

        // view bob
        float hs = sqrtf(vel.x * vel.x + vel.z * vel.z);
        if (onGround && hs > 0.5f) {
            bobPhase += dt * hs * 1.35f;
            bobAmp = lerpf(bobAmp, 1.f, clampf(8.f * dt, 0, 1));
        } else bobAmp = lerpf(bobAmp, 0.f, clampf(8.f * dt, 0, 1));
    }
};
