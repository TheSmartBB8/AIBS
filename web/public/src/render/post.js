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
export function hdrTarget(w, h, float = false, count = 1) {
  const filter = float ? THREE.NearestFilter : THREE.LinearFilter;
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count,
    type: float ? THREE.FloatType : THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: filter, magFilter: filter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  for (const t of rt.textures) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

// ---------------------------------------------------------------- accumulate
export const ACCUM_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
// Both halves of the split accumulate in one pass. They share every scalar — the blend
// weight, the clamp decision, the neighbourhood offsets — so running two passes would pay
// for the same bookkeeping twice.
layout(location = 0) out vec4 oDiffuse;
layout(location = 1) out vec4 oSpecular;
layout(location = 2) out vec4 oAlbedo;
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tCurSpec;
uniform sampler2D tHistSpec;
uniform sampler2D tCurAlbedo;
uniform sampler2D tHistAlbedo;
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

// One channel's running mean plus second moment of luma.
//
// cur/hist are this frame's sample and the history; curTex is the texture cur came from,
// needed for the neighbourhood clamp, which has to be gathered from the same channel it is
// clamping — clamping specular against a diffuse neighbourhood would reject exactly the
// highlights it is meant to preserve.
//
// (No backticks anywhere in this file's GLSL comments. They close the template literal, and
// that has now broken the build four separate times.)
vec4 accumChannel(vec4 cur, vec4 hist, sampler2D curTex, vec2 uv, vec2 texel, float blend, float doClamp) {
  vec3 c = cur.rgb, h = hist.rgb;
  // guard against NaN/Inf leaking into the history and poisoning it forever
  c = clamp(c, vec3(0.0), vec3(2048.0));
  if (!(c.r == c.r)) c = vec3(0.0);
  float m2c = lumaOf(c) * lumaOf(c);
  float m2h = hist.a;
  if (!(m2h == m2h)) m2h = m2c;

  // Neighbourhood clamping. While debris is tumbling and smoke is drifting the history
  // holds those things where they *were*, so blending it in smears them. Clamping the
  // history into the colour range of the current frame's 3x3 neighbourhood throws away
  // exactly the samples that disagree with what is there now, which is what lets the
  // accumulator keep running through motion instead of having to be thrown away.
  // Disabled on a still frame (uClamp = 0), where an honest mean is strictly better.
  if (doClamp > 0.0) {
    vec3 lo = c, hi = c;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 s = texture(curTex, uv + vec2(float(x), float(y)) * texel).rgb;
        lo = min(lo, s); hi = max(hi, s);
      }
    // widen slightly: a hard box on a 1-spp frame is so noisy it rejects good history
    vec3 pad = (hi - lo) * 0.5 + vec3(0.02);
    h = mix(h, clamp(h, lo - pad, hi + pad), doClamp);
  }
  vec3 mean = mix(h, c, blend);
  // Keep the second moment consistent with the mean it is paired with. Clamping rgb above
  // can leave a stale m2 that sits below luma^2, which would make the variance negative
  // and read as "perfectly converged" on exactly the pixels that just changed.
  float m2 = max(mix(m2h, m2c, blend), lumaOf(mean) * lumaOf(mean));
  return vec4(mean, m2);
}

