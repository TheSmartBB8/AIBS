// firearms.js — pistol, shotgun, hunting rifle, minigun.
//
// They share a hitscan core but almost nothing else:
//
//   pistol   1 ray, no spread, 0.42 energy — pops glass and wood, refuses brick upward.
//   shotgun  8 pellets in a real cone, energy bleeds with distance, and it *scuffs*:
//            when a pellet can't break the surface it still knocks a single voxel loose,
//            which is why it shreds a wooden shed but only pits a concrete wall.
//   rifle    3.0 energy and a penetration march — it keeps travelling through successive
//            obstacles, paying strength x thickness for each, until the budget runs out.
//   minigun  weak per shot, but spins up to ~28 rounds/second and the spread opens as
//            the barrels come up to speed.

import { coneDir, normalize, probeThickness, clamp, lerp } from './util.js';
import { rngOf } from './context.js';

/** A pellet/bullet strike that does not penetrate. Returns the number of carves made. */
function impact(ctx, hit, d, { energy, radius, source, scuff = false }) {
  const strength = ctx.palette.strength(hit.pal);
  const material = ctx.palette.material(hit.pal).name;
  const [px, py, pz] = hit.pos;
  const cx = px + d[0] * radius * 0.5, cy = py + d[1] * radius * 0.5, cz = pz + d[2] * radius * 0.5;

  if (energy >= strength) {
    ctx.carveSphere?.(cx, cy, cz, radius, energy, {
      source, tool: source, falloff: 0.7, normal: [hit.nx, hit.ny, hit.nz],
    });
    ctx.applyImpulse?.(cx, cy, cz, d[0] * energy * 90, d[1] * energy * 90, d[2] * energy * 90,
      { radius: radius * 2, source });
    ctx.spawnParticles?.('debris', px, py, pz, { count: 8, material, normal: [hit.nx, hit.ny, hit.nz] });
    ctx.emitOp?.({ type: 'carve', shape: 'sphere', x: cx, y: cy, z: cz, r: radius, e: energy, tool: source });
    return { carves: 1, broke: true, material, strength };
  }

  // SCUFF_FRACTION: close enough to break through that a single surface voxel pops off.
  // The visible result on concrete is a pit the size of one voxel — "barely marks".
  if (scuff && energy >= strength * 0.45) {
    const e = strength * 1.02;
    ctx.carveSphere?.(cx, cy, cz, radius * 0.35, e, {
      source, tool: source, falloff: 0, scuff: true, normal: [hit.nx, hit.ny, hit.nz],
    });
    ctx.spawnParticles?.('dust', px, py, pz, { count: 4, material });
    return { carves: 1, broke: false, scuffed: true, material, strength };
  }

  ctx.spawnParticles?.('ricochet', px, py, pz, { count: 3, material, normal: [hit.nx, hit.ny, hit.nz] });
  ctx.playSound?.('ricochet', px, py, pz, { material });
  return { carves: 0, broke: false, material, strength };
}

function muzzle(ctx, eye, d, source, loud = 1) {
  ctx.spawnParticles?.('muzzle', eye[0] + d[0] * 0.3, eye[1] + d[1] * 0.3, eye[2] + d[2] * 0.3, { count: 4 });
  ctx.addLight?.(eye[0] + d[0] * 0.3, eye[1] + d[1] * 0.3, eye[2] + d[2] * 0.3,
    { color: [1.0, 0.85, 0.55], intensity: 5 * loud, radius: 3 * loud, ttl: 0.05 });
  ctx.playSound?.(source, eye[0], eye[1], eye[2], {});
}

// ---------------------------------------------------------------------------- pistol
export const PISTOL_ENERGY = 0.42;

export const pistol = {
  id: 'pistol', name: 'Pistol', slot: 6,
  continuous: false, cooldown: 0.14, range: 60,
  ammo: 60, ammoPerShot: 1, energy: PISTOL_ENERGY,
  makeState() { return { shots: 0 }; },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    const h = ctx.world.raycast(eye[0], eye[1], eye[2], d[0], d[1], d[2], this.range);
    muzzle(ctx, eye, d, 'pistol', 0.7);
    state.shots++;
    if (!h.hit) return { tool: 'pistol', fired: true, hit: false, carves: 0, rays: [d] };
    const r = impact(ctx, h, d, { energy: PISTOL_ENERGY, radius: 0.055, source: 'pistol' });
    return { tool: 'pistol', fired: true, hit: true, rays: [d], energy: PISTOL_ENERGY, pos: h.pos, ...r };
  },
};

