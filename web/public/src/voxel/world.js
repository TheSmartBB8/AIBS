// world.js — the voxel world.
//
// Storage is one dense Uint8Array of palette indices. Dense (rather than sparse chunks)
// because the renderer raymarches the world as a 3D texture anyway, so a sparse structure
// would just have to be flattened every frame. Meshing still happens per 32^3 chunk so a
// local edit only re-meshes its neighbourhood.
//
// Alongside the full-resolution grid we keep a max-downsampled occupancy pyramid
// (1x, 4x, 16x). A ray can skip a whole empty 16^3 block in one step and only walks
// voxel-by-voxel right next to real geometry — the "mipmaps forming a dense octree"
// acceleration structure Teardown's renderer uses.

export const VOXEL = 0.1;           // metres per voxel (Teardown scale)
export const CHUNK = 32;            // meshing granularity

export class VoxelWorld {
  constructor(sx = 256, sy = 160, sz = 256) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.data = new Uint8Array(sx * sy * sz);

    // occupancy pyramid (max-downsample): level 1 = /4, level 2 = /16
    this.m1x = Math.ceil(sx / 4);  this.m1y = Math.ceil(sy / 4);  this.m1z = Math.ceil(sz / 4);
    this.m2x = Math.ceil(sx / 16); this.m2y = Math.ceil(sy / 16); this.m2z = Math.ceil(sz / 16);
    this.mip1 = new Uint8Array(this.m1x * this.m1y * this.m1z);
    this.mip2 = new Uint8Array(this.m2x * this.m2y * this.m2z);

    this.cx = Math.ceil(sx / CHUNK); this.cy = Math.ceil(sy / CHUNK); this.cz = Math.ceil(sz / CHUNK);
    this.chunkDirty = new Uint8Array(this.cx * this.cy * this.cz).fill(1);

