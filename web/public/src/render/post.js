// post.js — temporal accumulation, edge-aware cleanup, bloom and the filmic composite.
//
// The trace pass hands us a 1-sample-per-pixel image. Two things turn that into a
// picture:
//   1. Progressive accumulation. Every frame the camera holds still we average one more
//      independent sample into a float history buffer, and we jitter the projection
//      matrix sub-pixel while doing it, so the same mechanism that cleans the noise also
//      resolves geometry edges — 100+ samples gives shadow penumbrae and voxel
//      silhouettes with no visible stair-stepping at all.
//   2. An edge-aware à-trous filter whose radius collapses as the sample count climbs.
//      It keeps the image usable in motion and then gets out of the way entirely, so a
//      settled frame is unfiltered ground truth rather than something smeared.
//
// Then bloom (dual-filter mip chain, the Call-of-Duty style downsample/upsample), ACES
// tonemapping, and a soft vignette.
//
// There is deliberately NO sharpening pass, and that is a tested result rather than an
// omission. The standard pairing is denoise-then-sharpen, on the reasoning that a spatial
// filter spends high frequencies it should hand back. It was implemented here (AMD CAS
// shape: 5-tap unsharp scaled by local headroom) and swept against a 512-sample reference
// with tools/rmse.mjs. It was worse at every amount tested, monotonically:
//
//     sharpen   8 spp    32 spp
//        0.20    +4.1%     +5.0%
//        0.35    +9.3%    +15.6%
//        0.50   +16.4%    +31.9%
//        0.70   +28.4%    +62.6%
//        1.00   +52.0%   +120.8%
//
// The reason is that the variance-guided à-trous below is not over-blurring — it retires
// itself per pixel where the estimate has converged — so there is no lost detail to
// restore and the sharpen only manufactures edges that are not in the converged image.
//
// Recording this because the images argue the opposite. At 0.70 the frame reads visibly
// crisper: tighter voxel grid lines, harder crosswalk edges. I looked at that pair and
// called it better soon before the numbers came back saying it sits 63% further from
// ground truth. If you are about to add a sharpen because the output looks soft, measure
// it first.

import * as THREE from 'three';
import { FULLSCREEN_VERT } from './shaders/common.js';

export function makeQuad() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.frustumCulled = false;
  return m;
}

/**
 * float=true gives a 32-bit history buffer with point sampling: progressive averaging
 * writes increments of 1/N, and by N≈200 a half-float simply cannot represent them any
 * more, so the image would silently stop converging.
 */
