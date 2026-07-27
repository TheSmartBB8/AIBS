// physics.js — the destruction/physics world: fixed-step rigid bodies, integrity, welding.
//
// ============================================================================ determinism
// The body sim runs on a fixed 120 Hz substep. `step(dt)` never integrates with the frame's
// dt; it converts dt into integer ticks, banks them, and drains whole substeps. Integer
// ticks rather than a float accumulator because `acc += dt` accumulates rounding differently
// depending on how the wall clock was sliced, which is exactly the thing we are trying to
// eliminate — with integers, 144 fps and 31 fps deliver the *same sequence of substeps* and
// therefore bit-identical state. See tests/physics.test.mjs.
//
// ============================================================================ the pipeline
//   carve  ->  integrity flood fill  ->  detached groups  ->  bodies + debris
//   substep:  integrate -> contacts -> sequential impulses -> shatter -> settle -> weld
//
// Bodies re-weld into the voxel grid when they settle rather than living forever as props.
// Justification: the renderer raymarches a dense volume texture, so anything left as a
// separate prop needs its own draw path, its own lighting, and cannot be destroyed again by
// the same code that destroys the world. Welding at the nearest 90 degree orientation gives
// permanent, re-destructible, correctly-lit rubble for zero extra render machinery, and it
// bounds body count so a long fight does not turn into a thousand-body soup. The cost is
// that a chunk resting at 30 degrees snaps flat when it falls asleep; that is only visible
// if you stare at it, whereas debris that vanishes is visible immediately.

import { VOXEL } from '../voxel/world.js';
import {
  carveSphere, carveCapsule, carveRay, carveBox, liftVoxels, markRegionDirty, DamageField,
} from './destruction.js';
import { findDetached, groupVoxels } from './integrity.js';
import { VoxelBody } from './body.js';
import { DebrisSystem } from './debris.js';
import { collectWorldContacts, collectBodyContacts, aabbOverlap } from './collision.js';
import { matPhys, voxelMass, isUnbreakableMat } from './materials.js';
import { vsub, vadd, vcross, vdot, vlen, m3MulVec, Rng, clamp } from './math3d.js';

export const SUBSTEP_HZ = 120;
export const SUBSTEP_H = 1 / SUBSTEP_HZ;
const TICKS_PER_SUBSTEP = 1000;              // sub-tick resolution inside one substep
const TICKS_PER_SECOND = SUBSTEP_HZ * TICKS_PER_SUBSTEP;

