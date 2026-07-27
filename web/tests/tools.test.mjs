// Headless tests for the tools/weapons package. No GPU, no physics module:
// every engine dependency is a recording stub, which is the whole point of the
// injected-callback contract in public/src/tools/context.js.

import { VoxelWorld, VOXEL } from '../public/src/voxel/world.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';
import { ToolSystem } from '../public/src/tools/system.js';
import { TOOL, TOOLS, TOOL_ORDER, getTool, cooldownOf } from '../public/src/tools/registry.js';
import { sledgehammer, swingPose, SLEDGE_ENERGY } from '../public/src/tools/melee.js';
import { spraycan, SPRAY_COLOURS } from '../public/src/tools/spray.js';
import { extinguisher } from '../public/src/tools/extinguisher.js';
import { blowtorch, TORCH_ENERGY, HEAT_TO_IGNITE, TORCH_TICK } from '../public/src/tools/blowtorch.js';
import { pistol, shotgun, rifle, minigun, SHOT_PELLETS, SHOT_SPREAD, RIFLE_ENERGY } from '../public/src/tools/firearms.js';
import { plank } from '../public/src/tools/construct.js';
import { makeRng, angleBetween, normalize } from '../public/src/tools/util.js';

let fails = 0, checks = 0;
const CHECK = (cond, msg) => {
  checks++;
  if (cond) console.log(`[ OK ] ${msg}`);
  else { console.log(`[FAIL] ${msg}`); fails++; }
};

// ---------------------------------------------------------------- stub context
const CB = ['carveSphere', 'carveCapsule', 'explode', 'applyImpulse', 'spawnParticles',
            'igniteAt', 'extinguishAt', 'playSound', 'addLight', 'emitOp'];

/** Context whose every callback records its arguments. `omit` drops callbacks entirely. */
function recording(world, palette, { omit = [], seed = 7 } = {}) {
  const calls = {};
  const ctx = { world, palette, rng: makeRng(seed), calls };
  for (const k of CB) {
    calls[k] = [];
    if (omit.includes(k)) continue;
    ctx[k] = (...args) => { calls[k].push(args); };
  }
  return ctx;
}

const EYE = [1.0, 1.0, 1.0];
const FWD = [1, 0, 0];

/** 64^3 world (6.4 m cube) with a slab of `pal` filling x0..x1. */
function wallWorld(pal, x0 = 20, x1 = 21) {
  const w = new VoxelWorld(64, 64, 64);
  for (let y = 0; y < 24; y++)
    for (let z = 0; z < 24; z++)
      for (let x = x0; x <= x1; x++) w.setRaw(x, y, z, pal);
  w.rebuildMips();
  return w;
}

function box(w, x0, y0, z0, x1, y1, z1, p) {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) w.setRaw(x, y, z, p);
}

/** Sealed concrete room so thrown projectiles can't escape the test world. */
function roomWorld(pal) {
  const w = new VoxelWorld(64, 64, 64);
  box(w, 0, 0, 0, 63, 3, 63, pal);        // floor
  box(w, 0, 60, 0, 63, 63, 63, pal);      // ceiling
  box(w, 0, 0, 0, 1, 63, 63, pal);        // -x
  box(w, 62, 0, 0, 63, 63, 63, pal);      // +x
  box(w, 0, 0, 0, 63, 63, 1, pal);        // -z
  box(w, 0, 0, 62, 63, 63, 63, pal);      // +z
  w.rebuildMips();
  return w;
}

const paletteWith = () => {
  const p = new Palette();
  return {
    palette: p,
    wood: p.add(150, 110, 68, MAT.WOOD),
    glass: p.add(150, 190, 205, MAT.GLASS),
    concrete: p.add(170, 170, 170, MAT.CONCRETE),
    brick: p.add(150, 78, 58, MAT.BRICK),
    metal: p.add(138, 144, 150, MAT.METAL),
    heavy: p.add(90, 96, 104, MAT.HEAVY_METAL),
    rock: p.add(58, 56, 54, MAT.UNBREAKABLE),
  };
};

