// water.h — a shallow-water height field for the harbour surface.
//
// What this is, and what it is not.
//
// It is not a volumetric fluid. Nothing in real-time graphics simulates a harbour as a 3D
// fluid, Unreal included: UE5's Water Body system is a Gerstner height field with a dynamic
// ripple buffer painted into it, and its realism comes from the Single Layer Water shading
// model sitting on top — depth absorption, refraction, foam — rather than from simulating
// volume. Chasing an SPH or FLIP solver over a 64 m harbour would cost the entire frame
// budget and look worse, because the thing the eye actually reads is the surface.
//
// So this is a height field integrated with the 2D wave equation:
//
//     d2h/dt2 = c^2 * laplacian(h)
//
// which is the linearisation of shallow-water flow and is exactly right for the regime that
// matters here: surface waves whose amplitude is small next to their wavelength. What it
// buys over the sum-of-sines the surface used before is that it is a *simulation* — waves
// propagate at a finite speed, reflect off quay walls, refract around a pier, interfere with
// each other, and above all respond to the world. An explosion in the harbour throws a ring
// that runs out and bounces back off the far wall. A collapsing warehouse drops into it and
// the wave arrives at the boats a second later. None of that is expressible as a sum of
// sines, and all of it is what makes water read as a thing rather than as a material.
//
// Boundaries come from the voxel world: any cell whose column is solid at the water line is
// land, and is held at rest. That is what makes the reflections real rather than a box.
#pragma once
#include <vector>
#include <cmath>
#include <algorithm>
#include "vmath.h"

struct WaterSim {
    // 0.25 m cells — a quarter of a metre, so a blast ring is a smooth curve and a wave
    // reflecting off a pier leg diffracts around it rather than stepping. Over the 64 m map
    // that is 256x256, about 65k cells, and at 120 Hz roughly 8 million cell-updates a
    // second. Chosen for how it looks rather than for what it costs.
    static constexpr float CELL = 0.25f;

    int nx = 0, nz = 0;
    float originX = 0, originZ = 0;    // world metres of cell (0,0)
    float level = 0;                   // rest height, metres

    std::vector<float> h, vel;         // displacement from rest, and its rate
    std::vector<float> depth;          // still-water depth to the sea bed, metres
    std::vector<uint8_t> solid;        // 1 = land, held at rest

    bool ready = false;
    float accum = 0;

    void clear() {
        h.clear(); vel.clear(); depth.clear(); solid.clear();
        nx = nz = 0; ready = false; accum = 0;
    }

    inline int idx(int x, int z) const { return z * nx + x; }
    inline bool inside(int x, int z) const { return x >= 0 && z >= 0 && x < nx && z < nz; }

    /**
     * Size the grid to the world and sample the sea bed out of the voxel column.
     *
     * `isSolidAt` answers "is there world geometry at this metre position", which is how the
     * quay walls, piers and the sea bed all become boundary conditions without this file
     * needing to know anything about voxels.
     */
    template <class SolidFn>
    void build(float worldSizeX, float worldSizeZ, float waterLevel, SolidFn isSolidAt) {
        level = waterLevel;
        nx = std::max(2, (int)(worldSizeX / CELL));
        nz = std::max(2, (int)(worldSizeZ / CELL));
        originX = 0; originZ = 0;
        h.assign((size_t)nx * nz, 0.f);
        vel.assign((size_t)nx * nz, 0.f);
        depth.assign((size_t)nx * nz, 0.f);
        solid.assign((size_t)nx * nz, 0);
        for (int z = 0; z < nz; z++)
            for (int x = 0; x < nx; x++) {
                float wx = originX + (x + 0.5f) * CELL, wz = originZ + (z + 0.5f) * CELL;
                size_t i = (size_t)idx(x, z);
                // A cell is land if it is solid just under the water line.
                solid[i] = isSolidAt(wx, level + 0.05f, wz) ? 1 : 0;
                // Probe downward for the bed. Depth drives both the colour and the foam, so
                // it wants to be a real measurement rather than a constant.
                float d = 0.f;
                for (float y = level; y > level - 12.f; y -= 0.4f) {
                    if (isSolidAt(wx, y, wz)) break;
                    d += 0.4f;
                }
                depth[i] = d;
            }
        ready = true;
    }

    /** Push the surface down over a disc — an explosion, or something heavy landing. */
    void impulse(float wx, float wz, float radius, float strength) {
        if (!ready) return;
        int cx = (int)((wx - originX) / CELL), cz = (int)((wz - originZ) / CELL);
        int r = std::max(1, (int)(radius / CELL));
        for (int z = cz - r; z <= cz + r; z++)
            for (int x = cx - r; x <= cx + r; x++) {
                if (!inside(x, z)) continue;
                size_t i = (size_t)idx(x, z);
                if (solid[i]) continue;
                float dx = (float)(x - cx), dz = (float)(z - cz);
                float d = sqrtf(dx * dx + dz * dz) / (float)r;
                if (d > 1.f) continue;
                // Cosine bell rather than a flat disc: a hard-edged impulse injects the
                // grid's own frequency and the ring comes out square.
                float w = 0.5f + 0.5f * cosf(d * 3.14159265f);
                vel[i] -= strength * w;
            }
    }

