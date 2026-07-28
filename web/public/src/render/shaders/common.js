// common.js — GLSL building blocks shared by every pass of the raytraced pipeline.
//
// Everything here is GLSL ES 3.00 (three.js `glslVersion: THREE.GLSL3`), because
// sampler3D — the voxel volume — does not exist in GLSL ES 1.00.
//
// Coordinate conventions used throughout:
//   * "voxel space" = world metres / VOXEL, so the grid occupies [0..sx, 0..sy, 0..sz].
//   * The volume textures are laid out x-fastest, then z, then y (matching
//     VoxelWorld.idx), so a voxel (x,y,z) samples at texcoord (x/sx, z/sz, y/sy).

// ---------------------------------------------------------------- random / sampling
export const RANDOM = /* glsl */`
uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
uint gSeed;
void seedRng(uvec3 p) {
  gSeed = pcgHash(p.x + 1973u * p.y + 9277u * p.z + 26699u);
}
float rnd() {
  gSeed = pcgHash(gSeed);
  return float(gSeed) * (1.0 / 4294967296.0);
}
vec2 rnd2() { return vec2(rnd(), rnd()); }

// Build an orthonormal basis around n (Duff et al., branchless).
void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 cosineHemisphere(vec3 n, vec2 u) {
  float r = sqrt(u.x);
  float phi = 6.28318530718 * u.y;
  vec3 t, b; basis(n, t, b);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u.x)));
}

// Uniform direction inside a cone of half-angle acos(cosMax) around d.
vec3 sampleCone(vec3 d, float cosMax, vec2 u) {
  float ct = mix(cosMax, 1.0, u.x);
  float st = sqrt(max(0.0, 1.0 - ct * ct));
  float phi = 6.28318530718 * u.y;
  vec3 t, b; basis(d, t, b);
  return normalize(t * (st * cos(phi)) + b * (st * sin(phi)) + d * ct);
}

// GGX half-vector, NDF importance sampled.
vec3 sampleGGX(vec3 n, float rough, vec2 u) {
  float a = max(rough * rough, 1e-4);
  float phi = 6.28318530718 * u.x;
  float ct = sqrt((1.0 - u.y) / (1.0 + (a * a - 1.0) * u.y));
  float st = sqrt(max(0.0, 1.0 - ct * ct));
  vec3 t, b; basis(n, t, b);
  return normalize(t * (st * cos(phi)) + b * (st * sin(phi)) + n * ct);
}
float smithG1(float nv, float a) {
  float k = a * 0.5;
  return nv / (nv * (1.0 - k) + k);
}
`;

// ---------------------------------------------------------------- sky model
// A physically-flavoured but hand-tuned analytic sky. It is the *only* source of
// ambient light in the scene (there is no GI and no lightmap), so its shape matters
// enormously: the cool zenith is what tints shadowed faces blue, and the warm haze
// band near the horizon is what keeps them from going dead.
export const SKY = /* glsl */`
uniform vec3 uSunDir;         // direction light travels (away from the sun)
uniform vec3 uSunColor;       // linear radiance of the sun disc
uniform float uSunAngle;      // angular radius, radians (bigger = softer shadows)
uniform float uTime;          // seconds, drives cloud drift
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform float uSkyIntensity;
uniform vec3 uSunTint;

vec3 sunDirTo() { return -uSunDir; }

// Radiance arriving from direction d, *excluding* the sun disc. Used for ambient.
// Value noise for the cloud layer. Cheap, and only ever evaluated on sky rays.
float skyHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float skyVNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = skyHash(i), b = skyHash(i + vec2(1.0, 0.0));
  float c = skyHash(i + vec2(0.0, 1.0)), dd = skyHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, dd, f.x), f.y);
}
float skyFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * skyVNoise(p); p *= 2.13; a *= 0.5; }
  return v;
}

vec3 skyRadiance(vec3 d) {
  vec3 S = sunDirTo();
  float y = clamp(d.y, -1.0, 1.0);
  float g = pow(clamp(y, 0.0, 1.0), 0.44);
  vec3 c = mix(uSkyHorizon, uSkyZenith, g);
  // hazy ground hemisphere so downward rays are not black
  c = mix(uSkyGround, c, smoothstep(-0.30, 0.02, y));
  // forward (Mie) scattering lobe hugging the sun, strongest near the horizon
  float cs = max(dot(d, S), 0.0);
  float mie = pow(cs, 5.0) * 0.55 + pow(cs, 30.0) * 0.9;
  c += uSunTint * mie * (1.0 - 0.55 * smoothstep(0.0, 0.7, abs(y)));

  // Cloud layer. An empty gradient sky is roughly a quarter of every outdoor frame and
  // reads as a grey void; it also gives glass and metal nothing to reflect. Projecting
  // noise onto a plane above the camera costs almost nothing because it only runs on sky
  // rays, and it pays off twice — once in the sky, once in every reflection.
  if (y > 0.015) {
    vec2 uv = d.xz / max(y + 0.14, 0.02) * 1.35 + vec2(uTime * 0.006, uTime * 0.0022);
    float n = skyFbm(uv * 1.25);
    float cover = smoothstep(0.48, 0.78, n);
    float fade = smoothstep(0.015, 0.16, y);
    // lit rim on the sun side, cool grey in the body
    float lit = pow(max(dot(normalize(d), S), 0.0), 2.0);
    vec3 cloud = mix(vec3(0.62, 0.66, 0.74), uSunColor * 1.25 + vec3(0.35), 0.35 + 0.5 * lit);
    c = mix(c, cloud, cover * fade * 0.82);
  }
  return c * uSkyIntensity;
}

// Sky including the sun disc + bloomy halo. Used for primary rays and reflections.
vec3 skyWithSun(vec3 d) {
  vec3 c = skyRadiance(d);
  vec3 S = sunDirTo();
  float cs = dot(d, S);
  float ca = cos(uSunAngle);
  float disc = smoothstep(ca - uSunAngle * 0.35, ca + uSunAngle * 0.06, cs);
  c += uSunColor * disc * 14.0;
  c += uSunColor * pow(max(cs, 0.0), 1400.0) * 3.0;
  return c;
}
`;

