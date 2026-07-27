// extinguisher.js — fire extinguisher.
//
// A wide, short cone of suppression. It does zero damage: it kills fire along the cone
// and delivers a gust that only shifts light stuff (paper, foliage, small debris), which
// is why applyImpulse gets a maxDensity cap rather than a plain push.

import { coneDir, normalize } from './util.js';
import { rngOf } from './context.js';

export const EXT_RANGE = 4.5;
export const EXT_CONE = 0.30;        // radians half-angle — wide
export const EXT_JETS = 10;
export const EXT_SUPPRESS_R = 0.55;  // metres of suppression per sample point
export const EXT_CHARGE = 400;       // ~20 s of continuous use at the 0.05 s cooldown

export const extinguisher = {
  id: 'extinguisher',
  name: 'Fire extinguisher',
  slot: 3,
  continuous: true,
  cooldown: 0.05,
  range: EXT_RANGE,
  ammo: EXT_CHARGE,
  ammoPerShot: 1,

  makeState() { return { suppressed: 0 }; },

  fire(ctx, state, eye, dir) {
    const rng = rngOf(ctx);
    const d = normalize(dir[0], dir[1], dir[2]);
    const points = [];

    for (let i = 0; i < EXT_JETS; i++) {
      const jd = coneDir(d, EXT_CONE, rng);
      const h = ctx.world.raycast(eye[0], eye[1], eye[2], jd[0], jd[1], jd[2], EXT_RANGE);
      const reach = h.hit ? h.dist : EXT_RANGE;

      // Fire lives on surfaces but the flame volume sits in the air above them, so
      // suppress at a couple of points along the jet, not only where it lands.
      for (const frac of [0.55, 1.0]) {
        const t = reach * frac;
        const p = [eye[0] + jd[0] * t, eye[1] + jd[1] * t, eye[2] + jd[2] * t];
        const power = 1 - 0.5 * (t / EXT_RANGE);
        ctx.extinguishAt?.(p[0], p[1], p[2], EXT_SUPPRESS_R, power);
        // gust: shoves only material lighter than dirt, so masonry debris ignores it
        ctx.applyImpulse?.(p[0], p[1], p[2], jd[0] * 18 * power, jd[1] * 18 * power, jd[2] * 18 * power,
          { radius: EXT_SUPPRESS_R, maxDensity: 0.4, source: 'extinguisher' });
        points.push(p);
      }
    }

    state.suppressed++;
    ctx.spawnParticles?.('mist', eye[0], eye[1], eye[2], {
      dir: d, cone: EXT_CONE, range: EXT_RANGE, count: 18, ttl: 1.2,
    });
    ctx.playSound?.('extinguisher', eye[0], eye[1], eye[2], { loop: true });
    ctx.emitOp?.({ type: 'extinguish', x: eye[0], y: eye[1], z: eye[2], dir: d, cone: EXT_CONE });

    return { tool: 'extinguisher', fired: true, points, jets: EXT_JETS, carves: 0 };
  },
};
