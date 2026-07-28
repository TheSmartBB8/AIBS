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

uniform vec2  uRes;
uniform vec3  uCamPos;
uniform mat4  uInvViewProj;
uniform float uVoxel;
uniform float uFrameSeed;

uniform float uSunPower;
uniform float uSunSoftness;
uniform float uAoRange;      // voxels — how fast ambient recovers with distance
uniform float uGiRange;      // voxels — how far the indirect ray actually looks
uniform float uAoStrength;
uniform float uBakedAoMix;
uniform float uBounce;
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
${PALETTE}
${TRACE}

vec3 srgbToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

vec3 rayFromUv(vec2 uv) {
  vec4 h = uInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(h.xyz / h.w - uCamPos);
}

// Cheap stand-in for the radiance leaving a surface we hit with a secondary ray:
// sky ambient over the hemisphere plus its own emission. Used inside reflections so a
// blocked reflection darkens toward the real colour of the blocker instead of to black.
// skyScale exists because this function serves two callers with different needs, and the
// single value it used to hardcode was chosen for only one of them.
//
// The 0.55 was tuned as a stand-in for reflections, where the job is "don't go black" and
// being dim is harmless. As the indirect bounce it is a 45% cut to the only thing lighting
// an interior: indoors every bounce ray hits a wall that is not sun-facing, so the
// (correct) shadow test contributes nothing and this ambient term is all that is left.
// The first render after switching the bounce over showed exactly that — a room lit to
// near-black with an oversaturated red ceiling, because the little light remaining was
// arriving almost entirely as brick-coloured bounce.
vec3 secondaryShade(vec3 p, vec3 n, float pal, bool doSun, float skyScale) {
  vec4 pc = palColor(pal);
  vec3 alb = srgbToLinear(pc.rgb);
  vec3 amb = skyRadiance(normalize(n + vec3(0.0, 0.55, 0.0))) * skyScale;
  vec3 c = alb * amb;
  if (doSun) {
    vec3 S = sunDirTo();
    float nl = dot(n, S);
    if (nl > 0.0) {
      // Quarter-voxel, matching the primary sun ray's offset above rather than the 0.05
      // this used. That number was survivable while only reflections called this — a
      // reflection hit that self-shadows loses a highlight nobody misses. It is not
      // survivable now the indirect bounce comes through here: 0.05 voxels is 5 mm, the
      // first volFetch can land back in the originating voxel, and the bounce then reads
      // as shadowed precisely where the surface is most brightly lit.
      float d = traceShadow(p + n * 0.25, S, 400.0, 160);
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

  vec3 V = normalize(uCamPos - P);

  // ---------------------------------------------------------------- sun
  //
  // The sun is sampled explicitly for *both* lobes. Specular used to be left entirely to
  // the GGX reflection ray below, which meant a highlight only appeared when that one ray
  // happened to land on the sun disc — a fraction of a percent of the time on car paint.
  // Averaged over hundreds of samples that is unbiased and correct; at the 6-20 samples an
  // interactive frame has, it is the difference between painted metal and matte plastic.
  // Sampling the light directly instead gives a stable highlight from the very first
  // frame, and reuses the shadow ray the diffuse term already paid for.
  vec3 direct = vec3(0.0);
  vec3 sunSpec = vec3(0.0);
  vec3 S = sunDirTo();
  {
    float cosMax = cos(uSunAngle * uSunSoftness);
    vec3 L = sampleCone(S, cosMax, rnd2());
    float NoL = dot(N, L);
    if (NoL > 0.0) {
      // Transmittance rather than a binary occlusion test. Glass is an ordinary voxel to
      // traceShadow, so every window in the level used to block the sun completely and
      // interiors could not be lit through them at all. This is what puts a shaft of
      // sunlight on an interior floor.
      vec3 T = traceTransmit(ro, L, 512.0, 320);
      if (max(T.r, max(T.g, T.b)) > 0.002) {
        vec3 E = uSunColor * uSunPower * NoL * T;
        direct += E;
        // Clamped for the same reason the reflection weight is: a near-grazing view of a
        // smooth surface sends the BRDF to hundreds and leaves a permanent white speck.
        sunSpec += E * min(specularBRDF(N, V, L, rough, F0), vec3(8.0));
      }
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
    if (d >= dist - uLightRadius[i] * 0.02) {
      direct += contrib;
      // Lamps get a highlight too. No double-counting risk here: the reflection ray only
      // ever sees emissive *surfaces*, and secondaryShade does not evaluate point lights.
      sunSpec += contrib * min(specularBRDF(N, V, Ld, rough, F0), vec3(8.0));
    }
  }

  // ---------------------------------------------------------------- ambient / AO
  vec3 amb = vec3(0.0);
  for (int i = 0; i < AO_RAYS; i++) {
    vec3 D = cosineHemisphere(N, rnd2());
    // Trace to the *GI* range, not the AO range. These were one number, and it could not
    // be right for both jobs at once: the comment on aoRange records losing contact
    // darkening under debris at 46 voxels and losing the street canyon entirely at 12, and
    // the value that survived that squeeze (22, i.e. 2.2 m) is shorter than the street is
    // wide. So light bouncing off the sunlit facade never reached the terrace opposite —
    // the ray simply stopped in mid-air 40 cm short and was counted as open sky.
    //
    // They are different physical quantities. How quickly a surface stops being occluded
    // is a contact-shadow question and wants a short scale; how far away a surface can be
    // and still throw light at you is a transport question and wants a long one.
    VHit h = traceVoxels(ro, D, uGiRange, 160);
    if (!h.hit) {
      amb += skyRadiance(D);
    } else {
      // "the farther the ray travels, the more ambient lighting is used"
      float f = clamp(h.t / uAoRange, 0.0, 1.0);
      f = f * f * (3.0 - 2.0 * f);
      amb += skyRadiance(D) * f;
      if (uBounce > 0.0) {
        // A real second bounce. This used to weight the blocker's albedo by how sun-facing
        // it was and multiply by uBounceSun — "the discount for not knowing whether it is
        // really in sun". That guess is wrong in both directions at once: a wall in shadow
        // still bounced 40% of full sunlight into the room, and a wall in full sun bounced
        // only 40% of what it should. The two errors do not cancel, they just flatten the
        // indirect until every shaded surface sits at the same middling brightness.
        //
        // secondaryShade traces the blocker's own shadow ray, so now the bounce carries
        // sunlight only where sunlight actually lands. That is what produces real colour
        // bleeding — a red wall throwing red onto the pavement beside it, and nothing
        // where the wall is shaded.
        vec3 hp = ro + D * h.t;
        amb += secondaryShade(hp, h.n, h.pal, true, 1.0) * uBounce * (1.0 - f * 0.5);
      }
    }
  }
  amb *= uAoStrength / float(AO_RAYS);
  amb *= mix(1.0, bakedAo, uBakedAoMix);

  // ---------------------------------------------------------------- specular
  // Everything *except* the sun: the sky, the backdrop, and other geometry. The sun is
  // handled above, so this ray must not see it again — hence envAmbient rather than
  // envRadiance when it escapes.
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
          Li = envAmbient(P, R);
        } else {
          vec3 hp = ro + R * rh.t;
          Li = secondaryShade(hp, rh.n, rh.pal, rough < 0.45, 0.55);
        }
        spec = Li * w;
      }
    }
  }

  vec3 color = diffAlb * (direct + amb) + spec + sunSpec + albedo * emissive * uEmissivePower;

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
