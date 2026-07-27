// blowtorch.js — the surgical cutter and the primary fire-starter.
//
// Two things make it distinct from every other tool:
//   1. Energy 2.6 — high enough to cut metal (1.40) and even heavy metal (2.50), which
//      nothing else in the roster can touch. It is unlimited, so it is *the* answer to a
//      steel door; you just have to stand there and trace the cut.
//   2. It carves a CAPSULE between this tick's aim point and the last one, so dragging
//      the crosshair leaves a continuous slot the width of the flame instead of a string
//      of disconnected pocks. Radius 0.055 m = roughly one voxel.
//
// On flammable material it doesn't cut first — it heats. Hold on wood for HEAT_TO_IGNITE
// seconds and it catches.

import { normalize, dist } from './util.js';

export const TORCH_RANGE = 1.4;
export const TORCH_ENERGY = 2.6;      // > heavymetal 2.50, < unbreakable
export const TORCH_RADIUS = 0.055;    // metres — a one-voxel kerf
export const TORCH_TICK = 0.06;       // seconds between cut segments
export const HEAT_TO_IGNITE = 0.35;   // seconds of contact before flammable material lights
export const CUT_BREAK = 0.45;        // metres — aim jump that starts a new cut

export const blowtorch = {
  id: 'blowtorch',
  name: 'Blowtorch',
  slot: 4,
  continuous: true,
  cooldown: TORCH_TICK,
  range: TORCH_RANGE,
  ammo: Infinity,
  ammoPerShot: 0,
  energy: TORCH_ENERGY,

  makeState() { return { cutFrom: null, heat: 0, heatAt: null, cutLength: 0 }; },

  tick(state, dt, held) {
    if (!held) {
      // let go and the cut ends; the metal cools off fast enough to matter
      state.cutFrom = null;
      state.heat = Math.max(0, state.heat - dt * 2.5);
      if (state.heat === 0) state.heatAt = null;
    }
  },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    const h = ctx.world.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], TORCH_RANGE);
    if (!h.hit) {
      state.cutFrom = null;
      state.heat = 0;
      ctx.spawnParticles?.('torch_sparks', eye[0] + d[0] * 0.5, eye[1] + d[1] * 0.5, eye[2] + d[2] * 0.5, { count: 2 });
      return { tool: 'blowtorch', fired: true, hit: false, carves: 0, ignited: false };
    }

    const mat = ctx.palette.material(h.pal);
    const strength = mat.strength;
    const p = [h.pos[0] + d[0] * TORCH_RADIUS * 0.5, h.pos[1] + d[1] * TORCH_RADIUS * 0.5, h.pos[2] + d[2] * TORCH_RADIUS * 0.5];

    // --- heat / ignition (flammable material burns rather than cuts cleanly)
    let ignited = false;
    if (mat.flammable) {
      if (!state.heatAt || dist(state.heatAt, p) > CUT_BREAK) { state.heat = 0; state.heatAt = p; }
      state.heat += TORCH_TICK;
      if (state.heat >= HEAT_TO_IGNITE) {
        ctx.igniteAt?.(p[0], p[1], p[2], 0.3, 1.0);
        ctx.emitOp?.({ type: 'ignite', x: p[0], y: p[1], z: p[2], r: 0.3 });
        state.heat = 0;
        ignited = true;
      }
    } else {
      state.heat = 0;
      state.heatAt = null;
    }

    // --- the cut itself
    let carves = 0, cutLen = 0;
    if (TORCH_ENERGY >= strength) {
      const from = (state.cutFrom && dist(state.cutFrom, p) <= CUT_BREAK) ? state.cutFrom : p;
      cutLen = dist(from, p);
      ctx.carveCapsule?.(from[0], from[1], from[2], p[0], p[1], p[2], TORCH_RADIUS, TORCH_ENERGY, {
        source: 'blowtorch', tool: 'blowtorch', falloff: 0.15, normal: [h.nx, h.ny, h.nz],
      });
      ctx.emitOp?.({
        type: 'carve', shape: 'capsule', tool: 'blowtorch', r: TORCH_RADIUS, e: TORCH_ENERGY,
        a: from, b: p,
      });
      carves = 1;
      state.cutFrom = p;
      state.cutLength += cutLen;
    } else {
      state.cutFrom = null;   // unbreakable: no slot, just glow
    }

    ctx.spawnParticles?.('torch_sparks', p[0], p[1], p[2], { count: 8, normal: [h.nx, h.ny, h.nz], material: mat.name });
    ctx.addLight?.(p[0], p[1], p[2], { color: [0.65, 0.8, 1.0], intensity: 6, radius: 1.6, ttl: 0.08 });
    ctx.playSound?.('blowtorch', p[0], p[1], p[2], { loop: true });

    return {
      tool: 'blowtorch', fired: true, hit: true, carves, ignited,
      material: mat.name, strength, energy: TORCH_ENERGY, cutLength: cutLen, pos: h.pos,
    };
  },
};
