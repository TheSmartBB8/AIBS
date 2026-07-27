// body.js — a chunk of voxels that has broken free and is now a rigid body.
//
// This is the part that decides whether destruction reads as "Teardown" or as "a Minecraft
// mod". A slab that slides off a wall and translates to the floor looks like a bug; a slab
// that pitches over its own edge, catches a corner, and slaps down flat looks like physics.
// So the body carries a full orientation quaternion, angular velocity, and a real inertia
// tensor built from the voxel set — not a sphere approximation, because the whole point is
// that a long thin plank tumbles differently from a cube.
//
// Storage: the voxels live in a dense little Uint8Array over the body's own local lattice.
// Dense beats a hash set here because bodies are small (tens to a few thousand voxels) and
// the collision loop wants O(1) neighbour tests to find surface cells.

import { VOXEL } from '../voxel/world.js';
import { voxelMass, matPhys } from './materials.js';
import {
  vadd, vsub, vmul, vdot, vcross, vlen, vlen2, qIdentity, qIntegrate,
  m3FromQuat, m3Mul, m3MulVec, m3Transpose, m3Inverse, m3Identity, snapToCubeRotation,
} from './math3d.js';

let NEXT_BODY_ID = 1;
/** Tests reset this so body ids don't leak between scenarios. */
export function resetBodyIds() { NEXT_BODY_ID = 1; }

export class VoxelBody {
  /**
   * @param lattice {dim:[w,h,d], data:Uint8Array}  palette indices, 0 = empty
   * @param palette Palette
   * @param opts    {originVoxel, pos, q, v, w}
   *                originVoxel: world voxel coords of local cell (0,0,0); used to derive
   *                the initial world position when `pos` is not given explicitly.
   */
  constructor(lattice, palette, opts = {}) {
    this.id = NEXT_BODY_ID++;
    this.dim = lattice.dim.slice();
    this.data = lattice.data;
    this.palette = palette;

    this.q = opts.q ? opts.q.slice() : qIdentity();
    this.v = opts.v ? opts.v.slice() : [0, 0, 0];
    this.w = opts.w ? opts.w.slice() : [0, 0, 0];

    this.cells = null;      // Int32Array of occupied local indices
    this.surface = null;    // Int32Array of local indices with an exposed face
    this.mass = 0;
    this.invMass = 0;
    this.com = [0, 0, 0];   // centre of mass in local metric space
    this.Ibody = m3Identity();
    this.IinvBody = m3Identity();
    this.friction = 0.6;
    this.restitution = 0.15;

    this.computeMassProperties();

    const origin = opts.originVoxel || [0, 0, 0];
    this.pos = opts.pos ? opts.pos.slice() : [
      origin[0] * VOXEL + this.com[0],
      origin[1] * VOXEL + this.com[1],
      origin[2] * VOXEL + this.com[2],
    ];

    this.R = m3FromQuat(this.q);
    this.IinvWorld = m3Identity();
    this.updateDerived();

    this.sleepTimer = 0;
    this.settled = false;
    this.alive = true;
    this.age = 0;
    this.hadContact = false;
    // strongest impact seen this substep, used to decide whether the body shatters
    this.impact = null;
  }

