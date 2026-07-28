// Tests for rubble fragments.
//
// The property that matters is not "debris exists" — it did before — but that what comes
// off a blast is recognisably lumps of the thing that was there, and that those lumps end
// up on the ground rather than quietly ceasing to exist. Both of those were broken in ways
// the previous suite could not see, because it only ever counted particles.

import { VoxelWorld, VOXEL } from '../public/src/voxel/world.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';
import { DebrisSystem } from '../public/src/physics/debris.js';
import { PhysicsWorld } from '../public/src/physics/physics.js';

let fails = 0, checks = 0;
const CHECK = (c, m) => { checks++; if (c) console.log(`[ OK ] ${m}`); else { console.log(`[FAIL] ${m}`); fails++; } };

/** A slab of ground with a brick wall standing on it. */
function scene() {
  const w = new VoxelWorld(64, 64, 64);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const brick = p.add(150, 82, 62, MAT.BRICK);
  const wood = p.add(150, 110, 68, MAT.WOOD);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) { w.setRaw(x, 0, z, rock); w.setRaw(x, 1, z, rock); }
  for (let y = 2; y < 34; y++) for (let z = 10; z < 54; z++) for (let x = 28; x <= 33; x++) w.setRaw(x, y, z, brick);
  w.rebuildMips();
  return { w, p, brick, wood };
}

// ---- a fragment is a block of cells, not a grain
{
  const { w, p } = scene();
  const grains = new PhysicsWorld(w, p, { seed: 3, debrisChunk: 1 });
  grains.explode([3.05, 1.6, 3.2], 1.4, 6.0, {});
  const grainSizes = grains.debris.parts.map(d => d.cells.length);

  const { w: w2, p: p2 } = scene();
  const lumps = new PhysicsWorld(w2, p2, { seed: 3, debrisChunk: 3 });
  lumps.explode([3.05, 1.6, 3.2], 1.4, 6.0, {});
  const lumpSizes = lumps.debris.parts.map(d => d.cells.length);

  CHECK(grainSizes.every(s => s === 1), 'debrisChunk 1 still yields single-voxel chips');
  const mean = lumpSizes.reduce((a, b) => a + b, 0) / Math.max(1, lumpSizes.length);
  CHECK(mean > 4, `debrisChunk 3 yields multi-voxel fragments (mean ${mean.toFixed(1)} voxels)`);
  CHECK(lumpSizes.length < grainSizes.length,
        `and far fewer of them (${lumpSizes.length} fragments vs ${grainSizes.length} grains)`);
  CHECK(Math.max(...lumpSizes) <= 27, `no fragment exceeds the 3x3x3 lattice (max ${Math.max(...lumpSizes)})`);

  // A fragment must be contiguous with its own lattice cell — cells rebased around the
  // centre, so offsets stay small. A large offset means two distant buckets got merged,
  // which is what a hashed key would do.
  const spread = Math.max(...lumps.debris.parts.flatMap(d =>
    d.cells.map(c => Math.max(Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2])))));
  CHECK(spread <= 2, `fragment cells stay within their own lattice cell (max offset ${spread})`);
}

// ---- rubble ends up on the ground instead of vanishing
{
  const { w, p } = scene();
  const ph = new PhysicsWorld(w, p, { seed: 5, debrisChunk: 3 });
  ph.explode([3.05, 1.6, 3.2], 1.6, 7.0, {});
  const airborne = ph.debris.parts.reduce((a, d) => a + d.cells.length, 0);
  CHECK(airborne > 0, `the blast put voxels in the air (${airborne})`);

  for (let i = 0; i < 60 * 8; i++) ph.step(1 / 60);
  const kept = ph.debris.weldedCount;
  CHECK(kept > airborne * 0.6,
        `most of the rubble welds back into the world (${kept}/${airborne}, ${(100 * kept / airborne).toFixed(0)}%)`);
  CHECK(ph.debris.parts.length < 8, `and almost nothing is still in flight (${ph.debris.parts.length})`);
}