// ---------------------------------------------------------------- distant environment
// The voxel volume is only 25.6 m across. Any ray that leaves it used to return pure sky,
// which meant every shot looking down or outward showed the world simply *stopping* — a
// lit diorama sitting on a grey table. That single fact was doing more damage to the
// Teardown read than any lighting parameter.
//
// The fix is not more voxels. It is what a real renderer does beyond its detail budget:
// an analytic backdrop. A ground plane continuous with the level's own ground gives the
// world somewhere to go, two bands of azimuthal hills give the horizon a silhouette, and
// the same aerial-perspective curve used inside the volume dissolves both into the sky —
// so the join between "real geometry" and "backdrop" lands where the haze already is.
//
// Being analytic, it costs one plane intersection and some noise, only on rays that miss,
// and it shows up correctly in reflections for free.
export const ENVIRONMENT = /* glsl */`
uniform float uHorizonY;      // world-space height of the backdrop plane, metres
uniform vec3  uGroundNear;    // linear albedo of the near/lit distant ground
uniform vec3  uGroundFar;     // linear albedo of the darker patches (woodland, ploughing)
uniform vec3  uHillColor;     // linear colour the ridge silhouettes tend toward
uniform float uHillHeight;    // silhouette elevation, as a tangent (0.03 ~= 1.7 deg)
uniform float uEnvFog;        // haze density used to dissolve the backdrop, per metre

// Silhouette elevation of a ridge line as a function of azimuth. Built from harmonics of
// the azimuth so it is seamlessly periodic — a noise lookup would tear at +/-pi.
float ridgeLine(vec2 hz, float phase, float scale) {
  float a = atan(hz.y, hz.x) + phase;
  float e = sin(a * 2.0 + 0.4)  * 0.55
          + sin(a * 5.0 + 1.9)  * 0.30
          + sin(a * 11.0 + 3.7) * 0.16
          + sin(a * 23.0 + 5.5) * 0.07;
  return uHillHeight * scale * (0.55 + 0.45 * e);
}

/**
 * Radiance arriving along rd at a point that hit nothing in the volume.
 * The sky argument is the term to build on: with the sun disc for anything the camera or
 * a reflection sees directly, without it for the aerial-perspective blend (mixing a disc
 * into fogged geometry would paint a second sun over the buildings).
 */
vec3 envRadianceOn(vec3 ro, vec3 rd, vec3 sky) {
  vec3 S = sunDirTo();
  // What distance dissolves into. NOT skyRadiance(rd): for a downward ray that returns
  // uSkyGround, which is an ambient-lighting fudge (a dark brown), and it turned the far
  // landscape into a grey-green void — exactly the failure the backdrop exists to fix.
  // Real aerial perspective tends toward the *horizon* colour along the same azimuth.
  vec3 haze = skyRadiance(normalize(vec3(rd.x, 0.03, rd.z)));

  // ---- ground plane, for anything heading downward
  if (rd.y < -1e-5) {
    float t = (uHorizonY - ro.y) / rd.y;
    if (t > 0.0) {
      vec2 hp = (ro + rd * t).xz;

      // Relief. A mathematically flat plane stays a flat wash however it is coloured —
      // it was the remaining tell that the distance was painted on. Rather than raymarch
      // a heightfield, perturb the *shading normal* by the gradient of a low-frequency
      // height function: two extra noise taps buy sunlit and shaded slopes, which is
      // where the sense of rolling country actually comes from.
      const float HF = 0.0075, EPS = 6.0, AMP = 26.0;
      float h0 = skyFbm(hp * HF);
      float hx = skyFbm((hp + vec2(EPS, 0.0)) * HF);
      float hz = skyFbm((hp + vec2(0.0, EPS)) * HF);
      vec3 N = normalize(vec3(-(hx - h0) * AMP, 1.0, -(hz - h0) * AMP));

      // field-sized patches inside broader country, plus darker woodland on the tops
      float n = skyFbm(hp * 0.055) * 0.65 + skyFbm(hp * 0.009) * 0.55;
      vec3 g = mix(uGroundNear, uGroundFar, clamp(n - 0.18, 0.0, 1.0));
      g = mix(g, uGroundFar * 0.75, smoothstep(0.56, 0.70, h0) * 0.8);
      // drifting cloud shadow, the cue that reads as "a landscape under a real sky"
      float shade = mix(0.58, 1.0, smoothstep(0.36, 0.72, skyFbm(hp * 0.0065 + uTime * 0.004)));
      // Matched to how the volume's own ground is lit, or the join at the world edge
      // shows as a step: full sun term, and a hemisphere-averaged sky rather than zenith.
      vec3 ambient = mix(skyRadiance(vec3(0.0, 1.0, 0.0)),
                         skyRadiance(normalize(vec3(rd.x, 0.30, rd.z))), 0.6);
      vec3 lit = g * (uSunColor * uSunPower * max(dot(N, S), 0.0) * shade + ambient * (0.55 + 0.45 * N.y));
      return mix(lit, haze, clamp(1.0 - exp(-t * uEnvFog), 0.0, 1.0));
    }
  }

  // ---- ridge silhouettes just above the horizon. Two layers, because a single band
  // reads as a painted stripe; two at different heights and haze depths read as distance.
  float elev = rd.y / max(length(rd.xz), 1e-5);
  vec2 hz = normalize(rd.xz + vec2(1e-6));
  float far  = ridgeLine(hz, 0.0, 1.35);
  float near = ridgeLine(hz, 2.3, 0.80);
  vec3 c = sky;
  c = mix(c, mix(haze, uHillColor, 0.30), smoothstep(far,  far  - 0.0035, elev));
  c = mix(c, mix(haze, uHillColor, 0.55), smoothstep(near, near - 0.0025, elev));
  return c;
}

vec3 envRadiance(vec3 ro, vec3 rd)    { return envRadianceOn(ro, rd, skyWithSun(rd)); }
vec3 envAmbient(vec3 ro, vec3 rd)     { return envRadianceOn(ro, rd, skyRadiance(rd)); }
`;

