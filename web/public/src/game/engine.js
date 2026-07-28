// engine.js — the wiring layer.
//
// The simulation systems were each built to be independently testable, so none of them
// import each other: tools reach the world only through injected callbacks, physics owns
// voxel edits, fx owns fire and particles. This module is the one place that knows about
// all of them, and it exists to keep that decoupling intact rather than letting the
// systems grow references to one another.
//
// Coordinate convention: the tool callbacks take flat scalars (x, y, z, ...), while the
// physics helpers take arrays. Converting here — in one place — is deliberate; doing it
// at each call site is where sign and ordering mistakes breed.

import { PhysicsWorld, vehicleFromVoxels, liftVoxels, markRegionDirty } from '../physics/index.js';
import { ToolSystem } from '../tools/index.js';
import { TOOL, TOOL_ORDER } from '../tools/registry.js';
import { ParticleSystem } from '../fx/particles.js';
import { FireSim } from '../fx/fire.js';
import { VOXEL } from '../voxel/world.js';

export class Engine {
  constructor(world, palette, opts = {}) {
    this.world = world;
    this.palette = palette;
    this.time = 0;
    this.lights = [];              // transient lights the renderer consumes each frame
    this.sounds = [];              // queued sound events (no audio backend yet)
    this.ops = [];                 // networkable op log; nothing consumes it yet

    this.physics = new PhysicsWorld(world, palette, { seed: opts.seed ?? 1337 });
    this.particles = new ParticleSystem({ seed: opts.seed ?? 1337 });
    this.fire = new FireSim(world, palette, {
      seed: opts.seed ?? 1337,
      // Fire must not delete voxels behind physics' back — burning through a support has
      // to run the same integrity pass as any other edit, or a building can end up
      // floating because the thing holding it up quietly burned away.
      onBurnAway: (x, y, z, pal) => {
        world.set(x, y, z, 0);
        this.physics.afterEdit({ x0: x - 1, y0: y - 1, z0: z - 1, x1: x + 1, y1: y + 1, z1: z + 1 });
        this.particles.impactBurst([(x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL], [0, 1, 0], pal, 0.4);
      },
      onIgnite: (x, y, z) => {
        this.particles.fireEmit([(x + 0.5) * VOXEL, (y + 0.5) * VOXEL, (z + 0.5) * VOXEL], 1);
      },
    });

    this.tools = new ToolSystem(this.makeToolContext());
    this.stats = { carves: 0, explosions: 0, ignitions: 0 };
    this.driving = null;           // the Vehicle the player is currently in, if any
  }

  /**
   * Turn the level's vehicle descriptors into drivable vehicles.
   *
   * The level *describes* its cars rather than building them, because scene/ has
   * deliberately never depended on physics/. Lifting happens here: the voxels come out of
   * the grid (so the road underneath is clear and the car is no longer world geometry)
   * and become a chassis with wheels.
   */
  spawnVehicles(level) {
    const out = [];
    for (const spec of level?.vehicles || []) {
      const voxels = [];
      for (let y = spec.min[1]; y <= spec.max[1]; y++)
        for (let z = spec.min[2]; z <= spec.max[2]; z++)
          for (let x = spec.min[0]; x <= spec.max[0]; x++) {
            const pal = this.world.get(x, y, z);
            if (pal !== 0) voxels.push([x, y, z, pal]);
          }
      if (voxels.length < 8) continue;
      liftVoxels(this.world, voxels);
      markRegionDirty(this.world, spec.min[0], spec.min[1], spec.min[2],
        spec.max[0], spec.max[1], spec.max[2]);
      const veh = vehicleFromVoxels(voxels, this.palette, spec.wheels, {
        originVoxel: spec.min,
        tuning: { forward: spec.forward || [0, 0, 1] },
      });
      veh.name = spec.name || 'vehicle';
      this.physics.addVehicle(veh);
      out.push(veh);
    }
    return out;
  }

  get vehicles() { return this.physics.vehicles; }

  /** The drivable vehicle whose chassis centre is nearest `pos`, within `range` metres. */
  nearestVehicle(pos, range = 3.0) {
    let best = null, bestD = range * range;
    for (const v of this.physics.vehicles) {
      if (!v.alive) continue;
      const d = (v.body.pos[0] - pos[0]) ** 2 + (v.body.pos[1] - pos[1]) ** 2 + (v.body.pos[2] - pos[2]) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  enterVehicle(v) {
    if (!v || !v.alive) return null;
    this.driving = v;
    return v;
  }

  exitVehicle() {
    if (this.driving) this.driving.setInput({});
    const v = this.driving;
    this.driving = null;
    return v;
  }

  /** Route driving input to whatever the player is sitting in. */
  driveInput(input) {
    if (this.driving) this.driving.setInput(input);
  }

  /** The callback surface the tools were written against. */
  makeToolContext() {
    const P = this.physics;
    return {
      world: this.world,
      palette: this.palette,
      rng: Math.random,

      carveSphere: (x, y, z, radius, energy, opts = {}) => {
        this.stats.carves++;
        return P.carveBoxAt
          ? P.explode([x, y, z], radius, energy, { ...opts, impulse: 0, quiet: true })
          : null;
      },
      carveCapsule: (x0, y0, z0, x1, y1, z1, radius, energy, opts = {}) => {
        this.stats.carves++;
        return P.cut([x0, y0, z0], [x1, y1, z1], radius, energy, opts);
      },
      explode: (x, y, z, radius, energy, opts = {}) => {
        this.stats.explosions++;
        const res = P.explode([x, y, z], radius, energy, opts);
        this.particles.explosionBurst([x, y, z], radius);
        this.addLight(x, y, z, { color: [1.0, 0.62, 0.28], intensity: 26, radius: radius * 5, ttl: 0.35 });
        return res;
      },
      applyImpulse: (x, y, z, ix, iy, iz, opts = {}) => {
        // Radial blasts push every nearby body; a directed impulse (a sledge hit) pushes
        // whatever is at the point. Recoil is flagged `self` and is the player's problem,
        // not the world's.
        if (opts.self) return;
        const at = [x, y, z];
        if (opts.radial) {
          const r = opts.radius ?? 2, s = opts.strength ?? 1000;
          for (const b of P.bodies) {
            const dx = b.pos[0] - x, dy = b.pos[1] - y, dz = b.pos[2] - z;
            const d = Math.hypot(dx, dy, dz);
            if (d > r || d < 1e-6) continue;
            const f = (1 - d / r) * s;
            b.applyImpulse(at, [dx / d * f, dy / d * f, dz / d * f]);
          }
        } else {
          for (const b of P.bodies) {
            const d = Math.hypot(b.pos[0] - x, b.pos[1] - y, b.pos[2] - z);
            if (d > (opts.radius ?? 0.6) + 0.5) continue;
            b.applyImpulse(at, [ix, iy, iz]);
          }
        }
      },

      spawnParticles: (kind, x, y, z, opts = {}) => {
        const p = [x, y, z];
        switch (kind) {
          case 'explosion': this.particles.explosionBurst(p, opts.radius ?? 1.5); break;
          case 'smoke':     this.particles.smokePlume(p, opts.strength ?? 1); break;
          case 'sparks':
          case 'ricochet':  this.particles.impactBurst(p, opts.normal ?? [0, 1, 0], 0, 1.4); break;
          case 'splinters':
          case 'debris':    this.particles.impactBurst(p, opts.normal ?? [0, 1, 0], opts.pal ?? 0, 1); break;
          default:          this.particles.impactBurst(p, opts.normal ?? [0, 1, 0], 0, 0.8); break;
        }
      },

      // Signature is positional — (x, y, z, radius, intensity) — as documented in
      // tools/context.js and as every caller writes it. It used to take an options object
      // and read opts.r, so each call passed a number where an object was expected, the
      // radius silently fell back to 0.2 m, and a rocket lit a five-voxel box at the exact
      // centre of the crater it had just carved to air. Nothing ever caught fire.
      igniteAt: (x, y, z, radius = 0.2, intensity = 1, inner = 0) => {
        // igniteSphere, not a cube of unconditional ignites: it falls off with distance so
        // the near edge lights reliably and the far rim rarely, it stops at the
        // concurrent-fire cap instead of blowing through it, and it scorches what it fails
        // to light. `inner` hollows it out — see the note on igniteSphere.
        const lit = this.fire.igniteSphere([x, y, z], Math.max(VOXEL, radius),
          Math.min(1, 0.5 * intensity), inner);
        this.stats.ignitions += lit;
        return lit;
      },
      extinguishAt: (x, y, z, opts = {}) => {
        if (opts.dir) return this.fire.extinguishCone([x, y, z], opts.dir, opts.range ?? 4, opts.cone ?? 22, opts.power ?? 1);
        return this.fire.extinguishSphere([x, y, z], opts.radius ?? 1, opts.power ?? 1);
      },

      playSound: (name, opts = {}) => { this.sounds.push({ name, ...opts, t: this.time }); },
      addLight: (x, y, z, opts = {}) => this.addLight(x, y, z, opts),
      emitOp: (op) => { this.ops.push(op); if (this.ops.length > 4096) this.ops.shift(); },
    };
  }

  addLight(x, y, z, opts = {}) {
    this.lights.push({
      pos: [x, y, z],
      color: opts.color ?? [1, 0.8, 0.5],
      intensity: opts.intensity ?? 8,
      radius: opts.radius ?? 3,
      ttl: opts.ttl ?? 0.1,
      age: 0,
    });
    if (this.lights.length > 64) this.lights.shift();
  }

  selectTool(id) { this.tools.select(id); }
  nextTool(dir = 1) {
    const order = TOOL_ORDER;
    const i = order.indexOf(this.tools.current);
    this.tools.select(order[((i + dir) % order.length + order.length) % order.length]);
  }
  get currentTool() { return this.tools.current; }

  triggerDown(eye, dir) { return this.tools.triggerDown(eye, dir); }
  triggerUp(eye, dir) { return this.tools.triggerUp?.(eye, dir); }

  update(dt, aim) {
    this.time += dt;
    if (aim) this.tools.setAim?.(aim.eye, aim.dir);
    this.tools.update(dt, aim?.eye, aim?.dir);
    this.physics.step(dt);
    this.fire.update(dt);
    this.particles.update(dt);
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const L = this.lights[i];
      L.age += dt;
      if (L.age >= L.ttl) this.lights.splice(i, 1);
    }
  }
}

export { TOOL, TOOL_ORDER };
