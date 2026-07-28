// debris.js — the small stuff: fragments too small to be worth a rigid body.
//
// A 12-voxel fragment does not need an inertia tensor; it needs to arc, bounce off a wall,
// skitter, and end up on the floor. So debris are point particles with no orientation,
// which lets us run thousands of them.
//
// A particle carries a *cluster* of voxels, not one. Spawning every destroyed voxel as its
// own particle turned a rocket into six thousand independent grains, which spread into a
// wide field of fine gravel — nothing like the tumbling chunks the real game throws. A
// particle now owns a small block of cells (local offsets from its anchor voxel) that
// travel, collide and weld as a unit, so the same blast produces a few hundred fragments
// with the mass and scale of masonry rubble.
//
// The one non-obvious choice: settled debris is *welded back into the voxel grid* rather
// than despawned. Teardown's rubble stays on the ground, and since our world is a dense
// grid the cheapest way to have permanent rubble is to make it world geometry — it then
// gets meshed, lit, and can be blown up again by the next shot, for free. Debris that
// fades out is the single most immersion-breaking thing a destruction system can do.

import { VOXEL } from '../voxel/world.js';
import { sphereVsWorld, SAMPLE_RADIUS } from './collision.js';
import { matPhys } from './materials.js';
import { markRegionDirty } from './destruction.js';
import { Rng, qIdentity, qIntegrate, snapToCubeRotation, m3MulVec } from './math3d.js';

/** Shared by every single-voxel chip; never mutated. */
const SINGLE_CELL = Object.freeze([Object.freeze([0, 0, 0, 0])]);

export class DebrisSystem {
  constructor(world, palette, opts = {}) {
    this.world = world;
    this.palette = palette;
    this.parts = [];
    this.gravity = opts.gravity === undefined ? -20 : opts.gravity;
    this.maxParticles = opts.maxParticles === undefined ? 4000 : opts.maxParticles;
    this.maxAge = opts.maxAge === undefined ? 20 : opts.maxAge;
    this.weld = opts.weld === undefined ? true : opts.weld;
    this.settleSpeed = opts.settleSpeed === undefined ? 0.35 : opts.settleSpeed;
    this.settleTime = opts.settleTime === undefined ? 0.25 : opts.settleTime;
    this.rng = new Rng(opts.seed === undefined ? 0x5eed1234 : opts.seed);
    this.weldedCount = 0;
  }

  get count() { return this.parts.length; }

  /** Spawn one debris voxel at a world position (metres) with a world velocity. */
  spawn(x, y, z, vx, vy, vz, pal, opts = null) {
    if (this.parts.length >= this.maxParticles) this.parts.shift();
    const mp = matPhys(this.palette, pal);
    this.parts.push({
      x, y, z, vx, vy, vz, pal,
      age: 0, rest: 0, alive: true,
      restitution: mp.restitution, friction: mp.friction,
      // A single-voxel chip. `cells` is the general form used by chunks; keeping it
      // present (rather than null) means step/weld/render never need a special case.
      cells: (opts && opts.cells) || SINGLE_CELL,
      radius: (opts && opts.radius) || SAMPLE_RADIUS,
      // A single voxel is a cube: rotating it changes nothing, so chips never spin.
      q: null, w: null,
      // Pulverised material (crush splinters) must not weld back into the grid. Letting
      // it re-weld restores the exact voxels that were just smashed, so a wall landing on
      // a wooden deck leaves the deck visually untouched — the crater heals itself.
      noWeld: !!(opts && opts.noWeld),
    });
  }

