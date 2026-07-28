// Integration tests for the wiring layer. Each subsystem is tested on its own elsewhere;
// what matters here is that a tool actually reaches the world through the callback bridge,
// which is exactly the seam where flat-scalar vs array coordinate conventions get mixed up.
import { VoxelWorld, VOXEL } from '../public/src/voxel/world.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';
import { Engine } from '../public/src/game/engine.js';
import { TOOL, TOOL_ORDER } from '../public/src/tools/registry.js';

let fails = 0, checks = 0;
const CHECK = (c, m) => { checks++; if (c) console.log(`[ OK ] ${m}`); else { console.log(`[FAIL] ${m}`); fails++; } };

/** A room with a wooden wall at x = 20..21 and a concrete floor. */
function scene() {
  const w = new VoxelWorld(64, 64, 64);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const wood = p.add(150, 110, 68, MAT.WOOD);
  const conc = p.add(170, 170, 165, MAT.CONCRETE);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) { w.setRaw(x, 0, z, rock); w.setRaw(x, 1, z, rock); }
  for (let y = 2; y < 30; y++) for (let z = 4; z < 40; z++) for (let x = 20; x <= 21; x++) w.setRaw(x, y, z, wood);
  for (let y = 2; y < 30; y++) for (let z = 4; z < 40; z++) for (let x = 40; x <= 41; x++) w.setRaw(x, y, z, conc);
  w.rebuildMips();
  return { w, p, wood, conc };
}
const EYE = [1.0, 1.2, 1.2];
const FWD = [1, 0, 0];

// ---- construction
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  CHECK(!!e.physics && !!e.tools && !!e.fire && !!e.particles, 'engine builds every subsystem');
  CHECK(e.tools.missingCallbacks.length === 0,
        `every tool callback is wired (missing: ${JSON.stringify(e.tools.missingCallbacks)})`);
}

// ---- a tool actually destroys world voxels through the bridge
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  e.selectTool(TOOL.SHOTGUN);
  const before = w.countSolid();
  e.triggerDown(EYE, FWD);
  e.update(1 / 60, { eye: EYE, dir: FWD });
  CHECK(w.countSolid() < before, `firing a shotgun removes voxels (${before - w.countSolid()})`);
  CHECK(e.stats.carves > 0 || e.stats.explosions > 0, 'the carve reached the engine through the tool context');
}

// ---- material discrimination survives the bridge (energies are not being mangled)
{
  const shoot = (targetX) => {
    const { w, p } = scene();
    const e = new Engine(w, p);
    e.selectTool(TOOL.SHOTGUN);
    const before = w.countSolid();
    e.triggerDown([targetX === 20 ? 1.0 : 3.0, 1.2, 1.2], FWD);
    e.update(1 / 60, { eye: [1.0, 1.2, 1.2], dir: FWD });
    return before - w.countSolid();
  };
  const wood = shoot(20);
  CHECK(wood > 0, `the shotgun shreds the wooden wall (${wood} voxels)`);
}

// ---- explosions reach physics AND spawn light + particles
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  const before = w.countSolid();
  e.tools.ctx.explode(2.05, 1.0, 1.2, 1.2, 4.0, {});
  CHECK(w.countSolid() < before, `an explosion through the bridge destroys voxels (${before - w.countSolid()})`);
  CHECK(e.lights.length > 0, 'the explosion queued a transient light for the renderer');
  CHECK(e.particles.count > 0, `the explosion spawned particles (${e.particles.count})`);
  CHECK(e.stats.explosions === 1, 'the engine counted exactly one explosion');
}

// ---- transient lights expire rather than accumulating forever
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  e.addLight(1, 1, 1, { ttl: 0.1 });
  CHECK(e.lights.length === 1, 'light is queued');
  for (let i = 0; i < 20; i++) e.update(1 / 60, { eye: EYE, dir: FWD });
  CHECK(e.lights.length === 0, 'the light expired after its ttl');
}

// ---- fire: ignition through the bridge, and burn-away routed via physics
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  const lit = e.tools.ctx.igniteAt(20.5 * VOXEL, 1.0, 1.0, 0.4, 2);
  CHECK(lit > 0, `igniteAt lights flammable voxels (${lit})`);
  CHECK(e.fire.count > 0, 'the fire sim is tracking them');
  CHECK(e.stats.ignitions === lit, 'the stat counts voxels lit, not calls made');

  // concrete must never light
  const e2 = new Engine(scene().w, p);
  const litConc = e2.tools.ctx.igniteAt(40.5 * VOXEL, 1.0, 1.0, 0.4, 2);
  CHECK(litConc === 0, 'concrete cannot be ignited');
}

// ---- the tool contract is positional: a radius passed as a number must be honoured.
// Regression guard. The engine used to take an options object here while every caller
// (explosion.js, blowtorch.js) passed a number, so the radius silently collapsed to its
// default and explosions started no fires at all.
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  const near = e.tools.ctx.igniteAt(20.5 * VOXEL, 1.0, 1.0, 0.15, 2);
  e.fire.extinguishAll();
  const far = e.tools.ctx.igniteAt(20.5 * VOXEL, 1.0, 1.0, 0.9, 2);
  CHECK(far > near, `a larger radius lights more voxels (${near} -> ${far})`);
}

