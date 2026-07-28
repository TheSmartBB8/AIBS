// renderer.js — Teardown-style raytraced voxel renderer.
//
// Pipeline, per frame:
//   1. Raster the greedy chunk meshes into a 3-attachment G-buffer, with the projection
//      matrix jittered sub-pixel by a Halton sequence.
//   2. One fullscreen pass raytraces the actual lighting against the voxel volume:
//      cone-jittered sun shadow, distance-weighted hemisphere AO, GGX reflection ray,
//      one ray per emissive light cluster. Exactly one sample per effect per pixel.
//   3. Average that into a float history buffer. Because the projection jitter moves
//      with the sample index, this single mechanism resolves both the Monte-Carlo noise
//      and the geometric aliasing. Any camera or world change resets it.
//   4. Edge-aware cleanup (only while the history is thin), bloom, ACES, vignette.
//
// There are no shadow maps, no lightmaps, no SSAO and no baked GI anywhere — every
// shadow and every bounce of ambient in the image came from a ray walked through the
// voxel grid this frame, which is exactly how the real game does it.
//
// Contract used by main.js: `camera`, `stats`, `setSize`, `updateMeshes`, `render`.

import * as THREE from 'three';
import { meshChunk } from '../voxel/mesher.js';
import { CHUNK, VOXEL } from '../voxel/world.js';
import { MATERIALS, MAT } from '../voxel/palette.js';
import { VoxelVolume, findEmissiveLights } from './volume.js';
import { GBUFFER_VERT, GBUFFER_FRAG, createGBufferTarget } from './gbuffer.js';
import { createTraceMaterial } from './trace.js';
import { BodyRenderer } from './bodies.js';
import { ParticleRenderer } from './particles.js';
import {
  makeQuad, hdrTarget, fsMaterial,
  ACCUM_FRAG, DENOISE_FRAG, BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, COMPOSITE_FRAG,
} from './post.js';

// How metallic each material behaves. Painted sheet metal is not a mirror, so METAL sits
// well below 1 — it keeps its diffuse colour and gains a sheen, which is what car bodies
// and roller doors look like in Teardown.
const METALNESS = {
  [MAT.METAL]: 0.55,
  [MAT.HEAVY_METAL]: 0.72,
};

// What counts as a body actually moving, rather than merely existing.
//
// These have to clear the velocity ripple a spring-supported body shows at equilibrium.
// A parked car is not still: the suspension pushes up and gravity pulls down within each
// substep, so its velocity oscillates by roughly g*h — 0.167 m/s at 120 Hz — and measured
// peaks are 0.19 m/s and 0.76 rad/s. Thresholds below that make every parked car in the
// level read as motion forever, which pins the temporal accumulator and leaves the whole
// image grainy for the entire session. tests/vehicle.test.mjs asserts the margin holds.
export const MOTION_SPEED = 0.35;      // m/s
export const MOTION_SPIN = 1.2;        // rad/s
const MOTION_V2 = MOTION_SPEED * MOTION_SPEED;
const MOTION_W2 = MOTION_SPIN * MOTION_SPIN;

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