  /** Build a body straight from world voxels: [[x,y,z,pal], ...] (integer voxel coords). */
  static fromVoxels(voxels, palette, opts = {}) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i];
      if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0];
      if (v[1] < y0) y0 = v[1]; if (v[1] > y1) y1 = v[1];
      if (v[2] < z0) z0 = v[2]; if (v[2] > z1) z1 = v[2];
    }
    const dim = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1];
    const data = new Uint8Array(dim[0] * dim[1] * dim[2]);
    for (let i = 0; i < voxels.length; i++) {
      const [x, y, z, pal] = voxels[i];
      data[((y - y0) * dim[2] + (z - z0)) * dim[0] + (x - x0)] = pal;
    }
    return new VoxelBody({ dim, data }, palette, { ...opts, originVoxel: [x0, y0, z0] });
  }

  // ------------------------------------------------------------------ lattice helpers
  li(lx, ly, lz) { return (ly * this.dim[2] + lz) * this.dim[0] + lx; }
  lx(i) { return i % this.dim[0]; }
  ly(i) { return (((i / this.dim[0]) | 0) / this.dim[2]) | 0; }
  lz(i) { return ((i / this.dim[0]) | 0) % this.dim[2]; }

  /** Centre of local cell i in local metric coords. */
  cellCentre(i) {
    return [
      (this.lx(i) + 0.5) * VOXEL,
      (this.ly(i) + 0.5) * VOXEL,
      (this.lz(i) + 0.5) * VOXEL,
    ];
  }

  /** World-space centre of local cell i. */
  cellWorld(i) {
    const c = this.cellCentre(i);
    const r = m3MulVec(this.R, [c[0] - this.com[0], c[1] - this.com[1], c[2] - this.com[2]]);
    return [this.pos[0] + r[0], this.pos[1] + r[1], this.pos[2] + r[2]];
  }

  get voxelCount() { return this.cells.length; }

  // ------------------------------------------------------------------ mass properties
  /**
   * Mass, centre of mass, and the inertia tensor.
   *
   * I = sum_i [ m_i (|r|^2 * Id - r (x) r) ]  +  sum_i [ m_i * s^2/6 * Id ]
   *
   * The second term is each voxel's own inertia about its own centre (a cube of side s has
   * I = m s^2 / 6). Dropping it is the classic bug: a one-voxel body then has a zero
   * inertia tensor, the inverse blows up, and the fragment spins to infinity on the first
   * contact. It matters for any body only a voxel or two thick, which is most debris.
   */
  computeMassProperties() {
    const cells = [];
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== 0) cells.push(i);
    this.cells = Int32Array.from(cells);

    let m = 0, cx = 0, cy = 0, cz = 0;
    let fricSum = 0, restSum = 0;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      const pal = this.data[i];
      const mi = voxelMass(this.palette, pal, VOXEL);
      const c = this.cellCentre(i);
      m += mi; cx += mi * c[0]; cy += mi * c[1]; cz += mi * c[2];
      const mp = matPhys(this.palette, pal);
      fricSum += mp.friction; restSum += mp.restitution;
    }
    this.mass = m;
    this.invMass = m > 0 ? 1 / m : 0;
    this.com = m > 0 ? [cx / m, cy / m, cz / m] : [0, 0, 0];
    this.friction = cells.length ? fricSum / cells.length : 0.6;
    this.restitution = cells.length ? restSum / cells.length : 0.1;

    const selfI = (VOXEL * VOXEL) / 6;
    let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      const mi = voxelMass(this.palette, this.data[i], VOXEL);
      const c = this.cellCentre(i);
      const rx = c[0] - this.com[0], ry = c[1] - this.com[1], rz = c[2] - this.com[2];
      ixx += mi * (ry * ry + rz * rz + selfI);
      iyy += mi * (rx * rx + rz * rz + selfI);
      izz += mi * (rx * rx + ry * ry + selfI);
      ixy -= mi * rx * ry;
      ixz -= mi * rx * rz;
      iyz -= mi * ry * rz;
    }
    this.Ibody = [ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz];
    this.IinvBody = m > 0 ? m3Inverse(this.Ibody) : m3Identity();

    this.rebuildSurface();
  }

  /** Cells with at least one open 6-neighbour — the only ones that can ever touch anything. */
  rebuildSurface() {
    const [w, h, d] = this.dim;
    const surf = [];
    for (let k = 0; k < this.cells.length; k++) {
      const i = this.cells[k];
      const x = this.lx(i), y = this.ly(i), z = this.lz(i);
      if (x === 0 || y === 0 || z === 0 || x === w - 1 || y === h - 1 || z === d - 1 ||
          this.data[this.li(x - 1, y, z)] === 0 || this.data[this.li(x + 1, y, z)] === 0 ||
          this.data[this.li(x, y - 1, z)] === 0 || this.data[this.li(x, y + 1, z)] === 0 ||
          this.data[this.li(x, y, z - 1)] === 0 || this.data[this.li(x, y, z + 1)] === 0) {
        surf.push(i);
      }
    }
    this.surface = Int32Array.from(surf);
  }

  updateDerived() {
    this.R = m3FromQuat(this.q);
    this.IinvWorld = m3Mul(m3Mul(this.R, this.IinvBody), m3Transpose(this.R));
  }

  // ------------------------------------------------------------------ dynamics
  /** Velocity of the world-space point at offset r from the centre of mass. */
  pointVelocity(r) {
    const wr = vcross(this.w, r);
    return [this.v[0] + wr[0], this.v[1] + wr[1], this.v[2] + wr[2]];
  }

  /**
   * Apply an impulse J (N.s) at a world point. The r x J term is what makes off-centre hits
   * spin the body — an explosion that only ever pushed through the centre of mass would
   * produce debris that slides, which is exactly the thing that looks fake.
   */
  applyImpulse(worldPoint, J) {
    this.v[0] += J[0] * this.invMass;
    this.v[1] += J[1] * this.invMass;
    this.v[2] += J[2] * this.invMass;
    const r = vsub(worldPoint, this.pos);
    const dw = m3MulVec(this.IinvWorld, vcross(r, J));
    this.w[0] += dw[0]; this.w[1] += dw[1]; this.w[2] += dw[2];
    this.wake();
  }

  applyLinearImpulse(J) {
    this.v[0] += J[0] * this.invMass;
    this.v[1] += J[1] * this.invMass;
    this.v[2] += J[2] * this.invMass;
    this.wake();
  }

  /**
   * Blast loading: every voxel of the body gets a radial impulse whose magnitude falls off
   * with distance from the blast. Summing them gives the net force *and* the net torque for
   * free — the near face gets shoved harder than the far face, so the body spins. This is
   * the physically-honest version of "add some random spin", and it produces the right
   * correlation between where you shot and which way the chunk cartwheels.
   *
   * @param dv peak velocity change at the blast core, m/s
   */
  applyBlast(centre, radius, dv, falloff = 1.0) {
    if (this.mass <= 0) return;
    const r2 = radius * radius;
    let Jx = 0, Jy = 0, Jz = 0, Tx = 0, Ty = 0, Tz = 0;
    for (let k = 0; k < this.cells.length; k++) {
      const i = this.cells[k];
      const p = this.cellWorld(i);
      const dx = p[0] - centre[0], dy = p[1] - centre[1], dz = p[2] - centre[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2);
      const t = d / radius;
      const scale = falloff === 1 ? (1 - t) : Math.pow(1 - t, falloff);
      if (scale <= 0) continue;
      const mi = voxelMass(this.palette, this.data[i], VOXEL);
      // direction: away from the blast; degenerate at d == 0, push up instead
      let ux = 0, uy = 1, uz = 0;
      if (d > 1e-9) { ux = dx / d; uy = dy / d; uz = dz / d; }
      const j = mi * dv * scale;
      const jx = ux * j, jy = uy * j, jz = uz * j;
      Jx += jx; Jy += jy; Jz += jz;
      const rx = p[0] - this.pos[0], ry = p[1] - this.pos[1], rz = p[2] - this.pos[2];
      Tx += ry * jz - rz * jy;
      Ty += rz * jx - rx * jz;
      Tz += rx * jy - ry * jx;
    }
    this.v[0] += Jx * this.invMass;
    this.v[1] += Jy * this.invMass;
    this.v[2] += Jz * this.invMass;
    const dw = m3MulVec(this.IinvWorld, [Tx, Ty, Tz]);
    this.w[0] += dw[0]; this.w[1] += dw[1]; this.w[2] += dw[2];
    this.wake();
  }

  /** Semi-implicit (symplectic) Euler. Velocity first, then position — stable under gravity. */
  integrate(h, gravity, linDamp, angDamp) {
    this.v[0] += gravity[0] * h;
    this.v[1] += gravity[1] * h;
    this.v[2] += gravity[2] * h;
    const ld = 1 - linDamp * h, ad = 1 - angDamp * h;
    this.v[0] *= ld; this.v[1] *= ld; this.v[2] *= ld;
    this.w[0] *= ad; this.w[1] *= ad; this.w[2] *= ad;

    this.pos[0] += this.v[0] * h;
    this.pos[1] += this.v[1] * h;
    this.pos[2] += this.v[2] * h;
    this.q = qIntegrate(this.q, this.w, h);
    this.updateDerived();
    this.age += h;
  }

  wake() { this.sleepTimer = 0; }

  /** World-space AABB, from the rotated local box corners. */
  aabb() {
    const [w, h, d] = this.dim;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let c = 0; c < 8; c++) {
      const lx = (c & 1 ? w : 0) * VOXEL, ly = (c & 2 ? h : 0) * VOXEL, lz = (c & 4 ? d : 0) * VOXEL;
      const r = m3MulVec(this.R, [lx - this.com[0], ly - this.com[1], lz - this.com[2]]);
      const x = this.pos[0] + r[0], y = this.pos[1] + r[1], z = this.pos[2] + r[2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    return { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
  }

  /** Radius of the bounding sphere about the centre of mass (broadphase). */
  boundingRadius() {
    if (this._br !== undefined && this._brCells === this.cells.length) return this._br;
    let r2 = 0;
    const [w, h, d] = this.dim;
    for (let c = 0; c < 8; c++) {
      const lx = (c & 1 ? w : 0) * VOXEL, ly = (c & 2 ? h : 0) * VOXEL, lz = (c & 4 ? d : 0) * VOXEL;
      const dx = lx - this.com[0], dy = ly - this.com[1], dz = lz - this.com[2];
      const q = dx * dx + dy * dy + dz * dz;
      if (q > r2) r2 = q;
    }
    this._br = Math.sqrt(r2);
    this._brCells = this.cells.length;
    return this._br;
  }

  // ------------------------------------------------------------------ topology edits
  /**
   * Remove cells (e.g. shattered off on impact). The remaining material must not teleport:
   * the centre of mass moves in local space, so `pos` is shifted by R * (comNew - comOld)
   * and the linear velocity picks up the rotational term at the new COM. Get this wrong and
   * every shatter makes the body jump sideways.
   */
  removeCells(localIndices) {
    const removed = [];
    for (let k = 0; k < localIndices.length; k++) {
      const i = localIndices[k];
      if (this.data[i] === 0) continue;
      removed.push([i, this.data[i], this.cellWorld(i)]);
      this.data[i] = 0;
    }
    if (!removed.length) return removed;
    const comOld = this.com.slice();
    this.computeMassProperties();
    if (this.cells.length === 0) { this.alive = false; return removed; }
    const shift = m3MulVec(this.R, vsub(this.com, comOld));
    // velocity of the material that is now the COM, before we move the reference point
    const vNew = this.pointVelocity(shift);
    this.pos = vadd(this.pos, shift);
    this.v = vNew;
    this.updateDerived();
    this._br = undefined;
    return removed;
  }

  /**
   * Split into 6-connected components (a shatter can cut a body in two). Returns an array
   * of local-index arrays; a single entry means the body is still in one piece.
   */
  components() {
    const [w, h, d] = this.dim;
    const seen = new Uint8Array(this.data.length);
    const stack = new Int32Array(this.cells.length + 1);
    const out = [];
    for (let k = 0; k < this.cells.length; k++) {
      const start = this.cells[k];
      if (seen[start]) continue;
      let sp = 0; stack[sp++] = start; seen[start] = 1;
      const comp = [];
      while (sp > 0) {
        const i = stack[--sp];
        comp.push(i);
        const x = this.lx(i), y = this.ly(i), z = this.lz(i);
        for (let n = 0; n < 6; n++) {
          const nx = x + DX[n], ny = y + DY[n], nz = z + DZ[n];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= w || ny >= h || nz >= d) continue;
          const ni = this.li(nx, ny, nz);
          if (seen[ni] || this.data[ni] === 0) continue;
          seen[ni] = 1; stack[sp++] = ni;
        }
      }
      out.push(comp);
    }
    return out;
  }

  /**
   * Build a new body from a subset of this one's cells, preserving the world transform and
   * the motion of that material. Angular velocity is carried over unchanged, which is an
   * approximation (strictly the split should redistribute angular momentum), but it keeps
   * both halves spinning the way the eye expects after a break.
   */
  subset(localIndices) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < localIndices.length; k++) {
      const i = localIndices[k];
      const x = this.lx(i), y = this.ly(i), z = this.lz(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const dim = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1];
    const data = new Uint8Array(dim[0] * dim[1] * dim[2]);
    for (let k = 0; k < localIndices.length; k++) {
      const i = localIndices[k];
      const x = this.lx(i) - x0, y = this.ly(i) - y0, z = this.lz(i) - z0;
      data[(y * dim[2] + z) * dim[0] + x] = this.data[i];
    }
    // provisional body to get its own COM in *its* local frame
    const probe = new VoxelBody({ dim, data }, this.palette, { q: this.q, v: this.v, w: this.w });
    // that COM expressed in the parent's local frame
    const parentLocalCom = [
      probe.com[0] + x0 * VOXEL,
      probe.com[1] + y0 * VOXEL,
      probe.com[2] + z0 * VOXEL,
    ];
    const off = m3MulVec(this.R, vsub(parentLocalCom, this.com));
    probe.pos = vadd(this.pos, off);
    probe.v = this.pointVelocity(off);
    probe.w = this.w.slice();
    probe.updateDerived();
    return probe;
  }

  /**
   * Snap the free orientation to the nearest of the 24 cube rotations and compute the
   * integer world-voxel placement of every cell. Voxels can only re-enter the grid on the
   * lattice, so a settled body has to commit to an axis-aligned pose.
   *
   * Returns { rot, place(localIndex) -> [wx, wy, wz], translation }.
   */
  snapPlacement(extraOffset = [0, 0, 0]) {
    const rot = snapToCubeRotation(this.q);
    const R = rot.m;
    // A = (pos - R*com)/VOXEL; world cell = perm(local cell) + round(A)
    const Rcom = m3MulVec(R, this.com);
    const A = [
      (this.pos[0] - Rcom[0]) / VOXEL,
      (this.pos[1] - Rcom[1]) / VOXEL,
      (this.pos[2] - Rcom[2]) / VOXEL,
    ];
    const T = [
      Math.round(A[0]) + extraOffset[0],
      Math.round(A[1]) + extraOffset[1],
      Math.round(A[2]) + extraOffset[2],
    ];
    // integer cell mapping for a signed permutation: a flipped axis maps cell n -> -n-1
    const perm = rot.perm, sign = rot.sign;
    const l = [0, 0, 0];
    const place = (i) => {
      l[0] = this.lx(i); l[1] = this.ly(i); l[2] = this.lz(i);
      const o = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const s = sign[a], b = l[perm[a]];
        o[a] = (s > 0 ? b : -b - 1) + T[a];
      }
      return o;
    };
    return { rot, place, translation: T };
  }
}

const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];

export { vadd, vsub, vmul, vdot, vcross, vlen, vlen2 };
