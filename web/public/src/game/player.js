// player.js — first-person controller with voxel AABB collision.
//
// The camera basis convention here is the one everything else in the project must agree
// with, so it's stated explicitly rather than left implicit:
//   forward = (sin(yaw)cos(pitch), sin(pitch), cos(yaw)cos(pitch))
//   right   = normalize(cross(forward, worldUp))
// Mouse-right must DEcrease yaw, because forward() rotates away from `right` as yaw grows.
// Getting either of those backwards silently mirrors look or strafe, which is miserable to
// debug from a screenshot — so both are asserted in tests.

import { VOXEL } from '../voxel/world.js';

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 12, y: 3.0, z: 4.0 };   // centre of the AABB, metres
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.inWater = false;
    this.noclip = false;
    this.halfW = 0.28;
    this.halfH = 0.85;
    this.eyeOffset = 0.68;
    this.walkSpeed = 4.6;
    this.sprintSpeed = 8.0;
    this.bobPhase = 0;
    this.bobAmp = 0;
  }

  eye() { return { x: this.pos.x, y: this.pos.y + this.eyeOffset, z: this.pos.z }; }

  forward() {
    const cp = Math.cos(this.pitch);
    return { x: Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: Math.cos(this.yaw) * cp };
  }
  forwardFlat() { return { x: Math.sin(this.yaw), y: 0, z: Math.cos(this.yaw) }; }
  /** Must equal normalize(cross(forwardFlat, +Y)). */
  rightFlat() { return { x: -Math.cos(this.yaw), y: 0, z: Math.sin(this.yaw) }; }

  /** dx/dy are raw mouse deltas in pixels (dx>0 = moved right, dy>0 = moved down). */
  applyMouseLook(dx, dy, sens = 0.0022) {
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    const lim = Math.PI * 0.5 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  /** Any solid voxel overlapping the AABB centred at c? */
  boxSolid(c, hw = this.halfW, hh = this.halfH) {
    const w = this.world;
    const x0 = Math.floor((c.x - hw) / VOXEL), x1 = Math.floor((c.x + hw) / VOXEL);
    const y0 = Math.floor((c.y - hh) / VOXEL), y1 = Math.floor((c.y + hh) / VOXEL);
    const z0 = Math.floor((c.z - hw) / VOXEL), z1 = Math.floor((c.z + hw) / VOXEL);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (w.isSolidClamped(x, y, z)) return true;
    return false;
  }

  /**
   * @param dt seconds
   * @param input {mx, mz, jump, sprint, crouch} — mx = strafe (+right), mz = forward
   */
  update(dt, input) {
    const fwd = this.forwardFlat(), rgt = this.rightFlat();
    let wx = fwd.x * input.mz + rgt.x * input.mx;
    let wz = fwd.z * input.mz + rgt.z * input.mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }

    let speed = input.sprint ? this.sprintSpeed : this.walkSpeed;
    if (input.crouch) speed *= 0.45;

    if (this.noclip) {
      const f = this.forward();
      this.pos.x += (f.x * input.mz + rgt.x * input.mx) * speed * 2 * dt;
      this.pos.y += (f.y * input.mz + (input.jump ? 1 : 0) - (input.crouch ? 1 : 0)) * speed * 2 * dt;
      this.pos.z += (f.z * input.mz + rgt.z * input.mx) * speed * 2 * dt;
      return;
    }

    const accel = this.onGround ? 12 : 3.0;
    const k = Math.min(1, accel * dt);
    this.vel.x += (wx * speed - this.vel.x) * k;
    this.vel.z += (wz * speed - this.vel.z) * k;
    this.vel.y -= 22 * dt;
    if (input.jump && this.onGround) { this.vel.y = 7.4; this.onGround = false; }

    // axis-separated movement so a blocked axis doesn't cancel the others
    const step = (axis, amount) => {
      const np = { ...this.pos };
      np[axis] += amount;
      if (!this.boxSolid(np)) { this.pos = np; return true; }
      return false;
    };

    if (!step('x', this.vel.x * dt)) {
      // try to step up over a low obstacle (kerbs, rubble) before giving up
      let stepped = false;
      if (this.onGround) {
        for (const lift of [0.12, 0.26, 0.4]) {
          const np = { x: this.pos.x + this.vel.x * dt, y: this.pos.y + lift, z: this.pos.z };
          if (!this.boxSolid(np)) { this.pos = np; stepped = true; break; }
        }
      }
      if (!stepped) this.vel.x = 0;
    }
    if (!step('z', this.vel.z * dt)) {
      let stepped = false;
      if (this.onGround) {
        for (const lift of [0.12, 0.26, 0.4]) {
          const np = { x: this.pos.x, y: this.pos.y + lift, z: this.pos.z + this.vel.z * dt };
          if (!this.boxSolid(np)) { this.pos = np; stepped = true; break; }
        }
      }
      if (!stepped) this.vel.z = 0;
    }
    if (!step('y', this.vel.y * dt)) {
      if (this.vel.y < 0) this.onGround = true;
      this.vel.y = 0;
    } else if (this.vel.y < 0) {
      // only leave the ground once there's genuinely nothing underfoot
      const probe = { ...this.pos }; probe.y -= 0.06;
      this.onGround = this.boxSolid(probe);
    }

    // view bob
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 0.5) {
      this.bobPhase += dt * hs * 1.4;
      this.bobAmp += (1 - this.bobAmp) * Math.min(1, 8 * dt);
    } else {
      this.bobAmp += (0 - this.bobAmp) * Math.min(1, 8 * dt);
    }

    // Keep the player inside the world. isSolidClamped() reports "solid" below y=0 so
    // nothing falls out the bottom, but horizontally it reports open air — without this
    // clamp you can simply walk off the edge and stroll around on an invisible floor.
    const m = this.halfW + 0.02;
    const maxX = this.world.sx * VOXEL - m, maxZ = this.world.sz * VOXEL - m;
    if (this.pos.x < m) { this.pos.x = m; this.vel.x = 0; }
    if (this.pos.z < m) { this.pos.z = m; this.vel.z = 0; }
    if (this.pos.x > maxX) { this.pos.x = maxX; this.vel.x = 0; }
    if (this.pos.z > maxZ) { this.pos.z = maxZ; this.vel.z = 0; }

    if (this.pos.y < -20) { this.pos.y = 20; this.vel = { x: 0, y: 0, z: 0 }; }
  }
}
