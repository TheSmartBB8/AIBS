// fire.js — voxel fire propagation, modelled on Teardown's.
//
// The rules Teardown actually plays by, and which this reproduces:
//
//  * Fire is a property of a *voxel*, not a volume. Only materials flagged flammable can
//    hold it — a concrete wall next to a blazing pallet never lights.
//  * It creeps. A plank does not go up all at once; the flame front walks along it at
//    something like a tenth of a metre per second, and it walks *up* far faster than it
//    walks sideways and hardly at all downward. That asymmetry is most of what makes a
//    burning structure read as fire rather than as an expanding sphere.
//  * There is a hard cap on simultaneous fires (Teardown exposes it as SetMaxFires,
//    default 100). Past the cap new ignitions are simply refused; as burning voxels are
//    consumed, slots free up and the fire "walks" through the structure. This is both
//    the authentic behaviour and what keeps the cost flat.
//  * A burning voxel is eventually consumed and disappears.
//
// This class never writes to the world. When a voxel is used up it calls onBurnAway and
// the destruction system performs the edit through its normal path, so meshing, the
// occupancy pyramid, debris and physics all see it as an ordinary removal.
//
// Coordinates: ignite/isBurning/charAt take integer *voxel* coordinates. The volume
// queries (igniteSphere, extinguishSphere, extinguishCone) take *metres*, because they
// come from tools and explosions which live in world space.

import { VOXEL } from '../voxel/world.js';
import { MAT } from '../voxel/palette.js';
import { Rng } from './rng.js';
import { FixedStepper } from './clock.js';

// Per-material fire behaviour. Only these three materials appear here; everything else
// is non-flammable and can never be ignited.
//   burnTime : seconds of fuel at full intensity before the voxel is consumed
//   spread   : spread *attempts* per second at full intensity
//   ignite   : probability a single attempt actually lights the chosen neighbour
//   smoke    : smoke output multiplier, consumed by the FX layer
//   ramp     : seconds to reach full intensity after catching
const BURN = [];
BURN[MAT.FOLIAGE] = { burnTime: 2.2, spread: 26.0, ignite: 0.80, smoke: 0.55, ramp: 0.25 };
BURN[MAT.PLASTIC] = { burnTime: 6.5, spread: 8.0,  ignite: 0.40, smoke: 2.20, ramp: 0.90 };
BURN[MAT.WOOD]    = { burnTime: 5.0, spread: 12.0, ignite: 0.62, smoke: 1.00, ramp: 0.55 };

// Spread directions and their relative weights. Hot gas goes up, so the voxel above a
// flame is preheated and lights readily; the voxels beside it get a fraction of that;
// the voxel below only lights from dripping/falling embers, which is rare.
const DIR_X = new Int8Array([0, 1, -1, 0, 0, 0]);
const DIR_Y = new Int8Array([1, 0, 0, 0, 0, -1]);
const DIR_Z = new Int8Array([0, 0, 0, 1, -1, 0]);
const DIR_W = new Float32Array([1.0, 0.35, 0.35, 0.35, 0.35, 0.05]);
// Radiant heat crossing a one-voxel air gap (plank to plank across a joint) is much
// weaker than direct contact, but it is what lets fire cross a slatted fence.
const GAP_W = 0.30;

