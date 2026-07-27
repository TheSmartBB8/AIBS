// construct.js — the two-click tools: plank and winch.
//
// Both are "click A, then click B" and both are about the *relationship* between two
// surfaces rather than a single impact point.
//
//   plank  writes real wood voxels into the grid spanning A to B. Not a decal, not a
//          rigid-body prop — actual voxels, so the structural-integrity solver treats it
//          as load-bearing and you can genuinely prop up a collapsing wall with it.
//   winch  hooks A and B, spends a moment taking up the slack, then YANKS: it works out
//          which end is anchored in weaker material, tears that end loose and throws it
//          at the other one.

import { normalize, dist, sub, sampleAnchor, fillCapsule, clamp } from './util.js';
import { MAT } from '../voxel/palette.js';
import { VOXEL } from '../voxel/world.js';

// ------------------------------------------------------------------------------ plank
export const PLANK_RANGE = 8.0;
export const PLANK_MAX_LEN = 5.0;   // metres. Long enough to prop a storey, short enough that it cannot bridge a whole street.
export const PLANK_MIN_LEN = 0.25;
export const PLANK_RADIUS = 0.075;   // metres — a 1-2 voxel strut

export const plank = {
  id: 'plank', name: 'Plank', slot: 13,
  continuous: false, cooldown: 0.35, range: PLANK_RANGE,
  ammo: Infinity, ammoPerShot: 0,
  makeState() { return { anchor: null, built: 0 }; },

  cancel(state) { const had = !!state.anchor; state.anchor = null; return had; },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    const h = ctx.world.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], PLANK_RANGE);
    if (!h.hit) return { tool: 'plank', fired: false, reason: 'no surface in reach', armed: !!state.anchor };

    // sit the endpoint a half-voxel proud of the surface; the fill skips solid voxels,
    // so the strut ends flush against whatever it is bracing
    const p = [
      h.pos[0] + h.nx * VOXEL * 0.5,
      h.pos[1] + h.ny * VOXEL * 0.5,
      h.pos[2] + h.nz * VOXEL * 0.5,
    ];

    if (!state.anchor) {
      state.anchor = { p, surface: [h.x, h.y, h.z], pal: h.pal };
      ctx.spawnParticles?.('dust', p[0], p[1], p[2], { count: 2 });
      ctx.playSound?.('plank_anchor', p[0], p[1], p[2], {});
      return { tool: 'plank', fired: true, armed: true, placed: false, a: p };
    }

    const a = state.anchor.p, b = p;
    const len = dist(a, b);
    if (len > PLANK_MAX_LEN) {
      ctx.playSound?.('tool_deny', eye[0], eye[1], eye[2], {});
      return { tool: 'plank', fired: false, reason: 'too long', armed: true, length: len };
    }
    if (len < PLANK_MIN_LEN) {
      state.anchor = null;
      ctx.playSound?.('tool_deny', eye[0], eye[1], eye[2], {});
      return { tool: 'plank', fired: false, reason: 'too short', armed: false, length: len };
    }

    const pal = ctx.palette.add(178, 138, 88, MAT.WOOD);
    const voxels = fillCapsule(ctx.world, a, b, PLANK_RADIUS, pal);
    state.anchor = null;
    state.built++;

    ctx.playSound?.('plank_place', b[0], b[1], b[2], {});
    ctx.spawnParticles?.('dust', b[0], b[1], b[2], { count: 6 });
    ctx.emitOp?.({ type: 'plank', a, b, r: PLANK_RADIUS, pal });

    return { tool: 'plank', fired: true, armed: false, placed: true, a, b, length: len, voxels, pal };
  },
};

// ------------------------------------------------------------------------------ winch
export const WINCH_RANGE = 20.0;
export const WINCH_TIGHTEN = 0.55;      // seconds of slack take-up before the yank
export const WINCH_RIP_RADIUS = 0.42;
export const WINCH_RIP_OVERKILL = 1.7;  // energy multiplier over the weak anchor's strength
export const WINCH_IMPULSE = 900;

