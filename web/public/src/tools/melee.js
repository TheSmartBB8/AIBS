// melee.js — the sledgehammer.
//
// Short reach, one heavy blow, a big shallow bowl of a dent. Its whole character is the
// energy number: 0.60 punches straight through glass, foliage, plastic, plaster, wood
// and dirt, and bounces off brick (0.75), concrete (1.00) and metal (1.40) with a clang.
// It never "sort of" damages hard material — hitting concrete is pure feedback, no carve.

import { normalize } from './util.js';

export const SLEDGE_RANGE = 1.6;      // metres — you have to be on top of the wall
export const SLEDGE_ENERGY = 0.60;    // vs palette.strength(): wood 0.35 yes, brick 0.75 no
export const SLEDGE_RADIUS = 0.34;    // metres — chunky 7-voxel-wide bite
export const SWING_TIME = 0.42;       // seconds of animation

export const sledgehammer = {
  id: 'sledgehammer',
  name: 'Sledgehammer',
  slot: 1,
  continuous: false,
  cooldown: 0.55,
  range: SLEDGE_RANGE,
  ammo: Infinity,
  ammoPerShot: 0,
  energy: SLEDGE_ENERGY,

  makeState() {
    return { swinging: false, swingT: 0, hits: 0 };
  },

  /** Animation only — the renderer reads swingPose(state). */
  tick(state, dt) {
    if (!state.swinging) return;
    state.swingT += dt;
    if (state.swingT >= SWING_TIME) { state.swinging = false; state.swingT = 0; }
  },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    state.swinging = true;
    state.swingT = 0;

    const h = ctx.world.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], SLEDGE_RANGE);
    if (!h.hit) {
      ctx.playSound?.('sledge_whiff', eye[0], eye[1], eye[2], {});
      return { tool: 'sledgehammer', fired: true, hit: false, broke: false, energy: SLEDGE_ENERGY, carves: 0 };
    }

    const strength = ctx.palette.strength(h.pal);
    const material = ctx.palette.material(h.pal).name;
    const [px, py, pz] = h.pos;

    if (SLEDGE_ENERGY < strength) {
      // Too hard. Sparks, a heavy clang, a shove — but the wall is untouched.
      ctx.spawnParticles?.('sparks', px, py, pz, { count: 10, normal: [h.nx, h.ny, h.nz] });
      ctx.playSound?.('sledge_clang', px, py, pz, { material });
      ctx.applyImpulse?.(px, py, pz, d[0] * 40, d[1] * 40, d[2] * 40, { radius: 0.4, source: 'sledgehammer' });
      return {
        tool: 'sledgehammer', fired: true, hit: true, broke: false,
        material, strength, energy: SLEDGE_ENERGY, carves: 0, pos: h.pos,
      };
    }

    // Sink the sphere just under the surface so the result is a bowl, not a bite out of
    // the silhouette — that shallow dished dent is what makes the hammer read as blunt.
    const cx = px + d[0] * SLEDGE_RADIUS * 0.45;
    const cy = py + d[1] * SLEDGE_RADIUS * 0.45;
    const cz = pz + d[2] * SLEDGE_RADIUS * 0.45;

    ctx.carveSphere?.(cx, cy, cz, SLEDGE_RADIUS, SLEDGE_ENERGY, {
      source: 'sledgehammer', tool: 'sledgehammer', falloff: 0.55,
      normal: [h.nx, h.ny, h.nz],
    });
    ctx.applyImpulse?.(cx, cy, cz, d[0] * 260, d[1] * 260, d[2] * 260, { radius: SLEDGE_RADIUS * 1.6, source: 'sledgehammer' });
    ctx.spawnParticles?.('debris', px, py, pz, { count: 24, material, normal: [h.nx, h.ny, h.nz] });
    ctx.playSound?.('sledge_hit', px, py, pz, { material });
    ctx.emitOp?.({ type: 'carve', shape: 'sphere', x: cx, y: cy, z: cz, r: SLEDGE_RADIUS, e: SLEDGE_ENERGY, tool: 'sledgehammer' });

    state.hits++;
    return {
      tool: 'sledgehammer', fired: true, hit: true, broke: true,
      material, strength, energy: SLEDGE_ENERGY, carves: 1, pos: h.pos, centre: [cx, cy, cz],
    };
  },
};

/**
 * Viewmodel pose for the swing, 0..1 through wind-up / impact / recover.
 * Purely cosmetic: nothing in the damage path reads it.
 */
export function swingPose(state) {
  if (!state.swinging) return { t: 0, phase: 'idle', angle: 0 };
  const t = state.swingT / SWING_TIME;
  if (t < 0.35) {
    const k = t / 0.35;
    return { t, phase: 'wind', angle: -0.9 * k * k };
  }
  if (t < 0.5) {
    const k = (t - 0.35) / 0.15;
    return { t, phase: 'impact', angle: -0.9 + 2.1 * k };
  }
  const k = (t - 0.5) / 0.5;
  return { t, phase: 'recover', angle: 1.2 * (1 - k) };
}