// ---------------------------------------------------------------- volume tracing
// Hierarchical DDA. At every step we ask the coarsest occupancy level first: if the
// 16^3 block is empty we jump straight to its far face, otherwise try the 4^3 block,
// otherwise walk one voxel. In open air a ray leaves the 25.6 m world in ~4 steps and
// it only ever pays full-resolution cost in the thin shell around real geometry.
export const TRACE = /* glsl */`
uniform highp sampler3D uVol;
uniform highp sampler3D uMip1;
uniform highp sampler3D uMip2;
uniform vec3 uGrid;       // (sx, sy, sz) in voxels
uniform vec3 uTexScale;   // 1/(sx, sz, sy) — note the swizzled layout
uniform vec3 uTexScale1;
uniform vec3 uTexScale2;

float volFetch(vec3 c) { return texture(uVol,  (vec3(c.x, c.z, c.y) + 0.5) * uTexScale ).r; }
float mip1Fetch(vec3 c) { return texture(uMip1, (vec3(c.x, c.z, c.y) + 0.5) * uTexScale1).r; }
float mip2Fetch(vec3 c) { return texture(uMip2, (vec3(c.x, c.z, c.y) + 0.5) * uTexScale2).r; }

struct VHit {
  bool  hit;
  float t;      // distance in voxel units
  vec3  n;      // world-space face normal
  float pal;    // palette index 0..255
};

VHit traceVoxels(vec3 ro, vec3 rd, float tMax, int maxSteps) {
  VHit h; h.hit = false; h.t = tMax; h.n = vec3(0.0); h.pal = 0.0;

  vec3 sg = vec3(greaterThanEqual(rd, vec3(0.0))) * 2.0 - 1.0;
  rd = sg * max(abs(rd), vec3(1e-6));
  vec3 inv = 1.0 / rd;
  vec3 pos01 = max(sg, 0.0);

  // slab clip against the grid
  vec3 ta = (vec3(0.0) - ro) * inv;
  vec3 tb = (uGrid - ro) * inv;
  vec3 tn = min(ta, tb), tf = max(ta, tb);
  float tEnter = max(max(tn.x, tn.y), tn.z);
  float tLeave = min(min(tf.x, tf.y), tf.z);
  tMax = min(tMax, tLeave);
  float t = max(tEnter, 0.0) + 1e-3;
  if (t >= tMax) return h;

  int axis = 0;
  if (tEnter > 0.0) axis = (tn.x >= tn.y) ? ((tn.x >= tn.z) ? 0 : 2)
                                          : ((tn.y >= tn.z) ? 1 : 2);

  for (int i = 0; i < maxSteps; i++) {
    if (t >= tMax) return h;
    vec3 p = ro + rd * t;
    float cs;
    if (mip2Fetch(floor(p * 0.0625)) < 0.5) {
      cs = 16.0;
    } else if (mip1Fetch(floor(p * 0.25)) < 0.5) {
      cs = 4.0;
    } else {
      vec3 c0 = floor(p);
      float v = volFetch(c0);
      if (v > 0.0) {
        h.hit = true; h.t = t; h.pal = v * 255.0;
        h.n = vec3(0.0);
        h.n[axis] = -sg[axis];
        return h;
      }
      cs = 1.0;
    }
    vec3 cmin = floor(p / cs) * cs;
    vec3 te = (cmin + cs * pos01 - ro) * inv;
    float tnext = min(min(te.x, te.y), te.z);
    axis = (te.x <= te.y) ? ((te.x <= te.z) ? 0 : 2) : ((te.y <= te.z) ? 1 : 2);
    t = tnext + 1e-3;
  }
  return h;
}

// Occlusion-only variant: returns the distance to the first hit, or tMax if clear.
float traceShadow(vec3 ro, vec3 rd, float tMax, int maxSteps) {
  vec3 sg = vec3(greaterThanEqual(rd, vec3(0.0))) * 2.0 - 1.0;
  rd = sg * max(abs(rd), vec3(1e-6));
  vec3 inv = 1.0 / rd;
  vec3 pos01 = max(sg, 0.0);

  vec3 ta = (vec3(0.0) - ro) * inv;
  vec3 tb = (uGrid - ro) * inv;
  vec3 tn = min(ta, tb), tf = max(ta, tb);
  float tEnter = max(max(tn.x, tn.y), tn.z);
  float tLeave = min(min(tf.x, tf.y), tf.z);
  float tEnd = min(tMax, tLeave);
  float t = max(tEnter, 0.0) + 1e-3;

  for (int i = 0; i < maxSteps; i++) {
    if (t >= tEnd) return tMax;
    vec3 p = ro + rd * t;
    float cs;
    if (mip2Fetch(floor(p * 0.0625)) < 0.5) {
      cs = 16.0;
    } else if (mip1Fetch(floor(p * 0.25)) < 0.5) {
      cs = 4.0;
    } else {
      if (volFetch(floor(p)) > 0.0) return t;
      cs = 1.0;
    }
    vec3 cmin = floor(p / cs) * cs;
    vec3 te = (cmin + cs * pos01 - ro) * inv;
    t = min(min(te.x, te.y), te.z) + 1e-3;
  }
  // Step budget exhausted. Returning tMax would report "nothing in the way", which lets
  // sunlight punch straight through thick geometry at grazing angles — it showed up as a
  // lamp glow bleeding through an exterior wall. Fail closed instead.
  return -1.0;
}
`;

// ---------------------------------------------------------------- palette lookup
export const PALETTE = /* glsl */`
uniform sampler2D uPalCol;
uniform sampler2D uPalMat;
vec4 palColor(float idx) { return texture(uPalCol, vec2((idx + 0.5) / 256.0, 0.5)); }
vec4 palMat(float idx)   { return texture(uPalMat, vec2((idx + 0.5) / 256.0, 0.5)); }
`;

export const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
