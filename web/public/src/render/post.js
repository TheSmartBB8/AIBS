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
uniform float uBlend;
void main() {
  vec3 c = texture(tCur, vUv).rgb;
  vec3 h = texture(tHist, vUv).rgb;
  // guard against NaN/Inf leaking into the history and poisoning it forever
  c = clamp(c, vec3(0.0), vec3(2048.0));
  if (!(c.r == c.r)) c = vec3(0.0);
  oColor = vec4(mix(h, c, uBlend), 1.0);
}`;

// ---------------------------------------------------------------- edge-aware cleanup
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
void main() {
  vec3 c0 = texture(tColor, vUv).rgb;
  if (uStrength <= 0.001) { oColor = vec4(c0, 1.0); return; }
  vec4 n0 = texture(tNormal, vUv);
  vec3 p0 = texture(tPosition, vUv).xyz;
  float sum = 1.0;
  vec3 acc = c0;
  const float k[3] = float[3](1.0, 0.66, 0.24);
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      if (x == 0 && y == 0) continue;
      vec2 uv = vUv + vec2(float(x), float(y)) * uTexel * uStep;
      vec4 n = texture(tNormal, uv);
      vec3 p = texture(tPosition, uv).xyz;
      float wn = pow(max(dot(n.xyz, n0.xyz), 0.0), 24.0);
      float wp = exp(-length(p - p0) * 14.0);
      float w = k[abs(x)] * k[abs(y)] * wn * wp;
      acc += texture(tColor, uv).rgb * w;
      sum += w;
    }
  }
  oColor = vec4(mix(c0, acc / sum, uStrength), 1.0);
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
  vec3 c = texture(tColor, vUv).rgb;
  c += texture(tBloom, vUv).rgb * uBloom;
  c *= uExposure;
  c = acesFitted(c);

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