    // regions of the GPU volume texture needing re-upload
    this.texDirty = [];
    this.dirtyAll = true;
  }

  get sizeVec() { return [this.sx, this.sy, this.sz]; }
  idx(x, y, z) { return (y * this.sz + z) * this.sx + x; }
  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  get(x, y, z) {
    if (!this.inBounds(x, y, z)) return 0;
    return this.data[this.idx(x, y, z)];
  }
  isSolid(x, y, z) { return this.get(x, y, z) !== 0; }

  /** Solid test used by physics: below the floor counts as solid so nothing falls out. */
  isSolidClamped(x, y, z) {
    if (y < 0) return true;
    if (y >= this.sy) return false;
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return false;
    return this.data[this.idx(x, y, z)] !== 0;
  }

  /** Raw write, no dirty tracking — for bulk level generation. */
  setRaw(x, y, z, v) {
    if (!this.inBounds(x, y, z)) return;
    this.data[this.idx(x, y, z)] = v;
  }

  /** Tracked write: marks the meshing chunk and the GPU volume region dirty. */
  set(x, y, z, v) {
    if (!this.inBounds(x, y, z)) return;
    const i = this.idx(x, y, z);
    if (this.data[i] === v) return;
    this.data[i] = v;
    this.markDirty(x, y, z);
  }

  markDirty(x, y, z) {
    // dirty this chunk and any neighbour whose mesh borders this voxel
    const cx0 = Math.max(0, ((x - 1) / CHUNK) | 0), cx1 = Math.min(this.cx - 1, ((x + 1) / CHUNK) | 0);
    const cy0 = Math.max(0, ((y - 1) / CHUNK) | 0), cy1 = Math.min(this.cy - 1, ((y + 1) / CHUNK) | 0);
    const cz0 = Math.max(0, ((z - 1) / CHUNK) | 0), cz1 = Math.min(this.cz - 1, ((z + 1) / CHUNK) | 0);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++)
          this.chunkDirty[(cy * this.cz + cz) * this.cx + cx] = 1;
    this.addTexDirty(x, y, z, x, y, z);
  }

  addTexDirty(x0, y0, z0, x1, y1, z1) {
    if (this.dirtyAll) return;
    this.texDirty.push({
      x0: Math.max(0, x0 - 1), y0: Math.max(0, y0 - 1), z0: Math.max(0, z0 - 1),
      x1: Math.min(this.sx - 1, x1 + 1), y1: Math.min(this.sy - 1, y1 + 1), z1: Math.min(this.sz - 1, z1 + 1),
    });
  }

  markAllDirty() {
    this.chunkDirty.fill(1);
    this.dirtyAll = true;
  }

  chunkIsDirty(cx, cy, cz) { return this.chunkDirty[(cy * this.cz + cz) * this.cx + cx] !== 0; }
  clearChunkDirty(cx, cy, cz) { this.chunkDirty[(cy * this.cz + cz) * this.cx + cx] = 0; }

  countSolid() {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== 0) n++;
    return n;
  }

  // ---------------------------------------------------------------- occupancy pyramid
  rebuildMips() {
    this.mip1.fill(0);
    this.mip2.fill(0);
    const { sx, sy, sz, m1x, m1y, m1z, m2x, m2y, m2z } = this;
    for (let y = 0; y < sy; y++) {
      const y1 = (y / 4) | 0, y2 = (y / 16) | 0;
      for (let z = 0; z < sz; z++) {
        const z1 = (z / 4) | 0, z2 = (z / 16) | 0;
        const row = (y * sz + z) * sx;
        for (let x = 0; x < sx; x++) {
          if (this.data[row + x] === 0) continue;
          this.mip1[(y1 * m1z + z1) * m1x + ((x / 4) | 0)] = 255;
          this.mip2[(y2 * m2z + z2) * m2x + ((x / 16) | 0)] = 255;
        }
      }
    }
    void m1y; void m2y;
  }

  /** Refresh only the pyramid cells covering a changed box (cheap incremental update). */
  updateMipsRegion(x0, y0, z0, x1, y1, z1) {
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    x0 = clamp(x0, 0, this.sx - 1); x1 = clamp(x1, 0, this.sx - 1);
    y0 = clamp(y0, 0, this.sy - 1); y1 = clamp(y1, 0, this.sy - 1);
    z0 = clamp(z0, 0, this.sz - 1); z1 = clamp(z1, 0, this.sz - 1);
    for (const [step, mip, mx, my, mz] of [
      [4, this.mip1, this.m1x, this.m1y, this.m1z],
      [16, this.mip2, this.m2x, this.m2y, this.m2z],
    ]) {
      const bx0 = (x0 / step) | 0, bx1 = (x1 / step) | 0;
      const by0 = (y0 / step) | 0, by1 = (y1 / step) | 0;
      const bz0 = (z0 / step) | 0, bz1 = (z1 / step) | 0;
      for (let by = by0; by <= by1 && by < my; by++)
        for (let bz = bz0; bz <= bz1 && bz < mz; bz++)
          for (let bx = bx0; bx <= bx1 && bx < mx; bx++) {
            let any = 0;
            const vx0 = bx * step, vy0 = by * step, vz0 = bz * step;
            outer:
            for (let y = vy0; y < Math.min(vy0 + step, this.sy); y++)
              for (let z = vz0; z < Math.min(vz0 + step, this.sz); z++) {
                const row = (y * this.sz + z) * this.sx;
                for (let x = vx0; x < Math.min(vx0 + step, this.sx); x++)
                  if (this.data[row + x] !== 0) { any = 255; break outer; }
              }
            mip[(by * mz + bz) * mx + bx] = any;
          }
    }
  }

  // ---------------------------------------------------------------- raycast (DDA)
  /**
   * Walk voxels along a ray. Origin in metres. Returns {hit, x,y,z, nx,ny,nz, dist, pos, pal}.
   * Axis t-values are forced to +inf when the direction component is ~0 — otherwise a ray
   * that starts exactly on a voxel boundary picks up a spurious step on that axis and
   * drifts diagonally instead of running straight.
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv; dy *= inv; dz *= inv;
    let x = Math.floor(ox / VOXEL), y = Math.floor(oy / VOXEL), z = Math.floor(oz / VOXEL);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const EPS = 1e-9;
    const tDX = Math.abs(dx) > EPS ? Math.abs(VOXEL / dx) : Infinity;
    const tDY = Math.abs(dy) > EPS ? Math.abs(VOXEL / dy) : Infinity;
    const tDZ = Math.abs(dz) > EPS ? Math.abs(VOXEL / dz) : Infinity;
    const bx = (dx > 0 ? (x + 1) * VOXEL - ox : ox - x * VOXEL);
    const by = (dy > 0 ? (y + 1) * VOXEL - oy : oy - y * VOXEL);
    const bz = (dz > 0 ? (z + 1) * VOXEL - oz : oz - z * VOXEL);
    let tMaxX = Math.abs(dx) > EPS ? bx / Math.abs(dx) : Infinity;
    let tMaxY = Math.abs(dy) > EPS ? by / Math.abs(dy) : Infinity;
    let tMaxZ = Math.abs(dz) > EPS ? bz / Math.abs(dz) : Infinity;
    let t = 0, nx = 0, ny = 0, nz = 0;

    for (let i = 0; i < 4096; i++) {
      if (this.inBounds(x, y, z)) {
        const p = this.data[this.idx(x, y, z)];
        if (p !== 0) {
          return { hit: true, x, y, z, nx, ny, nz, dist: t, pal: p,
                   pos: [ox + dx * t, oy + dy * t, oz + dz * t] };
        }
      } else if (t > 0 && (y < 0 || y >= this.sy || x < -8 || z < -8 ||
                           x > this.sx + 8 || z > this.sz + 8)) {
        break;
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) break;
    }
    return { hit: false, dist: maxDist };
  }
}
