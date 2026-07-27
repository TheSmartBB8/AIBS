// particles.js — draws the fx layer's smoke, dust, fire and sparks.
//
// The dust plume is the single most recognisable thing about Teardown's destruction —
// far more than the flying chunks. Without it a blast reads as a stain on a wall rather
// than as something that happened. The simulation was already producing these particles;
// nothing was drawing them.
//
// Occlusion without a depth texture: the G-buffer already stores world position per pixel,
// so a particle fragment samples tPosition at its own screen UV, compares camera distance,
// and discards where solid geometry is nearer. That gives correct sorting against the world
// without allocating or resolving a depth attachment.
//
// Two passes, because they must blend differently: smoke and dust are alpha-blended (they
// darken and obscure), fire and sparks are additive (they emit).

import * as THREE from 'three';

const MAX_PARTICLES = 8192;

const VERT = /* glsl */`
precision highp float;
attribute vec3 aOffset;     // world position
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aRot;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vWorld;
void main() {
  vUv = uv - 0.5;
  vColor = aColor;
  vAlpha = aAlpha;
  // camera-facing billboard, rotated in view space so smoke puffs don't all share an angle
  float c = cos(aRot), s = sin(aRot);
  vec2 r = vec2(vUv.x * c - vUv.y * s, vUv.x * s + vUv.y * c) * aSize;
  vec4 mv = viewMatrix * vec4(aOffset, 1.0);
  mv.xy += r;
  vWorld = aOffset;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vWorld;
uniform sampler2D tPosition;   // G-buffer world position (w = palette, 0 = sky)
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform float uSoft;
void main() {
  float d = length(vUv) * 2.0;
  if (d > 1.0) discard;
  // soft round falloff — a hard-edged circle reads as a sprite, not as vapour
  float a = vAlpha * pow(1.0 - d, 1.6);
  if (a < 0.004) discard;

  // occlude against the scene: if solid geometry at this pixel is closer than the
  // particle, the particle is behind it
  vec4 P = texture2D(tPosition, gl_FragCoord.xy / uRes);
  if (P.w > 0.0) {
    float sceneDist = length(P.xyz - uCamPos);
    float partDist  = length(vWorld - uCamPos);
    if (sceneDist < partDist) discard;
    // fade as it approaches the surface so puffs don't slice through walls
    a *= clamp((sceneDist - partDist) * uSoft, 0.0, 1.0);
  }
  gl_FragColor = vec4(vColor, a);
}`;

function makeLayer(blending, depthWrite) {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aRot', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1).setUsage(THREE.DynamicDrawUsage));
  geo.instanceCount = 0;

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: {
      tPosition: { value: null },
      uRes: { value: new THREE.Vector2(960, 540) },
      uCamPos: { value: new THREE.Vector3() },
      uSoft: { value: 2.5 },
    },
    transparent: true, depthTest: false, depthWrite,
    blending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { geo, mat, mesh };
}

export class ParticleRenderer {
  constructor() {
    this.blend = makeLayer(THREE.NormalBlending, false);
    this.additive = makeLayer(THREE.AdditiveBlending, false);
    this.scene = new THREE.Scene();
    // additive last so emissive sits over the smoke it is lighting
    this.scene.add(this.blend.mesh);
    this.scene.add(this.additive.mesh);
    this.count = 0;
  }

  _fill(layer, src) {
    const n = Math.min(src.count | 0, MAX_PARTICLES);
    if (n > 0) {
      layer.geo.attributes.aOffset.array.set(src.position.subarray(0, n * 3));
      layer.geo.attributes.aColor.array.set(src.color.subarray(0, n * 3));
      layer.geo.attributes.aSize.array.set(src.size.subarray(0, n));
      layer.geo.attributes.aAlpha.array.set(src.alpha.subarray(0, n));
      layer.geo.attributes.aRot.array.set(src.rotation.subarray(0, n));
      for (const k of ['aOffset', 'aColor', 'aSize', 'aAlpha', 'aRot'])
        layer.geo.attributes[k].needsUpdate = true;
    }
    layer.geo.instanceCount = n;
    return n;
  }

  /** @param inst result of ParticleSystem.buildInstances() */
  update(inst, positionTex, camera, width, height) {
    if (!inst) { this.count = 0; return 0; }
    const a = this._fill(this.blend, inst.blend);
    const b = this._fill(this.additive, inst.additive);
    for (const L of [this.blend, this.additive]) {
      L.mat.uniforms.tPosition.value = positionTex;
      L.mat.uniforms.uRes.value.set(width, height);
      L.mat.uniforms.uCamPos.value.copy(camera.position);
    }
    this.count = a + b;
    return this.count;
  }

  render(renderer, camera) {
    if (this.count === 0) return;
    renderer.render(this.scene, camera);
  }

  dispose() {
    for (const L of [this.blend, this.additive]) { L.geo.dispose(); L.mat.dispose(); }
  }
}