export const DEFAULTS = {
  // A low, warm sun is the single most recognisable thing about Teardown's lighting.
  // Degrees. This runs the sun roughly *down* the street rather than across it, and that
  // is not a taste call — at 208 the sun crossed the road, so a 3-4 storey terrace 2.6 m
  // away put the entire carriageway, and every car parked on it, in its own shadow. No
  // camera angle or ambient tweak fixes a street that is 100% in shade; measured side by
  // side, 208 renders the car's front face and the road black, 275 renders both lit.
  sunAzimuth: 275,
  sunElevation: 23,       // degrees above the horizon
  sunColor: [1.0, 0.76, 0.50],
  sunPower: 3.9,
  sunAngle: 0.008,        // angular RADIUS. 0.030 = a 3.4 deg sun disc, ~6x the real sun,
                          // which smeared every shadow into a shapeless bruise.
  sunSoftness: 1.0,

  skyZenith: [0.045, 0.12, 0.34],
  skyHorizon: [0.60, 0.62, 0.66],
  skyGround: [0.16, 0.145, 0.125],
  skyIntensity: 1.40,
  sunTint: [0.85, 0.55, 0.30],

  aoRays: 2,
  aoRange: 22,            // voxels (2.2 m). 46 stretched the gradient over 4.6 m so contact
                          // darkening under debris vanished; 12 was the opposite failure —
                          // anything more than 1.2 m from another surface counted as fully
                          // open sky, so a street canyon got no canyon at all.
  giRange: 64,            // voxels (6.4 m) — how far an indirect ray looks for a bouncer.
                          // Separate from aoRange because they are different questions:
                          // occlusion falloff is a contact-shadow scale, transport is not.
                          // 6.4 m clears the 2.6 m street with room for the facade behind,
                          // which is the bounce that lights the shaded side of the road.
  aoStrength: 1.0,
  bakedAoMix: 0.45,
  bounce: 1.30,           // albedo-tinted sky bounce. Interiors were collapsing to pure
                          // black: indoors every AO ray hits, so ambient went to zero and
                          // nothing but this term lights a room through its openings.
                          // It is also the only thing lighting the shaded side of a street.
  specRange: 300,
  emissivePower: 1.0,
  lightScale: 0.22,
  voxelEdge: 0.16,        // seam darkening between adjacent voxels — the strongest cue
                          // that a merged quad is actually made of cubes.
  voxelNoise: 0.16,       // per-voxel grain. At 0.055 a greedy-merged wall still read as
                          // flat painted vinyl; Teardown surfaces always show the cubes.

  fogDensity: 0.011,      // aerial perspective. At 0.0075 fog was measurably doing nothing
                          // (far ground within 3 luma of near), so the scene stayed uniformly
                          // sharp to the horizon and read as a tabletop diorama.
  fogHeight: 7.0,

  // Analytic backdrop beyond the voxel volume. See ENVIRONMENT in shaders/common.js.
  // horizonY must match the level's ground surface (groundY * VOXEL) or the join shows.
  horizonY: 1.2,
  groundNear: [0.105, 0.200, 0.045],   // linear; the level's grass, so the seam is invisible
  groundFar: [0.045, 0.085, 0.030],    // woodland / ploughed patches
  hillColor: [0.085, 0.115, 0.135],
  hillHeight: 0.062,      // tangent of the ridge elevation — about 3.5 degrees. At 0.032
                          // the bands were ~13 px tall at review resolution and the horizon
                          // still read as a ruled line.
  envFog: 0.0035,         // much slacker than fogDensity: the backdrop must survive to the
                          // horizon rather than dissolving a hundred metres out. At 0.0075
                          // the countryside just past the world edge was already 20% haze,
                          // which desaturated it to grey and re-created the void it replaced.

  exposure: 1.18,
  bloom: 0.22,
  bloomThreshold: 1.75,
  bloomKnee: 0.35,
  vignette: 0.25,
  saturation: 0.95,       // the sRGB->linear decode already expands chroma; Teardown's
                          // palette is dusty, not toybox.
  contrast: 1.03,
  lift: 0.0,

  maxSamples: 512,
  denoise: 1,
  denoisePasses: 5,       // 5x5 taps at spacing 1,2,4,8,16 — an 81x81 effective support
  denoisePhiL: 4.0,       // how many standard deviations of luminance count as "the same
                          // surface". Below ~2 the filter refuses to cross its own noise
                          // and grain survives every pass; above ~8 it starts eating
                          // contact shadows under the parked cars.
  denoiseUntil: 256,      // past this the mean is its own answer and the filter is a
                          // no-op that still costs a full-screen pass.

  // How much history survives while something in the scene is moving. Debris and smoke
  // used to throw the whole accumulation away every frame, so the moment you destroyed
  // anything the image dropped to a single sample per pixel and stayed there for as long
  // as the rubble kept twitching — the noisiest the renderer ever looks is exactly when
  // the player is looking hardest. Holding a few frames of history, with neighbourhood
  // clamping to stop it smearing, is worth far more than the mean it gives up.
  motionSamples: 6,
};

export class VoxelRenderer {
  constructor(canvas, world, palette, opts = {}) {
    this.world = world;
    this.palette = palette;
    this.params = { ...DEFAULTS, ...opts };

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance',
      alpha: false, stencil: false, depth: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the composite encodes itself

    const gl = this.renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.renderer.getContext().getExtension('EXT_color_buffer_float');
    this.renderer.getContext().getExtension('OES_texture_float_linear');

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 400);

    // ---- palette textures
    this.palColTex = new THREE.DataTexture(palette.toColorTextureData(), 256, 1, THREE.RGBAFormat);
    this.palMatTex = new THREE.DataTexture(palette.toMaterialTextureData(), 256, 1, THREE.RGBAFormat);
    this.palPbrTex = new THREE.DataTexture(this._buildPbrData(), 256, 1, THREE.RGBAFormat);
    for (const t of [this.palColTex, this.palMatTex, this.palPbrTex]) {
      t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false; t.needsUpdate = true;
    }

