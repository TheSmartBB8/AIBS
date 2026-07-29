// render.h - OpenGL 3.3 renderer: voxel chunks with software-ray-traced lighting
// (DDA sun shadows + ray AO against a 3D occupancy texture), procedural sky, water,
// instanced particles, HDR + bloom + ACES tonemap, viewmodels, instanced UI.
// Vendor-agnostic GL 3.3 core: runs on NVIDIA, AMD and Intel drivers.
#pragma once
#include "glapi.h"
#include "vmath.h"
#include "world.h"
#include "font.h"
#include <vector>
#include <string>
#include <cstdio>

// ---------------------------------------------------------------- shader utils
// Shader errors are reported via MessageBox on Windows (not just stderr) because a
// -mwindows GUI build has no visible console — a driver rejecting a shader would
// otherwise fail completely silently and just look like "the graphics are broken".
static void reportShaderError(const char* tag, const char* stage, const char* log) {
    fprintf(stderr, "[shader] %s %s error:\n%s\n", tag, stage, log);
#ifdef _WIN32
    char buf[4200];
    _snprintf(buf, sizeof buf, "Shader \"%s\" failed to %s:\n\n%s", tag, stage, log);
    buf[sizeof buf - 1] = 0;
    MessageBoxA(nullptr, buf, "VoxWreck - Shader Error", MB_ICONERROR);
#endif
}
static GLuint compileShader(GLenum type, const char* src, const char* tag) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[4096];
        glGetShaderInfoLog(s, sizeof log, nullptr, log);
        reportShaderError(tag, type == GL_VERTEX_SHADER ? "compile (vertex)" : "compile (fragment)", log);
    }
    return s;
}
static GLuint linkProgram(const char* vs, const char* fs, const char* tag) {
    GLuint v = compileShader(GL_VERTEX_SHADER, vs, tag);
    GLuint f = compileShader(GL_FRAGMENT_SHADER, fs, tag);
    GLuint p = glCreateProgram();
    glAttachShader(p, v);
    glAttachShader(p, f);
    glLinkProgram(p);
    GLint ok = 0;
    glGetProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
        char log[4096];
        glGetProgramInfoLog(p, sizeof log, nullptr, log);
        reportShaderError(tag, "link", log);
    }
    glDeleteShader(v);
    glDeleteShader(f);
    return p;
}

// ---------------------------------------------------------------- shared GLSL
// sky color function shared by sky + water + chunk (for reflections/ambient tint)
static const char* GLSL_SKY_COMMON = R"(
uniform vec3 uSunDir;        // direction light travels
uniform vec3 uSunColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform float uTime;
uniform int uSkyStyle;       // 0 day, 1 sunset

float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i), b = hash21(i + vec2(1, 0));
    float c = hash21(i + vec2(0, 1)), d = hash21(i + vec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.13; a *= 0.5; }
    return v;
}
vec3 skyColor(vec3 dir) {
    float el = clamp(dir.y, -0.05, 1.0);
    float h = pow(1.0 - max(el, 0.0), 3.0);
    vec3 col = mix(uSkyZenith, uSkyHorizon, h);
    vec3 toSun = -uSunDir;
    float sd = max(dot(dir, toSun), 0.0);
    // sun disc + halo
    col += uSunColor * 0.35 * pow(sd, 350.0) * 4.0;
    col += uSunColor * 0.12 * pow(sd, 16.0);
    if (uSkyStyle == 1) col += uSunColor * 0.10 * pow(sd, 4.0);
    // clouds on a plane
    if (dir.y > 0.015) {
        vec2 cuv = dir.xz / (dir.y + 0.12) * 1.6;
        cuv += vec2(uTime * 0.008, uTime * 0.003);
        float cl = fbm(cuv * 1.4);
        float cover = uSkyStyle == 1 ? 0.58 : 0.52;
        float cm = smoothstep(cover, cover + 0.22, cl);
        float fade = smoothstep(0.015, 0.12, dir.y);
        vec3 cloudCol = uSkyStyle == 1
            ? mix(vec3(0.45, 0.28, 0.32), vec3(1.15, 0.72, 0.5), pow(sd, 2.0) * 0.8 + 0.3)
            : mix(vec3(0.75, 0.78, 0.84), vec3(1.25, 1.22, 1.15), 0.6 + 0.4 * sd);
        col = mix(col, cloudCol, cm * fade * 0.85);
    }
    // subtle stars at dusk
    if (uSkyStyle == 1 && dir.y > 0.25) {
        float st = step(0.9985, hash21(floor(dir.xz / max(dir.y, 0.01) * 240.0)));
        col += vec3(st) * 0.35 * smoothstep(0.25, 0.6, dir.y);
    }
    return col;
}
)";

// Voxel ray tracing against a 3-level mipmapped occupancy hierarchy — fine (1 voxel),
// mid (2^3 block, max-downsampled) and coarse (8^3 block, max-downsampled) — matching the
// "mipmaps forming a dense octree" acceleration structure Teardown uses to skip empty space:
// a ray jumps a full coarse cell when it's empty, falls back to mid-sized jumps near clutter,
// and only steps voxel-by-voxel right next to actual geometry.
static const char* GLSL_TRACE_COMMON = R"(
uniform sampler3D uOcc;         // R8: 1 = solid (mip 0, voxel resolution)
uniform sampler3D uOccMid;      // R8: 2x2x2 max-downsampled (mip 1)
uniform sampler3D uOccCoarse;   // R8: 8x8x8 max-downsampled (mip 2)
uniform vec3 uWorldSize;        // voxels

float occAt(ivec3 c) { return texelFetch(uOcc, c, 0).r; }

// returns 1.0 if ray (voxel space) reaches maxT unblocked, else 0
float traceRay(vec3 ro, vec3 rd, float maxT) {
    vec3 ard = abs(rd);
    rd += vec3(lessThan(ard, vec3(1e-5))) * 1e-5;
    vec3 invd = 1.0 / rd;
    vec3 sgn = step(vec3(0.0), rd);
    float t = 0.0;
    for (int i = 0; i < 220; i++) {
        vec3 p = ro + rd * t;
        if (p.y >= uWorldSize.y && rd.y > 0.0) return 1.0;
        if (p.y < 0.0 && rd.y < 0.0) return 0.0;
        if ((p.x < 0.0 && rd.x < 0.0) || (p.x >= uWorldSize.x && rd.x > 0.0)) return 1.0;
        if ((p.z < 0.0 && rd.z < 0.0) || (p.z >= uWorldSize.z && rd.z > 0.0)) return 1.0;
        bool inside = all(greaterThanEqual(p, vec3(0.0))) && all(lessThan(p, uWorldSize));
        if (inside) {
            ivec3 vc = ivec3(floor(p));
            ivec3 ccoarse = vc >> 3;
            if (texelFetch(uOccCoarse, ccoarse, 0).r < 0.001) {
                vec3 cellMin = vec3(ccoarse << 3);
                vec3 tExit = (cellMin + sgn * 8.0 - ro) * invd;
                t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
            } else {
                ivec3 cmid = vc >> 1;
                if (texelFetch(uOccMid, cmid, 0).r < 0.001) {
                    vec3 cellMin = vec3(cmid << 1);
                    vec3 tExit = (cellMin + sgn * 2.0 - ro) * invd;
                    t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
                } else {
                    if (occAt(vc) > 0.5) return 0.0;
                    vec3 vMin = vec3(vc);
                    vec3 tExit = (vMin + sgn - ro) * invd;
                    t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
                }
            }
        } else {
            // outside: step to world box (cheap: advance a coarse cell)
            vec3 cellMin = floor(p / 8.0) * 8.0;
            vec3 tExit = (cellMin + sgn * 8.0 - ro) * invd;
            t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
        }
        if (t >= maxT) return 1.0;
    }
    return 1.0;
}

// Ambient occlusion ray: returns the fraction of maxT traveled before hitting a voxel
// (1.0 = never hit). Teardown's ambient pass uses this distance directly as the AO
// intensity — the farther a ray gets before colliding, the less obscured the surface is —
// rather than a binary hit/miss test.
float aoRayDist(vec3 ro, vec3 rd, float maxT) {
    vec3 ard = abs(rd);
    rd += vec3(lessThan(ard, vec3(1e-5))) * 1e-5;
    vec3 invd = 1.0 / rd;
    vec3 sgn = step(vec3(0.0), rd);
    float t = 0.0;
    for (int i = 0; i < 16; i++) {
        vec3 p = ro + rd * t;
        if (any(lessThan(p, vec3(0.0))) || any(greaterThanEqual(p, uWorldSize))) return 1.0;
        ivec3 vc = ivec3(floor(p));
        ivec3 cmid = vc >> 1;
        if (texelFetch(uOccMid, cmid, 0).r < 0.001) {
            vec3 cellMin = vec3(cmid << 1);
            vec3 tExit = (cellMin + sgn * 2.0 - ro) * invd;
            t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
        } else {
            if (occAt(vc) > 0.5) return clamp(t / maxT, 0.0, 1.0);
            vec3 tExit = (vec3(vc) + sgn - ro) * invd;
            t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
        }
        if (t >= maxT) return 1.0;
    }
    return clamp(t / maxT, 0.0, 1.0);
}

