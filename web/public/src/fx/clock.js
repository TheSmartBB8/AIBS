// clock.js — the fixed-timestep accumulator every FX subsystem runs on.
//
// Two things depend on this. Determinism: a replay recorded at 144 Hz must produce the
// same fire and the same smoke when played back at 31 Hz, so the simulation may never
// see a raw frame delta. Stability: smoke drag and buoyancy are integrated explicitly,
// and an explicit integrator with a variable dt changes behaviour with frame rate.
//
// The subtle part is *how* the accumulator counts. The obvious `accum += dt; while
// (accum >= FIXED)` drifts: summing 1/144 fourteen-hundred-and-forty times and summing
// 1/31 three-hundred-and-ten times both "equal" 10 seconds but differ in the last bits,
// and if 10 s lands exactly on a step boundary the two runs disagree about whether the
// 600th step has happened. So we keep a float wall clock, snap it to an integer tick
// grid (1/60000 s), and derive the step count from the grid. Rounding absorbs the
// float noise and both frame rates agree on the step count for the same elapsed time.

export const TICKS_PER_SECOND = 60000;

export class FixedStepper {
  /**
   * @param {number} fixedDt        seconds per simulation step (must divide the tick grid)
   * @param {number} maxStepsPerUpdate catch-up limit; see advance()
   */
  constructor(fixedDt = 1 / 60, maxStepsPerUpdate = 8) {
    this.fixedDt = fixedDt;
    this.stepTicks = Math.max(1, Math.round(fixedDt * TICKS_PER_SECOND));
    this.maxStepsPerUpdate = maxStepsPerUpdate;
    this.wallSeconds = 0;
    this.stepsDone = 0;
    this.droppedSteps = 0;
  }

  /** Number of fixed steps owed for a frame of `dt` seconds. */
  advance(dt) {
    if (!(dt > 0)) return 0;                      // NaN, 0 and negative deltas are no-ops
    this.wallSeconds += dt;
    const targetSteps = Math.floor(Math.round(this.wallSeconds * TICKS_PER_SECOND) / this.stepTicks);
    let want = targetSteps - this.stepsDone;
    if (want <= 0) return 0;
    if (want > this.maxStepsPerUpdate) {
      // A real hitch (alt-tab, level load). Catching up fully would stall the next frame
      // too and spiral. We drop the surplus instead — the only path in the FX layer that
      // is not frame-rate independent, and it only trips on a stall, never in a replay.
      const dropped = want - this.maxStepsPerUpdate;
      this.stepsDone += dropped;
      this.droppedSteps += dropped;
      want = this.maxStepsPerUpdate;
    }
    this.stepsDone += want;
    return want;
  }

  /** Simulated time, in whole steps — never the wall clock. */
  get time() { return this.stepsDone * this.fixedDt; }

  /** Fraction of a step already elapsed, for render-side interpolation. */
  get alpha() {
    const t = Math.round(this.wallSeconds * TICKS_PER_SECOND) - this.stepsDone * this.stepTicks;
    return Math.min(1, Math.max(0, t / this.stepTicks));
  }

  reset() { this.wallSeconds = 0; this.stepsDone = 0; this.droppedSteps = 0; }
}