// ---- the fragment's collision sphere and weld anchor are at its centre
//
// With both at the minimum corner, a landing fragment tested for contact roughly a voxel
// off and then tried to weld from a cell buried in the floor. It read as "debris fades
// out", which is the one behaviour this whole module exists to avoid.
{
  const w = new VoxelWorld(32, 32, 32);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const brick = p.add(150, 82, 62, MAT.BRICK);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setRaw(x, 0, z, rock);
  w.rebuildMips();

  const d = new DebrisSystem(w, p, { seed: 1 });
  // anchor-relative 3x3x3 block, dropped from height with no sideways velocity
  const cells = [];
  for (let cz = 0; cz < 3; cz++) for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++)
    cells.push([cx, cy, cz, brick]);
  d.spawnChunk(1.6, 2.0, 1.6, 0, 0, 0, cells);

  const part = d.parts[0];
  CHECK(part.cells.length === 27, 'the fragment kept all 27 cells');
  const off = part.cells.map(c => c.slice(0, 3));
  CHECK(off.some(c => c[0] < 0) && off.some(c => c[0] > 0),
        'cells straddle the origin, so the particle position is the fragment centre');
  CHECK(part.radius > VOXEL, `the collision sphere covers the fragment (${(part.radius / VOXEL).toFixed(1)} voxels)`);

  const before = w.countSolid();
  for (let i = 0; i < 60 * 6; i++) d.step(1 / 60);
  const gained = w.countSolid() - before;
  CHECK(gained > 20, `the dropped fragment lands and welds as a block (${gained} voxels added)`);
  CHECK(d.parts.length === 0, 'and is no longer in flight');
}

// ---- a fragment that only partly fits still leaves what it can
//
// Rubble lands on rubble, so a lump of masonry very often has a cell or two inside
// something. Requiring a perfect fit throws the entire fragment away in that case — worth
// about five points of the rubble on a real blast — so the weld keeps whatever fits.
// Driven through weldParticle directly: engineering a wedged landing through the
// integrator would test the integrator, not this rule.
{
  const w = new VoxelWorld(32, 32, 32);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const brick = p.add(150, 82, 62, MAT.BRICK);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setRaw(x, 0, z, rock);
  // a post through the middle of the landing footprint, taller than the upward search
  for (let y = 1; y <= 8; y++) w.setRaw(17, y, 17, rock);
  w.rebuildMips();

  const d = new DebrisSystem(w, p, { seed: 1 });
  const cells = [];
  for (let cz = 0; cz < 3; cz++) for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++)
    cells.push([cx, cy, cz, brick]);
  d.spawnChunk(16 * VOXEL, 1 * VOXEL, 16 * VOXEL, 0, 0, 0, cells);

  const before = w.countSolid();
  const box = d.weldParticle(d.parts[0]);
  const added = w.countSolid() - before;
  CHECK(box !== null, 'a fragment straddling an obstruction still welds');
  CHECK(added >= 20 && added <= 26,
        `it leaves the cells that fit and drops the ones that do not (${added} of 27)`);
  CHECK(w.get(17, 1, 17) === rock, 'the obstruction is not overwritten');
}

// ---- noWeld still means noWeld, for pulverised material
{
  const w = new VoxelWorld(32, 32, 32);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const wood = p.add(150, 110, 68, MAT.WOOD);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setRaw(x, 0, z, rock);
  w.rebuildMips();

  const d = new DebrisSystem(w, p, { seed: 1 });
  const cells = [];
  for (let cz = 0; cz < 2; cz++) for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++)
    cells.push([cx, cy, cz, wood]);
  d.spawnChunk(1.6, 2.0, 1.6, 0, 0, 0, cells, { noWeld: true });
  const before = w.countSolid();
  for (let i = 0; i < 60 * 6; i++) d.step(1 / 60);
  CHECK(w.countSolid() === before, 'a noWeld fragment leaves the world untouched');
  CHECK(d.parts.length === 0, 'and still retires rather than accumulating forever');
}

