// gbuffer.js — rasterise the chunk meshes into a deferred G-buffer.
//
// The raster pass exists only to answer "what surface is at this pixel"; every photon
// after that is traced. Keeping it deferred means the expensive lighting runs exactly
// once per visible pixel no matter how much overdraw the greedy meshes have, and it
// gives the trace pass a clean, temporally-stable surface description to jitter over.
//
// Attachments
//   0  RGBA16F  albedo.rgb (linear)          | a = emissive strength
//   1  RGBA16F  world normal.xyz             | a = baked corner AO
//   2  RGBA32F  world position.xyz (metres)  | a = palette index
// A zero-length normal marks "no geometry" (sky), which is what the clear leaves behind.

import * as THREE from 'three';

export const GBUFFER_VERT = /* glsl */`
attribute float aAo;
attribute float aPal;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAo;
varying float vPal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = mat3(modelMatrix) * normal;
  vAo = aAo;
  vPal = aPal;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const GBUFFER_FRAG = /* glsl */`
precision highp float;
precision highp int;

varying vec3 vWorld;
varying vec3 vNormal;
varying float vAo;
varying float vPal;

uniform sampler2D uPalCol;
uniform float uVoxel;
uniform float uVoxelNoise;

layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oNormal;
layout(location = 2) out vec4 oPosition;

vec3 srgbToLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec4 pc = texture(uPalCol, vec2((vPal + 0.5) / 256.0, 0.5));
  vec3 albedo = srgbToLinear(pc.rgb);
  vec3 N = normalize(vNormal);

  // Per-voxel grain. Real Teardown voxels are never perfectly uniform — a couple of
  // percent of value noise keyed to the voxel cell keeps big greedy quads from
  // reading as flat vinyl. Step half a voxel along -N first so the cell lookup lands
  // inside the solid voxel rather than on the face plane between two of them.
  vec3 cell = floor(vWorld / uVoxel - N * 0.5);
  float g = hash13(cell) - 0.5;
  albedo *= 1.0 + g * uVoxelNoise;

  oAlbedo   = vec4(albedo, pc.a * 8.0);
  oNormal   = vec4(N, vAo);
  oPosition = vec4(vWorld, vPal);
}`;

export function createGBufferTarget(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count: 3,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  // World position needs full float: at 25 m a half-float ulp is ~1.5 cm, which is an
  // eighth of a voxel — enough to punch shadow-ray origins through their own surface.
  rt.textures[2].type = THREE.FloatType;
  rt.textures[0].name = 'gAlbedo';
  rt.textures[1].name = 'gNormal';
  rt.textures[2].name = 'gPosition';
  return rt;
}