// =========================================================== sledgehammer
{
  const P = paletteWith();

  const wCtx = recording(wallWorld(P.wood), P.palette);
  const rWood = sledgehammer.fire(wCtx, sledgehammer.makeState(), EYE, FWD);
  CHECK(rWood.hit && rWood.broke, 'sledgehammer breaks a wooden wall');
  CHECK(wCtx.calls.carveSphere.length === 1, 'sledgehammer carves exactly one dent per swing');
  const [, , , radius, energy] = wCtx.calls.carveSphere[0];
  CHECK(energy >= P.palette.strength(P.wood),
        `energy ${energy} >= wood strength ${P.palette.strength(P.wood)}`);
  CHECK(radius > 0.25, `dent is chunky, not a pinprick (r=${radius} m = ${(radius / VOXEL).toFixed(0)} voxels)`);

  const cCtx = recording(wallWorld(P.concrete), P.palette);
  const rConc = sledgehammer.fire(cCtx, sledgehammer.makeState(), EYE, FWD);
  CHECK(rConc.hit && !rConc.broke, 'sledgehammer bounces off concrete');
  CHECK(cCtx.calls.carveSphere.length === 0, 'concrete takes NO carve call from the sledgehammer');
  CHECK(SLEDGE_ENERGY < P.palette.strength(P.concrete),
        `sledgehammer energy ${SLEDGE_ENERGY} < concrete strength ${P.palette.strength(P.concrete)}`);
  CHECK(cCtx.calls.spawnParticles.some(a => a[0] === 'sparks'), 'a failed hit still throws sparks');

  const mCtx = recording(wallWorld(P.metal), P.palette);
  const rMetal = sledgehammer.fire(mCtx, sledgehammer.makeState(), EYE, FWD);
  CHECK(!rMetal.broke && mCtx.calls.carveSphere.length === 0, 'sledgehammer cannot touch metal');

  // swing animation is state-only and decays on its own
  const st = sledgehammer.makeState();
  sledgehammer.fire(recording(wallWorld(P.wood), P.palette), st, EYE, FWD);
  CHECK(st.swinging && swingPose(st).phase === 'wind', 'swing starts in wind-up');
  sledgehammer.tick(st, 0.2);
  CHECK(swingPose(st).phase !== 'wind', 'swing advances through its phases');
  sledgehammer.tick(st, 1.0);
  CHECK(!st.swinging && swingPose(st).phase === 'idle', 'swing returns to idle');
}

// ================================================================ blowtorch
{
  const P = paletteWith();

  const mCtx = recording(wallWorld(P.metal), P.palette);
  const rMetal = blowtorch.fire(mCtx, blowtorch.makeState(), EYE, FWD);
  CHECK(mCtx.calls.carveCapsule.length === 1, 'blowtorch cuts metal (capsule carve)');
  const cap = mCtx.calls.carveCapsule[0];
  const capEnergy = cap[8 - 1];   // (x0,y0,z0,x1,y1,z1,radius,energy,opts)
  CHECK(capEnergy >= P.palette.strength(P.metal),
        `torch energy ${capEnergy} >= metal strength ${P.palette.strength(P.metal)}`);
  CHECK(capEnergy >= P.palette.strength(P.heavy),
        'torch energy also beats heavy metal, the hardest breakable material');
  CHECK(cap[6] < 0.1, `torch kerf is narrow (r=${cap[6]} m), unlike the sledgehammer dent`);
  CHECK(rMetal.carves === 1 && TORCH_ENERGY > SLEDGE_ENERGY,
        'the torch does what the sledgehammer cannot: metal');

  const sledgeOnMetal = recording(wallWorld(P.metal), P.palette);
  sledgehammer.fire(sledgeOnMetal, sledgehammer.makeState(), EYE, FWD);
  CHECK(sledgeOnMetal.calls.carveSphere.length === 0 && mCtx.calls.carveCapsule.length === 1,
        'same metal wall: sledgehammer 0 carves, blowtorch 1 cut');

  const uCtx = recording(wallWorld(P.rock), P.palette);
  blowtorch.fire(uCtx, blowtorch.makeState(), EYE, FWD);
  CHECK(uCtx.calls.carveCapsule.length === 0, 'blowtorch still cannot cut unbreakable material');

  // dragging the aim leaves one continuous slot, not disconnected pocks
  const dragCtx = recording(wallWorld(P.metal), P.palette);
  const dst = blowtorch.makeState();
  blowtorch.fire(dragCtx, dst, EYE, FWD);
  blowtorch.fire(dragCtx, dst, EYE, [1, 0.05, 0]);
  const seg = dragCtx.calls.carveCapsule[1];
  const segLen = Math.hypot(seg[3] - seg[0], seg[4] - seg[1], seg[5] - seg[2]);
  CHECK(segLen > 0, `second tick cuts a segment from the previous point (len ${segLen.toFixed(3)} m)`);

  // flammable material heats before it lights
  const fCtx = recording(wallWorld(P.wood), P.palette);
  const fst = blowtorch.makeState();
  blowtorch.fire(fCtx, fst, EYE, FWD);
  CHECK(fCtx.calls.igniteAt.length === 0, 'wood does not ignite on the first contact tick');
  for (let t = 0; t < HEAT_TO_IGNITE / TORCH_TICK + 1; t++) blowtorch.fire(fCtx, fst, EYE, FWD);
  CHECK(fCtx.calls.igniteAt.length >= 1, 'holding the torch on wood eventually ignites it');
}

