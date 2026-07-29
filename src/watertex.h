// watertex.h — the two tiling maps planar-reflection water samples, synthesised, not shipped.
//
// The technique (ThinMatrix / teodorplop) wants a DuDv map to wobble the screen-space
// reflection and refraction lookups, and a normal map for the specular highlight and the
// per-pixel Fresnel term. Every implementation of it ships those as a pair of PNGs. This
// project ships no binary assets at all, so they are generated here instead.
//
// Two decisions carry the file.
//
// The first is that both maps are derived from a single height field. It would be marginally
// less code to write some plausible swirl into the DuDv channels and some separate plausible
// bumpiness into the normal channels, and each would survive inspection on its own — but they
// would then be describing two different surfaces. The highlight would sit where the
// distortion does not agree it should, which reads as the specular sliding across the water
// rather than belonging to it, and no shader parameter recovers from that: the two maps have
// to be talking about the same wave crests. Taking both from the gradient of one H costs
// nothing extra and makes them consistent by construction.
//
// The second is that every basis function here is strictly periodic over the SIZE x SIZE
// domain. The renderer samples these with GL_REPEAT at four to eight tiles across the harbour,
// so a mismatch of a few units at the wrap edge is not a subtle artifact — it is a hard grid
// of lines drawn across the entire water surface, several of them, scrolling with the UV
// animation. So the ingredients are chosen for their wrapping behaviour rather than for
// convenience: sine trains at *integer* numbers of cycles per texture width, and gradient
// noise whose lattice corners are looked up modulo the lattice period, so the far edge of the
// domain literally is the near edge rather than merely resembling it. Unbounded Perlin or
// simplex noise — the obvious thing to reach for — cannot tile at all, and mirroring or
// cross-fading the edges of a non-tiling field trades the seam for a visible band of
// low-contrast mush, which at eight tiles is just as obvious.
#pragma once
#include <vector>
#include <cstdint>
#include <cmath>

namespace watertex_detail {

// A unit gradient for one lattice corner, with the corner index wrapped into [0, period).
// That wrap is the entire mechanism behind the tiling: it makes corner (period, k) the same
// corner as (0, k), so the noise closes on itself exactly.
inline void latticeGradient(int ix, int iy, int period, uint32_t seed, float& gx, float& gy) {
    uint32_t x = (uint32_t)(((ix % period) + period) % period);
    uint32_t y = (uint32_t)(((iy % period) + period) % period);
    uint32_t h = x * 374761393u + y * 668265263u + seed * 2654435761u;
    h = (h ^ (h >> 13)) * 1274126177u;
    h ^= h >> 16;
    float a = (float)(h & 0xFFFFFFu) * (6.28318530718f / 16777216.f);
    gx = cosf(a); gy = sinf(a);
}

/** Perlin gradient noise that repeats every `period` units. Range is about [-0.7, 0.7]. */
inline float periodicNoise(float x, float y, int period, uint32_t seed) {
    int x0 = (int)floorf(x), y0 = (int)floorf(y);
    float fx = x - (float)x0, fy = y - (float)y0;
    // Quintic fade rather than the cheaper smoothstep. What leaves this file is a *gradient*
    // of the field, and a cubic fade leaves H's second derivative discontinuous along every
    // lattice line, which surfaces as a faint grid of creases in the normals — the same
    // lattice-line artifact that got Perlin replaced with simplex noise for bump work.
    float u = fx * fx * fx * (fx * (fx * 6.f - 15.f) + 10.f);
    float v = fy * fy * fy * (fy * (fy * 6.f - 15.f) + 10.f);
    float g00x, g00y, g10x, g10y, g01x, g01y, g11x, g11y;
    latticeGradient(x0,     y0,     period, seed, g00x, g00y);
    latticeGradient(x0 + 1, y0,     period, seed, g10x, g10y);
    latticeGradient(x0,     y0 + 1, period, seed, g01x, g01y);
    latticeGradient(x0 + 1, y0 + 1, period, seed, g11x, g11y);
    float n00 = g00x * fx          + g00y * fy;
    float n10 = g10x * (fx - 1.f)  + g10y * fy;
    float n01 = g01x * fx          + g01y * (fy - 1.f);
    float n11 = g11x * (fx - 1.f)  + g11y * (fy - 1.f);
    float a = n00 + u * (n10 - n00);
    float b = n01 + u * (n11 - n01);
    return a + v * (b - a);
}

/** The usual signed-vector encoding, n * 0.5 + 0.5, into a byte. */
inline uint8_t encodeSigned(float s) {
    float t = (s * 0.5f + 0.5f) * 255.f;
    if (t < 0.f) t = 0.f; else if (t > 255.f) t = 255.f;
    return (uint8_t)(t + 0.5f);
}

} // namespace watertex_detail

struct WaterTextures {
    static constexpr int SIZE = 256;
    std::vector<uint8_t> dudv;     // SIZE*SIZE*4, RGBA8: R,G = distortion vector, B = 0, A = 255
    std::vector<uint8_t> normal;   // SIZE*SIZE*4, RGBA8: RGB = tangent-space normal, A = 255

