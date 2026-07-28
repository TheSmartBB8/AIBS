// main.js — app entry. Builds the world, wires player + engine + renderer, and exposes a
// control surface on window.__app so the headless harness can drive deterministic shots.

import * as THREE from 'three';
import { VoxelWorld, VOXEL } from './voxel/world.js';
import { Palette } from './voxel/palette.js';
import { buildLevel } from './scene/level.js';
import { VoxelRenderer } from './render/renderer.js';
import { Player } from './game/player.js';
import { Engine } from './game/engine.js';
import { TOOL_ORDER } from './tools/registry.js';
import { VIEWS } from './scene/views.js';

export { VIEWS };

const canvas = document.getElementById('view');
const world = new VoxelWorld(256, 160, 256);
const palette = new Palette();
const level = buildLevel(world, palette);
const renderer = new VoxelRenderer(canvas, world, palette);
const player = new Player(world);
const engine = new Engine(world, palette, { seed: 1337 });

player.pos = { x: 12.0, y: 2.2, z: 3.2 };
player.yaw = 0.15;

function resize() { renderer.setSize(window.innerWidth, window.innerHeight); }
window.addEventListener('resize', resize);
resize();

const t0 = performance.now();
renderer.updateMeshes(0);
const buildMs = performance.now() - t0;

// ---------------------------------------------------------------- input
const keys = Object.create(null);
let pointerLocked = false;
let freeCam = true;    // headless shots use fixed viewpoints, not the player camera

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyF') freeCam = !freeCam;
  const n = parseInt(e.key, 10);
  if (!isNaN(n) && n >= 1 && n <= 9 && TOOL_ORDER[n - 1] !== undefined) engine.selectTool(TOOL_ORDER[n - 1]);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
canvas.addEventListener('click', () => { if (!pointerLocked) canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => { pointerLocked = document.pointerLockElement === canvas; });
addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  player.applyMouseLook(e.movementX, e.movementY);
  freeCam = false;
  renderer.resetAccumulation?.();
});
addEventListener('mousedown', (e) => {
  if (!pointerLocked) return;
  if (e.button === 0) engine.triggerDown(aimEye(), aimDir());
});
addEventListener('mouseup', (e) => {
  if (!pointerLocked) return;
  if (e.button === 0) engine.triggerUp(aimEye(), aimDir());
});
addEventListener('wheel', (e) => { if (pointerLocked) engine.nextTool(e.deltaY > 0 ? 1 : -1); }, { passive: true });

const aimEye = () => { const e = player.eye(); return [e.x, e.y, e.z]; };
const aimDir = () => { const d = player.forward(); return [d.x, d.y, d.z]; };

// ---------------------------------------------------------------- loop
let frames = 0, last = performance.now();

function applyView(v) {
  const cam = renderer.camera;
  cam.position.set(v.pos[0], v.pos[1], v.pos[2]);
  cam.lookAt(new THREE.Vector3(v.look[0], v.look[1], v.look[2]));
  cam.fov = v.fov ?? 70;
  cam.updateProjectionMatrix();
  renderer.resetAccumulation?.();
}
applyView(VIEWS.street);

function step(dt) {
  if (pointerLocked) {
    player.update(dt, {
      mx: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0),
      mz: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0),
      jump: !!keys.Space, sprint: !!keys.ShiftLeft, crouch: !!keys.ControlLeft,
    });
  }
  engine.update(dt, { eye: aimEye(), dir: aimDir() });
  // A destructive edit changes geometry, so the accumulated history is stale.
  if (world.chunkDirty.some !== undefined) { /* typed array: checked via updateMeshes below */ }
  const rebuilt = renderer.updateMeshes(6);
  if (rebuilt > 0) renderer.resetAccumulation?.();
  renderer.setLights?.(engine.lights);
  renderer.setBodies?.(engine.physics.bodies, engine.physics.debris);
  renderer.setParticles?.(engine.particles.buildInstances());
  if (!freeCam) {
    const e = player.eye();
    const f = player.forward();
    renderer.camera.position.set(e.x, e.y, e.z);
    renderer.camera.lookAt(e.x + f.x, e.y + f.y, e.z + f.z);
  }
}

function loop() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
  renderer.render();
  frames++;
  requestAnimationFrame(loop);
}
loop();

// ---------------------------------------------------------------- headless control surface
window.__app = {
  THREE, world, palette, renderer, player, engine, level, VIEWS, VOXEL,
  ready: true,
  buildMs,
  get frames() { return frames; },
  stats: () => ({ ...renderer.stats, buildMs, ...engine.stats,
                  bodies: engine.physics.bodies.length,
                  particles: engine.particles.count, fires: engine.fire.count }),
  setView(name) {
    const v = VIEWS[name];
    if (!v) throw new Error('unknown view: ' + name);
    freeCam = true;
    applyView(v);
    return true;
  },
  setCamera(pos, look, fov) { freeCam = true; applyView({ pos, look, fov }); return true; },
  setSize(w, h) { renderer.setSize(w, h); return true; },
  renderFrames(n = 1) { for (let i = 0; i < n; i++) renderer.render(); return true; },

  /** Fire a tool at a world point — used by the harness to stage destruction for shots. */
  fireAt(toolId, from, at, holdFrames = 1) {
    const d = [at[0] - from[0], at[1] - from[1], at[2] - from[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= L; d[1] /= L; d[2] /= L;
    engine.selectTool(toolId);
    for (let i = 0; i < holdFrames; i++) {
      engine.triggerDown(from, d);
      engine.update(1 / 60, { eye: from, dir: d });
    }
    engine.triggerUp(from, d);
    return true;
  },
  /** Advance the simulation without rendering — lets debris settle before a shot. */
  simulate(seconds = 2, dt = 1 / 60) {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) engine.update(dt, { eye: aimEye(), dir: aimDir() });
    renderer.updateMeshes(0);
    renderer.resetAccumulation?.();
    return true;
  },
  countSolid: () => world.countSolid(),
};
console.log('[voxwreck] ready', JSON.stringify(renderer.stats), 'buildMs=' + buildMs.toFixed(0));