// ---- fragments tumble in flight and land grid-aligned
{
  const { w, p } = scene();
  const ph = new PhysicsWorld(w, p, { seed: 9, debrisChunk: 3 });
  ph.explode([3.05, 1.6, 3.2], 1.6, 7.0, {});
  const lumps = ph.debris.parts.filter(d => d.cells.length > 1);
  CHECK(lumps.length > 0, `the blast threw multi-voxel fragments (${lumps.length})`);
  CHECK(lumps.every(d => d.q && d.w), 'each fragment carries an orientation and a spin');
  CHECK(lumps.some(d => Math.hypot(d.w[0], d.w[1], d.w[2]) > 0.5),
        'and the spins are not all zero');

  const before = lumps.map(d => d.q.slice());
  for (let i = 0; i < 12; i++) ph.step(1 / 120);
  const turned = lumps.filter((d, i) =>
    Math.abs(d.q[0] - before[i][0]) + Math.abs(d.q[1] - before[i][1]) +
    Math.abs(d.q[2] - before[i][2]) > 1e-4).length;
  CHECK(turned > lumps.length * 0.5, `most fragments actually rotate (${turned}/${lumps.length})`);
  CHECK(lumps.every(d => Math.abs(Math.hypot(d.q[0], d.q[1], d.q[2], d.q[3]) - 1) < 1e-6),
        'orientations stay unit quaternions');

  // Single voxels are cubes; spinning them costs work and changes nothing on screen.
  CHECK(ph.debris.parts.filter(d => d.cells.length === 1).every(d => d.q === null),
        'single-voxel chips carry no orientation at all');

  for (let i = 0; i < 60 * 8; i++) ph.step(1 / 60);
  CHECK(ph.debris.weldedCount > 0, `fragments welded after tumbling (${ph.debris.weldedCount})`);
}

// ---- the landing snap keeps the fragment's shape, in its new orientation
//
// The grid cannot store a bar lying at 37 degrees, so the tumble is rounded to the
// nearest of the 24 axis-aligned orientations. What must survive that is the shape: the
// same number of cells, and the bar pointing whichever way it had turned to — snapping to
// identity instead would make a fragment that landed across the road jump to lie along it.
{
  const w = new VoxelWorld(32, 32, 32);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const brick = p.add(150, 82, 62, MAT.BRICK);
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setRaw(x, 0, z, rock);
  w.rebuildMips();

  const d = new DebrisSystem(w, p, { seed: 1 });
  // a 3x1x1 bar lying along x
  d.spawnChunk(16 * VOXEL, 1 * VOXEL, 16 * VOXEL, 0, 0, 0,
    [[0, 0, 0, brick], [1, 0, 0, brick], [2, 0, 0, brick]]);
  const part = d.parts[0];
  CHECK(part.cells.every(c => c[1] === 0 && c[2] === 0), 'the bar starts along x');

  // a quarter turn about y: sin(45)=cos(45) for a 90 degree rotation quaternion
  const s = Math.SQRT1_2;
  part.q = [0, s, 0, s];
  const before = w.countSolid();
  const box = d.weldParticle(part);
  CHECK(box !== null && w.countSolid() - before === 3,
        `all three cells welded (${w.countSolid() - before})`);
  CHECK(box.z1 - box.z0 === 2 && box.x1 === box.x0,
        `and the bar now lies along z (x span ${box.x1 - box.x0}, z span ${box.z1 - box.z0})`);
}

// ---- determinism: same seed, same rubble
{
  const settle = (seed) => {
    const { w, p } = scene();
    const ph = new PhysicsWorld(w, p, { seed, debrisChunk: 3 });
    ph.explode([3.05, 1.6, 3.2], 1.5, 6.5, {});
    for (let i = 0; i < 60 * 5; i++) ph.step(1 / 60);
    return `${w.countSolid()}:${ph.debris.weldedCount}:${ph.bodies.length}`;
  };
  CHECK(settle(11) === settle(11), 'the same seed produces byte-identical rubble');
  CHECK(settle(11) !== settle(12), 'and a different seed does not');
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