// ==================================================================== rifle
{
  const P = paletteWith();

  // two thin wooden walls, 1 m apart
  const w = new VoxelWorld(64, 64, 64);
  box(w, 20, 0, 0, 21, 24, 24, P.wood);
  box(w, 30, 0, 0, 31, 24, 24, P.wood);
  w.rebuildMips();
  const ctx = recording(w, P.palette);
  const r = rifle.fire(ctx, rifle.makeState(), [0.5, 1.0, 1.0], FWD);
  CHECK(ctx.calls.carveSphere.length >= 2,
        `rifle punches through both thin walls in one shot (${ctx.calls.carveSphere.length} carves)`);
  CHECK(r.penetrated && r.segments.length >= 2, 'result reports penetration through 2 obstacles');
  CHECK(r.segments[1].energy < r.segments[0].energy, 'the round loses energy in each wall it crosses');

  // ... but a heavy steel slab stops it dead
  const hw = wallWorld(P.heavy, 20, 23);
  const hctx = recording(hw, P.palette);
  const hr = rifle.fire(hctx, rifle.makeState(), [0.5, 1.0, 1.0], FWD);
  CHECK(hctx.calls.carveSphere.length === 1, 'rifle marks heavy metal once and goes no further');
  CHECK(hr.stopped && !hr.penetrated, `heavy metal stops the round (stoppedBy=${hr.stoppedBy})`);

  // unbreakable takes nothing at all
  const uctx = recording(wallWorld(P.rock, 20, 21), P.palette);
  const ur = rifle.fire(uctx, rifle.makeState(), [0.5, 1.0, 1.0], FWD);
  CHECK(uctx.calls.carveSphere.length === 0 && ur.stopped, 'rifle ricochets off unbreakable material');

  // contrast: the pistol has no penetration budget at all
  const pctx = recording(w, P.palette);
  pistol.fire(pctx, pistol.makeState(), [0.5, 1.0, 1.0], FWD);
  CHECK(pctx.calls.carveSphere.length === 1, 'pistol stops at the first wall (1 carve)');
  CHECK(RIFLE_ENERGY > 5 * pistol.energy, 'rifle carries far more energy than the pistol');
}

// ================================================================== shotgun
{
  const P = paletteWith();
  const ctx = recording(wallWorld(P.wood, 20, 21), P.palette);
  const r = shotgun.fire(ctx, shotgun.makeState(), EYE, FWD);
  CHECK(r.rays.length === SHOT_PELLETS, `shotgun fires ${SHOT_PELLETS} pellets`);

  const uniq = new Set(r.rays.map(d => d.map(v => v.toFixed(6)).join(',')));
  CHECK(uniq.size === SHOT_PELLETS, 'every pellet takes its own divergent direction');

  const angles = r.rays.map(d => angleBetween(d, FWD));
  const maxA = Math.max(...angles);
  CHECK(maxA > 1e-3, `pellets actually diverge from the aim (max ${(maxA * 1000).toFixed(1)} mrad)`);
  CHECK(maxA <= SHOT_SPREAD + 1e-6, 'pellets stay inside the advertised cone');

  const hits = r.rays.map((d, i) => r.pellets[i]).filter(p => p.hit);
  CHECK(hits.length === SHOT_PELLETS, 'all 8 pellets reach the wall at this range');
  CHECK(ctx.calls.carveSphere.length === SHOT_PELLETS, 'each pellet shreds wood on its own');

  // concrete: barely marked, not shredded
  const cctx = recording(wallWorld(P.concrete, 20, 21), P.palette);
  const cr = shotgun.fire(cctx, shotgun.makeState(), EYE, FWD);
  CHECK(cr.broke === 0 && cr.scuffed > 0, 'shotgun only scuffs concrete, never breaks it');
  const scuffR = cctx.calls.carveSphere[0][3];
  const woodR = ctx.calls.carveSphere[0][3];
  CHECK(scuffR < woodR * 0.5, `concrete scuff (r=${scuffR.toFixed(3)}) is far smaller than the wood bite (r=${woodR.toFixed(3)})`);
}

