// renderer.js — baseline voxel renderer.
//
// Chunk meshes are drawn with a custom ShaderMaterial that looks colour and material
// traits up from palette textures, applies baked corner AO, and shades with a sun +
// sky-tinted hemisphere ambient. This is the substrate the raytraced lighting pass
// (shadows / AO / specular, plus TAA accumulation) plugs into.
//
// Uniform + attribute contract, relied on by the lighting work:
//   attributes : position, normal, aAo (0..1), aPal (palette index)
//   uniforms   : uPalCol, uPalMat (256x1 textures), uSunDir, uSunColor,
//                uSkyTop, uSkyBot, uAmbient, uCamPos

import * as THREE from 'three';
import { meshChunk } from '../voxel/mesher.js';
import { CHUNK, VOXEL } from '../voxel/world.js';

export const VOX_VERT = /* glsl */`
attribute float aAo;
attribute float aPal;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAo;
varying float vPal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vAo = aAo;
  vPal = aPal;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const VOX_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAo;
varying float vPal;

uniform sampler2D uPalCol;
uniform sampler2D uPalMat;
uniform vec3 uSunDir;       // direction light travels (points away from the sun)
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyBot;
uniform float uAmbient;
uniform vec3 uCamPos;
uniform float uExposure;

void main() {
  float u = (vPal + 0.5) / 256.0;
  vec4 col = texture2D(uPalCol, vec2(u, 0.5));
  vec4 mat = texture2D(uPalMat, vec2(u, 0.5));
  vec3 albedo = col.rgb;
  float emissive = col.a * 8.0;

  vec3 N = normalize(vNormal);
  vec3 toSun = -normalize(uSunDir);

  // sun (hard for now; the raytraced pass replaces this with soft shadowed visibility)
  float ndl = max(dot(N, toSun), 0.0);
  vec3 direct = uSunColor * ndl;

  // sky-tinted hemisphere ambient, modulated by baked corner AO
  float up = N.y * 0.5 + 0.5;
  vec3 ambient = mix(uSkyBot, uSkyTop, up) * uAmbient;

  vec3 lit = albedo * (direct + ambient * vAo) + albedo * emissive;
  gl_FragColor = vec4(lit * uExposure, 1.0);
}`;

export class VoxelRenderer {
  constructor(canvas, world, palette) {
    this.world = world;
    this.palette = palette;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x0b0f16, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 400);

    // palette textures
    this.palColTex = new THREE.DataTexture(palette.toColorTextureData(), 256, 1, THREE.RGBAFormat);
    this.palColTex.needsUpdate = true;
    this.palMatTex = new THREE.DataTexture(palette.toMaterialTextureData(), 256, 1, THREE.RGBAFormat);
    this.palMatTex.needsUpdate = true;
    for (const t of [this.palColTex, this.palMatTex]) {
      t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
    }

    this.uniforms = {
      uPalCol:   { value: this.palColTex },
      uPalMat:   { value: this.palMatTex },
      uSunDir:   { value: new THREE.Vector3(0.42, -0.72, 0.33).normalize() },
      uSunColor: { value: new THREE.Color(1.25, 1.12, 0.94) },
      uSkyTop:   { value: new THREE.Color(0.32, 0.48, 0.78) },
      uSkyBot:   { value: new THREE.Color(0.62, 0.63, 0.58) },
      uAmbient:  { value: 0.55 },
      uCamPos:   { value: new THREE.Vector3() },
      uExposure: { value: 1.0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VOX_VERT,
      fragmentShader: VOX_FRAG,
      uniforms: this.uniforms,
      side: THREE.FrontSide,
    });

    this.chunkGroup = new THREE.Group();
    this.scene.add(this.chunkGroup);
    this.meshes = new Map();   // "cx,cy,cz" -> THREE.Mesh

    this.stats = { chunks: 0, triangles: 0, lastMeshMs: 0 };
  }

  setSize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Re-mesh dirty chunks. budget = max chunks to rebuild this call (0 = all). */
  updateMeshes(budget = 0) {
    const t0 = performance.now();
    const w = this.world;
    let done = 0, tris = 0;
    for (let cy = 0; cy < w.cy; cy++)
      for (let cz = 0; cz < w.cz; cz++)
        for (let cx = 0; cx < w.cx; cx++) {
          if (!w.chunkIsDirty(cx, cy, cz)) continue;
          if (budget && done >= budget) { this.stats.lastMeshMs = performance.now() - t0; return done; }
          w.clearChunkDirty(cx, cy, cz);
          this._rebuildChunk(cx, cy, cz);
          done++;
        }
    for (const m of this.meshes.values()) tris += m.geometry.index
      ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
    this.stats.chunks = this.meshes.size;
    this.stats.triangles = tris;
    this.stats.lastMeshMs = performance.now() - t0;
    w.dirtyAll = false;
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
    if (old) {
      this.chunkGroup.remove(old);
      old.geometry.dispose();
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = true;
    this.chunkGroup.add(mesh);
    this.meshes.set(key, mesh);
  }

  render() {
    this.uniforms.uCamPos.value.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
