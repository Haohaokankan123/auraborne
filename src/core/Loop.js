// src/core/Loop.js
//
// Fixed-timestep game loop with a render interpolation alpha.
//
// This file is the heartbeat of the game. It separates two different "clocks":
//
//   1. The PHYSICS clock, which must tick at a perfectly steady rate (60 times
//      per second) so that the simulation is deterministic. Determinism matters
//      because the same physics code will later run on a server, and the client
//      and server must agree on the result of identical inputs. If physics
//      advanced by a variable amount each frame, two machines running at
//      different frame rates would diverge.
//
//   2. The RENDER clock, which runs as fast as the browser will paint (via
//      requestAnimationFrame, "rAF"). Rendering can happen more or less often
//      than physics, so we hand the renderer an "alpha" value telling it how
//      far it is between the previous physics state and the current one, so it
//      can smoothly interpolate and avoid visual stutter.
//
// The technique implemented here is the classic "accumulator" pattern described
// in Glenn Fiedler's article "Fix Your Timestep!"
// (https://gafferongames.com/post/fix_your_timestep/).

// The loop also hosts the ADAPTIVE-RESOLUTION GOVERNOR. We already measure the
// real per-frame time here, so it's the natural place to watch the 16.6ms budget
// and, when a weak GPU can't hold it, ask the Renderer to drop its render scale
// (fewer pixels) until the frame rate recovers — then ramp back up when headroom
// returns. The governor only ever scales DOWN from the tier cap, so it can never
// add cost; on a Chromebook it's the safety net that keeps the 60fps target.
import qualitySettings from './QualitySettings.js';

// The fixed physics step, in seconds. 1/60 means physics advances in slices of
// exactly 16.666... milliseconds. Exported so other modules (and the future
// server) use the EXACT same step value — they must match for determinism.
export const DT = 1 / 60;

// The largest real time we will ever process in a single frame, in seconds.
// If the tab is backgrounded or the machine hitches, a huge amount of real time
// can pass between two rAF callbacks. Without a clamp we would try to run
// hundreds of physics steps to "catch up", which takes even longer, which
// produces an even bigger gap next frame — a feedback loop known as the
// "spiral of death". Clamping the per-frame delta to 0.25s caps the catch-up
// work at a fixed maximum (0.25 / DT = 15 steps) so the loop can never spiral.
const MAX_FRAME_DELTA = 0.25;

// --- ADAPTIVE-RESOLUTION GOVERNOR tuning --------------------------------------
// All times are in MILLISECONDS (the EMA tracks frame time in ms). The render
// loop is vsync-capped, so a frame can't run much FASTER than the refresh
// interval (≈16.67ms on a 60Hz panel) even with spare GPU headroom — which means
// we can only directly MEASURE "too slow" (frames overshooting the interval), not
// "how much headroom is left". So the governor scales DOWN when the smoothed frame
// time sits above the budget, and OPTIMISTICALLY tries to scale back UP after a
// long stretch of comfortably-on-budget frames; if that overshoots, it just drops
// again (a stable hunt around the best resolution the GPU can hold).
const GOV_EMA_ALPHA = 0.1;     // frame-time smoothing (≈10-frame window)
const GOV_DOWN_MS = 18.5;      // EMA above this ⇒ missing vsync (≈<54fps) ⇒ count toward a step DOWN
const GOV_UP_MS = 16.9;        // EMA at/below this ⇒ holding the refresh ⇒ count toward a step UP
const GOV_DOWN_FRAMES = 30;    // ~0.5s sustained slowness before stepping down (responsive, not twitchy)
const GOV_UP_FRAMES = 150;     // ~2.5s sustained smoothness before reclaiming resolution
const GOV_STEP = 0.15;         // render-scale change per step (1.0 → 0.85 → 0.70 → tier floor)
const GOV_SPIKE_MS = 100;      // ignore one-off hitches (tab switch, GC) so they don't trip a drop

export class GameLoop {
  // update(dt): called at a FIXED 60Hz. dt is always exactly DT seconds.
  // render(alpha): called once per animation frame. alpha is in [0, 1) and
  //   represents how far the render time sits between the last completed
  //   physics state (alpha = 0) and the next one (alpha approaching 1).
  constructor(update, render) {
    this.update = update;
    this.render = render;

    // Timestamp (from performance.now(), in milliseconds) of the previous
    // frame. Used to measure how much real time elapsed since last frame.
    this.lastTime = 0;

    // The accumulator stores leftover real time (in seconds) that has not yet
    // been consumed by a fixed physics step. Each frame we add the elapsed
    // real time to it, then drain it DT at a time. Whatever is left over (less
    // than one full DT) stays in the accumulator and becomes the interpolation
    // alpha for rendering.
    this.accumulator = 0;

    // Whether the loop is currently running. Guards against double-starts and
    // lets stop() cancel the pending animation frame.
    this.running = false;

    // The id returned by requestAnimationFrame, so stop() can cancel it.
    this.rafId = 0;

    // Bind the frame method once so we can pass it to requestAnimationFrame and
    // still cancel/re-register the same function reference each frame.
    this._frame = this._frame.bind(this);

    // ADAPTIVE-RESOLUTION GOVERNOR state. frameTimeEMA is the smoothed per-frame
    // time in ms (exposed for debug/HUD); _govScale is the render scale the
    // governor currently commands (1 = full tier resolution). The two counters
    // accumulate consecutive over-/under-budget frames toward a step.
    this.frameTimeEMA = 1000 / 60; // seed at one 60Hz frame so we don't start "slow"
    this._govScale = 1;
    this._govDownFrames = 0;
    this._govUpFrames = 0;
  }

