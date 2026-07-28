// trace.js — the raytraced lighting pass. This is the whole look of the renderer.
//
// One fullscreen pass reads the G-buffer and, for every pixel, fires:
//   * one sun ray, jittered inside the sun's angular cone   -> soft, contact-hardening
//     shadows whose penumbra widens naturally with occluder distance;
//   * N cosine-weighted hemisphere rays -> ambient occlusion where the *distance the
//     ray travelled* sets how much sky it collects, not a binary hit test. This is what
//     gives corners a soft gradient instead of a dirt ring;
//   * one GGX-importance-sampled reflection ray -> specular + specular occlusion. With
//     no GI in the engine, reflections escaping to the sky are what stop metal and
//     glass from reading as matte plastic;
//   * one shadow ray per emissive light cluster.
//
// Every one of those is a *single sample* — the result is deliberately noisy and gets
// resolved by temporal accumulation (accum.js). With a static camera it converges to a
// ground-truth-quality image in ~100 frames.

import * as THREE from 'three';
import { RANDOM, SKY, ENVIRONMENT, TRACE, PALETTE, FULLSCREEN_VERT } from './shaders/common.js';

export const TRACE_FRAG = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler3D;

varying vec2 vUv;
layout(location = 0) out vec4 oColor;

uniform sampler2D tAlbedo;
uniform sampler2D tNormal;
uniform sampler2D tPosition;
uniform sampler2D uPalPbr;

uniform vec2  uRes;
uniform vec3  uCamPos;
uniform mat4  uInvViewProj;
uniform float uVoxel;
uniform float uFrameSeed;

uniform float uSunPower;
uniform float uSunSoftness;
uniform float uAoRange;      // voxels
uniform float uAoStrength;
uniform float uBakedAoMix;
uniform float uBounce;
uniform float uBounceSun;
uniform float uSpecRange;    // voxels
uniform float uEmissivePower;
uniform float uFogDensity;
uniform float uFogHeight;

uniform int   uNumLights;
uniform vec3  uLightPos[8];    // voxel space
uniform vec3  uLightColor[8];  // linear rgb * power
uniform float uLightRadius[8]; // voxels

${RANDOM}
${SKY}
${ENVIRONMENT}
${TRACE}
${PALETTE}

vec3 srgbToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

vec3 rayFromUv(vec2 uv) {
  vec4 h = uInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(h.xyz / h.w - uCamPos);
}

// Cheap stand-in for the radiance leaving a surface we hit with a secondary ray:
// sky ambient over the hemisphere plus its own emission. Used inside reflections so a
// blocked reflection darkens toward the real colour of the blocker instead of to black.
vec3 secondaryShade(vec3 p, vec3 n, float pal, bool doSun) {
  vec4 pc = palColor(pal);
  vec3 alb = srgbToLinear(pc.rgb);
  vec3 amb = skyRadiance(normalize(n + vec3(0.0, 0.55, 0.0))) * 0.55;
  vec3 c = alb * amb;
  if (doSun) {
    vec3 S = sunDirTo();
    float nl = dot(n, S);
    if (nl > 0.0) {
      float d = traceShadow(p + n * 0.05, S, 400.0, 160);
      if (d >= 400.0) c += alb * uSunColor * uSunPower * nl;
    }
  }
  c += alb * pc.a * 8.0 * uEmissivePower;
  return c;
}