export class PhysicsWorld {
  constructor(world, palette, opts = {}) {
    this.world = world;
    this.palette = palette;

    this.gravity = opts.gravity ? opts.gravity.slice() : [0, -20, 0];
    this.bodies = [];
    this.debris = new DebrisSystem(world, palette, {
      gravity: this.gravity[1],
      weld: opts.weldDebris === undefined ? true : opts.weldDebris,
      seed: opts.seed === undefined ? 0x5eed1234 : opts.seed,
    });
    this.damage = new DamageField();
    this.rng = new Rng((opts.seed === undefined ? 0x5eed1234 : opts.seed) ^ 0x1f2e3d4c);

    // ---- solver tuning
    this.contactIterations = opts.contactIterations === undefined ? 6 : opts.contactIterations;
    this.linearDamping = opts.linearDamping === undefined ? 0.06 : opts.linearDamping;
    this.angularDamping = opts.angularDamping === undefined ? 0.10 : opts.angularDamping;
    this.penetrationSlop = opts.penetrationSlop === undefined ? VOXEL * 0.08 : opts.penetrationSlop;
    this.positionBeta = opts.positionBeta === undefined ? 0.45 : opts.positionBeta;
    this.restitutionThreshold = opts.restitutionThreshold === undefined ? 1.2 : opts.restitutionThreshold;

    // ---- sleeping / settling
    this.sleepLinear = opts.sleepLinear === undefined ? 0.14 : opts.sleepLinear;
    this.sleepAngular = opts.sleepAngular === undefined ? 0.5 : opts.sleepAngular;
    this.settleTime = opts.settleTime === undefined ? 0.35 : opts.settleTime;
    this.weldBodies = opts.weldBodies === undefined ? true : opts.weldBodies;

    // ---- structural integrity
    this.integrityMargin = opts.integrityMargin === undefined ? 24 : opts.integrityMargin;
    this.minBodyVoxels = opts.minBodyVoxels === undefined ? 30 : opts.minBodyVoxels;
    this.maxBodies = opts.maxBodies === undefined ? 64 : opts.maxBodies;
    this.bodyBodyCollisions = opts.bodyBodyCollisions === undefined ? true : opts.bodyBodyCollisions;

    // ---- impact damage
    this.shatterEnabled = opts.shatterEnabled === undefined ? true : opts.shatterEnabled;
    this.shatterSpeedScale = opts.shatterSpeedScale === undefined ? 9 : opts.shatterSpeedScale;
    this.crushWorld = opts.crushWorld === undefined ? true : opts.crushWorld;

    // ---- fixed-timestep clock
    this.ticks = 0;
    this.substepCount = 0;
    this.maxBacklogSubsteps = opts.maxBacklogSubsteps === undefined ? 240 : opts.maxBacklogSubsteps;

    // ---- callbacks for the renderer / fx layer (never affect simulation state)
    this.onDestroy = opts.onDestroy || null;      // (x, y, z, pal)
    this.onBodySpawn = opts.onBodySpawn || null;  // (body)
    this.onBodySettle = opts.onBodySettle || null;// (body, placement)
    this.onImpact = opts.onImpact || null;        // (body, point, speed)

    this.stats = { welds: 0, shatters: 0, detachEvents: 0 };
  }

  // ==================================================================== fixed timestep
  /**
   * Advance by a frame's dt. Runs 0..N whole substeps of SUBSTEP_H; leftover time is banked
   * as integer ticks. `maxSubsteps` caps work per call (spiral-of-death guard) *without*
   * discarding time, so a capped call just leaves a bigger backlog.
   * Returns how many substeps actually ran.
   */
  step(dt, maxSubsteps = 8) {
    if (!(dt > 0)) return 0;
    this.ticks += Math.round(dt * TICKS_PER_SECOND);
    const backlogCap = this.maxBacklogSubsteps * TICKS_PER_SUBSTEP;
    if (this.ticks > backlogCap) this.ticks = backlogCap;   // only trips after a real stall
    let n = 0;
    while (this.ticks >= TICKS_PER_SUBSTEP && n < maxSubsteps) {
      this.ticks -= TICKS_PER_SUBSTEP;
      this.substep(SUBSTEP_H);
      this.substepCount++;
      n++;
    }
    return n;
  }

  /** Advance exactly n substeps, ignoring the wall clock (replays, tests, headless sims). */
  runSubsteps(n) {
    for (let i = 0; i < n; i++) { this.substep(SUBSTEP_H); this.substepCount++; }
  }

  // ==================================================================== one substep
  substep(h) {
    const bodies = this.bodies;

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.hadContact = false;
      b.impact = null;
      b.integrate(h, this.gravity, this.linearDamping, this.angularDamping);
    }

    for (let i = 0; i < bodies.length; i++) this.solveWorldContacts(bodies[i], h);

    if (this.bodyBodyCollisions && bodies.length > 1) this.solveBodyPairs(h);