float hash13(vec3 p) {
    p = fract(p * 0.31831 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// Sample seed. Every ray direction in this renderer is chosen from a hash of the world
// position, which fixes the dither pattern in space: it is bit-identical in every frame.
// That is what a still image wants and it is a dead end for anything temporal — averaging
// frames of the same pattern returns the pattern, so the AO can never be better than its
// two-to-four samples and the grain is permanent.
//
// uSampleSeed is the frame index while accumulating and a constant otherwise. Offsetting
// the hash input by it makes each frame an independent estimate at identical ray cost.
uniform float uSampleSeed;
vec3 seedAt(vec3 worldPos, float salt) {
    return worldPos * (11.0 + salt * 4.0) + salt * 91.7 + uSampleSeed * 57.31;
}
)";

// ---------------------------------------------------------------- chunk shaders
static const char* VS_CHUNK = R"(#version 330 core
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;      // rgb + emissive/8
layout(location=2) in float aNormal;    // 0..5
layout(location=3) in float aAO;        // 0..1
layout(location=4) in float aRefl;      // 0..1 specular reflectivity
layout(location=5) in float aSmooth;    // 0..1 smoothness (1-roughness)
uniform mat4 uViewProj;
uniform vec3 uOffset;                   // falling cluster offset (meters)
// Tumble, for detached debris in flight. Identity for the static world and for anything
// that has already landed, so the ordinary chunk path pays a single mat3 multiply.
uniform mat3 uSpin;
uniform vec3 uSpinCenter;
out vec3 vWorld;
out vec4 vColor;
out vec3 vNormal;
out float vAO;
out float vRefl;
out float vSmooth;
const vec3 NRM[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
void main() {
    vec3 wp = uSpin * (aPos - uSpinCenter) + uSpinCenter + uOffset;
    vWorld = wp;
    vColor = aColor;
    // The normal must ride the rotation too, or a tumbling piece keeps lighting
    // itself as though its faces still pointed the way they were authored.
    vNormal = uSpin * NRM[int(aNormal + 0.5)];
    vAO = aAO;
    vRefl = aRefl;
    vSmooth = aSmooth;
    gl_Position = uViewProj * vec4(wp, 1.0);
}
)";

static std::string fsChunk() {
    std::string s = R"(#version 330 core
in vec3 vWorld;
in vec4 vColor;
in vec3 vNormal;
in float vAO;
in float vRefl;
in float vSmooth;
layout(location=0) out vec4 FragColor;
layout(location=1) out vec4 GNormal;   // xyz = surface normal, w = view distance
uniform vec3 uCamPos;
uniform float uVoxelSize;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform int uShadowQuality;    // 0,1,2
uniform int uAOQuality;        // 0,1,2
uniform int uNumLights;
uniform vec4 uLightPosR[16];   // xyz + radius
uniform vec3 uLightCol[16];
)";
    s += GLSL_SKY_COMMON;
    s += GLSL_TRACE_COMMON;
    s += R"(
void main() {
    vec3 N = vNormal;
    vec3 albedo = vColor.rgb;
    float emis = vColor.a * 8.0;
    float dist = length(vWorld - uCamPos);

    // ---- procedural surface detail: this renderer ships no texture assets, so without this
    // every voxel face would be a single flat baked color -- the "looks flat/plastic" problem.
    // Voxel faces are always axis-aligned, so a straight per-axis UV stands in for triplanar
    // mapping with no seams to hide. A fine grain + a coarser blotch/weathering pattern modulate
    // albedo, scaled by the per-material roughness proxy so glass/polished metal stay cleaner
    // than rough concrete, bedrock or wood. A matching fake-bump shading normal (derived the
    // same way, from the noise gradient rather than real geometry) lets the sun's diffuse term
    // pick up the same detail instead of every face lighting as a perfectly flat plane.
    vec2 uvTex = abs(N.x) > 0.5 ? vWorld.zy : (abs(N.y) > 0.5 ? vWorld.xz : vWorld.xy);
    float roughness = 1.0 - vSmooth;
    float fine = fbm(uvTex * 46.0) - 0.5;
    float coarse = fbm(uvTex * 5.0 + 19.0) - 0.5;
    albedo *= 1.0 + (fine * 0.5 + coarse * 0.8) * roughness * 0.4;
    albedo *= mix(0.92, 1.05, fbm(uvTex * 1.6 + 5.0));

    // extra high-frequency micro-detail layer, well above voxel resolution -- this is the
    // "sharper/more detailed surface" a texture resolution bump would otherwise buy, done
    // analytically instead of with a bitmap so it never blurs or pixelates up close. Faded out
    // by distance since undersampled high-frequency noise aliases/shimmers once a screen pixel
    // covers many texture cycles, the same reason bitmap texture filtering uses mipmaps.
    float detailFade = smoothstep(28.0, 6.0, dist);
    float micro = fbm(uvTex * 240.0) - 0.5;
    albedo *= 1.0 + micro * roughness * 0.16 * detailFade;

    // ---- material variety: the layer above is a universal micro-grain that applies equally
    // everywhere; this second layer picks a distinct *pattern shape* per material instead of
    // just varying intensity. There's no per-voxel material ID in the vertex data (only the
    // baked color and the refl/smooth proxy), so classification runs on those -- continuous
    // blend weights rather than a hard switch, so two adjacent voxels of a slightly different
    // shade never show a seam between pattern styles.
    float maxc = max(albedo.r, max(albedo.g, albedo.b));
    float minc = min(albedo.r, min(albedo.g, albedo.b));
    float sat = maxc - minc;
    float warmth = albedo.r - albedo.b;
    float greenness = albedo.g - max(albedo.r, albedo.b);
    float value = maxc;

    float wOrganic = smoothstep(0.02, 0.10, greenness);                              // grass/leaves
    float wGrain = smoothstep(0.06, 0.16, warmth) * smoothstep(0.05, 0.14, sat)
                 * (1.0 - wOrganic);                                                 // wood/brick/dirt
    float wGrid = (1.0 - smoothstep(0.02, 0.10, sat)) * smoothstep(0.55, 0.75, value)
                * (1.0 - wOrganic) * (1.0 - wGrain);                                 // tile/paneling
    float wSpeckle = (1.0 - wOrganic) * (1.0 - wGrain) * (1.0 - wGrid);              // stone/concrete/asphalt
    // refl/smooth alone can't tell metal apart from concrete/asphalt/tile (materialSpecular
    // gives every M_HEAVY voxel the same values), so also gate on hue: this palette's metals
    // read cool/blue-gray while its concrete and tile read warm-neutral gray.
    float coolness = 1.0 - smoothstep(-0.06, 0.01, warmth);
    float wMetal = coolness * smoothstep(0.30, 0.55, vRefl) * smoothstep(0.35, 0.65, vSmooth)
                 * (1.0 - smoothstep(0.78, 0.92, vSmooth));                          // brushed metal (additive)

    float nSpeckle = fbm(uvTex * 70.0) - 0.5;
    nSpeckle = sign(nSpeckle) * pow(abs(nSpeckle) * 2.0, 0.7) * 0.5;                 // punchier, isolated speckle
    float nGrainStreak = fbm(vec2(uvTex.x * 3.0, uvTex.y * 26.0)) - 0.5;             // anisotropic grain lines
    float nGrainRing = sin(uvTex.y * 40.0 + nGrainStreak * 6.0) * 0.5;
    float nGrain = nGrainStreak * 0.65 + nGrainRing * 0.35;
    float nOrganic = (fbm(uvTex * 10.0) - 0.5) * 0.8 + (fbm(uvTex * 26.0 + 5.0) - 0.5) * 0.4;
    vec2 gridCell = fract(uvTex * 3.0) - 0.5;
    float nGrid = -(1.0 - smoothstep(0.0, 0.06, min(abs(gridCell.x), abs(gridCell.y)))) * 0.55;
    float nBrushed = (fbm(vec2(uvTex.x * 90.0, uvTex.y * 6.0)) - 0.5) * 0.35;

    float pattern = wSpeckle * nSpeckle + wGrain * nGrain + wOrganic * nOrganic
                  + wGrid * nGrid + wMetal * nBrushed;
    albedo *= 1.0 + clamp(pattern, -0.6, 0.6) * roughness;

    vec3 Tt, Bt;
    if (abs(N.x) > 0.5) { Tt = vec3(0.0, 0.0, 1.0); Bt = vec3(0.0, 1.0, 0.0); }
    else if (abs(N.y) > 0.5) { Tt = vec3(1.0, 0.0, 0.0); Bt = vec3(0.0, 0.0, 1.0); }
    else { Tt = vec3(1.0, 0.0, 0.0); Bt = vec3(0.0, 1.0, 0.0); }
    float bumpC = vnoise(uvTex * 46.0);
    float bumpX = vnoise(uvTex * 46.0 + vec2(0.6, 0.0));
    float bumpY = vnoise(uvTex * 46.0 + vec2(0.0, 0.6));
    vec2 gradLo = vec2(bumpX - bumpC, bumpY - bumpC);
    // finer second bump octave, layered like a detail normal map; distance-faded for the same
    // aliasing reason as the micro albedo layer above
    float bumpC2 = vnoise(uvTex * 240.0);
    float bumpX2 = vnoise(uvTex * 240.0 + vec2(0.15, 0.0));
    float bumpY2 = vnoise(uvTex * 240.0 + vec2(0.0, 0.15));
    vec2 gradHi = vec2(bumpX2 - bumpC2, bumpY2 - bumpC2) * detailFade;
    vec2 grad = gradLo + gradHi * 0.5;
    vec3 Nb = normalize(N - (Tt * grad.x + Bt * grad.y) * roughness * 0.5);

    // voxel-space position, biased off the surface
    vec3 vp = vWorld / uVoxelSize + N * 0.55;
    vec3 toSun = -uSunDir;

    // ---- ray-traced sun visibility
    float sunVis = 1.0;
    float mx = max(uWorldSize.x, max(uWorldSize.y, uWorldSize.z)) * 1.4;
    if (dot(N, toSun) > 0.0) {
        float h1 = hash13(vWorld * 39.7);
        float h2 = hash13(vWorld * 91.3 + 7.7);
        if (uShadowQuality == 0) {
            sunVis = traceRay(vp, toSun, mx);
        } else if (uShadowQuality == 1) {
            vec3 j = (vec3(h1, h2, hash13(vWorld * 17.9)) - 0.5) * 0.05;
            sunVis = 0.5 * traceRay(vp, normalize(toSun + j), mx)
                   + 0.5 * traceRay(vp, toSun, mx);
        } else {
            sunVis = 0.0;
            for (int k = 0; k < 3; k++) {
                vec3 j = vec3(hash13(vWorld * 39.7 + float(k) * 13.1),
                              hash13(vWorld * 91.3 + float(k) * 7.7),
                              hash13(vWorld * 17.9 + float(k) * 3.3)) - 0.5;
                sunVis += traceRay(vp, normalize(toSun + j * 0.07), mx);
            }
            sunVis /= 3.0;
        }
    } else sunVis = 0.0;

    // ---- ray-traced ambient occlusion: cosine-weighted hemisphere rays whose *distance*
    // to the nearest voxel sets the AO intensity (mirrors Teardown's ambient lighting pass:
    // farther unobstructed travel = less occluded), blended with baked per-vertex corner AO.
    float ao = vAO;
    if (uAOQuality > 0) {
        vec3 T = normalize(abs(N.y) < 0.9 ? cross(N, vec3(0, 1, 0)) : vec3(1, 0, 0));
        vec3 B = cross(N, T);
        int n = uAOQuality == 1 ? 2 : 4;
        float maxDist = 20.0;
        float accum = 0.0;
        for (int k = 0; k < 4; k++) {
            if (k >= n) break;
            vec3 jp = seedAt(vWorld, float(k));
            float u1 = hash13(jp);
            float u2 = hash13(jp + 3.3);
            float rr = sqrt(u1);
            float phi = 6.2831853 * u2;
            vec3 localDir = vec3(rr * cos(phi), rr * sin(phi), sqrt(max(0.0, 1.0 - u1)));
            vec3 d = normalize(T * localDir.x + B * localDir.y + N * localDir.z);
            // jitter the ray origin too, to hide repeating per-voxel AO artifacts
            vec3 originJitter = (vec3(hash13(jp + 9.1), hash13(jp + 13.7), hash13(jp + 21.3)) - 0.5) * 0.5;
            accum += aoRayDist(vp + originJitter, d, maxDist);
        }
        float rayAO = accum / float(n);
        ao *= mix(1.0, rayAO, 0.85);
    }

    // ---- lighting (uses the bumped shading normal Nb so the surface detail above actually
    // catches light instead of every face shading as a perfectly flat plane; ray directions
    // stay on the true geometric N since Nb is a shading-only fake)
    float ndl = max(dot(Nb, toSun), 0.0);
    vec3 direct = uSunColor * ndl * sunVis;
    vec3 skyAmb = mix(uSkyHorizon, uSkyZenith, Nb.y * 0.5 + 0.5) * uAmbient * 1.6;
    vec3 bounce = uSunColor * 0.06 * max(dot(Nb, vec3(-toSun.x, 0.4, -toSun.z)), 0.0);
    vec3 light = direct + (skyAmb + bounce) * ao;

    // dynamic lights (explosions, muzzle flash): raytraced visibility so light no longer
    // bleeds through walls, with the sampled point jittered over the light's volume for a
    // soft area-light-like penumbra (Teardown: "ray to a random point on the light's surface").
    for (int i = 0; i < uNumLights; i++) {
        vec3 lightCenter = uLightPosR[i].xyz;
        float r = uLightPosR[i].w;
        float dCenter = length(lightCenter - vWorld);
        if (dCenter < r) {
            vec3 jp = seedAt(vWorld, 17.3 + float(i) * 3.1);
            vec3 jitter = (vec3(hash13(jp), hash13(jp + 5.5), hash13(jp + 11.1)) - 0.5) * (r * 0.12);
            vec3 Lp = (lightCenter + jitter) - vWorld;
            float d = length(Lp);
            vec3 Ldir = Lp / max(d, 0.01);
            float att = pow(clamp(1.0 - dCenter / r, 0.0, 1.0), 2.0);
            float diff = max(dot(Nb, Ldir), 0.12);
            float lvis = traceRay(vp, Ldir, d / uVoxelSize);
            light += uLightCol[i] * att * diff * lvis;
        }
    }

    vec3 col = albedo * light + albedo * emis;

    // tiny sunlit sparkle on rough aggregate-like surfaces (concrete/stone/asphalt) where the
    // fine speckle noise peaks -- the same "catches the light" cue real aggregate has, and
    // another cheap way to read as higher surface detail without an actual high-res texture
    col += wSpeckle * smoothstep(0.86, 0.99, nSpeckle + 0.5) * detailFade * uSunColor * sunVis * 0.5;

    // ---- raytraced specular reflections / specular occlusion (Teardown-style): the
    // reflection ray (jittered by roughness, so rough materials get blurrier reflections)
    // is traced against the same occupancy volume used for shadows. Unblocked -> sample the
    // sky; blocked -> the reflection darkens rather than faking a full mirror image, which is
    // exactly the "specular occlusion" the technique relies on in place of global illumination.
    if (uShadowQuality > 0 && vRefl > 0.05) {
        vec3 V = normalize(uCamPos - vWorld);
        vec3 R = reflect(-V, N);
        vec3 jp2 = seedAt(vWorld, 71.0);
        vec3 jitter2 = vec3(hash13(jp2), hash13(jp2 + 6.2), hash13(jp2 + 12.4)) * 2.0 - 1.0;
        vec3 Rj = normalize(R + jitter2 * roughness * 0.6);
        if (dot(Rj, N) < 0.0) Rj = reflect(Rj, N);
        float skyVis = traceRay(vp, Rj, 44.0);
        vec3 reflColor = skyColor(Rj) * skyVis;
        float sunGlint = pow(max(dot(Rj, toSun), 0.0), mix(8.0, 140.0, vSmooth)) * sunVis;
        vec3 tint = mix(vec3(1.0), albedo, 0.35);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.6 + 0.15;
        col += vRefl * fres * tint * (reflColor * 0.35 + uSunColor * sunGlint * 1.3);
    }

    // fog
    float f = 1.0 - exp(-pow(dist * uFogDensity, 1.5));
    vec3 fogCol = mix(uFogColor, uSunColor * 0.25 + uFogColor, 0.0);
    col = mix(col, fogCol, clamp(f, 0.0, 1.0));

    FragColor = vec4(col, 1.0);
    // Geometry for the cleanup filter downstream: the true surface normal, and view depth.
    // Only the chunk pass writes this attachment — sky, water, particles and models leave it
    // alone via glDrawBuffers — so w > 0 means "an opaque voxel surface is here" and the
    // filter knows to leave everything else untouched rather than smearing across it.
    GNormal = vec4(N, dist);
}
)";
    return s;
}

