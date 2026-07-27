// spray.js — spray can. The one tool that touches the world without breaking it.
//
// Teardown's model separates colour from material, and this is the tool that proves it:
// spraying a concrete wall pink gives you a pink *concrete* wall. It rewrites the voxel's
// palette index to an entry with a new colour but THE SAME material byte, so strength,
// density and flammability are all unchanged and nothing downstream (destruction,
// fire, structure) can tell the difference.

import { coneDir, normalize } from './util.js';
import { rngOf } from './context.js';

export const SPRAY_COLOURS = [
  [222,  58,  74],   // red
  [242, 142,  40],   // orange
  [246, 214,  70],   // yellow
  [ 92, 196, 104],   // green
  [ 62, 140, 232],   // blue
  [158,  92, 220],   // violet
  [246, 246, 246],   // white
  [ 26,  26,  30],   // black
];

export const SPRAY_RANGE = 3.2;
export const SPRAY_SPREAD = 0.055;   // radians — a soft ~0.2 m patch at arm's length
export const SPRAY_JETS = 14;        // rays per tick

export const spraycan = {
  id: 'spraycan',
  name: 'Spray can',
  slot: 2,
  continuous: true,
  cooldown: 0.045,
  range: SPRAY_RANGE,
  ammo: Infinity,
  ammoPerShot: 0,

  makeState() { return { colour: 0, painted: 0 }; },

  /** Right-click / scroll cycles the can. */
  cycleColour(state, delta = 1) {
    state.colour = (state.colour + delta + SPRAY_COLOURS.length * 4) % SPRAY_COLOURS.length;
    return SPRAY_COLOURS[state.colour];
  },

  fire(ctx, state, eye, dir) {
    const rng = rngOf(ctx);
    const d = normalize(dir[0], dir[1], dir[2]);
    const [r, g, b] = SPRAY_COLOURS[state.colour % SPRAY_COLOURS.length];
    const { world, palette } = ctx;

    let painted = 0, skipped = 0;
    let firstPos = null;
    for (let i = 0; i < SPRAY_JETS; i++) {
      const jd = coneDir(d, SPRAY_SPREAD, rng);
      const h = world.raycast(eye[0], eye[1], eye[2], jd[0], jd[1], jd[2], SPRAY_RANGE);
      if (!h.hit) continue;
      if (!firstPos) firstPos = h.pos;

      const src = h.pal;
      const mat = palette.mat[src];
      const dst = palette.add(r, g, b, mat, 0);
      // Palette full: add() returns whatever the last slot happens to be. Repainting with
      // it would silently change the material, which is exactly what this tool must never
      // do, so bail on that voxel instead.
      if (palette.mat[dst] !== mat) { skipped++; continue; }
      if (dst === src) continue;

      world.set(h.x, h.y, h.z, dst);
      painted++;
    }

    if (painted > 0) {
      state.painted += painted;
      ctx.emitOp?.({ type: 'paint', colour: [r, g, b], count: painted });
    }
    if (firstPos) {
      ctx.spawnParticles?.('paint', firstPos[0], firstPos[1], firstPos[2], { colour: [r, g, b], count: 6 });
    }
    ctx.playSound?.('spray_hiss', eye[0], eye[1], eye[2], { loop: true });

    return { tool: 'spraycan', fired: true, painted, skipped, colour: [r, g, b], colourIndex: state.colour };
  },
};
