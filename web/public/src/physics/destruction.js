// destruction.js — energy-based voxel carving.
//
// The point of this file is that destruction is *not* a boolean delete of a shape. A blast
// deposits an energy field; a voxel only breaks if the energy that reaches it exceeds its
// material strength. That single rule is what makes a shotgun shred a wooden fence and
// merely scuff a concrete wall with the exact same call, and it means every tool in the
// game can be described as "a shape plus an energy" rather than as a bespoke carve routine.
//
// Energy that fails to break a voxel is not thrown away: it accumulates in a sparse damage
// field, so chipping at concrete with a weak tool eventually gets through. The field is
// sparse (a Map keyed by the world's linear index) because in practice only a few thousand
// voxels are ever part-damaged at once — a dense byte array over a 256x160x256 world would
// cost 10 MB to track a handful of scratches.

import { VOXEL, CHUNK } from '../voxel/world.js';
import { isUnbreakableMat } from './materials.js';

/**
 * Mark a whole edited box dirty in one go.
 *
 * NOTE (API that would otherwise belong on VoxelWorld): world.set() marks dirty per voxel,
 * which pushes one texDirty rectangle per voxel — a 30k-voxel blast would allocate 30k
 * objects. This is the free-function equivalent that touches the same public fields
 * (chunkDirty / addTexDirty / updateMipsRegion) once for the whole region. Carves therefore
 * write through setRaw and call this at the end.
 */
export function markRegionDirty(world, x0, y0, z0, x1, y1, z1) {
  const cx0 = Math.max(0, ((x0 - 1) / CHUNK) | 0), cx1 = Math.min(world.cx - 1, ((x1 + 1) / CHUNK) | 0);
  const cy0 = Math.max(0, ((y0 - 1) / CHUNK) | 0), cy1 = Math.min(world.cy - 1, ((y1 + 1) / CHUNK) | 0);
  const cz0 = Math.max(0, ((z0 - 1) / CHUNK) | 0), cz1 = Math.min(world.cz - 1, ((z1 + 1) / CHUNK) | 0);
  for (let cy = cy0; cy <= cy1; cy++)
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++)
        world.chunkDirty[(cy * world.cz + cz) * world.cx + cx] = 1;
  world.addTexDirty(x0, y0, z0, x1, y1, z1);
  world.updateMipsRegion(x0, y0, z0, x1, y1, z1);
}

/** Sparse accumulated damage, keyed by world linear voxel index. */
export class DamageField {
  constructor() { this.map = new Map(); }
  get(i) { const v = this.map.get(i); return v === undefined ? 0 : v; }
  set(i, v) { this.map.set(i, v); }
  clear(i) { this.map.delete(i); }
  clearAll() { this.map.clear(); }
  get size() { return this.map.size; }
}

/**
 * Core carve. `energyAt(cx, cy, cz)` receives a voxel *centre* in metres and returns the
 * energy delivered there. Everything else — strength comparison, damage accumulation,
 * bookkeeping, dirty marking — is shared by every carve shape.
 *
 * opts:
 *   damage        DamageField to accumulate into (null = no accumulation, one-shot only)
 *   maxVoxels     safety cap on how much a single carve may remove
 *   filter(pal)   optional predicate; false leaves the voxel alone (e.g. a paint-only tool)
 *   noDirty       skip the dirty/mip update (used when the caller batches several carves)
 *
 * Returns { destroyed: [[x,y,z,pal], ...], damaged: [[x,y,z,pal,accum], ...], bbox, count }.
 */
