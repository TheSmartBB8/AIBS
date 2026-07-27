// collision.js — dynamic body against the static voxel grid.
//
// There is no convex hull, no BVH and no mesh: the static world *is* a signed occupancy
// field on a lattice, so the cheapest correct query is "is this point inside a solid cell,
// and if so how do I get out". Each surface voxel of the body is treated as a sphere of
// radius VOXEL/2 and tested against the cells it overlaps with the standard
// sphere-vs-AABB closest-point test. That gives a contact point, a real normal (not an
// axis snapped guess) and a penetration depth, which is everything the impulse solver needs.
//
// Sphere rather than cube for the body voxel: a rotated cube against an axis-aligned cube is
// a full SAT problem per pair, and at 120 Hz with thousands of samples that is not worth it.
// The inscribed sphere under-reports contact at the body's own voxel corners by at most
// 0.041 m, which the positional-correction slop absorbs.

import { VOXEL } from '../voxel/world.js';

export const SAMPLE_RADIUS = VOXEL * 0.5;

/**
 * Deepest contact between a sphere at (px,py,pz) and the static voxel field.
 * Returns null, or {nx, ny, nz, pen} with the normal pointing *out of* the world (toward
 * the sphere), i.e. the direction the body must be pushed.
 */
export function sphereVsWorld(world, px, py, pz, R = SAMPLE_RADIUS) {
  const cx = Math.floor(px / VOXEL), cy = Math.floor(py / VOXEL), cz = Math.floor(pz / VOXEL);

  // Centre buried inside a solid cell: closest-point gives a zero-length normal, so escape
  // along whichever face has open air behind it and the least distance to travel.
  if (world.isSolidClamped(cx, cy, cz)) {
    let bestD = Infinity, bnx = 0, bny = 1, bnz = 0;
    const faces = [
      [1, 0, 0, (cx + 1) * VOXEL - px], [-1, 0, 0, px - cx * VOXEL],
      [0, 1, 0, (cy + 1) * VOXEL - py], [0, -1, 0, py - cy * VOXEL],
      [0, 0, 1, (cz + 1) * VOXEL - pz], [0, 0, -1, pz - cz * VOXEL],
    ];
    for (let k = 0; k < 6; k++) {
      const f = faces[k];
      if (world.isSolidClamped(cx + f[0], cy + f[1], cz + f[2])) continue;
      if (f[3] < bestD) { bestD = f[3]; bnx = f[0]; bny = f[1]; bnz = f[2]; }
    }
    if (bestD === Infinity) { bestD = (cy + 1) * VOXEL - py; bnx = 0; bny = 1; bnz = 0; }
    return { nx: bnx, ny: bny, nz: bnz, pen: R + bestD };
  }

  // Otherwise: closest point on each nearby solid cell's AABB.
  const x0 = Math.floor((px - R) / VOXEL), x1 = Math.floor((px + R) / VOXEL);
  const y0 = Math.floor((py - R) / VOXEL), y1 = Math.floor((py + R) / VOXEL);
  const z0 = Math.floor((pz - R) / VOXEL), z1 = Math.floor((pz + R) / VOXEL);
  let bestPen = 0, bnx = 0, bny = 0, bnz = 0, hit = false;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (!world.isSolidClamped(x, y, z)) continue;
        const ax0 = x * VOXEL, ay0 = y * VOXEL, az0 = z * VOXEL;
        const qx = px < ax0 ? ax0 : px > ax0 + VOXEL ? ax0 + VOXEL : px;
        const qy = py < ay0 ? ay0 : py > ay0 + VOXEL ? ay0 + VOXEL : py;
        const qz = pz < az0 ? az0 : pz > az0 + VOXEL ? az0 + VOXEL : pz;
        const dx = px - qx, dy = py - qy, dz = pz - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R * R || d2 <= 1e-18) continue;
        const d = Math.sqrt(d2);
        const pen = R - d;
        if (pen > bestPen) {
          bestPen = pen; hit = true;
          bnx = dx / d; bny = dy / d; bnz = dz / d;
        }
      }
    }
  }
  return hit ? { nx: bnx, ny: bny, nz: bnz, pen: bestPen } : null;
}

/**
 * All contacts between a body and the static world for this substep.
 *
 * Only surface cells are tested (an interior voxel can never be the first thing to touch),
 * and the list is strided down to `maxSamples` on very large bodies. Striding a shell is a
 * real approximation — a thin spike could slip between samples — but the stride only kicks
 * in above ~2000 shell voxels, by which point the body is big enough that missing one
 * sample changes nothing.
 *
 * Contact = { p:[x,y,z] world, n:[x,y,z], pen, li } (li = body local cell index)
 */
