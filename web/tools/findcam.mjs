// findcam.mjs — search for a camera position that can actually see a given world point.
//
// seecam.mjs answers "can any of the named review views see this?", and the answer is
// usually no: those views exist to review the level, not to cover an arbitrary point. When
// the answer is no, the next step used to be guessing a position by hand, and that guessing
// is what produced seven unusable frames in a row — including one where the camera ended up
// *inside* a wooden fence, so the G-buffer put solid geometry a few centimetres in front of
// every particle and the occlusion test correctly discarded the entire fire.
//
// So: sample a hemisphere of candidate positions around the target, keep the ones with clear
// line of sight to the whole event volume AND clear air at the camera itself, and rank them.
//
// Usage: node tools/findcam.mjs <x> <y> <z> [radius_m] [minDist] [maxDist]
import { VoxelWorld } from '../public/src/voxel/world.js';
import { Palette } from '../public/src/voxel/palette.js';
import { buildLevel } from '../public/src/scene/level.js';

const T = [parseFloat(process.argv[2]), parseFloat(process.argv[3]), parseFloat(process.argv[4])];
const R = parseFloat(process.argv[5] || '1.2');
const DMIN = parseFloat(process.argv[6] || '3.0');
const DMAX = parseFloat(process.argv[7] || '9.0');
if (T.some(Number.isNaN)) {
  console.error('usage: node tools/findcam.mjs <x> <y> <z> [radius_m] [minDist] [maxDist]');
  process.exit(1);
}

const world = new VoxelWorld(256, 160, 256);
buildLevel(world, new Palette());

// Centre, the four horizontal extremes, and one above. Deliberately no probe below: fire
// burns on top of a surface, so a point R metres under the target is inside the ground and
// can never be seen from anywhere. Including it capped every candidate at 6/7 and made the
// search report that no camera in the level could see a fire sitting in open grass.
const probes = [[0, 0, 0], [R, 0, 0], [-R, 0, 0], [0, R, 0], [0, 0, R], [0, 0, -R]]
  .map((o) => [T[0] + o[0], T[1] + o[1], T[2] + o[2]]);

/** Fraction of the event volume reachable from `p`, or -1 if `p` is itself inside solid. */
function score(p) {
  const vx = Math.floor(p[0] / 0.1), vy = Math.floor(p[1] / 0.1), vz = Math.floor(p[2] / 0.1);
  if (!world.inBounds(vx, vy, vz) || world.get(vx, vy, vz) !== 0) return -1;
  let seen = 0;
  for (const q of probes) {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const dl = Math.hypot(...d);
    const h = world.raycast(p[0], p[1], p[2], d[0] / dl, d[1] / dl, d[2] / dl, dl - 0.35);
    if (!h.hit) seen++;
  }
  return seen / probes.length;
}

const cands = [];
let bestPartial = { p: [0,0,0], d: 0, az: 0, el: 0, s: -1 };
for (let az = 0; az < 360; az += 10)
  for (const el of [5, 12, 20, 30, 42])
    for (let d = DMIN; d <= DMAX; d += 0.75) {
      const a = az * Math.PI / 180, e = el * Math.PI / 180;
      const p = [T[0] + Math.cos(a) * Math.cos(e) * d,
                 T[1] + Math.sin(e) * d,
                 T[2] + Math.sin(a) * Math.cos(e) * d];
      const s = score(p);
      if (s < 1) { if (s > bestPartial.s) bestPartial = { p, d, az, el, s }; continue; }
      cands.push({ p, d, az, el, s });
    }

if (!cands.length) {
  console.log('no fully unoccluded camera position found in range.');
  console.log(`best partial: ${Math.round(bestPartial.s * 100)}% visible at ` +
              `[${bestPartial.p.map((v) => v.toFixed(2)).join(', ')}] (d=${bestPartial.d.toFixed(1)}, el=${bestPartial.el}°)`);
  console.log('(a negative score means every sampled position was inside solid geometry)');
  process.exit(2);
}
// Prefer a natural eye-level-ish shot: closer and lower reads better than far and overhead.
cands.sort((a, b) => (a.el - b.el) || (a.d - b.d));
console.log(`target ${T.join(', ')} r=${R}m — ${cands.length} clear positions\n`);
console.log('  dist   elev   azim   camera');
for (const c of cands.slice(0, 8))
  console.log(`  ${c.d.toFixed(1).padStart(4)}   ${String(c.el).padStart(4)}°  ${String(c.az).padStart(4)}°   [${c.p.map((v) => v.toFixed(2)).join(', ')}]`);
const best = cands[0];
console.log(`\nbest: --camera ${best.p.map((v) => v.toFixed(2)).join(' ')} --look ${T.join(' ')}`);
