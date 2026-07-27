// explosives.js — pipe bomb, bomb, nitroglycerin, rocket launcher.
//
// These tools don't destroy anything themselves. Each one returns a *spawn descriptor*
// that ToolSystem takes ownership of; the system flies the projectiles, counts the
// fuses down and routes damage into the ones that react to it. That split is what makes
// the timing behaviours testable without a frame loop:
//
//   pipe bomb  thrown, arcs, BOUNCES off geometry, and detonates strictly on its fuse —
//              hitting a wall does nothing but make it ring and change direction.
//   bomb       sticks to the surface you aim at, 3 s countdown.
//   nitro      no fuse at all. It sits there until something damages it, then goes off —
//              and its own blast damages whatever else is nearby, so they chain.
//   rocket     fast, barely affected by gravity, detonates the instant it touches
//              anything, with the largest radius in the roster.

import { normalize } from './util.js';
import { MAT } from '../voxel/palette.js';
import { VOXEL } from '../voxel/world.js';

export const PLACE_RANGE = 4.0;

/** Write a small solid ball of voxels so a placed charge is visible and hittable. */
function writeBlob(world, pal, c, radius) {
  const r = Math.max(1, Math.round(radius / VOXEL));
  const cx = Math.floor(c[0] / VOXEL), cy = Math.floor(c[1] / VOXEL), cz = Math.floor(c[2] / VOXEL);
  const voxels = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        const x = cx + dx, y = cy + dy, z = cz + dz;
        if (!world.inBounds(x, y, z) || world.get(x, y, z) !== 0) continue;
        world.set(x, y, z, pal);
        voxels.push([x, y, z]);
      }
  if (voxels.length) world.updateMipsRegion(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r);
  return voxels;
}

/** Aim at a surface and return the point a charge should sit at, backed off along the normal. */
function placementPoint(ctx, eye, dir, range = PLACE_RANGE, standoff = 0.09) {
  const d = normalize(dir[0], dir[1], dir[2]);
  const h = ctx.world.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], range);
  if (!h.hit) return null;
  return {
    pos: [h.pos[0] + h.nx * standoff, h.pos[1] + h.ny * standoff, h.pos[2] + h.nz * standoff],
    normal: [h.nx, h.ny, h.nz],
    surface: [h.x, h.y, h.z],
    pal: h.pal,
    dir: d,
  };
}

// -------------------------------------------------------------------------- pipe bomb
export const PIPEBOMB_FUSE = 3.0;
export const PIPEBOMB_SPEED = 14;
export const PIPEBOMB_BLAST = { radius: 2.0, energy: 2.4, impulse: 2200, kind: 'pipebomb' };

export const pipebomb = {
  id: 'pipebomb', name: 'Pipe bomb', slot: 8,
  continuous: false, cooldown: 0.90, range: 0,
  ammo: 5, ammoPerShot: 1,
  fuse: PIPEBOMB_FUSE, blast: PIPEBOMB_BLAST,
  makeState() { return { thrown: 0 }; },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    state.thrown++;
    ctx.playSound?.('pipebomb_throw', eye[0], eye[1], eye[2], {});
    return {
      tool: 'pipebomb', fired: true,
      spawn: {
        kind: 'projectile', type: 'pipebomb',
        pos: [eye[0] + d[0] * 0.4, eye[1] + d[1] * 0.4, eye[2] + d[2] * 0.4],
        // a touch of lob so it arcs instead of flying flat
        vel: [d[0] * PIPEBOMB_SPEED, d[1] * PIPEBOMB_SPEED + 2.0, d[2] * PIPEBOMB_SPEED],
        gravity: -9.8,
        restitution: 0.35,
        friction: 0.4,
        radius: 0.08,
        fuse: PIPEBOMB_FUSE,
        detonateOnImpact: false,     // <- the whole point of the pipe bomb
        blast: PIPEBOMB_BLAST,
      },
    };
  },
};

// ------------------------------------------------------------------------------- bomb
export const BOMB_FUSE = 3.0;
export const BOMB_BLAST = { radius: 3.2, energy: 3.2, impulse: 4200, kind: 'bomb' };