// ---------------------------------------------------------------- sky
static const char* VS_FULLSCREEN = R"(#version 330 core
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
    vUV = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.99999, 1.0);
}
)";
static std::string fsSky() {
    std::string s = R"(#version 330 core
in vec2 vUV;
out vec4 FragColor;
uniform vec3 uCamRight, uCamUp, uCamFwd;
uniform float uTanHalfFov, uAspect;
)";
    s += GLSL_SKY_COMMON;
    s += R"(
void main() {
    vec2 ndc = vUV * 2.0 - 1.0;
    vec3 dir = normalize(uCamFwd + uCamRight * ndc.x * uTanHalfFov * uAspect
                         + uCamUp * ndc.y * uTanHalfFov);
    FragColor = vec4(skyColor(dir), 1.0);
}
)";
    return s;
}

// ---------------------------------------------------------------- water
static const char* VS_WATER = R"(#version 330 core
layout(location=0) in vec2 aPos;      // xz in meters
uniform mat4 uViewProj;
uniform float uWaterLevel;
// Simulation field: r = surface displacement, gb = surface gradient, a = still-water depth.
uniform sampler2D uWater;
uniform vec2 uWaterOrigin;            // world metres of the field's (0,0) corner
uniform vec2 uWaterSize;              // world metres the field spans
out vec3 vWorld;
out vec3 vFieldN;                     // surface normal from the simulated gradient
out float vDepth;                     // still-water depth under this point
out float vDisp;
void main() {
    vec2 uv = (aPos - uWaterOrigin) / uWaterSize;
    vec4 f = texture(uWater, uv);
    // Real displacement, not just a perturbed normal. The surface used to be a flat quad
    // with the waves painted on as a normal, which holds up until anything crosses the
    // waterline: a hull sat in a mirror-flat plane while its reflection rippled.
    vWorld = vec3(aPos.x, uWaterLevel + f.r, aPos.y);
    vDisp = f.r;
    vDepth = f.a;
    // Gradients are per-cell differences, so scale by cell size to get a true slope.
    vFieldN = normalize(vec3(-f.g * 12.0, 1.0, -f.b * 12.0));
    gl_Position = uViewProj * vec4(vWorld, 1.0);
}
)";
// Single-layer water, in the sense Unreal uses the term: one surface that carries its own
// depth-dependent absorption, a Fresnel-weighted reflection, and foam — rather than a flat
// tinted plane with waves drawn on it.
static std::string fsWater() {
    std::string s = R"(#version 330 core
in vec3 vWorld;
in vec3 vFieldN;
in float vDepth;
in float vDisp;
out vec4 FragColor;
uniform vec3 uCamPos;
uniform vec3 uWaterColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
)";
    s += GLSL_SKY_COMMON;
    s += R"(
// Beer-Lambert extinction, per channel, in inverse metres. Red is absorbed within a metre or
// so and blue takes many, which is the entire reason water is blue and why a shallow patch
// over sand is not. A single scalar tint cannot express it: the old shader used one colour
// everywhere, so the harbour was the same slab of teal from the shoreline to the deep, and
// no amount of wave detail fixes that because the cue is chromatic, not geometric.
const vec3 EXTINCT = vec3(0.46, 0.16, 0.09);

void main() {
    vec2 p = vWorld.xz;
    float t = uTime;

    // The simulated surface carries the large waves. Fine ripples stay procedural: the grid
    // is half-metre and cannot represent them, and they are the one part of a water surface
    // where a sum of sines is honestly the right model.
    float r1 = sin(p.x * 5.3 + t * 2.1) * 0.5 + sin(p.x * 2.7 - p.y * 3.1 + t * 1.7) * 0.5;
    float r2 = sin(p.y * 4.9 + t * 1.9) * 0.5 + sin(p.x * 3.3 + p.y * 2.3 - t * 2.3) * 0.5;
    vec3 N = normalize(vFieldN + vec3(-r1 * 0.06, 0.0, -r2 * 0.06));

    vec3 V = normalize(uCamPos - vWorld);
    float NoV = max(dot(N, V), 0.0);

    // Reflection. Grazing rays see sky, steep ones see into the water.
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.02;
    vec3 refl = skyColor(normalize(R));

    // Schlick against water's real index of refraction: F0 = ((1-1.33)/(1+1.33))^2 = 0.02.
    // The old shader used a 0.9 scale with a 0.08 floor, which is far too reflective looking
    // straight down — the harbour behaved like a sheet of chrome from directly above.
    float fres = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

    // How far a viewing ray travels through the water before it hits the bed. At a grazing
    // angle that is much further than the depth, which is why a lake goes opaque toward the
    // horizon and clear at your feet.
    float pathLen = vDepth / max(NoV, 0.12);
    vec3 trans = exp(-EXTINCT * pathLen);
    // Bed colour, dimmed by what the water has already absorbed above it. No refraction
    // sample here — the scene colour is not available at this point in the frame — so this
    // stands in for the bed with the sand tone the maps use, tinted by depth.
    vec3 bed = vec3(0.62, 0.56, 0.42) * mix(0.35, 1.0, exp(-pathLen * 0.35));
    vec3 body = mix(uWaterColor, bed, trans);

    vec3 col = mix(body, refl, fres);

    // Sun glint, sharpened by how much of the sun disc the slope can catch.
    vec3 toSun = -uSunDir;
    col += uSunColor * pow(max(dot(R, toSun), 0.0), 240.0) * 2.0;

    // Foam, from two causes, as in the references: a band where the water shoals against the
    // land, and streaks on the steep faces of waves. Both keyed off quantities the
    // simulation already produces, so foam appears where a blast ring passes rather than
    // being scattered around by a noise function.
    float shore = 1.0 - smoothstep(0.0, 1.1, vDepth);
    float steep = smoothstep(0.16, 0.55, 1.0 - N.y);
    float crest = smoothstep(0.02, 0.14, vDisp);
    float foam = clamp(shore * 0.85 + steep * 0.9 + crest * 0.5, 0.0, 1.0);
    // Break the shoreline band up, or it reads as a painted stripe following the coast.
    foam *= 0.65 + 0.35 * sin(p.x * 7.0 + p.y * 5.0 + t * 1.3);
    col = mix(col, vec3(0.92, 0.95, 0.97), clamp(foam, 0.0, 1.0) * 0.85);

    float dist = length(vWorld - uCamPos);
    float f = 1.0 - exp(-pow(dist * uFogDensity, 1.5));
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

    // Shallow water is see-through and deep water is not, so opacity follows the same path
    // length the colour does. A constant 0.93 made a puddle as opaque as the open sea.
    float alpha = mix(0.55, 0.97, 1.0 - exp(-pathLen * 0.8));
    alpha = max(alpha, foam * 0.9);
    FragColor = vec4(col, alpha);
}
)";
    return s;
}

// ---------------------------------------------------------------- particles
static const char* VS_PART = R"(#version 330 core
layout(location=0) in vec2 aCorner;      // quad -0.5..0.5
layout(location=1) in vec4 aPosSize;     // world xyz + size
layout(location=2) in vec4 aColor;
layout(location=3) in vec4 aMisc;        // rot, shape(0 soft,1 square), unused, unused
uniform mat4 uViewProj;
uniform vec3 uCamRight, uCamUp;
out vec4 vColor;
out vec2 vUV;
flat out float vShape;
void main() {
    float c = cos(aMisc.x), s = sin(aMisc.x);
    vec2 rc = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c);
    vec3 wp = aPosSize.xyz + (uCamRight * rc.x + uCamUp * rc.y) * aPosSize.w;
    vColor = aColor;
    vUV = aCorner * 2.0;
    vShape = aMisc.y;
    gl_Position = uViewProj * vec4(wp, 1.0);
}
)";
static const char* FS_PART = R"(#version 330 core
in vec4 vColor;
in vec2 vUV;
flat in float vShape;
out vec4 FragColor;
void main() {
    float a = vColor.a;
    if (vShape < 0.5) {
        float d = length(vUV);
        a *= smoothstep(1.0, 0.25, d);
    }
    if (a < 0.004) discard;
    FragColor = vec4(vColor.rgb, a);
}
)";

// ---------------------------------------------------------------- simple lit (viewmodel, players)
static const char* VS_MODEL = R"(#version 330 core
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aColor;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vNormal;
out vec4 vColor;
out vec3 vWorld;
void main() {
    vec4 wp = uModel * vec4(aPos, 1.0);
    vWorld = wp.xyz;
    vNormal = mat3(uModel) * aNormal;
    vColor = aColor;
    gl_Position = uViewProj * wp;
}
)";
static const char* FS_MODEL = R"(#version 330 core
in vec3 vNormal;
in vec4 vColor;
in vec3 vWorld;
out vec4 FragColor;
uniform vec3 uSunDirM;
uniform vec3 uSunColorM;
uniform float uAmbientM;
void main() {
    vec3 N = normalize(vNormal);
    float ndl = max(dot(N, -uSunDirM), 0.0);
    vec3 col = vColor.rgb * (uSunColorM * ndl * 0.55 + vec3(uAmbientM));
    col += vColor.rgb * vColor.a * 6.0;      // a used as emissive here
    FragColor = vec4(col, 1.0);
}
)";

