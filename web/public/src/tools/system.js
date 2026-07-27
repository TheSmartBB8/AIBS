// system.js — ToolSystem: owns the selected tool, cooldowns, and everything a tool
// leaves behind that has to keep living after the click.
//
// Tools are stateless-ish functions that return a *result*; if that result carries a
// `spawn`, the system takes it over:
//
//   spawn.kind = 'projectile'  -> flown here, bounced off the voxel grid, fused
//   spawn.kind = 'placed'      -> counted down here, and watched for damage
//   spawn.kind = 'winch'       -> tightened here, then yanked
//
// The system also wraps the destructive context callbacks so that *every* carve and
// explosion — whoever caused it — is reported to notifyDamage(). That is the bus the
// nitro canisters listen on, and it is what makes chain reactions fall out for free.

import { VOXEL } from '../voxel/world.js';
import { TOOL, TOOLS, TOOL_ORDER, getTool, cooldownOf } from './registry.js';
import { detonate } from './explosion.js';
import { yankWinch } from './construct.js';
import { dot, clamp } from './util.js';
import { validateContext } from './context.js';

const DAMAGE_KEYS = ['carveSphere', 'carveCapsule', 'explode'];
const MAX_EVENTS = 64;

export class ToolSystem {
  constructor(ctx, { tool = TOOL.SLEDGEHAMMER } = {}) {
    this.missingCallbacks = validateContext(ctx);
    this.setContext(ctx);

    this.states = {};
    for (const id of TOOL_ORDER) {
      const t = getTool(id);
      const s = t.makeState ? t.makeState() : {};
      s.cooldown = 0;
      s.ammo = t.ammo ?? Infinity;
      this.states[id] = s;
    }

    this.current = tool;
    this.held = false;
    this.aim = { eye: [0, 0, 0], dir: [0, 0, 1] };
    this.projectiles = [];
    this.placed = [];
    this.winches = [];
    this.events = [];
    this.time = 0;
    this._queue = [];
    this._draining = false;
  }

  /** Re-bind the engine callbacks (call again if physics/fx are wired up late). */
  setContext(base) {
    this.baseCtx = base;
    this.ctx = this._wrapDamage(base);
    return this.ctx;
  }