void main() {
  vec4 nrm = texture(tNormal, vUv);
  vec3 rayDir = rayFromUv(vUv);

  if (dot(nrm.xyz, nrm.xyz) < 0.25) {          // missed the volume entirely
    oColor = vec4(envRadiance(uCamPos, rayDir), 1.0);
    return;
  }

  vec4 alb4 = texture(tAlbedo, vUv);
  vec4 pos4 = texture(tPosition, vUv);
  vec3 albedo = alb4.rgb;
  float emissive = alb4.a;
  vec3 P = pos4.xyz;
  float pal = pos4.w;
  vec3 N = normalize(nrm.xyz);
  float bakedAo = nrm.w;

  vec4 pbr = texture(uPalPbr, vec2((pal + 0.5) / 256.0, 0.5));
  float rough = max(pbr.r, 0.035);
  float metal = pbr.g;
  float f0d   = pbr.b;
  vec3  F0 = mix(vec3(f0d), albedo, metal);
  vec3  diffAlb = albedo * (1.0 - metal);

  vec3 Pv = P / uVoxel;
  vec3 ro = Pv + N * 0.25;   // quarter-voxel. At 0.03 (3 mm) the shadow ray's first
                             // volFetch can land back inside the originating voxel, which
                             // showed up as isolated black pixels on flat sunlit ground.

  seedRng(uvec3(uvec2(gl_FragCoord.xy), uint(uFrameSeed)));

  // ---------------------------------------------------------------- sun
  vec3 direct = vec3(0.0);
  vec3 S = sunDirTo();
  {
    float cosMax = cos(uSunAngle * uSunSoftness);
    vec3 L = sampleCone(S, cosMax, rnd2());
    float NoL = dot(N, L);
    if (NoL > 0.0) {
      float d = traceShadow(ro, L, 512.0, 320);
      if (d >= 512.0) direct += uSunColor * uSunPower * NoL;
    }
  }

  // ---------------------------------------------------------------- emissive lights
  for (int i = 0; i < 8; i++) {
    if (i >= uNumLights) break;
    vec3 lp = uLightPos[i] + (cosineHemisphere(normalize(Pv - uLightPos[i] + 1e-4), rnd2())) * uLightRadius[i];
    vec3 dv = lp - Pv;
    float dist = length(dv);
    vec3 Ld = dv / max(dist, 1e-4);
    float NoL = dot(N, Ld);
    if (NoL <= 0.0) continue;
    float dm = dist * uVoxel;
    float atten = 1.0 / (1.0 + dm * dm);
    vec3 contrib = uLightColor[i] * (NoL * atten);
    if (max(contrib.r, max(contrib.g, contrib.b)) < 0.002) continue;
    float d = traceShadow(ro, Ld, dist - uLightRadius[i] * 0.02, 220);
    if (d >= dist - uLightRadius[i] * 0.02) direct += contrib;
  }

  // ---------------------------------------------------------------- ambient / AO
  vec3 amb = vec3(0.0);
  for (int i = 0; i < AO_RAYS; i++) {
    vec3 D = cosineHemisphere(N, rnd2());
    VHit h = traceVoxels(ro, D, uAoRange, 128);
    if (!h.hit) {
      amb += skyRadiance(D);
    } else {
      // "the farther the ray travels, the more ambient lighting is used"
      float f = clamp(h.t / uAoRange, 0.0, 1.0);
      f = f * f * (3.0 - 2.0 * f);
      amb += skyRadiance(D) * f;
      if (uBounce > 0.0) {
        // What the blocker bounces back. Using sky alone made every bounce cold and weak:
        // in a real street the shaded side is lit mostly by *sunlight* coming off the
        // sunlit facade opposite, which is why shaded walls read warm rather than blue.
        // Weighted by how sun-facing the blocker is, with no shadow ray of its own —
        // uBounceSun is the discount for not knowing whether it is really in sun.
        vec4 hc = palColor(h.pal);
        float sunFacing = max(dot(h.n, S), 0.0);
        vec3 incident = skyRadiance(vec3(0.0, 1.0, 0.0))
                      + uSunColor * uSunPower * sunFacing * uBounceSun;
        amb += srgbToLinear(hc.rgb) * incident * uBounce * (1.0 - f * 0.5);
      }
    }
  }
  amb *= uAoStrength / float(AO_RAYS);
  amb *= mix(1.0, bakedAo, uBakedAoMix);

  // ---------------------------------------------------------------- specular
  vec3 V = normalize(uCamPos - P);
  vec3 spec = vec3(0.0);
  {
    vec3 H = sampleGGX(N, rough, rnd2());
    vec3 R = reflect(-V, H);
    float NoR = dot(N, R);
    if (NoR > 0.0) {
      float NoV = max(dot(N, V), 1e-4);
      float NoH = max(dot(N, H), 1e-4);
      float VoH = max(dot(V, H), 1e-4);
      float a = rough * rough;
      vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
      float G = smithG1(NoV, a) * smithG1(max(NoR, 1e-4), a);
      vec3 w = min(F * (G * VoH / (NoV * NoH)), vec3(6.0));
      if (max(w.r, max(w.g, w.b)) > 0.004) {
        VHit rh = traceVoxels(ro, R, uSpecRange, 192);
        vec3 Li;
        if (!rh.hit) {
          // The backdrop reflects too — without it, every window and puddle looking
          // downward-and-outward mirrored a slab of empty sky where ground should be.
          Li = envRadiance(P, R);
        } else {
          vec3 hp = ro + R * rh.t;
          Li = secondaryShade(hp, rh.n, rh.pal, rough < 0.45);
        }
        spec = Li * w;
      }
    }
  }

  vec3 color = diffAlb * (direct + amb) + spec + albedo * emissive * uEmissivePower;

  // ---------------------------------------------------------------- aerial perspective
  float dist = length(P - uCamPos);
  float hf = exp(-max(P.y - uFogHeight, 0.0) * 0.10);
  float fog = 1.0 - exp(-dist * uFogDensity * hf);
  // Fade toward what is actually *behind* this surface, not toward the sky. Geometry
  // below the horizon used to haze out to a pale sky colour, which lit up the base of
  // every distant building as if it were floating.
  color = mix(color, envAmbient(uCamPos, rayDir), clamp(fog, 0.0, 1.0));

  oColor = vec4(color, 1.0);
}`;

export function createTraceMaterial(uniforms, aoRays) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: TRACE_FRAG,
    uniforms,
    defines: { AO_RAYS: aoRays },
    depthTest: false,
    depthWrite: false,
  });
}