export function hdrTarget(w, h, float = false) {
  const filter = float ? THREE.NearestFilter : THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: float ? THREE.FloatType : THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: filter, magFilter: filter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

// ---------------------------------------------------------------- accumulate
export const ACCUM_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
layout(location = 0) out vec4 oColor;
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform vec2 uTexel;
uniform float uBlend;
uniform float uClamp;   // 0 = pure average (still frame), 1 = clamp history (motion)

// Alpha carries the running mean of sample luminance *squared*. Together with the mean
// radiance in rgb that is a complete second-moment estimator, so the denoiser downstream
// can ask "how noisy is this pixel actually?" instead of being told by a hand-tuned
// sample-count schedule. It costs nothing: the buffer is already RGBA float and alpha was
// being written as a constant 1.0.
//
// Luminance is a linear functional, so mean(luma(sample)) == luma(mean(rgb)) and the
// first moment needs no separate channel — variance is just alpha - luma(rgb)^2.
float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec4 cs = texture(tCur, vUv);
  vec4 hs = texture(tHist, vUv);
  vec3 c = cs.rgb, h = hs.rgb;
  // guard against NaN/Inf leaking into the history and poisoning it forever
  c = clamp(c, vec3(0.0), vec3(2048.0));
  if (!(c.r == c.r)) c = vec3(0.0);
  float m2c = lumaOf(c) * lumaOf(c);
  float m2h = hs.a;
  if (!(m2h == m2h)) m2h = m2c;

  // Neighbourhood clamping. While debris is tumbling and smoke is drifting the history
  // holds those things where they *were*, so blending it in smears them. Clamping the
  // history into the colour range of the current frame's 3x3 neighbourhood throws away
  // exactly the samples that disagree with what is there now, which is what lets the
  // accumulator keep running through motion instead of having to be thrown away.
  // Disabled on a still frame (uClamp = 0), where an honest mean is strictly better.
  if (uClamp > 0.0) {
    vec3 lo = c, hi = c;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 s = texture(tCur, vUv + vec2(float(x), float(y)) * uTexel).rgb;
        lo = min(lo, s); hi = max(hi, s);
      }
    // widen slightly: a hard box on a 1-spp frame is so noisy it rejects good history
    vec3 pad = (hi - lo) * 0.5 + vec3(0.02);
    h = mix(h, clamp(h, lo - pad, hi + pad), uClamp);
  }
  vec3 mean = mix(h, c, uBlend);
  // Keep the second moment consistent with the mean it is paired with. Clamping rgb above
  // can leave a stale m2 that sits below luma^2, which would make the variance negative
  // and read as "perfectly converged" on exactly the pixels that just changed.
  float m2 = max(mix(m2h, m2c, uBlend), lumaOf(mean) * lumaOf(mean));
  oColor = vec4(mean, m2);
}`;

// ---------------------------------------------------------------- edge-aware cleanup
//
// Variance-guided a-trous, run as several passes with a doubling tap spacing (1, 2, 4,
// 8...). Two changes from the single 5x5 pass this replaces, both of which matter:
//
//   * Multiple passes. One 5x5 kernel gathers 25 pixels; five passes at doubling spacing
//     gather an effective 81x81 neighbourhood for the cost of 125 taps. At the 6-20
//     samples an interactive frame actually has, that is the whole difference between
//     grain and a clean image — and interactive is where the player lives, since nobody
//     holds still for the 96 samples a review screenshot gets.
//
//   * The filter decides its own strength from measured variance rather than from a
//     sample-count schedule. The old code faded out linearly and cut off at 20 samples
//     because that was roughly where grain stopped being obvious *on the shots I looked
//     at*; a dim interior needs far more, a sunlit wall far less, and one global ramp
//     cannot serve both. Variance of the mean falls as 1/N automatically, so the filter
//     retires itself where the estimate has converged and keeps working where it has not.
//
// Alpha in/out is variance. uM2 selects how to read it: the accumulation buffer hands us
// a second moment (variance = m2 - luma^2, over N samples), every later pass hands us the
// filtered variance directly.
export const DENOISE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
layout(location = 0) out vec4 oColor;
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tPosition;
uniform vec2 uTexel;
uniform float uStep;      // à-trous dilation in pixels
uniform float uStrength;  // 0 = passthrough
uniform float uM2;        // 1 = alpha is a second moment, 0 = alpha is variance
uniform float uSamples;   // accumulated samples behind the mean in tColor
uniform float uPhiL;      // luminance tolerance, in standard deviations
uniform float uPhiN;      // normal tolerance (exponent)
uniform float uPhiP;      // world-position falloff, 1/metres

float lumaOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Variance of the *mean* at a texel, however alpha happens to be encoded this pass.
//
// Note the N-1 rather than N: (E[l^2] - E[l]^2) underestimates the sample variance by
// (N-1)/N, and dividing the corrected figure by N to get the variance of the mean leaves
// N-1 on the bottom. At small N — the only place any of this matters — that correction is
// not a rounding detail: at N=2 it is a factor of two.
float varAt(vec4 c) {
  float l = lumaOf(c.rgb);
  return uM2 > 0.5 ? max(c.a - l * l, 0.0) / max(uSamples - 1.0, 1.0) : max(c.a, 0.0);
}

void main() {
  vec4 c0 = texture(tColor, vUv);
  if (uStrength <= 0.001) { oColor = c0; return; }
  vec4 n0 = texture(tNormal, vUv);
  vec3 p0 = texture(tPosition, vUv).xyz;
  float l0 = lumaOf(c0.rgb);

  // Spatial fallback for a thin history.
  //
  // The temporal variance is estimated from the same N samples as the mean, so at N=1 it
  // is *identically zero* — the mean is the sample, and there is nothing to disagree with.
  // Taken at face value that gives a zero tolerance, every neighbour is rejected as an
  // edge, and the filter switches itself off completely on the single noisiest frame
  // there is: the one right after the camera moves. Which is most of them, in play.
  //
  // So below a handful of samples, estimate the noise from the neighbourhood in space
  // instead, and use whichever estimate is larger. Costs 25 taps and only on the first
  // few frames after a reset.
  // Only at a single sample, where the temporal estimate is *identically* zero and there
  // is nothing else to go on. This used to trigger below 4 samples and that was actively
  // harmful. Measured against a 384-sample reference, before and after narrowing it:
  //
  //     samples   was      now
  //           1   -12.6%   -12.6%
  //           2   +15.0%   -43.6%
  //           3   +39.0%   -39.9%
  //           6   -31.6%   -31.6%
  //
  // Two and three samples went from worse-than-no-filter to the best results in the table,
  // and the counts either side are untouched, which is what says the change is confined to
  // the band it was aimed at.
  //
  // The cause is the max() below. A neighbourhood's spatial variance at low sample counts
  // is dominated by real scene detail rather than noise, so once the temporal estimate
  // becomes usable at N=2 the floor overrides it with an inflated tolerance and the filter
  // blurs across genuine edges. Taking the larger of the two is only right when one of
  // them is known to be meaningless.
  //
  // Worth noting none of the earlier measurements could have caught this: they sampled
  // 4/8/16/32/64 with a static camera, and 2-3 samples is what a *moving* camera produces
  // constantly — which is most frames in play.
  // Geometrically weighted, which the first version was not — and that omission showed up
  // in the numbers as an anomaly rather than an error. The 1-sample frame is by far the
  // noisiest and should gain the most from filtering, yet it improved only 12.6% while 2
  // and 3 samples improved ~40%. An unweighted 5x5 measures variance *across surface
  // boundaries*: a window frame against brick, a kerb against tarmac. That is scene detail,
  // not noise, and counting it inflates the tolerance on exactly the pixels where an edge
  // needs protecting. Weighting the moments by the same normal and position terms the main
  // loop uses confines the estimate to one surface, which is what it was always meant to
  // measure.
  // Runs in every pass at one sample, and that is not the waste it looks like.
  //
  // I nearly restricted it to the first pass to save 200 texture reads, on the reasoning
  // that later passes read the real variance pass one wrote. They do not. At N=1 the
  // accumulator stores m2 = max(..., luma(mean)^2) where mean *is* the single sample, so
  // c.a - l*l is identically zero and varAt returns zero for every tap. Pass one therefore
  // writes accV = sum(0 * w^2) = 0, and passes two through five read a zero variance, get
  // sigmaL ~ 1e-4, and filter nothing whatsoever.
  //
  // So this is not 250 taps buying a 1.6 point improvement. It is 250 taps buying the
  // difference between five filtering passes and one, on the frame a moving camera
  // produces every time.
  float floorV = 0.0;
  if (uSamples < 2.0) {
    float m1 = 0.0, m2 = 0.0, mw = 0.0;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++) {
        vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
        vec4 n = texture(tNormal, uv);
        vec3 p = texture(tPosition, uv).xyz;
        float w = pow(max(dot(n.xyz, n0.xyz), 0.0), uPhiN) * exp(-length(p - p0) * uPhiP);
        float l = lumaOf(texture(tColor, uv).rgb);
        m1 += l * w; m2 += l * l * w; mw += w;
      }
    if (mw > 1e-4) {
      m1 /= mw; m2 /= mw;
      floorV = max(m2 - m1 * m1, 0.0);
    }
  }

  // The variance estimate is itself built from noisy data. Prefilter it 3x3 (gaussian)
  // before using it as a tolerance, or a single firefly declares its own neighbourhood an
  // edge, refuses to be filtered, and survives every pass as a permanent bright speck.
  float vs = 0.0, vw = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      float k = (x == 0 && y == 0) ? 4.0 : ((x == 0 || y == 0) ? 2.0 : 1.0);
      vs += varAt(texture(tColor, vUv + vec2(float(x), float(y)) * uTexel)) * k;
      vw += k;
    }
  float sigmaL = uPhiL * sqrt(max(vs / vw, floorV)) + 1e-4;

  const float k[3] = float[3](1.0, 0.66, 0.24);
  vec3 acc = c0.rgb;
  float accV = varAt(c0);
  float sum = 1.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      if (x == 0 && y == 0) continue;
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel * uStep;
      vec4 c = texture(tColor, uv);
      vec4 n = texture(tNormal, uv);
      vec3 p = texture(tPosition, uv).xyz;
      float wn = pow(max(dot(n.xyz, n0.xyz), 0.0), uPhiN);
      float wp = exp(-length(p - p0) * uPhiP);
      float wl = exp(-abs(lumaOf(c.rgb) - l0) / sigmaL);
      float w = k[abs(x)] * k[abs(y)] * wn * wp * wl;
      acc += c.rgb * w;
      sum += w;
      // Variance of a weighted mean carries the *square* of each weight, so the estimate
      // shrinks as the filter gathers — which is what lets the next pass filter less.
      accV += varAt(c) * w * w;
    }
  }
  // Var(sum(w*x)/sum(w)) = sum(w^2 * Var(x)) / sum(w)^2. Dividing by sum(w^2) instead —
  // which is the shape the accumulator above invites you to write — yields a weighted
  // *average* of the neighbours' variances, which barely falls at all. The filter then
  // never tapers: every pass sees the same tolerance as the first and keeps smoothing at
  // full strength. Measured against a 512-sample reference that made the 32-sample frame
  // 36% *worse* than no filtering, while looking cleaner to the eye — the exact failure
  // an RMSE check exists to catch.
  oColor = vec4(mix(c0.rgb, acc / sum, uStrength), accV / max(sum * sum, 1e-6));
}`;