  _wrapDamage(base) {
    const sys = this;
    const ctx = Object.assign({}, base);
    for (const key of DAMAGE_KEYS) {
      const fn = typeof base[key] === 'function' ? base[key].bind(base) : null;
      let wrapped;
      if (key === 'carveCapsule') {
        wrapped = (x0, y0, z0, x1, y1, z1, r, e, opts) => {
          if (fn) fn(x0, y0, z0, x1, y1, z1, r, e, opts);
          const half = Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.5;
          sys.notifyDamage((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, half + r, e, opts && opts.source);
        };
      } else {
        wrapped = (x, y, z, r, e, opts) => {
          if (fn) fn(x, y, z, r, e, opts);
          sys.notifyDamage(x, y, z, r, e, opts && (opts.source || opts.kind));
        };
      }
      // marked so explosion.js can tell a bookkeeping wrapper from a real implementation
      if (!fn) wrapped.__noBase = true;
      ctx[key] = wrapped;
    }
    return ctx;
  }

  // ------------------------------------------------------------------ selection
  get toolDef() { return getTool(this.current); }
  get state() { return this.states[this.current]; }

  select(id) {
    if (!TOOLS[id]) return false;
    if (id !== this.current) {
      // stop whatever the old tool was doing (torch cut, minigun spin, held trigger)
      const prev = getTool(this.current);
      prev.tick?.(this.states[this.current], 0, false, this.ctx);
      this.held = false;
      this.current = id;
    }
    return true;
  }

  selectSlot(n) { return this.select(TOOL_ORDER[clamp(n - 1, 0, TOOL_ORDER.length - 1)]); }

  cycle(delta = 1) {
    const i = TOOL_ORDER.indexOf(this.current);
    const n = TOOL_ORDER.length;
    return this.select(TOOL_ORDER[(i + delta % n + n) % n]);
  }

  /** Right-click: spray can cycles colour, two-click tools drop their armed anchor. */
  secondary(delta = 1) {
    const t = this.toolDef, s = this.state;
    if (typeof t.cycleColour === 'function') return { action: 'colour', value: t.cycleColour(s, delta) };
    if (typeof t.cancel === 'function') return { action: 'cancel', value: t.cancel(s) };
    return { action: 'none' };
  }

  ammoOf(id = this.current) { return this.states[id].ammo; }
  cooldownOf(id = this.current) { return this.states[id].cooldown; }
  reload(id = this.current) { this.states[id].ammo = getTool(id).ammo ?? Infinity; }
  reloadAll() { for (const id of TOOL_ORDER) this.reload(id); }

  describe() {
    const t = this.toolDef, s = this.state;
    return {
      id: t.id, name: t.name, slot: t.slot, continuous: !!t.continuous,
      cooldown: s.cooldown, cooldownMax: cooldownOf(t, s),
      ammo: s.ammo, ammoMax: t.ammo, range: t.range,
      armed: !!s.anchor, spin: s.spin ?? 0, colour: s.colour ?? null,
    };
  }

  // ----------------------------------------------------------------------- input
  triggerDown(eye, dir) {
    if (eye) this.aim = { eye, dir };
    this.held = true;
    return this.fire(this.aim.eye, this.aim.dir);
  }

  triggerUp() {
    this.held = false;
    const t = this.toolDef;
    t.tick?.(this.states[t.id], 0, false, this.ctx);
  }

  setAim(eye, dir) { this.aim = { eye, dir }; }

  /** One trigger pull. Honours cooldown and ammo; adopts any spawn the tool returns. */
  fire(eye = this.aim.eye, dir = this.aim.dir) {
    const tool = this.toolDef;
    const st = this.state;
    if (st.cooldown > 0) return { tool: tool.id, fired: false, reason: 'cooldown' };

    const cost = tool.ammoPerShot || 0;
    if (cost > 0 && st.ammo < cost) {
      this.ctx.playSound?.('tool_empty', eye[0], eye[1], eye[2], {});
      st.cooldown = 0.3;
      return { tool: tool.id, fired: false, reason: 'empty' };
    }

    const res = tool.fire(this.ctx, st, eye, dir) || { fired: true };
    if (res.fired !== false) {
      st.cooldown = cooldownOf(tool, st);
      if (cost > 0) st.ammo -= cost;
      if (res.spawn) this._adopt(res.spawn);
    } else {
      // a refused shot still throttles, so a held trigger can't spin the CPU
      st.cooldown = Math.min(cooldownOf(tool, st), 0.12);
    }
    this.lastResult = res;
    return res;
  }

  _adopt(spawn) {
    if (spawn.kind === 'projectile') {
      this.projectiles.push({ ...spawn, pos: [...spawn.pos], vel: [...spawn.vel], age: 0, bounces: 0, dead: false });
    } else if (spawn.kind === 'placed') {
      this.placed.push({ ...spawn, pos: [...spawn.pos], age: 0, dead: false });
    } else if (spawn.kind === 'winch') {
      this.winches.push({ ...spawn, t: 0, dead: false });
    }
  }

  // ---------------------------------------------------------------------- update
  update(dt, eye, dir) {
    this.time += dt;
    if (eye) this.aim = { eye, dir: dir || this.aim.dir };

    for (const id of TOOL_ORDER) {
      const st = this.states[id];
      if (st.cooldown > 0) st.cooldown = Math.max(0, st.cooldown - dt);
      TOOLS[id].tick?.(st, dt, this.held && this.current === id, this.ctx);
    }

    if (this.held && this.toolDef.continuous) this.fire(this.aim.eye, this.aim.dir);

    this._updateProjectiles(dt);
    this._updatePlaced(dt);
    this._updateWinches(dt);
  }

  _updateProjectiles(dt) {
    const world = this.ctx.world;
    for (const p of this.projectiles) {
      if (p.dead) continue;
      p.age += dt;
      // fuse first: a pipe bomb that is mid-bounce when its fuse runs out still goes off
      if (p.fuse != null && p.age >= p.fuse) { this._detonateProjectile(p, 'fuse'); continue; }

      const radius = p.radius ?? 0.06;
      let remaining = dt, guard = 0;
      while (remaining > 1e-6 && !p.dead && guard++ < 64) {
        const speed = Math.hypot(p.vel[0], p.vel[1], p.vel[2]) || 1e-6;
        const h = Math.min(remaining, (VOXEL * 2) / speed);
        p.vel[1] += (p.gravity ?? -9.8) * h;

        const mx = p.vel[0] * h, my = p.vel[1] * h, mz = p.vel[2] * h;
        const moveLen = Math.hypot(mx, my, mz);
        if (moveLen > 1e-9) {
          const d = [mx / moveLen, my / moveLen, mz / moveLen];
          const hit = world.raycast(p.pos[0], p.pos[1], p.pos[2], d[0], d[1], d[2], moveLen + radius);
          if (hit.hit) {
            const t = Math.max(0, hit.dist - radius - 0.005);
            p.pos = [p.pos[0] + d[0] * t, p.pos[1] + d[1] * t, p.pos[2] + d[2] * t];
            if (p.detonateOnImpact) {
              this._detonateProjectile(p, 'impact', hit);
              break;
            }
            const n = [hit.nx, hit.ny, hit.nz];
            const vn = dot(p.vel, n);
            const nrm = [n[0] * vn, n[1] * vn, n[2] * vn];
            const rest = p.restitution ?? 0.35, fric = p.friction ?? 0.4;
            p.vel = [
              (p.vel[0] - nrm[0]) * (1 - fric) - nrm[0] * rest,
              (p.vel[1] - nrm[1]) * (1 - fric) - nrm[1] * rest,
              (p.vel[2] - nrm[2]) * (1 - fric) - nrm[2] * rest,
            ];
            p.pos = [p.pos[0] + n[0] * 0.03, p.pos[1] + n[1] * 0.03, p.pos[2] + n[2] * 0.03];
            p.bounces++;
            this.ctx.playSound?.(`${p.type}_bounce`, p.pos[0], p.pos[1], p.pos[2], { speed });
            remaining -= h;
            continue;
          }
        }
        p.pos = [p.pos[0] + mx, p.pos[1] + my, p.pos[2] + mz];
        remaining -= h;
        if (p.pos[1] < -5 || p.pos[1] > world.sy * VOXEL + 80) { p.dead = true; }
      }
      if (!p.dead && p.trail) {
        this.ctx.spawnParticles?.('smoke', p.pos[0], p.pos[1], p.pos[2], { trail: p.trail, ttl: 1.2, count: 2 });
      }
    }
    if (this.projectiles.some(p => p.dead)) this.projectiles = this.projectiles.filter(p => !p.dead);
  }

  _updatePlaced(dt) {
    for (const p of this.placed) {
      if (p.dead) continue;
      p.age += dt;
      // fuse == null means "never on its own" — nitro's defining property
      if (p.fuse != null && p.age >= p.fuse) this._detonatePlaced(p, 'fuse');
      else if (p.fuse != null) {
        const left = p.fuse - p.age;
        if (left < 1.2) this.ctx.spawnParticles?.('sparks', p.pos[0], p.pos[1], p.pos[2], { count: 1, ttl: 0.2 });
      }
    }
    if (this.placed.some(p => p.dead)) this.placed = this.placed.filter(p => !p.dead);
  }

  _updateWinches(dt) {
    for (const w of this.winches) {
      if (w.dead) continue;
      w.t += dt;
      w.slack = clamp(1 - w.t / w.tighten, 0, 1);
      if (w.t >= w.tighten) {
        const ev = yankWinch(this.ctx, w);
        this._event({ type: 'winch_yank', ...ev });
      }
    }
    if (this.winches.some(w => w.dead)) this.winches = this.winches.filter(w => !w.dead);
  }

  // ------------------------------------------------------------------- explosions
  _detonateProjectile(p, cause, hit) {
    p.dead = true;
    const ev = detonate(this.ctx, p.pos, p.blast);
    this._event({ type: 'detonate', what: p.type, cause, bounces: p.bounces, age: p.age, ...ev });
    void hit;
    return ev;
  }

  _detonatePlaced(p, cause) {
    p.dead = true;
    this._clearVoxels(p);
    const ev = detonate(this.ctx, p.pos, p.blast);
    this._event({ type: 'detonate', what: p.type, cause, age: p.age, ...ev });
    return ev;
  }

  _clearVoxels(p) {
    if (!p.voxels || !p.voxels.length) return;
    const w = this.ctx.world;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const [x, y, z] of p.voxels) {
      w.set(x, y, z, 0);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    w.updateMipsRegion(x0, y0, z0, x1, y1, z1);
  }

  /**
   * Damage happened in the world. Public: the physics module should call this too when
   * a collapse or a falling body crushes something, so nitro reacts to more than gunfire.
   */
  notifyDamage(x, y, z, radius, energy, source) {
    if (!(energy > 0)) return 0;
    let triggered = 0;
    for (const p of this.placed) {
      if (p.dead || p.queued || !p.triggerOnDamage) continue;
      const d = Math.hypot(p.pos[0] - x, p.pos[1] - y, p.pos[2] - z);
      if (d > (radius || 0) + (p.triggerRadius ?? 0.3)) continue;
      if (energy < (p.triggerEnergy ?? 0.2)) continue;
      p.queued = true;
      p.cause = source || 'damage';
      this._queue.push(p);
      triggered++;
    }
    if (triggered) this._drain();
    return triggered;
  }

  /**
   * Detonate queued charges. Re-entrant-safe: a blast set off in here reports its own
   * damage, which enqueues more charges that this same loop picks up — that is the
   * chain reaction, without recursion.
   */
  _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      let guard = 0;
      while (this._queue.length && guard++ < 128) {
        const p = this._queue.shift();
        if (p.dead) continue;
        this._detonatePlaced(p, p.cause || 'damage');
      }
    } finally {
      this._draining = false;
      this._queue.length = 0;
      // Compact here rather than waiting for the next _updatePlaced tick. notifyDamage()
      // is a public entry point, so a caller that inspects `placed` straight after a
      // chain reaction must not still see the canisters that just went off.
      if (this.placed.some((p) => p.dead)) this.placed = this.placed.filter((p) => !p.dead);
    }
  }

  _event(e) {
    this.events.push({ t: this.time, ...e });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }
}