  // Begin running the loop. Safe to call only when stopped.
  start() {
    if (this.running) {
      return;
    }
    this.running = true;

    // Seed lastTime with "now" so the first frame measures a tiny delta instead
    // of the entire time since the page loaded (which would otherwise dump a
    // huge value into the accumulator on frame one).
    this.lastTime = performance.now();
    this.accumulator = 0;

    this.rafId = requestAnimationFrame(this._frame);
  }

  // Stop running the loop and cancel the pending animation frame.
  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // The per-frame callback driven by requestAnimationFrame.
  // `now` is supplied by the browser and is a high-resolution timestamp in
  // milliseconds, equivalent to performance.now().
  _frame(now) {
    if (!this.running) {
      return;
    }

    // Schedule the next frame immediately so the loop keeps going even if the
    // work below throws (the browser will still call us again next paint).
    this.rafId = requestAnimationFrame(this._frame);

    // How much real time passed since the previous frame, converted from
    // milliseconds to seconds (our physics works in seconds).
    let frameDelta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Feed the REAL (pre-clamp) frame time to the adaptive-resolution governor so
    // it can watch the 16.6ms budget. Done before the clamp because the clamp
    // exists to protect the physics accumulator, not the timing measurement.
    this._tickGovernor(frameDelta * 1000);

    // Clamp to avoid the spiral of death (see MAX_FRAME_DELTA above). After a
    // long stall we deliberately "drop" the extra time rather than try to
    // simulate all of it at once.
    if (frameDelta > MAX_FRAME_DELTA) {
      frameDelta = MAX_FRAME_DELTA;
    }

    // Bank this frame's real time into the accumulator.
    this.accumulator += frameDelta;

    // Drain the accumulator one fixed step at a time. Each iteration advances
    // the simulation by exactly DT seconds. Because we only ever subtract whole
    // DT slices, the physics is fully deterministic and independent of the
    // render frame rate: a 30fps machine and a 144fps machine both run the same
    // number of DT steps for the same amount of elapsed real time.
    while (this.accumulator >= DT) {
      this.update(DT);
      this.accumulator -= DT;
    }

    // Whatever real time is left in the accumulator is less than one DT. As a
    // fraction of DT it tells the renderer how far we are toward the NEXT
    // physics step, so it can interpolate between the last two states and draw
    // a smooth in-between frame. alpha is therefore always in [0, 1).
    const alpha = this.accumulator / DT;
    this.render(alpha);
  }

  // ADAPTIVE-RESOLUTION GOVERNOR. Called once per frame with the real frame time
  // (ms). Smooths it into frameTimeEMA, then steps the render scale down when the
  // EMA sits above budget for GOV_DOWN_FRAMES, or back up after GOV_UP_FRAMES of
  // comfortably-on-budget frames. The chosen scale is handed to the Renderer via
  // the QualitySettings bridge (renderer.setRenderScale), which only rebuilds the
  // render targets when the scale actually changes — so this is ~free per frame.
  // @param {number} frameMs - real time since the previous frame, in milliseconds.
  // @private
  _tickGovernor(frameMs) {
    // Ignore one-off hitches (backgrounded tab, GC pause): a single 250ms stall
    // must not yank the resolution down for a problem that's already gone.
    if (frameMs > GOV_SPIKE_MS) return;

    this.frameTimeEMA += (frameMs - this.frameTimeEMA) * GOV_EMA_ALPHA;
    const ema = this.frameTimeEMA;

    // Tally consecutive over-/under-budget frames; the opposite condition resets
    // the other tally. Frames in the dead zone between the two thresholds leave
    // both tallies untouched (neither ramping), which is the hysteresis that
    // stops the governor oscillating around the boundary.
    if (ema > GOV_DOWN_MS) {
      this._govDownFrames++;
      this._govUpFrames = 0;
    } else if (ema < GOV_UP_MS) {
      this._govUpFrames++;
      this._govDownFrames = 0;
    }

    const floor = qualitySettings.getConfig().renderScaleFloor || 0.6;
    if (this._govDownFrames >= GOV_DOWN_FRAMES && this._govScale > floor) {
      this._govScale = Math.max(floor, this._govScale - GOV_STEP);
      this._govDownFrames = 0;
      qualitySettings.applyRenderScale(this._govScale);
    } else if (this._govUpFrames >= GOV_UP_FRAMES && this._govScale < 1) {
      this._govScale = Math.min(1, this._govScale + GOV_STEP);
      this._govUpFrames = 0;
      qualitySettings.applyRenderScale(this._govScale);
    }
  }
}
