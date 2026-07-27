// index.js — public surface of the tools package.
//
//   import { ToolSystem, TOOL } from './tools/index.js';
//   const tools = new ToolSystem({ world, palette, carveSphere, ... });
//   tools.select(TOOL.BLOWTORCH);
//   tools.triggerDown(eye, dir);      // ... tools.update(dt, eye, dir) each frame
//
// See context.js for the full injected-callback contract.

export { ToolSystem } from './system.js';
export { TOOL, TOOLS, TOOL_ORDER, getTool, cooldownOf } from './registry.js';
export { TOOL_CTX_CALLBACKS, validateContext, hasCb, rngOf } from './context.js';
export { detonate } from './explosion.js';

export { sledgehammer, swingPose } from './melee.js';
export { spraycan, SPRAY_COLOURS } from './spray.js';
export { extinguisher } from './extinguisher.js';
export { blowtorch } from './blowtorch.js';
export { pistol, shotgun, rifle, minigun } from './firearms.js';
export { pipebomb, bomb, nitro, rocket } from './explosives.js';
export { plank, winch, yankWinch, evaluateWinch } from './construct.js';
export { makeRng } from './util.js';
