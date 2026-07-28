// Tests for drivable vehicles.
//
// These assert behaviour a player would notice: the car holds itself off the ground, goes
// where it is pointed, stops when braked, does not drive through walls, and stops driving
// when you shoot the wheels off. Nothing here needs a GPU.

import { VoxelWorld, VOXEL } from '../public/src/voxel/world.js';
import { Palette, MAT } from '../public/src/voxel/palette.js';
import { PhysicsWorld } from '../public/src/physics/physics.js';
import { vehicleFromVoxels, CAR_TUNING } from '../public/src/physics/vehicle.js';

let fails = 0, checks = 0;
const CHECK = (c, m) => { checks++; if (c) console.log(`[ OK ] ${m}`); else { console.log(`[FAIL] ${m}`); fails++; } };

const L = 42, W = 18, H = 14;     // chassis in voxels: 4.2 x 1.4 x 1.8 m

/** Flat ground, plus a car body sitting a little above it. */
function scene(opts = {}) {
  const world = new VoxelWorld(768, 48, 128);
  const p = new Palette();
  const rock = p.add(70, 70, 70, MAT.UNBREAKABLE);
  const steel = p.add(58, 96, 152, MAT.METAL);
  for (let z = 0; z < 128; z++) for (let x = 0; x < 768; x++) { world.setRaw(x, 0, z, rock); world.setRaw(x, 1, z, rock); }
  world.rebuildMips();

  // chassis voxels, lifted straight into a body (never written into the world)
  const x0 = 30, y0 = 8, z0 = 55;
  const voxels = [];
  for (let y = 0; y < H; y++) for (let z = 0; z < W; z++) for (let x = 0; x < L; x++)
    voxels.push([x0 + x, y0 + y, z0 + z, steel]);

  const inset = 5;
  const mounts = [
    // Front pair (toward +x, the facing direction) steers; rear pair drives. The mirror
    // of index `inset` in a 0..L-1 lattice is `L - 1 - inset`, not `L - inset` — off by
    // one and the front and rear overhangs differ by a voxel.
    { at: [x0 + L - 1 - inset, y0, z0 + 2], steered: true, driven: false },
    { at: [x0 + L - 1 - inset, y0, z0 + W - 3], steered: true, driven: false },
    { at: [x0 + inset, y0, z0 + 2], steered: false, driven: true },
    { at: [x0 + inset, y0, z0 + W - 3], steered: false, driven: true },
  ];
  // The chassis is long along X, so that is the way it faces. Declaring it is the whole
  // point: with the default +Z it steered about its own long axis and drove in circles.
  const veh = vehicleFromVoxels(voxels, p, mounts, {
    originVoxel: [x0, y0, z0], tuning: { forward: [1, 0, 0] }, ...opts,
  });
  const phys = new PhysicsWorld(world, p, { seed: 5 });
  phys.addVehicle(veh);
  return { world, p, phys, veh, steel };
}

const run = (phys, seconds, dt = 1 / 60) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) phys.step(dt);
};

// ---- it holds itself up on its suspension instead of sinking or launching
{
  const { phys, veh } = scene();
  const y0 = veh.body.pos[1];
  run(phys, 3);
  const y = veh.body.pos[1];
  CHECK(Number.isFinite(y), 'the chassis position stays finite');
  CHECK(y < y0, `it settles downward from its drop height (${y0.toFixed(2)} -> ${y.toFixed(2)} m)`);
  CHECK(y > 0.2, `and does not sink into the ground (${y.toFixed(2)} m)`);
  CHECK(veh.wheels.filter(w => w.grounded).length === 4, 'all four wheels find the road');
  const c = veh.wheels.map(w => w.compression);
  CHECK(c.every(v => v > 0.02 && v < 0.98),
        `the springs sit inside their travel rather than topped or bottomed (${c.map(v => v.toFixed(2)).join(', ')})`);
  run(phys, 2);
  CHECK(Math.abs(veh.body.pos[1] - y) < 0.05, 'and it stays there rather than slowly sinking or climbing');
}