// ================================================================ spray can
{
  const P = paletteWith();
  const w = wallWorld(P.concrete, 20, 21);
  const ctx = recording(w, P.palette);
  const st = spraycan.makeState();
  const before = w.get(20, 10, 10);
  const r = spraycan.fire(ctx, st, EYE, FWD);
  const after = w.get(20, 10, 10);

  CHECK(r.painted > 0, `spray can repaints voxels (${r.painted})`);
  CHECK(after !== before, 'the sprayed voxel gets a new palette index');
  CHECK(P.palette.mat[after] === P.palette.mat[before], 'the new palette entry keeps the SAME material');
  CHECK(P.palette.material(after).name === 'concrete', 'painted concrete is still concrete');
  CHECK(P.palette.strength(after) === P.palette.strength(before), 'strength is untouched by paint');
  CHECK(P.palette.isFlammable(after) === false, 'painting does not make concrete flammable');
  CHECK(ctx.calls.carveSphere.length === 0 && ctx.calls.carveCapsule.length === 0,
        'spray can destroys nothing');

  const c0 = st.colour;
  spraycan.cycleColour(st);
  CHECK(st.colour === (c0 + 1) % SPRAY_COLOURS.length, 'spray can cycles colours');
  spraycan.fire(ctx, st, EYE, FWD);
  CHECK(P.palette.mat[w.get(20, 10, 10)] === MAT.CONCRETE, 'second colour still preserves the material');

  // painting wood keeps it flammable — the material byte, not the colour, decides
  const w2 = wallWorld(P.wood, 20, 21);
  const ctx2 = recording(w2, P.palette);
  spraycan.fire(ctx2, spraycan.makeState(), EYE, FWD);
  CHECK(P.palette.isFlammable(w2.get(20, 10, 10)), 'painted wood still burns');
}

// ============================================================= extinguisher
{
  const P = paletteWith();
  const ctx = recording(wallWorld(P.wood, 20, 21), P.palette);
  const r = extinguisher.fire(ctx, extinguisher.makeState(), EYE, FWD);
  CHECK(ctx.calls.extinguishAt.length >= 2, 'extinguisher suppresses at several points along the cone');
  CHECK(ctx.calls.carveSphere.length === 0, 'extinguisher does no damage');
  const gust = ctx.calls.applyImpulse[0];
  CHECK(gust && gust[6] && gust[6].maxDensity !== undefined,
        'the gust is capped by density so it only shifts light material');
  const dirs = r.points.map(p => normalize(p[0] - EYE[0], p[1] - EYE[1], p[2] - EYE[2]));
  CHECK(Math.max(...dirs.map(d => angleBetween(d, FWD))) > 1e-3, 'suppression spreads into a cone');
}

// ================================================================== minigun
{
  const P = paletteWith();
  const ctx = recording(wallWorld(P.wood, 20, 21), P.palette);
  const st = minigun.makeState();
  const cold = minigun.fire(ctx, st, EYE, FWD);
  CHECK(cold.fired === false && cold.reason === 'spinup', 'minigun refuses to fire before spin-up');
  CHECK(ctx.calls.carveSphere.length === 0, 'no damage during spin-up');

  for (let i = 0; i < 60; i++) minigun.tick(st, 1 / 60, true);
  CHECK(st.spin > 0.9, `barrels reach full speed after ~1 s (spin ${st.spin.toFixed(2)})`);
  const hot = minigun.fire(ctx, st, EYE, FWD);
  CHECK(hot.fired && ctx.calls.carveSphere.length === 1, 'spun-up minigun fires');
  CHECK(minigun.cooldownFor(st) < minigun.cooldown, 'rate of fire rises with spin');
  CHECK(minigun.energy < shotgun.energy, 'minigun rounds are individually weak');

  for (let i = 0; i < 200; i++) minigun.tick(st, 1 / 60, false);
  CHECK(st.spin === 0, 'barrels spin down when the trigger is released');
}