  /**
   * Spawn a multi-voxel fragment. `cells` are [dx, dy, dz, pal] offsets from the anchor
   * voxel, which sits at the given world position.
   *
   * Heavier fragments bounce less and settle sooner: a brick does not skitter the way a
   * chip does, and rubble that keeps twitching also keeps the renderer from converging.
   */
  spawnChunk(x, y, z, vx, vy, vz, cells, opts = null) {
    if (!cells || cells.length === 0) return;
    if (cells.length === 1) {
      this.spawn(x, y, z, vx, vy, vz, cells[0][3], opts);
      return;
    }
    if (this.parts.length >= this.maxParticles) this.parts.shift();

    // Rebase the cells around the fragment's own centre. They arrive relative to its
    // minimum corner, and leaving them that way puts both the collision sphere and the
    // weld anchor at a corner that is typically buried in whatever the fragment landed
    // on: it tested for collision in the wrong place and then failed to weld, so most of
    // a blast's rubble quietly disappeared instead of piling up.
    let ex = 0, ey = 0, ez = 0;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i][0] > ex) ex = cells[i][0];
      if (cells[i][1] > ey) ey = cells[i][1];
      if (cells[i][2] > ez) ez = cells[i][2];
    }
    const ox = ex >> 1, oy = ey >> 1, oz = ez >> 1;
    const local = new Array(cells.length);
    let half = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const lx = c[0] - ox, ly = c[1] - oy, lz = c[2] - oz;
      local[i] = [lx, ly, lz, c[3]];
      const m = Math.max(Math.abs(lx), Math.abs(ly), Math.abs(lz));
      if (m > half) half = m;
    }

    const pal = cells[0][3];
    const mp = matPhys(this.palette, pal);
    this.parts.push({
      x: x + ox * VOXEL, y: y + oy * VOXEL, z: z + oz * VOXEL,
      vx, vy, vz, pal,
      age: 0, rest: 0, alive: true,
      restitution: mp.restitution * 0.55,
      friction: Math.min(1, mp.friction * 1.25),
      cells: local,
      radius: VOXEL * (half + 0.5),
      // Tumble. A fragment that translates without rotating reads as a sprite being slid
      // across the screen; the spin is most of what makes flying rubble look like mass.
      // Spun proportionally to how hard it was thrown and inversely to its size, so a
      // small chip whirls and a big slab turns over slowly.
      q: qIdentity(),
      w: [this.rng.sym(), this.rng.sym(), this.rng.sym()].map(
        (r) => r * Math.hypot(vx, vy, vz) * 2.2 / (half + 1)),
      noWeld: !!(opts && opts.noWeld),
    });
  }

  /**
   * Spawn debris for a destroyed voxel, thrown away from a blast centre with a little
   * deterministic scatter so a wall does not disintegrate into a perfectly radial starburst.
   */
  spawnFromVoxel(vx, vy, vz, pal, centre, speed, opts = null) {
    const px = (vx + 0.5) * VOXEL, py = (vy + 0.5) * VOXEL, pz = (vz + 0.5) * VOXEL;
    let dx = px - centre[0], dy = py - centre[1], dz = pz - centre[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-6) { dx /= d; dy /= d; dz /= d; } else { dx = 0; dy = 1; dz = 0; }
    const j = 0.45;
    this.spawn(px, py, pz,
      dx * speed + this.rng.sym() * speed * j,
      dy * speed + this.rng.sym() * speed * j + speed * 0.25,
      dz * speed + this.rng.sym() * speed * j,
      pal, opts);
  }

  /**
   * Same, for a multi-voxel fragment anchored at voxel (ax, ay, az). The throw is aimed
   * from the blast centre through the fragment's *centroid*, not its corner, or every
   * fragment picks up a bias toward -x-y-z.
   */
  spawnChunkFrom(ax, ay, az, cells, centre, speed, opts = null) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < cells.length; i++) { cx += cells[i][0]; cy += cells[i][1]; cz += cells[i][2]; }
    const n = cells.length;
    const mx = (ax + cx / n + 0.5) * VOXEL, my = (ay + cy / n + 0.5) * VOXEL, mz = (az + cz / n + 0.5) * VOXEL;
    let dx = mx - centre[0], dy = my - centre[1], dz = mz - centre[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-6) { dx /= d; dy /= d; dz /= d; } else { dx = 0; dy = 1; dz = 0; }
    // Heavier fragments leave slower for the same blast — momentum is shared across the
    // mass, and a brick that flies like a chip reads as weightless.
    const s = speed / Math.sqrt(n);
    const j = 0.45;
    this.spawnChunk((ax + 0.5) * VOXEL, (ay + 0.5) * VOXEL, (az + 0.5) * VOXEL,
      dx * s + this.rng.sym() * s * j,
      dy * s + this.rng.sym() * s * j + s * 0.25,
      dz * s + this.rng.sym() * s * j,
      cells, opts);
  }

  /** One fixed substep. */
  step(h) {
    const g = this.gravity;
    const parts = this.parts;
    let welded = null;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.age += h;
      p.vy += g * h;
      if (p.q) { p.q = qIntegrate(p.q, p.w, h); }
      const nx = p.x + p.vx * h, ny = p.y + p.vy * h, nz = p.z + p.vz * h;
      const c = sphereVsWorld(this.world, nx, ny, nz, p.radius);
      if (c) {
        // push out and reflect the normal component, scrub the tangent with friction
        p.x = nx + c.nx * c.pen;
        p.y = ny + c.ny * c.pen;
        p.z = nz + c.nz * c.pen;
        const vn = p.vx * c.nx + p.vy * c.ny + p.vz * c.nz;
        if (vn < 0) {
          // split into normal + tangent once, bounce the normal, scrub the tangent
          const tvx = p.vx - c.nx * vn, tvy = p.vy - c.ny * vn, tvz = p.vz - c.nz * vn;
          const vnOut = -vn * p.restitution;
          const damp = 1 - Math.min(1, p.friction * 0.6);
          p.vx = c.nx * vnOut + tvx * damp;
          p.vy = c.ny * vnOut + tvy * damp;
          p.vz = c.nz * vnOut + tvz * damp;
          // Scrubbing on the ground kills spin far faster than it kills travel — rubble
          // that keeps spinning as it slides to a halt looks like it is on ice.
          if (p.w) { const k = damp * 0.5; p.w[0] *= k; p.w[1] *= k; p.w[2] *= k; }
        }
        const sp2 = p.vx * p.vx + p.vy * p.vy + p.vz * p.vz;
        if (sp2 < this.settleSpeed * this.settleSpeed) p.rest += h; else p.rest = 0;
      } else {
        p.x = nx; p.y = ny; p.z = nz;
        p.rest = 0;
      }

      const done = p.rest >= this.settleTime || p.age >= this.maxAge || p.y < -2;
      if (done) {
        p.alive = false;
        if (this.weld && !p.noWeld && p.y >= 0) {
          const b = this.weldParticle(p);
          if (b) {
            if (!welded) welded = b;
            else {
              if (b.x0 < welded.x0) welded.x0 = b.x0; if (b.x1 > welded.x1) welded.x1 = b.x1;
              if (b.y0 < welded.y0) welded.y0 = b.y0; if (b.y1 > welded.y1) welded.y1 = b.y1;
              if (b.z0 < welded.z0) welded.z0 = b.z0; if (b.z1 > welded.z1) welded.z1 = b.z1;
            }
          }
        }
      }
    }
    if (welded) markRegionDirty(this.world, welded.x0, welded.y0, welded.z0, welded.x1, welded.y1, welded.z1);
    // compact
    let n = 0;
    for (let i = 0; i < parts.length; i++) if (parts[i].alive) parts[n++] = parts[i];
    parts.length = n;
  }

  /**
   * Try to drop the fragment into the grid, returning the bounding box it wrote or null.
   *
   * The anchor cell must land somewhere empty with something adjacent to rest against,
   * otherwise we would be creating geometry floating in mid-air — which the integrity pass
   * would immediately detach again, producing an infinite fall/weld loop. The rest of the
   * fragment's cells then go in around it, skipping any that are already occupied: a
   * fragment settling into a corner keeps whatever fits and quietly loses the overlap,
   * which looks like rubble packing rather than like geometry interpenetrating.
   */
  weldParticle(p) {
    const w = this.world;
    const x = Math.floor(p.x / VOXEL), y = Math.floor(p.y / VOXEL), z = Math.floor(p.z / VOXEL);
    if (!w.inBounds(x, y, z)) return null;

    // The grid has no way to store a fragment lying at 37 degrees, so the tumble is
    // snapped to the nearest of the 24 axis-aligned orientations and baked into the cell
    // offsets. Snapping rather than resetting to identity is what stops a long fragment
    // that landed across the road from suddenly lying along it.
    let cells = p.cells;
    if (p.q && cells.length > 1) {
      const m = snapToCubeRotation(p.q).m;
      const rot = new Array(cells.length);
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        const v = m3MulVec(m, [c[0], c[1], c[2]]);
        rot[k] = [Math.round(v[0]), Math.round(v[1]), Math.round(v[2]), c[3]];
      }
      cells = rot;
      p.cells = rot;
      p.q = qIdentity();
      p.w = null;
    }

    // Nudge upward until enough of the fragment fits. A single chip only ever needs one
    // free cell; a lump of masonry landing on uneven rubble will always have some of its
    // cells inside something, so demanding a perfect fit throws the whole fragment away.
    let best = -1, bestFits = 0;
    for (let up = 0; up <= 3; up++) {
      const yy = y + up;
      if (!w.inBounds(x, yy, z)) break;
      let fits = 0, anchored = false;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        const cx = x + c[0], cy = yy + c[1], cz = z + c[2];
        if (!w.inBounds(cx, cy, cz) || w.data[w.idx(cx, cy, cz)] !== 0) continue;
        fits++;
        if (!anchored && (w.isSolidClamped(cx, cy - 1, cz) ||
            w.isSolidClamped(cx - 1, cy, cz) || w.isSolidClamped(cx + 1, cy, cz) ||
            w.isSolidClamped(cx, cy, cz - 1) || w.isSolidClamped(cx, cy, cz + 1))) anchored = true;
      }
      // must touch something, or the integrity pass detaches it again next frame and the
      // fragment falls and re-welds forever
      if (!anchored || fits === 0) continue;
      if (fits > bestFits) { bestFits = fits; best = up; }
      if (fits === cells.length) break;
    }
    if (best < 0) return null;

    const yy = y + best;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      const cx = x + c[0], cy = yy + c[1], cz = z + c[2];
      if (!w.inBounds(cx, cy, cz)) continue;
      const i = w.idx(cx, cy, cz);
      if (w.data[i] !== 0) continue;
      w.data[i] = c[3] || p.pal;
      this.weldedCount++;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      if (cz < z0) z0 = cz; if (cz > z1) z1 = cz;
    }
    if (x0 === Infinity) return null;
    p.x = (x + 0.5) * VOXEL; p.y = (yy + 0.5) * VOXEL; p.z = (z + 0.5) * VOXEL;
    return { x0, y0, z0, x1, y1, z1 };
  }

  clear() { this.parts.length = 0; }
}