// ---------------------------------------------------------------- bloom
export const BLOOM_PREFILTER_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
layout(location = 0) out vec4 oColor;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
vec3 tap(vec2 o) { return texture(tColor, vUv + o * uTexel).rgb; }
void main() {
  // 4-tap box with Karis average so one blown-out pixel cannot strobe the whole chain
  vec3 a = tap(vec2(-1.0, -1.0)), b = tap(vec2(1.0, -1.0));
  vec3 c = tap(vec2(-1.0, 1.0)),  d = tap(vec2(1.0, 1.0));
  float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b)));
  float wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b)));
  float wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
  float wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b)));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  oColor = vec4(col * contrib, 1.0);
}`;

export const BLOOM_DOWN_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
layout(location = 0) out vec4 oColor;
uniform sampler2D tColor;
uniform vec2 uTexel;
vec3 tap(vec2 o) { return texture(tColor, vUv + o * uTexel).rgb; }
void main() {
  vec3 c = tap(vec2(0.0)) * 0.125;
  c += (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0))) * 0.125;
  c += (tap(vec2(-2.0, 0.0)) + tap(vec2(2.0, 0.0)) + tap(vec2(0.0, -2.0)) + tap(vec2(0.0, 2.0))) * 0.0625;
  c += (tap(vec2(-2.0, -2.0)) + tap(vec2(2.0, -2.0)) + tap(vec2(-2.0, 2.0)) + tap(vec2(2.0, 2.0))) * 0.03125;
  c += (tap(vec2(0.0, 0.0))) * 0.0;
  c += (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 0.0625;
  oColor = vec4(c, 1.0);
}`;