export function carveField(world, palette, box, energyAt, opts = {}, onDestroy = null) {
  const { damage = null, maxVoxels = 1 << 20, filter = null, noDirty = false } = opts;

  const x0 = Math.max(0, box.x0 | 0), x1 = Math.min(world.sx - 1, box.x1 | 0);
  const y0 = Math.max(0, box.y0 | 0), y1 = Math.min(world.sy - 1, box.y1 | 0);
  const z0 = Math.max(0, box.z0 | 0), z1 = Math.min(world.sz - 1, box.z1 | 0);

  const destroyed = [];
  const damaged = [];
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity;
  let bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;

  for (let y = y0; y <= y1; y++) {
    const wy = (y + 0.5) * VOXEL;
    for (let z = z0; z <= z1; z++) {
      const wz = (z + 0.5) * VOXEL;
      const row = (y * world.sz + z) * world.sx;
      for (let x = x0; x <= x1; x++) {
        const pal = world.data[row + x];
        if (pal === 0) continue;
        if (isUnbreakableMat(palette, pal)) continue;
        if (filter && !filter(pal)) continue;

        const e = energyAt((x + 0.5) * VOXEL, wy, wz);
        if (e <= 0) continue;

        const strength = palette.strength(pal);
        const i = row + x;
        const acc = e + (damage ? damage.get(i) : 0);

        if (acc >= strength) {
          if (destroyed.length >= maxVoxels) continue;
          world.data[i] = 0;
          if (damage) damage.clear(i);
          destroyed.push([x, y, z, pal]);
          if (onDestroy) onDestroy(x, y, z, pal);
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
          if (y < by0) by0 = y; if (y > by1) by1 = y;
          if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
        } else if (damage) {
          damage.set(i, acc);
          damaged.push([x, y, z, pal, acc / strength]);
        }
      }
    }
  }

  const bbox = destroyed.length
    ? { x0: bx0, y0: by0, z0: bz0, x1: bx1, y1: by1, z1: bz1 }
    : null;
  if (bbox && !noDirty) markRegionDirty(world, bx0, by0, bz0, bx1, by1, bz1);

  return { destroyed, damaged, bbox, count: destroyed.length };
}

/**
 * Spherical blast.
 *
 * centre/radius in metres. `energy` is the energy delivered inside the core; outside the
 * core it falls off to zero at `radius`. The core exists because a pure 1/d falloff means
 * only the single voxel at the exact centre ever sees full energy, which makes explosions
 * feel like they have no punch — real blasts have a total-destruction radius.
 *
 * opts.core    fraction of the radius at full energy (default 0.2)
 * opts.falloff falloff exponent outside the core (default 1.0 = linear)
 */
export function carveSphere(world, palette, centre, radius, energy, onDestroy = null, opts = {}) {
  const core = opts.core === undefined ? 0.2 : opts.core;
  const falloff = opts.falloff === undefined ? 1.0 : opts.falloff;
  const r2 = radius * radius;
  const rCore = radius * core;
  const span = Math.max(1e-9, radius - rCore);
  const [cx, cy, cz] = centre;

  const energyAt = (px, py, pz) => {
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) return 0;
    const d = Math.sqrt(d2);
    if (d <= rCore) return energy;
    const t = (d - rCore) / span;
    return energy * powFalloff(1 - t, falloff);
  };

  return carveField(world, palette, boxAround(centre, radius), energyAt, opts, onDestroy);
}

/**
 * Capsule / thick-ray carve: the blowtorch cut, the rocket trail, a bullet channel.
 * a and b are the segment endpoints in metres.
 */
