// vehicle.js — drivable voxel vehicles.
//
// A vehicle is a VoxelBody (so it gets the existing mass properties, world collision,
// blast response and destructibility for free) plus a set of raycast wheels. The wheels
// are not simulated bodies: each is a ray cast down from its mount into the voxel grid,
// and everything a wheel does — holding the car up, gripping, driving, steering, resisting
// slide — is expressed as forces applied to the chassis at the contact point.
//
// That is the standard arcade/simulation compromise and it is the right one here. Real
// wheel bodies with constraints would spend a solver budget on something the player never
// looks at, and would fight the voxel world's blocky surface. Raycast wheels ride a stepped
// surface smoothly, which matters when every kerb in the level is a 10 cm cliff.
//
// Forces, per wheel, per substep:
//   suspension  a damped spring along the chassis' local up, so weight transfer, roll in
//               corners and pitch under braking all fall out rather than being faked
//   longitudinal drive or brake force along the wheel's forward, clamped by available grip
//   lateral      force opposing sideways slip at the contact, also clamped by grip
//
// Grip is a friction circle: longitudinal and lateral demand share one budget, so flooring
// it mid-corner makes the back step out. That single coupling is most of what makes a car
// feel like a car.

import { VOXEL } from '../voxel/world.js';
import { VoxelBody } from './body.js';
import {
  vadd, vsub, vmul, vdot, vcross, vlen, vnorm, m3MulVec, m3FromQuat, qIdentity, clamp,
} from './math3d.js';

/**
 * Defaults for a road car.
 *
 * Everything that scales with weight is expressed as a *ratio*, not a force in newtons.
 * A voxel chassis' mass depends entirely on how it was authored — a solid 4 m block of
 * metal weighs eighty tonnes, a hollow shell of the same size a fraction of that — so an
 * absolute spring rate either bottoms out instantly or launches the car into orbit
 * depending on a decision the level author was not thinking about. Deriving the rates from
 * the chassis' own mass means any body that looks like a car drives like one.
 */
export const CAR_TUNING = {
  suspensionRest: 0.28,     // m from mount to wheel centre at full extension
  suspensionTravel: 0.22,   // m of compression before it bottoms out
  wheelRadius: 0.20,
  restSag: 0.35,            // fraction of travel the springs sit at under their own weight
  dampingRatio: 0.55,       // of critical. Below ~0.3 the car porpoises, above ~1 it is a brick
  gripLong: 1.5,            // friction coefficients at the contact
  gripLat: 1.9,             // lateral is stiffer, or the car understeers into everything
  driveAccel: 5.0,          // m/s^2 at full throttle on a clean surface
  brakeAccel: 9.0,          // m/s^2 under full brakes
  maxSteer: 0.62,           // radians at the front wheels
  steerRate: 3.2,           // radians/s the steering angle chases the input
  steerCentreRate: 5.0,     // and returns to centre faster than it turns in
  topSpeed: 26,             // m/s at full throttle on the flat — drag is derived from it
  rollingResistance: 0.015, // constant fraction of load, the way a tyre actually behaves
  // Downforce as a fraction of the car's own weight *at top speed*, which is a number a
  // human can reason about. Expressed per (m/s)^2 it read 0.02 and silently meant thirteen
  // times the car's weight at speed: it crushed the suspension, inflated the load-
  // proportional rolling resistance, and pinned the car to 5.5 m/s.
  downforceAtTopSpeed: 0.45,
  gravity: 20,              // must match PhysicsWorld's; addVehicle syncs it
};

export class Wheel {
  /**
   * @param mount  wheel mount in chassis-local metric space, relative to the body centre of mass
   * @param opts   steered / driven / braked flags and per-wheel overrides
   */
  constructor(mount, opts = {}) {
    this.mount = mount.slice();
    this.steered = !!opts.steered;
    this.driven = opts.driven === undefined ? true : !!opts.driven;
    this.braked = opts.braked === undefined ? true : !!opts.braked;
    this.radius = opts.radius === undefined ? CAR_TUNING.wheelRadius : opts.radius;

    // state, all recomputed every substep
    this.grounded = false;
    this.compression = 0;      // 0 = fully extended, 1 = bottomed out
    this.contact = [0, 0, 0];  // world contact point
    this.normal = [0, 1, 0];
    this.steer = 0;            // current steering angle, radians
    this.spin = 0;             // visual wheel rotation, radians
    this.slip = 0;             // 0..1, how much grip is being used — drives skid fx
    this.surfacePal = 0;
  }
}

