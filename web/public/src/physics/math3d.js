// math3d.js — minimal, dependency-free 3D math for the physics module.
//
// Deliberately *not* built on three.js: the rigid-body sim has to produce bit-identical
// results in a headless node test and in the browser, and three's math objects drag in
// renderer-side state we don't want in a test harness. Every operation here is built from
// +, -, *, / and sqrt, all of which IEEE-754 specifies exactly, so a replayed simulation
// reproduces to the last bit. No Math.sin/cos/pow in any hot path for the same reason.
//
// Conventions:
//   vec3        plain [x, y, z] arrays
//   quat        [x, y, z, w], unit length, rotates body space -> world space
//   mat3        row-major [m00 m01 m02  m10 m11 m12  m20 m21 m22]

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const vclone = (a) => [a[0], a[1], a[2]];
export const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vmul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen2 = (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const vlen = (a) => Math.sqrt(vlen2(a));
export function vnorm(a) {
  const l = vlen(a);
  return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const vaddScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

// ------------------------------------------------------------------ quaternions
export const qIdentity = () => [0, 0, 0, 1];

export function qMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qNormalize(q) {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  if (l < 1e-20) return [0, 0, 0, 1];
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export const qConjugate = (q) => [-q[0], -q[1], -q[2], q[3]];
export const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

/** Rotate v by q. v' = v + 2 * qv x (qv x v + qw v) — no trig, exact. */
export function qRotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/**
 * Advance an orientation by angular velocity w (world frame) over h seconds.
 * First-order exponential map + renormalise. With h = 1/120 the truncation error is far
 * below the visual threshold and, crucially, it uses no transcendental functions.
 */
export function qIntegrate(q, w, h) {
  const wq = [w[0], w[1], w[2], 0];
  const d = qMul(wq, q);
  const s = 0.5 * h;
  return qNormalize([q[0] + d[0] * s, q[1] + d[1] * s, q[2] + d[2] * s, q[3] + d[3] * s]);
}

// ------------------------------------------------------------------ 3x3 matrices
export const m3Identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function m3FromQuat(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}

export function m3MulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function m3Mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export const m3Transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export function m3Inverse(m) {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-30) return m3Identity();
  const inv = 1 / det;
  return [
    A * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    C * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

/** Convert a rotation matrix to a unit quaternion (Shepperd's branch-stable method). */
export function m3ToQuat(m) {
  const t = m[0] + m[4] + m[8];
  let q;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, 0.25 * s];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s];
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s];
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s];
  }
  return qNormalize(q);
}

/**
 * The 24 rotations of a cube, as integer matrices. Used when a settled body re-welds:
 * voxels can only merge back into the grid on an axis-aligned lattice, so the body's
 * free orientation is snapped to whichever of these 24 it is closest to.
 *
 * Built as signed permutation matrices with determinant +1 (48 signed permutations, half
 * of which are reflections). Generation order is fixed, so the snap is deterministic.
 */
export const CUBE_ROTATIONS = (() => {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const out = [];
  for (const p of perms) {
    for (let bits = 0; bits < 8; bits++) {
      const s = [bits & 1 ? -1 : 1, bits & 2 ? -1 : 1, bits & 4 ? -1 : 1];
      // row r of the matrix is s[r] * e_{p[r]}
      const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let r = 0; r < 3; r++) m[r * 3 + p[r]] = s[r];
      // determinant of a signed permutation = sign(perm) * prod(signs)
      const sgnPerm = permSign(p);
      const det = sgnPerm * s[0] * s[1] * s[2];
      if (det === 1) out.push({ m, perm: p.slice(), sign: s.slice(), q: m3ToQuat(m) });
    }
  }
  return out;
})();

function permSign(p) {
  let sign = 1;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 3; j++)
      if (p[i] > p[j]) sign = -sign;
  return sign;
}

/** Nearest axis-aligned (90 degree) rotation to q, as one of CUBE_ROTATIONS. */
export function snapToCubeRotation(q) {
  let best = CUBE_ROTATIONS[0], bestDot = -1;
  for (let i = 0; i < CUBE_ROTATIONS.length; i++) {
    const d = Math.abs(qDot(q, CUBE_ROTATIONS[i].q));
    if (d > bestDot) { bestDot = d; best = CUBE_ROTATIONS[i]; }
  }
  return best;
}

/**
 * Deterministic 32-bit xorshift. Used for debris scatter so "random-looking" spray is
 * still perfectly reproducible — same call sequence, same rubble.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) { this.s = (seed >>> 0) || 1; }
  next() {
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }
  /** uniform in [-1, 1] */
  sym() { return this.next() * 2 - 1; }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
