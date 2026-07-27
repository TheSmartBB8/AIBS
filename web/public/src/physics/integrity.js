// integrity.js — "what is still holding this up?"
//
// After every edit we ask which voxels near the edit can still trace a 6-connected path to
// something that holds them up. Anything that can't is detached, and gets handed to the
// rigid-body sim. This is the system that makes a building fall down when you cut its legs
// off instead of hanging in the air like Minecraft.
//
// Anchors are:
//   * y == 0            — resting on the world floor (world.isSolidClamped treats y<0 as solid)
//   * an unbreakable material voxel (bedrock, foundations)
//   * the x/z world boundary — geometry running off the edge of the map is held by "offscreen"
//
// The search is deliberately *bounded*: a box around the edit, not the whole world. A global
// flood fill over a 256x160x256 grid is ~10M cells and would stall the frame on every shot.
// The price of the bound is one documented approximation: a component that leaves the search
// box through a face (its neighbour outside the box is solid) is assumed to be attached to
// whatever is out there. That errs toward *not* collapsing things, which is the safe
// direction — the alternative (assuming detached) would drop half a level on the first shot.
// The box is grown with `margin`, so anything that fits inside the analysed region is
// classified exactly.

import { isUnbreakableMat } from './materials.js';

/**
 * Label 6-connected solid components inside `box` (inclusive world voxel coords, clamped).
 *
 * opts.maxVolume  hard cap on the analysed cell count (default 4M); the box is shrunk
 *                 around its centre if it exceeds this.
 *
 * Returns { groups, region } where each group is
 *   { cells: Int32Array of world linear indices, size, anchored, escaped, min:[x,y,z], max:[x,y,z] }
 */
export function labelComponents(world, palette, box, opts = {}) {
  const maxVolume = opts.maxVolume === undefined ? 4_000_000 : opts.maxVolume;

  let x0 = Math.max(0, box.x0 | 0), x1 = Math.min(world.sx - 1, box.x1 | 0);
  let y0 = Math.max(0, box.y0 | 0), y1 = Math.min(world.sy - 1, box.y1 | 0);
  let z0 = Math.max(0, box.z0 | 0), z1 = Math.min(world.sz - 1, box.z1 | 0);
  if (x1 < x0 || y1 < y0 || z1 < z0) return { groups: [], region: null };

  // shrink around the centre if the region is absurdly large
  while ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > maxVolume) {
    if (x1 - x0 >= y1 - y0 && x1 - x0 >= z1 - z0) { x0++; if (x1 > x0) x1--; }
    else if (y1 - y0 >= z1 - z0) { y0++; if (y1 > y0) y1--; }
    else { z0++; if (z1 > z0) z1--; }
  }

  const w = x1 - x0 + 1, h = y1 - y0 + 1, d = z1 - z0 + 1;
  const n = w * h * d;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const groups = [];

  // local <-> world index helpers
  const localOf = (x, y, z) => ((y - y0) * d + (z - z0)) * w + (x - x0);

  for (let sy = y0; sy <= y1; sy++) {
    for (let sz = z0; sz <= z1; sz++) {
      for (let sx = x0; sx <= x1; sx++) {
        const l0 = localOf(sx, sy, sz);
        if (seen[l0]) continue;
        if (world.data[world.idx(sx, sy, sz)] === 0) { seen[l0] = 1; continue; }

        // flood this component
        let sp = 0;
        stack[sp++] = l0;
        seen[l0] = 1;
        const cells = [];
        let anchored = false, escaped = false;
        let mnx = sx, mny = sy, mnz = sz, mxx = sx, mxy = sy, mxz = sz;

        while (sp > 0) {
          const l = stack[--sp];
          const lx = l % w, t = (l / w) | 0, lz = t % d, ly = (t / d) | 0;
          const x = lx + x0, y = ly + y0, z = lz + z0;
          const wi = world.idx(x, y, z);
          const pal = world.data[wi];
          cells.push(wi);

          if (x < mnx) mnx = x; if (x > mxx) mxx = x;
          if (y < mny) mny = y; if (y > mxy) mxy = y;
          if (z < mnz) mnz = z; if (z > mxz) mxz = z;

          if (y === 0 || x === 0 || z === 0 || x === world.sx - 1 || z === world.sz - 1) anchored = true;
          else if (isUnbreakableMat(palette, pal)) anchored = true;

          // 6 neighbours
          for (let k = 0; k < 6; k++) {
            const nx = x + NX[k], ny = y + NY[k], nz = z + NZ[k];
            if (nx < x0 || ny < y0 || nz < z0 || nx > x1 || ny > y1 || nz > z1) {
              // left the analysis box — if there is solid material out there the component
              // continues into unanalysed territory and we conservatively call it attached
              if (world.inBounds(nx, ny, nz) && world.data[world.idx(nx, ny, nz)] !== 0) escaped = true;
              continue;
            }
            const nl = localOf(nx, ny, nz);
            if (seen[nl]) continue;
            if (world.data[world.idx(nx, ny, nz)] === 0) { seen[nl] = 1; continue; }
            seen[nl] = 1;
            stack[sp++] = nl;
          }
        }

        groups.push({
          cells: Int32Array.from(cells),
          size: cells.length,
          anchored, escaped,
          supported: anchored || escaped,
          min: [mnx, mny, mnz], max: [mxx, mxy, mxz],
        });
      }
    }
  }

  return { groups, region: { x0, y0, z0, x1, y1, z1 } };
}

/**
 * Detached groups near an edit. `editBox` is the bbox of the voxels that just changed;
 * it is grown by `margin` (default 24 voxels = 2.4 m) before the flood fill.
 */
export function findDetached(world, palette, editBox, opts = {}) {
  const margin = opts.margin === undefined ? 24 : opts.margin;
  const box = editBox === null ? { x0: 0, y0: 0, z0: 0, x1: world.sx - 1, y1: world.sy - 1, z1: world.sz - 1 } : {
    x0: editBox.x0 - margin, y0: editBox.y0 - margin, z0: editBox.z0 - margin,
    x1: editBox.x1 + margin, y1: editBox.y1 + margin, z1: editBox.z1 + margin,
  };
  const { groups } = labelComponents(world, palette, box, opts);
  return groups.filter((g) => !g.supported);
}

/** Expand a group's linear indices into [x, y, z, pal] tuples. */
export function groupVoxels(world, group) {
  const out = new Array(group.cells.length);
  const { sx, sz } = world;
  for (let i = 0; i < group.cells.length; i++) {
    const wi = group.cells[i];
    const x = wi % sx, t = (wi / sx) | 0, z = t % sz, y = (t / sz) | 0;
    out[i] = [x, y, z, world.data[wi]];
  }
  return out;
}

const NX = [1, -1, 0, 0, 0, 0];
const NY = [0, 0, 1, -1, 0, 0];
const NZ = [0, 0, 0, 0, 1, -1];
