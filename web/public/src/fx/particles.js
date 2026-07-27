// particles.js — one pooled particle system for every effect in the game.
//
// Design constraints, in order of importance:
//
//  1. Smoke has to look like Teardown's smoke. That means volume and *darkness*: thick,
//     near-black at the source where it is dense and hot, thinning and lightening to ash
//     grey as it rises, cools and expands. It has to churn — buoyancy plus drag alone
//     gives straight-line rising blobs, so every buoyant particle is pushed by a curl
//     noise field which folds it as it climbs. And it has to drift: one global wind
//     vector, so a column of smoke leans downwind and a whole burning lot reads as one
//     weather system rather than a set of independent puffs.
//  2. No allocation after construction. Every array is sized once from `capacity`;
//     spawning takes an index off a free list, dying pushes it back. buildInstances()
//     fills preallocated output buffers and hands back the same object every call.
//  3. Deterministic. step() consumes no randomness at all (flicker comes from a
//     stateless hash of slot+step), so only the emitters draw from the seeded stream,
//     and they are called from inside the fixed step.
//
// Units are metres and seconds throughout. Positions are world space, so the caller can
// feed voxel centres as (v + 0.5) * VOXEL.

import { VOXEL } from '../voxel/world.js';
import { MAT } from '../voxel/palette.js';
import { Rng } from './rng.js';
import { curlNoise3 } from './noise.js';
import { FixedStepper } from './clock.js';
import { readVec } from './fire.js';

export const PType = {
  SMOKE: 0,
  FIRE: 1,
  SPARK: 2,
  DEBRIS: 3,
  DUST: 4,
  GLASS_SHARD: 5,
  EMBER: 6,
};
export const PTYPE_COUNT = 7;
export const PTYPE_NAMES = ['SMOKE', 'FIRE', 'SPARK', 'DEBRIS', 'DUST', 'GLASS_SHARD', 'EMBER'];

// Collision responses.
const COL_NONE = 0;
const COL_SOFT = 1;    // gas: stops at the surface and spreads along it
const COL_BOUNCE = 2;  // solid: reflects with restitution and friction

// Per-type physics. `budget` is the share of the pool a type may occupy, so a long-lived
// smoke column can never starve the flames that are producing it.
const T = [];
T[PType.SMOKE] = {
  buoyancy: 7.0, cool: 0.5, drag: 1.35, gravity: 0, turb: 1.9, turbFreq: 0.55,
  wind: 1.0, collide: COL_SOFT, restitution: 0, budget: 0.5, additive: false,
};
T[PType.FIRE] = {
  buoyancy: 10.0, cool: 2.4, drag: 2.6, gravity: 0, turb: 2.6, turbFreq: 1.3,
  wind: 0.35, collide: COL_SOFT, restitution: 0, budget: 0.22, additive: true,
};
T[PType.SPARK] = {
  buoyancy: 0, cool: 2.2, drag: 0.45, gravity: -9.81, turb: 0.7, turbFreq: 1.8,
  wind: 0.15, collide: COL_BOUNCE, restitution: 0.42, budget: 0.2, additive: true,
};
T[PType.DEBRIS] = {
  buoyancy: 0, cool: 0, drag: 0.14, gravity: -9.81, turb: 0, turbFreq: 0,
  wind: 0.03, collide: COL_BOUNCE, restitution: 0.26, budget: 0.28, additive: false,
};
T[PType.DUST] = {
  buoyancy: 1.1, cool: 1.0, drag: 1.8, gravity: -0.6, turb: 1.3, turbFreq: 0.7,
  wind: 1.0, collide: COL_SOFT, restitution: 0, budget: 0.22, additive: false,
};
T[PType.GLASS_SHARD] = {
  buoyancy: 0, cool: 0, drag: 0.09, gravity: -9.81, turb: 0, turbFreq: 0,
  wind: 0.03, collide: COL_BOUNCE, restitution: 0.5, budget: 0.12, additive: false,
};
T[PType.EMBER] = {
  buoyancy: 4.2, cool: 0.7, drag: 1.15, gravity: -1.8, turb: 3.0, turbFreq: 1.1,
  wind: 0.8, collide: COL_SOFT, restitution: 0, budget: 0.12, additive: true,
};
export const PTYPE_TRAITS = T;