    /** Surface height at a world position, for buoyancy and for spawning fx on the surface. */
    float heightAt(float wx, float wz) const {
        if (!ready) return level;
        int x = (int)((wx - originX) / CELL), z = (int)((wz - originZ) / CELL);
        if (!inside(x, z)) return level;
        return level + h[(size_t)idx(x, z)];
    }

    /**
     * Fixed-step integration. Explicit, so the step has to respect the CFL condition:
     * c*dt/dx <= 1/sqrt(2) in 2D, or the solve goes unstable and the surface explodes into
     * a checkerboard within a second. C2 below is chosen against the 1/120 s step.
     */
    float swellT = 0;

    void update(float dt) {
        if (!ready) return;
        swellT += dt;
        // A standing swell, driven into the field rather than added in the shader.
        //
        // Real open water is never still, and a harbour with a glassy surface reads as a
        // sheet of plastic no matter how good the shading is. Driving it through the
        // simulation rather than painting it on means the swell reflects off the quay and
        // interferes with blast rings like any other wave, instead of sliding over them.
        {
            const float amp = 0.010f;
            for (int z = 1; z < nz - 1; z += 3)
                for (int x = 1; x < nx - 1; x += 3) {
                    size_t i = (size_t)idx(x, z);
                    if (solid[i]) continue;
                    float wx = x * CELL, wz = z * CELL;
                    float s = sinf(wx * 0.21f + swellT * 0.9f) * 0.6f
                            + sinf(wz * 0.17f - swellT * 0.7f) * 0.5f
                            + sinf((wx + wz) * 0.09f + swellT * 0.45f) * 0.9f;
                    vel[i] += s * amp * dt;
                }
        }
        const float H = 1.f / 120.f;
        accum += dt;
        int steps = (int)(accum / H);
        if (steps > 8) steps = 8;          // never chase a hitch
        accum -= steps * H;

        const float C2 = 0.32f;            // wave speed squared, in cells per step
        const float DAMP = 0.996f;         // slow decay, so a blast ring dies out eventually
        for (int s = 0; s < steps; s++) {
            for (int z = 1; z < nz - 1; z++) {
                for (int x = 1; x < nx - 1; x++) {
                    size_t i = (size_t)idx(x, z);
                    if (solid[i]) { h[i] = 0.f; vel[i] = 0.f; continue; }
                    // Neighbours: a land cell reflects, which is modelled by treating it as
                    // having the same height as the cell in hand — a zero-gradient wall. Use
                    // its real height and the wave would leak into the quay instead.
                    float hc = h[i];
                    float hl = solid[i - 1]      ? hc : h[i - 1];
                    float hr = solid[i + 1]      ? hc : h[i + 1];
                    float hd = solid[i - nx]     ? hc : h[i - nx];
                    float hu = solid[i + nx]     ? hc : h[i + nx];
                    float lap = (hl + hr + hd + hu) - 4.f * hc;
                    vel[i] = (vel[i] + lap * C2) * DAMP;
                }
            }
            for (size_t i = 0; i < h.size(); i++)
                if (!solid[i]) h[i] += vel[i];
        }
    }

    /**
     * Pack into an RGBA float texture for the renderer: height, the two surface gradients,
     * and still-water depth.
     *
     * Gradients are computed here rather than in the shader because the shader would have to
     * take three extra texture samples per pixel to get them, and they are the same value for
     * every pixel inside a cell anyway.
     */
    void pack(std::vector<float>& out) const {
        out.resize((size_t)nx * nz * 4);
        for (int z = 0; z < nz; z++)
            for (int x = 0; x < nx; x++) {
                size_t i = (size_t)idx(x, z);
                int xm = std::max(0, x - 1), xp = std::min(nx - 1, x + 1);
                int zm = std::max(0, z - 1), zp = std::min(nz - 1, z + 1);
                float gx = (h[(size_t)idx(xp, z)] - h[(size_t)idx(xm, z)]) * 0.5f;
                float gz = (h[(size_t)idx(x, zp)] - h[(size_t)idx(x, zm)]) * 0.5f;
                out[i * 4 + 0] = h[i];
                out[i * 4 + 1] = gx;
                out[i * 4 + 2] = gz;
                out[i * 4 + 3] = solid[i] ? 0.f : depth[i];
            }
    }
};
