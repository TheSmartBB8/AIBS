// main.js — app entry. Builds the world, wires the renderer, and exposes a small
// control surface on window.__app so the headless screenshot harness can drive
// deterministic, repeatable shots for the visual-critic loop.

import * as THREE from 'three';
import { VoxelWorld, VOXEL } from './voxel/world.js';
import { Palette } from './voxel/palette.js';
import { buildLevel } from './scene/level.js';
import { VoxelRenderer } from './render/renderer.js';

// Named camera viewpoints. Fixed so every iteration of the critic loop compares the
// same framing — a shot that moved would make "did this get better?" unanswerable.
// Framed as three-quarter views with the sun raking across the facade — the angle
// Teardown's own screenshots favour, because it shows silhouette, shadow and AO at once.
// A head-on wall fills the frame with flat colour and hides exactly what we're judging.
export const VIEWS = {
  street:   { pos: [4.2,  2.0,  1.4], look: [14.0, 2.8, 12.0], fov: 68 },
  approach: { pos: [2.2,  1.8,  6.0], look: [13.0, 3.0, 13.0], fov: 72 },
  corner:   { pos: [21.5, 2.6,  2.2], look: [11.0, 3.2, 12.5], fov: 66 },
  wide:     { pos: [1.6,  6.5,  1.0], look: [14.0, 2.0, 13.5], fov: 62 },
  interior: { pos: [12.5, 2.0, 15.5], look: [12.2, 2.6,  8.5], fov: 76 },
  closeup:  { pos: [10.4, 1.5,  6.2], look: [11.6, 2.3,  8.0], fov: 52 },
  container:{ pos: [24.4, 2.4,  5.2], look: [21.0, 1.9, 11.5], fov: 66 },
  aerial:   { pos: [2.0, 19.0,  2.0], look: [13.0, 1.0, 13.0], fov: 60 },
};

const canvas = document.getElementById('view');
const world = new VoxelWorld(256, 160, 256);
const palette = new Palette();
const level = buildLevel(world, palette);
const renderer = new VoxelRenderer(canvas, world, palette);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

// build all meshes up front (headless shots must not race a progressive build)
const t0 = performance.now();
renderer.updateMeshes(0);
const buildMs = performance.now() - t0;

function applyView(v) {
  const cam = renderer.camera;
  cam.position.set(v.pos[0], v.pos[1], v.pos[2]);
  cam.lookAt(new THREE.Vector3(v.look[0], v.look[1], v.look[2]));
  cam.fov = v.fov ?? 70;
  cam.updateProjectionMatrix();
}
applyView(VIEWS.street);

let frames = 0;
function loop() {
  renderer.render();
  frames++;
  requestAnimationFrame(loop);
}
loop();

// ---- headless control surface
window.__app = {
  THREE, world, palette, renderer, level, VIEWS,
  ready: true,
  buildMs,
  get frames() { return frames; },
  stats: () => ({ ...renderer.stats, buildMs, solid: undefined }),
  setView(name) {
    const v = VIEWS[name];
    if (!v) throw new Error('unknown view: ' + name);
    applyView(v);
    return true;
  },
  setCamera(pos, look, fov) {
    applyView({ pos, look, fov });
    return true;
  },
  setSize(w, h) { renderer.setSize(w, h); return true; },
  /** Render n frames synchronously — used to settle any accumulation before a shot. */
  renderFrames(n = 1) {
    for (let i = 0; i < n; i++) renderer.render();
    return true;
  },
  countSolid: () => world.countSolid(),
  VOXEL,
};
console.log('[voxwreck] ready', JSON.stringify(renderer.stats), 'buildMs=' + buildMs.toFixed(0));