// ==================================================================== plank
{
  const P = paletteWith();
  // two facing walls with a gap between them
  const w = new VoxelWorld(64, 64, 64);
  box(w, 10, 0, 0, 11, 30, 30, P.concrete);
  box(w, 40, 0, 0, 41, 30, 30, P.concrete);
  w.rebuildMips();
  const ctx = recording(w, P.palette);
  const st = plank.makeState();
  const solidBefore = w.countSolid();

  const first = plank.fire(ctx, st, [2.5, 1.0, 1.0], [-1, 0, 0]);
  CHECK(first.armed && !first.placed, 'first click only arms an anchor');
  CHECK(!!st.anchor, 'anchor is stored on the tool state');
  CHECK(w.countSolid() === solidBefore, 'arming writes no voxels');

  const second = plank.fire(ctx, st, [2.5, 1.0, 1.0], [1, 0, 0]);
  CHECK(second.placed && second.voxels > 0, `second click writes ${second.voxels} real voxels`);
  CHECK(!st.anchor, 'anchor is consumed');
  CHECK(w.countSolid() === solidBefore + second.voxels, 'the world really grew by that many voxels');
  CHECK(P.palette.material(second.pal).name === 'wood', 'the strut is genuine wood, not decoration');

  // it must actually SPAN the gap, all the way between the two walls
  const midPal = w.get(26, 10, 10);
  CHECK(midPal !== 0 && P.palette.mat[midPal] === MAT.WOOD, 'voxels exist at the midpoint of the span');
  CHECK(w.get(13, 10, 10) !== 0, 'voxels exist next to the first anchor');
  CHECK(w.get(38, 10, 10) !== 0, 'voxels exist next to the second anchor');
  CHECK(w.get(26, 25, 10) === 0, 'the strut is a thin strut, not a filled slab');
  CHECK(second.length > 2.5 && second.length < 3.0, `plank length ${second.length.toFixed(2)} m matches the gap`);

  // over-long spans are refused and keep the anchor armed
  const st2 = plank.makeState();
  const w2 = new VoxelWorld(64, 64, 64);
  box(w2, 0, 0, 0, 1, 40, 40, P.concrete);
  box(w2, 62, 0, 0, 63, 40, 40, P.concrete);
  w2.rebuildMips();
  const ctx2 = recording(w2, P.palette);
  plank.fire(ctx2, st2, [3.2, 1.0, 1.0], [-1, 0, 0]);
  const solid2 = w2.countSolid();
  const tooLong = plank.fire(ctx2, st2, [3.2, 1.0, 1.0], [1, 0, 0]);
  CHECK(tooLong.fired === false && tooLong.reason === 'too long', 'a 6 m span is refused');
  CHECK(w2.countSolid() === solid2 && !!st2.anchor, 'refused plank writes nothing and stays armed');
}

// ============================================== ToolSystem: pipe bomb fuse
{
  const P = paletteWith();
  const w = roomWorld(P.concrete);
  const ctx = recording(w, P.palette);
  const sys = new ToolSystem(ctx);
  sys.select(TOOL.PIPEBOMB);
  const r = sys.triggerDown([1.0, 2.0, 3.0], [1, 0, 0]);
  CHECK(r.fired && sys.projectiles.length === 1, 'pipe bomb spawns a projectile');
  const p = sys.projectiles[0];
  CHECK(p.detonateOnImpact === false, 'a pipe bomb is explicitly not an impact fuse');

  let bouncedBeforeBlast = 0;
  for (let t = 0; t < 2.9; t += 0.02) {
    sys.update(0.02);
    if (sys.projectiles.length) bouncedBeforeBlast = sys.projectiles[0].bounces;
  }
  CHECK(bouncedBeforeBlast >= 1, `pipe bomb bounced ${bouncedBeforeBlast} time(s) without detonating`);
  CHECK(ctx.calls.explode.length === 0, 'no explosion before the fuse runs out');
  CHECK(sys.projectiles.length === 1, 'the bomb is still in play at t=2.9 s');

  for (let t = 0; t < 0.4; t += 0.02) sys.update(0.02);
  CHECK(ctx.calls.explode.length === 1, 'pipe bomb detonates when its 3 s fuse expires');
  CHECK(sys.projectiles.length === 0, 'the projectile is retired after detonating');
  const ev = sys.events.find(e => e.type === 'detonate');
  CHECK(ev && ev.cause === 'fuse', 'the detonation is attributed to the fuse, not an impact');
}

// ============================================ ToolSystem: rocket on impact
{
  const P = paletteWith();
  const ctx = recording(roomWorld(P.concrete), P.palette);
  const sys = new ToolSystem(ctx);
  sys.select(TOOL.ROCKET);
  sys.triggerDown([1.0, 2.0, 3.0], [1, 0, 0]);
  CHECK(sys.projectiles[0].detonateOnImpact === true, 'a rocket is an impact fuse');
  sys.update(0.05);
  sys.update(0.05);
  CHECK(ctx.calls.explode.length === 1, 'rocket detonates on contact, long before any fuse');
  const ev = sys.events.find(e => e.type === 'detonate');
  CHECK(ev.cause === 'impact', 'the detonation is attributed to the impact');
  CHECK(ev.radius > 4, `rocket has the largest blast radius (${ev.radius} m)`);
}

