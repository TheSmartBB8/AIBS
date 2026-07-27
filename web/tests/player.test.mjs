// Headless tests for the first-person controller. The camera-basis checks here exist
// because a sign error in look or strafe is invisible in code review and maddening to
// diagnose from a screenshot.
import { VoxelWorld, VOXEL } from '../public/src/voxel/world.js';
import { Player } from '../public/src/game/player.js';

let fails = 0, checks = 0;
const CHECK = (c, m) => { checks++; if (c) console.log(`[ OK ] ${m}`); else { console.log(`[FAIL] ${m}`); fails++; } };
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

const flatWorld = (h = 10) => {
  const w = new VoxelWorld(64, 64, 64);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++)
    for (let y = 0; y <= h; y++) w.setRaw(x, y, z, 1);
  return w;
};

// ---- camera basis
{
  const p = new Player(flatWorld());
  for (const yaw of [0, 0.7, 1.9, -1.2, 3.0]) {
    p.yaw = yaw;
    const f = p.forwardFlat(), r = p.rightFlat();
    const trueRight = cross(f, { x: 0, y: 1, z: 0 });
    const err = Math.hypot(r.x - trueRight.x, r.y - trueRight.y, r.z - trueRight.z);
    CHECK(err < 1e-6, `rightFlat equals cross(forward, up) at yaw=${yaw.toFixed(1)}`);
  }
  // pitch must not tilt the flat basis
  p.pitch = 0.9;
  CHECK(Math.abs(p.forwardFlat().y) < 1e-9, 'forwardFlat ignores pitch');
  // forward() must actually pitch
  p.yaw = 0; p.pitch = 0.5;
  CHECK(p.forward().y > 0.4, 'looking up gives forward a positive Y');
}

// ---- mouse look direction
{
  const p = new Player(flatWorld());
  for (const startYaw of [0, 1.1, -2.4]) {
    p.yaw = startYaw; p.pitch = 0;
    const before = p.forwardFlat();
    const right = p.rightFlat();
    p.applyMouseLook(10, 0);
    const after = p.forwardFlat();
    const moved = { x: after.x - before.x, y: 0, z: after.z - before.z };
    CHECK(dot(moved, right) > 0, `mouse-right turns toward the camera's right (yaw=${startYaw})`);
  }
  p.yaw = 0; p.pitch = 0;
  p.applyMouseLook(0, 10);
  CHECK(p.pitch < 0, 'mouse-down looks down');
  // pitch clamp
  p.applyMouseLook(0, -100000);
  CHECK(p.pitch < Math.PI / 2 && p.pitch > 0, 'pitch is clamped below straight up');
  p.applyMouseLook(0, 200000);
  CHECK(p.pitch > -Math.PI / 2, 'pitch is clamped above straight down');
}

// ---- gravity and ground
{
  const w = flatWorld(10);                       // solid up to y=10 -> surface at y=11*VOXEL
  const p = new Player(w);
  p.pos = { x: 3.2, y: 3.0, z: 3.2 };
  const noInput = { mx: 0, mz: 0, jump: false, sprint: false, crouch: false };
  for (let i = 0; i < 400; i++) p.update(1 / 120, noInput);
  CHECK(p.onGround, 'player falls and lands on the ground');
  const surface = 11 * VOXEL;
  CHECK(Math.abs((p.pos.y - p.halfH) - surface) < 0.05,
        `feet rest on the surface (feet=${(p.pos.y - p.halfH).toFixed(3)} surface=${surface.toFixed(3)})`);
  const restY = p.pos.y;
  for (let i = 0; i < 120; i++) p.update(1 / 120, noInput);
  CHECK(Math.abs(p.pos.y - restY) < 1e-6, 'player stays at rest, does not sink or jitter');
}

// ---- jumping
{
  const p = new Player(flatWorld(10));
  p.pos = { x: 3.2, y: 3.0, z: 3.2 };
  const idle = { mx: 0, mz: 0, jump: false, sprint: false, crouch: false };
  for (let i = 0; i < 400; i++) p.update(1 / 120, idle);
  const groundY = p.pos.y;
  p.update(1 / 120, { ...idle, jump: true });
  CHECK(p.vel.y > 5, 'jump imparts upward velocity');
  let peak = groundY;
  for (let i = 0; i < 200; i++) { p.update(1 / 120, idle); peak = Math.max(peak, p.pos.y); }
  CHECK(peak > groundY + 0.7, `jump clears a useful height (${(peak - groundY).toFixed(2)}m)`);
}