// ---------------------------------------------------------------- post
static const char* FS_BRIGHT = R"(#version 330 core
in vec2 vUV;
out vec4 FragColor;
uniform sampler2D uTex;
void main() {
    vec3 c = texture(uTex, vUV).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    FragColor = vec4(c * smoothstep(1.0, 2.2, l), 1.0);
}
)";
static const char* FS_BLUR = R"(#version 330 core
in vec2 vUV;
out vec4 FragColor;
uniform sampler2D uTex;
uniform vec2 uDir;   // (1/w,0) or (0,1/h)
void main() {
    vec3 c = texture(uTex, vUV).rgb * 0.227027;
    vec2 off1 = uDir * 1.3846153846;
    vec2 off2 = uDir * 3.2307692308;
    c += texture(uTex, vUV + off1).rgb * 0.3162162162;
    c += texture(uTex, vUV - off1).rgb * 0.3162162162;
    c += texture(uTex, vUV + off2).rgb * 0.0702702703;
    c += texture(uTex, vUV - off2).rgb * 0.0702702703;
    FragColor = vec4(c, 1.0);
}
)";
// Running mean of the scene buffer.
//
// uBlend is 1/(n+1), so this is a plain unweighted average of every frame since the last
// reset rather than an exponential fade. An exponential blend never actually converges — it
// keeps a permanent share of the newest, noisiest sample — and the whole point here is to
// reach a clean image and stay there while the player stands still.
static const char* FS_ACCUM = R"(#version 330 core
in vec2 vUV;
out vec4 FragColor;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform float uBlend;
void main() {
    vec3 c = texture(uCur, vUV).rgb;
    // A single NaN would poison the history for the rest of the session, since every later
    // frame averages against it.
    if (!(c.r == c.r)) c = vec3(0.0);
    c = clamp(c, vec3(0.0), vec3(4096.0));
    vec4 hs = texture(uHist, vUV);
    vec3 h = hs.rgb;
    if (!(h.r == h.r)) h = c;

    // Alpha carries the running mean of sample luminance *squared*. With the mean in rgb
    // that is a complete second-moment estimator, so the cleanup filter can ask how noisy
    // each pixel actually is rather than being told by a hand-tuned schedule. It costs
    // nothing — the buffer is RGBA and alpha was being written as a constant 1.
    //
    // Luminance is linear, so mean(luma(sample)) == luma(mean(rgb)) and the first moment
    // needs no channel of its own: variance is just alpha - luma(rgb)^2.
    float lc = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float m2h = hs.a;
    if (!(m2h == m2h)) m2h = lc * lc;
    vec3 mean = mix(h, c, uBlend);
    float lm = dot(mean, vec3(0.2126, 0.7152, 0.0722));
    // Keep the moment consistent with the mean it is paired with, or a clamped rgb can
    // leave a stale m2 below luma^2 — a negative variance, which reads as "fully converged"
    // on precisely the pixels that just changed.
    float m2 = max(mix(m2h, lc * lc, uBlend), lm * lm);
    FragColor = vec4(mean, m2);
}
)";

// Variance-guided a-trous cleanup, run as a few passes at doubling tap spacing.
//
// This is what carries the image for the first frames after the camera moves, which is most
// frames in play — the accumulator needs dozens of samples to settle and the player is not
// standing still for them.
//
// The filter decides its own strength per pixel from the measured variance rather than from
// a sample-count ramp. Variance of the mean falls as 1/N on its own, so the filter retires
// itself where the estimate has converged and keeps working where it has not; one global
// ramp cannot serve a dim interior and a sunlit wall at once.
static const char* FS_DENOISE = R"(#version 330 core
in vec2 vUV;
out vec4 FragColor;
uniform sampler2D uColor;     // rgb = mean radiance, a = second moment (pass 0) or variance
uniform sampler2D uGeom;      // rgb = normal, a = view distance (0 = not a voxel surface)
uniform vec2 uTexel;
uniform float uStep;          // a-trous dilation, in pixels
uniform float uM2;            // 1 = alpha is a second moment, 0 = alpha is already variance
uniform float uSamples;
uniform float uPhiL, uPhiN, uPhiD;

float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Variance of the *mean*. Note N-1 rather than N: (E[l^2] - E[l]^2) understates the sample
// variance by (N-1)/N, and dividing the corrected figure by N to get the variance of the
// mean leaves N-1 underneath. At the small N where any of this matters that is not a
// rounding detail — at N = 2 it is a factor of two.
float varAt(vec4 c) {
    float l = lumaOf(c.rgb);
    return uM2 > 0.5 ? max(c.a - l * l, 0.0) / max(uSamples - 1.0, 1.0) : max(c.a, 0.0);
}

void main() {
    vec4 c0 = texture(uColor, vUV);
    vec4 g0 = texture(uGeom, vUV);
    // Sky, water, particles and viewmodels never wrote geometry here, so leave them exactly
    // as they are. Filtering them would mean weighting by a neighbour's surface that has
    // nothing to do with the pixel in hand.
    if (g0.w <= 0.0) { FragColor = c0; return; }
    float l0 = lumaOf(c0.rgb);

    // The variance estimate is itself built from noisy data, so prefilter it 3x3 before
    // using it as a tolerance. Without this a single firefly declares its own neighbourhood
    // an edge, refuses to be filtered, and survives every pass as a permanent bright speck.
    float vs = 0.0, vw = 0.0;
    for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
            float k = (x == 0 && y == 0) ? 4.0 : ((x == 0 || y == 0) ? 2.0 : 1.0);
            vs += varAt(texture(uColor, vUV + vec2(float(x), float(y)) * uTexel)) * k;
            vw += k;
        }
    float sigmaL = uPhiL * sqrt(vs / vw) + 1e-4;

    const float k5[3] = float[3](1.0, 0.66, 0.24);
    vec3 acc = c0.rgb;
    float accV = varAt(c0), sum = 1.0;
    for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
            if (x == 0 && y == 0) continue;
            vec2 uv = vUV + vec2(float(x), float(y)) * uTexel * uStep;
            vec4 g = texture(uGeom, uv);
            if (g.w <= 0.0) continue;
            vec4 c = texture(uColor, uv);
            float wn = pow(max(dot(g.xyz, g0.xyz), 0.0), uPhiN);
            float wd = exp(-abs(g.w - g0.w) * uPhiD);
            float wl = exp(-abs(lumaOf(c.rgb) - l0) / sigmaL);
            float w = k5[abs(x)] * k5[abs(y)] * wn * wd * wl;
            acc += c.rgb * w;
            sum += w;
            // Variance of a weighted mean carries the *square* of each weight, so the
            // estimate shrinks as the filter gathers, which is what lets the next pass
            // filter less. Dividing by sum(w^2) instead — the shape this accumulator invites
            // you to write — yields a weighted average of the neighbours' variances, which
            // barely falls at all and leaves every pass filtering at full strength.
            accV += varAt(c) * w * w;
        }
    }
    FragColor = vec4(acc / sum, accV / max(sum * sum, 1e-6));
}
)";

static const char* FS_COMPOSITE = R"(#version 330 core
in vec2 vUV;
out vec4 FragColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uVignette;
vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
void main() {
    vec3 c = texture(uScene, vUV).rgb;
    c += texture(uBloom, vUV).rgb * uBloomStrength;
    c = aces(c * 0.85);
    c = pow(c, vec3(1.0 / 2.2));
    // final grade: a mild S-curve contrast around mid-gray plus a small saturation lift.
    // Cheap, display-referred polish pass -- the flat ACES+gamma output on its own reads as
    // washed out compared to the punchier grade most references (Teardown included) ship with.
    c = mix(vec3(0.5), c, 1.10);
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(lum), c, 1.15);
    c = clamp(c, 0.0, 1.0);
    vec2 d = vUV - 0.5;
    c *= 1.0 - uVignette * dot(d, d) * 1.6;
    FragColor = vec4(c, 1.0);
}
)";

// ---------------------------------------------------------------- UI (instanced rounded rects)
static const char* VS_UI = R"(#version 330 core
layout(location=0) in vec2 aCorner;                // -1..1
layout(location=1) in vec4 aRect;                  // center xy, halfsize wh (pixels)
layout(location=2) in vec4 aColor;
layout(location=3) in float aRadius;
uniform vec2 uScreen;
out vec4 vColor;
out vec2 vLocal;
flat out vec2 vHalf;
flat out float vRadius;
void main() {
    vec2 p = aRect.xy + aCorner * aRect.zw;
    vec2 ndc = vec2(p.x / uScreen.x * 2.0 - 1.0, 1.0 - p.y / uScreen.y * 2.0);
    vColor = aColor;
    vLocal = aCorner * aRect.zw;
    vHalf = aRect.zw;
    vRadius = aRadius;
    gl_Position = vec4(ndc, 0.0, 1.0);
}
)";
static const char* FS_UI = R"(#version 330 core
in vec4 vColor;
in vec2 vLocal;
flat in vec2 vHalf;
flat in float vRadius;
out vec4 FragColor;
void main() {
    vec2 q = abs(vLocal) - vHalf + vRadius;
    float d = length(max(q, 0.0)) - vRadius;
    float a = vColor.a * clamp(0.5 - d, 0.0, 1.0);
    if (a < 0.003) discard;
    FragColor = vec4(vColor.rgb, a);
}
)";

// ---------------------------------------------------------------- data structs
struct ModelVert { float x, y, z, nx, ny, nz; uint8_t r, g, b, a; };

struct PartInst { float x, y, z, size; float r, g, b, a; float rot, shape, u0, u1; };

struct UIInst { float cx, cy, hw, hh; float r, g, b, a; float radius; };

struct DynLight { vec3 pos; float radius; vec3 color; };

struct RenderSettings {
    int shadowQuality = 2;    // 0 low, 1 medium, 2 high
    int aoQuality = 2;
    float fov = 75.f;
    float bloom = 0.55f;
    bool vsync = true;
    float renderScale = 1.25f; // internal supersampling factor (1.0/1.25/1.5/2.0)
    bool accumulate = true;    // converge the ray noise while the camera holds still
    int maxAccum = 256;        // stop averaging past this; the mean is its own answer
    int denoisePasses = 4;     // 5x5 taps at spacing 1,2,4,8 — an effective 41x41 support
    // Retired after three samples, which is far earlier than it sounds like it should be and
    // is what the measurements say. Against a 384-sample reference on Sandpoint Marina, the
    // filter's effect on error was -0.1% at 1 sample, -9.4% at 2, then +7.2% at 4, +23.5% at
    // 8 and +40.8% at 32. Tuning the tolerance moved the crossover slightly and never past
    // 4 samples: phiL 1.0 still cost +3.7% at 8.
    //
    // The web sibling gets -38% from the same filter at 1 sample, so the difference is worth
    // stating plainly: it is not that this implementation is worse, it is that this renderer
    // is far less noisy to start with. Its 1-sample error is 5.29 where the web build's is
    // 18.6, because the AO here is stratified over 2-4 rays and much of the lighting is
    // analytic rather than sampled. There is simply much less noise for a spatial filter to
    // remove, and past a couple of samples everything it removes is signal.
    int denoiseUntil = 4;
    float denoisePhiL = 2.0f;  // luminance tolerance, in standard deviations. 2.0 measured
                               // best at the only sample counts where the filter still runs;
                               // 4.0 gave -3.6% at 2 samples where 2.0 gives -9.4%.
};