// ================================================ ToolSystem: bomb timer
{
  const P = paletteWith();
  const ctx = recording(roomWorld(P.concrete), P.palette);
  const sys = new ToolSystem(ctx);
  sys.select(TOOL.BOMB);
  const r = sys.triggerDown([1.0, 2.0, 3.0], [0, -1, 0]);
  CHECK(r.fired && sys.placed.length === 1, 'bomb sticks to the surface under the crosshair');
  CHECK(sys.placed[0].fuse === 3.0, 'placed bomb carries a 3 s fuse');

  for (let t = 0; t < 2.8; t += 0.05) sys.update(0.05);
  CHECK(ctx.calls.explode.length === 0, 'placed bomb has not gone off at 2.8 s');
  for (let t = 0; t < 0.4; t += 0.05) sys.update(0.05);
  CHECK(ctx.calls.explode.length === 1, 'placed bomb detonates after its countdown');
  CHECK(sys.placed.length === 0, 'the charge is removed once it fires');
}

// ======================================== ToolSystem: nitro (damage only)
{
  const P = paletteWith();
  const ctx = recording(roomWorld(P.concrete), P.palette);
  const sys = new ToolSystem(ctx);
  sys.select(TOOL.NITRO);
  const r = sys.triggerDown([1.0, 2.0, 3.0], [0, -1, 0]);
  CHECK(r.fired && sys.placed.length === 1, 'nitro canister is placed');
  CHECK(sys.placed[0].fuse === null, 'nitro has no fuse at all');

  for (let t = 0; t < 10; t += 0.1) sys.update(0.1);
  CHECK(ctx.calls.explode.length === 0, 'nitro does NOT detonate on a timer (10 s elapsed)');
  CHECK(sys.placed.length === 1, 'nitro is still sitting there');

  const at = sys.placed[0].pos;
  sys.notifyDamage(at[0] + 0.2, at[1], at[2], 0.1, 0.9, 'test');
  CHECK(ctx.calls.explode.length === 1, 'nitro detonates when damaged nearby');
  CHECK(sys.placed.length === 0, 'the canister is consumed');

  // ... and damage far away leaves it alone
  const ctx2 = recording(roomWorld(P.concrete), P.palette);
  const sys2 = new ToolSystem(ctx2);
  sys2.select(TOOL.NITRO);
  sys2.triggerDown([1.0, 2.0, 3.0], [0, -1, 0]);
  const at2 = sys2.placed[0].pos;
  sys2.notifyDamage(at2[0] + 3.0, at2[1], at2[2], 0.1, 0.9, 'test');
  CHECK(ctx2.calls.explode.length === 0, 'damage out of range does not set nitro off');
  sys2.notifyDamage(at2[0] + 0.2, at2[1], at2[2], 0.1, 0.01, 'test');
  CHECK(ctx2.calls.explode.length === 0, 'a scratch below the trigger threshold does not set nitro off');
}

// ===================================== ToolSystem: chain reaction + damage bus
{
  const P = paletteWith();
  const ctx = recording(roomWorld(P.concrete), P.palette);
  const sys = new ToolSystem(ctx);
  sys.select(TOOL.NITRO);
  // three canisters, each inside the previous one's blast radius
  sys.triggerDown([1.0, 2.0, 3.0], [0, -1, 0]);
  sys.update(1.0);
  sys.triggerDown([2.5, 2.0, 3.0], [0, -1, 0]);
  sys.update(1.0);
  sys.triggerDown([4.0, 2.0, 3.0], [0, -1, 0]);
  sys.update(1.0);
  CHECK(sys.placed.length === 3, 'three nitro canisters placed');
  CHECK(ctx.calls.explode.length === 0, 'still nothing has gone off');

  const at = sys.placed[0].pos;
  sys.notifyDamage(at[0], at[1] + 0.2, at[2], 0.1, 1.0, 'test');
  CHECK(ctx.calls.explode.length === 3, `one hit chain-reacts all three (${ctx.calls.explode.length})`);
  CHECK(sys.placed.length === 0, 'all canisters consumed by the chain');

  // any carve routed through the system's context counts as damage
  const ctx2 = recording(roomWorld(P.concrete), P.palette);
  const sys2 = new ToolSystem(ctx2);
  sys2.select(TOOL.NITRO);
  sys2.triggerDown([1.0, 2.0, 3.0], [0, -1, 0]);
  const nAt = sys2.placed[0].pos;
  sys2.ctx.carveSphere(nAt[0] + 0.2, nAt[1], nAt[2], 0.1, 0.8, { source: 'test' });
  CHECK(ctx2.calls.carveSphere.length >= 1, 'the wrapped carve still reaches the engine callback');
  CHECK(ctx2.calls.explode.length === 1, 'a carve near nitro sets it off through the damage bus');
}