// ---- walls block movement
{
  const w = flatWorld(10);
  for (let y = 11; y < 30; y++) for (let z = 0; z < 64; z++) w.setRaw(40, y, z, 2);
  const p = new Player(w);
  p.pos = { x: 3.5, y: 1.6, z: 3.2 };
  const idle = { mx: 0, mz: 0, jump: false, sprint: false, crouch: false };
  for (let i = 0; i < 200; i++) p.update(1 / 120, idle);
  p.yaw = Math.PI / 2;                      // face +x
  for (let i = 0; i < 600; i++) p.update(1 / 120, { ...idle, mz: 1 });
  CHECK(p.pos.x < 40 * VOXEL, `wall stops the player (x=${p.pos.x.toFixed(2)}, wall at ${(40 * VOXEL).toFixed(2)})`);
  CHECK(p.pos.x > 3.0, 'player actually moved toward the wall before being stopped');
}

// ---- step-up over a low kerb
{
  const w = flatWorld(10);
  // raised platform (not a narrow kerb) so the player stays up after stepping onto it —
  // a 4-voxel-wide strip would just be climbed and immediately walked off the far side
  for (let z = 0; z < 64; z++) for (let x = 30; x < 64; x++)
    for (let y = 11; y <= 12; y++) w.setRaw(x, y, z, 2);   // 2 voxels = 0.2m step
  const p = new Player(w);
  p.pos = { x: 2.6, y: 1.6, z: 3.2 };
  const idle = { mx: 0, mz: 0, jump: false, sprint: false, crouch: false };
  for (let i = 0; i < 200; i++) p.update(1 / 120, idle);
  const beforeY = p.pos.y;
  p.yaw = Math.PI / 2;
  // ~1s of walking: enough to cross the 0.4m to the kerb and climb it, without running
  // clear across this small test world
  for (let i = 0; i < 120; i++) p.update(1 / 120, { ...idle, mz: 1 });
  CHECK(p.pos.x > 34 * VOXEL, `player stepped up onto the kerb (x=${p.pos.x.toFixed(2)})`);
  CHECK(p.pos.y > beforeY + 0.1,
        `player ended up higher after the step-up (${beforeY.toFixed(2)} -> ${p.pos.y.toFixed(2)})`);
}

// ---- world bounds: the player must not be able to walk out of the level
{
  const w = flatWorld(10);
  const p = new Player(w);
  p.pos = { x: 3.2, y: 1.6, z: 3.2 };
  const idle = { mx: 0, mz: 0, jump: false, sprint: false, crouch: false };
  for (let i = 0; i < 200; i++) p.update(1 / 120, idle);
  p.yaw = Math.PI / 2;                       // face +x, straight at the world edge
  for (let i = 0; i < 1200; i++) p.update(1 / 120, { ...idle, mz: 1 });
  CHECK(p.pos.x <= w.sx * VOXEL, `player is held inside the world (x=${p.pos.x.toFixed(2)}, edge=${(w.sx * VOXEL).toFixed(2)})`);
  CHECK(p.pos.y > 0.5, 'player did not fall through to the invisible floor at the boundary');
}

// ---- strafe direction matches the camera
{
  const p = new Player(flatWorld(10));
  p.pos = { x: 3.2, y: 1.6, z: 3.2 };
  const idle = { mx: 0, mz: 0, jump: false, sprint: false, crouch: false };
  for (let i = 0; i < 200; i++) p.update(1 / 120, idle);
  p.yaw = 0;
  const start = { ...p.pos };
  for (let i = 0; i < 120; i++) p.update(1 / 120, { ...idle, mx: 1 });
  const moved = { x: p.pos.x - start.x, y: 0, z: p.pos.z - start.z };
  CHECK(dot(moved, p.rightFlat()) > 0.05, 'strafe-right moves the player to the camera right');
}

console.log(`\n== ${fails === 0 ? 'ALL CHECKS PASSED' : 'FAILED'} (${checks} checks, ${fails} failing) ==`);
process.exit(fails === 0 ? 0 : 1);
