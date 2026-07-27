// debris.js — the small stuff: single voxels and chips too small to be worth a rigid body.
//
// A 12-voxel fragment does not need an inertia tensor; it needs to arc, bounce off a wall,
// skitter, and end up on the floor. So debris are point particles with a voxel-sized
// collision sphere and no orientation, which lets us run thousands of them.
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
import { Rng } from './math3d.js';

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
  spawn(x, y, z, vx, vy, vz, pal) {
    if (this.parts.length >= this.maxParticles) this.parts.shift();
    const mp = matPhys(this.palette, pal);
    this.parts.push({
      x, y, z, vx, vy, vz, pal,
      age: 0, rest: 0, alive: true,
      restitution: mp.restitution, friction: mp.friction,
    });
  }

  /**
   * Spawn debris for a destroyed voxel, thrown away from a blast centre with a little
   * deterministic scatter so a wall does not disintegrate into a perfectly radial starburst.
   */
  spawnFromVoxel(vx, vy, vz, pal, centre, speed) {
    const px = (vx + 0.5) * VOXEL, py = (vy + 0.5) * VOXEL, pz = (vz + 0.5) * VOXEL;
    let dx = px - centre[0], dy = py - centre[1], dz = pz - centre[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 1e-6) { dx /= d; dy /= d; dz /= d; } else { dx = 0; dy = 1; dz = 0; }
    const j = 0.45;
    this.spawn(px, py, pz,
      dx * speed + this.rng.sym() * speed * j,
      dy * speed + this.rng.sym() * speed * j + speed * 0.25,
      dz * speed + this.rng.sym() * speed * j,
      pal);
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
      const nx = p.x + p.vx * h, ny = p.y + p.vy * h, nz = p.z + p.vz * h;
      const c = sphereVsWorld(this.world, nx, ny, nz, SAMPLE_RADIUS);
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
        if (this.weld && p.y >= 0 && this.weldParticle(p)) {
          const vx = Math.floor(p.x / VOXEL), vy = Math.floor(p.y / VOXEL), vz = Math.floor(p.z / VOXEL);
          if (!welded) welded = { x0: vx, y0: vy, z0: vz, x1: vx, y1: vy, z1: vz };
          else {
            if (vx < welded.x0) welded.x0 = vx; if (vx > welded.x1) welded.x1 = vx;
            if (vy < welded.y0) welded.y0 = vy; if (vy > welded.y1) welded.y1 = vy;
            if (vz < welded.z0) welded.z0 = vz; if (vz > welded.z1) welded.z1 = vz;
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
   * Try to drop the particle into the grid. It must land in an empty cell that has support
   * underneath, otherwise we would be creating a voxel floating in mid-air — which the
   * integrity pass would immediately detach again, producing an infinite fall/weld loop.
   */
  weldParticle(p) {
    const w = this.world;
    let x = Math.floor(p.x / VOXEL), y = Math.floor(p.y / VOXEL), z = Math.floor(p.z / VOXEL);
    if (!w.inBounds(x, y, z)) return false;
    for (let up = 0; up <= 2; up++) {
      const yy = y + up;
      if (!w.inBounds(x, yy, z)) break;
      if (w.data[w.idx(x, yy, z)] !== 0) continue;
      if (!w.isSolidClamped(x, yy - 1, z) &&
          !w.isSolidClamped(x - 1, yy, z) && !w.isSolidClamped(x + 1, yy, z) &&
          !w.isSolidClamped(x, yy, z - 1) && !w.isSolidClamped(x, yy, z + 1)) continue;
      w.data[w.idx(x, yy, z)] = p.pal;
      this.weldedCount++;
      p.x = (x + 0.5) * VOXEL; p.y = (yy + 0.5) * VOXEL; p.z = (z + 0.5) * VOXEL;
      return true;
    }
    return false;
  }

  clear() { this.parts.length = 0; }
}