export class FireSim {
  constructor(world, palette, opts = {}) {
    this.world = world;
    this.palette = palette;

    this.fixedDt = opts.fixedDt ?? 1 / 60;
    this.seed = (opts.seed ?? 1337) >>> 0;
    this.rng = new Rng(this.seed ^ 0x5F356495);
    this.stepper = new FixedStepper(this.fixedDt, opts.maxStepsPerUpdate ?? 8);

    // Callbacks. onBurnAway is the only one the integrator must implement.
    this.onBurnAway = opts.onBurnAway || null;      // (x, y, z, pal)
    this.onIgnite = opts.onIgnite || null;          // (x, y, z, pal)
    this.onExtinguish = opts.onExtinguish || null;  // (x, y, z, pal, reason)

    // Fire only lives on surfaces — a voxel buried inside a solid beam has no oxygen and,
    // more practically, would waste one of the hundred fire slots somewhere invisible.
    this.surfaceOnly = opts.surfaceOnly !== false;
    this.spreadScale = opts.spreadScale ?? 1;       // global "how fast does it creep" dial
    this.burnScale = opts.burnScale ?? 1;           // global "how long does fuel last" dial
    this.waterQuery = opts.waterQuery || null;      // (x,y,z) -> bool, submerged?
    this.suppressionDecay = opts.suppressionDecay ?? 0.45;  // wetness lost per second

    this.time = 0;
    this.steps = 0;
    this.totalIgnitions = 0;
    this.totalBurnedAway = 0;
    this.refusedByCap = 0;

    this.count = 0;
    this._alloc(opts.maxFires ?? 100);

    this.index = new Map();   // world voxel index -> fire slot
    // Char is sparse: only voxels that have actually been touched by fire appear. The
    // renderer darkens by it (a burning shed blackens before it collapses) and the
    // destruction system can subtract it from material strength (fire weakens structure).
    this.char = new Map();    // world voxel index -> 0..1
    this._scratch3 = new Float32Array(3);
  }

  _alloc(maxFires) {
    const n = this.maxFires = Math.max(1, maxFires | 0);
    this.fx = new Int16Array(n);
    this.fy = new Int16Array(n);
    this.fz = new Int16Array(n);
    this.pal = new Uint8Array(n);
    this.fuel = new Float32Array(n);          // seconds of fuel left
    this.fuel0 = new Float32Array(n);         // seconds of fuel at ignition
    this.intensity = new Float32Array(n);     // 0..1 ramp, drives spread and emission
    this.rampRate = new Float32Array(n);
    this.spreadRate = new Float32Array(n);    // attempts/sec, jittered per fire
    this.spreadCharge = new Float32Array(n);
    this.wet = new Float32Array(n);           // suppression, >= 1 puts the fire out
    this.age = new Float32Array(n);
    // Emission accumulators, owned by the FX layer (see FxSystem._emitFromFires). They
    // live here so they follow a fire through the swap-remove that compacts these arrays.
    this.emitFlame = new Float32Array(n);
    this.emitSmoke = new Float32Array(n);
    this.emitEmber = new Float32Array(n);

    this._burnSlot = new Int32Array(n);       // deferred burn-away queue
    this._burnX = new Int32Array(n);
    this._burnY = new Int32Array(n);
    this._burnZ = new Int32Array(n);
    this._burnPal = new Uint8Array(n);
    // Spread candidates: six neighbours plus six one-gap jumps.
    this._cx = new Int32Array(12);
    this._cy = new Int32Array(12);
    this._cz = new Int32Array(12);
    this._cp = new Uint8Array(12);
    this._cw = new Float32Array(12);
    // Fire light clustering output.
    this._lightX = new Float32Array(32);
    this._lightY = new Float32Array(32);
    this._lightZ = new Float32Array(32);
    this._lightI = new Float32Array(32);
    this._lights = { count: 0, x: this._lightX, y: this._lightY, z: this._lightZ, i: this._lightI };
  }

  /** Change the concurrent-fire budget at runtime (a graphics setting, as in Teardown). */
  setMaxFires(n) {
    n = Math.max(1, n | 0);
    if (n === this.maxFires) return;
    const old = {
      count: Math.min(this.count, n),
      fx: this.fx, fy: this.fy, fz: this.fz, pal: this.pal, fuel: this.fuel, fuel0: this.fuel0,
      intensity: this.intensity, rampRate: this.rampRate, spreadRate: this.spreadRate,
      spreadCharge: this.spreadCharge, wet: this.wet, age: this.age,
      emitFlame: this.emitFlame, emitSmoke: this.emitSmoke, emitEmber: this.emitEmber,
    };
    this._alloc(n);
    for (const k of ['fx', 'fy', 'fz', 'pal', 'fuel', 'fuel0', 'intensity', 'rampRate',
                     'spreadRate', 'spreadCharge', 'wet', 'age', 'emitFlame', 'emitSmoke', 'emitEmber'])
      this[k].set(old[k].subarray(0, old.count));
    this.count = old.count;
    this.index.clear();
    for (let i = 0; i < this.count; i++)
      this.index.set(this.world.idx(this.fx[i], this.fy[i], this.fz[i]), i);
  }

