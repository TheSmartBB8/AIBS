// mesher.js — greedy voxel meshing with baked per-vertex ambient occlusion.
//
// Two things matter here for the Teardown look:
//   1. Baked corner AO. The soft darkening where surfaces meet is a huge part of why
//      voxel scenes read as solid rather than as flat-shaded boxes. It's cheap (computed
//      once at mesh time) and survives even when the expensive raytraced passes are off.
//   2. Greedy merging. A flat wall becomes a handful of quads instead of thousands, which
//      is the difference between a scene that renders and one that doesn't.
//
// Quads only merge when palette index AND all four corner AO values match, so merging
// never smears AO across a boundary where it should change.

const AO_LUT = [0.0, 0.62, 0.82, 1.0]; // occlusion count 3,2,1,0 -> brightness

/**
 * Mesh one chunk. Returns interleaved typed arrays ready for a BufferGeometry, or null
 * if the chunk is empty.
 */
export function meshChunk(world, cx, cy, cz, chunkSize, voxelSize) {
  const positions = [];
  const normals = [];
  const aos = [];
  const pals = [];

  const bx = cx * chunkSize, by = cy * chunkSize, bz = cz * chunkSize;
  const dims = [
    Math.min(chunkSize, world.sx - bx),
    Math.min(chunkSize, world.sy - by),
    Math.min(chunkSize, world.sz - bz),
  ];
  if (dims[0] <= 0 || dims[1] <= 0 || dims[2] <= 0) return null;
  const base = [bx, by, bz];

  const solidAt = (x, y, z) => world.isSolid(x, y, z);

  // AO for one corner of a face: how many of {side1, side2, corner} are solid.
  // Classic voxel AO — if both sides are solid the corner is fully dark regardless.
  const cornerAO = (s1, s2, c) => (s1 && s2 ? 0 : 3 - (s1 + s2 + c));

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const x = [0, 0, 0];
    const q = [0, 0, 0];
    q[d] = 1;

    const maskPal = new Int32Array(dims[u] * dims[v]);
    const maskAO = new Float32Array(dims[u] * dims[v] * 4);
    const maskDir = new Int8Array(dims[u] * dims[v]);

    for (x[d] = -1; x[d] < dims[d];) {
      // build the slice mask
      let n = 0;
      for (x[v] = 0; x[v] < dims[v]; x[v]++) {
        for (x[u] = 0; x[u] < dims[u]; x[u]++, n++) {
          const ax = base[0] + x[0], ay = base[1] + x[1], az = base[2] + x[2];
          const bxx = ax + q[0], byy = ay + q[1], bzz = az + q[2];
          const solidA = x[d] >= 0 ? solidAt(ax, ay, az) : false;
          const solidB = x[d] < dims[d] - 1 ? solidAt(bxx, byy, bzz) : solidAt(bxx, byy, bzz);

          maskPal[n] = 0; maskDir[n] = 0;
          if (solidA === solidB) continue;   // no face between two solids or two airs

          // the visible face belongs to whichever side is solid, facing the air side
          const dir = solidA ? 1 : -1;
          const px = solidA ? ax : bxx, py = solidA ? ay : byy, pz = solidA ? az : bzz;
          const pal = world.get(px, py, pz);
          if (pal === 0) continue;
          maskPal[n] = pal;
          maskDir[n] = dir;

          // AO sampled on the air side of the face
          const ox = dir > 0 ? px + q[0] : px - q[0];
          const oy = dir > 0 ? py + q[1] : py - q[1];
          const oz = dir > 0 ? pz + q[2] : pz - q[2];
          const du = [0, 0, 0]; du[u] = 1;
          const dv = [0, 0, 0]; dv[v] = 1;
          for (let ci = 0; ci < 4; ci++) {
            // corner offsets in (u,v): (0,0) (1,0) (1,1) (0,1)
            const su = (ci === 1 || ci === 2) ? 1 : -1;
            const sv = (ci === 2 || ci === 3) ? 1 : -1;
            const s1 = solidAt(ox + du[0] * su, oy + du[1] * su, oz + du[2] * su);
            const s2 = solidAt(ox + dv[0] * sv, oy + dv[1] * sv, oz + dv[2] * sv);
            const cc = solidAt(ox + du[0] * su + dv[0] * sv,
                               oy + du[1] * su + dv[1] * sv,
                               oz + du[2] * su + dv[2] * sv);
            maskAO[n * 4 + ci] = AO_LUT[cornerAO(s1 ? 1 : 0, s2 ? 1 : 0, cc ? 1 : 0)];
          }
        }
      }

      x[d]++;

      // greedily merge the mask into rectangles
      n = 0;
      for (let j = 0; j < dims[v]; j++) {
        for (let i = 0; i < dims[u];) {
          const pal = maskPal[n];
          if (pal === 0) { i++; n++; continue; }

          const sameAt = (idx) =>
            maskPal[idx] === pal && maskDir[idx] === maskDir[n] &&
            maskAO[idx * 4 + 0] === maskAO[n * 4 + 0] &&
            maskAO[idx * 4 + 1] === maskAO[n * 4 + 1] &&
            maskAO[idx * 4 + 2] === maskAO[n * 4 + 2] &&
            maskAO[idx * 4 + 3] === maskAO[n * 4 + 3];

          let w = 1;
          while (i + w < dims[u] && sameAt(n + w)) w++;
          let h = 1;
          outer:
          for (; j + h < dims[v]; h++) {
            for (let k = 0; k < w; k++)
              if (!sameAt(n + k + h * dims[u])) break outer;
          }

          // emit the quad
          x[u] = i; x[v] = j;
          const du = [0, 0, 0]; du[u] = w;
          const dv = [0, 0, 0]; dv[v] = h;
          const dir = maskDir[n];
          const nrm = [q[0] * dir, q[1] * dir, q[2] * dir];

          const p0 = [(base[0] + x[0]) * voxelSize, (base[1] + x[1]) * voxelSize, (base[2] + x[2]) * voxelSize];
          const p1 = [p0[0] + du[0] * voxelSize, p0[1] + du[1] * voxelSize, p0[2] + du[2] * voxelSize];
          const p2 = [p0[0] + (du[0] + dv[0]) * voxelSize, p0[1] + (du[1] + dv[1]) * voxelSize, p0[2] + (du[2] + dv[2]) * voxelSize];
          const p3 = [p0[0] + dv[0] * voxelSize, p0[1] + dv[1] * voxelSize, p0[2] + dv[2] * voxelSize];

          const a0 = maskAO[n * 4 + 0], a1 = maskAO[n * 4 + 1], a2 = maskAO[n * 4 + 2], a3 = maskAO[n * 4 + 3];

          // Split along the shorter AO gradient so the interpolation doesn't produce the
          // classic diagonal seam artifact across the quad.
          const flip = (a0 + a2) < (a1 + a3);
          const tris = dir > 0
            ? (flip ? [[p1, p2, p3], [p1, p3, p0]] : [[p0, p1, p2], [p0, p2, p3]])
            : (flip ? [[p3, p2, p1], [p0, p3, p1]] : [[p2, p1, p0], [p3, p2, p0]]);
          const triAO = dir > 0
            ? (flip ? [[a1, a2, a3], [a1, a3, a0]] : [[a0, a1, a2], [a0, a2, a3]])
            : (flip ? [[a3, a2, a1], [a0, a3, a1]] : [[a2, a1, a0], [a3, a2, a0]]);

          for (let t = 0; t < 2; t++) {
            for (let c = 0; c < 3; c++) {
              positions.push(tris[t][c][0], tris[t][c][1], tris[t][c][2]);
              normals.push(nrm[0], nrm[1], nrm[2]);
              aos.push(triAO[t][c]);
              pals.push(pal);
            }
          }

          // clear the merged region
          for (let hh = 0; hh < h; hh++)
            for (let ww = 0; ww < w; ww++)
              maskPal[n + ww + hh * dims[u]] = 0;

          i += w; n += w;
        }
      }
    }
  }

  if (positions.length === 0) return null;
  return {
    position: new Float32Array(positions),
    normal: new Float32Array(normals),
    ao: new Float32Array(aos),
    pal: new Float32Array(pals),
    triangles: positions.length / 9,
  };
}
