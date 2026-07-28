// seecam.mjs — which review camera can actually see a given world point?
//
// This exists because I burned three ~15-minute software renders trying to photograph a
// demolition and got a useless frame every time: `street` looks down the road while the
// rocket hits the warehouse off to one side, `closeup` is a tight material-inspection view
// buried in a crate stack, and `interior` had the impact behind that same stack. Answering
// the question from the voxel grid takes about a second.
//
// The first version of this checked a single ray to a single point, and that is what let
// the third failure through: the point was visible, but the surrounding volume the event
// actually occupies was not, and the foreground filled the lower half of the frame. So it
// now samples a small sphere of points around the target and reports what fraction arrive,
// which is the thing that decides whether an explosion is photogenic from here.
//
// Usage: node tools/seecam.mjs <x> <y> <z> [radius_m]
//        node tools/seecam.mjs 12.2 2.4 8.0 1.5
import { VoxelWorld } from '../public/src/voxel/world.js';
import { Palette } from '../public/src/voxel/palette.js';
import { buildLevel } from '../public/src/scene/level.js';
import { VIEWS } from '../public/src/scene/views.js';

const T = [parseFloat(process.argv[2]), parseFloat(process.argv[3]), parseFloat(process.argv[4])];
const R = parseFloat(process.argv[5] || '1.5');
if (T.some(Number.isNaN)) {
  console.error('usage: node tools/seecam.mjs <x> <y> <z> [radius_m]');
  process.exit(1);
}

const world = new VoxelWorld(256, 160, 256);
buildLevel(world, new Palette());

// Points on and around the target: the centre plus the six axial extremes of a sphere of
// the given radius. An event is worth filming when most of its volume is reachable, not
// when one lucky ray squeezes through.
const probes = [[0, 0, 0], [R, 0, 0], [-R, 0, 0], [0, R, 0], [0, -R, 0], [0, 0, R], [0, 0, -R]]
  .map((o) => [T[0] + o[0], T[1] + o[1], T[2] + o[2]]);

console.log(`target ${T.join(', ')} r=${R}m\n`);
console.log('view         off-axis   dist_m   visible   verdict');
const rows = [];
for (const [name, v] of Object.entries(VIEWS)) {
  const f = [0, 1, 2].map((i) => v.look[i] - v.pos[i]);
  const fl = Math.hypot(...f);
  const F = f.map((c) => c / fl);

  let seen = 0, angSum = 0;
  for (const p of probes) {
    const d = [0, 1, 2].map((i) => p[i] - v.pos[i]);
    const dl = Math.hypot(...d);
    const D = d.map((c) => c / dl);
    angSum += Math.acos(Math.max(-1, Math.min(1, F[0] * D[0] + F[1] * D[1] + F[2] * D[2]))) * 180 / Math.PI;
    const h = world.raycast(v.pos[0], v.pos[1], v.pos[2], D[0], D[1], D[2], dl - 0.4);
    if (!h.hit) seen++;
  }
  const ang = angSum / probes.length;
  const dist = Math.hypot(T[0] - v.pos[0], T[1] - v.pos[1], T[2] - v.pos[2]);
  const frac = seen / probes.length;
  const inFrame = ang < (v.fov ?? 70) / 2 * 0.8;
  const verdict = !inFrame ? 'out of frame'
    : frac >= 0.7 ? 'USABLE'
    : frac > 0 ? 'partly blocked'
    : 'occluded';
  rows.push({ name, ang, dist, frac, verdict });
}
rows.sort((a, b) => (b.frac - a.frac) || (a.ang - b.ang));
for (const r of rows)
  console.log(
    r.name.padEnd(11),
    (r.ang.toFixed(1) + '°').padStart(8),
    r.dist.toFixed(1).padStart(8),
    (Math.round(r.frac * 100) + '%').padStart(8),
    '  ' + r.verdict);