export function collectWorldContacts(world, body, opts = {}) {
  const maxSamples = opts.maxSamples === undefined ? 2048 : opts.maxSamples;
  const maxContacts = opts.maxContacts === undefined ? 96 : opts.maxContacts;
  const surf = body.surface;
  const n = surf.length;
  const stride = n > maxSamples ? Math.ceil(n / maxSamples) : 1;
  const contacts = [];

  for (let k = 0; k < n; k += stride) {
    const i = surf[k];
    const p = body.cellWorld(i);
    const c = sphereVsWorld(world, p[0], p[1], p[2]);
    if (!c) continue;
    contacts.push({ p, n: [c.nx, c.ny, c.nz], pen: c.pen, li: i });
  }

  if (contacts.length > maxContacts) {
    // keep the deepest; ties broken by cell index so the ordering is deterministic
    contacts.sort((a, b) => (b.pen - a.pen) || (a.li - b.li));
    contacts.length = maxContacts;
  }
  return contacts;
}

/**
 * Contacts between two dynamic bodies: sample the smaller body's shell, transform each
 * sample into the other body's local lattice, and test occupancy there. Cheap, symmetric
 * enough in practice, and it is what lets rubble stack instead of interpenetrating.
 */
export function collectBodyContacts(a, b, opts = {}) {
  const maxSamples = opts.maxSamples === undefined ? 512 : opts.maxSamples;
  const maxContacts = opts.maxContacts === undefined ? 32 : opts.maxContacts;
  // sample the body with fewer shell voxels against the other's volume
  const [s, t] = a.surface.length <= b.surface.length ? [a, b] : [b, a];
  const flip = s !== a;

  const surf = s.surface;
  const stride = surf.length > maxSamples ? Math.ceil(surf.length / maxSamples) : 1;
  const contacts = [];
  const Rt = t.R;
  const R = SAMPLE_RADIUS;

  for (let k = 0; k < surf.length; k += stride) {
    const i = surf[k];
    const p = s.cellWorld(i);
    // world -> t local metric: R^T (p - t.pos) + t.com
    const dx = p[0] - t.pos[0], dy = p[1] - t.pos[1], dz = p[2] - t.pos[2];
    const lx = Rt[0] * dx + Rt[3] * dy + Rt[6] * dz + t.com[0];
    const ly = Rt[1] * dx + Rt[4] * dy + Rt[7] * dz + t.com[1];
    const lz = Rt[2] * dx + Rt[5] * dy + Rt[8] * dz + t.com[2];
    const cx = Math.floor(lx / VOXEL), cy = Math.floor(ly / VOXEL), cz = Math.floor(lz / VOXEL);
    if (cx < -1 || cy < -1 || cz < -1 || cx > t.dim[0] || cy > t.dim[1] || cz > t.dim[2]) continue;

    let bestPen = 0, bnx = 0, bny = 0, bnz = 0, hit = false;
    for (let z = cz - 1; z <= cz + 1; z++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let x = cx - 1; x <= cx + 1; x++) {
          if (x < 0 || y < 0 || z < 0 || x >= t.dim[0] || y >= t.dim[1] || z >= t.dim[2]) continue;
          if (t.data[t.li(x, y, z)] === 0) continue;
          const ax0 = x * VOXEL, ay0 = y * VOXEL, az0 = z * VOXEL;
          const qx = lx < ax0 ? ax0 : lx > ax0 + VOXEL ? ax0 + VOXEL : lx;
          const qy = ly < ay0 ? ay0 : ly > ay0 + VOXEL ? ay0 + VOXEL : ly;
          const qz = lz < az0 ? az0 : lz > az0 + VOXEL ? az0 + VOXEL : lz;
          const ddx = lx - qx, ddy = ly - qy, ddz = lz - qz;
          const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 >= R * R) continue;
          if (d2 <= 1e-18) {
            // buried: push straight back the way it came
            const pen = R + VOXEL * 0.5;
            if (pen > bestPen) { bestPen = pen; hit = true; bnx = 0; bny = 1; bnz = 0; }
            continue;
          }
          const d = Math.sqrt(d2);
          const pen = R - d;
          if (pen > bestPen) { bestPen = pen; hit = true; bnx = ddx / d; bny = ddy / d; bnz = ddz / d; }
        }
    if (!hit) continue;
    // normal back to world space (rotate by t.R), pointing from t toward s
    const nwx = Rt[0] * bnx + Rt[1] * bny + Rt[2] * bnz;
    const nwy = Rt[3] * bnx + Rt[4] * bny + Rt[5] * bnz;
    const nwz = Rt[6] * bnx + Rt[7] * bny + Rt[8] * bnz;
    // caller expects the normal pointing toward `a`
    const sgn = flip ? -1 : 1;
    contacts.push({ p, n: [nwx * sgn, nwy * sgn, nwz * sgn], pen: bestPen });
  }

  if (contacts.length > maxContacts) {
    contacts.sort((x, y) => y.pen - x.pen);
    contacts.length = maxContacts;
  }
  return contacts;
}

export function aabbOverlap(a, b, pad = 0) {
  return a.min[0] - pad <= b.max[0] && a.max[0] + pad >= b.min[0] &&
         a.min[1] - pad <= b.max[1] && a.max[1] + pad >= b.min[1] &&
         a.min[2] - pad <= b.max[2] && a.max[2] + pad >= b.min[2];
}