struct Renderer {
    int width = 1280, height = 720;      // actual window size (final composite target)
    int renderW = 1280, renderH = 720;   // internal supersampled scene resolution
    GLuint progChunk = 0, progSky = 0, progWater = 0, progPart = 0, progModel = 0;
    GLuint progBright = 0, progBlur = 0, progComposite = 0, progUI = 0;
    GLuint progAccum = 0, progDenoise = 0;
    GLuint denoiseFBO[2] = {0, 0}, denoiseTex[2] = {0, 0};
    // fullscreen quad
    GLuint fsVAO = 0, fsVBO = 0;
    // water quad
    GLuint waterVAO = 0, waterVBO = 0, waterTex = 0;
    int waterVerts = 0, waterTexW = 0, waterTexH = 0;
    // particles
    GLuint partVAO = 0, partQuadVBO = 0, partInstVBO = 0;
    // UI
    GLuint uiVAO = 0, uiQuadVBO = 0, uiInstVBO = 0;
    std::vector<UIInst> uiBatch;
    // 3D occupancy textures: fine (1 voxel), mid (2^3 max-downsample), coarse (8^3 max-downsample)
    GLuint occTex = 0, occMidTex = 0, occCoarseTex = 0;
    // HDR pipeline
    GLuint sceneFBO = 0, sceneColor = 0, sceneDepth = 0, sceneGeom = 0;
    GLuint bloomFBO[2] = {0, 0}, bloomTex[2] = {0, 0};
    int bloomW = 0, bloomH = 0;
    // model mesh pool (viewmodel + players built per frame or cached)
    GLuint modelVAO = 0, modelVBO = 0;
    std::vector<ModelVert> modelVerts;

    RenderSettings settings;
    std::vector<DynLight> lights;
    float time = 0;

    // per-frame camera
    vec3 camPos, camFwd, camRight, camUp;
    mat4 viewProj;

    // ---------------------------------------------------------------- temporal accumulation
    //
    // The AO and reflection rays pick their directions from hash13(vWorld) — a hash of the
    // *world position*. That makes the dither pattern fixed in space: it is identical in
    // every frame, so averaging frames together gains exactly nothing and a temporal filter
    // has nothing to work with. Two to four samples per pixel is all the image ever gets,
    // and the shortfall shows up as the permanent stippled grain across every shaded face.
    //
    // Mixing a frame counter into the hash makes each frame an independent estimate, which
    // is what lets a running mean converge. Same total ray cost per frame; the difference is
    // whether the samples are the same four every time or four new ones.
    //
    // Two float buffers, ping-ponged, because the running mean has to be read and written in
    // the same pass. Float rather than half: the blend weight is 1/(n+1), and by a couple of
    // hundred samples half-float cannot represent the increment any more, so the image would
    // quietly stop converging rather than fail.
    GLuint accumFBO[2] = {0, 0}, accumTex[2] = {0, 0};
    int accumIdx = 0;
    int accumSamples = 0;
    unsigned frameIndex = 0;
    // What the accumulator was looking at last frame. Any change means the history describes
    // a different picture and has to be thrown away.
    vec3 lastCamPos = vec3(1e9f, 1e9f, 1e9f);
    vec3 lastCamFwd = vec3(0, 0, 0);
    unsigned lastWorldRev = ~0u;

    /** Halton, for the sub-pixel jitter that turns accumulation into antialiasing too. */
    static float halton(int i, int b) {
        float f = 1, r = 0;
        while (i > 0) { f /= b; r += f * (i % b); i /= b; }
        return r;
    }
    void resetAccumulation() { accumSamples = 0; }

    bool init(int w, int h) {
        width = w; height = h;
        if (!glapi_load()) return false;
        progChunk = linkProgram(VS_CHUNK, fsChunk().c_str(), "chunk");
        progSky = linkProgram(VS_FULLSCREEN, fsSky().c_str(), "sky");
        progWater = linkProgram(VS_WATER, fsWater().c_str(), "water");
        progPart = linkProgram(VS_PART, FS_PART, "particles");
        progModel = linkProgram(VS_MODEL, FS_MODEL, "model");
        progBright = linkProgram(VS_FULLSCREEN, FS_BRIGHT, "bright");
        progBlur = linkProgram(VS_FULLSCREEN, FS_BLUR, "blur");
        progComposite = linkProgram(VS_FULLSCREEN, FS_COMPOSITE, "composite");
        progAccum = linkProgram(VS_FULLSCREEN, FS_ACCUM, "accum");
        progDenoise = linkProgram(VS_FULLSCREEN, FS_DENOISE, "denoise");
        progUI = linkProgram(VS_UI, FS_UI, "ui");

        // fullscreen triangle-pair
        float fsq[] = {-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1};
        glGenVertexArrays(1, &fsVAO);
        glBindVertexArray(fsVAO);
        glGenBuffers(1, &fsVBO);
        glBindBuffer(GL_ARRAY_BUFFER, fsVBO);
        glBufferData(GL_ARRAY_BUFFER, sizeof fsq, fsq, GL_STATIC_DRAW);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 8, (void*)0);