  // ------------------------------------------------------------------ queries
  get free() { return this.maxFires - this.count; }

  isBurning(x, y, z) {
    if (!this.world.inBounds(x, y, z)) return false;
    return this.index.has(this.world.idx(x, y, z));
  }

  /** 0 when not burning, else the fire's 0..1 intensity ramp. */
  getIntensity(x, y, z) {
    if (!this.world.inBounds(x, y, z)) return 0;
    const s = this.index.get(this.world.idx(x, y, z));
    return s === undefined ? 0 : this.intensity[s];
  }

  /** 0..1 how far through its fuel a burning voxel is — the renderer's blacken factor. */
  getBurnProgress(x, y, z) {
    if (!this.world.inBounds(x, y, z)) return 0;
    const s = this.index.get(this.world.idx(x, y, z));
    if (s === undefined) return 0;
    return 1 - Math.max(0, this.fuel[s]) / this.fuel0[s];
  }

  /** 0..1 scorch on any voxel fire has touched, burning or not. Survives extinguishing. */
  charAt(x, y, z) {
    if (!this.world.inBounds(x, y, z)) return 0;
    return this.char.get(this.world.idx(x, y, z)) || 0;
  }

  /** Char weakens what it has cooked — multiply material strength by this. */
  strengthFactor(x, y, z) { return 1 - 0.55 * this.charAt(x, y, z); }

  forEachFire(cb) {
    for (let i = 0; i < this.count; i++)
      cb(this.fx[i], this.fy[i], this.fz[i], this.intensity[i], this.pal[i], i);
  }

  canIgnite(x, y, z) {
    const p = this.world.get(x, y, z);
    if (p === 0 || !this.palette.isFlammable(p)) return false;
    if (!this.world.inBounds(x, y, z)) return false;
    if (this.surfaceOnly && !this.isExposed(x, y, z)) return false;
    return !this.index.has(this.world.idx(x, y, z));
  }

  /** Has at least one air neighbour, i.e. oxygen can reach it. */
  isExposed(x, y, z) {
    const w = this.world;
    return w.get(x + 1, y, z) === 0 || w.get(x - 1, y, z) === 0 ||
           w.get(x, y + 1, z) === 0 || w.get(x, y - 1, z) === 0 ||
           w.get(x, y, z + 1) === 0 || w.get(x, y, z - 1) === 0;
  }

  // ------------------------------------------------------------------ ignition
  /**
   * Light a single voxel. Returns false if it is air, non-flammable, already alight,
   * buried (unless opts.force), or if the concurrent-fire cap is full.
   */
  ignite(x, y, z, opts) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return false;
    const p = w.get(x, y, z);
    if (p === 0 || !this.palette.isFlammable(p)) return false;
    const force = opts ? !!opts.force : false;
    if (this.surfaceOnly && !force && !this.isExposed(x, y, z)) return false;
    const key = w.idx(x, y, z);
    if (this.index.has(key)) return false;
    if (this.count >= this.maxFires) { this.refusedByCap++; return false; }