export class Vehicle {
  /**
   * @param body    VoxelBody chassis
   * @param wheels  Wheel[]
   * @param tuning  overrides on CAR_TUNING
   */
  constructor(body, wheels, tuning = {}) {
    this.body = body;
    this.wheels = wheels;
    this.tuning = { ...CAR_TUNING, ...tuning };
    // Which way the chassis faces in its own lattice. A level author places a car along
    // whatever axis the street runs, and a hardcoded +Z means a car laid out along X
    // steers about its long axis and drives itself in circles — which is exactly what it
    // did. Right is up x forward, so the set stays right-handed whatever forward is.
    this.forwardLocal = vnorm((tuning.forward || [0, 0, 1]).slice());
    this.upLocal = vnorm((tuning.up || [0, 1, 0]).slice());
    this.rightLocal = vnorm(vcross(this.upLocal, this.forwardLocal));
    this.throttle = 0;   // -1..1, negative is reverse
    this.brake = 0;      // 0..1
    this.steerInput = 0; // -1..1
    this.handbrake = false;
    this.alive = true;
    // A destroyed engine stops the car driving even though the chassis still rolls.
    this.driveHealth = 1;
    this.body.friction = 0.75;
    this.body.restitution = 0.05;
    this.retune();
  }

  /**
   * Derive the absolute rates from the chassis mass. Call again if the car loses enough
   * of itself to change its weight materially — a car with the back half blown off should
   * ride higher on what is left, not sit exactly as it did.
   */
  retune() {
    const T = this.tuning;
    const m = Math.max(this.body.mass, 1e-3);
    const n = Math.max(this.wheels.length, 1);
    const sag = Math.max(T.restSag * T.suspensionTravel, 1e-3);
    // total spring rate that puts the car at restSag of its travel under its own weight
    this.springK = (m * T.gravity) / sag;
    // critical damping for that rate, scaled by the ratio we actually want
    this.damperC = 2 * T.dampingRatio * Math.sqrt(this.springK * m);
    this.driveForce = m * T.driveAccel;
    this.brakeForce = m * T.brakeAccel;
    this.restLoad = (m * T.gravity) / n;   // per-wheel static load, the grip reference
    this.downforceK = T.downforceAtTopSpeed / Math.max(T.topSpeed * T.topSpeed, 1e-6);
    // Aerodynamic drag sized so it exactly cancels full drive at topSpeed, which makes
    // topSpeed mean what it says instead of being a number the car never approaches.
    this.dragK = this.driveForce / Math.max(T.topSpeed * T.topSpeed, 1e-6);
  }

  get speed() { return vlen(this.body.v); }

  /** Signed speed along the chassis' forward axis — negative when reversing. */
  get forwardSpeed() {
    return vdot(this.body.v, m3MulVec(this.body.R, this.forwardLocal));
  }

  setInput({ throttle = 0, brake = 0, steer = 0, handbrake = false } = {}) {
    this.throttle = clamp(throttle, -1, 1);
    this.brake = clamp(brake, 0, 1);
    this.steerInput = clamp(steer, -1, 1);
    this.handbrake = !!handbrake;
  }

  /**
   * One fixed substep. The chassis is integrated by the normal rigid-body path afterwards;
   * this only accumulates the wheel forces into it.
   */
  step(world, h) {
    if (!this.alive || this.body.mass <= 0) return;
    const T = this.tuning;
    const b = this.body;
    b.R = m3FromQuat(b.q);
    b.updateDerived();

    const up = m3MulVec(b.R, this.upLocal);
    const fwd = m3MulVec(b.R, this.forwardLocal);
    const right = m3MulVec(b.R, this.rightLocal);

    // Steering chases the input rather than snapping: instant steering makes a car feel
    // like it is on rails and makes it impossible to hold a slide.
    const target = this.steerInput * T.maxSteer;
    for (const wh of this.wheels) {
      if (!wh.steered) { wh.steer = 0; continue; }
      const rate = (Math.abs(target) < Math.abs(wh.steer) ? T.steerCentreRate : T.steerRate) * h;
      const d = clamp(target - wh.steer, -rate, rate);
      wh.steer += d;
    }

    // Gather every wheel's force from the *same* body state, then apply them together.
    // Applying each wheel's impulse as it is computed makes the sweep order matter: the
    // wheels processed first push the chassis, and the ones processed later then read an
    // already-moved body and contribute less. With a fixed wheel order that is a constant
    // bias, and it showed up as every car in the level sitting visibly leaned over to the
    // same side even though its mass and mounts were exactly symmetric.
    let groundedCount = 0;
    const pending = this._pending || (this._pending = []);
    pending.length = 0;
    for (const wh of this.wheels) if (this._stepWheel(world, wh, h, up, fwd, right, pending)) groundedCount++;
    for (let i = 0; i < pending.length; i += 2) b.applyImpulse(pending[i], pending[i + 1]);
    this.grounded = groundedCount > 0;

    // Aerodynamic downforce through the centre of mass. Without it the car goes light
    // over crests at speed and the suspension loses the ground entirely.
    if (groundedCount > 0) {
      const s = this.speed;
      const F = this.downforceK * s * s * b.mass * T.gravity;
      b.applyLinearImpulse(vmul(up, -F * h));
    }

    // Aerodynamic drag, always — a car coasting in neutral slows down, and this is what
    // gives the throttle a terminal speed now that drive force is flat.
    {
      const s = this.speed;
      if (s > 1e-3) {
        const F = this.dragK * s * s;
        b.applyLinearImpulse(vmul(b.v, -F * h / s));
      }
    }
  }

