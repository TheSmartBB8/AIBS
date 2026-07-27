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
  if (blast.fire !== false) ctx.igniteAt?.(x, y, z, radius * 0.75, blast.fire ?? 1.0);
  ctx.emitOp?.({ type: 'explode', x, y, z, radius, energy, kind });

  return { x, y, z, radius, energy, kind };
}