    const b = BURN[this.palette.mat[p]];
    const i = this.count++;
    const rng = this.rng;
    this.fx[i] = x; this.fy[i] = y; this.fz[i] = z; this.pal[i] = p;
    // Jitter fuel and spread rate per voxel. Identical timers would make a wall of planks
    // light and die in perfect ranks; the jitter is what makes the front ragged.
    const fuel = b.burnTime * this.burnScale * rng.range(0.7, 1.35);
    this.fuel[i] = fuel; this.fuel0[i] = fuel;
    this.intensity[i] = 0;
    this.rampRate[i] = 1 / (b.ramp * rng.range(0.7, 1.4));
    this.spreadRate[i] = b.spread * this.spreadScale * rng.range(0.55, 1.5);
    this.spreadCharge[i] = rng.next();          // desynchronise the first attempt
    this.wet[i] = 0;
    this.age[i] = 0;
    this.emitFlame[i] = rng.next();
    this.emitSmoke[i] = rng.next();
    this.emitEmber[i] = rng.next();
    this.index.set(key, i);
    this.totalIgnitions++;

    this._charAdd(key, 0.05);
    // Licking flames scorch what they touch before it catches.
    this._scorchNeighbours(x, y, z, 0.06);
    if (this.onIgnite) this.onIgnite(x, y, z, p);
    return true;
  }

  /**
   * Light everything flammable inside a sphere — the explosion / molotov entry point.
   * @param pos    [x,y,z] in metres
   * @param radius metres
   * @param chance per-voxel probability (default 0.35: a scorched patch, not a fireball)
   */
  igniteSphere(pos, radius, chance = 0.35) {
    const cx = readVec(pos, 0) / VOXEL, cy = readVec(pos, 1) / VOXEL, cz = readVec(pos, 2) / VOXEL;
    const r = radius / VOXEL, r2 = r * r;
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    const z0 = Math.floor(cz - r), z1 = Math.ceil(cz + r);
    let lit = 0;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (this.count >= this.maxFires) return lit;
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          // Fall off with distance: the middle of a blast lights reliably, the rim rarely.
          const p = chance * (1 - Math.sqrt(d2) / r);
          if (!this.rng.chance(p)) continue;
          if (this.ignite(x, y, z)) lit++;
          else this._charAdd(this.world.idx(x, y, z), 0.15);
        }
    return lit;
  }

  // ------------------------------------------------------------------ extinguishing
  _extinguishSlot(i, reason) {
    const x = this.fx[i], y = this.fy[i], z = this.fz[i], p = this.pal[i];
    this.index.delete(this.world.idx(x, y, z));
    const last = --this.count;
    if (i !== last) {
      this.fx[i] = this.fx[last]; this.fy[i] = this.fy[last]; this.fz[i] = this.fz[last];
      this.pal[i] = this.pal[last]; this.fuel[i] = this.fuel[last]; this.fuel0[i] = this.fuel0[last];
      this.intensity[i] = this.intensity[last]; this.rampRate[i] = this.rampRate[last];
      this.spreadRate[i] = this.spreadRate[last]; this.spreadCharge[i] = this.spreadCharge[last];
      this.wet[i] = this.wet[last]; this.age[i] = this.age[last];
      this.emitFlame[i] = this.emitFlame[last]; this.emitSmoke[i] = this.emitSmoke[last];
      this.emitEmber[i] = this.emitEmber[last];
      this.index.set(this.world.idx(this.fx[i], this.fy[i], this.fz[i]), i);
    }
    if (reason !== 'burnaway' && this.onExtinguish) this.onExtinguish(x, y, z, p, reason);
    return true;
  }

  extinguishVoxel(x, y, z, reason = 'manual') {
    if (!this.world.inBounds(x, y, z)) return false;
    const s = this.index.get(this.world.idx(x, y, z));
    if (s === undefined) return false;
    return this._extinguishSlot(s, reason);
  }

  /**
   * The destruction system calls this when a voxel is removed for any reason. A fire
   * riding a voxel that no longer exists is put out — shooting out the burning plank is
   * a legitimate way to fight a fire. (step() also self-heals, so a missed call is not
   * fatal, just a frame late.)
   */
  notifyVoxelRemoved(x, y, z) { return this.extinguishVoxel(x, y, z, 'destroyed'); }

  /**
   * Douse a sphere — water splash, fire extinguisher blast, submersion.
   * @param power suppression applied; >= 1 puts a dry fire out instantly. Callers
   *              spraying continuously should pass rate*dt.
   */
  extinguishSphere(pos, radius, power = 1) {
    const cx = readVec(pos, 0), cy = readVec(pos, 1), cz = readVec(pos, 2);
    const r2 = radius * radius;
    let out = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const dx = (this.fx[i] + 0.5) * VOXEL - cx;
      const dy = (this.fy[i] + 0.5) * VOXEL - cy;
      const dz = (this.fz[i] + 0.5) * VOXEL - cz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (this._suppress(i, power, 'doused')) out++;
    }
    return out;
  }

  /**
   * Extinguisher cone. Only fires inside the cone are affected — one behind the player
   * keeps burning, which is the whole point of having to aim.
   * @param origin      [x,y,z] metres (nozzle)
   * @param dir         [x,y,z] direction, need not be normalised
   * @param range       metres
   * @param halfAngleDeg cone half-angle
   * @param power       suppression applied at point blank; falls off with distance
   */
  extinguishCone(origin, dir, range = 4, halfAngleDeg = 22, power = 1) {
    const ox = readVec(origin, 0), oy = readVec(origin, 1), oz = readVec(origin, 2);
    let dx = readVec(dir, 0), dy = readVec(dir, 1), dz = readVec(dir, 2);
    const dl = Math.hypot(dx, dy, dz);
    if (dl < 1e-9) return 0;
    dx /= dl; dy /= dl; dz /= dl;
    const cosLimit = Math.cos(halfAngleDeg * Math.PI / 180);
    let out = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      const vx = (this.fx[i] + 0.5) * VOXEL - ox;
      const vy = (this.fy[i] + 0.5) * VOXEL - oy;
      const vz = (this.fz[i] + 0.5) * VOXEL - oz;
      const d = Math.hypot(vx, vy, vz);
      if (d > range) continue;
      if (d < 1e-6) { if (this._suppress(i, power, 'doused')) out++; continue; }
      if ((vx * dx + vy * dy + vz * dz) / d < cosLimit) continue;
      // Spray thins out downrange.
      const falloff = 1 - 0.55 * (d / range);
      if (this._suppress(i, power * falloff, 'doused')) out++;
    }
    return out;
  }

  _suppress(i, power, reason) {
    this.wet[i] += power;
    // Water also cools: an unsuppressed-but-soaked fire loses intensity, which slows
    // both its spread and its emission, so a partial hit visibly knocks it back.
    this.intensity[i] = Math.max(0, this.intensity[i] - power * 0.8);
    if (this.wet[i] >= 1) { this._extinguishSlot(i, reason); return true; }
    return false;
  }

  extinguishAll() { while (this.count > 0) this._extinguishSlot(this.count - 1, 'reset'); }

  /** Submersion test, e.g. (x,y,z) => y < waterLevelVoxels. */
  setWaterQuery(fn) { this.waterQuery = fn; }
  setWaterLevel(metres) {
    const yv = metres / VOXEL;
    this.waterQuery = (x, y) => y + 0.5 < yv;
  }

  // ------------------------------------------------------------------ simulation
  /** Variable-dt entry point: accumulates and runs whole fixed steps. */
  update(dt) {
    const n = this.stepper.advance(dt);
    for (let i = 0; i < n; i++) this.step(this.fixedDt);
    return n;
  }

  /** One fixed step. Call this directly if an outer system owns the accumulator. */
  step(dt) {
    const w = this.world;
    this.time += dt;
    this.steps++;
    let burns = 0;

    for (let i = 0; i < this.count; i++) {
      const x = this.fx[i], y = this.fy[i], z = this.fz[i];
      const key = w.idx(x, y, z);

      // Self-heal: the voxel may have been shot away, or replaced by something that
      // does not burn, since the last step.
      const p = w.get(x, y, z);
      if (p === 0 || !this.palette.isFlammable(p)) { this._extinguishSlot(i, 'destroyed'); i--; continue; }
      this.pal[i] = p;

      if (this.waterQuery && this.waterQuery(x, y, z)) { this._extinguishSlot(i, 'doused'); i--; continue; }

      // Wetness dries off, so a glancing spray only delays a strong fire.
      if (this.wet[i] > 0) this.wet[i] = Math.max(0, this.wet[i] - this.suppressionDecay * dt);

      this.age[i] += dt;
      const inten = this.intensity[i] = Math.min(1, this.intensity[i] + this.rampRate[i] * dt);

      // Fuel burns, and the voxel blackens as it goes.
      this.fuel[i] -= dt * inten;
      this._charSet(key, Math.min(1, 0.05 + (1 - this.fuel[i] / this.fuel0[i]) * 0.95));

      // Spread. Charge accrues with intensity so a fire that has just caught spreads
      // slowly and a well-established one spreads fast.
      this.spreadCharge[i] += dt * this.spreadRate[i] * inten;
      let attempts = 0;
      while (this.spreadCharge[i] >= 1 && attempts < 3) {
        this.spreadCharge[i] -= 1;
        attempts++;
        this._trySpread(i);
      }

      if (this.fuel[i] <= 0) {
        this._burnSlot[burns] = i; this._burnX[burns] = x; this._burnY[burns] = y;
        this._burnZ[burns] = z; this._burnPal[burns] = p; burns++;
      }
    }

    // Burn-aways are deferred: onBurnAway routes into the destruction system, which may
    // ignite or remove other voxels, and that must not reshuffle the array we are walking.
    if (burns > 0) {
      // Descending, so each swap-remove only ever moves a slot we have already handled.
      for (let k = burns - 1; k >= 0; k--) this._extinguishSlot(this._burnSlot[k], 'burnaway');
      for (let k = 0; k < burns; k++) {
        this.totalBurnedAway++;
        this._charSet(w.idx(this._burnX[k], this._burnY[k], this._burnZ[k]), 1);
        this._scorchNeighbours(this._burnX[k], this._burnY[k], this._burnZ[k], 0.28);
        if (this.onBurnAway) this.onBurnAway(this._burnX[k], this._burnY[k], this._burnZ[k], this._burnPal[k]);
      }
    }
  }

  /**
   * One spread attempt from fire `i`. Gathers legal neighbours, picks one weighted by
   * direction, and rolls against the target material's ignitability. Failing the roll is
   * not wasted work — it is what keeps the front ragged rather than a clean shell.
   */
  _trySpread(i) {
    const w = this.world, pal = this.palette;
    const x = this.fx[i], y = this.fy[i], z = this.fz[i];
    const cx = this._cx, cy = this._cy, cz = this._cz, cp = this._cp, cw = this._cw;
    let n = 0, total = 0;

    for (let d = 0; d < 6; d++) {
      const dx = DIR_X[d], dy = DIR_Y[d], dz = DIR_Z[d];
      let tx = x + dx, ty = y + dy, tz = z + dz;
      let weight = DIR_W[d];
      let p = w.get(tx, ty, tz);
      if (p === 0) {
        // Empty neighbour: radiant heat can reach across exactly one voxel of air.
        tx += dx; ty += dy; tz += dz;
        p = w.get(tx, ty, tz);
        weight *= GAP_W;
      }
      // A solid non-flammable voxel is a firebreak: it neither burns nor lets heat past.
      if (p === 0 || !pal.isFlammable(p)) continue;
      if (!w.inBounds(tx, ty, tz)) continue;
      if (this.index.has(w.idx(tx, ty, tz))) continue;           // already alight
      if (this.surfaceOnly && !this.isExposed(tx, ty, tz)) continue;
      cx[n] = tx; cy[n] = ty; cz[n] = tz; cp[n] = p; cw[n] = weight;
      total += weight; n++;
    }
    if (n === 0) return false;

    let r = this.rng.next() * total, pick = n - 1;
    for (let k = 0; k < n; k++) { r -= cw[k]; if (r <= 0) { pick = k; break; } }

    const b = BURN[pal.mat[cp[pick]]];
    // Heat marks the target even when it fails to catch — scorch spreads ahead of flame.
    this._charAdd(w.idx(cx[pick], cy[pick], cz[pick]), 0.04);
    if (!this.rng.chance(b.ignite)) return false;
    return this.ignite(cx[pick], cy[pick], cz[pick]);
  }

  // ------------------------------------------------------------------ char bookkeeping
  _charAdd(key, amount) {
    const v = this.char.get(key) || 0;
    this.char.set(key, v + amount > 1 ? 1 : v + amount);
  }
  _charSet(key, amount) {
    const v = this.char.get(key) || 0;
    if (amount > v) this.char.set(key, amount > 1 ? 1 : amount);
  }
  _scorchNeighbours(x, y, z, amount) {
    const w = this.world;
    for (let d = 0; d < 6; d++) {
      const tx = x + DIR_X[d], ty = y + DIR_Y[d], tz = z + DIR_Z[d];
      if (!w.inBounds(tx, ty, tz) || w.get(tx, ty, tz) === 0) continue;
      this._charAdd(w.idx(tx, ty, tz), amount);
    }
  }
  clearChar() { this.char.clear(); }

  // ------------------------------------------------------------------ lighting
  /**
   * Collapse the fire set into at most `maxLights` point lights so the renderer can light
   * the scene from the fire without one light per voxel. Fires within `cell` metres merge
   * into an intensity-weighted centroid; the brightest clusters win.
   * Returns a reused object — do not retain the arrays.
   */
  buildFireLights(maxLights = 8, cell = 1.2) {
    const cap = Math.min(maxLights, this._lightX.length);
    const lx = this._lightX, ly = this._lightY, lz = this._lightZ, li = this._lightI;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const inten = this.intensity[i];
      if (inten <= 0.01) continue;
      const x = (this.fx[i] + 0.5) * VOXEL, y = (this.fy[i] + 0.5) * VOXEL, z = (this.fz[i] + 0.5) * VOXEL;
      let merged = false;
      for (let k = 0; k < n; k++) {
        const dx = lx[k] / li[k] - x, dy = ly[k] / li[k] - y, dz = lz[k] / li[k] - z;
        if (dx * dx + dy * dy + dz * dz < cell * cell) {
          lx[k] += x * inten; ly[k] += y * inten; lz[k] += z * inten; li[k] += inten;
          merged = true; break;
        }
      }
      if (merged) continue;
      if (n < cap) { lx[n] = x * inten; ly[n] = y * inten; lz[n] = z * inten; li[n] = inten; n++; }
      else {
        // Full: displace the dimmest cluster if this one is brighter.
        let dim = 0;
        for (let k = 1; k < n; k++) if (li[k] < li[dim]) dim = k;
        if (li[dim] < inten) { lx[dim] = x * inten; ly[dim] = y * inten; lz[dim] = z * inten; li[dim] = inten; }
      }
    }
    for (let k = 0; k < n; k++) { lx[k] /= li[k]; ly[k] /= li[k]; lz[k] /= li[k]; }
    this._lights.count = n;
    return this._lights;
  }

  stats() {
    return {
      fires: this.count, maxFires: this.maxFires, free: this.free,
      ignitions: this.totalIgnitions, burnedAway: this.totalBurnedAway,
      refusedByCap: this.refusedByCap, charred: this.char.size, time: this.time,
    };
  }
}

/** Accept [x,y,z], {x,y,z} or a THREE.Vector3 without allocating. */
export function readVec(v, i) {
  if (v == null) return 0;
  if (typeof v === 'number') return i === 0 ? v : 0;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return v[i] || 0;
  return (i === 0 ? v.x : i === 1 ? v.y : v.z) || 0;
}

export { BURN as FIRE_MATERIALS };