    void generate() {
        using namespace watertex_detail;
        const size_t N = (size_t)SIZE * SIZE;
        dudv.assign(N * 4, 0);
        normal.assign(N * 4, 0);

        // How far the encoded normal is allowed to tilt off vertical. The DuDv map gets the
        // full signed range because the shader scales it down by its own distortion strength
        // anyway, but the normal is used more or less as-is, and a normal map that tilts 45
        // degrees turns a harbour into hammered tin.
        const float BUMP = 0.7f;

        // Overlapping ripple trains, then noise on top. Frequencies are in whole cycles per
        // texture width, which is what makes them periodic; a single train at one frequency
        // and direction reads as corduroy, so these run at a few scales across a few
        // directions and interfere. The noise octaves then break up the regularity that a
        // pure sum of sines always betrays when it tiles — the eye finds the repeat period of
        // five sines very quickly.
        struct Train { int fu, fv; float phase, amp; };
        static const Train TRAINS[] = {
            {  3,  1, 0.00f, 1.00f },
            {  1,  4, 2.10f, 0.70f },
            {  5, -2, 4.30f, 0.45f },
            {  2,  7, 1.20f, 0.28f },
            { -6,  5, 5.50f, 0.18f },
        };

        std::vector<float> H(N, 0.f);
        for (int y = 0; y < SIZE; y++)
            for (int x = 0; x < SIZE; x++) {
                float u = (float)x / (float)SIZE, v = (float)y / (float)SIZE;
                float h = 0.f;
                for (const Train& t : TRAINS)
                    h += sinf(6.28318530718f * ((float)t.fu * u + (float)t.fv * v) + t.phase) * t.amp;
                // Amplitude halves as the frequency doubles — the 1/f falloff that makes fBm
                // look like a surface rather than like static. Periods are 4..64 cycles, so
                // the finest detail is four texels wide and still resolvable.
                float amp = 0.50f;
                for (int o = 0; o < 5; o++) {
                    int period = 4 << o;
                    h += periodicNoise(u * (float)period, v * (float)period, period, 0x9E37u + (uint32_t)o * 1013u) * amp;
                    amp *= 0.5f;
                }
                H[(size_t)y * SIZE + x] = h;
            }

        // Central differences with neighbour indices taken modulo SIZE. H being periodic is
        // not on its own enough: differencing against a clamped edge neighbour halves the
        // stride there and leaves the *gradient* discontinuous at the seam even though the
        // height is not, which is exactly as visible as a discontinuity in H would have been.
        std::vector<float> gu(N), gv(N);
        float gmax = 1e-6f;
        for (int y = 0; y < SIZE; y++)
            for (int x = 0; x < SIZE; x++) {
                int xm = (x + SIZE - 1) % SIZE, xp = (x + 1) % SIZE;
                int ym = (y + SIZE - 1) % SIZE, yp = (y + 1) % SIZE;
                size_t i = (size_t)y * SIZE + x;
                float a = 0.5f * (H[(size_t)y * SIZE + xp] - H[(size_t)y * SIZE + xm]);
                float b = 0.5f * (H[(size_t)yp * SIZE + x] - H[(size_t)ym * SIZE + x]);
                gu[i] = a; gv[i] = b;
                float m = fabsf(a) > fabsf(b) ? fabsf(a) : fabsf(b);
                if (m > gmax) gmax = m;
            }

        // Normalise against the observed peak instead of guessing a constant, so the encoded
        // range is filled whatever the octave amplitudes above are retuned to, and so nothing
        // clips. Headroom of 0.95 rather than 1.0 only to keep the extremes off the rails.
        const float inv = 0.95f / gmax;

        for (size_t i = 0; i < N; i++) {
            float du = gu[i] * inv, dv = gv[i] * inv;

            // DuDv: the signed 2D distortion vector the shader adds to its sample coordinates.
            // A DuDv map is by definition a derivative field, so the height gradient is not an
            // approximation of one here — it is the real thing. Blue is unused; alpha opaque.
            dudv[i * 4 + 0] = encodeSigned(du);
            dudv[i * 4 + 1] = encodeSigned(dv);
            dudv[i * 4 + 2] = 0;
            dudv[i * 4 + 3] = 255;

            // Normal: for a surface y = H(u, v) the outward normal is (-dH/du, 1, -dH/dv).
            //
            // Channel convention, which the shader MUST decode to match:
            //     R = x, along +u        G = y, the UP axis        B = z, along +v
            //     decode as normal.rgb * 2.0 - 1.0, then treat .y as up
            // This is deliberately not the convention several water tutorials use — they store
            // up in blue and sample the map as vec3(t.r, t.b, t.g) — so that the encoding
            // matches the y-up world the rest of the renderer works in and no channel swizzle
            // is hiding in the shader. Because y is up and always positive, G lives in the
            // upper half of its range by construction; that is correct, not clipping.
            float nx = -du * BUMP, ny = 1.f, nz = -dv * BUMP;
            float len = sqrtf(nx * nx + ny * ny + nz * nz);
            normal[i * 4 + 0] = encodeSigned(nx / len);
            normal[i * 4 + 1] = encodeSigned(ny / len);
            normal[i * 4 + 2] = encodeSigned(nz / len);
            normal[i * 4 + 3] = 255;
        }
    }
};
