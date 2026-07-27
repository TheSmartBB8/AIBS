// rng.js — deterministic randomness for the FX layer.
//
// Fire and particles must replay identically from a seed: multiplayer and the
// screenshot harness both compare states that were produced on different machines at
// different frame rates. Math.random() is therefore banned everywhere under fx/ — every
// stochastic decision draws from one of these streams, and every stream advances only
// inside a fixed simulation step.
//
// mulberry32: 32-bit state, passes the small-crush smoke tests, and uses only imul/xor/
// shift so it is bit-identical on every JS engine.

const INV32 = 2.3283064365386963e-10;   // 1 / 2^32
const TAU = Math.PI * 2;

export class Rng {
  constructor(seed = 1) {
    this.s = (seed >>> 0) || 0x9E3779B9;
  }

  /** Uniform in [0,1). */
  next() {
    this.s = (this.s + 0x6D2B79F5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) * INV32;
  }

  /** Uniform in [a,b). */
  range(a, b) { return a + (b - a) * this.next(); }

  /** Uniform integer in [0,n). */
  int(n) { return (this.next() * n) | 0; }

  /** Symmetric jitter in [-a,a). */
  sym(a) { return (this.next() * 2 - 1) * a; }

  /** True with probability p. */
  chance(p) { return this.next() < p; }

  /**
   * Uniform point on the unit sphere, written into out[0..2].
   * Uses trig, which is deterministic within an engine but not guaranteed bit-identical
   * across engines — the only place under fx/ that touches a transcendental.
   */
  unitVec(out) {
    const z = this.next() * 2 - 1;
    const a = this.next() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out[0] = r * Math.cos(a); out[1] = z; out[2] = r * Math.sin(a);
    return out;
  }

  /**
   * Direction in a cone around (dx,dy,dz), spread = 0 (exact) .. 1 (full hemisphere).
   * Used by impact sprays so debris follows the surface normal instead of scattering.
   */
  coneVec(dx, dy, dz, spread, out) {
    this.unitVec(out);
    out[0] = dx + out[0] * spread;
    out[1] = dy + out[1] * spread;
    out[2] = dz + out[2] * spread;
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }

  /** Snapshot / restore, so a whole sim can be checkpointed for replay. */
  save() { return this.s; }
  load(s) { this.s = s >>> 0; }
  /** Independent child stream — lets subsystems be seeded once without sharing a cursor. */
  fork(salt) { return new Rng((this.s ^ Math.imul(salt | 0, 0x9E3779B9)) >>> 0); }
}

/** Stateless hash in [0,1) — for per-particle flicker that must not advance any stream. */
export function hash01(a, b, c = 0) {
  let h = Math.imul(a | 0, 0x8DA6B343) ^ Math.imul(b | 0, 0xD8163841) ^ Math.imul(c | 0, 0xCB1AB31F);
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
  h ^= h >>> 16;
  return (h >>> 0) * INV32;
}