  _stepWheel(world, wh, h, up, fwd, right, pending) {
    const T = this.tuning;
    const b = this.body;

    // mount point in world space
    const mountW = vadd(b.pos, m3MulVec(b.R, wh.mount));
    const maxReach = T.suspensionRest + T.suspensionTravel + wh.radius;
    const down = vmul(up, -1);
    const hit = world.raycast(mountW[0], mountW[1], mountW[2], down[0], down[1], down[2], maxReach);

    if (!hit || !hit.hit) {
      wh.grounded = false;
      wh.compression = 0;
      wh.slip = 0;
      // free-spinning wheel decays toward the road speed it last had
      wh.spin += (this.forwardSpeed / Math.max(wh.radius, 1e-3)) * h;
      return false;
    }

    const dist = hit.dist;
    const rest = T.suspensionRest + wh.radius;
    // Positive = compressed. Negative would mean the wheel is dangling, handled above.
    const x = clamp(rest - dist, 0, T.suspensionTravel);
    wh.grounded = true;
    wh.compression = x / T.suspensionTravel;
    wh.contact = [mountW[0] + down[0] * dist, mountW[1] + down[1] * dist, mountW[2] + down[2] * dist];
    wh.normal = hit.nx !== undefined ? vnorm([hit.nx, hit.ny, hit.nz]) : [0, 1, 0];
    wh.surfacePal = hit.pal || 0;

    const n = this.wheels.length;
    const r = vsub(wh.contact, b.pos);
    const pv = b.pointVelocity(r);

    // ---- suspension: damped spring along the chassis' up
    const compressRate = -vdot(pv, up);
    let Fs = (this.springK / n) * x + (this.damperC / n) * compressRate;
    if (Fs < 0) Fs = 0;                       // a spring cannot pull the car down
    // Grip references the *static* load, not the instantaneous spring force: over a bump
    // the spring momentarily reads near zero and the tyre would let go of the road for no
    // reason a driver could see. Weight transfer still modulates it, just not to nothing.
    const load = Math.max(Fs, this.restLoad * 0.35);
    pending.push(wh.contact, vmul(up, Fs * h));

    // ---- traction, in the wheel's own frame
    const steerC = Math.cos(wh.steer), steerS = Math.sin(wh.steer);
    const wFwd = vnorm(vadd(vmul(fwd, steerC), vmul(right, steerS)));
    const wRight = vnorm(vadd(vmul(right, steerC), vmul(fwd, -steerS)));

    const vf = vdot(pv, wFwd);
    const vr = vdot(pv, wRight);
    wh.spin += (vf / Math.max(wh.radius, 1e-3)) * h;

    // Longitudinal demand: drive, brake, and rolling resistance.
    let Flong = 0;
    if (wh.driven && this.driveHealth > 0) {
      Flong += this.throttle * (this.driveForce / this._drivenCount()) * this.driveHealth;
    }
    if (wh.braked && (this.brake > 0 || this.handbrake)) {
      const bf = Math.max(this.brake, this.handbrake && !wh.steered ? 1 : 0);
      Flong -= Math.sign(vf) * bf * (this.brakeForce / this.wheels.length);
    }
    // Rolling resistance is a constant fraction of load opposing motion, not something
    // proportional to speed — as a speed term it behaved like drag and held the car to a
    // quarter of its stated top speed. The deadband stops it buzzing around zero.
    if (Math.abs(vf) > 0.05) Flong -= Math.sign(vf) * T.rollingResistance * load;

    // Lateral demand: kill the sideways slip within this step, which is what a tyre
    // actually tries to do. The friction circle below decides how much of that it gets.
    const Flat = -vr * b.mass / (this.wheels.length * Math.max(h, 1e-4));

    // ---- friction circle. One grip budget shared between turning and accelerating, so
    // power-on mid-corner breaks traction instead of magically adding cornering force.
    const capLong = T.gripLong * load;
    const capLat = T.gripLat * load;
    let fl = clamp(Flong, -capLong, capLong);
    let ft = clamp(Flat, -capLat, capLat);
    const demand = Math.hypot(fl / Math.max(capLong, 1e-6), ft / Math.max(capLat, 1e-6));
    if (demand > 1) { fl /= demand; ft /= demand; }
    // Handbrake deliberately spends the rear grip budget, which is how you get the car
    // to rotate — clamping lateral force is the whole trick.
    if (this.handbrake && !wh.steered) ft *= 0.35;
    wh.slip = clamp(demand, 0, 2);

    pending.push(wh.contact, vadd(vmul(wFwd, fl * h), vmul(wRight, ft * h)));
    return true;
  }