    // shatter / crush, after the solve so we act on the resolved impulses
    if (this.shatterEnabled) {
      for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i];
        if (b.impact) this.handleImpact(b, b.impact);
      }
    }

    // sleep bookkeeping + settle
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.alive) continue;
      const slow = vlen(b.v) < this.sleepLinear && vlen(b.w) < this.sleepAngular;
      if (slow && b.hadContact) b.sleepTimer += h; else b.sleepTimer = 0;
      if (b.sleepTimer >= this.settleTime) this.settleBody(b);
      if (b.pos[1] < -2) b.alive = false;   // fell off the edge of the map
    }

    // compact the body list (deterministic order preserved)
    let n = 0;
    for (let i = 0; i < bodies.length; i++) if (bodies[i].alive) bodies[n++] = bodies[i];
    bodies.length = n;

    this.debris.step(h);
  }

  // ==================================================================== contact solving
  /**
   * Sequential impulses against the static grid.
   *
   * Restitution uses the *pre-solve* approach speed (captured once) rather than the live
   * velocity, otherwise each solver iteration re-injects bounce energy and heavy chunks
   * pogo off the floor. Below `restitutionThreshold` restitution is dropped entirely, which
   * is what stops a resting slab from vibrating.
   */
  solveWorldContacts(body, h) {
    const contacts = collectWorldContacts(this.world, body);
    if (!contacts.length) return;
    body.hadContact = true;

    // precompute r, effective mass, target bounce
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      c.r = vsub(c.p, body.pos);
      const rn = vcross(c.r, c.n);
      const irn = m3MulVec(body.IinvWorld, rn);
      c.km = body.invMass + vdot(c.n, vcross(irn, c.r));
      if (c.km < 1e-12) c.km = 1e-12;
      const vrel = vdot(body.pointVelocity(c.r), c.n);
      c.vn0 = vrel;
      const surfaceMat = this.staticMaterialAt(c.p, c.n);
      const e = 0.5 * (body.restitution + surfaceMat.restitution);
      c.mu = Math.sqrt(body.friction * surfaceMat.friction);
      c.bounce = vrel < -this.restitutionThreshold ? -e * vrel : 0;
      c.jn = 0;
    }

    // track the hardest hit for the shatter pass
    let worst = null;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      if (c.vn0 < -0.5 && (!worst || c.vn0 < worst.vn0)) worst = c;
    }

    for (let it = 0; it < this.contactIterations; it++) {
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        // ---- normal
        const vAt = body.pointVelocity(c.r);
        const vn = vdot(vAt, c.n);
        let dj = (-(vn) + c.bounce) / c.km;
        const old = c.jn;
        c.jn = Math.max(0, old + dj);
        dj = c.jn - old;
        if (dj !== 0) this.applyContactImpulse(body, c.r, [c.n[0] * dj, c.n[1] * dj, c.n[2] * dj]);

        // ---- friction (Coulomb cone against the accumulated normal impulse)
        if (c.jn > 0 && c.mu > 0) {
          const v2 = body.pointVelocity(c.r);
          const vn2 = vdot(v2, c.n);
          const tx = v2[0] - c.n[0] * vn2, ty = v2[1] - c.n[1] * vn2, tz = v2[2] - c.n[2] * vn2;
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (tl > 1e-7) {
            const t = [tx / tl, ty / tl, tz / tl];
            const rt = vcross(c.r, t);
            const irt = m3MulVec(body.IinvWorld, rt);
            const ktm = body.invMass + vdot(t, vcross(irt, c.r));
            let jt = -tl / (ktm > 1e-12 ? ktm : 1e-12);
            const maxJt = c.mu * c.jn;
            jt = clamp(jt, -maxJt, maxJt);
            this.applyContactImpulse(body, c.r, [t[0] * jt, t[1] * jt, t[2] * jt]);
          }
        }
      }
    }

    // ---- positional correction: average the push so a hundred contacts don't launch it
    let px = 0, py = 0, pz = 0, cnt = 0;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const depth = c.pen - this.penetrationSlop;
      if (depth <= 0) continue;
      px += c.n[0] * depth; py += c.n[1] * depth; pz += c.n[2] * depth;
      cnt++;
    }
    if (cnt) {
      const s = this.positionBeta / cnt;
      let cx = px * s, cy = py * s, cz = pz * s;
      const l = Math.sqrt(cx * cx + cy * cy + cz * cz);
      const maxCorr = VOXEL * 0.75;
      if (l > maxCorr) { const k = maxCorr / l; cx *= k; cy *= k; cz *= k; }
      body.pos[0] += cx; body.pos[1] += cy; body.pos[2] += cz;
    }

    if (worst) {
      const speed = -worst.vn0;
      body.impact = { p: worst.p.slice(), n: worst.n.slice(), speed, li: worst.li };
      if (this.onImpact && speed > 2) this.onImpact(body, worst.p, speed);
    }
    void h;
  }

  applyContactImpulse(body, r, J) {
    body.v[0] += J[0] * body.invMass;
    body.v[1] += J[1] * body.invMass;
    body.v[2] += J[2] * body.invMass;
    const dw = m3MulVec(body.IinvWorld, vcross(r, J));
    body.w[0] += dw[0]; body.w[1] += dw[1]; body.w[2] += dw[2];
  }

  /** Material of the static voxel just behind a contact (the thing being stood on). */
  staticMaterialAt(p, n) {
    const x = Math.floor((p[0] - n[0] * VOXEL * 0.5) / VOXEL);
    const y = Math.floor((p[1] - n[1] * VOXEL * 0.5) / VOXEL);
    const z = Math.floor((p[2] - n[2] * VOXEL * 0.5) / VOXEL);
    const pal = this.world.get(x, y, z);
    return matPhys(this.palette, pal || 0);
  }

  /** Body-vs-body: one pass of impulses per overlapping pair, enough to stack rubble. */
  solveBodyPairs(h) {
    const bodies = this.bodies;
    const boxes = bodies.map((b) => b.aabb());
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const A = bodies[i], B = bodies[j];
        if (!A.alive || !B.alive) continue;
        if (!aabbOverlap(boxes[i], boxes[j])) continue;
        const contacts = collectBodyContacts(A, B);
        if (!contacts.length) continue;
        A.hadContact = true; B.hadContact = true;
        const mu = Math.sqrt(A.friction * B.friction);
        const e = 0.5 * (A.restitution + B.restitution);
        for (let it = 0; it < 2; it++) {
          for (let k = 0; k < contacts.length; k++) {
            const c = contacts[k];
            const ra = vsub(c.p, A.pos), rb = vsub(c.p, B.pos);
            const vRel = vsub(A.pointVelocity(ra), B.pointVelocity(rb));
            const vn = vdot(vRel, c.n);
            if (vn > 0) continue;
            const ira = m3MulVec(A.IinvWorld, vcross(ra, c.n));
            const irb = m3MulVec(B.IinvWorld, vcross(rb, c.n));
            const km = A.invMass + B.invMass +
              vdot(c.n, vcross(ira, ra)) + vdot(c.n, vcross(irb, rb));
            if (km < 1e-12) continue;
            const bounce = vn < -this.restitutionThreshold ? -e * vn : 0;
            const jn = (-(vn) + bounce) / km / contacts.length;
            if (jn <= 0) continue;
            const J = [c.n[0] * jn, c.n[1] * jn, c.n[2] * jn];
            this.applyContactImpulse(A, ra, J);
            this.applyContactImpulse(B, rb, [-J[0], -J[1], -J[2]]);
            // tangential scrub
            const vRel2 = vsub(A.pointVelocity(ra), B.pointVelocity(rb));
            const vn2 = vdot(vRel2, c.n);
            const tx = vRel2[0] - c.n[0] * vn2, ty = vRel2[1] - c.n[1] * vn2, tz = vRel2[2] - c.n[2] * vn2;
            const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (tl > 1e-7) {
              const t = [tx / tl, ty / tl, tz / tl];
              const jt = clamp(-tl / km / contacts.length, -mu * jn, mu * jn);
              const Jt = [t[0] * jt, t[1] * jt, t[2] * jt];
              this.applyContactImpulse(A, ra, Jt);
              this.applyContactImpulse(B, rb, [-Jt[0], -Jt[1], -Jt[2]]);
            }
          }
        }
        // separate positionally, split by inverse mass
        let deepest = contacts[0];
        for (let k = 1; k < contacts.length; k++) if (contacts[k].pen > deepest.pen) deepest = contacts[k];
        const depth = deepest.pen - this.penetrationSlop;
        if (depth > 0) {
          const total = A.invMass + B.invMass;
          if (total > 0) {
            const s = (depth * this.positionBeta) / total;
            A.pos[0] += deepest.n[0] * s * A.invMass;
            A.pos[1] += deepest.n[1] * s * A.invMass;
            A.pos[2] += deepest.n[2] * s * A.invMass;
            B.pos[0] -= deepest.n[0] * s * B.invMass;
            B.pos[1] -= deepest.n[1] * s * B.invMass;
            B.pos[2] -= deepest.n[2] * s * B.invMass;
          }
        }
      }
    }
    void h;
  }

  // ==================================================================== impact damage
  /**
   * A hard landing chips the *contact face*, it does not delete the body. We carve a small
   * sphere out of the body around the contact with an energy that falls off, so a concrete
   * block dropped from a roof loses its bottom corner and keeps going — which is what
   * actually happens, and what stops the "chunk lands, chunk vanishes" tell.
   * The same impact damages whatever it landed on, so heavy debris crushes wood and dirt.
   */
  handleImpact(body, impact) {
    const speed = impact.speed;
    if (speed < 3) return;
    // energy per unit area, compared against material strength via brittleness
    const e = speed / this.shatterSpeedScale;

    const local = [];
    const R = VOXEL * (0.6 + Math.min(2.5, speed * 0.08));
    const R2 = R * R;
    for (let k = 0; k < body.surface.length; k++) {
      const i = body.surface[k];
      const p = body.cellWorld(i);
      const dx = p[0] - impact.p[0], dy = p[1] - impact.p[1], dz = p[2] - impact.p[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > R2) continue;
      const t = Math.sqrt(d2) / R;
      const pal = body.data[i];
      const mp = matPhys(this.palette, pal);
      const local_e = e * (1 - t) * mp.brittle;
      if (local_e >= this.palette.strength(pal)) local.push(i);
    }

    if (local.length && local.length < body.cells.length) {
      const removed = body.removeCells(local);
      this.stats.shatters++;
      for (let k = 0; k < removed.length; k++) {
        const [, pal, wp] = removed[k];
        const v = body.pointVelocity(vsub(wp, body.pos));
        this.debris.spawn(wp[0], wp[1], wp[2],
          v[0] * 0.5 + this.rng.sym() * 1.5,
          Math.abs(v[1]) * 0.3 + this.rng.next() * 2,
          v[2] * 0.5 + this.rng.sym() * 1.5, pal);
      }
      if (body.alive) this.maybeSplit(body);
    }

    // crush whatever we landed on
    if (this.crushWorld && speed > 5) {
      const crushEnergy = (body.mass * speed * speed) * 4e-4;
      if (crushEnergy > 0.02) {
        const at = [
          impact.p[0] - impact.n[0] * VOXEL * 0.5,
          impact.p[1] - impact.n[1] * VOXEL * 0.5,
          impact.p[2] - impact.n[2] * VOXEL * 0.5,
        ];
        const res = carveSphere(this.world, this.palette, at, R + VOXEL, crushEnergy,
          this.onDestroy, { damage: this.damage, core: 0.3 });
        for (let k = 0; k < res.destroyed.length; k++) {
          const [x, y, z, pal] = res.destroyed[k];
          this.debris.spawnFromVoxel(x, y, z, pal, at, 1.5);
        }
      }
    }
  }

  /** After a shatter the body may be in two pieces; give each piece its own rigid body. */
  maybeSplit(body) {
    const comps = body.components();
    if (comps.length <= 1) return;
    body.alive = false;
    for (let i = 0; i < comps.length; i++) {
      if (comps[i].length < this.minBodyVoxels) {
        for (let k = 0; k < comps[i].length; k++) {
          const li = comps[i][k];
          const wp = body.cellWorld(li);
          const v = body.pointVelocity(vsub(wp, body.pos));
          this.debris.spawn(wp[0], wp[1], wp[2], v[0], v[1], v[2], body.data[li]);
        }
        continue;
      }
      const sub = body.subset(comps[i]);
      sub.sleepTimer = 0;
      this.bodies.push(sub);
      if (this.onBodySpawn) this.onBodySpawn(sub);
    }
  }

  // ==================================================================== settling / welding
  /**
   * Merge a stopped body back into the voxel grid.
   *
   * The orientation snaps to the nearest of the 24 cube rotations so the voxels land on the
   * lattice. The placement is then searched downward: we prefer the lowest integer offset
   * that has no overlap *and* touches existing geometry, because a chunk welded with a
   * 1-voxel gap under it would be flagged as detached by the very next integrity pass and
   * fall again — an infinite fall/weld loop. Where overlap is unavoidable the harder
   * material wins: incoming voxels crush weaker material (which becomes debris) and are
   * themselves shed as debris when they hit something stronger.
   */
  settleBody(body) {
    body.settled = true;
    body.alive = false;
    if (!this.weldBodies) return null;

    let best = null;
    for (let dy = 2; dy >= -3; dy--) {
      const cand = this.evaluatePlacement(body, [0, dy, 0]);
      if (!cand) continue;
      if (cand.overlap === 0 && cand.supported) { best = cand; break; }
      if (!best || cand.score > best.score) best = cand;
    }
    if (!best) return null;

    const w = this.world;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let placed = 0;
    for (let k = 0; k < best.cells.length; k++) {
      const [wx, wy, wz, pal] = best.cells[k];
      if (!w.inBounds(wx, wy, wz)) continue;
      const wi = w.idx(wx, wy, wz);
      const existing = w.data[wi];
      if (existing !== 0) {
        if (isUnbreakableMat(this.palette, existing) ||
            this.palette.strength(existing) >= this.palette.strength(pal)) {
          // we lose: shed this voxel as debris instead of overwriting
          this.debris.spawn((wx + 0.5) * VOXEL, (wy + 0.5) * VOXEL, (wz + 0.5) * VOXEL,
            0, 0.5, 0, pal);
          continue;
        }
        // we win: crush what was there
        this.debris.spawn((wx + 0.5) * VOXEL, (wy + 0.5) * VOXEL, (wz + 0.5) * VOXEL,
          this.rng.sym() * 1.2, 1.0, this.rng.sym() * 1.2, existing);
      }
      w.data[wi] = pal;
      placed++;
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
      if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
      if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
    }
    if (placed) {
      markRegionDirty(this.world, x0, y0, z0, x1, y1, z1);
      this.stats.welds++;
      body.weldBounds = { x0, y0, z0, x1, y1, z1 };
      body.weldedVoxels = placed;
      if (this.onBodySettle) this.onBodySettle(body, best);
    }
    return best;
  }

  /** Score one candidate integer placement of a settled body. */
  evaluatePlacement(body, offset) {
    const { place } = body.snapPlacement(offset);
    const w = this.world;
    const cells = new Array(body.cells.length);
    let overlap = 0, supported = false, outside = 0;
    for (let k = 0; k < body.cells.length; k++) {
      const li = body.cells[k];
      const o = place(li);
      const pal = body.data[li];
      cells[k] = [o[0], o[1], o[2], pal];
      if (!w.inBounds(o[0], o[1], o[2])) { outside++; continue; }
      if (w.data[w.idx(o[0], o[1], o[2])] !== 0) overlap++;
      if (!supported) {
        if (w.isSolidClamped(o[0], o[1] - 1, o[2]) || w.isSolidClamped(o[0], o[1] + 1, o[2]) ||
            w.isSolidClamped(o[0] - 1, o[1], o[2]) || w.isSolidClamped(o[0] + 1, o[1], o[2]) ||
            w.isSolidClamped(o[0], o[1], o[2] - 1) || w.isSolidClamped(o[0], o[1], o[2] + 1)) {
          supported = true;
        }
      }
    }
    if (outside === cells.length) return null;
    const score = (supported ? 1000 : 0) - overlap * 10 - outside * 5 - offset[1];
    return { cells, overlap, supported, outside, score, offset: offset.slice() };
  }

  // ==================================================================== destruction API
  /**
   * Spherical explosion: carve, throw debris, re-check structural integrity, and blast
   * every body in range (linear impulse *and* torque, because a blast that only pushes
   * through the centre of mass produces debris that slides instead of cartwheeling).
   */
  explode(centre, radius, energy, opts = {}) {
    const res = carveSphere(this.world, this.palette, centre, radius, energy,
      this.onDestroy, { damage: this.damage, core: opts.core, falloff: opts.falloff });

    const debrisSpeed = opts.debrisSpeed === undefined ? 6 : opts.debrisSpeed;
    const debrisFraction = opts.debrisFraction === undefined ? 0.35 : opts.debrisFraction;
    this.spawnDebrisFor(res.destroyed, centre, debrisSpeed, debrisFraction);

    const dv = opts.impulse === undefined ? Math.min(28, 4 + energy * 6) : opts.impulse;
    for (let i = 0; i < this.bodies.length; i++) {
      this.bodies[i].applyBlast(centre, radius * 2.0, dv);
    }

    const detached = this.afterEdit(res.bbox, opts);
    for (let i = 0; i < detached.length; i++) detached[i].applyBlast(centre, radius * 2.0, dv);

    return { ...res, bodies: detached };
  }

  /** Blowtorch / laser cut along a segment. */
  cut(a, b, radius, energy, opts = {}) {
    const res = carveCapsule(this.world, this.palette, a, b, radius, energy,
      this.onDestroy, { damage: this.damage, core: opts.core, falloff: opts.falloff });
    const mid = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
    this.spawnDebrisFor(res.destroyed, mid, opts.debrisSpeed === undefined ? 1.2 : opts.debrisSpeed,
      opts.debrisFraction === undefined ? 0.25 : opts.debrisFraction);
    const detached = this.afterEdit(res.bbox, opts);
    return { ...res, bodies: detached };
  }

  /** Shot along a ray (bullets, shotgun pellets). */
  shoot(origin, dir, length, radius, energy, opts = {}) {
    const res = carveRay(this.world, this.palette, origin, dir, length, radius, energy,
      this.onDestroy, { damage: this.damage, core: opts.core, falloff: opts.falloff });
    this.spawnDebrisFor(res.destroyed, origin, opts.debrisSpeed === undefined ? 4 : opts.debrisSpeed,
      opts.debrisFraction === undefined ? 0.5 : opts.debrisFraction);
    const detached = this.afterEdit(res.bbox, opts);
    return { ...res, bodies: detached };
  }

  /** Box demolition charge. */
  carveBoxAt(min, max, energy, opts = {}) {
    const res = carveBox(this.world, this.palette, min, max, energy,
      this.onDestroy, { damage: this.damage, edgeFalloff: opts.edgeFalloff });
    const mid = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
    this.spawnDebrisFor(res.destroyed, mid, opts.debrisSpeed === undefined ? 3 : opts.debrisSpeed,
      opts.debrisFraction === undefined ? 0.3 : opts.debrisFraction);
    const detached = this.afterEdit(res.bbox, opts);
    return { ...res, bodies: detached };
  }

  spawnDebrisFor(destroyed, centre, speed, fraction) {
    if (!destroyed.length || fraction <= 0) return;
    const stride = fraction >= 1 ? 1 : Math.max(1, Math.round(1 / fraction));
    for (let i = 0; i < destroyed.length; i += stride) {
      const [x, y, z, pal] = destroyed[i];
      this.debris.spawnFromVoxel(x, y, z, pal, centre, speed);
    }
  }

  /**
   * Structural-integrity pass over the edited region. Detached groups leave the grid: small
   * ones crumble into debris, big ones become rigid bodies.
   */
  afterEdit(bbox, opts = {}) {
    if (!bbox) return [];
    const margin = opts.integrityMargin === undefined ? this.integrityMargin : opts.integrityMargin;
    const groups = findDetached(this.world, this.palette, bbox, { margin });
    const spawned = [];
    if (!groups.length) return spawned;
    this.stats.detachEvents++;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const voxels = groupVoxels(this.world, g);
      liftVoxels(this.world, voxels);

      if (g.size < this.minBodyVoxels || this.bodies.length >= this.maxBodies) {
        const c = [
          ((g.min[0] + g.max[0]) * 0.5 + 0.5) * VOXEL,
          ((g.min[1] + g.max[1]) * 0.5 + 0.5) * VOXEL,
          ((g.min[2] + g.max[2]) * 0.5 + 0.5) * VOXEL,
        ];
        for (let k = 0; k < voxels.length; k++) {
          const [x, y, z, pal] = voxels[k];
          this.debris.spawnFromVoxel(x, y, z, pal, c, 0.6);
        }
        continue;
      }

      const body = VoxelBody.fromVoxels(voxels, this.palette);
      this.bodies.push(body);
      spawned.push(body);
      if (this.onBodySpawn) this.onBodySpawn(body);
    }
    return spawned;
  }

  /** Detach a group by hand (scripted collapses, editor). */
  spawnBody(voxels, opts = {}) {
    liftVoxels(this.world, voxels);
    const body = VoxelBody.fromVoxels(voxels, this.palette, opts);
    this.bodies.push(body);
    if (this.onBodySpawn) this.onBodySpawn(body);
    return body;
  }

  totalDebris() { return this.debris.count; }
}

