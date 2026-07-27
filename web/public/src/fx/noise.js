// noise.js — the turbulence field that makes smoke churn.
//
// Smoke that only obeys buoyancy + drag rises in straight lines and reads as grey blobs
// drifting upward. What sells real smoke is the rolling, folding motion of a turbulent
// plume. We get that from curl noise: build a vector potential P from three decorrelated
// scalar noise fields and take its curl. curl(P) is divergence-free by construction, so
// the resulting velocity field swirls without any source or sink — particles orbit and
// fold through each other instead of converging into clumps or blowing apart.
//
// Value noise (hashed lattice + smoothstep) rather than gradient noise: it needs no
// permutation table, is cheap enough to evaluate twelve times per curl, and uses only
// integer ops so it is bit-identical across engines.

const INV32 = 2.3283064365386963e-10;

function hash(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 0x8DA6B343) ^ Math.imul(iy | 0, 0xD8163841) ^
          Math.imul(iz | 0, 0xCB1AB31F) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 16), 0x7FEB352D);
  h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
  h ^= h >>> 16;
  return (h >>> 0) * INV32;
}

/** Trilinearly interpolated lattice noise in [0,1). */
export function valueNoise3(x, y, z, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = hash(ix, iy, iz, seed),         c100 = hash(ix + 1, iy, iz, seed);
  const c010 = hash(ix, iy + 1, iz, seed),     c110 = hash(ix + 1, iy + 1, iz, seed);
  const c001 = hash(ix, iy, iz + 1, seed),     c101 = hash(ix + 1, iy, iz + 1, seed);
  const c011 = hash(ix, iy + 1, iz + 1, seed), c111 = hash(ix + 1, iy + 1, iz + 1, seed);

  const x00 = c000 + (c100 - c000) * ux, x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux, x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy, y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

/** Same field remapped to [-1,1]. */
export function signedNoise3(x, y, z, seed = 0) {
  return valueNoise3(x, y, z, seed) * 2 - 1;
}

const EPS = 0.42;          // finite-difference step, in noise-space units
const INV_2EPS = 1 / (2 * EPS);
const S0 = 0x1B873593, S1 = 0x85EBCA6B, S2 = 0xC2B2AE35;

/**
 * curl of the vector potential (n0,n1,n2) sampled at (x,y,z), written to out[0..2].
 * Result is roughly unit-scaled. Twelve noise taps — call it at a reduced rate per
 * particle (see ParticleSystem.turbulenceRefresh), not every step for every particle.
 */
export function curlNoise3(x, y, z, out, seed = 0) {
  const s0 = seed ^ S0, s1 = seed ^ S1, s2 = seed ^ S2;

  // dP2/dy, dP1/dz  ->  curl.x
  const p2y1 = signedNoise3(x, y + EPS, z, s2), p2y0 = signedNoise3(x, y - EPS, z, s2);
  const p1z1 = signedNoise3(x, y, z + EPS, s1), p1z0 = signedNoise3(x, y, z - EPS, s1);
  // dP0/dz, dP2/dx  ->  curl.y
  const p0z1 = signedNoise3(x, y, z + EPS, s0), p0z0 = signedNoise3(x, y, z - EPS, s0);
  const p2x1 = signedNoise3(x + EPS, y, z, s2), p2x0 = signedNoise3(x - EPS, y, z, s2);
  // dP1/dx, dP0/dy  ->  curl.z
  const p1x1 = signedNoise3(x + EPS, y, z, s1), p1x0 = signedNoise3(x - EPS, y, z, s1);
  const p0y1 = signedNoise3(x, y + EPS, z, s0), p0y0 = signedNoise3(x, y - EPS, z, s0);

  out[0] = ((p2y1 - p2y0) - (p1z1 - p1z0)) * INV_2EPS;
  out[1] = ((p0z1 - p0z0) - (p2x1 - p2x0)) * INV_2EPS;
  out[2] = ((p1x1 - p1x0) - (p0y1 - p0y0)) * INV_2EPS;
  return out;
}
