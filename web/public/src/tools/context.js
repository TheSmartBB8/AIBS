// context.js — the tool <-> engine dependency contract.
//
// Tools never import the destruction/physics/fx modules directly. Everything a tool
// does to the world outside of the voxel grid itself goes through a *context object*
// of injected callbacks. That keeps this package testable with recording stubs, and
// lets the physics module land independently.
//
// ALL COORDINATES ARE IN METRES (world units), not voxel indices. Convert with
// VOXEL from voxel/world.js when you need indices.
//
// ---------------------------------------------------------------------------
// REQUIRED
//   world      : VoxelWorld       — read/write voxel grid (tools raycast + write it)
//   palette    : Palette          — colour + material lookup
//
// OPTIONAL (every one is called with `?.` — an unset callback is silently skipped)
//   rng()                                        -> [0,1)  deterministic source; defaults to Math.random
//
//   carveSphere(x, y, z, radius, energy, opts)
//       Remove voxels inside the sphere whose palette strength is <= the energy that
//       reaches them. `energy` is directly comparable to palette.strength(i).
//       opts: { source, tool, falloff, normal, impulse }
//         falloff 0 = full energy out to the rim, 1 = energy fades linearly to 0 at the rim.
//
//   carveCapsule(x0,y0,z0, x1,y1,z1, radius, energy, opts)
//       Same, along a segment. Used for the blowtorch slot cut.
//
//   explode(x, y, z, radius, energy, opts)                                  [optional]
//       Full explosion (carve + debris + impulse). If absent, tools/explosion.js
//       synthesises one from carveSphere + applyImpulse, so this may be left unset.
//
//   applyImpulse(x, y, z, ix, iy, iz, opts)
//       Push whatever dynamic bodies/debris are near (x,y,z) by the impulse (ix,iy,iz).
//       opts: { radius, radial, strength, maxDensity, source }
//         radial:true  — ignore (ix,iy,iz) and push everything within `radius` away
//                        from the point with `strength` (used for blasts).
//         maxDensity   — only affect material lighter than this (extinguisher gust).
//
//   spawnParticles(kind, x, y, z, opts)   kind: 'debris'|'sparks'|'dust'|'smoke'|
//                                               'explosion'|'muzzle'|'mist'|'paint'|
//                                               'torch_sparks'|'ricochet'|'splinters'
//   igniteAt(x, y, z, radius, intensity)      start/feed fire on flammable voxels
//   extinguishAt(x, y, z, radius, power)      suppress fire
//   playSound(name, x, y, z, opts)
//   addLight(x, y, z, opts)                   opts: { color:[r,g,b], intensity, radius, ttl }
//   emitOp(op)                                serialisable record of a world edit
//                                             (undo / replay / netcode)
// ---------------------------------------------------------------------------

/** Every optional callback name, in the order they appear above. */
export const TOOL_CTX_CALLBACKS = [
  'carveSphere', 'carveCapsule', 'explode', 'applyImpulse', 'spawnParticles',
  'igniteAt', 'extinguishAt', 'playSound', 'addLight', 'emitOp',
];

/**
 * True when `name` is backed by a real implementation.
 *
 * ToolSystem wraps the destructive callbacks so it can watch for damage near placed
 * explosives; those wrappers exist even when the underlying engine callback does not.
 * They are tagged `__noBase` so code that needs to know whether a real implementation
 * is present (explosion.js choosing between ctx.explode and its fallback) can tell.
 */
export function hasCb(ctx, name) {
  const f = ctx && ctx[name];
  return typeof f === 'function' && f.__noBase !== true;
}

/** Random source for a context. Pass ctx.rng in tests to make spread deterministic. */
export function rngOf(ctx) {
  return (ctx && typeof ctx.rng === 'function') ? ctx.rng : Math.random;
}

/**
 * Throws if the context is unusable, and reports which optional callbacks are missing
 * so the wiring layer can log what is not hooked up yet.
 */
export function validateContext(ctx) {
  if (!ctx || !ctx.world) throw new Error('tool context requires a `world`');
  if (!ctx.palette) throw new Error('tool context requires a `palette`');
  return TOOL_CTX_CALLBACKS.filter(k => typeof ctx[k] !== 'function');
}