void main() {
  oDiffuse  = accumChannel(texture(tCur, vUv), texture(tHist, vUv), tCur, vUv, uTexel, uBlend, uClamp);
  oSpecular = accumChannel(texture(tCurSpec, vUv), texture(tHistSpec, vUv), tCurSpec, vUv, uTexel, uBlend, uClamp);
  // Albedo just averages. It carries no variance — it is not a Monte-Carlo estimate, it is
  // the surface — and it must not be neighbourhood-clamped either: the clamp exists to
  // reject history that disagrees with the current frame, and at a jittered geometry edge
  // disagreeing is precisely what the two surfaces are supposed to do. Rejecting it there
  // would pin the albedo to the latest sample and undo the whole point of averaging it.
  oAlbedo = vec4(mix(texture(tHistAlbedo, vUv).rgb, texture(tCurAlbedo, vUv).rgb, uBlend), 1.0);
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
layout(location = 0) out vec4 oDiffuse;
layout(location = 1) out vec4 oSpecular;
uniform sampler2D tColor;
uniform sampler2D tSpec;
uniform sampler2D tNormal;
uniform sampler2D tPosition;
uniform vec2 uTexel;
uniform float uStep;      // à-trous dilation in pixels
uniform float uStrength;  // 0 = passthrough
uniform float uM2;        // 1 = alpha is a second moment, 0 = alpha is variance
uniform float uSamples;   // accumulated samples behind the mean in tColor
uniform float uPhiL;      // diffuse luminance tolerance, in standard deviations
uniform float uPhiLSpec;  // specular luminance tolerance, in standard deviations
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
  vec4 s0 = texture(tSpec, vUv);
  if (uStrength <= 0.001) { oDiffuse = c0; oSpecular = s0; return; }
  vec4 n0 = texture(tNormal, vUv);
  vec3 p0 = texture(tPosition, vUv).xyz;
  float l0 = lumaOf(c0.rgb);
  float ls0 = lumaOf(s0.rgb);

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
  // First pass only (uM2), and at one sample only. Measured, because reasoning got this
  // backwards — see below.
  //
  //     1 sample, floor in every pass:  -14.2%
  //     1 sample, floor in pass 1 only: -39.0%
  //
  // Five times cheaper and nearly three times better. The mechanism is that the alpha this
  // shader writes carries the *temporal* variance, and at N=1 that is identically zero:
  // the accumulator stores m2 = max(..., luma(mean)^2) where mean is the single sample, so
  // c.a - l*l cancels exactly. Pass one therefore hands pass two a zero variance.
  //
  // I read that far and concluded passes two through five would filter nothing, so the
  // floor had to run in all of them. Wrong: without the guard each pass recomputes the
  // spatial floor from the already-filtered image, finds it still large — filtering
  // removes noise but leaves the scene structure the estimate is really measuring — and
  // keeps filtering at step 2, 4, 8, 16. That is a very wide kernel applied four more
  // times to an image that was already clean enough, and it is over-blur, not cleanup.
  //
  // One aggressive pass on the raw frame beats five compounding ones. It also closes most
  // of the gap to the 2-sample result (-43.6%), which is the anomaly that started this.
  float floorV = 0.0, floorVs = 0.0;
  if (uSamples < 2.0 && uM2 > 0.5) {
    float m1 = 0.0, m2 = 0.0, s1 = 0.0, s2 = 0.0, mw = 0.0;
    for (int y = -2; y <= 2; y++)
      for (int x = -2; x <= 2; x++) {
        vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
        vec4 n = texture(tNormal, uv);
        vec3 p = texture(tPosition, uv).xyz;
        float w = pow(max(dot(n.xyz, n0.xyz), 0.0), uPhiN) * exp(-length(p - p0) * uPhiP);
        float l = lumaOf(texture(tColor, uv).rgb);
        float ls = lumaOf(texture(tSpec, uv).rgb);
        m1 += l * w; m2 += l * l * w;
        s1 += ls * w; s2 += ls * ls * w;
        mw += w;
      }
    if (mw > 1e-4) {
      m1 /= mw; m2 /= mw; s1 /= mw; s2 /= mw;
      floorV = max(m2 - m1 * m1, 0.0);
      floorVs = max(s2 - s1 * s1, 0.0);
    }
  }

  // The variance estimate is itself built from noisy data. Prefilter it 3x3 (gaussian)
  // before using it as a tolerance, or a single firefly declares its own neighbourhood an
  // edge, refuses to be filtered, and survives every pass as a permanent bright speck.
  float vs = 0.0, vss = 0.0, vw = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      float k = (x == 0 && y == 0) ? 4.0 : ((x == 0 || y == 0) ? 2.0 : 1.0);
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel;
      vs += varAt(texture(tColor, uv)) * k;
      vss += varAt(texture(tSpec, uv)) * k;
      vw += k;
    }
  float sigmaL = uPhiL * sqrt(max(vs / vw, floorV)) + 1e-4;
  float sigmaLs = uPhiLSpec * sqrt(max(vss / vw, floorVs)) + 1e-4;

  // The geometric weights — normal and world position — describe the *surface*, not what is
  // lit on it, so they are identical for both halves and are computed once. That is why one
  // tap loop serves two outputs at well under twice the cost of two loops.
  //
  // Only the luminance term differs, and it differs less than expected: see the note on
  // denoisePhiLSpec. The split earns its keep through demodulation, not through this.
  const float k[3] = float[3](1.0, 0.66, 0.24);
  vec3 acc = c0.rgb, accS = s0.rgb;
  float accV = varAt(c0), accVs = varAt(s0);
  float sum = 1.0, sumS = 1.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      if (x == 0 && y == 0) continue;
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel * uStep;
      vec4 c = texture(tColor, uv);
      vec4 s = texture(tSpec, uv);
      vec4 n = texture(tNormal, uv);
      vec3 p = texture(tPosition, uv).xyz;
      float wn = pow(max(dot(n.xyz, n0.xyz), 0.0), uPhiN);
      float wp = exp(-length(p - p0) * uPhiP);
      float wg = k[abs(x)] * k[abs(y)] * wn * wp;

      float w = wg * exp(-abs(lumaOf(c.rgb) - l0) / sigmaL);
      acc += c.rgb * w;
      sum += w;
      // Variance of a weighted mean carries the *square* of each weight, so the estimate
      // shrinks as the filter gathers — which is what lets the next pass filter less.
      accV += varAt(c) * w * w;

      float ws = wg * exp(-abs(lumaOf(s.rgb) - ls0) / sigmaLs);
      accS += s.rgb * ws;
      sumS += ws;
      accVs += varAt(s) * ws * ws;
    }
  }
  // Var(sum(w*x)/sum(w)) = sum(w^2 * Var(x)) / sum(w)^2. Dividing by sum(w^2) instead —
  // which is the shape the accumulator above invites you to write — yields a weighted
  // *average* of the neighbours' variances, which barely falls at all. The filter then
  // never tapers: every pass sees the same tolerance as the first and keeps smoothing at
  // full strength. Measured against a 512-sample reference that made the 32-sample frame
  // 36% *worse* than no filtering, while looking cleaner to the eye — the exact failure
  // an RMSE check exists to catch.
  oDiffuse  = vec4(mix(c0.rgb, acc / sum, uStrength), accV / max(sum * sum, 1e-6));
  oSpecular = vec4(mix(s0.rgb, accS / sumS, uStrength), accVs / max(sumS * sumS, 1e-6));
}`;

// Put the two filtered halves back together, and hand the albedo back to the diffuse one.
//
// This also serves the job the old straight-copy blit did: emissive particles have to be
// drawn *into* the HDR colour before the bloom chain reads it, and the buffers holding that
// colour are ones we are sampling, so the result has to land somewhere writable anyway.
export const RECOMBINE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
layout(location = 0) out vec4 oColor;
uniform sampler2D tColor;      // filtered diffuse irradiance (albedo demodulated out)
uniform sampler2D tSpec;       // filtered specular + emissive + fog inscatter
uniform sampler2D tAlbedo;     // *accumulated* diffuse albedo, not the G-buffer's
void main() {
  // Mean times mean. Both factors are averages over the same jittered samples, so an edge
  // pixel gets the blend of two surfaces in each — which is what makes the product
  // anti-aliased rather than merely noisy. The trace pass already folded (1 - metal) in.
  oColor = vec4(texture(tAlbedo, vUv).rgb * texture(tColor, vUv).rgb + texture(tSpec, vUv).rgb, 1.0);
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
