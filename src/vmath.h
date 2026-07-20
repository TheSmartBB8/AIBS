// vmath.h - minimal vector/matrix math
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <algorithm>

struct vec2 { float x=0, y=0; };
struct vec3 {
    float x=0, y=0, z=0;
    vec3() {}
    vec3(float a, float b, float c) : x(a), y(b), z(c) {}
    vec3 operator+(const vec3& o) const { return {x+o.x, y+o.y, z+o.z}; }
    vec3 operator-(const vec3& o) const { return {x-o.x, y-o.y, z-o.z}; }
    vec3 operator*(float s) const { return {x*s, y*s, z*s}; }
    vec3 operator/(float s) const { return {x/s, y/s, z/s}; }
    vec3 operator-() const { return {-x, -y, -z}; }
    vec3& operator+=(const vec3& o) { x+=o.x; y+=o.y; z+=o.z; return *this; }
    vec3& operator-=(const vec3& o) { x-=o.x; y-=o.y; z-=o.z; return *this; }
    vec3& operator*=(float s) { x*=s; y*=s; z*=s; return *this; }
};
struct vec4 { float x=0, y=0, z=0, w=0; };

static inline float vdot(const vec3& a, const vec3& b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
static inline vec3 vcross(const vec3& a, const vec3& b) {
    return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}
static inline float vlen(const vec3& a) { return sqrtf(vdot(a, a)); }
static inline vec3 vnorm(const vec3& a) { float l = vlen(a); return l > 1e-8f ? a * (1.f/l) : vec3(0,0,0); }
static inline vec3 vlerp(const vec3& a, const vec3& b, float t) { return a + (b-a)*t; }
static inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
static inline float lerpf(float a, float b, float t) { return a + (b-a)*t; }

// column-major 4x4 (OpenGL convention)
struct mat4 {
    float m[16];
    static mat4 identity() { mat4 r; memset(r.m, 0, sizeof r.m); r.m[0]=r.m[5]=r.m[10]=r.m[15]=1; return r; }
    mat4 operator*(const mat4& o) const {
        mat4 r;
        for (int c = 0; c < 4; c++)
            for (int rr = 0; rr < 4; rr++) {
                float s = 0;
                for (int k = 0; k < 4; k++) s += m[k*4+rr] * o.m[c*4+k];
                r.m[c*4+rr] = s;
            }
        return r;
    }
};

static inline mat4 mat4_perspective(float fovyRad, float aspect, float zn, float zf) {
    mat4 r; memset(r.m, 0, sizeof r.m);
    float f = 1.f / tanf(fovyRad * 0.5f);
    r.m[0] = f / aspect; r.m[5] = f;
    r.m[10] = (zf + zn) / (zn - zf); r.m[11] = -1;
    r.m[14] = (2 * zf * zn) / (zn - zf);
    return r;
}
static inline mat4 mat4_lookat(const vec3& eye, const vec3& at, const vec3& up) {
    vec3 f = vnorm(at - eye), s = vnorm(vcross(f, up)), u = vcross(s, f);
    mat4 r = mat4::identity();
    r.m[0]=s.x; r.m[4]=s.y; r.m[8]=s.z;
    r.m[1]=u.x; r.m[5]=u.y; r.m[9]=u.z;
    r.m[2]=-f.x; r.m[6]=-f.y; r.m[10]=-f.z;
    r.m[12]=-vdot(s, eye); r.m[13]=-vdot(u, eye); r.m[14]=vdot(f, eye);
    return r;
}
static inline mat4 mat4_translate(const vec3& t) {
    mat4 r = mat4::identity(); r.m[12]=t.x; r.m[13]=t.y; r.m[14]=t.z; return r;
}
static inline mat4 mat4_scale(const vec3& s) {
    mat4 r = mat4::identity(); r.m[0]=s.x; r.m[5]=s.y; r.m[10]=s.z; return r;
}
static inline mat4 mat4_roty(float a) {
    mat4 r = mat4::identity(); float c=cosf(a), s=sinf(a);
    r.m[0]=c; r.m[8]=s; r.m[2]=-s; r.m[10]=c; return r;
}
static inline mat4 mat4_rotx(float a) {
    mat4 r = mat4::identity(); float c=cosf(a), s=sinf(a);
    r.m[5]=c; r.m[9]=-s; r.m[6]=s; r.m[10]=c; return r;
}
static inline mat4 mat4_rotz(float a) {
    mat4 r = mat4::identity(); float c=cosf(a), s=sinf(a);
    r.m[0]=c; r.m[4]=-s; r.m[1]=s; r.m[5]=c; return r;
}
static inline mat4 mat4_ortho(float l, float r_, float b, float t, float zn, float zf) {
    mat4 r = mat4::identity();
    r.m[0]=2/(r_-l); r.m[5]=2/(t-b); r.m[10]=-2/(zf-zn);
    r.m[12]=-(r_+l)/(r_-l); r.m[13]=-(t+b)/(t-b); r.m[14]=-(zf+zn)/(zf-zn);
    return r;
}
static inline vec3 mat4_mulpoint(const mat4& m, const vec3& p) {
    return { m.m[0]*p.x+m.m[4]*p.y+m.m[8]*p.z+m.m[12],
             m.m[1]*p.x+m.m[5]*p.y+m.m[9]*p.z+m.m[13],
             m.m[2]*p.x+m.m[6]*p.y+m.m[10]*p.z+m.m[14] };
}

// deterministic PRNG (xorshift) - must match across network peers
struct Rng {
    uint32_t s;
    explicit Rng(uint32_t seed = 1) : s(seed ? seed : 1) {}
    uint32_t next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    float uf() { return (next() & 0xFFFFFF) / 16777216.f; }           // [0,1)
    float sf() { return uf() * 2.f - 1.f; }                          // [-1,1)
    int ri(int lo, int hi) { return lo + (int)(next() % (uint32_t)(hi - lo + 1)); } // [lo,hi]
};
