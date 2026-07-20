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
static GLuint compileShader(GLenum type, const char* src, const char* tag) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[4096];
        glGetShaderInfoLog(s, sizeof log, nullptr, log);
        fprintf(stderr, "[shader] %s compile error:\n%s\n", tag, log);
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
        fprintf(stderr, "[shader] %s link error:\n%s\n", tag, log);
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

// voxel ray tracing against occupancy textures (fine + 8x coarse)
static const char* GLSL_TRACE_COMMON = R"(
uniform sampler3D uOcc;         // R8: 1 = solid (voxel resolution)
uniform sampler3D uOccCoarse;   // R8: 8x downsampled max
uniform vec3 uWorldSize;        // voxels

float occAt(ivec3 c) { return texelFetch(uOcc, c, 0).r; }

// returns 1.0 if ray (voxel space) reaches maxT unblocked, else 0
float traceRay(vec3 ro, vec3 rd, float maxT) {
    vec3 ard = abs(rd);
    rd += vec3(lessThan(ard, vec3(1e-5))) * 1e-5;
    vec3 invd = 1.0 / rd;
    vec3 sgn = step(vec3(0.0), rd);
    float t = 0.0;
    for (int i = 0; i < 160; i++) {
        vec3 p = ro + rd * t;
        if (p.y >= uWorldSize.y && rd.y > 0.0) return 1.0;
        if (p.y < 0.0 && rd.y < 0.0) return 0.0;
        if ((p.x < 0.0 && rd.x < 0.0) || (p.x >= uWorldSize.x && rd.x > 0.0)) return 1.0;
        if ((p.z < 0.0 && rd.z < 0.0) || (p.z >= uWorldSize.z && rd.z > 0.0)) return 1.0;
        bool inside = all(greaterThanEqual(p, vec3(0.0))) && all(lessThan(p, uWorldSize));
        if (inside) {
            ivec3 vc = ivec3(floor(p));
            ivec3 cc = vc >> 3;
            if (texelFetch(uOccCoarse, cc, 0).r < 0.001) {
                vec3 cellMin = vec3(cc << 3);
                vec3 tExit = (cellMin + sgn * 8.0 - ro) * invd;
                t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
            } else {
                if (occAt(vc) > 0.5) return 0.0;
                vec3 vMin = floor(p);
                vec3 tExit = (vMin + sgn - ro) * invd;
                t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
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

// short-range occlusion ray: returns visibility 0..1 with distance falloff
float aoRay(vec3 ro, vec3 rd, float maxT) {
    vec3 ard = abs(rd);
    rd += vec3(lessThan(ard, vec3(1e-5))) * 1e-5;
    vec3 invd = 1.0 / rd;
    vec3 sgn = step(vec3(0.0), rd);
    float t = 0.0;
    for (int i = 0; i < 8; i++) {
        vec3 p = ro + rd * t;
        if (any(lessThan(p, vec3(0.0))) || any(greaterThanEqual(p, uWorldSize))) return 1.0;
        if (occAt(ivec3(floor(p))) > 0.5) return clamp(t / maxT, 0.0, 1.0) * 0.6;
        vec3 tExit = (floor(p) + sgn - ro) * invd;
        t = min(min(tExit.x, tExit.y), tExit.z) + 0.002;
        if (t >= maxT) return 1.0;
    }
    return 1.0;
}

float hash13(vec3 p) {
    p = fract(p * 0.31831 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
)";

// ---------------------------------------------------------------- chunk shaders
static const char* VS_CHUNK = R"(#version 330 core
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;      // rgb + emissive/8
layout(location=2) in float aNormal;    // 0..5
layout(location=3) in float aAO;        // 0..1
uniform mat4 uViewProj;
uniform vec3 uOffset;                   // falling cluster offset (meters)
out vec3 vWorld;
out vec4 vColor;
out vec3 vNormal;
out float vAO;
const vec3 NRM[6] = vec3[6](vec3(1,0,0), vec3(-1,0,0), vec3(0,1,0), vec3(0,-1,0), vec3(0,0,1), vec3(0,0,-1));
void main() {
    vec3 wp = aPos + uOffset;
    vWorld = wp;
    vColor = aColor;
    vNormal = NRM[int(aNormal + 0.5)];
    vAO = aAO;
    gl_Position = uViewProj * vec4(wp, 1.0);
}
)";

static std::string fsChunk() {
    std::string s = R"(#version 330 core
in vec3 vWorld;
in vec4 vColor;
in vec3 vNormal;
in float vAO;
out vec4 FragColor;
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

    // ---- ray-traced AO (short rays in normal hemisphere) x baked vertex AO
    float ao = vAO;
    if (uAOQuality > 0) {
        vec3 T = normalize(abs(N.y) < 0.9 ? cross(N, vec3(0, 1, 0)) : vec3(1, 0, 0));
        vec3 B = cross(N, T);
        float h = hash13(vWorld * 53.1) * 6.2831;
        float cs = cos(h), sn = sin(h);
        vec3 T2 = T * cs + B * sn;
        vec3 B2 = -T * sn + B * cs;
        float rayAO = 0.0;
        int n = uAOQuality == 1 ? 2 : 4;
        for (int k = 0; k < 4; k++) {
            if (k >= n) break;
            float ang = (float(k) + 0.5) / float(n) * 6.2831;
            vec3 d = normalize(N * 1.1 + T2 * cos(ang) * 0.85 + B2 * sin(ang) * 0.85);
            rayAO += aoRay(vp, d, 9.0);
        }
        ao *= mix(1.0, rayAO / float(n), 0.75);
    }

    // ---- lighting
    float ndl = max(dot(N, toSun), 0.0);
    vec3 direct = uSunColor * ndl * sunVis;
    vec3 skyAmb = mix(uSkyHorizon, uSkyZenith, N.y * 0.5 + 0.5) * uAmbient * 1.6;
    vec3 bounce = uSunColor * 0.06 * max(dot(N, vec3(-toSun.x, 0.4, -toSun.z)), 0.0);
    vec3 light = direct + (skyAmb + bounce) * ao;

    // dynamic lights (explosions, muzzle flash)
    for (int i = 0; i < uNumLights; i++) {
        vec3 L = uLightPosR[i].xyz - vWorld;
        float d = length(L);
        float r = uLightPosR[i].w;
        if (d < r) {
            float att = pow(1.0 - d / r, 2.0);
            light += uLightCol[i] * att * max(dot(N, L / max(d, 0.01)), 0.1);
        }
    }

    vec3 col = albedo * light + albedo * emis;

    // fog
    float dist = length(vWorld - uCamPos);
    float f = 1.0 - exp(-pow(dist * uFogDensity, 1.5));
    vec3 fogCol = mix(uFogColor, uSunColor * 0.25 + uFogColor, 0.0);
    col = mix(col, fogCol, clamp(f, 0.0, 1.0));

    FragColor = vec4(col, 1.0);
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
out vec3 vWorld;
void main() {
    vWorld = vec3(aPos.x, uWaterLevel, aPos.y);
    gl_Position = uViewProj * vec4(vWorld, 1.0);
}
)";
static std::string fsWater() {
    std::string s = R"(#version 330 core
in vec3 vWorld;
out vec4 FragColor;
uniform vec3 uCamPos;
uniform vec3 uWaterColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
)";
    s += GLSL_SKY_COMMON;
    s += R"(
void main() {
    vec2 p = vWorld.xz;
    float t = uTime;
    // sum-of-sines normal perturbation
    float h1 = sin(p.x * 1.1 + t * 1.3) * 0.5 + sin(p.x * 0.4 - p.y * 0.7 + t * 0.9) * 0.7;
    float h2 = sin(p.y * 1.3 + t * 1.1) * 0.5 + sin(p.x * 0.8 + p.y * 0.5 - t * 1.4) * 0.6;
    float e = 0.15;
    vec3 N = normalize(vec3(-(h1) * e, 1.0, -(h2) * e));
    vec3 V = normalize(uCamPos - vWorld);
    vec3 R = reflect(-V, N);
    R.y = abs(R.y) + 0.02;
    vec3 refl = skyColor(normalize(R));
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0) * 0.9 + 0.08;
    vec3 col = mix(uWaterColor, refl, fres);
    // sun glint
    vec3 toSun = -uSunDir;
    col += uSunColor * pow(max(dot(R, toSun), 0.0), 240.0) * 2.0;
    float dist = length(vWorld - uCamPos);
    float f = 1.0 - exp(-pow(dist * uFogDensity, 1.5));
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
    FragColor = vec4(col, 0.93);
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
    int shadowQuality = 1;    // 0 low, 1 medium, 2 high
    int aoQuality = 1;
    float fov = 75.f;
    float bloom = 0.55f;
    bool vsync = true;
};

struct Renderer {
    int width = 1280, height = 720;
    GLuint progChunk = 0, progSky = 0, progWater = 0, progPart = 0, progModel = 0;
    GLuint progBright = 0, progBlur = 0, progComposite = 0, progUI = 0;
    // fullscreen quad
    GLuint fsVAO = 0, fsVBO = 0;
    // water quad
    GLuint waterVAO = 0, waterVBO = 0;
    // particles
    GLuint partVAO = 0, partQuadVBO = 0, partInstVBO = 0;
    // UI
    GLuint uiVAO = 0, uiQuadVBO = 0, uiInstVBO = 0;
    std::vector<UIInst> uiBatch;
    // 3D occupancy textures
    GLuint occTex = 0, occCoarseTex = 0;
    // HDR pipeline
    GLuint sceneFBO = 0, sceneColor = 0, sceneDepth = 0;
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

        // water quad (large, centered on map)
        {
            float cx = WX * VOXEL_SIZE * 0.5f, cz = WZ * VOXEL_SIZE * 0.5f, R = 1500.f;
            float wq[] = {cx - R, cz - R, cx + R, cz - R, cx + R, cz + R,
                          cx - R, cz - R, cx + R, cz + R, cx - R, cz + R};
            glGenVertexArrays(1, &waterVAO);
            glBindVertexArray(waterVAO);
            glGenBuffers(1, &waterVBO);
            glBindBuffer(GL_ARRAY_BUFFER, waterVBO);
            glBufferData(GL_ARRAY_BUFFER, sizeof wq, wq, GL_STATIC_DRAW);
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
        glGenTextures(1, &occCoarseTex);
        glBindTexture(GL_TEXTURE_3D, occCoarseTex);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_3D, GL_TEXTURE_WRAP_R, GL_CLAMP_TO_EDGE);

        createTargets();
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
        if (sceneFBO) { glDeleteFramebuffers(1, &sceneFBO); sceneFBO = 0; }
        makeTex2D(sceneColor, width, height, GL_RGBA16F, GL_RGBA, GL_FLOAT);
        makeTex2D(sceneDepth, width, height, GL_DEPTH_COMPONENT24, GL_DEPTH_COMPONENT, GL_UNSIGNED_INT);
        glGenFramebuffers(1, &sceneFBO);
        glBindFramebuffer(GL_FRAMEBUFFER, sceneFBO);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, sceneColor, 0);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, sceneDepth, 0);
        bloomW = width / 2; bloomH = height / 2;
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

    void resize(int w, int h) {
        if (w == width && h == height) return;
        if (w < 8 || h < 8) return;
        width = w; height = h;
        createTargets();
    }

    // ---------------- 3D occupancy upload
    // Texture layout convention: (s,t,r) = (x,y,z); GL data must therefore be
    // ordered x fastest, then y, then z (our vox array is x, z, y — transpose on upload).
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
        // coarse (8x max-downsample), same (x,y,z) convention
        const int CX = WX / 8, CY = WY / 8, CZ = WZ / 8;
        static std::vector<uint8_t> coarse;
        coarse.assign((size_t)CX * CY * CZ, 0);
        for (int y = 0; y < WY; y++)
            for (int z = 0; z < WZ; z++)
                for (int x = 0; x < WX; x++)
                    if (w.vox[World::vidx(x, y, z)])
                        coarse[((size_t)(z / 8) * CY + y / 8) * CX + x / 8] = 255;
        glBindTexture(GL_TEXTURE_3D, occCoarseTex);
        glTexImage3D(GL_TEXTURE_3D, 0, GL_R8, CX, CY, CZ, 0, GL_RED, GL_UNSIGNED_BYTE, coarse.data());
    }

    void uploadDirtyOccupancy(World& w) {
        if (w.texDirty.empty()) return;
        static std::vector<uint8_t> buf, cbuf;
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
            // recompute covered coarse cells
            int cx0 = r.x0 / 8, cx1 = r.x1 / 8, cy0 = r.y0 / 8, cy1 = r.y1 / 8, cz0 = r.z0 / 8, cz1 = r.z1 / 8;
            int cnx = cx1 - cx0 + 1, cny = cy1 - cy0 + 1, cnz = cz1 - cz0 + 1;
            cbuf.assign((size_t)cnx * cny * cnz, 0);
            for (int cz = cz0; cz <= cz1; cz++)
                for (int cy = cy0; cy <= cy1; cy++)
                    for (int cx = cx0; cx <= cx1; cx++) {
                        uint8_t v = 0;
                        for (int yy = cy * 8; yy < cy * 8 + 8 && yy < WY && !v; yy++)
                            for (int zz = cz * 8; zz < cz * 8 + 8 && zz < WZ && !v; zz++)
                                for (int xx = cx * 8; xx < cx * 8 + 8 && xx < WX; xx++)
                                    if (w.vox[World::vidx(xx, yy, zz)]) { v = 255; break; }
                        cbuf[((size_t)(cz - cz0) * cny + (cy - cy0)) * cnx + (cx - cx0)] = v;
                    }
            glBindTexture(GL_TEXTURE_3D, occCoarseTex);
            glTexSubImage3D(GL_TEXTURE_3D, 0, cx0, cy0, cz0, cnx, cny, cnz, GL_RED, GL_UNSIGNED_BYTE, cbuf.data());
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
        mat4 view = mat4_lookat(camPos, camPos + camFwd, vec3(0, 1, 0));
        viewProj = proj * view;
    }

    void setSceneUniforms(GLuint prog, const MapInfo& mi) {
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

    void beginScene(const MapInfo& mi) {
        glBindFramebuffer(GL_FRAMEBUFFER, sceneFBO);
        glViewport(0, 0, width, height);
        glClearColor(mi.skyHorizon.x, mi.skyHorizon.y, mi.skyHorizon.z, 1);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    }

    void drawSky(const MapInfo& mi) {
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

    void beginChunks(const MapInfo& mi, float ambient) {
        glUseProgram(progChunk);
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
        glBindTexture(GL_TEXTURE_3D, occCoarseTex);
        glUniform1i(glGetUniformLocation(progChunk, "uOccCoarse"), 1);
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
        // falling clusters (offset by fall distance)
        for (auto& fc : w.clusters) {
            if (!fc.gpuReady) uploadClusterMesh(fc);
            if (fc.indexCount == 0) continue;
            float g = 22.f;
            float d = 0.5f * g * fc.t * fc.t;
            float maxD = fc.drop * VOXEL_SIZE;
            if (d > maxD) d = maxD;
            glUniform3f(glGetUniformLocation(progChunk, "uOffset"), 0, -d, 0);
            glBindVertexArray(fc.vao);
            glDrawElements(GL_TRIANGLES, (GLsizei)fc.indexCount, GL_UNSIGNED_INT, nullptr);
        }
        glUniform3f(glGetUniformLocation(progChunk, "uOffset"), 0, 0, 0);
        glBindVertexArray(0);
    }

    void drawWater(const MapInfo& mi) {
        if (!mi.hasWater) return;
        glUseProgram(progWater);
        setSceneUniforms(progWater, mi);
        glUniform1f(glGetUniformLocation(progWater, "uWaterLevel"), mi.waterLevel);
        glUniform3f(glGetUniformLocation(progWater, "uWaterColor"), mi.waterColor.x, mi.waterColor.y, mi.waterColor.z);
        glEnable(GL_BLEND);
        glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
        glDisable(GL_CULL_FACE);
        glBindVertexArray(waterVAO);
        glDrawArrays(GL_TRIANGLES, 0, 6);
        glEnable(GL_CULL_FACE);
        glDisable(GL_BLEND);
    }

    void drawParticles(const std::vector<PartInst>& alpha, const std::vector<PartInst>& additive) {
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
        // bright pass -> bloom[0]
        glBindFramebuffer(GL_FRAMEBUFFER, bloomFBO[0]);
        glViewport(0, 0, bloomW, bloomH);
        glUseProgram(progBright);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, sceneColor);
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
        glBindTexture(GL_TEXTURE_2D, sceneColor);
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
        glEnable(GL_DEPTH_TEST);
        uiBatch.clear();
    }
};
