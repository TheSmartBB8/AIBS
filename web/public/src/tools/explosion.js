// explosion.js — one blast implementation shared by every explosive tool.
//
// Prefers ctx.explode when the physics module provides it; otherwise synthesises the
// same event out of carveSphere + a radial impulse, so the tools work (and are
// testable) before physics lands.

import { hasCb } from './context.js';

/**
 * @param {object} ctx    tool context
 * @param {number[]} p    centre, metres
 * @param {object} blast  { radius, energy, impulse, kind, fire }
 */
export function detonate(ctx, p, blast) {
  const [x, y, z] = p;
  const radius = blast.radius;
  const energy = blast.energy;
  const impulse = blast.impulse ?? energy * 900;
  const kind = blast.kind || 'explosion';

  // Fire goes on before the blast, not after. The carve does not merely empty voxels — it
  // lifts everything it breaks off into rigid bodies, so for the frames between detonation
  // and the debris settling back there is nothing standing near the impact to catch. Light
  // the intact surface first and let the carve extinguish whatever it then destroys, and
  // the flame is left exactly where it belongs: on the material that survived.
  //
  // The shell runs from just inside the crater rim outward. A solid sphere would spend the
  // whole hundred-fire budget at the centre, on voxels the next line vaporises.
  if (blast.fire !== false) ctx.igniteAt?.(x, y, z, radius * 1.7, blast.fire ?? 1.0, radius * 0.8);

  if (hasCb(ctx, 'explode')) {
    ctx.explode(x, y, z, radius, energy, { kind, impulse });
  } else {
    // fallback: carve the crater, then shove everything in the blast radius outward.
    // falloff 1 => energy fades to zero at the rim, so the crater has a soft edge and
    // strong material only breaks near the centre.
    ctx.carveSphere?.(x, y, z, radius, energy, { source: kind, falloff: 1, tool: kind });
    ctx.applyImpulse?.(x, y, z, 0, 0, 0, { radial: true, radius: radius * 2.2, strength: impulse, source: kind });
  }

  ctx.spawnParticles?.('explosion', x, y, z, { radius, energy });
  ctx.spawnParticles?.('smoke', x, y, z, { radius: radius * 1.4, ttl: 4 });
  ctx.playSound?.('explosion', x, y, z, { radius });
  ctx.addLight?.(x, y, z, { color: [1.0, 0.72, 0.34], intensity: radius * 9, radius: radius * 4, ttl: 0.28 });
  ctx.emitOp?.({ type: 'explode', x, y, z, radius, energy, kind });

  return { x, y, z, radius, energy, kind };
}