const SMOKE_HOT = [0.085, 0.078, 0.072];    // dense, near-black, right off the flame
const SMOKE_COOL = [0.50, 0.495, 0.485];    // thinned-out ash grey, high in the column

export class ParticleSystem {
  constructor(opts = {}) {
    const cap = this.capacity = Math.max(1, opts.capacity ?? 8192);
    this.world = opts.world || null;
    this.palette = opts.palette || null;
    this.fixedDt = opts.fixedDt ?? 1 / 60;
    this.seed = (opts.seed ?? 1337) >>> 0;
    this.rng = new Rng(this.seed ^ 0x2545F491);
    this.stepper = new FixedStepper(this.fixedDt, opts.maxStepsPerUpdate ?? 8);

    this.wind = new Float32Array(3);
    if (opts.wind) { this.wind[0] = opts.wind[0]; this.wind[1] = opts.wind[1]; this.wind[2] = opts.wind[2]; }
    else { this.wind[0] = 0.55; this.wind[1] = 0.0; this.wind[2] = 0.22; }
    this.gravityScale = opts.gravityScale ?? 1;
    this.turbulenceScale = opts.turbulenceScale ?? 1;
    // Curl noise is twelve noise taps; refreshing every particle every step is wasteful
    // when the field barely changes in 16 ms. Each particle refreshes on its own step
    // phase, (slot + step) % N, which also decorrelates neighbours.
    this.turbulenceRefresh = Math.max(1, opts.turbulenceRefresh ?? 6);

    this.time = 0;
    this.steps = 0;
    this.spawned = 0;
    this.rejected = 0;

    // ---- pool (structure of arrays; nothing here is ever reallocated)
    this.px = new Float32Array(cap); this.py = new Float32Array(cap); this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap);        // seconds remaining
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);       // size at birth
    this.size1 = new Float32Array(cap);       // size at death (smoke grows, embers shrink)
    this.size = new Float32Array(cap);        // resolved, refreshed by buildInstances
    this.rot = new Float32Array(cap);
    this.rotVel = new Float32Array(cap);
    this.temp = new Float32Array(cap);        // 1 = as emitted, 0 = fully cooled
    this.alphaPeak = new Float32Array(cap);
    this.alpha = new Float32Array(cap);       // resolved, refreshed by buildInstances
    // Colour is a hot->cool ramp resolved by temperature, which is what gives smoke its
    // dark-at-the-base gradient and fire its white->orange->red falloff for free.
    this.hr = new Float32Array(cap); this.hg = new Float32Array(cap); this.hb = new Float32Array(cap);
    this.cr = new Float32Array(cap); this.cg = new Float32Array(cap); this.cb = new Float32Array(cap);
    this.r = new Float32Array(cap); this.g = new Float32Array(cap); this.b = new Float32Array(cap);
    this.tx = new Float32Array(cap); this.ty = new Float32Array(cap); this.tz = new Float32Array(cap);
    this.type = new Uint8Array(cap);
    this.flags = new Uint8Array(cap);         // bit 0: settled

    this.free = new Int32Array(cap);
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
    this.freeCount = cap;
    this.alive = new Int32Array(cap);
    this.aliveSlot = new Int32Array(cap).fill(-1);   // slot -> index in `alive`
    this.aliveCount = 0;
    this.typeCount = new Int32Array(PTYPE_COUNT);
    this.typeBudget = new Int32Array(PTYPE_COUNT);
    for (let t = 0; t < PTYPE_COUNT; t++)
      this.typeBudget[t] = Math.max(8, Math.floor(cap * T[t].budget));

    // ---- instance output, split by blend mode. Fire and sparks must be added into the
    // frame buffer or they look like orange paper; smoke must not be, or it cannot
    // darken anything behind it. Two draws, so two buffers.
    this.blend = makeInstanceBuffers(cap);
    this.additive = makeInstanceBuffers(cap);
    this.instances = { blend: this.blend, additive: this.additive };

    this._v = new Float32Array(3);      // scratch direction
    this._c = new Float32Array(3);      // scratch colour
    this._curl = new Float32Array(3);
  }

  // ------------------------------------------------------------------ pool
  get count() { return this.aliveCount; }

  /** Take a slot, or -1 if the pool or this type's share is full. */
  _spawn(type) {
    if (this.freeCount === 0 || this.typeCount[type] >= this.typeBudget[type]) {
      this.rejected++;
      return -1;
    }
    const i = this.free[--this.freeCount];
    this.aliveSlot[i] = this.aliveCount;
    this.alive[this.aliveCount++] = i;
    this.typeCount[type]++;
    this.type[i] = type;
    this.flags[i] = 0;
    this.rot[i] = 0; this.rotVel[i] = 0;
    this.temp[i] = 1;
    this.tx[i] = 0; this.ty[i] = 0; this.tz[i] = 0;
    this.spawned++;
    return i;
  }

  /** Retire the particle at position `ai` in the alive list (swap-remove). */
  _kill(ai) {
    const slot = this.alive[ai];
    this.typeCount[this.type[slot]]--;
    const last = --this.aliveCount;
    if (ai !== last) {
      const moved = this.alive[last];
      this.alive[ai] = moved;
      this.aliveSlot[moved] = ai;
    }
    this.aliveSlot[slot] = -1;
    this.free[this.freeCount++] = slot;
  }

  clear() { while (this.aliveCount > 0) this._kill(this.aliveCount - 1); }

  setWind(x, y, z) { this.wind[0] = x; this.wind[1] = y; this.wind[2] = z; }

  // ------------------------------------------------------------------ simulation
  update(dt) {
    const n = this.stepper.advance(dt);
    for (let i = 0; i < n; i++) this.step(this.fixedDt);
    return n;
  }

  step(dt) {
    this.time += dt;
    const step = ++this.steps;
    const world = this.world;
    const refresh = this.turbulenceRefresh;
    const curl = this._curl;
    const wx = this.wind[0], wy = this.wind[1], wz = this.wind[2];

    for (let ai = 0; ai < this.aliveCount; ai++) {
      const i = this.alive[ai];
      const t = this.type[i];
      const tr = T[t];

      const life = this.life[i] - dt;
      if (life <= 0) { this._kill(ai); ai--; continue; }
      this.life[i] = life;

      // --- cooling. Drives buoyancy (hot rises, cooled flattens out) and colour.
      if (tr.cool > 0) {
        const k = tr.cool * dt;
        this.temp[i] *= k < 1 ? (1 - k) : 0;
      }
      const temp = this.temp[i];

      // --- turbulence, refreshed on this particle's own phase
      if (tr.turb > 0 && ((step + i) % refresh) === 0) {
        const f = tr.turbFreq;
        // Advect the field itself, so the churn is not frozen in space.
        curlNoise3(this.px[i] * f + this.time * 0.11,
                   this.py[i] * f - this.time * 0.19,
                   this.pz[i] * f + this.time * 0.07, curl, this.seed);
        const s = tr.turb * this.turbulenceScale;
        this.tx[i] = curl[0] * s; this.ty[i] = curl[1] * s; this.tz[i] = curl[2] * s;
      }

      let ax = this.tx[i], ay = this.ty[i], az = this.tz[i];

      // --- buoyancy: proportional to how hot the parcel still is. The whole "rises fast
      // then flattens out" behaviour falls out of this plus cooling; no special case.
      if (tr.buoyancy > 0) ay += tr.buoyancy * temp;
      if (tr.gravity !== 0) ay += tr.gravity * this.gravityScale;

      // --- drag toward the wind. One term does both jobs: air resistance and advection.
      const kw = tr.wind, d = tr.drag;
      if (d > 0) {
        ax += ((wx * kw) - this.vx[i]) * d;
        ay += ((wy * kw) - this.vy[i]) * d;
        az += ((wz * kw) - this.vz[i]) * d;
      }

      let vx = this.vx[i] + ax * dt;
      let vy = this.vy[i] + ay * dt;
      let vz = this.vz[i] + az * dt;

      // --- integrate, per axis, against the voxel grid so nothing pours through a floor
      let x = this.px[i], y = this.py[i], z = this.pz[i];
      if (tr.collide !== COL_NONE && world) {
        const nx = x + vx * dt;
        if (solidAt(world, nx, y, z)) {
          if (tr.collide === COL_BOUNCE) { vx = -vx * tr.restitution; vy *= 0.86; vz *= 0.86; }
          else vx *= -0.12;
        } else x = nx;

        const ny = y + vy * dt;
        if (solidAt(world, x, ny, z)) {
          if (tr.collide === COL_BOUNCE) {
            vy = -vy * tr.restitution;
            vx *= 0.72; vz *= 0.72;                      // ground friction
            if (Math.abs(vy) < 0.35) {                   // settle instead of jittering
              vy = 0; vx *= 0.35; vz *= 0.35;
              this.flags[i] |= 1;
              this.rotVel[i] *= 0.3;
            }
          } else {
            // Gas hitting a ceiling or a floor spills sideways instead of stopping dead.
            // This is what makes smoke pool under a roof and roll along the ground.
            const spill = Math.abs(vy) * 0.75;
            vx += this.tx[i] * 0.5 + (this.tx[i] >= 0 ? spill : -spill) * 0.35;
            vz += this.tz[i] * 0.5 + (this.tz[i] >= 0 ? spill : -spill) * 0.35;
            vy *= -0.08;
          }
        } else y = ny;

        const nz = z + vz * dt;
        if (solidAt(world, x, y, nz)) {
          if (tr.collide === COL_BOUNCE) { vz = -vz * tr.restitution; vx *= 0.86; vy *= 0.86; }
          else vz *= -0.12;
        } else z = nz;
      } else {
        x += vx * dt; y += vy * dt; z += vz * dt;
      }

      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.rot[i] += this.rotVel[i] * dt;
    }
  }

  // ------------------------------------------------------------------ appearance
  /** Resolve size, colour and alpha for one live slot. Cheap, and always current. */
  _resolve(i) {
    const t = this.type[i];
    const age = 1 - this.life[i] / this.maxLife[i];
    const temp = this.temp[i];
    this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * age;
    // Types that never cool (debris, glass) ramp their colour by age instead.
    const mix = T[t].cool > 0 ? temp : 1 - age;
    this.r[i] = this.cr[i] + (this.hr[i] - this.cr[i]) * mix;
    this.g[i] = this.cg[i] + (this.hg[i] - this.cg[i]) * mix;
    this.b[i] = this.cb[i] + (this.hb[i] - this.cb[i]) * mix;

    const peak = this.alphaPeak[i];
    const u = 1 - age;
    let a;
    switch (t) {
      case PType.SMOKE: {
        // Bloom in over the first slice of life instead of popping, then thin out. Hot
        // smoke is also denser, which reinforces the dark base of the column.
        const fin = age < 0.08 ? age / 0.08 : 1;
        a = peak * fin * u * u * (0.55 + 0.45 * temp);
        break;
      }
      case PType.DUST: {
        const fin = age < 0.12 ? age / 0.12 : 1;
        a = peak * fin * u * u;
        break;
      }
      case PType.FIRE:
        a = peak * Math.sqrt(u) * (0.35 + 0.65 * temp);
        break;
      case PType.EMBER:
        a = peak * u * (0.55 + 0.45 * hashFlicker(i, this.steps));   // embers wink
        break;
      case PType.DEBRIS:
      case PType.GLASS_SHARD:
        a = peak * (u < 0.25 ? u * 4 : 1);
        break;
      default:
        a = peak * u;
    }
    this.alpha[i] = a;
    return a;
  }

  // ------------------------------------------------------------------ emitters
  /**
   * A steady flame off one burning voxel. Small, fast, bright, additive; a handful of
   * these per fire voxel per second is what a burning plank looks like.
   */
  fireEmit(pos, intensity = 1) {
    const x = readVec(pos, 0), y = readVec(pos, 1), z = readVec(pos, 2);
    const i = this._spawn(PType.FIRE);
    if (i < 0) return -1;
    const rng = this.rng;
    this.px[i] = x + rng.sym(0.055); this.py[i] = y + rng.range(-0.02, 0.07); this.pz[i] = z + rng.sym(0.055);
    this.vx[i] = rng.sym(0.28); this.vy[i] = rng.range(0.55, 1.5) * (0.6 + intensity * 0.6); this.vz[i] = rng.sym(0.28);
    this.maxLife[i] = this.life[i] = rng.range(0.28, 0.62);
    this.size0[i] = rng.range(0.10, 0.20) * (0.7 + intensity * 0.5);
    this.size1[i] = this.size0[i] * rng.range(1.6, 2.6);
    this.rotVel[i] = rng.sym(3.5);
    this.alphaPeak[i] = rng.range(0.65, 0.95);
    setRamp(this, i, 1.0, 0.92, 0.62, 0.85, 0.22, 0.045);   // white-hot -> deep red
    return i;
  }

  /**
   * Thick dark smoke. `strength` scales size, lifetime and opacity together — 1 is one
   * burning voxel, 3+ is an explosion or a fuel fire.
   */
  smokePlume(pos, strength = 1) {
    const x = readVec(pos, 0), y = readVec(pos, 1), z = readVec(pos, 2);
    const i = this._spawn(PType.SMOKE);
    if (i < 0) return -1;
    const rng = this.rng;
    const s = Math.max(0.25, strength);
    this.px[i] = x + rng.sym(0.09 * s); this.py[i] = y + rng.range(0, 0.12 * s); this.pz[i] = z + rng.sym(0.09 * s);
    this.vx[i] = rng.sym(0.35); this.vy[i] = rng.range(0.6, 1.6) * s; this.vz[i] = rng.sym(0.35);
    this.maxLife[i] = this.life[i] = rng.range(3.0, 6.5) * (0.7 + 0.3 * s);
    this.size0[i] = rng.range(0.18, 0.34) * s;
    this.size1[i] = this.size0[i] * rng.range(4.5, 8.0);     // billows as it cools
    this.rotVel[i] = rng.sym(0.9);
    this.alphaPeak[i] = rng.range(0.45, 0.78);
    this.temp[i] = rng.range(0.85, 1);
    // A slight warm cast at the base, where it is still lit by the fire it came from.
    const w = rng.range(0, 0.05);
    setRamp(this, i,
            SMOKE_HOT[0] + w * 1.6, SMOKE_HOT[1] + w * 0.6, SMOKE_HOT[2],
            SMOKE_COOL[0] * rng.range(0.85, 1.15),
            SMOKE_COOL[1] * rng.range(0.85, 1.15),
            SMOKE_COOL[2] * rng.range(0.85, 1.15));
    return i;
  }

  /** Steam — a fire being put out, or water hitting something hot. Bright and short. */
  steamPuff(pos, strength = 1) {
    const i = this.smokePlume(pos, strength * 0.8);
    if (i < 0) return -1;
    const rng = this.rng;
    this.maxLife[i] = this.life[i] = rng.range(0.9, 1.8);
    this.alphaPeak[i] = rng.range(0.25, 0.45);
    setRamp(this, i, 0.92, 0.94, 0.96, 0.78, 0.80, 0.83);
    return i;
  }

  /** An ember lifting off a fire: glowing, buoyant, spiralling on the curl field. */
  emberEmit(pos, intensity = 1) {
    const x = readVec(pos, 0), y = readVec(pos, 1), z = readVec(pos, 2);
    const i = this._spawn(PType.EMBER);
    if (i < 0) return -1;
    const rng = this.rng;
    this.px[i] = x + rng.sym(0.07); this.py[i] = y + rng.range(0, 0.1); this.pz[i] = z + rng.sym(0.07);
    this.vx[i] = rng.sym(0.6); this.vy[i] = rng.range(0.7, 2.2) * intensity; this.vz[i] = rng.sym(0.6);
    this.maxLife[i] = this.life[i] = rng.range(1.4, 3.6);
    this.size0[i] = rng.range(0.018, 0.045);
    this.size1[i] = this.size0[i] * rng.range(0.45, 0.9);    // burns down as it flies
    this.rotVel[i] = rng.sym(6);
    this.alphaPeak[i] = rng.range(0.7, 1.0);
    setRamp(this, i, 1.0, 0.72, 0.28, 0.55, 0.10, 0.02);
    return i;
  }

  spark(pos, dir, energy = 1) {
    const i = this._spawn(PType.SPARK);
    if (i < 0) return -1;
    const rng = this.rng;
    const v = this._v;
    if (dir) rng.coneVec(readVec(dir, 0), readVec(dir, 1), readVec(dir, 2), 0.85, v);
    else rng.unitVec(v);
    const sp = rng.range(2.5, 9) * (0.5 + energy * 0.7);
    this.px[i] = readVec(pos, 0); this.py[i] = readVec(pos, 1); this.pz[i] = readVec(pos, 2);
    this.vx[i] = v[0] * sp; this.vy[i] = v[1] * sp + rng.range(0.3, 1.6); this.vz[i] = v[2] * sp;
    this.maxLife[i] = this.life[i] = rng.range(0.25, 0.85);
    this.size0[i] = rng.range(0.012, 0.03);
    this.size1[i] = this.size0[i] * 0.5;
    this.rotVel[i] = rng.sym(12);
    this.alphaPeak[i] = 1;
    setRamp(this, i, 1.0, 0.96, 0.80, 1.0, 0.42, 0.06);
    return i;
  }

  /** A tumbling chip knocked off a voxel — it keeps that voxel's own colour. */
  debrisChip(pos, dir, palIdx, energy = 1) {
    return this._chip(PType.DEBRIS, pos, dir, palIdx, energy);
  }

  glassShard(pos, dir, palIdx, energy = 1) {
    return this._chip(PType.GLASS_SHARD, pos, dir, palIdx, energy);
  }

  _chip(type, pos, dir, palIdx, energy) {
    const i = this._spawn(type);
    if (i < 0) return -1;
    const rng = this.rng;
    const glass = type === PType.GLASS_SHARD;
    const v = this._v;
    if (dir) rng.coneVec(readVec(dir, 0), readVec(dir, 1), readVec(dir, 2), glass ? 0.85 : 0.7, v);
    else rng.unitVec(v);
    const sp = rng.range(1.0, 4.5) * (0.4 + energy * 0.8) * (glass ? 1.35 : 1);
    this.px[i] = readVec(pos, 0) + rng.sym(0.04);
    this.py[i] = readVec(pos, 1) + rng.sym(0.04);
    this.pz[i] = readVec(pos, 2) + rng.sym(0.04);
    this.vx[i] = v[0] * sp; this.vy[i] = v[1] * sp + rng.range(0.5, 2.2); this.vz[i] = v[2] * sp;
    this.maxLife[i] = this.life[i] = glass ? rng.range(1.2, 2.6) : rng.range(2.2, 5.0);
    this.size0[i] = this.size1[i] = (glass ? rng.range(0.3, 0.9) : rng.range(0.5, 1.4)) * VOXEL;
    this.rot[i] = rng.range(0, 6.283);
    this.rotVel[i] = rng.sym(glass ? 22 : 14);
    this.alphaPeak[i] = glass ? rng.range(0.55, 0.85) : 1;
    const c = this._paletteColor(palIdx);
    if (glass) {
      setRamp(this, i, Math.min(1, c[0] * 1.5 + 0.25), Math.min(1, c[1] * 1.5 + 0.25),
              Math.min(1, c[2] * 1.5 + 0.3), c[0], c[1], c[2]);
    } else {
      setRamp(this, i, c[0], c[1], c[2], c[0] * 0.72, c[1] * 0.72, c[2] * 0.72);
    }
    return i;
  }

  dustPuff(pos, strength = 1, palIdx = 0) {
    const i = this._spawn(PType.DUST);
    if (i < 0) return -1;
    const rng = this.rng;
    const s = Math.max(0.2, strength);
    this.px[i] = readVec(pos, 0) + rng.sym(0.12 * s);
    this.py[i] = readVec(pos, 1) + rng.sym(0.12 * s);
    this.pz[i] = readVec(pos, 2) + rng.sym(0.12 * s);
    this.vx[i] = rng.sym(1.1 * s); this.vy[i] = rng.range(0.1, 0.9) * s; this.vz[i] = rng.sym(1.1 * s);
    this.maxLife[i] = this.life[i] = rng.range(1.4, 3.4);
    this.size0[i] = rng.range(0.12, 0.3) * s;
    this.size1[i] = this.size0[i] * rng.range(2.5, 4.5);
    this.rotVel[i] = rng.sym(1.2);
    this.alphaPeak[i] = rng.range(0.18, 0.4);
    if (palIdx) {
      const c = this._paletteColor(palIdx);
      setRamp(this, i, c[0] * 1.25 + 0.1, c[1] * 1.25 + 0.1, c[2] * 1.25 + 0.1,
              c[0] * 0.9 + 0.25, c[1] * 0.9 + 0.25, c[2] * 0.9 + 0.25);
    } else {
      setRamp(this, i, 0.62, 0.58, 0.52, 0.72, 0.69, 0.64);
    }
    return i;
  }

  /**
   * Explosion: a flash of flame, a fast dark ball of smoke that keeps climbing for
   * seconds, a shower of sparks and embers, and a dust ring pushed out along the ground.
   * @param pos    [x,y,z] metres
   * @param radius blast radius in metres
   */
  explosionBurst(pos, radius = 1.5) {
    const x = readVec(pos, 0), y = readVec(pos, 1), z = readVec(pos, 2);
    const rng = this.rng;
    const s = Math.max(0.3, radius);
    const v = this._v;
    let n = 0;

    const flames = Math.min(48, Math.round(14 * s));
    for (let k = 0; k < flames; k++) {
      const i = this.fireEmit(pos, 1.6);
      if (i < 0) break;
      rng.unitVec(v);
      const sp = rng.range(1.5, 7) * s;
      this.px[i] = x + v[0] * rng.range(0, 0.3) * s;
      this.py[i] = y + v[1] * rng.range(0, 0.3) * s;
      this.pz[i] = z + v[2] * rng.range(0, 0.3) * s;
      this.vx[i] = v[0] * sp; this.vy[i] = v[1] * sp + rng.range(0.5, 3); this.vz[i] = v[2] * sp;
      this.maxLife[i] = this.life[i] = rng.range(0.35, 0.95);
      this.size0[i] = rng.range(0.25, 0.6) * s;
      this.size1[i] = this.size0[i] * rng.range(1.4, 2.2);
      n++;
    }

    const smokes = Math.min(90, Math.round(22 * s));
    for (let k = 0; k < smokes; k++) {
      const i = this.smokePlume(pos, 1.6 * s);
      if (i < 0) break;
      rng.unitVec(v);
      const sp = rng.range(1.0, 5.0) * s;
      this.vx[i] = v[0] * sp;
      this.vy[i] = Math.abs(v[1]) * sp * 0.7 + rng.range(0.8, 3.2);
      this.vz[i] = v[2] * sp;
      this.maxLife[i] = this.life[i] = rng.range(5, 11);
      this.size1[i] = this.size0[i] * rng.range(6, 11);
      n++;
    }

    const sparks = Math.min(140, Math.round(34 * s));
    for (let k = 0; k < sparks; k++) { if (this.spark(pos, null, 1.4 * s) < 0) break; n++; }

    const embers = Math.min(40, Math.round(11 * s));
    for (let k = 0; k < embers; k++) { if (this.emberEmit(pos, 1.5) < 0) break; n++; }

    // Ground-hugging dust ring.
    const dust = Math.min(46, Math.round(13 * s));
    for (let k = 0; k < dust; k++) {
      const i = this.dustPuff(pos, 1.5 * s);
      if (i < 0) break;
      rng.unitVec(v);
      const sp = rng.range(2, 6) * s;
      this.vx[i] = v[0] * sp; this.vy[i] = Math.abs(v[1]) * 0.6; this.vz[i] = v[2] * sp;
      n++;
    }
    return n;
  }

  /**
   * Something hit something. Chips fly off along the normal in the struck voxel's own
   * colour, dust puffs, metal and stone throw sparks, glass throws shards.
   * @param pos    [x,y,z] metres
   * @param normal [x,y,z] surface normal
   * @param palIdx palette index of the material that was hit
   * @param energy roughly 0..3
   */
  impactBurst(pos, normal, palIdx = 0, energy = 1) {
    const e = Math.max(0.05, energy);
    const mat = this.palette ? this.palette.mat[palIdx] : MAT.CONCRETE;
    let n = 0;

    const chips = Math.min(28, Math.round(3 + 6 * e));
    const glass = mat === MAT.GLASS;
    for (let k = 0; k < chips; k++) {
      if (this._chip(glass ? PType.GLASS_SHARD : PType.DEBRIS, pos, normal, palIdx, e) < 0) break;
      n++;
    }

    const dust = Math.min(16, Math.round(2 + 4 * e));
    for (let k = 0; k < dust; k++) { if (this.dustPuff(pos, 0.5 + 0.5 * e, palIdx) < 0) break; n++; }

    // Steel on stone strikes sparks; wood and dirt do not.
    if (mat === MAT.METAL || mat === MAT.HEAVY_METAL || mat === MAT.CONCRETE || mat === MAT.BRICK) {
      const sp = Math.min(24, Math.round(4 * e));
      for (let k = 0; k < sp; k++) { if (this.spark(pos, normal, e) < 0) break; n++; }
    }
    return n;
  }

  _paletteColor(palIdx) {
    const c = this._c;
    if (this.palette && palIdx) {
      c[0] = this.palette.r[palIdx] / 255;
      c[1] = this.palette.g[palIdx] / 255;
      c[2] = this.palette.b[palIdx] / 255;
    } else { c[0] = 0.5; c[1] = 0.5; c[2] = 0.5; }
    return c;
  }

  // ------------------------------------------------------------------ render feed
  /**
   * Fill the instance buffers. Returns the *same* object every call — the renderer keeps
   * one InstancedBufferGeometry per blend mode and re-uploads `count` instances.
   *
   * `additive` (fire, sparks, embers) wants additive blending with depth-write off;
   * `blend` (smoke, debris, dust, glass) wants ordinary alpha blending. Smoke is not
   * depth-sorted here — that needs the camera, so the renderer sorts `blend`
   * back-to-front itself if it wants correct overlap between puffs.
   */
  buildInstances() {
    const b = this.blend, a = this.additive;
    let bn = 0, an = 0;
    for (let ai = 0; ai < this.aliveCount; ai++) {
      const i = this.alive[ai];
      const t = this.type[i];
      this._resolve(i);
      const additive = T[t].additive;
      const dst = additive ? a : b;
      const k = additive ? an++ : bn++;
      const k3 = k * 3;
      dst.position[k3] = this.px[i]; dst.position[k3 + 1] = this.py[i]; dst.position[k3 + 2] = this.pz[i];
      dst.color[k3] = this.r[i]; dst.color[k3 + 1] = this.g[i]; dst.color[k3 + 2] = this.b[i];
      dst.size[k] = this.size[i];
      dst.alpha[k] = this.alpha[i];
      dst.rotation[k] = this.rot[i];
      dst.type[k] = t;
    }
    b.count = bn; a.count = an;
    return this.instances;
  }

  stats() {
    const perType = {};
    for (let t = 0; t < PTYPE_COUNT; t++) perType[PTYPE_NAMES[t]] = this.typeCount[t];
    return {
      alive: this.aliveCount, capacity: this.capacity, free: this.freeCount,
      spawned: this.spawned, rejected: this.rejected, perType,
    };
  }
}

function makeInstanceBuffers(cap) {
  return {
    count: 0,
    position: new Float32Array(cap * 3),
    color: new Float32Array(cap * 3),
    size: new Float32Array(cap),
    alpha: new Float32Array(cap),
    rotation: new Float32Array(cap),
    type: new Float32Array(cap),
  };
}

function setRamp(p, i, hr, hg, hb, cr, cg, cb) {
  p.hr[i] = hr; p.hg[i] = hg; p.hb[i] = hb;
  p.cr[i] = cr; p.cg[i] = cg; p.cb[i] = cb;
  p.r[i] = hr; p.g[i] = hg; p.b[i] = hb;
}

/** Cheap deterministic flicker that does not advance any RNG stream. */
function hashFlicker(i, step) {
  let h = Math.imul(i | 0, 0x27D4EB2D) ^ Math.imul(step | 0, 0x165667B1);
  h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  h ^= h >>> 13;
  return (h >>> 0) * 2.3283064365386963e-10;
}

function solidAt(world, x, y, z) {
  return world.isSolidClamped(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL));
}