        // Water surface: a tessellated grid, not two triangles.
        //
        // The surface is displaced per-vertex by the simulation now, so it needs vertices to
        // displace. Over the map it is stepped at half the simulation cell so a wave is
        // resolved rather than aliased; beyond the map edge it becomes a coarse skirt out to
        // the horizon, since open sea only ever needs to be flat and blue.
        {
            const float mapX = WX * VOXEL_SIZE, mapZ = WZ * VOXEL_SIZE;
            const float step = 0.12f;   // ~5x the simulation resolution; cost is not the constraint here
            const int gx = (int)(mapX / step), gz = (int)(mapZ / step);
            std::vector<float> wq;
            wq.reserve((size_t)gx * gz * 12 + 64);
            auto quad = [&](float x0, float z0, float x1, float z1) {
                float v[12] = {x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1};
                wq.insert(wq.end(), v, v + 12);
            };
            for (int z = 0; z < gz; z++)
                for (int x = 0; x < gx; x++)
                    quad(x * step, z * step, (x + 1) * step, (z + 1) * step);
            // skirt: four big quads filling out to the horizon around the simulated patch
            const float R = 1500.f;
            quad(-R, -R, mapX + R, 0);
            quad(-R, mapZ, mapX + R, mapZ + R);
            quad(-R, 0, 0, mapZ);
            quad(mapX, 0, mapX + R, mapZ);
            waterVerts = (int)(wq.size() / 2);
            glGenVertexArrays(1, &waterVAO);
            glBindVertexArray(waterVAO);
            glGenBuffers(1, &waterVBO);
            glBindBuffer(GL_ARRAY_BUFFER, waterVBO);
            glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(wq.size() * sizeof(float)), wq.data(), GL_STATIC_DRAW);
            glEnableVertexAttribArray(0);
            glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 8, (void*)0);
        }

        // particle instancing
        {
            float corners[] = {-0.5f, -0.5f, 0.5f, -0.5f, 0.5f, 0.5f, -0.5f, -0.5f, 0.5f, 0.5f, -0.5f, 0.5f};
            glGenVertexArrays(1, &partVAO);
            glBindVertexArray(partVAO);
            glGenBuffers(1, &partQuadVBO);
            glBindBuffer(GL_ARRAY_BUFFER, partQuadVBO);
            glBufferData(GL_ARRAY_BUFFER, sizeof corners, corners, GL_STATIC_DRAW);
            glEnableVertexAttribArray(0);
            glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 8, (void*)0);
            glGenBuffers(1, &partInstVBO);
            glBindBuffer(GL_ARRAY_BUFFER, partInstVBO);
            for (int i = 1; i <= 3; i++) {
                glEnableVertexAttribArray(i);
                glVertexAttribPointer(i, 4, GL_FLOAT, GL_FALSE, sizeof(PartInst), (void*)(size_t)((i - 1) * 16));
                glVertexAttribDivisor(i, 1);
            }
        }

        // UI instancing
        {
            float corners[] = {-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1};
            glGenVertexArrays(1, &uiVAO);
            glBindVertexArray(uiVAO);
            glGenBuffers(1, &uiQuadVBO);
            glBindBuffer(GL_ARRAY_BUFFER, uiQuadVBO);
            glBufferData(GL_ARRAY_BUFFER, sizeof corners, corners, GL_STATIC_DRAW);
            glEnableVertexAttribArray(0);
            glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 8, (void*)0);
            glGenBuffers(1, &uiInstVBO);
            glBindBuffer(GL_ARRAY_BUFFER, uiInstVBO);
            glEnableVertexAttribArray(1);
            glVertexAttribPointer(1, 4, GL_FLOAT, GL_FALSE, sizeof(UIInst), (void*)0);
            glVertexAttribDivisor(1, 1);
            glEnableVertexAttribArray(2);
            glVertexAttribPointer(2, 4, GL_FLOAT, GL_FALSE, sizeof(UIInst), (void*)16);
            glVertexAttribDivisor(2, 1);
            glEnableVertexAttribArray(3);
            glVertexAttribPointer(3, 1, GL_FLOAT, GL_FALSE, sizeof(UIInst), (void*)32);
            glVertexAttribDivisor(3, 1);
        }

        // model mesh (dynamic)
        glGenVertexArrays(1, &modelVAO);
        glBindVertexArray(modelVAO);
        glGenBuffers(1, &modelVBO);
        glBindBuffer(GL_ARRAY_BUFFER, modelVBO);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(ModelVert), (void*)0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, sizeof(ModelVert), (void*)12);
        glEnableVertexAttribArray(2);
        glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(ModelVert), (void*)24);
        glBindVertexArray(0);

        // occupancy textures
        glGenTextures(1, &occTex);
        glBindTexture(GL_TEXTURE_3D, occTex);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_R, GL_CLAMP_TO_EDGE);
        glGenTextures(1, &occMidTex);
        glBindTexture(GL_TEXTURE_3D, occMidTex);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_R, GL_CLAMP_TO_EDGE);
        glGenTextures(1, &occCoarseTex);
        glBindTexture(GL_TEXTURE_3D, occCoarseTex);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_R, GL_CLAMP_TO_EDGE);

        createTargets();
        lastRenderScale = settings.renderScale;
        glEnable(GL_DEPTH_TEST);
        glDepthFunc(GL_LEQUAL);
        glEnable(GL_CULL_FACE);
        glCullFace(GL_BACK);
        glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
        return true;
    }

    void createTargets() {
        auto makeTex2D = [&](GLuint& t, int w, int h, GLint ifmt, GLenum fmt, GLenum type) {
            if (t) glDeleteTextures(1, &t);
            glGenTextures(1, &t);
            glBindTexture(GL_TEXTURE_2D, t);
            glTexImage2D(GL_TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, nullptr);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        };
        renderW = std::max(8, (int)(width * settings.renderScale));
        renderH = std::max(8, (int)(height * settings.renderScale));
        if (sceneFBO) { glDeleteFramebuffers(1, &sceneFBO); sceneFBO = 0; }
        makeTex2D(sceneColor, renderW, renderH, GL_RGBA16F, GL_RGBA, GL_FLOAT);
        makeTex2D(sceneGeom, renderW, renderH, GL_RGBA16F, GL_RGBA, GL_FLOAT);
        makeTex2D(sceneDepth, renderW, renderH, GL_DEPTH_COMPONENT24, GL_DEPTH_COMPONENT, GL_UNSIGNED_INT);
        glGenFramebuffers(1, &sceneFBO);
        glBindFramebuffer(GL_FRAMEBUFFER, sceneFBO);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sceneColor, 0);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT1, GL_TEXTURE_2D, sceneGeom, 0);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, sceneDepth, 0);
        for (int i = 0; i < 2; i++) {
            if (accumFBO[i]) { glDeleteFramebuffers(1, &accumFBO[i]); accumFBO[i] = 0; }
            makeTex2D(accumTex[i], renderW, renderH, GL_RGBA32F, GL_RGBA, GL_FLOAT);
            glGenFramebuffers(1, &accumFBO[i]);
            glBindFramebuffer(GL_FRAMEBUFFER, accumFBO[i]);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, accumTex[i], 0);
        }
        for (int i = 0; i < 2; i++) {
            if (denoiseFBO[i]) { glDeleteFramebuffers(1, &denoiseFBO[i]); denoiseFBO[i] = 0; }
            makeTex2D(denoiseTex[i], renderW, renderH, GL_RGBA32F, GL_RGBA, GL_FLOAT);
            glGenFramebuffers(1, &denoiseFBO[i]);
            glBindFramebuffer(GL_FRAMEBUFFER, denoiseFBO[i]);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, denoiseTex[i], 0);
        }
        resetAccumulation();
        bloomW = renderW / 2; bloomH = renderH / 2;
        if (bloomW < 1) bloomW = 1;
        if (bloomH < 1) bloomH = 1;
        for (int i = 0; i < 2; i++) {
            if (bloomFBO[i]) { glDeleteFramebuffers(1, &bloomFBO[i]); bloomFBO[i] = 0; }
            makeTex2D(bloomTex[i], bloomW, bloomH, GL_RGBA16F, GL_RGBA, GL_FLOAT);
            glGenFramebuffers(1, &bloomFBO[i]);
            glBindFramebuffer(GL_FRAMEBUFFER, bloomFBO[i]);
            glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, bloomTex[i], 0);
        }
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }

    float lastRenderScale = -1.f;
    void resize(int w, int h) {
        bool scaleChanged = settings.renderScale != lastRenderScale;
        if (w == width && h == height && !scaleChanged) return;
        if (w < 8 || h < 8) return;
        width = w; height = h;
        lastRenderScale = settings.renderScale;
        createTargets();
    }

    // ---------------- 3D occupancy upload
    // Texture layout convention: (s,t,r) = (x,y,z); GL data must therefore be
    // ordered x fastest, then y, then z (our vox array is x, z, y — transpose on upload).
    // Two downsample levels are maintained (mid = 2^3 max, coarse = 8^3 max), matching the
    // 3-level mip hierarchy the trace shader walks for empty-space skipping.
    static void buildDownsample(const World& w, int factor, std::vector<uint8_t>& out, int& ox, int& oy, int& oz) {
        ox = WX / factor; oy = WY / factor; oz = WZ / factor;
        out.assign((size_t)ox * oy * oz, 0);
        for (int y = 0; y < WY; y++)
            for (int z = 0; z < WZ; z++)
                for (int x = 0; x < WX; x++)
                    if (w.vox[World::vidx(x, y, z)])
                        out[((size_t)(z / factor) * oy + y / factor) * ox + x / factor] = 255;
    }
    void uploadFullOccupancy(const World& w) {
        static std::vector<uint8_t> occ;
        occ.assign((size_t)WX * WY * WZ, 0);
        for (int z = 0; z < WZ; z++)
            for (int y = 0; y < WY; y++) {
                const uint8_t* src = &w.vox[World::vidx(0, y, z)];
                uint8_t* dst = &occ[((size_t)z * WY + y) * WX];
                for (int x = 0; x < WX; x++) dst[x] = src[x] ? 255 : 0;
            }
        glBindTexture(GL_TEXTURE_3D, occTex);
        glTexImage3D(GL_TEXTURE_3D, 0, GL_R8, WX, WY, WZ, 0, GL_RED, GL_UNSIGNED_BYTE, occ.data());

        static std::vector<uint8_t> mid;
        int mx, my, mz;
        buildDownsample(w, 2, mid, mx, my, mz);
        glBindTexture(GL_TEXTURE_3D, occMidTex);
        glTexImage3D(GL_TEXTURE_3D, 0, GL_R8, mx, my, mz, 0, GL_RED, GL_UNSIGNED_BYTE, mid.data());

        static std::vector<uint8_t> coarse;
        int cx, cy, cz;
        buildDownsample(w, 8, coarse, cx, cy, cz);
        glBindTexture(GL_TEXTURE_3D, occCoarseTex);
        glTexImage3D(GL_TEXTURE_3D, 0, GL_R8, cx, cy, cz, 0, GL_RED, GL_UNSIGNED_BYTE, coarse.data());
    }

    // recompute the downsampled cells covering [r.x0..r.x1]x[...] at the given factor and
    // sub-upload them into 'tex'
    static void resubDownsample(const World& w, int factor, GLuint tex, const DirtyRegion& r, std::vector<uint8_t>& buf) {
        int dimY = WY / factor, dimZ = WZ / factor;
        int cx0 = r.x0 / factor, cx1 = r.x1 / factor;
        int cy0 = r.y0 / factor, cy1 = r.y1 / factor;
        int cz0 = r.z0 / factor, cz1 = r.z1 / factor;
        int cnx = cx1 - cx0 + 1, cny = cy1 - cy0 + 1, cnz = cz1 - cz0 + 1;
        buf.assign((size_t)cnx * cny * cnz, 0);
        for (int cz = cz0; cz <= cz1; cz++)
            for (int cy = cy0; cy <= cy1; cy++)
                for (int cx = cx0; cx <= cx1; cx++) {
                    uint8_t v = 0;
                    for (int yy = cy * factor; yy < cy * factor + factor && yy < WY && !v; yy++)
                        for (int zz = cz * factor; zz < cz * factor + factor && zz < WZ && !v; zz++)
                            for (int xx = cx * factor; xx < cx * factor + factor && xx < WX; xx++)
                                if (w.vox[World::vidx(xx, yy, zz)]) { v = 255; break; }
                    buf[((size_t)(cz - cz0) * cny + (cy - cy0)) * cnx + (cx - cx0)] = v;
                }
        glBindTexture(GL_TEXTURE_3D, tex);
        glTexSubImage3D(GL_TEXTURE_3D, 0, cx0, cy0, cz0, cnx, cny, cnz, GL_RED, GL_UNSIGNED_BYTE, buf.data());
        (void)dimY; (void)dimZ;
    }
    void uploadDirtyOccupancy(World& w) {
        if (w.texDirty.empty()) return;
        static std::vector<uint8_t> buf, mbuf, cbuf;
        for (const DirtyRegion& r : w.texDirty) {
            int nx = r.x1 - r.x0 + 1, ny = r.y1 - r.y0 + 1, nz = r.z1 - r.z0 + 1;
            buf.resize((size_t)nx * ny * nz);
            size_t o = 0;
            for (int z = r.z0; z <= r.z1; z++)
                for (int y = r.y0; y <= r.y1; y++)
                    for (int x = r.x0; x <= r.x1; x++)
                        buf[o++] = w.vox[World::vidx(x, y, z)] ? 255 : 0;
            glBindTexture(GL_TEXTURE_3D, occTex);
            glTexSubImage3D(GL_TEXTURE_3D, 0, r.x0, r.y0, r.z0, nx, ny, nz, GL_RED, GL_UNSIGNED_BYTE, buf.data());
            resubDownsample(w, 2, occMidTex, r, mbuf);
            resubDownsample(w, 8, occCoarseTex, r, cbuf);
        }
        w.texDirty.clear();
    }

    // ---------------- chunk GPU upload
    void uploadChunk(ChunkMesh& c) {
        if (!c.vao) {
            glGenVertexArrays(1, &c.vao);
            glBindVertexArray(c.vao);
            glGenBuffers(1, &c.vbo);
            glGenBuffers(1, &c.ibo);
            glBindBuffer(GL_ARRAY_BUFFER, c.vbo);
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, c.ibo);
            glEnableVertexAttribArray(0);
            glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void*)0);
            glEnableVertexAttribArray(1);
            glVertexAttribPointer(1, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)12);
            glEnableVertexAttribArray(2);
            glVertexAttribPointer(2, 1, GL_UNSIGNED_BYTE, GL_FALSE, sizeof(Vertex), (void*)16);
            glEnableVertexAttribArray(3);
            glVertexAttribPointer(3, 1, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)17);
            glEnableVertexAttribArray(4);
            glVertexAttribPointer(4, 1, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)18);
            glEnableVertexAttribArray(5);
            glVertexAttribPointer(5, 1, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)19);
        } else glBindVertexArray(c.vao);
        glBindBuffer(GL_ARRAY_BUFFER, c.vbo);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(c.verts.size() * sizeof(Vertex)),
                     c.verts.empty() ? nullptr : c.verts.data(), GL_DYNAMIC_DRAW);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, c.ibo);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)(c.idx.size() * sizeof(uint32_t)),
                     c.idx.empty() ? nullptr : c.idx.data(), GL_DYNAMIC_DRAW);
        c.indexCount = (uint32_t)c.idx.size();
        c.gpuDirty = false;
        glBindVertexArray(0);
    }

    void uploadClusterMesh(FallingCluster& fc) {
        glGenVertexArrays(1, &fc.vao);
        glBindVertexArray(fc.vao);
        glGenBuffers(1, &fc.vbo);
        glGenBuffers(1, &fc.ibo);
        glBindBuffer(GL_ARRAY_BUFFER, fc.vbo);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(fc.verts.size() * sizeof(Vertex)), fc.verts.data(), GL_STATIC_DRAW);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, fc.ibo);
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)(fc.idx.size() * sizeof(uint32_t)), fc.idx.data(), GL_STATIC_DRAW);
        glEnableVertexAttribArray(0);
        glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void*)0);
        glEnableVertexAttribArray(1);
        glVertexAttribPointer(1, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)12);
        glEnableVertexAttribArray(2);
        glVertexAttribPointer(2, 1, GL_UNSIGNED_BYTE, GL_FALSE, sizeof(Vertex), (void*)16);
        glEnableVertexAttribArray(3);
        glVertexAttribPointer(3, 1, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)17);
        glEnableVertexAttribArray(4);
        glVertexAttribPointer(4, 1, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)18);
        glEnableVertexAttribArray(5);
        glVertexAttribPointer(5, 1, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void*)19);
        glBindVertexArray(0);
        fc.gpuReady = true;
    }
    void destroyClusterMesh(FallingCluster& fc) {
        if (fc.vao) { glDeleteVertexArrays(1, &fc.vao); fc.vao = 0; }
        if (fc.vbo) { glDeleteBuffers(1, &fc.vbo); fc.vbo = 0; }
        if (fc.ibo) { glDeleteBuffers(1, &fc.ibo); fc.ibo = 0; }
        fc.gpuReady = false;
    }

    // ---------------- frame
    void setCamera(vec3 pos, float yaw, float pitch, float shakeAmp, float shakeT) {
        camPos = pos;
        // screen shake
        float sy = yaw + shakeAmp * 0.02f * sinf(shakeT * 37.f);
        float sp = pitch + shakeAmp * 0.018f * sinf(shakeT * 43.f + 1.7f);
        camFwd = vec3(sinf(sy) * cosf(sp), sinf(sp), cosf(sy) * cosf(sp));
        camRight = vnorm(vcross(camFwd, vec3(0, 1, 0)));
        camUp = vcross(camRight, camFwd);
        float aspect = (float)width / (float)height;
        mat4 proj = mat4_perspective(settings.fov * 3.14159265f / 180.f, aspect, 0.08f, 900.f);

        // Any camera movement invalidates the history: the accumulator holds a mean of what
        // was in front of each pixel, and moving puts something else there. Compared with a
        // tolerance rather than exactly, because a stationary player still produces tiny
        // float drift in the view matrix and an exact test would reset every single frame.
        vec3 dp = camPos - lastCamPos, df = camFwd - lastCamFwd;
        if (vdot(dp, dp) > 1e-8f || vdot(df, df) > 1e-10f) resetAccumulation();
        lastCamPos = camPos;
        lastCamFwd = camFwd;

        // Sub-pixel jitter, applied only while accumulating. The same averaging that
        // resolves the ray noise also resolves geometry edges, so antialiasing comes free
        // with convergence rather than needing a separate pass.
        if (settings.accumulate) {
            float jx = (halton(accumSamples + 1, 2) - 0.5f) * 2.0f / (float)renderW;
            float jy = (halton(accumSamples + 1, 3) - 0.5f) * 2.0f / (float)renderH;
            proj.m[8] += jx;
            proj.m[9] += jy;
        }
        mat4 view = mat4_lookat(camPos, camPos + camFwd, vec3(0, 1, 0));
        viewProj = proj * view;
    }

    void setSceneUniforms(GLuint prog, const MapInfo& mi) {
        // Constant when not accumulating, so the fixed-dither look is preserved exactly for
        // anyone who turns convergence off — otherwise the grain would crawl every frame,
        // which is worse than grain that sits still.
        glUniform1f(glGetUniformLocation(prog, "uSampleSeed"),
                    settings.accumulate ? (float)(accumSamples % 4096) : 0.0f);
        glUniformMatrix4fv(glGetUniformLocation(prog, "uViewProj"), 1, GL_FALSE, viewProj.m);
        glUniform3f(glGetUniformLocation(prog, "uCamPos"), camPos.x, camPos.y, camPos.z);
        glUniform3f(glGetUniformLocation(prog, "uSunDir"), mi.sunDir.x, mi.sunDir.y, mi.sunDir.z);
        glUniform3f(glGetUniformLocation(prog, "uSunColor"), mi.sunColor.x, mi.sunColor.y, mi.sunColor.z);
        glUniform3f(glGetUniformLocation(prog, "uSkyHorizon"), mi.skyHorizon.x, mi.skyHorizon.y, mi.skyHorizon.z);
        glUniform3f(glGetUniformLocation(prog, "uSkyZenith"), mi.skyZenith.x, mi.skyZenith.y, mi.skyZenith.z);
        glUniform1f(glGetUniformLocation(prog, "uTime"), time);
        glUniform1i(glGetUniformLocation(prog, "uSkyStyle"), mi.skyStyle);
        glUniform3f(glGetUniformLocation(prog, "uFogColor"), mi.skyHorizon.x, mi.skyHorizon.y, mi.skyHorizon.z);
        glUniform1f(glGetUniformLocation(prog, "uFogDensity"), mi.fogDensity);
    }

    // Attachment 1 carries surface normal + view depth for the cleanup filter, and only the
    // chunk pass writes it. Everything else — sky, water, particles, viewmodels — renders
    // with just attachment 0 bound, so those pixels keep a zero here and the filter reads
    // that as "no voxel surface, leave alone" rather than filtering them against geometry
    // that belongs to whatever is behind them.
    static void drawTo(bool withGeom) {
        const GLenum both[2] = { GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT1 };
        glDrawBuffers(withGeom ? 2 : 1, both);
    }

    void beginScene(const MapInfo& mi) {
        glBindFramebuffer(GL_FRAMEBUFFER, sceneFBO);
        drawTo(true);
        glViewport(0, 0, renderW, renderH);
        glClearColor(mi.skyHorizon.x, mi.skyHorizon.y, mi.skyHorizon.z, 1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    }

    void drawSky(const MapInfo& mi) {
        drawTo(false);
        glDisable(GL_CULL_FACE);
        glDepthMask(GL_FALSE);
        glUseProgram(progSky);
        setSceneUniforms(progSky, mi);
        glUniform3f(glGetUniformLocation(progSky, "uCamRight"), camRight.x, camRight.y, camRight.z);
        glUniform3f(glGetUniformLocation(progSky, "uCamUp"), camUp.x, camUp.y, camUp.z);
        glUniform3f(glGetUniformLocation(progSky, "uCamFwd"), camFwd.x, camFwd.y, camFwd.z);
        glUniform1f(glGetUniformLocation(progSky, "uTanHalfFov"), tanf(settings.fov * 0.5f * 3.14159265f / 180.f));
        glUniform1f(glGetUniformLocation(progSky, "uAspect"), (float)width / (float)height);
        glBindVertexArray(fsVAO);
        glDrawArrays(GL_TRIANGLES, 0, 6);
        glDepthMask(GL_TRUE);
        glEnable(GL_CULL_FACE);
    }

    /** Identity spin — the static world, and anything that has already landed. */
    void clearSpin(GLuint prog) {
        static const float I3[9] = {1,0,0, 0,1,0, 0,0,1};
        glUniformMatrix3fv(glGetUniformLocation(prog, "uSpin"), 1, GL_FALSE, I3);
        glUniform3f(glGetUniformLocation(prog, "uSpinCenter"), 0, 0, 0);
    }

    void beginChunks(const MapInfo& mi, float ambient) {
        drawTo(true);
        glUseProgram(progChunk);
        clearSpin(progChunk);
        setSceneUniforms(progChunk, mi);
        glUniform1f(glGetUniformLocation(progChunk, "uVoxelSize"), VOXEL_SIZE);
        glUniform1f(glGetUniformLocation(progChunk, "uAmbient"), ambient);
        glUniform1i(glGetUniformLocation(progChunk, "uShadowQuality"), settings.shadowQuality);
        glUniform1i(glGetUniformLocation(progChunk, "uAOQuality"), settings.aoQuality);
        glUniform3f(glGetUniformLocation(progChunk, "uWorldSize"), (float)WX, (float)WY, (float)WZ);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_3D, occTex);
        glUniform1i(glGetUniformLocation(progChunk, "uOcc"), 0);
        glActiveTexture(GL_TEXTURE0 + 1);
        glBindTexture(GL_TEXTURE_3D, occMidTex);
        glUniform1i(glGetUniformLocation(progChunk, "uOccMid"), 1);
        glActiveTexture(GL_TEXTURE0 + 2);
        glBindTexture(GL_TEXTURE_3D, occCoarseTex);
        glUniform1i(glGetUniformLocation(progChunk, "uOccCoarse"), 2);
        // dynamic lights
        int n = (int)lights.size();
        if (n > 16) n = 16;
        glUniform1i(glGetUniformLocation(progChunk, "uNumLights"), n);
        float posr[16 * 4], col[16 * 3];
        for (int i = 0; i < n; i++) {
            posr[i * 4 + 0] = lights[i].pos.x; posr[i * 4 + 1] = lights[i].pos.y;
            posr[i * 4 + 2] = lights[i].pos.z; posr[i * 4 + 3] = lights[i].radius;
            col[i * 3 + 0] = lights[i].color.x; col[i * 3 + 1] = lights[i].color.y; col[i * 3 + 2] = lights[i].color.z;
        }
        if (n) {
            glUniform4fv(glGetUniformLocation(progChunk, "uLightPosR"), n, posr);
            glUniform3fv(glGetUniformLocation(progChunk, "uLightCol"), n, col);
        }
    }

    void drawChunks(World& w) {
        glUniform3f(glGetUniformLocation(progChunk, "uOffset"), 0, 0, 0);
        for (auto& c : w.chunks) {
            if (c.gpuDirty) uploadChunk(c);
            if (!c.vao || c.indexCount == 0) continue;
            glBindVertexArray(c.vao);
            glDrawElements(GL_TRIANGLES, (GLsizei)c.indexCount, GL_UNSIGNED_INT, nullptr);
        }
        // falling clusters (dynamic bodies: full 3D offset from the physics sim).
        // a mid-flight shatter re-meshes the cluster: free the stale GPU buffers first.
        for (auto& fc : w.clusters) {
            if (!fc.gpuReady && fc.vao) destroyClusterMesh(fc);
            if (!fc.gpuReady) uploadClusterMesh(fc);
            if (fc.indexCount == 0) continue;
            glUniform3f(glGetUniformLocation(progChunk, "uOffset"), fc.offset.x, fc.offset.y, fc.offset.z);
            if (fc.spinning) {
                float m[9];
                quat_to_mat3(fc.rot, m);
                glUniformMatrix3fv(glGetUniformLocation(progChunk, "uSpin"), 1, GL_FALSE, m);
                glUniform3f(glGetUniformLocation(progChunk, "uSpinCenter"), fc.center.x, fc.center.y, fc.center.z);
            } else {
                clearSpin(progChunk);
            }
            glBindVertexArray(fc.vao);
            glDrawElements(GL_TRIANGLES, (GLsizei)fc.indexCount, GL_UNSIGNED_INT, nullptr);
        }
        clearSpin(progChunk);
        glUniform3f(glGetUniformLocation(progChunk, "uOffset"), 0, 0, 0);
        glBindVertexArray(0);
    }

    /** Hand the simulation's packed field to the GPU. Called once per frame while it runs. */
    void uploadWaterField(const float* rgba, int w, int h) {
        if (!waterTex) {
            glGenTextures(1, &waterTex);
            glBindTexture(GL_TEXTURE_2D, waterTex);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            waterTexW = 0;
        }
        glBindTexture(GL_TEXTURE_2D, waterTex);
        if (w != waterTexW || h != waterTexH) {
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, w, h, 0, GL_RGBA, GL_FLOAT, rgba);
            waterTexW = w; waterTexH = h;
        } else {
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, w, h, 0, GL_RGBA, GL_FLOAT, rgba);
        }
    }

    void drawWater(const MapInfo& mi) {
        drawTo(false);
        if (!mi.hasWater) return;
        glUseProgram(progWater);
        setSceneUniforms(progWater, mi);
        glUniform1f(glGetUniformLocation(progWater, "uWaterLevel"), mi.waterLevel);
        glUniform3f(glGetUniformLocation(progWater, "uWaterColor"), mi.waterColor.x, mi.waterColor.y, mi.waterColor.z);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, waterTex);
        glUniform1i(glGetUniformLocation(progWater, "uWater"), 0);
        glUniform2f(glGetUniformLocation(progWater, "uWaterOrigin"), 0.f, 0.f);
        glUniform2f(glGetUniformLocation(progWater, "uWaterSize"), WX * VOXEL_SIZE, WZ * VOXEL_SIZE);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        glDisable(GL_CULL_FACE);
        // Depth-write off: the surface is transparent, and writing depth from it made the
        // far half of the sea occlude the near half wherever a wave crossed in front.
        glDepthMask(GL_FALSE);
        glBindVertexArray(waterVAO);
        glDrawArrays(GL_TRIANGLES, 0, waterVerts);
        glDepthMask(GL_TRUE);
        glEnable(GL_CULL_FACE);
        glDisable(GL_BLEND);
    }

    void drawParticles(const std::vector<PartInst>& alpha, const std::vector<PartInst>& additive) {
        drawTo(false);
        if (alpha.empty() && additive.empty()) return;
        glUseProgram(progPart);
        glUniformMatrix4fv(glGetUniformLocation(progPart, "uViewProj"), 1, GL_FALSE, viewProj.m);
        glUniform3f(glGetUniformLocation(progPart, "uCamRight"), camRight.x, camRight.y, camRight.z);
        glUniform3f(glGetUniformLocation(progPart, "uCamUp"), camUp.x, camUp.y, camUp.z);
        glBindVertexArray(partVAO);
        glEnable(GL_BLEND);
        glDepthMask(GL_FALSE);
        if (!alpha.empty()) {
            glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
            glBindBuffer(GL_ARRAY_BUFFER, partInstVBO);
            glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(alpha.size() * sizeof(PartInst)), alpha.data(), GL_STREAM_DRAW);
            glDrawArraysInstanced(GL_TRIANGLES, 0, 6, (GLsizei)alpha.size());
        }
        if (!additive.empty()) {
            glBlendFunc(GL_SRC_ALPHA, GL_ONE);
            glBindBuffer(GL_ARRAY_BUFFER, partInstVBO);
            glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(additive.size() * sizeof(PartInst)), additive.data(), GL_STREAM_DRAW);
            glDrawArraysInstanced(GL_TRIANGLES, 0, 6, (GLsizei)additive.size());
        }
        glDepthMask(GL_TRUE);
        glDisable(GL_BLEND);
        glBindVertexArray(0);
    }

    // ---------------- model drawing (viewmodel / remote players)
    void modelBegin() { modelVerts.clear(); }
    void modelBox(vec3 c, vec3 h, uint8_t r, uint8_t g, uint8_t b, uint8_t emis = 0) {
        // 6 faces, 2 tris each
        static const int F[6][4][3] = {
            {{1,-1,1},{1,-1,-1},{1,1,-1},{1,1,1}}, {{-1,-1,-1},{-1,-1,1},{-1,1,1},{-1,1,-1}},
            {{-1,1,1},{1,1,1},{1,1,-1},{-1,1,-1}}, {{-1,-1,-1},{1,-1,-1},{1,-1,1},{-1,-1,1}},
            {{-1,-1,1},{1,-1,1},{1,1,1},{-1,1,1}}, {{1,-1,-1},{-1,-1,-1},{-1,1,-1},{1,1,-1}},
        };
        static const float N[6][3] = {{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
        for (int f = 0; f < 6; f++) {
            ModelVert v[4];
            for (int i = 0; i < 4; i++) {
                v[i].x = c.x + F[f][i][0] * h.x;
                v[i].y = c.y + F[f][i][1] * h.y;
                v[i].z = c.z + F[f][i][2] * h.z;
                v[i].nx = N[f][0]; v[i].ny = N[f][1]; v[i].nz = N[f][2];
                v[i].r = r; v[i].g = g; v[i].b = b; v[i].a = emis;
            }
            modelVerts.push_back(v[0]); modelVerts.push_back(v[1]); modelVerts.push_back(v[2]);
            modelVerts.push_back(v[2]); modelVerts.push_back(v[3]); modelVerts.push_back(v[0]);
        }
    }
    void modelDraw(const mat4& model, const MapInfo& mi, float ambient) {
        drawTo(false);
        if (modelVerts.empty()) return;
        glUseProgram(progModel);
        glUniformMatrix4fv(glGetUniformLocation(progModel, "uViewProj"), 1, GL_FALSE, viewProj.m);
        glUniformMatrix4fv(glGetUniformLocation(progModel, "uModel"), 1, GL_FALSE, model.m);
        glUniform3f(glGetUniformLocation(progModel, "uSunDirM"), mi.sunDir.x, mi.sunDir.y, mi.sunDir.z);
        glUniform3f(glGetUniformLocation(progModel, "uSunColorM"), mi.sunColor.x, mi.sunColor.y, mi.sunColor.z);
        glUniform1f(glGetUniformLocation(progModel, "uAmbientM"), ambient);
        glBindVertexArray(modelVAO);
        glBindBuffer(GL_ARRAY_BUFFER, modelVBO);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(modelVerts.size() * sizeof(ModelVert)), modelVerts.data(), GL_STREAM_DRAW);
        glDrawArrays(GL_TRIANGLES, 0, (GLsizei)modelVerts.size());
        glBindVertexArray(0);
    }

    // ---------------- post processing to backbuffer
    void endScene() {
        glDisable(GL_DEPTH_TEST);
        glBindVertexArray(fsVAO);

        // ---- temporal accumulation
        //
        // Everything downstream reads `lit` rather than sceneColor directly, so with
        // accumulation off this is exactly the old pipeline and the bloom chain cannot tell
        // the difference.
        GLuint lit = sceneColor;
        if (settings.accumulate && accumSamples < settings.maxAccum) {
            int dst = 1 - accumIdx;
            glBindFramebuffer(GL_FRAMEBUFFER, accumFBO[dst]);
            glViewport(0, 0, renderW, renderH);
            glUseProgram(progAccum);
            glActiveTexture(GL_TEXTURE0);
            glBindTexture(GL_TEXTURE_2D, sceneColor);
            glUniform1i(glGetUniformLocation(progAccum, "uCur"), 0);
            glActiveTexture(GL_TEXTURE0 + 1);
            glBindTexture(GL_TEXTURE_2D, accumTex[accumIdx]);
            glUniform1i(glGetUniformLocation(progAccum, "uHist"), 1);
            // First frame after a reset takes the sample whole; there is no history to mix.
            glUniform1f(glGetUniformLocation(progAccum, "uBlend"),
                        accumSamples == 0 ? 1.0f : 1.0f / (float)(accumSamples + 1));
            glDrawArrays(GL_TRIANGLES, 0, 6);
            glActiveTexture(GL_TEXTURE0);
            accumIdx = dst;
            accumSamples++;
        }
        if (settings.accumulate && accumSamples > 0) lit = accumTex[accumIdx];

        // ---- variance-guided cleanup
        //
        // Only while the history is thin. A settled frame gets essentially nothing from the
        // filter — the weights have already collapsed to identity because the variance is
        // near zero — so past denoiseUntil this is a fullscreen pass that costs real time to
        // return the image it was handed.
        if (settings.denoisePasses > 0 && accumSamples > 0 && accumSamples < settings.denoiseUntil) {
            // Fewer passes as the estimate firms up: a very noisy frame wants the full
            // 81x81 effective support, a nearly-settled one wants a light touch.
            int passes = settings.denoisePasses;
            if (accumSamples > 32) passes = 1;
            else if (accumSamples > 16) passes = 2;
            else if (accumSamples > 4) passes = 3;

            glUseProgram(progDenoise);
            glActiveTexture(GL_TEXTURE0 + 1);
            glBindTexture(GL_TEXTURE_2D, sceneGeom);
            glUniform1i(glGetUniformLocation(progDenoise, "uGeom"), 1);
            glUniform1i(glGetUniformLocation(progDenoise, "uColor"), 0);
            glUniform2f(glGetUniformLocation(progDenoise, "uTexel"), 1.f / renderW, 1.f / renderH);
            glUniform1f(glGetUniformLocation(progDenoise, "uSamples"), (float)accumSamples);
            glUniform1f(glGetUniformLocation(progDenoise, "uPhiL"), settings.denoisePhiL);
            glUniform1f(glGetUniformLocation(progDenoise, "uPhiN"), 24.f);
            glUniform1f(glGetUniformLocation(progDenoise, "uPhiD"), 6.f);
            glViewport(0, 0, renderW, renderH);
            for (int i = 0; i < passes; i++) {
                glBindFramebuffer(GL_FRAMEBUFFER, denoiseFBO[i & 1]);
                glActiveTexture(GL_TEXTURE0);
                glBindTexture(GL_TEXTURE_2D, lit);
                // Only the first pass reads the accumulator, whose alpha is a second
                // moment; every later pass is handed a variance and must not square it out
                // a second time.
                glUniform1f(glGetUniformLocation(progDenoise, "uM2"), i == 0 ? 1.f : 0.f);
                glUniform1f(glGetUniformLocation(progDenoise, "uStep"), (float)(1 << i));
                glDrawArrays(GL_TRIANGLES, 0, 6);
                lit = denoiseTex[i & 1];
            }
            glActiveTexture(GL_TEXTURE0);
        }

        // bright pass -> bloom[0]
        glBindFramebuffer(GL_FRAMEBUFFER, bloomFBO[0]);
        glViewport(0, 0, bloomW, bloomH);
        glUseProgram(progBright);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, lit);
        glUniform1i(glGetUniformLocation(progBright, "uTex"), 0);
        glBindVertexArray(fsVAO);
        glDrawArrays(GL_TRIANGLES, 0, 6);
        // blur x2
        glUseProgram(progBlur);
        glUniform1i(glGetUniformLocation(progBlur, "uTex"), 0);
        for (int i = 0; i < 2; i++) {
            glBindFramebuffer(GL_FRAMEBUFFER, bloomFBO[1]);
            glBindTexture(GL_TEXTURE_2D, bloomTex[0]);
            glUniform2f(glGetUniformLocation(progBlur, "uDir"), 1.f / bloomW, 0.f);
            glDrawArrays(GL_TRIANGLES, 0, 6);
            glBindFramebuffer(GL_FRAMEBUFFER, bloomFBO[0]);
            glBindTexture(GL_TEXTURE_2D, bloomTex[1]);
            glUniform2f(glGetUniformLocation(progBlur, "uDir"), 0.f, 1.f / bloomH);
            glDrawArrays(GL_TRIANGLES, 0, 6);
        }
        // composite to backbuffer
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        glViewport(0, 0, width, height);
        glUseProgram(progComposite);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, lit);
        glUniform1i(glGetUniformLocation(progComposite, "uScene"), 0);
        glActiveTexture(GL_TEXTURE0 + 1);
        glBindTexture(GL_TEXTURE_2D, bloomTex[0]);
        glUniform1i(glGetUniformLocation(progComposite, "uBloom"), 1);
        glUniform1f(glGetUniformLocation(progComposite, "uBloomStrength"), settings.bloom);
        glUniform1f(glGetUniformLocation(progComposite, "uVignette"), 0.35f);
        glBindVertexArray(fsVAO);
        glDrawArrays(GL_TRIANGLES, 0, 6);
        glEnable(GL_DEPTH_TEST);
    }

    // ---------------- UI batch
    void uiRect(float x, float y, float w, float h, float r, float g, float b, float a, float radius = 0) {
        uiBatch.push_back({x + w * 0.5f, y + h * 0.5f, w * 0.5f, h * 0.5f, r, g, b, a, radius});
    }
    // 5x7 font text; scale = pixel size of one font pixel
    void uiText(const char* s, float x, float y, float scale, float r, float g, float b, float a) {
        float cx = x;
        for (const char* c = s; *c; c++) {
            if (*c == '\n') { y += 9 * scale; cx = x; continue; }
            const uint8_t* gl_ = fontGlyph(*c);
            for (int row = 0; row < 7; row++)
                for (int col = 0; col < 5; col++)
                    if (gl_[row] & (1 << (4 - col)))
                        uiRect(cx + col * scale, y + row * scale, scale * 1.02f, scale * 1.02f, r, g, b, a, 0);
            cx += 6 * scale;
        }
    }
    float uiTextWidth(const char* s, float scale) {
        int n = 0;
        for (const char* c = s; *c; c++) n++;
        return n ? (n * 6 - 1) * scale : 0.f;
    }
    void uiTextCentered(const char* s, float cx, float y, float scale, float r, float g, float b, float a) {
        uiText(s, cx - uiTextWidth(s, scale) * 0.5f, y, scale, r, g, b, a);
    }
    void uiFlush() {
        if (uiBatch.empty()) return;
        glDisable(GL_DEPTH_TEST);
        glDisable(GL_CULL_FACE);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        glUseProgram(progUI);
        glUniform2f(glGetUniformLocation(progUI, "uScreen"), (float)width, (float)height);
        glBindVertexArray(uiVAO);
        glBindBuffer(GL_ARRAY_BUFFER, uiInstVBO);
        glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(uiBatch.size() * sizeof(UIInst)), uiBatch.data(), GL_STREAM_DRAW);
        glDrawArraysInstanced(GL_TRIANGLES, 0, 6, (GLsizei)uiBatch.size());
        glBindVertexArray(0);
        glDisable(GL_BLEND);
        glEnable(GL_CULL_FACE);
        glEnable(GL_DEPTH_TEST);
        uiBatch.clear();
    }
};
