// Find a demolition target that is BOTH in shot and made of something.
//
// seecam.mjs answers "can this camera see this point", which is necessary and not
// sufficient: I aimed a rocket at a point it scored 71% on and got a frame with no
// destruction in it, because the point was empty air in the 0.4 m gap between the terrace
// (ends z 1.6 m) and the road (starts z 2.0 m). The rocket flew through and hit nothing.
//
// Casting the camera's own rays and reporting where they *land* answers both at once.
import { VoxelWorld } from '../public/src/voxel/world.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';
import { buildLevel } from '../public/src/scene/level.js';
import { VIEWS } from '../public/src/scene/views.js';

const world = new VoxelWorld(256, 160, 256);
const palette = new Palette();
buildLevel(world, palette);
const name = process.argv[2] || 'street';
const v = VIEWS[name];
const MATNAME = Object.fromEntries(Object.entries(MAT).map(([k, n]) => [n, k]));

const f = [0, 1, 2].map((i) => v.look[i] - v.pos[i]);
const F = f.map((c) => c / Math.hypot(...f));
const R0 = [-F[2], 0, F[0]];
const Rn = R0.map((c) => c / (Math.hypot(...R0) || 1));
const U = [Rn[1] * F[2] - Rn[2] * F[1], Rn[2] * F[0] - Rn[0] * F[2], Rn[0] * F[1] - Rn[1] * F[0]];
const half = Math.tan((v.fov * Math.PI / 180) / 2);

console.log(`${name}: surfaces the lens is pointed at\n`);
console.log(' screen x,y     dist   material          hit point');
for (const ny of [0.25, 0.0, -0.2]) {
  for (const nx of [-0.45, -0.2, 0.2, 0.45]) {
    const a = nx * half * 1.68, b = ny * half;
    const d = [0, 1, 2].map((i) => F[i] + Rn[i] * a + U[i] * b);
    const dl = Math.hypot(...d);
    const D = d.map((c) => c / dl);
    const h = world.raycast(v.pos[0], v.pos[1], v.pos[2], D[0], D[1], D[2], 30);
    if (!h.hit) { console.log(`${nx.toFixed(2)},${ny.toFixed(2)}   —      sky`); continue; }
    const p = h.pal ?? 0;
    const m = (MATNAME[palette.mat[p]] || '?').padEnd(12);
    // Pull the aim point slightly back along the ray so it sits on the surface, not inside.
    const pt = [0, 1, 2].map((i) => v.pos[i] + D[i] * (h.dist - 0.05));
    console.log(`${nx.toFixed(2).padStart(5)},${ny.toFixed(2).padStart(5)}  ${h.dist.toFixed(1).padStart(5)}  ${m}  ${pt.map((c) => c.toFixed(2)).join(',')}`);
  }
}