export const winch = {
  id: 'winch', name: 'Winch', slot: 14,
  continuous: false, cooldown: 0.40, range: WINCH_RANGE,
  ammo: Infinity, ammoPerShot: 0,
  makeState() { return { anchor: null, yanks: 0 }; },

  cancel(state) { const had = !!state.anchor; state.anchor = null; return had; },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    const h = ctx.world.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], WINCH_RANGE);
    if (!h.hit) return { tool: 'winch', fired: false, reason: 'nothing to hook', armed: !!state.anchor };

    const p = [h.pos[0] + h.nx * 0.04, h.pos[1] + h.ny * 0.04, h.pos[2] + h.nz * 0.04];
    const anchor = { p, surface: [h.x, h.y, h.z], pal: h.pal, ...sampleAnchor(ctx.world, ctx.palette, p[0], p[1], p[2], 0.25) };

    if (!state.anchor) {
      state.anchor = anchor;
      ctx.playSound?.('winch_hook', p[0], p[1], p[2], {});
      return { tool: 'winch', fired: true, armed: true, a: p };
    }

    const a = state.anchor, b = anchor;
    const len = dist(a.p, b.p);
    state.anchor = null;
    if (len < 0.3) {
      ctx.playSound?.('tool_deny', eye[0], eye[1], eye[2], {});
      return { tool: 'winch', fired: false, reason: 'anchors too close', armed: false };
    }

    ctx.playSound?.('winch_hook', b.p[0], b.p[1], b.p[2], {});
    ctx.emitOp?.({ type: 'winch', a: a.p, b: b.p, tighten: WINCH_TIGHTEN });
    state.yanks++;
    return {
      tool: 'winch', fired: true, armed: false, a: a.p, b: b.p, length: len,
      spawn: { kind: 'winch', a, b, length: len, t: 0, tighten: WINCH_TIGHTEN, slack: 1 },
    };
  },
};

/** Which end gives first: the anchor sunk in weaker material (ties broken by mass). */
export function evaluateWinch(w) {
  const sa = w.a.avg || 0, sb = w.b.avg || 0;
  const aWeaker = sa < sb || (sa === sb && (w.a.mass || 0) <= (w.b.mass || 0));
  return aWeaker ? { weak: w.a, strong: w.b } : { weak: w.b, strong: w.a };
}

/**
 * The payoff: rip the weak anchor free and hurl it at the strong one.
 * Exported so it can be driven directly in tests as well as by ToolSystem.
 */
export function yankWinch(ctx, w) {
  const { weak, strong } = evaluateWinch(w);
  const delta = sub(strong.p, weak.p);
  const dir = normalize(delta[0], delta[1], delta[2]);

  // tear the weak end loose — just enough energy to beat its own material, no more,
  // so a hook in brick rips a brick-sized chunk and a hook in wood rips a wooden one
  const energy = Math.max(0.05, weak.avg || weak.max || 0.1) * WINCH_RIP_OVERKILL;
  ctx.carveSphere?.(weak.p[0], weak.p[1], weak.p[2], WINCH_RIP_RADIUS, energy, {
    source: 'winch', tool: 'winch', falloff: 0.5,
  });

  const mag = clamp(WINCH_IMPULSE + (weak.mass || 0) * 30, WINCH_IMPULSE, 6000);
  ctx.applyImpulse?.(weak.p[0], weak.p[1], weak.p[2], dir[0] * mag, dir[1] * mag, dir[2] * mag,
    { radius: WINCH_RIP_RADIUS * 1.5, source: 'winch' });

  ctx.spawnParticles?.('debris', weak.p[0], weak.p[1], weak.p[2], { count: 20, normal: dir });
  ctx.playSound?.('winch_yank', weak.p[0], weak.p[1], weak.p[2], {});
  ctx.emitOp?.({ type: 'winch_yank', from: weak.p, to: strong.p, dir, impulse: mag, energy });

  w.dead = true;
  return { from: weak.p, to: strong.p, dir, impulse: mag, energy, weak, strong };
}
