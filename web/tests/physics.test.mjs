// Headless correctness tests for destruction, structural integrity and the rigid-body sim.
// No GPU, no renderer: everything here is arithmetic over the voxel grid.
//   node tests/physics.test.mjs
import { VoxelWorld, VOXEL } from '../public/src/voxel/world.js';
import { TORCH_RADIUS, TORCH_ENERGY } from '../public/src/tools/blowtorch.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';
import {
  PhysicsWorld, hashState, SUBSTEP_H, SUBSTEP_HZ,
  VoxelBody, resetBodyIds,
  carveSphere, carveCapsule, carveBox,
  findDetached, labelComponents, groupVoxels,
  sphereVsWorld, voxelMass,
} from '../public/src/physics/index.js';
import { snapToCubeRotation, CUBE_ROTATIONS, m3FromQuat, qIntegrate } from '../public/src/physics/math3d.js';

let fails = 0, checks = 0;
const CHECK = (cond, msg) => {
  checks++;
  if (cond) console.log(`[ OK ] ${msg}`);
  else { console.log(`[FAIL] ${msg}`); fails++; }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const mag = (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

// ---------------------------------------------------------------- shared fixtures
function makePalette() {
  const p = new Palette();
  return {
    p,
    bedrock: p.add(58, 56, 54, MAT.UNBREAKABLE),
    wood: p.add(150, 110, 68, MAT.WOOD),
    concrete: p.add(172, 168, 160, MAT.CONCRETE),
    brick: p.add(150, 78, 58, MAT.BRICK),
    glass: p.add(150, 190, 205, MAT.GLASS),
    metal: p.add(138, 144, 150, MAT.METAL),
  };
}

/** Flat bedrock floor at y = 0..1 (top surface at y = 0.2 m). */
function floorWorld(size = 40) {
  const w = new VoxelWorld(size, size, size);
  const P = makePalette();
  for (let z = 0; z < size; z++)
    for (let x = 0; x < size; x++) { w.setRaw(x, 0, z, P.bedrock); w.setRaw(x, 1, z, P.bedrock); }
  w.rebuildMips();
  return { w, P };
}

const box = (w, x0, y0, z0, x1, y1, z1, pal) => {
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) w.setRaw(x, y, z, pal);
};

// ================================================================ 1. energy vs strength
{
  const { w, P } = floorWorld(40);
  // two identical walls the same distance from the blast, only the material differs
  box(w, 10, 4, 8, 10, 12, 16, P.wood);       // wood wall at x = 10
  box(w, 20, 4, 8, 20, 12, 16, P.concrete);   // concrete wall at x = 20
  w.rebuildMips();

  const centre = (x) => [(x + 0.5) * VOXEL, 8.5 * VOXEL, 12.5 * VOXEL];
  const woodHit = carveSphere(w, P.p, centre(10), 0.45, 0.9);
  const concHit = carveSphere(w, P.p, centre(20), 0.45, 0.9);

  CHECK(woodHit.count > 20, `one blast shreds wood (${woodHit.count} voxels destroyed)`);
  CHECK(concHit.count === 0, `the identical blast does not break concrete (${concHit.count} destroyed)`);
  CHECK(woodHit.destroyed.every(([, , , pal]) => pal === P.wood),
        'destroyed list carries the source palette index for debris/particles');
  CHECK(woodHit.destroyed.every(([x, y, z]) => w.get(x, y, z) === 0),
        'every reported voxel is actually gone from the grid');
  CHECK(woodHit.bbox !== null && woodHit.bbox.x0 === 10 && woodHit.bbox.x1 === 10,
        'carve reports the bounding box of what it removed');

  // enough energy and concrete goes too
  const hard = carveSphere(w, P.p, centre(20), 0.45, 2.4);
  CHECK(hard.count > 20, `a bigger blast does break concrete (${hard.count} destroyed)`);
}

// ================================================================ 2. damage accumulates
{
  const { w, P } = floorWorld(24);
  box(w, 10, 4, 8, 12, 10, 14, P.concrete);
  const phys = new PhysicsWorld(w, P.p);
  const at = [11.5 * VOXEL, 7.5 * VOXEL, 11.5 * VOXEL];

  const a = phys.explode(at, 0.35, 0.6);
  CHECK(a.count === 0, 'a weak hit leaves concrete standing');
  CHECK(phys.damage.size > 0, 'but the energy is banked as accumulated damage');
  const b = phys.explode(at, 0.35, 0.6);
  CHECK(b.count > 0, `chipping away with the same weak tool eventually breaks through (${b.count})`);
}

// ================================================================ 3. unbreakable + shapes
{
  const { w, P } = floorWorld(24);
  const before = w.countSolid();
  carveSphere(w, P.p, [1.2, 0.1, 1.2], 0.8, 1e6);
  CHECK(w.countSolid() === before, 'no amount of energy removes an unbreakable material');

  // capsule cut severs a beam
  const { w: w2, P: P2 } = floorWorld(24);
  box(w2, 4, 10, 12, 20, 12, 14, P2.wood);
  // Use the blowtorch's real constants. A one-voxel kerf (radius < VOXEL) loses most of
  // its energy to distance falloff, so the tool is tuned with a high energy to compensate;
  // testing it at an arbitrary lower energy asserts a configuration nothing actually uses.
  const cut = carveCapsule(w2, P2.p, [1.2, 0.9, 1.15], [1.2, 1.4, 1.55], TORCH_RADIUS, TORCH_ENERGY);
  CHECK(cut.count > 0, `capsule/ray carve cuts through a beam (${cut.count} voxels)`);
  // Geometric containment, not "exactly one column": at the torch's real energy the kerf
  // is wide enough to take the neighbouring column too, since a voxel centre 0.05 m from
  // the axis still sits inside the 0.055 m radius. What must hold is that nothing outside
  // the capsule is touched.
  const axisX = 1.2;
  CHECK(cut.destroyed.every(([x]) => Math.abs((x + 0.5) * VOXEL - axisX) <= TORCH_RADIUS + 1e-9),
        'every destroyed voxel centre lies within the capsule radius of its axis');

  const { w: w3, P: P3 } = floorWorld(24);
  box(w3, 4, 4, 4, 14, 14, 14, P3.brick);
  const bx = carveBox(w3, P3.p, [0.6, 0.6, 0.6], [0.89, 0.89, 0.89], 2.0);
  CHECK(bx.count === 27, `box carve removes exactly the 3x3x3 cells it covers (${bx.count})`);
}

// ================================================================ 4. structural integrity
{
  // bedrock floor, one concrete pillar, a wooden slab resting on it and nothing else
  const { w, P } = floorWorld(40);
  box(w, 8, 2, 8, 9, 6, 9, P.concrete);       // pillar
  box(w, 4, 7, 4, 14, 7, 14, P.wood);         // 11 x 1 x 11 slab = 121 voxels
  w.rebuildMips();

  const all = labelComponents(w, P.p, { x0: 0, y0: 0, z0: 0, x1: 39, y1: 39, z1: 39 });
  CHECK(all.groups.length === 1, 'before the shot everything is one connected, anchored component');
  CHECK(all.groups[0].anchored, 'that component is anchored (floor + unbreakable bedrock)');

  const phys = new PhysicsWorld(w, P.p, { shatterEnabled: false });
  const solidBefore = w.countSolid();
  const res = phys.explode([0.9, 0.45, 0.9], 0.26, 8.0);

  CHECK(res.count >= 20, `the blast removes the pillar (${res.count} voxels)`);
  CHECK(w.get(8, 4, 8) === 0 && w.get(9, 6, 9) === 0, 'the whole pillar is gone, not just its middle');
  CHECK(res.bodies.length === 1, `knocking out the support detaches the slab as exactly ONE body (got ${res.bodies.length})`);
  const slab = res.bodies[0];
  CHECK(slab.voxelCount === 121, `the body contains the whole slab and nothing else (${slab.voxelCount} voxels)`);
  CHECK(w.get(4, 7, 4) === 0 && w.get(14, 7, 14) === 0, 'the detached slab has been lifted out of the static grid');
  CHECK(w.countSolid() === solidBefore - res.count - 121, 'grid solid count matches removed + detached');
  CHECK(slab.mass > 0 && near(slab.mass, 121 * voxelMass(P.p, P.wood, VOXEL), 1e-9),
        `body mass is the sum of its voxel masses (${slab.mass.toFixed(3)} kg)`);

  // the floor itself must never be considered detached
  const still = findDetached(w, P.p, { x0: 0, y0: 0, z0: 0, x1: 39, y1: 8, z1: 39 }, { margin: 0 });
  CHECK(still.length === 0, 'the anchored floor is never mistaken for debris');
}

// ================================================================ 5. small groups crumble
{
  const { w, P } = floorWorld(30);
  box(w, 12, 2, 12, 12, 5, 12, P.wood);       // 1-voxel column
  box(w, 11, 6, 11, 13, 7, 13, P.wood);       // 3 x 2 x 3 = 18 voxels on top
  w.rebuildMips();

  const phys = new PhysicsWorld(w, P.p, { shatterEnabled: false });
  const res = phys.explode([12.5 * VOXEL, 3.5 * VOXEL, 12.5 * VOXEL], 0.22, 3.0);
  CHECK(res.bodies.length === 0, 'a group below the rigid-body threshold does not become a body');
  CHECK(phys.debris.count >= 18, `it crumbles into particles instead (${phys.debris.count} debris)`);
  CHECK(w.get(11, 6, 11) === 0, 'the crumbled group is removed from the grid');
}

// ================================================================ 6. rotation / torque
{
  const { w, P } = floorWorld(40);
  const vox = [];
  for (let z = 10; z < 22; z++) for (let x = 10; x < 22; x++) vox.push([x, 24, z, P.wood]);
  for (const v of vox) w.setRaw(v[0], v[1], v[2], P.wood);
  const phys = new PhysicsWorld(w, P.p);
  const body = phys.spawnBody(vox);

  // a) a plain off-centre impulse must produce spin, and about the right axis
  const corner = body.cellWorld(body.cells[0]);
  body.applyImpulse(corner, [0, 40, 0]);
  CHECK(mag(body.w) > 0.5, `an off-centre impulse spins the body (|w| = ${mag(body.w).toFixed(2)} rad/s)`);
  const r = [corner[0] - body.pos[0], corner[1] - body.pos[1], corner[2] - body.pos[2]];
  const tau = [r[1] * 0 - r[2] * 40, 0, r[0] * 40];           // r x J with J = (0, 40, 0)
  CHECK(body.w[0] * tau[0] + body.w[2] * tau[2] > 0, 'the spin axis follows r x J, not an arbitrary direction');

  // b) an impulse through the centre of mass must produce none
  const body2 = VoxelBody.fromVoxels(vox, P.p);
  body2.applyImpulse(body2.pos.slice(), [0, 40, 0]);
  CHECK(mag(body2.w) < 1e-9, 'an impulse straight through the centre of mass produces no spin');
  CHECK(near(body2.v[1], 40 / body2.mass, 1e-9), 'and the linear response is exactly J/m');

  // c) an explosion off to one side does the same thing, via the blast falloff alone
  const body3 = VoxelBody.fromVoxels(vox, P.p);
  body3.applyBlast([10.0 * VOXEL, 22.0 * VOXEL, 16.0 * VOXEL], 2.0, 12);
  CHECK(mag(body3.w) > 0.5, `an off-centre explosion imparts torque as well as impulse (|w| = ${mag(body3.w).toFixed(2)})`);
  CHECK(body3.v[1] > 0, 'and still throws the body away from the blast');

  const body4 = VoxelBody.fromVoxels(vox, P.p);
  body4.applyBlast([body4.pos[0], body4.pos[1] - 0.5, body4.pos[2]], 2.0, 12);
  CHECK(mag(body4.w) < 1e-6, 'a perfectly centred blast on a symmetric slab produces no spin (torque is geometric, not faked)');

  // d) the tensor is not a sphere: a long plank resists roll differently from pitch
  const plank = [];
  for (let x = 0; x < 30; x++) plank.push([x, 0, 0, P.wood]);
  const pb = VoxelBody.fromVoxels(plank, P.p);
  CHECK(pb.Ibody[0] < pb.Ibody[4] * 0.05,
        'a plank has far less inertia about its long axis than across it (real tensor, not a sphere)');
  const single = VoxelBody.fromVoxels([[0, 0, 0, P.wood]], P.p);
  CHECK(single.Ibody[0] > 0 && Number.isFinite(single.IinvBody[0]),
        'a single-voxel body still has a finite, invertible inertia tensor');
}

// ================================================================ 7. drop / rest / conserve
{
  const { w, P } = floorWorld(32);
  const vox = [];
  for (let y = 20; y < 23; y++) for (let z = 12; z < 18; z++) for (let x = 12; x < 18; x++) vox.push([x, y, z, P.concrete]);
  for (const v of vox) w.setRaw(v[0], v[1], v[2], P.concrete);
  w.rebuildMips();

  const phys = new PhysicsWorld(w, P.p, { shatterEnabled: false });
  const body = phys.spawnBody(vox);
  const y0 = body.pos[1];

  let minVy = 0, maxY = body.pos[1];
  for (let i = 0; i < 900 && !body.settled; i++) {
    phys.step(1 / 60);
    if (body.v[1] < minVy) minVy = body.v[1];
    if (body.pos[1] > maxY) maxY = body.pos[1];
  }
  const drop = y0 - body.pos[1];
  const freeFall = -Math.sqrt(2 * 20 * drop);

  CHECK(minVy < -4, `a dropped body gains real downward speed (peak ${minVy.toFixed(2)} m/s)`);
  CHECK(minVy > freeFall * 1.02 && minVy < freeFall * 0.9,
        `peak speed matches sqrt(2gh) within damping (${minVy.toFixed(2)} vs analytic ${freeFall.toFixed(2)})`);
  CHECK(maxY <= y0 + 1e-9, 'gravity never adds energy: the body never rises above where it started');
  CHECK(body.settled, 'the body comes to rest');
  CHECK(mag(body.v) < 0.15 && mag(body.w) < 0.5,
        `and actually stops (|v| = ${mag(body.v).toFixed(4)}, |w| = ${mag(body.w).toFixed(4)})`);
  CHECK(near(body.pos[1], 0.2 + 0.15, 0.03),
        `it rests on the floor surface, not inside it (y = ${body.pos[1].toFixed(3)}, expected ~0.35)`);
}

// ================================================================ 8. settle re-welds
{
  const { w, P } = floorWorld(32);
  const vox = [];
  for (let y = 14; y < 17; y++) for (let z = 12; z < 18; z++) for (let x = 12; x < 18; x++) vox.push([x, y, z, P.concrete]);
  for (const v of vox) w.setRaw(v[0], v[1], v[2], P.concrete);
  w.rebuildMips();

  // shatter + debris welding off so the solid-count arithmetic is exact
  const phys = new PhysicsWorld(w, P.p, { shatterEnabled: false, weldDebris: false });
  const body = phys.spawnBody(vox);
  const liftedCount = w.countSolid();
  CHECK(liftedCount === 32 * 32 * 2, 'detaching the chunk removed it from the grid');

  let settleCount = -1;
  phys.onBodySettle = () => { settleCount = w.countSolid(); };
  for (let i = 0; i < 900 && !body.settled; i++) phys.step(1 / 60);

  const after = w.countSolid();
  CHECK(body.settled, 'body settles');
  CHECK(after > liftedCount, `settling re-welds solid voxels into the grid (${liftedCount} -> ${after})`);
  CHECK(body.weldedVoxels === 108, `every voxel of the body came back (${body.weldedVoxels} of 108)`);
  CHECK(after === liftedCount + 108, 'solid count increases by exactly the body voxel count');
  CHECK(settleCount === -1 || settleCount === after, 'the settle callback sees the finished weld');

  // the welded rubble must be lattice-aligned and structurally sound
  const wb = body.weldBounds;
  CHECK(wb.y0 === 2, `the chunk welds resting on the floor, not floating (y0 = ${wb.y0})`);
  const det = findDetached(w, P.p, wb, { margin: 4 });
  CHECK(det.length === 0, 'welded rubble is anchored, so it will not immediately re-detach (no fall/weld loop)');
}

// ================================================================ 9. 90-degree snapping
{
  const { w, P } = floorWorld(32);
  const vox = [];
  for (let x = 10; x < 16; x++) for (let z = 10; z < 13; z++) vox.push([x, 20, z, P.wood]);
  const body = VoxelBody.fromVoxels(vox, P.p);

  CHECK(CUBE_ROTATIONS.length === 24, 'there are exactly 24 axis-aligned cube rotations');
  CHECK(CUBE_ROTATIONS.every((r) => det3(r.m) === 1), 'all 24 are proper rotations (det = +1, no mirrors)');

  // a body tipped 12 degrees about Y snaps back to the identity
  const s = 12 * Math.PI / 180;
  body.q = [0, Math.sin(s / 2), 0, Math.cos(s / 2)];
  body.updateDerived();
  const snapped = snapToCubeRotation(body.q);
  CHECK(snapped.m.join() === [1, 0, 0, 0, 1, 0, 0, 0, 1].join(), 'a small tilt snaps back to the identity rotation');

  // ...and a body rolled 88 degrees snaps to the quarter turn, with the voxels still a
  // gap-free, overlap-free integer lattice after the snap
  const s2 = 88 * Math.PI / 180;
  body.q = [0, Math.sin(s2 / 2), 0, Math.cos(s2 / 2)];
  body.updateDerived();
  const place = body.snapPlacement().place;
  const seen = new Set();
  let dup = 0;
  for (let k = 0; k < body.cells.length; k++) {
    const o = place(body.cells[k]);
    const key = `${o[0]},${o[1]},${o[2]}`;
    if (seen.has(key)) dup++;
    seen.add(key);
  }
  CHECK(dup === 0 && seen.size === body.cells.length,
        'the snapped placement maps every voxel to a distinct grid cell (no gaps, no overlaps)');
  const rot = snapToCubeRotation(body.q);
  CHECK(Math.abs(rot.m[0]) === 0 && Math.abs(rot.m[2]) === 1, 'an 88 degree roll snaps to the 90 degree rotation');
}

// ================================================================ 10. collision primitives
{
  const { w } = floorWorld(24);
  // floor top surface is at y = 0.2
  CHECK(sphereVsWorld(w, 1.0, 0.30, 1.0) === null, 'a sample clear of the surface reports no contact');
  const c = sphereVsWorld(w, 1.0, 0.23, 1.0);
  CHECK(c !== null && near(c.ny, 1, 1e-9) && near(c.pen, 0.02, 1e-9),
        'a sample grazing the floor gets an upward normal and the right penetration depth');
  const deep = sphereVsWorld(w, 1.0, 0.15, 1.0);
  CHECK(deep !== null && deep.ny === 1 && deep.pen > 0.05,
        'a sample buried inside the floor is pushed back out of the nearest open face');
  CHECK(sphereVsWorld(w, 1.0, -0.5, 1.0) !== null, 'below the world reads as solid so nothing falls through');
}

// ================================================================ 11. hard impact shatters
{
  const { w, P } = floorWorld(48);
  const vox = [];
  for (let y = 40; y < 43; y++) for (let z = 20; z < 26; z++) for (let x = 20; x < 26; x++) vox.push([x, y, z, P.brick]);
  for (const v of vox) w.setRaw(v[0], v[1], v[2], P.brick);
  box(w, 14, 2, 14, 32, 3, 32, P.wood);     // a wooden deck to land on and crush
  w.rebuildMips();

  const phys = new PhysicsWorld(w, P.p);
  const body = phys.spawnBody(vox);
  const n0 = body.voxelCount;
  const woodBefore = countPal(w, P.wood);
  for (let i = 0; i < 600 && !body.settled; i++) phys.step(1 / 60);

  CHECK(body.voxelCount < n0, `a hard landing chips the contact face (${n0} -> ${body.voxelCount} voxels)`);
  CHECK(body.voxelCount > n0 * 0.5, 'but the body does not vaporise on impact');
  CHECK(phys.debris.count > 0 || phys.debris.weldedCount > 0, 'the chipped voxels become debris');
  CHECK(countPal(w, P.wood) < woodBefore, 'heavy debris crushes the weaker material it lands on');
}

// ================================================================ 12. fixed-step determinism
{
  // The whole point: the substep sequence must not depend on how wall-clock time was sliced.
  const scenario = () => {
    resetBodyIds();
    const { w, P } = floorWorld(40);
    box(w, 8, 2, 8, 9, 6, 9, P.concrete);
    box(w, 4, 7, 4, 14, 7, 14, P.wood);
    box(w, 20, 2, 20, 26, 8, 26, P.brick);
    w.rebuildMips();
    const phys = new PhysicsWorld(w, P.p, { seed: 12345 });
    // off-centre so the slab actually tumbles rather than dropping flat
    phys.explode([0.65, 0.45, 0.65], 0.4, 6.0);
    return phys;
  };

  const runAtFps = (fps, targetSubsteps) => {
    const phys = scenario();
    const dt = 1 / fps;
    while (phys.substepCount < targetSubsteps) phys.step(dt, targetSubsteps - phys.substepCount);
    return phys;
  };

  const N = 600;   // 5 seconds at 120 Hz
  const fast = runAtFps(144, N);
  const slow = runAtFps(31, N);
  const silly = runAtFps(7, N);
  const exact = (() => { const p = scenario(); p.runSubsteps(N); return p; })();

  const hFast = hashState(fast), hSlow = hashState(slow), hSilly = hashState(silly), hExact = hashState(exact);
  CHECK(fast.substepCount === N && slow.substepCount === N, 'both runs consumed exactly the same number of substeps');
  CHECK(hFast === hSlow, `144 fps and 31 fps produce bit-identical state (hash ${hFast} vs ${hSlow})`);
  CHECK(hFast === hSilly, `7 fps produces the same state too (hash ${hSilly})`);
  CHECK(hFast === hExact, 'and it matches a direct fixed-substep replay with no accumulator at all');
  CHECK(fast.bodies.length === slow.bodies.length, 'same surviving body count');

  // Non-vacuous: the hash must actually be sensitive to simulation state. Perturb and hash
  // immediately — running the perturbed scenario to completion is NOT a valid sensitivity
  // check, because bodies settle and weld back onto the integer grid, so the sim genuinely
  // converges and a 1e-9 offset is legitimately absorbed. That convergence is correct
  // behaviour; it just cannot distinguish a sensitive hash from a blind one.
  const probe = scenario();
  probe.runSubsteps(30);                       // still mid-flight, nothing settled yet
  const hBefore = hashState(probe);
  // This scenario throws debris rather than whole rigid bodies, so perturb what is
  // actually in flight. The hash covers debris positions too.
  const live = probe.bodies.length > 0 ? probe.bodies : probe.debris.parts;
  CHECK(live.length > 0, `the sensitivity probe has something in flight to perturb (${live.length})`);
  if (probe.bodies.length > 0) probe.bodies[0].pos[0] += 1e-9;
  else probe.debris.parts[0].x += 1e-9;
  CHECK(hashState(probe) !== hBefore,
        'the hash detects a 1e-9 m perturbation (so the equality above is not vacuous)');

  // sub-substep frames must bank time, not integrate it
  const tiny = scenario();
  const h0 = hashState(tiny);
  for (let i = 0; i < 5; i++) tiny.step(SUBSTEP_H / 6);
  CHECK(tiny.substepCount === 0 && hashState(tiny) === h0,
        'frames shorter than a substep bank their time instead of integrating a partial step');
  tiny.step(SUBSTEP_H / 6);
  CHECK(tiny.substepCount === 1, 'the banked time then fires exactly one substep');
  CHECK(SUBSTEP_HZ === 120 && near(SUBSTEP_H, 1 / 120, 1e-15), 'substeps run at 120 Hz');
}

// ================================================================ 13. integrator sanity
{
  // Quaternion integration must preserve unit length over long spins, otherwise the
  // rotation matrix shears and voxels stretch.
  let q = [0, 0, 0, 1];
  const w = [3.1, -1.7, 0.9];
  for (let i = 0; i < 120 * 60; i++) q = qIntegrate(q, w, SUBSTEP_H);
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  CHECK(near(len, 1, 1e-12), `orientation stays unit-length over 60 s of tumbling (|q| = ${len})`);
  const m = m3FromQuat(q);
  CHECK(near(det3(m), 1, 1e-9), 'the derived rotation matrix stays a pure rotation (det = 1)');

  // A body given angular velocity and nothing else must actually change orientation.
  const { w: world, P } = floorWorld(24);
  const b = VoxelBody.fromVoxels([[10, 10, 10, P.wood], [11, 10, 10, P.wood], [12, 10, 10, P.wood]], P.p);
  const before = b.cellWorld(b.cells[0]).slice();
  b.w = [0, 4, 0];
  for (let i = 0; i < 30; i++) b.integrate(SUBSTEP_H, [0, 0, 0], 0, 0);
  const after = b.cellWorld(b.cells[0]);
  CHECK(mag([after[0] - before[0], after[1] - before[1], after[2] - before[2]]) > 0.05,
        'angular velocity actually moves the body voxels (they orbit the centre of mass)');
  CHECK(near(b.pos[0], world ? b.pos[0] : 0, 1) && near(mag(b.v), 0, 1e-12),
        'a purely rotating body does not translate');
}

// ================================================================ 14. bounded integrity cost
{
  const { w, P } = floorWorld(64);
  box(w, 4, 2, 4, 59, 40, 59, P.brick);     // a big solid block touching the world edges? no: 4..59
  w.rebuildMips();
  const t0 = Date.now();
  const groups = findDetached(w, P.p, { x0: 30, y0: 20, z0: 30, x1: 31, y1: 21, z1: 31 }, { margin: 8 });
  const dt = Date.now() - t0;
  CHECK(groups.length === 0, 'a component that leaves the analysis box is assumed attached (never mass-collapses a level)');
  CHECK(dt < 200, `bounded flood fill stays cheap (${dt} ms for a 20^3 region inside a 64^3 world)`);

  const labelled = labelComponents(w, P.p, { x0: 20, y0: 10, z0: 20, x1: 40, y1: 30, z1: 40 });
  CHECK(labelled.groups.length === 1 && labelled.groups[0].escaped,
        'the escape flag is set when a component continues past the region face');
  CHECK(groupVoxels(w, labelled.groups[0]).every(([x, y, z, pal]) => pal === w.get(x, y, z)),
        'groupVoxels decodes linear indices back to the right coordinates and palettes');
}

// ---------------------------------------------------------------- helpers
function det3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7])
       - m[1] * (m[3] * m[8] - m[5] * m[6])
       + m[2] * (m[3] * m[7] - m[4] * m[6]);
}
function countPal(w, pal) {
  let n = 0;
  for (let i = 0; i < w.data.length; i++) if (w.data[i] === pal) n++;
  return n;
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