export const bomb = {
  id: 'bomb', name: 'Bomb', slot: 9,
  continuous: false, cooldown: 0.80, range: PLACE_RANGE,
  ammo: 3, ammoPerShot: 1,
  fuse: BOMB_FUSE, blast: BOMB_BLAST,
  makeState() { return { placed: 0 }; },

  fire(ctx, state, eye, dir) {
    const at = placementPoint(ctx, eye, dir);
    if (!at) return { tool: 'bomb', fired: false, reason: 'no surface in reach' };
    const pal = ctx.palette.add(38, 38, 44, MAT.PLASTIC);
    const voxels = writeBlob(ctx.world, pal, at.pos, 0.14);
    state.placed++;
    ctx.playSound?.('bomb_place', at.pos[0], at.pos[1], at.pos[2], {});
    ctx.emitOp?.({ type: 'place', what: 'bomb', x: at.pos[0], y: at.pos[1], z: at.pos[2], fuse: BOMB_FUSE });
    return {
      tool: 'bomb', fired: true, pos: at.pos,
      spawn: {
        kind: 'placed', type: 'bomb', pos: at.pos, normal: at.normal,
        attachedTo: at.surface, voxels,
        fuse: BOMB_FUSE,
        triggerOnDamage: true, triggerRadius: 0.30, triggerEnergy: 0.5,
        blast: BOMB_BLAST,
      },
    };
  },
};

// ------------------------------------------------------------------------------ nitro
export const NITRO_BLAST = { radius: 4.2, energy: 3.8, impulse: 5200, kind: 'nitro', fire: 1.6 };

export const nitro = {
  id: 'nitro', name: 'Nitroglycerin', slot: 10,
  continuous: false, cooldown: 0.80, range: PLACE_RANGE,
  ammo: 3, ammoPerShot: 1,
  fuse: null,                       // never times out — this is the defining trait
  blast: NITRO_BLAST,
  makeState() { return { placed: 0 }; },

  fire(ctx, state, eye, dir) {
    const at = placementPoint(ctx, eye, dir, PLACE_RANGE, 0.12);
    if (!at) return { tool: 'nitro', fired: false, reason: 'no surface in reach' };
    const pal = ctx.palette.add(196, 46, 36, MAT.METAL);
    const voxels = writeBlob(ctx.world, pal, at.pos, 0.18);
    state.placed++;
    ctx.playSound?.('nitro_place', at.pos[0], at.pos[1], at.pos[2], {});
    ctx.emitOp?.({ type: 'place', what: 'nitro', x: at.pos[0], y: at.pos[1], z: at.pos[2] });
    return {
      tool: 'nitro', fired: true, pos: at.pos,
      spawn: {
        kind: 'placed', type: 'nitro', pos: at.pos, normal: at.normal,
        attachedTo: at.surface, voxels,
        fuse: null,                 // ToolSystem must never count this one down
        triggerOnDamage: true, triggerRadius: 0.45, triggerEnergy: 0.2,
        blast: NITRO_BLAST,
      },
    };
  },
};

// -------------------------------------------------------------------- rocket launcher
export const ROCKET_SPEED = 26;
export const ROCKET_BLAST = { radius: 4.5, energy: 3.6, impulse: 6000, kind: 'rocket' };

export const rocket = {
  id: 'rocket', name: 'Rocket launcher', slot: 11,
  continuous: false, cooldown: 1.80, range: 0,
  ammo: 4, ammoPerShot: 1,
  blast: ROCKET_BLAST,
  makeState() { return { fired: 0 }; },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    state.fired++;
    ctx.playSound?.('rocket_launch', eye[0], eye[1], eye[2], {});
    ctx.spawnParticles?.('smoke', eye[0], eye[1], eye[2], { count: 20, ttl: 2.5 });
    ctx.applyImpulse?.(eye[0], eye[1], eye[2], -d[0] * 140, -d[1] * 140, -d[2] * 140, { source: 'recoil', self: true });
    return {
      tool: 'rocket', fired: true,
      spawn: {
        kind: 'projectile', type: 'rocket',
        pos: [eye[0] + d[0] * 0.5, eye[1] + d[1] * 0.5, eye[2] + d[2] * 0.5],
        vel: [d[0] * ROCKET_SPEED, d[1] * ROCKET_SPEED, d[2] * ROCKET_SPEED],
        gravity: -1.5,               // barely drops over its flight
        radius: 0.09,
        fuse: 6.0,                   // self-destruct so a miss into the sky isn't immortal
        detonateOnImpact: true,
        trail: 'rocket',
        blast: ROCKET_BLAST,
      },
    };
  },
};