// =========================================================== ToolSystem: winch
{
  const P = paletteWith();
  const w = new VoxelWorld(64, 64, 64);
  box(w, 10, 0, 0, 11, 30, 30, P.wood);     // weak anchor at low x
  box(w, 40, 0, 0, 41, 30, 30, P.heavy);    // strong anchor at high x
  w.rebuildMips();
  const ctx = recording(w, P.palette);
  const sys = new ToolSystem(ctx);
  sys.select(TOOL.WINCH);

  const a = sys.triggerDown([2.5, 1.0, 1.0], [-1, 0, 0]);
  CHECK(a.armed, 'first click hooks the wooden anchor');
  sys.update(0.5);
  const b = sys.triggerDown([2.5, 1.0, 1.0], [1, 0, 0]);
  CHECK(b.fired && sys.winches.length === 1, 'second click strings the cable');
  CHECK(ctx.calls.applyImpulse.length === 0, 'nothing is yanked while the cable is still slack');

  sys.update(0.3);
  CHECK(sys.winches.length === 1 && sys.winches[0].slack < 1, 'the cable tightens over time');
  sys.update(0.4);
  CHECK(sys.winches.length === 0, 'the winch fires once and is done');

  const yank = ctx.calls.applyImpulse.find(c => c[6] && c[6].source === 'winch');
  CHECK(!!yank, 'the yank applies an impulse');
  const dir = normalize(yank[3], yank[4], yank[5]);
  CHECK(dir[0] > 0.99, `impulse points from the weak (wood) anchor toward the strong (steel) one (dir x=${dir[0].toFixed(3)})`);
  const rip = ctx.calls.carveSphere.find(c => c[5] && c[5].source === 'winch');
  CHECK(!!rip, 'material is torn free at an anchor');
  CHECK(rip[0] < 2.0, `the tear happens at the WEAK anchor (x=${rip[0].toFixed(2)} m, wood side)`);
  CHECK(rip[4] >= P.palette.strength(P.wood), 'the rip energy beats the weak anchor material');
  CHECK(rip[4] < P.palette.strength(P.heavy), 'but not the strong anchor material');

  const ev = sys.events.find(e => e.type === 'winch_yank');
  CHECK(ev && ev.weak.avg < ev.strong.avg, 'the system identified which end was weaker');
}

// ================================================ registry / system integrity
{
  const ids = Object.values(TOOL);
  CHECK(ids.length === 14, `roster has all 14 tools (${ids.length})`);
  for (const id of ids) {
    const t = TOOLS[id];
    CHECK(!!t, `${id}: registered`);
    if (!t) continue;
    CHECK(t.id === id, `${id}: id matches its enum key`);
    CHECK(typeof t.fire === 'function', `${id}: has a fire() entry point`);
    CHECK(typeof t.cooldown === 'number' && t.cooldown > 0, `${id}: has a positive cooldown (${t.cooldown}s)`);
    CHECK(typeof t.continuous === 'boolean', `${id}: declares whether it is held or single-shot`);
    CHECK(typeof t.name === 'string' && t.name.length > 0, `${id}: has a display name`);
    CHECK(t.ammo === Infinity || (typeof t.ammo === 'number' && t.ammo > 0), `${id}: ammo semantics defined`);
    CHECK(!(t.ammoPerShot > 0) || t.ammo !== Infinity, `${id}: a tool that spends ammo has a finite supply`);
    CHECK(TOOL_ORDER.includes(id), `${id}: present in the hotbar order`);
  }
  CHECK(new Set(TOOL_ORDER).size === TOOL_ORDER.length, 'hotbar order has no duplicates');
  CHECK(new Set(Object.values(TOOLS).map(t => t.slot)).size === ids.length, 'every tool has a unique slot');

  const P = paletteWith();
  const ctx = recording(wallWorld(P.wood, 20, 21), P.palette);
  const sys = new ToolSystem(ctx);
  for (const id of TOOL_ORDER) {
    CHECK(!!sys.states[id], `${id}: ToolSystem allocated state`);
    sys.select(id);
    // every tool must survive being fired at a wall with a fully stubbed context
    let ok = true;
    try { sys.fire([1.0, 1.0, 1.0], [1, 0, 0]); } catch (e) { ok = false; console.log(`       ${e.message}`); }
    CHECK(ok, `${id}: fires without throwing`);
    CHECK(sys.describe().id === id, `${id}: describe() reports the selection`);
  }
}