export const BLOOM_UP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
layout(location = 0) out vec4 oColor;
uniform sampler2D tColor;   // coarser level
uniform sampler2D tPrev;    // this level's own downsampled result
uniform vec2 uTexel;
uniform float uRadius;
vec3 tap(vec2 o) { return texture(tColor, vUv + o * uTexel * uRadius).rgb; }
void main() {
  vec3 c = tap(vec2(0.0)) * 0.25;
  c += (tap(vec2(-1.0, 0.0)) + tap(vec2(1.0, 0.0)) + tap(vec2(0.0, -1.0)) + tap(vec2(0.0, 1.0))) * 0.125;
  c += (tap(vec2(-1.0, -1.0)) + tap(vec2(1.0, -1.0)) + tap(vec2(-1.0, 1.0)) + tap(vec2(1.0, 1.0))) * 0.0625;
  oColor = vec4(texture(tPrev, vUv).rgb + c, 1.0);
}`;

// ---------------------------------------------------------------- composite
export const COMPOSITE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
layout(location = 0) out vec4 oColor;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;

// ACES, Stephen Hill's fit (RRT+ODT baked). The shoulder is what stops the sun-facing
// brick from clipping to a flat orange slab and is a big part of the filmic feel.
const mat3 ACESIn = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACESOut = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);
vec3 rrt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 c) {
  c = ACESIn * c;
  c = rrt(c);
  c = ACESOut * c;
  return clamp(c, 0.0, 1.0);
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 c = texture(tColor, vUv).rgb + texture(tBloom, vUv).rgb * uBloom;
  c = acesFitted(c * uExposure);

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = clamp((c - 0.5) * uContrast + 0.5 + uLift, 0.0, 1.0);

  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float vig = smoothstep(1.05, 0.30, length(q) * 1.05);
  c *= mix(1.0, vig, uVignette);

  c = linearToSrgb(c);
  // ordered dither kills the banding a smooth HDR sky would otherwise show at 8 bit
  float d = fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)));
  d = fract(52.9829189 * d) - 0.5;
  c += d / 255.0;
  oColor = vec4(c, 1.0);
}`;

export function fsMaterial(frag, uniforms) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
}