export function carveCapsule(world, palette, a, b, radius, energy, onDestroy = null, opts = {}) {
  const core = opts.core === undefined ? 0.35 : opts.core;
  const falloff = opts.falloff === undefined ? 1.0 : opts.falloff;
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const abLen2 = abx * abx + aby * aby + abz * abz;
  const r2 = radius * radius;
  const rCore = radius * core;
  const span = Math.max(1e-9, radius - rCore);

  const energyAt = (px, py, pz) => {
    let t = 0;
    if (abLen2 > 1e-18) {
      t = ((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / abLen2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const dx = px - (a[0] + abx * t), dy = py - (a[1] + aby * t), dz = pz - (a[2] + abz * t);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) return 0;
    const d = Math.sqrt(d2);
    if (d <= rCore) return energy;
    return energy * powFalloff(1 - (d - rCore) / span, falloff);
  };

  const box = {
    x0: Math.floor((Math.min(a[0], b[0]) - radius) / VOXEL),
    y0: Math.floor((Math.min(a[1], b[1]) - radius) / VOXEL),
    z0: Math.floor((Math.min(a[2], b[2]) - radius) / VOXEL),
    x1: Math.floor((Math.max(a[0], b[0]) + radius) / VOXEL),
    y1: Math.floor((Math.max(a[1], b[1]) + radius) / VOXEL),
    z1: Math.floor((Math.max(a[2], b[2]) + radius) / VOXEL),
  };
  return carveField(world, palette, box, energyAt, opts, onDestroy);
}

/** Convenience wrapper: cut from an origin along a direction for `length` metres. */
export function carveRay(world, palette, origin, dir, length, radius, energy, onDestroy = null, opts = {}) {
  const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
  const b = [
    origin[0] + (dir[0] / l) * length,
    origin[1] + (dir[1] / l) * length,
    origin[2] + (dir[2] / l) * length,
  ];
  return carveCapsule(world, palette, origin, b, radius, energy, onDestroy, opts);
}

/**
 * Axis-aligned box carve (demolition charge footprint, editor tools).
 * opts.edgeFalloff (0..1) tapers the energy toward the box faces; 0 = hard edges.
 */
export function carveBox(world, palette, min, max, energy, onDestroy = null, opts = {}) {
  const edgeFalloff = opts.edgeFalloff === undefined ? 0 : opts.edgeFalloff;
  const cx = (min[0] + max[0]) * 0.5, cy = (min[1] + max[1]) * 0.5, cz = (min[2] + max[2]) * 0.5;
  const hx = Math.max(1e-9, (max[0] - min[0]) * 0.5);
  const hy = Math.max(1e-9, (max[1] - min[1]) * 0.5);
  const hz = Math.max(1e-9, (max[2] - min[2]) * 0.5);

  const energyAt = (px, py, pz) => {
    const tx = Math.abs(px - cx) / hx, ty = Math.abs(py - cy) / hy, tz = Math.abs(pz - cz) / hz;
    const t = Math.max(tx, ty, tz);
    if (t > 1) return 0;
    return energy * (1 - edgeFalloff * t);
  };

  const box = {
    x0: Math.floor(min[0] / VOXEL), y0: Math.floor(min[1] / VOXEL), z0: Math.floor(min[2] / VOXEL),
    x1: Math.floor(max[0] / VOXEL), y1: Math.floor(max[1] / VOXEL), z1: Math.floor(max[2] / VOXEL),
  };
  return carveField(world, palette, box, energyAt, opts, onDestroy);
}

/** Remove an explicit voxel list from the grid (used when a group detaches into a body). */
export function liftVoxels(world, voxels) {
  if (!voxels.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < voxels.length; i++) {
    const [x, y, z] = voxels[i];
    world.data[world.idx(x, y, z)] = 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  markRegionDirty(world, x0, y0, z0, x1, y1, z1);
  return { x0, y0, z0, x1, y1, z1 };
}

// integer-exponent power, kept out of Math.pow so the common cases stay exact
function powFalloff(base, exp) {
  if (base <= 0) return 0;
  if (exp === 1) return base;
  if (exp === 2) return base * base;
  if (exp === 3) return base * base * base;
  return Math.pow(base, exp);
}

function boxAround(centre, radius) {
  return {
    x0: Math.floor((centre[0] - radius) / VOXEL), y0: Math.floor((centre[1] - radius) / VOXEL),
    z0: Math.floor((centre[2] - radius) / VOXEL), x1: Math.floor((centre[0] + radius) / VOXEL),
    y1: Math.floor((centre[1] + radius) / VOXEL), z1: Math.floor((centre[2] + radius) / VOXEL),
  };
}
