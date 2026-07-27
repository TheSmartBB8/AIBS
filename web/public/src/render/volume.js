// volume.js — the voxel grid and its occupancy pyramid as GPU 3D textures.
//
// VoxelWorld stores voxels x-fastest, then z, then y. A Data3DTexture created as
// (width = sx, height = sz, depth = sy) therefore consumes world.data with *no
// repacking at all* — the byte order already matches. The price is a swizzle at
// sample time: voxel (x,y,z) lives at texcoord (x/sx, z/sz, y/sy).

import * as THREE from 'three';

function make3D(data, w, h, d) {
  const t = new THREE.Data3DTexture(data, w, h, d);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class VoxelVolume {
  constructor(world) {
    this.world = world;
    this.tex  = make3D(world.data, world.sx, world.sz, world.sy);
    this.mip1 = make3D(world.mip1, world.m1x, world.m1z, world.m1y);
    this.mip2 = make3D(world.mip2, world.m2x, world.m2z, world.m2y);
    this.version = 0;
    this._lastDirtyLen = -1;
  }

  /** Re-upload if the world reports edits. Returns true when the GPU copy changed. */
  sync() {
    const w = this.world;
    const dirty = w.dirtyAll || w.texDirty.length > 0;
    if (!dirty && this.version > 0) return false;
    // Sub-region uploads would need texSubImage3D plumbing three.js does not expose
    // for Data3DTexture; a full 10 MB re-upload only happens on frames that edited
    // the world, which already cost a re-mesh, so it is not the bottleneck.
    this.tex.needsUpdate = true;
    this.mip1.needsUpdate = true;
    this.mip2.needsUpdate = true;
    w.texDirty.length = 0;
    this.version++;
    return true;
  }

  uniforms() {
    const w = this.world;
    return {
      uVol:  { value: this.tex },
      uMip1: { value: this.mip1 },
      uMip2: { value: this.mip2 },
      uGrid: { value: new THREE.Vector3(w.sx, w.sy, w.sz) },
      uTexScale:  { value: new THREE.Vector3(1 / w.sx, 1 / w.sz, 1 / w.sy) },
      uTexScale1: { value: new THREE.Vector3(1 / w.m1x, 1 / w.m1z, 1 / w.m1y) },
      uTexScale2: { value: new THREE.Vector3(1 / w.m2x, 1 / w.m2z, 1 / w.m2y) },
    };
  }
}

/**
 * Find emissive voxel clusters and turn them into point lights.
 *
 * Teardown treats every glowing voxel as a real light source. Sampling millions of
 * them per pixel is not on, so we run a cheap connected-blob pass once over the grid
 * and hand the raytracer a handful of sphere lights instead. One lamp fixture (a few
 * dozen voxels) collapses to one light at its centroid with a radius covering the blob.
 */
export function findEmissiveLights(world, palette, maxLights = 12) {
  const emissiveIdx = [];
  for (let i = 1; i < 256; i++) if (palette.emissive[i] > 0) emissiveIdx.push(i);
  if (!emissiveIdx.length) return [];
  const isEm = new Uint8Array(256);
  for (const i of emissiveIdx) isEm[i] = 1;

  const { sx, sy, sz, data } = world;
  // coarse bucketing: 8-voxel cells, merged by proximity. Good enough for lamps.
  const CELL = 8;
  const buckets = new Map();
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      const row = (y * sz + z) * sx;
      for (let x = 0; x < sx; x++) {
        const p = data[row + x];
        if (p === 0 || !isEm[p]) continue;
        const key = ((y / CELL) | 0) * 4096 + ((z / CELL) | 0) * 64 + ((x / CELL) | 0);
        let b = buckets.get(key);
        if (!b) { b = { n: 0, x: 0, y: 0, z: 0, r: 0, g: 0, bl: 0, e: 0 }; buckets.set(key, b); }
        b.n++; b.x += x; b.y += y; b.z += z;
        b.r += palette.r[p] / 255; b.g += palette.g[p] / 255; b.bl += palette.b[p] / 255;
        b.e += palette.emissive[p];
      }
    }
  }
  let list = [...buckets.values()].map(b => ({
    x: b.x / b.n, y: b.y / b.n, z: b.z / b.n,
    n: b.n,
    col: [b.r / b.n, b.g / b.n, b.bl / b.n],
    emissive: b.e / b.n,
  }));
  // merge blobs whose centres are within 12 voxels (a fixture split across cells)
  const merged = [];
  for (const c of list) {
    let hit = null;
    for (const m of merged) {
      const d = Math.hypot(m.x - c.x, m.y - c.y, m.z - c.z);
      if (d < 14) { hit = m; break; }
    }
    if (hit) {
      const tn = hit.n + c.n;
      hit.x = (hit.x * hit.n + c.x * c.n) / tn;
      hit.y = (hit.y * hit.n + c.y * c.n) / tn;
      hit.z = (hit.z * hit.n + c.z * c.n) / tn;
      hit.col = [
        (hit.col[0] * hit.n + c.col[0] * c.n) / tn,
        (hit.col[1] * hit.n + c.col[1] * c.n) / tn,
        (hit.col[2] * hit.n + c.col[2] * c.n) / tn,
      ];
      hit.emissive = (hit.emissive * hit.n + c.emissive * c.n) / tn;
      hit.n = tn;
    } else merged.push({ ...c });
  }
  merged.sort((a, b) => b.n * b.emissive - a.n * a.emissive);
  return merged.slice(0, maxLights).map(m => ({
    pos: [m.x, m.y, m.z],                                  // voxel space
    color: m.col,
    // radiant power scales with the number of glowing voxels
    power: m.emissive * Math.pow(m.n, 0.62) * 0.55,
    radius: Math.max(1.5, Math.pow(m.n, 1 / 3) * 0.9),     // sphere light radius, voxels
  }));
}