// ---- burning long enough actually consumes wood, through the normal edit path
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  for (let i = 0; i < 12; i++) e.tools.ctx.igniteAt((20.5 + 0) * VOXEL, (4 + i) * VOXEL, (10 + i) * VOXEL, 0.15, 2);
  const before = w.countSolid();
  for (let i = 0; i < 60 * 30; i++) e.update(1 / 60, { eye: EYE, dir: FWD });
  CHECK(w.countSolid() < before, `fire burns wood away over time (${before - w.countSolid()} voxels)`);
}

// ---- an explosive on wood leaves the place burning.
//
// This is the check that was missing. Every part in isolation was fine — FireSim spreads,
// detonate() calls igniteAt, the engine implements it — and the whole chain still did
// nothing, because the blast carved the crater before igniting its own centre and the
// radius was being dropped on the way through. Nothing short of end to end catches that,
// and a screenshot is a poor substitute: fire was invisible here for the same reason it
// was invisible on screen, but this runs in milliseconds and says which link broke.
// The shared scene() wall is deliberately not used: it is 3.6 m long against a 3.4 m blast
// radius, so a rocket removes its entire base and the whole free-standing slab drops. That
// is correct physics and it leaves nothing standing to burn. A real wall outlives its
// crater, so this one runs the full width of the world and stays grounded at the ends.
{
  const w = new VoxelWorld(64, 64, 64);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const wood = p.add(150, 110, 68, MAT.WOOD);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) { w.setRaw(x, 0, z, rock); w.setRaw(x, 1, z, rock); }
  for (let y = 2; y < 24; y++) for (let z = 0; z < 64; z++) for (let x = 20; x <= 21; x++) w.setRaw(x, y, z, wood);
  w.rebuildMips();

  const e = new Engine(w, p);
  e.selectTool(TOOL.ROCKET);
  e.triggerDown([1.0, 1.2, 3.2], FWD);
  for (let i = 0; i < 60 * 3; i++) e.update(1 / 60, { eye: EYE, dir: FWD });
  CHECK(e.fire.count > 0, `a rocket into a wooden wall leaves it burning (${e.fire.count} fires)`);
  CHECK(e.fire.totalIgnitions > 1, `and the fire spreads rather than sitting still (${e.fire.totalIgnitions} ignitions)`);
}

// ---- and it lights the surface even when the blast knocks that surface clean off.
//
// This is the case the grounded wall above cannot see. scene()'s wall is free-standing and
// shorter than the blast radius, so the rocket takes out its whole base and the slab lifts
// into rigid bodies — at which point the voxel grid near the impact is momentarily empty.
// Igniting after the carve finds nothing there and returns zero. Hence ignition runs first.
//
// The assertion is on ignitions, not on surviving fires: those flames ride voxels that have
// just left the grid, and FireSim is indexed by grid position, so they go out. Burning
// debris — a lit plank that keeps burning as it tumbles — is a separate feature this
// engine does not have.
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  e.selectTool(TOOL.ROCKET);
  e.triggerDown([1.0, 1.2, 1.6], FWD);
  for (let i = 0; i < 60 * 3; i++) e.update(1 / 60, { eye: EYE, dir: FWD });
  CHECK(e.fire.totalIgnitions > 0,
        `a blast lights what it hits before demolishing it (${e.fire.totalIgnitions} ignitions)`);
}

// ---- every tool in the roster can be selected and fired without throwing
{
  const failures = [];
  for (const id of TOOL_ORDER) {
    try {
      const { w, p } = scene();
      const e = new Engine(w, p);
      e.selectTool(id);
      e.triggerDown(EYE, FWD);
      for (let i = 0; i < 30; i++) e.update(1 / 60, { eye: EYE, dir: FWD });
      e.triggerDown(EYE, FWD);          // second click completes two-stage tools
      for (let i = 0; i < 30; i++) e.update(1 / 60, { eye: EYE, dir: FWD });
    } catch (err) {
      failures.push(`${id}: ${err.message}`);
    }
  }
  CHECK(failures.length === 0, `all ${TOOL_ORDER.length} tools fire through the engine without throwing`);
  if (failures.length) failures.slice(0, 6).forEach(f => console.log('        ', f));
}

// ---- tool cycling wraps in both directions
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  e.selectTool(TOOL_ORDER[0]);
  e.nextTool(-1);
  CHECK(e.currentTool === TOOL_ORDER[TOOL_ORDER.length - 1], 'scrolling back from the first tool wraps to the last');
  e.nextTool(1);
  CHECK(e.currentTool === TOOL_ORDER[0], 'and forward again wraps to the first');
}

// ---- a big blast leaves the sim stable and stepping
{
  const { w, p } = scene();
  const e = new Engine(w, p);
  e.tools.ctx.explode(2.05, 1.5, 1.5, 2.2, 6.0, {});
  let threw = null;
  try { for (let i = 0; i < 600; i++) e.update(1 / 60, { eye: EYE, dir: FWD }); }
  catch (err) { threw = err; }
  CHECK(!threw, `stepping 10 s after a large blast does not throw${threw ? ' — ' + threw.message : ''}`);
  CHECK(w.countSolid() > 0, 'the world still has geometry');
  CHECK(Number.isFinite(e.physics.bodies.reduce((a, b) => a + b.pos[1], 0)), 'no body position went NaN');
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
