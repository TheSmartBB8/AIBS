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
//
// There is a second field on the same grid, and it is here rather than in the shader for one
// reason: foam has memory. Steepness and shoaling depth are both functions of what the surface
// is doing *now*, so anything derived from them can only ever mark where a wave is breaking at
// this instant — which is why the renderer's synthesised foam can draw a white line along a
// wave front but can never draw a wake. A wake is a trail: the boat left it seconds ago and has
// since gone somewhere else. Carrying coverage as its own field, deposited by whatever is
// ploughing through the water and decaying on its own clock, is the whole difference.
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
    std::vector<float> foam;           // surface coverage, 0..1, decaying on its own clock
    // Scratch for the spread pass, kept as a member rather than allocated inside update()
    // because that runs up to eight times a frame and a 65k-element allocation per step is
    // real money for a buffer whose size never changes after build().
    std::vector<float> foamTmp;

    bool ready = false;
    float accum = 0;

    void clear() {
        h.clear(); vel.clear(); depth.clear(); solid.clear();
        foam.clear(); foamTmp.clear();
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
        foam.assign((size_t)nx * nz, 0.f);
        foamTmp.assign((size_t)nx * nz, 0.f);
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

    /**
     * Lay foam down over a disc — a hull ploughing through, a body going in, spray landing.
     *
     * Saturating rather than accumulating, because the value is a coverage fraction: 1 means
     * the cell is entirely white water and there is no such thing as more than that. The
     * version that just added would look identical the moment it was on screen and then behave
     * wrongly, since decay is proportional to the value — a spot driven over ten times would
     * sit at 10 and take ten time constants to fall back through 1, so the trail's lifetime
     * would depend on how many times the boat had crossed its own wake rather than on when it
     * last passed.
     *
     * Same cosine bell as impulse(), for a different but related reason. There it keeps the
     * grid's own frequency out of the wave solve; here a hard-edged disc would leave a trail
     * with a stencilled rim, and the spread below is far too gentle to soften it within the few
     * seconds the foam lives.
     */
    void addFoam(float wx, float wz, float radius, float amount) {
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
                float w = 0.5f + 0.5f * cosf(d * 3.14159265f);
                foam[i] = std::min(1.f, foam[i] + amount * w);
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
        // Every cell, not every third one — and the reason is worth stating, because the
        // version that stepped by 3 looked like a free nine-fold saving and was in fact the
        // single worst thing in the water.
        //
        // The argument for the stride is that the forcing function is smooth and the wave
        // equation spreads whatever it is handed, so the cells in between get driven by their
        // neighbours a step later. That argument fails on a discrete grid. Forcing a lattice of
        // isolated cells injects energy overwhelmingly into the shortest wavelength the grid can
        // represent, and on a discretised wave equation the highest-frequency mode has zero
        // group velocity: it oscillates in place and transports nothing. So the energy could not
        // leave, no matter how long the solve ran. Measured on a flat 64 m basin after 15 s, the
        // old field had an autocorrelation of exactly zero between adjacent cells while lags of
        // 3, 6 and 9 sat at 0.997, 0.986 and 0.966, and its adjacent-difference rms was sqrt(2)
        // times its field rms — the theoretical maximum, i.e. every last bit of energy parked at
        // the Nyquist limit. Actual swell amplitude was 0.0001 m. What the harbour showed was
        // therefore not waves at all but a standing 0.75 m lattice, which is exactly the
        // "blocky" texture, and it was in the geometry rather than in the shading, which is why
        // no amount of work on the surface shader shifted it.
        //
        // Driving every cell puts the energy where the sinusoid says it should go, at wavelengths
        // of 30 m and up, which propagate and reflect as waves are supposed to. Same measurement
        // now: monotonic decorrelation with no trace of a period-3 spike, Nyquist ratio 0.02
        // instead of 1.41, and 2.7 cm of rms swell. The amplitude constant drops by roughly the
        // nine-fold increase in the number of cells being driven.
        {
            const float amp = 0.0014f;
            for (int z = 1; z < nz - 1; z++)
                for (int x = 1; x < nx - 1; x++) {
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

        // Foam constants. Written as rates per second and converted to the step here, rather
        // than as the per-step numbers they end up as, so that H is the only place that has to
        // change if the step ever does — and so that the time constant can be read off the
        // line as a time.
        //
        // 5.5 s is the number the wake reads off, and it is a compromise between two failures
        // either side of it. Under about 2 s the trail dies within a hull length of the stern
        // and reads as spray rather than as a wake, which is the whole thing this field exists
        // to draw. Over about 10 s the basin slowly turns white across a session, because
        // deposition is continuous for as long as anything is moving and decay is the only
        // thing that ever takes coverage away. Measured on a flat basin: a wake halves in 3.4 s
        // and is down to a tenth in 13 s, and the centre of a deposit tracks exp(-t/5.5) to
        // within 1.7% over the first ten seconds — the residual being the spread below, which
        // takes a little off the middle of anything that is not already flat.
        const float FOAM_TAU = 5.5f;               // seconds to fall to 1/e
        const float FOAM_DECAY = expf(-H / FOAM_TAU);

        // The spread is set by what it does over a wake's lifetime rather than by what it does
        // in a step. At this rate the equivalent diffusion is 0.011 m^2/s, so in the ten-odd
        // seconds a trail stays visible its edge blurs over about half a metre — two cells,
        // enough to turn a stamped-out stripe into something with a soft edge that keeps
        // widening as it fades. It cannot be turned up much further without changing what the
        // decay measures: spreading also takes the top off a narrow deposit, so a wake's peak
        // would start dying visibly faster than the time constant above says it should, which
        // is a confusing thing to leave for whoever tunes this next.
        const float FOAM_SPREAD = 0.006f;          // of the way to the 4-neighbour mean, per step
        const float FOAM_SLOPE0 = 0.06f;           // surface slope at which a wave face starts to break
        const float FOAM_BREAK = 12.0f;            // coverage per second per unit slope past that
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

            // Foam, on the same fixed step as the wave solve.
            //
            // In the loop rather than once per frame because every part of it is rate-based:
            // decayed once per frame the wake would evaporate faster on a fast machine, and
            // spread once per frame it would blur further per second the higher the framerate
            // — the class of bug that only ever shows up as "it looked right on my machine".
            //
            // Written into a second buffer and swapped, which is the part that is easy to get
            // wrong. Diffusing in place turns a symmetric exchange into a sweep: a cell reads
            // the new value from the neighbour behind it and the old value from the one ahead,
            // so the pair no longer trade equal and opposite amounts, and the field creeps up
            // the sweep direction while quietly gaining or losing total coverage. Out of place
            // the exchange across every edge is exactly antisymmetric, so spreading moves foam
            // around and cannot manufacture any — which matters because the only thing keeping
            // a wake bounded is that nothing but addFoam and the breaker term below adds to it.
            //
            // Land is excluded from the exchange the same way it is excluded from the wave
            // solve, by treating a solid neighbour as a copy of the cell in hand. Its real
            // value is zero, so letting it into the mean would pull the whole shoreline down
            // and eat a wake that ran alongside a quay; and foam is a thing on the water, so
            // it must not climb onto the stone either.
            for (int z = 0; z < nz; z++)
                for (int x = 0; x < nx; x++) {
                    size_t i = (size_t)idx(x, z);
                    if (solid[i]) { foamTmp[i] = 0.f; continue; }
                    bool okl = x > 0,      okr = x < nx - 1;
                    bool okd = z > 0,      oku = z < nz - 1;
                    float fc = foam[i];
                    float fl = (okl && !solid[i - 1])  ? foam[i - 1]  : fc;
                    float fr = (okr && !solid[i + 1])  ? foam[i + 1]  : fc;
                    float fd = (okd && !solid[i - nx]) ? foam[i - nx] : fc;
                    float fu = (oku && !solid[i + nx]) ? foam[i + nx] : fc;
                    float f = (fc + ((fl + fr + fd + fu) * 0.25f - fc) * FOAM_SPREAD) * FOAM_DECAY;

                    // Water makes its own foam where it is breaking, and the surface already
                    // knows where that is: a wave steep enough to break is a wave with a large
                    // gradient across its face. Keying on the slope rather than on the height
                    // is what lets a long slow swell stay green while a short blast ring
                    // whitens along its front, and no threshold on amplitude can express that
                    // distinction, because the two waves are the same height.
                    //
                    // The threshold is placed by measurement rather than by taste. On a flat
                    // basin the swell alone tops out at a slope of 0.011, a player hitting the
                    // water reaches 0.076, and the largest blast the game can ask for reaches
                    // 0.26. At 0.06 the swell can never reach it — which matters, since a
                    // source that fires on the ambient surface would whiten the entire harbour
                    // given a minute — while the events that ought to break do.
                    //
                    // Deliberately weak past it: that blast leaves about 0.07 coverage along
                    // its front, against the 0.3-odd a hull deposits in a single pass. The
                    // dominant source is meant to be things moving through, because that is
                    // what the eye is being asked to read. Turned up far enough to stand on
                    // its own it undoes the point of the field — foam would appear wherever
                    // the water is lively rather than wherever something has been, which is
                    // the shader's existing steepness term over again, only laggier.
                    float hc = h[i];
                    float hl = (okl && !solid[i - 1])  ? h[i - 1]  : hc;
                    float hr = (okr && !solid[i + 1])  ? h[i + 1]  : hc;
                    float hd = (okd && !solid[i - nx]) ? h[i - nx] : hc;
                    float hu = (oku && !solid[i + nx]) ? h[i + nx] : hc;
                    float gx = (hr - hl) * (0.5f / CELL), gz = (hu - hd) * (0.5f / CELL);
                    float slope = sqrtf(gx * gx + gz * gz);
                    if (slope > FOAM_SLOPE0) f += (slope - FOAM_SLOPE0) * FOAM_BREAK * H;

                    foamTmp[i] = std::min(1.f, f);
                }
            foam.swap(foamTmp);
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
                // A Sobel derivative rather than a two-tap central difference.
                //
                // The plain central difference is the sharper and more obvious estimator, and
                // it is the wrong one here because of what happens downstream: the renderer
                // uploads these gradients as a texture and reads them back bilinearly. Bilinear
                // interpolation is continuous in value but not in slope, so a per-cell gradient
                // interpolated that way produces a surface whose normal creases along every
                // cell boundary — a 0.25 m grid of facets, which the eye reads as the water
                // being made of tiles. Weighting the two neighbouring rows into the estimate
                // costs four more taps and makes the gradient field itself smooth enough that
                // the interpolation has nothing sharp left to step across.
                const float* H = h.data();
                float gx = ((H[idx(xp, zm)] + 2.f * H[idx(xp, z)] + H[idx(xp, zp)])
                          - (H[idx(xm, zm)] + 2.f * H[idx(xm, z)] + H[idx(xm, zp)])) * 0.125f;
                float gz = ((H[idx(xm, zp)] + 2.f * H[idx(x, zp)] + H[idx(xp, zp)])
                          - (H[idx(xm, zm)] + 2.f * H[idx(x, zm)] + H[idx(xp, zm)])) * 0.125f;
                out[i * 4 + 0] = h[i];
                out[i * 4 + 1] = gx;
                out[i * 4 + 2] = gz;
                out[i * 4 + 3] = solid[i] ? 0.f : depth[i];
            }
    }

    /**
     * Pack the foam coverage on its own, one float per cell, in pack()'s layout.
     *
     * Its own buffer and its own single-channel texture, rather than a fifth channel on the
     * field pack() already builds, because there is no five-channel format to widen it into.
     * Carrying foam there would mean a second RGBA alongside the first — four times the upload
     * and four times the sample cost for the one number being added. Freeing a channel by
     * dropping a gradient is worse again: the shader would have to recover it with three extra
     * taps per pixel, which is the exact cost pack() computes the gradients here to avoid.
     *
     * The field is already row-major in the order asked for, so this is a copy. It is a
     * function rather than the renderer reaching into `foam` directly so that the layout stays
     * a decision this file makes, as it is for pack().
     */
    void packFoam(std::vector<float>& out) const {
        out.assign(foam.begin(), foam.end());
    }
};