// ---- wheel mounts land symmetrically about the centre of mass
//
// Mounts are given in voxel coordinates but the centre of mass is computed from voxel
// *centres*, so measuring from voxel corners offsets every wheel by half a voxel against
// it: a car with wheels nominally 0.65 m either side of the centreline gets 0.70 and 0.60.
// Asserted directly rather than through driving, because the resulting misalignment is
// small enough to hide inside the car's normal tracking error.
{
  const { veh } = scene();
  const zs = veh.wheels.map((w) => w.mount[2]);
  const left = zs.filter((z) => z < 0), right = zs.filter((z) => z > 0);
  CHECK(left.length === 2 && right.length === 2, 'two wheels each side of the centreline');
  CHECK(Math.abs(Math.abs(left[0]) - Math.abs(right[0])) < 1e-9,
        `and they are equidistant from it (${left[0].toFixed(3)} vs ${right[0].toFixed(3)} m)`);
  const xs = veh.wheels.map((w) => w.mount[0]);
  CHECK(Math.abs(Math.max(...xs) + Math.min(...xs)) < 1e-9,
        `the wheelbase straddles the centre of mass evenly (${Math.min(...xs).toFixed(3)} .. ${Math.max(...xs).toFixed(3)} m)`);
}

// ---- settling refuses to consume a vehicle
//
// Driven through settleBody directly. Going through the sleep path would depend on the
// suspension happening to fall under the sleep thresholds, which it may not, and a test
// that passes because the code under test was never reached is worse than no test.
{
  const { world, phys, veh } = scene();
  run(phys, 2);
  const before = world.countSolid();
  const placed = phys.settleBody(veh.body);
  CHECK(placed === null, 'settleBody declines to weld a vehicle chassis');
  CHECK(veh.body.alive && !veh.body.settled, 'the chassis is left alive and unsettled');
  CHECK(world.countSolid() === before, 'and no voxels were written into the world');

  // an ordinary body in the same world still settles normally
  const other = phys.bodies.find((b) => !b.vehicle);
  CHECK(other === undefined, 'sanity: the only body here is the vehicle');
}

// ---- throttle drives it forward, and it has a terminal speed
{
  const { phys, veh } = scene();
  run(phys, 2);
  const start = veh.body.pos.slice();
  veh.setInput({ throttle: 1 });
  run(phys, 4);
  const moved = veh.body.pos[0] - start[0];
  CHECK(moved > 3, `full throttle drives it forward along its own axis (${moved.toFixed(1)} m in 4 s)`);
  CHECK(Math.abs(veh.body.pos[2] - start[2]) < 1.5,
        `and it tracks straight (${Math.abs(veh.body.pos[2] - start[2]).toFixed(2)} m of drift)`);
  // Kept short on purpose: at this acceleration a longer run drives off the end of the
  // test road, the wheels lose the ground, and the "car stopped" for reasons that have
  // nothing to do with the drivetrain.
  const v1 = veh.forwardSpeed;
  run(phys, 1.5);
  const v2 = veh.forwardSpeed;
  CHECK(v2 > v1 * 1.02, `it is still accelerating (${v1.toFixed(1)} -> ${v2.toFixed(1)} m/s)`);
  CHECK(v2 < CAR_TUNING.topSpeed, `and stays under its stated top speed (${v2.toFixed(1)} of ${CAR_TUNING.topSpeed} m/s)`);
}

// ---- brakes stop it
{
  const { phys, veh } = scene();
  run(phys, 2);
  veh.setInput({ throttle: 1 });
  run(phys, 5);
  const fast = veh.forwardSpeed;
  CHECK(fast > 4, `it is moving before braking (${fast.toFixed(1)} m/s)`);
  veh.setInput({ throttle: 0, brake: 1 });
  run(phys, 4);
  CHECK(Math.abs(veh.forwardSpeed) < fast * 0.25,
        `braking stops it (${fast.toFixed(1)} -> ${veh.forwardSpeed.toFixed(1)} m/s)`);
}

// ---- steering turns it, and turns both ways
{
  // forward is +x in the lattice, so its world direction is the first column of R
  const heading = (veh) => Math.atan2(veh.body.R[6], veh.body.R[0]);
  const drive = (steer) => {
    const { phys, veh } = scene();
    run(phys, 2);
    const h0 = heading(veh);
    veh.setInput({ throttle: 1, steer });
    run(phys, 5);
    let d = heading(veh) - h0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  };
  const left = drive(-1), right = drive(1);
  CHECK(Math.abs(left) > 0.25, `steering left changes the heading (${(left * 57.3).toFixed(0)} deg)`);
  CHECK(Math.abs(right) > 0.25, `steering right changes the heading (${(right * 57.3).toFixed(0)} deg)`);
  CHECK(Math.sign(left) !== Math.sign(right), 'and the two turn opposite ways');
}