  _drivenCount() {
    let n = 0;
    for (const wh of this.wheels) if (wh.driven) n++;
    return n || 1;
  }

  /**
   * Wheels ride where the chassis puts them, so if the chassis loses the voxels a wheel is
   * mounted to, that corner should stop working. Called after the chassis takes damage.
   */
  syncDamage() {
    const b = this.body;
    if (!b.alive || b.mass <= 0) { this.alive = false; return; }
    for (const wh of this.wheels) {
      // a mount whose surrounding cells are gone no longer drives or steers
      if (!this._mountIntact(wh)) { wh.driven = false; wh.steered = false; }
    }
    if (this.wheels.every((wh) => !wh.driven)) this.driveHealth = 0;
  }

  _mountIntact(wh) {
    const b = this.body;
    // mount is relative to the centre of mass; convert back to the local lattice
    const lx = Math.round((wh.mount[0] + b.com[0]) / VOXEL);
    const ly = Math.round((wh.mount[1] + b.com[1]) / VOXEL);
    const lz = Math.round((wh.mount[2] + b.com[2]) / VOXEL);
    for (let dy = 0; dy <= 2; dy++) {
      const y = ly + dy;
      if (lx < 0 || y < 0 || lz < 0 || lx >= b.dim[0] || y >= b.dim[1] || lz >= b.dim[2]) continue;
      if (b.data[b.li(lx, y, lz)] !== 0) return true;
    }
    return false;
  }

  /** Wheel transforms for the renderer: world centre, plus the axes to orient the disc. */
  wheelTransforms() {
    const b = this.body;
    const R = b.R;
    const out = [];
    for (const wh of this.wheels) {
      const drop = wh.grounded
        ? this.tuning.suspensionRest + this.tuning.suspensionTravel * (1 - wh.compression)
        : this.tuning.suspensionRest + this.tuning.suspensionTravel;
      const localCentre = [wh.mount[0], wh.mount[1] - drop, wh.mount[2]];
      out.push({
        pos: vadd(b.pos, m3MulVec(R, localCentre)),
        steer: wh.steer,
        spin: wh.spin,
        radius: wh.radius,
        grounded: wh.grounded,
        slip: wh.slip,
      });
    }
    return out;
  }
}

/**
 * Build a vehicle from voxels already in the world (the level's parked car, say).
 *
 * `wheelMounts` are given in *voxel* coordinates within the lifted lattice, which is how
 * a level author naturally thinks about it; they are converted to centre-of-mass-relative
 * metres here so nothing downstream has to know about the lattice origin.
 */
export function vehicleFromVoxels(voxels, palette, wheelMounts, opts = {}) {
  const body = VoxelBody.fromVoxels(voxels, palette, opts);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (const v of voxels) {
    if (v[0] < minX) minX = v[0];
    if (v[1] < minY) minY = v[1];
    if (v[2] < minZ) minZ = v[2];
  }
  // + 0.5 puts the mount at the voxel's *centre*. The centre of mass is computed from
  // voxel centres, so measuring mounts from voxel corners offsets every wheel by half a
  // voxel against it — the left and right wheels ended up 0.70 m and 0.60 m from the
  // centreline, and the car drove in a slow constant curve that looked like a physics bug
  // rather than an arithmetic one.
  const wheels = wheelMounts.map((m) => new Wheel([
    (m.at[0] - minX + 0.5) * VOXEL - body.com[0],
    (m.at[1] - minY + 0.5) * VOXEL - body.com[1],
    (m.at[2] - minZ + 0.5) * VOXEL - body.com[2],
  ], m));
  return new Vehicle(body, wheels, opts.tuning || {});
}