// --------------------------------------------------------------------------- shotgun
export const SHOT_PELLETS = 8;
export const SHOT_SPREAD = 0.085;     // radians half-angle
export const SHOT_ENERGY = 0.55;      // per pellet at the muzzle
export const SHOT_RANGE = 24;
export const SHOT_BLEED = 0.55;       // fraction of energy lost at max range

export const shotgun = {
  id: 'shotgun', name: 'Shotgun', slot: 5,
  continuous: false, cooldown: 0.85, range: SHOT_RANGE,
  ammo: 30, ammoPerShot: 1, energy: SHOT_ENERGY, pellets: SHOT_PELLETS,
  makeState() { return { shots: 0 }; },

  fire(ctx, state, eye, dir) {
    const rng = rngOf(ctx);
    const d = normalize(dir[0], dir[1], dir[2]);
    const pellets = [];
    let carves = 0, broke = 0, scuffed = 0;

    for (let i = 0; i < SHOT_PELLETS; i++) {
      const pd = coneDir(d, SHOT_SPREAD, rng);
      const h = ctx.world.raycast(eye[0], eye[1], eye[2], pd[0], pd[1], pd[2], SHOT_RANGE);
      if (!h.hit) { pellets.push({ dir: pd, hit: false }); continue; }
      const e = SHOT_ENERGY * (1 - SHOT_BLEED * clamp(h.dist / SHOT_RANGE, 0, 1));
      const r = impact(ctx, h, pd, { energy: e, radius: 0.10, source: 'shotgun', scuff: true });
      carves += r.carves;
      if (r.broke) broke++;
      if (r.scuffed) scuffed++;
      pellets.push({ dir: pd, hit: true, energy: e, ...r, pos: h.pos });
    }

    muzzle(ctx, eye, d, 'shotgun', 1.4);
    ctx.applyImpulse?.(eye[0], eye[1], eye[2], -d[0] * 60, -d[1] * 60, -d[2] * 60, { source: 'recoil', self: true });
    state.shots++;
    return {
      tool: 'shotgun', fired: true, pellets, rays: pellets.map(p => p.dir),
      carves, broke, scuffed, spread: SHOT_SPREAD,
    };
  },
};

// ----------------------------------------------------------------------------- rifle
export const RIFLE_ENERGY = 3.0;
export const RIFLE_RADIUS = 0.075;
export const RIFLE_RANGE = 200;
export const PEN_K = 10;        // energy per (strength x metre) of material crossed
export const PEN_BASE = 0.15;   // fixed cost of punching a surface at all
export const MAX_PEN = 6;       // sanity bound on the march

export const rifle = {
  id: 'rifle', name: 'Hunting rifle', slot: 7,
  continuous: false, cooldown: 1.30, range: RIFLE_RANGE,
  ammo: 20, ammoPerShot: 1, energy: RIFLE_ENERGY,
  makeState() { return { shots: 0 }; },

  fire(ctx, state, eye, dir) {
    const d = normalize(dir[0], dir[1], dir[2]);
    let energy = RIFLE_ENERGY;
    let ox = eye[0], oy = eye[1], oz = eye[2];
    let travelled = 0;
    const segments = [];
    let carves = 0, stopped = false, stoppedBy = null;

    for (let i = 0; i < MAX_PEN; i++) {
      const remaining = RIFLE_RANGE - travelled;
      if (remaining <= 0) break;
      const h = ctx.world.raycast(ox, oy, oz, d[0], d[1], d[2], remaining);
      if (!h.hit) break;

      const strength = ctx.palette.strength(h.pal);
      const material = ctx.palette.material(h.pal).name;
      travelled += h.dist;

      if (energy < strength) {
        // can't even mark it — the round splashes
        ctx.spawnParticles?.('ricochet', h.pos[0], h.pos[1], h.pos[2], { count: 6, material });
        ctx.playSound?.('ricochet', h.pos[0], h.pos[1], h.pos[2], { material });
        segments.push({ material, strength, energy, carved: false, pos: h.pos });
        stopped = true; stoppedBy = material;
        break;
      }

      // the hole narrows as the round slows — a clean 7 cm entry, a ragged small exit
      const radius = RIFLE_RADIUS * lerp(0.55, 1, clamp(energy / RIFLE_ENERGY, 0, 1));
      const cx = h.pos[0] + d[0] * radius, cy = h.pos[1] + d[1] * radius, cz = h.pos[2] + d[2] * radius;
      ctx.carveSphere?.(cx, cy, cz, radius, energy, {
        source: 'rifle', tool: 'rifle', falloff: 0.4, normal: [h.nx, h.ny, h.nz],
      });
      ctx.applyImpulse?.(cx, cy, cz, d[0] * energy * 120, d[1] * energy * 120, d[2] * energy * 120,
        { radius: radius * 2, source: 'rifle' });
      ctx.spawnParticles?.('splinters', h.pos[0], h.pos[1], h.pos[2], { count: 10, material, normal: [h.nx, h.ny, h.nz] });
      ctx.emitOp?.({ type: 'carve', shape: 'sphere', x: cx, y: cy, z: cz, r: radius, e: energy, tool: 'rifle' });
      carves++;

      const probe = probeThickness(ctx.world, h.pos[0], h.pos[1], h.pos[2], d[0], d[1], d[2], 3.0);
      const cost = strength * probe.thickness * PEN_K + PEN_BASE;
      const before = energy;
      energy -= cost;
      segments.push({
        material, strength, energy: before, energyAfter: energy,
        thickness: probe.thickness, carved: true, exited: probe.exited, pos: h.pos,
      });

      if (energy <= 0 || !probe.exited) { stopped = true; stoppedBy = material; break; }

      // resume just past the far face
      const step = probe.thickness + 0.06;
      ox = h.pos[0] + d[0] * step; oy = h.pos[1] + d[1] * step; oz = h.pos[2] + d[2] * step;
      travelled += step;
    }

    muzzle(ctx, eye, d, 'rifle', 1.6);
    ctx.applyImpulse?.(eye[0], eye[1], eye[2], -d[0] * 90, -d[1] * 90, -d[2] * 90, { source: 'recoil', self: true });
    state.shots++;
    return {
      tool: 'rifle', fired: true, rays: [d], segments, carves,
      penetrated: carves > 1, stopped, stoppedBy,
      energy: RIFLE_ENERGY, energyLeft: Math.max(0, energy),
    };
  },
};