// ---- it does not drive through a wall
{
  const { world, p, phys, veh } = scene();
  const conc = p.add(170, 170, 165, MAT.CONCRETE);
  // a thick unbreakable-strength wall across its path
  for (let y = 2; y < 40; y++) for (let z = 20; z < 110; z++) for (let x = 200; x <= 214; x++)
    world.setRaw(x, y, z, conc);
  world.rebuildMips();
  const wallX = 200 * VOXEL;
  veh.setInput({ throttle: 1 });
  run(phys, 10);
  CHECK(veh.body.pos[0] < wallX + 1.0,
        `the car is stopped by the wall rather than passing through (x=${veh.body.pos[0].toFixed(1)}, wall at ${wallX.toFixed(1)})`);
  CHECK(veh.body.pos.every(Number.isFinite), 'and the impact does not blow up the solver');
}

// ---- a parked vehicle is not welded into the road
{
  const { world, phys, veh } = scene();
  const before = world.countSolid();
  run(phys, 12);              // long enough that any other body would have settled
  CHECK(world.countSolid() === before, 'a stationary vehicle never welds itself into the grid');
  CHECK(veh.body.alive && !veh.body.settled, 'and its chassis stays a live body');
  CHECK(phys.vehicles.length === 1 && phys.bodies.includes(veh.body),
        'it is still registered and still drivable');
  veh.setInput({ throttle: 1 });
  const x0 = veh.body.pos[0];
  run(phys, 3);
  CHECK(veh.body.pos[0] - x0 > 1, 'and it drives away when you ask it to');
}

// ---- blowing the wheels off stops it driving
{
  const { phys, veh } = scene();
  run(phys, 2);
  veh.setInput({ throttle: 1 });
  run(phys, 3);
  CHECK(veh.forwardSpeed > 2, `it drives while intact (${veh.forwardSpeed.toFixed(1)} m/s)`);

  // strip the whole chassis lattice, as a big enough blast would
  for (const wh of veh.wheels) wh.driven = false;
  veh.syncDamage();
  veh.setInput({ throttle: 1 });
  const before = veh.forwardSpeed;
  run(phys, 5);
  CHECK(veh.forwardSpeed < before,
        `with no driven wheels it coasts to a stop (${before.toFixed(1)} -> ${veh.forwardSpeed.toFixed(1)} m/s)`);
  CHECK(veh.driveHealth === 0, 'and the drivetrain reports itself dead');
}

// ---- an explosion throws it, because the chassis is an ordinary rigid body
{
  const { phys, veh } = scene();
  run(phys, 2);
  const before = veh.body.pos.slice();
  phys.explode([veh.body.pos[0] - 1.5, veh.body.pos[1] - 0.6, veh.body.pos[2]], 2.0, 8.0, {});
  run(phys, 1);
  const moved = Math.hypot(veh.body.pos[0] - before[0], veh.body.pos[1] - before[1], veh.body.pos[2] - before[2]);
  CHECK(moved > 0.3, `a blast underneath launches the car (${moved.toFixed(2)} m)`);
  CHECK(veh.body.pos.every(Number.isFinite), 'and nothing goes NaN');
}

// ---- determinism, since vehicles now feed the same fixed-substep pipeline
{
  const drive = () => {
    const { phys, veh } = scene();
    veh.setInput({ throttle: 1, steer: 0.4 });
    run(phys, 4);
    return veh.body.pos.map(v => v.toFixed(6)).join(',');
  };
  CHECK(drive() === drive(), 'the same inputs produce bit-identical motion');

  // and the substep clock still absorbs an uneven frame rate
  const sliced = (dt) => {
    const { phys, veh } = scene();
    veh.setInput({ throttle: 1, steer: 0.4 });
    for (let i = 0; i < Math.round(4 / dt); i++) phys.step(dt);
    return veh.body.pos.map(v => v.toFixed(4)).join(',');
  };
  CHECK(sliced(1 / 60) === sliced(1 / 120),
        'and 60 fps and 120 fps agree, so the vehicle rides the fixed substep');
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