    this.volume = new VoxelVolume(world);
    this.lights = [];

    this._initUniforms();
    this._initMaterials();

    this.chunkGroup = new THREE.Group();
    this.scene.add(this.chunkGroup);
    this.meshes = new Map();

    // Detached chunks in flight. They go into the same scene as the static geometry so
    // they are rasterised into the same G-buffer and receive identical raytraced lighting.
    this.bodyRenderer = new BodyRenderer(palette, this.gbufMaterial);
    this.scene.add(this.bodyRenderer.group);

    // Smoke/dust/fire. Drawn forward over the composited image rather than into the
    // G-buffer, because they are transparent and the deferred pass has nowhere to put them.
    this.particleRenderer = new ParticleRenderer();
    this._particleInst = null;

    this.width = 960; this.height = 540;
    this._allocTargets(this.width, this.height);

    this.samples = 0;
    this._camKey = '';
    this._volVersion = -1;
    this._frozenTime = null;   // null = read the wall clock; see freezeTime()
    this.stats = { chunks: 0, triangles: 0, lastMeshMs: 0, samples: 0, frameMs: 0 };

    this._baseProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this.quad = makeQuad();
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.Camera();

    this.applyParams();
  }

  // ---------------------------------------------------------------- setup
  _buildPbrData() {
    const d = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const mi = this.palette.mat[i];
      const m = MATERIALS[mi] || MATERIALS[0];
      const rough = Math.min(1, Math.max(0.03, 1 - m.smoothness));
      const metal = METALNESS[mi] ?? 0.0;
      const f0 = Math.min(0.11, 0.02 + m.reflectivity * 0.10);
      d[i * 4 + 0] = Math.round(rough * 255);
      d[i * 4 + 1] = Math.round(metal * 255);
      d[i * 4 + 2] = Math.round(f0 * 255);
      d[i * 4 + 3] = 255;
    }
    return d;
  }

  _initUniforms() {
    const vu = this.volume.uniforms();
    this.sunDir = new THREE.Vector3(0.42, -0.72, 0.33).normalize();

    this.shared = {
      ...vu,
      uPalCol: { value: this.palColTex },
      uPalMat: { value: this.palMatTex },
      uPalPbr: { value: this.palPbrTex },
      uSunDir: { value: this.sunDir },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uSunAngle: { value: 0.03 },
      uTime: { value: 0 },
      uSkyZenith: { value: new THREE.Vector3() },
      uSkyHorizon: { value: new THREE.Vector3() },
      uSkyGround: { value: new THREE.Vector3() },
      uSkyIntensity: { value: 1 },
      uSunTint: { value: new THREE.Vector3() },

      tAlbedo: { value: null },
      tNormal: { value: null },
      tPosition: { value: null },
      uRes: { value: new THREE.Vector2(960, 540) },
      uCamPos: { value: new THREE.Vector3() },
      uInvViewProj: { value: new THREE.Matrix4() },
      uVoxel: { value: VOXEL },
      uFrameSeed: { value: 0 },

      uSunPower: { value: 4.5 },
      uSunSoftness: { value: 1 },
      uAoRange: { value: 46 },
      uGiRange: { value: 64 },
      uAoStrength: { value: 1 },
      uBakedAoMix: { value: 0.45 },
      uBounce: { value: 0.28 },
      uSpecRange: { value: 300 },
      uEmissivePower: { value: 1 },
      uFogDensity: { value: 0.0075 },
      uFogHeight: { value: 3 },

      uHorizonY: { value: 1.2 },
      uGroundNear: { value: new THREE.Vector3() },
      uGroundFar: { value: new THREE.Vector3() },
      uHillColor: { value: new THREE.Vector3() },
      uHillHeight: { value: 0.032 },
      uEnvFog: { value: 0.0075 },

      uNumLights: { value: 0 },
      uLightPos: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
      uLightColor: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
      uLightRadius: { value: new Float32Array(8) },
    };

    this.gbufUniforms = {
      uPalCol: { value: this.palColTex },
      uVoxel: { value: VOXEL },
      uVoxelNoise: { value: this.params.voxelNoise },
      uVoxelEdge: { value: this.params.voxelEdge },
    };
  }

  _initMaterials() {
    this.gbufMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      uniforms: this.gbufUniforms,
      side: THREE.FrontSide,
    });

    this.traceMaterial = createTraceMaterial(this.shared, this.params.aoRays);

    this.accumMaterial = fsMaterial(ACCUM_FRAG, {
      tCur: { value: null }, tHist: { value: null }, uBlend: { value: 1 },
      uTexel: { value: new THREE.Vector2() }, uClamp: { value: 0 },
    });
    this.denoiseMaterial = fsMaterial(DENOISE_FRAG, {
      tColor: { value: null }, tNormal: { value: null }, tPosition: { value: null },
      uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 }, uStrength: { value: 0 },
      uM2: { value: 1 }, uSamples: { value: 1 },
      uPhiL: { value: 4.0 }, uPhiN: { value: 24.0 }, uPhiP: { value: 14.0 },
    });
    this.bloomPreMaterial = fsMaterial(BLOOM_PREFILTER_FRAG, {
      tColor: { value: null }, uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1 }, uKnee: { value: 0.6 },
    });
    this.bloomDownMaterial = fsMaterial(BLOOM_DOWN_FRAG, {
      tColor: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.bloomUpMaterial = fsMaterial(BLOOM_UP_FRAG, {
      tColor: { value: null }, tPrev: { value: null },
      uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
    });
    this.compositeMaterial = fsMaterial(COMPOSITE_FRAG, {
      tColor: { value: null }, tBloom: { value: null },
      uRes: { value: new THREE.Vector2(960, 540) },
      uExposure: { value: 1.1 }, uBloom: { value: 0.6 }, uVignette: { value: 0.4 },
      uSaturation: { value: 1.1 }, uContrast: { value: 1.05 }, uLift: { value: 0 },
    });
  }

  _allocTargets(w, h) {
    this._disposeTargets();
    this.gbuf = createGBufferTarget(w, h);
    this.traceRT = hdrTarget(w, h);
    this.accumRT = [hdrTarget(w, h, true), hdrTarget(w, h, true)];
    // Two, to ping-pong the à-trous passes. Float rather than half: alpha carries variance
    // of the mean, which at 100+ samples is a very small number multiplied by w*w again
    // every pass, and half-float flushes it to zero — at which point the filter reads
    // "converged" everywhere and stops, silently, exactly where it should be gentlest.
    this.denoiseRT = [hdrTarget(w, h, true), hdrTarget(w, h, true)];
    this.bloomRT = [];
    let bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
    for (let i = 0; i < 5; i++) {
      this.bloomRT.push(hdrTarget(bw, bh));
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
    }
    this.accumIdx = 0;
  }

  _disposeTargets() {
    const all = [this.gbuf, this.traceRT, ...(this.denoiseRT || []),
      ...(this.accumRT || []), ...(this.bloomRT || []), ...(this._scratch || [])];
    for (const rt of all) if (rt) rt.dispose();
    this._scratch = null;
  }

  // ---------------------------------------------------------------- public API
  applyParams() {
    const p = this.params;
    const s = this.shared;
    const az = p.sunAzimuth * Math.PI / 180, el = p.sunElevation * Math.PI / 180;
    // direction *toward* the sun, then stored as the direction light travels
    const toSun = new THREE.Vector3(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize();
    this.sunDir.copy(toSun).multiplyScalar(-1);
    s.uSunDir.value.copy(this.sunDir);
    s.uSunColor.value.set(...p.sunColor);
    s.uSunAngle.value = p.sunAngle;
    s.uSunSoftness.value = p.sunSoftness;
    s.uSunPower.value = p.sunPower;
    s.uSkyZenith.value.set(...p.skyZenith);
    s.uSkyHorizon.value.set(...p.skyHorizon);
    s.uSkyGround.value.set(...p.skyGround);
    s.uSkyIntensity.value = p.skyIntensity;
    s.uSunTint.value.set(...p.sunTint);
    s.uAoRange.value = p.aoRange;
    s.uGiRange.value = p.giRange;
    s.uAoStrength.value = p.aoStrength;
    s.uBakedAoMix.value = p.bakedAoMix;
    s.uBounce.value = p.bounce;
    s.uSpecRange.value = p.specRange;
    s.uEmissivePower.value = p.emissivePower;
    s.uFogDensity.value = p.fogDensity;
    s.uFogHeight.value = p.fogHeight;
    s.uHorizonY.value = p.horizonY;
    s.uGroundNear.value.set(...p.groundNear);
    s.uGroundFar.value.set(...p.groundFar);
    s.uHillColor.value.set(...p.hillColor);
    s.uHillHeight.value = p.hillHeight;
    s.uEnvFog.value = p.envFog;
    this.gbufUniforms.uVoxelNoise.value = p.voxelNoise;
    this.gbufUniforms.uVoxelEdge.value = p.voxelEdge;

    if (this.traceMaterial.defines.AO_RAYS !== p.aoRays) {
      this.traceMaterial.defines.AO_RAYS = p.aoRays;
      this.traceMaterial.needsUpdate = true;
    }

    const c = this.compositeMaterial.uniforms;
    c.uExposure.value = p.exposure;
    c.uBloom.value = p.bloom;
    c.uVignette.value = p.vignette;
    c.uSaturation.value = p.saturation;
    c.uContrast.value = p.contrast;
    c.uLift.value = p.lift;
    this.bloomPreMaterial.uniforms.uThreshold.value = p.bloomThreshold;
    this.bloomPreMaterial.uniforms.uKnee.value = p.bloomKnee;

    this._applyLights();
    this.resetAccumulation();
  }

  set(key, value) { this.params[key] = value; this.applyParams(); return value; }

  setSunDirection(x, y, z) {
    this.sunDir.set(x, y, z).normalize();
    const t = this.sunDir.clone().multiplyScalar(-1);
    this.params.sunElevation = Math.asin(THREE.MathUtils.clamp(t.y, -1, 1)) * 180 / Math.PI;
    this.params.sunAzimuth = Math.atan2(t.x, t.z) * 180 / Math.PI;
    this.applyParams();
  }

  /** Rescan the world for glowing voxels and rebuild the point-light set. */
  rebuildLights() {
    this.lights = findEmissiveLights(this.world, this.palette, 8);
    this._applyLights();
    this.resetAccumulation();
    return this.lights;
  }

  /**
   * Merge transient gameplay lights (explosion flashes, muzzle flare, fire) with the
   * static emissive set for this frame. There are only 8 light slots, so transient
   * lights take priority — a blast going off matters more than a distant lamp — and the
   * static set fills whatever is left.
   */
  setLights(transient) {
    if (!transient || transient.length === 0) {
      if (this._hadTransient) { this._hadTransient = false; this.lights = this._staticLights || this.lights; this._applyLights(); }
      this._movingLights = false;
      return;
    }
    this._staticLights = this._staticLights || this.lights;
    const dyn = transient.slice(0, 8).map((L) => ({
      pos: L.pos,
      color: L.color,
      // fade the flash out over its lifetime instead of cutting it off abruptly
      power: L.intensity * Math.max(0, 1 - (L.age ?? 0) / Math.max(1e-3, L.ttl ?? 0.1)),
      radius: L.radius,
    }));
    this.lights = dyn.concat(this._staticLights.slice(0, Math.max(0, 8 - dyn.length)));
    this._hadTransient = true;
    this._applyLights();
    // A flash fades every frame, so a full reset here pins the image at one sample for
    // as long as anything is burning. Same treatment as debris: hold and clamp.
    this._movingLights = true;
    this.holdAccumulation();
  }

  /**
   * Sync the in-flight debris. Anything moving invalidates the accumulated history, so
   * this resets it — otherwise tumbling chunks smear across the temporal buffer.
   */
  setBodies(bodies, debris, vehicles) {
    this.bodyRenderer.update(bodies || [], debris, vehicles);
    // "Moving" has to mean actually moving, not merely present. The renderer's own
    // return value counts anything it drew, which was fine while bodies existed only
    // while they were in flight — and became wrong the moment parked vehicles started
    // living in the body list permanently. Every frame then reported motion, the
    // accumulator was pinned at motionSamples, and the whole image stayed grainy for
    // the entire session because there is always a car in the street.
    const list = bodies || [];
    let moving = (debris?.parts?.length || 0) > 0;
    for (let i = 0; !moving && i < list.length; i++) {
      const b = list[i];
      if (!b.alive) continue;
      if (b.v[0] * b.v[0] + b.v[1] * b.v[1] + b.v[2] * b.v[2] > MOTION_V2) moving = true;
      else if (b.w[0] * b.w[0] + b.w[1] * b.w[1] + b.w[2] * b.w[2] > MOTION_W2) moving = true;
    }
    this._movingBodies = moving || !!this._hadBodies;
    if (this._movingBodies) this.holdAccumulation();
    this._hadBodies = moving;
    return moving;
  }

  /** Hand in the fx layer's instance data for this frame. */
  setParticles(inst) {
    this._particleInst = inst;
    // Particles move every frame. They are drawn forward over the composited image, so
    // they never enter the history themselves — but the world behind them is being
    // relit as smoke shadows it, so the history is still partly stale.
    this._movingParticles = !!inst && ((inst.blend?.count | 0) + (inst.additive?.count | 0)) > 0;
    if (this._movingParticles) this.holdAccumulation();
  }

  _applyLights() {
    const s = this.shared;
    const n = Math.min(8, this.lights.length);
    s.uNumLights.value = n;
    for (let i = 0; i < n; i++) {
      const L = this.lights[i];
      s.uLightPos.value[i].set(L.pos[0], L.pos[1], L.pos[2]);
      const k = L.power * this.params.lightScale;
      s.uLightColor.value[i].set(
        Math.pow(L.color[0], 2.2) * k,
        Math.pow(L.color[1], 2.2) * k,
        Math.pow(L.color[2], 2.2) * k,
      );
      s.uLightRadius.value[i] = L.radius;
    }
  }

  /** Throw the history away. For anything that invalidates it wholesale: the camera
   *  moving, geometry being remeshed, a parameter change. */
  /**
   * Pin the clock the cloud layer reads, so successive accumulations render the same sky.
   * Pass null to go back to wall-clock time. See __app.freeze() for why this exists.
   */
  freezeTime(t) {
    this._frozenTime = t;
    this.resetAccumulation();
  }

  resetAccumulation() {
    this.samples = 0;
    this._movingBodies = false;
    this._movingParticles = false;
    this._movingLights = false;
  }

  /**
   * Something in the scene is animating. Keep a few frames of history rather than
   * discarding it, and turn on neighbourhood clamping so the part that is stale gets
   * rejected per pixel instead of smearing.
   */
  holdAccumulation() {
    this.samples = Math.min(this.samples, this.params.motionSamples);
  }

  /** True while debris, particles or a fading flash are live, so the history is partly stale. */
  get inMotion() { return !!(this._movingBodies || this._movingParticles || this._movingLights); }

  setSize(w, h) {
    w = Math.max(2, w | 0); h = Math.max(2, h | 0);
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._allocTargets(w, h);
    this.shared.uRes.value.set(w, h);
    this.compositeMaterial.uniforms.uRes.value.set(w, h);
    this.resetAccumulation();
  }

  // ---------------------------------------------------------------- meshing
  updateMeshes(budget = 0) {
    const t0 = performance.now();
    const w = this.world;
    let done = 0, tris = 0;
    outer:
    for (let cy = 0; cy < w.cy; cy++)
      for (let cz = 0; cz < w.cz; cz++)
        for (let cx = 0; cx < w.cx; cx++) {
          if (!w.chunkIsDirty(cx, cy, cz)) continue;
          if (budget && done >= budget) break outer;
          w.clearChunkDirty(cx, cy, cz);
          this._rebuildChunk(cx, cy, cz);
          done++;
        }
    for (const m of this.meshes.values()) tris += m.geometry.index
      ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
    this.stats.chunks = this.meshes.size;
    this.stats.triangles = tris;
    this.stats.lastMeshMs = performance.now() - t0;
    if (done > 0) this.resetAccumulation();
    if (!budget || done === 0) w.dirtyAll = false;
    return done;
  }

  _rebuildChunk(cx, cy, cz) {
    const key = `${cx},${cy},${cz}`;
    const old = this.meshes.get(key);
    const data = meshChunk(this.world, cx, cy, cz, CHUNK, VOXEL);
    if (!data) {
      if (old) { this.chunkGroup.remove(old); old.geometry.dispose(); this.meshes.delete(key); }
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    geo.setAttribute('aAo', new THREE.BufferAttribute(data.ao, 1));
    geo.setAttribute('aPal', new THREE.BufferAttribute(data.pal, 1));
    geo.computeBoundingSphere();
    if (old) { this.chunkGroup.remove(old); old.geometry.dispose(); }
    const mesh = new THREE.Mesh(geo, this.gbufMaterial);
    mesh.frustumCulled = true;
    this.chunkGroup.add(mesh);
    this.meshes.set(key, mesh);
  }

  // ---------------------------------------------------------------- frame
  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  _cameraKey() {
    const c = this.camera;
    const e = c.matrixWorld.elements;
    return `${e[12].toFixed(4)},${e[13].toFixed(4)},${e[14].toFixed(4)},` +
           `${e[0].toFixed(4)},${e[1].toFixed(4)},${e[2].toFixed(4)},` +
           `${e[4].toFixed(4)},${e[6].toFixed(4)},${e[8].toFixed(4)},${e[10].toFixed(4)},` +
           `${c.fov.toFixed(3)},${c.aspect.toFixed(4)}`;
  }

  render() {
    const t0 = performance.now();
    const cam = this.camera;
    cam.updateMatrixWorld(true);

    const key = this._cameraKey();
    if (key !== this._camKey) { this._camKey = key; this.resetAccumulation(); }

    if (this.volume.sync()) this.resetAccumulation();
    if (this.volume.version > 0 && this._volVersion < 0) {
      this._volVersion = this.volume.version;
      this.rebuildLights();
    }

    const p = this.params;
    // Clouds drift with wall-clock time, but the value is frozen while a still frame
    // accumulates — otherwise the sky would smear across the temporal history.
    if (this.samples === 0) {
      this.shared.uTime.value = this._frozenTime !== null && this._frozenTime !== undefined
        ? this._frozenTime : performance.now() * 0.001;
    }
    if (this.samples < p.maxSamples) {
      this._renderSample();
      this.samples++;
    }
    this._composite();

    this.stats.samples = this.samples;
    this.stats.frameMs = performance.now() - t0;
  }

  _renderSample() {
    const cam = this.camera;
    const w = this.width, h = this.height;
    const n = this.samples;

    // ---- sub-pixel jitter (Halton 2,3), shared by the raster and the trace
    cam.updateProjectionMatrix();
    this._baseProj.copy(cam.projectionMatrix);
    const jx = (halton(n + 1, 2) - 0.5) * 2.0 / w;
    const jy = (halton(n + 1, 3) - 0.5) * 2.0 / h;
    cam.projectionMatrix.elements[8] += jx;
    cam.projectionMatrix.elements[9] += jy;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    // ---- G-buffer
    this.renderer.setRenderTarget(this.gbuf);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, cam);

    // ---- trace
    const s = this.shared;
    s.tAlbedo.value = this.gbuf.textures[0];
    s.tNormal.value = this.gbuf.textures[1];
    s.tPosition.value = this.gbuf.textures[2];
    s.uCamPos.value.copy(cam.position);
    this._invViewProj.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    s.uInvViewProj.value.copy(this._invViewProj);
    s.uFrameSeed.value = n % 65536;
    s.uRes.value.set(w, h);
    this._blit(this.traceMaterial, this.traceRT);

    // restore the clean projection so anything else reading the camera sees no jitter
    cam.projectionMatrix.copy(this._baseProj);
    cam.projectionMatrixInverse.copy(this._baseProj).invert();

    // ---- accumulate
    const src = this.accumRT[this.accumIdx];
    const dst = this.accumRT[1 - this.accumIdx];
    const au = this.accumMaterial.uniforms;
    au.tCur.value = this.traceRT.texture;
    au.tHist.value = src.texture;
    au.uBlend.value = n === 0 ? 1.0 : 1.0 / (n + 1);
    au.uTexel.value.set(1 / w, 1 / h);
    // Clamp only while something is animating. On a still frame the running mean is the
    // whole point of the accumulator and clamping would bias it toward the newest sample.
    au.uClamp.value = this.inMotion ? 1.0 : 0.0;
    this._blit(this.accumMaterial, dst);
    this.accumIdx = 1 - this.accumIdx;
  }

  _composite() {
    const w = this.width, h = this.height;
    const p = this.params;
    let color = this.accumRT[this.accumIdx].texture;

    // ---- cleanup: variance-guided à-trous, doubling tap spacing each pass
    //
    // How hard each pass filters is decided per pixel by the measured variance, not here.
    // All this schedule does is buy back the GPU time: a converged frame gets almost
    // nothing out of five passes, because the weights have already collapsed to identity.
    const passes = this._denoisePasses(this.samples, p);
    if (passes > 0) {
      const du = this.denoiseMaterial.uniforms;
      du.tNormal.value = this.gbuf.textures[1];
      du.tPosition.value = this.gbuf.textures[2];
      du.uTexel.value.set(1 / w, 1 / h);
      du.uStrength.value = 1.0;
      du.uPhiL.value = p.denoisePhiL;
      du.uSamples.value = this.samples;
      for (let i = 0; i < passes; i++) {
        du.tColor.value = color;
        // Only the first pass reads the accumulator, whose alpha is a second moment;
        // after that alpha is variance and must not be squared out again.
        du.uM2.value = i === 0 ? 1 : 0;
        du.uStep.value = 1 << i;
        const dst = this.denoiseRT[i & 1];
        this._blit(this.denoiseMaterial, dst);
        color = dst.texture;
      }
    }

    // ---- bloom mip chain
    const bu = this.bloomPreMaterial.uniforms;
    bu.tColor.value = color;
    bu.uTexel.value.set(1 / w, 1 / h);
    this._blit(this.bloomPreMaterial, this.bloomRT[0]);
    for (let i = 1; i < this.bloomRT.length; i++) {
      const src = this.bloomRT[i - 1];
      this.bloomDownMaterial.uniforms.tColor.value = src.texture;
      this.bloomDownMaterial.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._blit(this.bloomDownMaterial, this.bloomRT[i]);
    }
    for (let i = this.bloomRT.length - 1; i > 0; i--) {
      const coarse = this.bloomRT[i];
      const fine = this.bloomRT[i - 1];
      // up-blur the coarse level and add it into the finer one, in place via a temp read
      this.bloomUpMaterial.uniforms.tColor.value = coarse.texture;
      this.bloomUpMaterial.uniforms.tPrev.value = fine.texture;
      this.bloomUpMaterial.uniforms.uTexel.value.set(1 / coarse.width, 1 / coarse.height);
      this.bloomUpMaterial.uniforms.uRadius.value = 1.0;
      this._blit(this.bloomUpMaterial, this._bloomScratch(i - 1));
      // swap scratch into place
      const t = this.bloomRT[i - 1];
      this.bloomRT[i - 1] = this._scratch[i - 1];
      this._scratch[i - 1] = t;
    }

    const cu = this.compositeMaterial.uniforms;
    cu.tColor.value = color;
    cu.tBloom.value = this.bloomRT[0].texture;
    cu.uRes.value.set(w, h);
    this.renderer.setRenderTarget(null);
    this._blit(this.compositeMaterial, null);

    // Particles go over the tonemapped image, occlusion-tested against the G-buffer's
    // world-position target. They are already in display space, so they are not bloomed —
    // an acceptable trade for smoke and dust, which are the point here.
    if (this._particleInst) {
      const n = this.particleRenderer.update(
        this._particleInst, this.gbuf.textures[2], this.camera, w, h);
      if (n > 0) {
        const prevAuto = this.renderer.autoClear;
        this.renderer.autoClear = false;
        this.particleRenderer.render(this.renderer, this.camera);
        this.renderer.autoClear = prevAuto;
      }
      this.stats.particles = n;
    }
  }

  /**
   * How many à-trous passes to run at a given sample count. Purely a cost schedule — the
   * per-pixel weights already retire the filter where the estimate has converged, so this
   * only decides how much GPU time to spend looking for the places it has not.
   */
  _denoisePasses(samples, p) {
    if (samples <= 0 || p.denoise <= 0) return 0;
    const max = p.denoisePasses;
    // Boundaries measured, not guessed — tools/rmse.mjs, against a 512-sample reference.
    //
    // Three passes at 32 samples came out neutral (+0.5%) while a single pass at 64 still
    // gained 15%, so the wide kernels stop paying for themselves somewhere between 16 and
    // 32. Moving that boundary from 48 to 32 was then confirmed rather than assumed: the
    // same view at 32 samples went from +0.5% to -23.7%.
    //
    // Measured on two deliberately opposite lighting regimes, because one view cannot
    // justify a global change. Sunlit street: -35/-26/-14/-24/-15% at 4/8/16/32/64.
    // Dim interior: -61/-52/-43/-37/-25%. The interior gains roughly twice as much, which
    // is the argument for variance-guidance over a sample-count ramp — no single schedule
    // serves both, and the per-pixel variance sorts it out without being told.
    if (samples < 4) return max;
    if (samples < 16) return Math.max(1, max - 1);
    if (samples < 32) return Math.max(1, max - 2);
    if (samples < p.denoiseUntil) return 1;
    return 0;
  }

  _bloomScratch(i) {
    if (!this._scratch) this._scratch = [];
    if (!this._scratch[i]) {
      const b = this.bloomRT[i];
      this._scratch[i] = hdrTarget(b.width, b.height);
    }
    return this._scratch[i];
  }
}