// --------------------------------------------------------------------------- minigun
export const MINIGUN_ENERGY = 0.30;
export const MINIGUN_SPINUP = 0.9;    // seconds to full speed
export const MINIGUN_SPINDOWN = 1.4;
export const MINIGUN_MIN_SPIN = 0.4;  // below this the barrels turn but nothing fires
export const MINIGUN_RPM_MIN = 0.115; // seconds/round just after the gate opens
export const MINIGUN_RPM_MAX = 0.035; // seconds/round at full spin (~28/s)

export const minigun = {
  id: 'minigun', name: 'Minigun', slot: 12,
  continuous: true, cooldown: MINIGUN_RPM_MIN, range: 80,
  ammo: 300, ammoPerShot: 1, energy: MINIGUN_ENERGY,
  makeState() { return { spin: 0, shots: 0 }; },

  tick(state, dt, held) {
    const target = held ? dt / MINIGUN_SPINUP : -dt / MINIGUN_SPINDOWN;
    state.spin = clamp(state.spin + target, 0, 1);
  },

  /** Rate of fire rises with spin — the system asks for this instead of `cooldown`. */
  cooldownFor(state) {
    if (state.spin < MINIGUN_MIN_SPIN) return 0.03;   // retry soon, still spinning up
    const k = (state.spin - MINIGUN_MIN_SPIN) / (1 - MINIGUN_MIN_SPIN);
    return lerp(MINIGUN_RPM_MIN, MINIGUN_RPM_MAX, k);
  },

  fire(ctx, state, eye, dir) {
    if (state.spin < MINIGUN_MIN_SPIN) {
      ctx.playSound?.('minigun_spin', eye[0], eye[1], eye[2], { pitch: state.spin });
      return { tool: 'minigun', fired: false, reason: 'spinup', spin: state.spin, carves: 0 };
    }
    const rng = rngOf(ctx);
    const d = normalize(dir[0], dir[1], dir[2]);
    const spread = 0.008 + 0.030 * state.spin;   // the faster it turns, the looser it walks
    const bd = coneDir(d, spread, rng);
    const h = ctx.world.raycast(eye[0], eye[1], eye[2], bd[0], bd[1], bd[2], this.range);
    muzzle(ctx, eye, bd, 'minigun', 0.9);
    state.shots++;
    if (!h.hit) return { tool: 'minigun', fired: true, hit: false, carves: 0, rays: [bd], spin: state.spin };
    const r = impact(ctx, h, bd, { energy: MINIGUN_ENERGY, radius: 0.05, source: 'minigun', scuff: true });
    return {
      tool: 'minigun', fired: true, hit: true, rays: [bd], spread,
      spin: state.spin, energy: MINIGUN_ENERGY, pos: h.pos, ...r,
    };
  },
};