// ==================================================================== determinism helper
/**
 * FNV-1a over the world grid plus every body/debris float. Two simulations that hash the
 * same have identical state down to the last mantissa bit — this is what the fixed-timestep
 * test asserts, and it doubles as a desync check if this ever runs over a network.
 */
export function hashState(phys) {
  let h = 0x811c9dc5 >>> 0;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const b = new Uint8Array(buf);
  const byte = (v) => { h ^= v & 255; h = Math.imul(h, 0x01000193) >>> 0; };
  const int = (v) => { byte(v); byte(v >>> 8); byte(v >>> 16); byte(v >>> 24); };
  const num = (v) => { f[0] = v; for (let i = 0; i < 8; i++) byte(b[i]); };

  const d = phys.world.data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) { int(i); byte(d[i]); }

  int(phys.substepCount);
  int(phys.bodies.length);
  for (let i = 0; i < phys.bodies.length; i++) {
    const bd = phys.bodies[i];
    int(bd.voxelCount);
    for (let k = 0; k < 3; k++) { num(bd.pos[k]); num(bd.v[k]); num(bd.w[k]); }
    for (let k = 0; k < 4; k++) num(bd.q[k]);
  }
  int(phys.debris.count);
  for (let i = 0; i < phys.debris.parts.length; i++) {
    const p = phys.debris.parts[i];
    num(p.x); num(p.y); num(p.z); num(p.vx); num(p.vy); num(p.vz); byte(p.pal);
  }
  return h >>> 0;
}

export { VoxelBody, DebrisSystem, carveSphere, carveCapsule, carveRay, carveBox };
