// util.js — vector / ray helpers shared by the tools.
// Kept dependency-free apart from the voxel grid constants.

import { VOXEL } from '../voxel/world.js';

export const EPS = 1e-6;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function normalize(x, y, z) {
  const l = Math.hypot(x, y, z);
  if (l < EPS) return [0, 0, 1];
  return [x / l, y / l, z / l];
}

export function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/** Two unit vectors perpendicular to `d` (and to each other). */
export function orthoBasis(dx, dy, dz) {
  const up = Math.abs(dy) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const r = normalize(
    up[1] * dz - up[2] * dy,
    up[2] * dx - up[0] * dz,
    up[0] * dy - up[1] * dx,
  );
  const u = [
    dy * r[2] - dz * r[1],
    dz * r[0] - dx * r[2],
    dx * r[1] - dy * r[0],
  ];
  return [r, u];
}

/** Uniform sample inside a cone of half-angle `spread` (radians) about `dir`. */
export function coneDir(dir, spread, rng) {
  const d = normalize(dir[0], dir[1], dir[2]);
  if (!(spread > 0)) return d;
  const [r, u] = orthoBasis(d[0], d[1], d[2]);
  const a = rng() * Math.PI * 2;
  const rad = Math.sqrt(rng()) * Math.tan(spread);
  const cx = Math.cos(a) * rad, cy = Math.sin(a) * rad;
  return normalize(
    d[0] + r[0] * cx + u[0] * cy,
    d[1] + r[1] * cx + u[1] * cy,
    d[2] + r[2] * cx + u[2] * cy,
  );
}

/** Angle in radians between two (not necessarily unit) vectors. */
export function angleBetween(a, b) {
  const na = normalize(a[0], a[1], a[2]), nb = normalize(b[0], b[1], b[2]);
  return Math.acos(clamp(dot(na, nb), -1, 1));
}

export function reflect(v, n) {
  const d = dot(v, n) * 2;
  return [v[0] - n[0] * d, v[1] - n[1] * d, v[2] - n[2] * d];
}

/** Deterministic PRNG (xorshift32) — tests inject this as ctx.rng. */
export function makeRng(seed = 12345) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function metresToVoxel(p) { return [Math.floor(p[0] / VOXEL), Math.floor(p[1] / VOXEL), Math.floor(p[2] / VOXEL)]; }
export function voxelCentre(x, y, z) { return [(x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL]; }

/** Palette index at a point given in metres (0 = air / out of bounds). */
export function palAtPoint(world, x, y, z) {
  return world.get(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL));
}

export function strengthAtPoint(palette, world, x, y, z) {
  const p = palAtPoint(world, x, y, z);
  return p === 0 ? 0 : palette.strength(p);
}

/**
 * Walk forward from a point that sits on/inside a solid until air is reached.
 * Returns how much solid the ray has to chew through — the thing that makes a
 * rifle round pass a plank but stop in a slab.
 */
export function probeThickness(world, px, py, pz, dx, dy, dz, maxM = 2.0) {
  const step = VOXEL * 0.5;
  let t = step * 0.5;
  let last = 0;
  while (t < maxM) {
    const p = palAtPoint(world, px + dx * t, py + dy * t, pz + dz * t);
    if (p === 0) {
      return { thickness: t, exited: true, exit: [px + dx * t, py + dy * t, pz + dz * t], lastPal: last };
    }
    last = p;
    t += step;
  }
  return { thickness: maxM, exited: false, exit: [px + dx * maxM, py + dy * maxM, pz + dz * maxM], lastPal: last };
}

/**
 * Average / peak material strength in a small ball. Used by the winch to decide which
 * of its two anchors is the weak one, and by placement tools to check the surface.
 */
export function sampleAnchor(world, palette, x, y, z, radius = 0.25) {
  const r = Math.max(1, Math.round(radius / VOXEL));
  const cx = Math.floor(x / VOXEL), cy = Math.floor(y / VOXEL), cz = Math.floor(z / VOXEL);
  let sum = 0, n = 0, max = 0, pal = 0, mass = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        const p = world.get(cx + dx, cy + dy, cz + dz);
        if (p === 0) continue;
        const m = palette.material(p);
        sum += m.strength; mass += m.density; n++;
        if (m.strength > max) { max = m.strength; pal = p; }
      }
  return { count: n, avg: n ? sum / n : 0, max, pal, mass };
}

/** Fill every air voxel within `radius` of the segment a->b with `pal`. Returns the count. */
export function fillCapsule(world, a, b, radius, pal, { overwrite = false } = {}) {
  const r2 = radius * radius;
  const pad = radius + VOXEL;
  const lo = [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.min(a[2], b[2]) - pad];
  const hi = [Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad, Math.max(a[2], b[2]) + pad];
  const x0 = Math.max(0, Math.floor(lo[0] / VOXEL)), x1 = Math.min(world.sx - 1, Math.floor(hi[0] / VOXEL));
  const y0 = Math.max(0, Math.floor(lo[1] / VOXEL)), y1 = Math.min(world.sy - 1, Math.floor(hi[1] / VOXEL));
  const z0 = Math.max(0, Math.floor(lo[2] / VOXEL)), z1 = Math.min(world.sz - 1, Math.floor(hi[2] / VOXEL));
  const ab = sub(b, a);
  const abLen2 = dot(ab, ab) || EPS;
  let n = 0;
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        if (!overwrite && world.get(x, y, z) !== 0) continue;
        const c = voxelCentre(x, y, z);
        const t = clamp(dot(sub(c, a), ab) / abLen2, 0, 1);
        const dx = c[0] - (a[0] + ab[0] * t);
        const dy = c[1] - (a[1] + ab[1] * t);
        const dz = c[2] - (a[2] + ab[2] * t);
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        world.set(x, y, z, pal);
        n++;
      }
  if (n > 0) world.updateMipsRegion(x0, y0, z0, x1, y1, z1);
  return n;
}