// ============================================= ToolSystem: cooldown + ammo
{
  const P = paletteWith();
  const ctx = recording(wallWorld(P.wood, 20, 21), P.palette);
  const sys = new ToolSystem(ctx);
  sys.select(TOOL.PISTOL);
  const a = sys.fire(EYE, FWD);
  const b = sys.fire(EYE, FWD);
  CHECK(a.fired && b.fired === false && b.reason === 'cooldown', 'a second shot inside the cooldown is refused');
  sys.update(getTool(TOOL.PISTOL).cooldown + 0.01);
  CHECK(sys.fire(EYE, FWD).fired, 'the shot is allowed once the cooldown has elapsed');
  CHECK(sys.ammoOf(TOOL.PISTOL) === pistol.ammo - 2, 'ammo is spent per shot');

  sys.states[TOOL.PISTOL].ammo = 0;
  sys.states[TOOL.PISTOL].cooldown = 0;
  CHECK(sys.fire(EYE, FWD).reason === 'empty', 'an empty gun refuses to fire');
  sys.reload(TOOL.PISTOL);
  CHECK(sys.ammoOf(TOOL.PISTOL) === pistol.ammo, 'reload refills the magazine');

  // unlimited tools never run dry
  sys.select(TOOL.BLOWTORCH);
  for (let i = 0; i < 200; i++) { sys.states[TOOL.BLOWTORCH].cooldown = 0; sys.fire(EYE, FWD); }
  CHECK(sys.ammoOf(TOOL.BLOWTORCH) === Infinity, 'the blowtorch is unlimited');

  // held trigger drives continuous tools from update(), single-shot tools stay put
  const ctx2 = recording(wallWorld(P.wood, 20, 21), P.palette);
  const sys2 = new ToolSystem(ctx2);
  sys2.select(TOOL.BLOWTORCH);
  sys2.triggerDown(EYE, FWD);
  for (let i = 0; i < 10; i++) sys2.update(0.05);
  const contCuts = ctx2.calls.carveCapsule.length;
  CHECK(contCuts > 5, `a held blowtorch keeps cutting every tick (${contCuts} cuts)`);
  sys2.triggerUp();
  const after = ctx2.calls.carveCapsule.length;
  for (let i = 0; i < 10; i++) sys2.update(0.05);
  CHECK(ctx2.calls.carveCapsule.length === after, 'releasing the trigger stops the cut');

  const ctx3 = recording(wallWorld(P.wood, 20, 21), P.palette);
  const sys3 = new ToolSystem(ctx3);
  sys3.select(TOOL.SLEDGEHAMMER);
  sys3.triggerDown(EYE, FWD);
  for (let i = 0; i < 20; i++) sys3.update(0.05);
  CHECK(ctx3.calls.carveSphere.length === 1, 'a held single-shot tool swings exactly once');
}

// ==================================== missing callbacks must be safely skipped
{
  const P = paletteWith();
  // context with NOTHING but world + palette
  const bare = { world: roomWorld(P.concrete), palette: P.palette, rng: makeRng(3) };
  const sys = new ToolSystem(bare);
  CHECK(sys.missingCallbacks.length === 10, 'the system reports every unwired callback');
  let ok = true;
  try {
    for (const id of TOOL_ORDER) {
      sys.select(id);
      sys.states[id].cooldown = 0;
      sys.fire([1.0, 2.0, 3.0], [1, 0, 0]);
      sys.states[id].cooldown = 0;
      sys.fire([1.0, 2.0, 3.0], [1, 0, 0]);
    }
    for (let i = 0; i < 400; i++) sys.update(0.02);
  } catch (e) { ok = false; console.log(`       ${e.message}`); }
  CHECK(ok, 'every tool runs end to end with no engine callbacks wired at all');

  // and the fallback path still fires: explosions become carve + impulse
  const P2 = paletteWith();
  const partial = recording(roomWorld(P2.concrete), P2.palette, { omit: ['explode'] });
  const sys2 = new ToolSystem(partial);
  sys2.select(TOOL.BOMB);
  sys2.triggerDown([1.0, 2.0, 3.0], [0, -1, 0]);
  for (let t = 0; t < 3.2; t += 0.05) sys2.update(0.05);
  CHECK(partial.calls.carveSphere.some(c => c[5] && c[5].source === 'bomb'),
        'with no explode() wired, the blast falls back to carveSphere');
  CHECK(partial.calls.applyImpulse.some(c => c[6] && c[6].radial),
        'and to a radial impulse');
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
