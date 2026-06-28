// shared/kartModel.js
//
// The deterministic arcade kart model: pure math, no rendering.
// This file is SHARED between the browser client and the (future) server,
// so it MUST stay pure — NO three import, NO DOM, NO Math.random.
//
// "Deterministic" means: given the same starting state, the same input, and
// the same dt, stepKart always produces the exact same new state. That lets
// the server re-run the simulation and match the client (needed for netcode).
//
// "Framerate-independent" means: every speed/angle change is multiplied by dt
// (seconds elapsed this step). Running at 30 fps or 144 fps yields the same
// motion over the same wall-clock time, as long as dt is honest.
//
// Coordinate convention (matches the rest of the project):
//   - Y is up. The track lies in the XZ plane. World units are meters.
//   - heading is an angle in radians around the Y axis.

import { PHYSICS, DRIFT, EFFECTS, STAT_RANGES, TRICK, OVERDRIVE } from './constants.js';
// ANTI-GRAV (MK8-style wall/ceiling riding): pure track helpers used ONLY by the
// surface-relative in-section branch below. Both are pure shared modules (no three,
// no DOM, no Math.random) and trackData NEVER imports kartModel, so there is no
// cycle. This couples kartModel to track DATA (gated behind state.agSection>=0), which
// is far lazier than threading 9 basis numbers through all three callers' stepKart.
import { surfaceFrameAt, getLapLength, getHalfWidth } from './trackData.js';

// --- M5: PER-KART STAT PROFILE ------------------------------------------
// A "stat profile" is six numbers, each normalized to 0.0..1.0 (0 = worst of
// that stat, 1 = best). The customization layer (src/data/*) builds these from
// a chosen character + kart body + wheels; the model only ever reads them.
//
// NEUTRAL_STATS is the default used when a kart is created with no stats. Every
// value is 0.5, which — because each STAT_RANGES band is symmetric about 1.0 —
// makes every derived multiplier exactly 1.0. That is the whole backward-compat
// guarantee: no stats => neutral => identical to the pre-M5 model.
export const NEUTRAL_STATS = {
  topSpeed: 0.5,
  accel: 0.5,
  handling: 0.5,
  weight: 0.5,
  traction: 0.5,
  miniTurbo: 0.5,
};

/**
 * Clamp one stat value into the legal 0..1 band. Non-numbers (undefined, NaN)
 * fall back to the neutral 0.5 so a partial/garbage profile can never break the
 * sim or knock a kart off the backward-compatible neutral baseline.
 *
 * @param {number} v - a raw stat value.
 * @returns {number} v clamped to [0, 1], or 0.5 if v is not a finite number.
 * @private
 */
function clampStat(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Normalize an arbitrary stats object into a complete, clamped stat profile.
 * Missing fields default to neutral (0.5); out-of-range fields are clamped. The
 * result always has all six keys, so stepKart can read them without guards.
 *
 * @param {object} [stats] - partial/raw stat profile (any subset of the 6 keys).
 * @returns {{topSpeed:number,accel:number,handling:number,weight:number,traction:number,miniTurbo:number}}
 * @private
 */
function normalizeStats(stats) {
  if (!stats) return { ...NEUTRAL_STATS };
  return {
    topSpeed: clampStat(stats.topSpeed),
    accel: clampStat(stats.accel),
    handling: clampStat(stats.handling),
    weight: clampStat(stats.weight),
    traction: clampStat(stats.traction),
    miniTurbo: clampStat(stats.miniTurbo),
  };
}

/**
 * Linearly interpolate a stat (0..1) into a multiplier between min and max.
 *   mult = min + stat * (max - min)
 * With the symmetric STAT_RANGES bands, stat 0.5 returns exactly the midpoint
 * (1.0 for every band), which is what keeps the neutral profile identical to
 * the legacy physics.
 *
 * @param {number} stat - normalized stat value 0..1 (already clamped).
 * @param {number} min  - multiplier at stat 0.
 * @param {number} max  - multiplier at stat 1.
 * @returns {number} the interpolated multiplier.
 * @private
 */
function statMult(stat, min, max) {
  return min + stat * (max - min);
}

/**
 * Create a fresh kart state object.
 *
 * @param {object} opts - optional overrides merged in last (e.g. spawn x/z/heading).
 * @returns {object} kart state (see fields below).
 *
 * Core (M1) fields:
 *   x, y, z   - world position in meters (y is the ground height the renderer reads).
 *   heading   - facing angle in radians (see the forward-vector note in stepKart).
 *   speed     - signed scalar speed in m/s. Positive = forward, negative = reverse.
 *   surface   - 'road' | 'offroad' | 'boost' | 'ramp'. Set by the caller each tick
 *               from the (now hilly) track sampler; drives the top-speed/accel caps.
 *
 * Terrain / jump (TERRAIN) fields — y now RIDES HILLS and karts can JUMP:
 *   vy        - vertical velocity in m/s (only meaningful while airborne; 0 on the ground).
 *   airborne  - boolean: true while the kart is in a jump arc (launched off a ramp).
 *   gliding   - boolean: true while in a GLIDE (a floaty, strongly-steerable descent
 *               off a `glide` ramp). Set true by the caller right after launchKart on a
 *               glide ramp; updateVertical uses GLIDE_GRAVITY/GLIDE_STEER_MULT/GLIDE_DRAG
 *               while it is true and CLEARS it (back to false) on ground contact.
 *   lean      - radians: visual body ROLL into the current turn (steer x speed). VISUAL
 *               ONLY — set by stepKart, read by the renderer; never affects handling.
 *   pitch     - radians: visual nose pitch under accel (nose up) / brake (nose down).
 *   suspension- 0..1 visual compression that spikes on a landing then springs back.
 *   groundY   - the track centerline elevation under the kart, in meters. The CALLER
 *               (RaceManager/server) sets this every tick BEFORE stepKart from
 *               trackData.sampleSurface(...).groundY. stepKart eases state.y toward it
 *               while grounded so hills are followed identically client + server.
 *   slope     - signed d(y)/d(arclength) along the driving tangent (+ = uphill). The
 *               CALLER sets this every tick before stepKart; stepKart applies a gentle
 *               speed effect from it (uphill bleeds speed, downhill adds a little).
 *
 * Drift / mini-turbo (M2) fields — written by stepKart, read by render/HUD/FX:
 *   drifting      - boolean: true while a drift slide is active.
 *   driftDir      - -1 (left) / +1 (right) / 0 (not drifting). Locked when a drift starts.
 *   driftCharge   - seconds of continuous drift accumulated (resets on release).
 *   miniTurboTier - 0 none / 1 blue / 2 orange / 3 purple, derived from driftCharge.
 *   boostTimer    - seconds of active mini-turbo boost remaining (surge while > 0).
 *   hopTimer      - seconds left in the initial drift hop (> 0 during the pop-up).
 *
 * Items / status effects (M3) fields — written by stepKart + the pure helpers
 * below (applySpin/applyStar/applyShrink/addCoin), read by render/HUD/FX:
 *   spinTimer     - seconds left spinning out: input is ignored and speed bleeds.
 *   starTimer     - seconds left invincible: cannot be spun, small top-speed bump.
 *   shrinkTimer   - seconds left shrunk: reduced top speed while tiny.
 *   coins         - 0..EFFECTS.COIN_MAX coins held; each adds a flat top-speed bonus.
 *
 * Stats (M5) field:
 *   stats - a normalized stat profile { topSpeed, accel, handling, weight,
 *           traction, miniTurbo }, each 0..1. stepKart scales the effective
 *           physics by these. Defaults to NEUTRAL_STATS (all 0.5) when not
 *           supplied, which is identical to the pre-M5 physics.
 *
 * @param {object} opts - optional overrides. Recognized: opts.stats (a partial
 *        or full stat profile, normalized + clamped here) plus any state field
 *        override (e.g. spawn x/z/heading). Note: opts.stats is consumed before
 *        the spread, so it cannot accidentally overwrite the normalized profile.
 */
export function createKartState(opts = {}) {
  // Pull stats out of opts so the spread below can't clobber the normalized
  // profile with the raw (possibly partial) one. Everything else in opts is
  // still spread as a plain state override, exactly as before.
  const { stats, ...rest } = opts;
  return {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    speed: 0,
    // --- Analog steer ramp + slip-angle travel direction (deterministic feel) ---
    //   steerActual - input.steer eased through an asymmetric ramp (turn-in vs return);
    //                 drives ALL continuous yaw so a keyboard's instant 0->1 steer no
    //                 longer snaps the kart. A gamepad stick is already smooth (near-no-op).
    //   velHeading  - the TRAVEL-direction yaw (position advances along THIS). It eases
    //                 toward heading fast when grounded & not drifting (straight-line feel
    //                 ~unchanged) and slowly while drifting, so the facing LEADS the travel
    //                 (a tail-out slide). Clamped to within DRIFT_SLIP_MAX of heading so the
    //                 kart slides, never spins. Defaults 0 (== the default heading) — at any
    //                 spawn/respawn speed is 0, so the first-tick ease toward heading is invisible.
    steerActual: 0,
    velHeading: 0,
    surface: 'road',
    // --- TERRAIN: hill-riding + jumps (all start neutral / grounded) ---
    // vy/airborne are owned by stepKart + launchKart. groundY/slope are set by
    // the CALLER each tick (default 0 keeps a flat-ground / legacy world unchanged:
    // groundY 0 means y eases toward 0, slope 0 means no slope speed effect).
    vy: 0, // vertical velocity (m/s); only nonzero while airborne
    airborne: false, // true during a ramp jump arc
    airTime: 0, // s spent in the current jump arc; ramps air-steer grip in (reset on launch + landing)
    gliding: false, // true while in a GLIDE (floaty, strongly-steerable descent off a glide ramp)
    groundY: 0, // centerline elevation under the kart (caller-set); y rides toward it
    slope: 0, // signed d(y)/ds along driving tangent (caller-set); + = uphill
    // --- R12 suspension / lean FEEL (visual only; renderer reads these) ---
    // lean = body ROLL into the current turn (steer x speed); pitch = nose
    // up/down under accel/brake; suspension = 0..1 compression that spikes on a
    // landing then springs back. stepKart/updateVertical SET these; Kart.js TILTS
    // + SQUASHES the mesh from them. They never feed back into handling. Default
    // 0 keeps any kart that ignores them (or the server) visually neutral.
    lean: 0, // radians: body roll into turns (+ = roll right)
    pitch: 0, // radians: nose pitch under accel(+up)/brake(-down)
    suspension: 0, // 0..1 compression (peaks on landing, springs back to 0)
    // --- M2 drift / mini-turbo state (all start neutral) ---
    drifting: false, // true while sliding
    driftDir: 0, // -1 left / +1 right / 0 none (locked at drift start)
    driftCharge: 0, // s of continuous drift banked toward the next tier
    miniTurboTier: 0, // 0 none / 1 blue / 2 orange / 3 purple
    boostTimer: 0, // s of boost surge still to apply
    hopTimer: 0, // s remaining in the start-of-drift hop
    // --- M3 item / status-effect state (all start neutral) ---
    spinTimer: 0, // s left spinning out (hit by shell/banana); ignores input + bleeds speed
    starTimer: 0, // s left invincible (star power-up); cannot be spun + small speed bump
    shrinkTimer: 0, // s left shrunk (lightning); reduced top speed while tiny
    coins: 0, // 0..EFFECTS.COIN_MAX coins held; each adds a flat top-speed bonus
    // --- AIR-TRICK + OVERDRIVE state (signature hook; all start neutral) ----
    // These are part of the DETERMINISTIC state (set on every relevant path), but
    // every default 0/false so a kart that never tricks / never fills overdrive is
    // byte-identical to the pre-trick model (no code path below activates).
    trickActive: false, // true while banking style in the CURRENT mid-air arc
    trickStyle: 0, // style banked THIS air session (cashed + reset on landing)
    trickRot: 0, // rad of VISUAL barrel-roll for the mesh (does NOT change heading)
    trickLandStyle: 0, // transient: style of the LAST clean landing; set on land, read+cleared by render/HUD/SFX (0 = none)
    overdrive: 0, // 0..1 charge meter (fills from tricks + mini-turbos)
    overdriveTimer: 0, // s of active overdrive surge remaining
    // --- ANTI-GRAV (MK8 wall/ceiling riding) — all inert by default -----------
    // agSection -1 = the NORMAL world model (gate OFF); >=0 = index of the anti-grav
    // section the kart is inside (surface-relative). When inert (-1) NO code path
    // below activates, so a legacy / no-anti-grav kart is byte-identical to before.
    // agS/agLateral/agHeading are the authoritative surface-relative coords while in
    // a section; agTrackId is set by updateAntigravTransition so stepKart's pure
    // in-section branch can re-derive the surface frame.
    agSection: -1, // gate: -1 normal model / >=0 inside an anti-grav section
    agS: 0,        // authoritative spline-param progress while in-section
    agLateral: 0,  // signed-left offset across the tube (m)
    agHeading: 0,  // surface-plane travel yaw (rad; 0 = down-track, + toward +right)
    agTrackId: null, // track id stamped by updateAntigravTransition (for surfaceFrameAt)
    // --- M5 per-kart stat profile (normalized + clamped; neutral by default) ---
    // Computed from opts.stats (pulled out above). No stats => NEUTRAL_STATS,
    // which keeps the kart identical to the pre-M5 model.
    stats: normalizeStats(stats),
    // Spread the REST of opts LAST so a caller can override any default above
    // (for example { x: 10, z: -4, heading: Math.PI } to set a spawn point).
    // opts.stats was already consumed, so it can't overwrite the profile here.
    ...rest,
  };
}

/**
 * Advance the kart state by one timestep.
 *
 * Mutates AND returns `state` (returning it is a convenience for chaining/tests).
 *
 * @param {object} state - a kart state from createKartState (mutated in place).
 * @param {object} input - input snapshot from core/Input.js getState():
 *        { steer:-1..1 (-1=left,+1=right), throttle:0..1, brake:0..1,
 *          drift:boolean, useItem:boolean, lookBack:boolean }
 * @param {number} dt    - timestep in seconds (normally PHYSICS.DT === 1/60).
 * @param {object} opts  - reserved for future per-kart tuning (unused in M1).
 * @returns {object} the same `state`, now advanced by dt.
 */
export function stepKart(state, input, dt, opts = {}) {
  // ----------------------------------------------------------------------
  // 0a. PER-KART STAT MULTIPLIERS (M5) — derive once, reuse this whole step.
  // ----------------------------------------------------------------------
  // Turn the kart's normalized stat profile (0..1 each) into physics
  // multipliers via STAT_RANGES. normalizeStats fills any missing/garbage field
  // with neutral 0.5, so a legacy state with no `stats` yields all-1.0
  // multipliers and the math below collapses to the exact pre-M5 behaviour.
  // Deterministic: depends only on state.stats (constant per kart).
  const stats = normalizeStats(state.stats);
  const topSpeedMult = statMult(
    stats.topSpeed,
    STAT_RANGES.TOP_SPEED_MULT_MIN,
    STAT_RANGES.TOP_SPEED_MULT_MAX,
  );
  const accelMult = statMult(stats.accel, STAT_RANGES.ACCEL_MULT_MIN, STAT_RANGES.ACCEL_MULT_MAX);
  const handlingMult = statMult(
    stats.handling,
    STAT_RANGES.HANDLING_MULT_MIN,
    STAT_RANGES.HANDLING_MULT_MAX,
  );
  const miniTurboMult = statMult(
    stats.miniTurbo,
    STAT_RANGES.MINI_TURBO_MULT_MIN,
    STAT_RANGES.MINI_TURBO_MULT_MAX,
  );
  // traction scales the offroad penalty (step 1) and the brake bite (step 2);
  // weight scales suspension spring-back (step 4b) and — inverted around 1.0 via
  // driftWeightMult — the drift yaw (step 3), so a lighter kart rotates a touch
  // faster in a slide and a heavier one runs a wider, more planted arc. Both are
  // 1.0 at neutral 0.5, so a no-stats kart is byte-identical to before.
  const tractionMult = statMult(
    stats.traction,
    STAT_RANGES.TRACTION_MULT_MIN,
    STAT_RANGES.TRACTION_MULT_MAX,
  );
  const weightMult = statMult(stats.weight, STAT_RANGES.WEIGHT_MULT_MIN, STAT_RANGES.WEIGHT_MULT_MAX);
  const driftWeightMult = 2 - weightMult; // invert weight around 1.0: heavy<1 (planted), light>1 (nimble)

  // ----------------------------------------------------------------------
  // 0aa. ANALOG STEER RAMP — ease steerActual toward input.steer (deterministic).
  // ----------------------------------------------------------------------
  // A keyboard snaps steer 0->1 instantly, which darts the kart. Ease a private
  // state.steerActual toward input.steer with ASYMMETRIC rates — quicker to return
  // to center (STEER_CENTER_RATE) than to turn in (STEER_TURN_RATE) — and use
  // steerActual for ALL continuous yaw below (steps 3 / 4b lean / the anti-grav
  // branch). A gamepad stick is already analog so its steerActual tracks within a
  // frame or two (near-no-op). The DRIFT START still reads RAW input.steer (sign +
  // deadzone) in updateDrift, so a flick-into-drift still locks on frame 1.
  // Deterministic: only state.steerActual + input.steer + dt; framerate-independent.
  {
    const target = input.steer;
    const sameWay = Math.sign(target) === Math.sign(state.steerActual || target);
    const rampRate =
      Math.abs(target) > Math.abs(state.steerActual) && sameWay
        ? PHYSICS.STEER_TURN_RATE
        : PHYSICS.STEER_CENTER_RATE;
    state.steerActual += (target - state.steerActual) * (1 - Math.exp(-rampRate * dt));
  }

  // ----------------------------------------------------------------------
  // 0. DRIFT STATE MACHINE (M2) — decide drifting/driftDir/charge/boost.
  // ----------------------------------------------------------------------
  // This runs BEFORE the speed/steer math so steps 1–3 can read the resolved
  // drift state. It is the only place drift fields are set, keeping the model
  // deterministic: same state + same input.drift + same dt => same result.
  // miniTurboMult scales BOTH the charge accrual rate and the released boost
  // duration, so a high-miniTurbo kart banks tiers faster and surges longer.
  updateDrift(state, input, dt, miniTurboMult);

  // ----------------------------------------------------------------------
  // 0b. ITEM / STATUS-EFFECT TIMERS (M3) — decay the active effect clocks.
  // ----------------------------------------------------------------------
  // Each effect is just a countdown in seconds. They tick down on their own
  // clock here (deterministic: only state + dt), and the steps below read the
  // resolved timers. coins is not a timer — it's a held count, mutated by
  // addCoin(), so it is left untouched here.
  if (state.spinTimer > 0) {
    state.spinTimer -= dt;
    if (state.spinTimer < 0) state.spinTimer = 0;
  }
  if (state.starTimer > 0) {
    state.starTimer -= dt;
    if (state.starTimer < 0) state.starTimer = 0;
  }
  if (state.shrinkTimer > 0) {
    state.shrinkTimer -= dt;
    if (state.shrinkTimer < 0) state.shrinkTimer = 0;
  }

  // ----------------------------------------------------------------------
  // 0d. OVERDRIVE (signature hook) — spend a full meter for a strong surge.
  // ----------------------------------------------------------------------
  // state.overdrive (0..1) is CHARGED elsewhere: on clean trick landings (see
  // updateVertical) and each time a mini-turbo fires (see updateDrift). HERE the
  // player SPENDS it: pressing input.overdrive with a FULL meter and nothing
  // already running arms a fixed-DURATION surge and consumes the meter. While it
  // runs it ticks down; step 1 multiplies the forward cap by SPEED_MULT and step 3
  // scales the yaw by GRIP_EDGE (the handling "edge"). The meter consumption gates
  // re-triggering, so a held key can't restart it mid-surge. Deterministic: only
  // state + input.overdrive + dt. Neutral: no press / empty meter => no-op, and
  // gripMult/overdriveMult stay 1 so a kart that never overdrives is unchanged.
  if (state.overdriveTimer > 0) {
    state.overdriveTimer -= dt;
    if (state.overdriveTimer < 0) state.overdriveTimer = 0;
  } else if (input.overdrive && state.overdrive >= 1 && state.spinTimer <= 0) {
    state.overdriveTimer = OVERDRIVE.DURATION;
    state.overdrive = 0; // consume the full meter (not while spun out — don't waste it)
  }
  const overdriveActive = state.overdriveTimer > 0;
  const overdriveMult = overdriveActive ? OVERDRIVE.SPEED_MULT : 1; // step-1 cap boost
  const gripMult = overdriveActive ? OVERDRIVE.GRIP_EDGE : 1; // step-3 yaw "edge"

  // ----------------------------------------------------------------------
  // 1. Work out the top speed allowed by the current surface (and boost).
  // ----------------------------------------------------------------------
  // On 'offroad' the forward top speed is capped lower (grass/dirt slows you).
  // While a mini-turbo boost is active (boostTimer > 0) the top speed AND the
  // engine accel are scaled up by BOOST_MULT so the kart surges past the normal
  // cap. Reverse uses its own fixed cap and is not surface/boost-scaled.
  //
  // M3 layers two more multipliers and a flat coin bonus onto the forward cap:
  //   - star  (starTimer > 0)   : * STAR_SPEED_MULT   (small surge, >1)
  //   - shrink (shrinkTimer > 0) : * SHRINK_SPEED_MULT (slowed while tiny, <1)
  //     (if both somehow overlap they simply multiply — star partly offsets shrink)
  //   - coins                    : + COIN_SPEED_BONUS per coin (capped at COIN_MAX)
  // surface is now one of road|offroad|boost|ramp (set by the caller from the
  // track sampler). Only 'offroad' penalizes the kart — road/boost/ramp all keep
  // full grip (boost/ramp are still drivable track, not penalty surfaces). The
  // offroad penalty hits BOTH the top-speed cap (here) and the engine accel
  // (offroadAccelMult, applied in step 2), so leaving the road is heavy but
  // recoverable rather than a hard stop.
  // AIRBORNE EXEMPTION: while airborne the wheels aren't on any surface, so the
  // offroad penalty must NOT apply — otherwise a kart jumping a GAP (surface reads
  // 'offroad' over the carved void) has its horizontal speed bled to the offroad cap
  // mid-flight and stalls into the chasm. Gating on !airborne keeps the launch speed
  // across the gap (the slope effect at step ~390 is gated the same way).
  const offroad = state.surface === 'offroad' && !state.airborne;
  // tractionMult (M5) eases the offroad penalty for a high-traction kart, capped at
  // full road grip (Math.min(...,1)) so traction can never make grass faster than road.
  const surfaceMult = offroad ? Math.min(PHYSICS.OFFROAD_SPEED_MULT * tractionMult, 1) : 1;
  const offroadAccelMult = offroad ? Math.min(PHYSICS.OFFROAD_ACCEL_MULT * tractionMult, 1) : 1;
  const boostMult = state.boostTimer > 0 ? DRIFT.BOOST_MULT : 1;
  const starMult = state.starTimer > 0 ? EFFECTS.STAR_SPEED_MULT : 1;
  const shrinkMult = state.shrinkTimer > 0 ? EFFECTS.SHRINK_SPEED_MULT : 1;
  // Coin top-speed bonus: clamp the held coins to the cap first so a stray
  // over-cap value can't grant extra speed, then convert to m/s.
  const coinCount = Math.min(state.coins || 0, EFFECTS.COIN_MAX);
  const coinBonus = coinCount * EFFECTS.COIN_SPEED_BONUS;
  // topSpeedMult (M5) scales the base cap per-kart BEFORE the surface/boost/item
  // multipliers, so a faster kart's advantage scales with everything else and a
  // neutral kart (mult 1.0) is unchanged. The flat coin bonus is added last.
  // overdriveMult (signature hook) layers in alongside boostMult — 1.0 unless an
  // overdrive surge is active, so a kart that never overdrives is unchanged.
  const maxForward =
    PHYSICS.MAX_SPEED * topSpeedMult * surfaceMult * boostMult * starMult * shrinkMult * overdriveMult +
    coinBonus;

  // ----------------------------------------------------------------------
  // 0c. SPIN-OUT (M3) — if spinning, the player has no control this step.
  // ----------------------------------------------------------------------
  // While state.spinTimer > 0 the kart is spun out: throttle and steering are
  // ignored and the kart bleeds speed toward 0 by SPIN_SLOWDOWN. We do this as
  // an early-out so the normal throttle/brake/steer math below is skipped
  // entirely, then still advance the position so the kart coasts to a halt.
  // (Kart.js spins the whole group visually while spinTimer > 0.)
  if (state.spinTimer > 0) {
    const bleed = EFFECTS.SPIN_SLOWDOWN * dt;
    if (state.speed > bleed) {
      state.speed -= bleed; // forward momentum drags down
    } else if (state.speed < -bleed) {
      state.speed += bleed; // reverse momentum drags up toward 0
    } else {
      state.speed = 0; // close enough: snap to stopped
    }
    // ANTI-GRAV: a kart spun out ON a wall/ceiling stays magnetic-stuck — we just
    // re-derive its pose from the (frozen) surface frame so it doesn't drop off the
    // surface or teleport-back when the spin ends. Gated behind agSection>=0, so a
    // normal spin (the common case) runs the untouched world-relative coast below.
    // ponytail: position is frozen during the spin (losing ground is correct), which
    // avoids the metresPerU/clamp dance for a rare shell-on-the-corkscrew case.
    if (state.agSection >= 0) {
      state.vy = 0; state.airborne = false; state.gliding = false;
      const fr = surfaceFrameAt(state.agTrackId, state.agS, state.agLateral);
      state.x = fr.worldPos.x; state.y = fr.worldPos.y; state.z = fr.worldPos.z;
      const sch = Math.cos(state.agHeading), ssh = Math.sin(state.agHeading);
      state.heading = Math.atan2(
        fr.tangent.x * sch + fr.right.x * ssh,
        fr.tangent.z * sch + fr.right.z * ssh,
      );
      state.velHeading = state.heading; // freeze travel = facing where the pose freezes
      return state;
    }
    // Heading is frozen (no steering control); position still advances so the
    // kart keeps sliding forward as it slows. Uses the same forward-vector math
    // as step 4 below. velHeading is frozen onto heading so no stale drift slip
    // lingers into the recovery once the spin ends (applySpin already cleared the drift).
    state.velHeading = state.heading;
    const spinForwardX = Math.sin(state.heading);
    const spinForwardZ = Math.cos(state.heading);
    state.x += spinForwardX * state.speed * dt;
    state.z += spinForwardZ * state.speed * dt;
    // Still resolve vertical motion while spun out: a kart hit mid-jump must
    // keep falling, and a grounded spin must keep riding the hill under it.
    updateVertical(state, dt);
    return state;
  }

  // ----------------------------------------------------------------------
  // 2. Update speed from throttle / brake / coasting.
  // ----------------------------------------------------------------------
  // Priority: throttle accelerates forward; otherwise brake slows down and
  // (once stopped) reverses; otherwise the kart coasts toward 0.
  if (input.throttle > 0) {
    // Throttle pushes speed UP toward the (surface-capped) forward max.
    // boostMult amplifies the accel too, so a boost feels like a kick, not just
    // a higher ceiling you slowly creep toward. accelMult (M5) is the per-kart
    // acceleration stat; 1.0 for a neutral kart, so this stays legacy-identical.
    // offroadAccelMult bogs the engine down off the road (1.0 on road/boost/ramp).
    state.speed += PHYSICS.ENGINE_ACCEL * accelMult * boostMult * offroadAccelMult * input.throttle * dt;
  } else if (state.boostTimer > 0 && state.speed >= 0) {
    // Coasting WHILE boosting: the boost actively drives the kart up to the
    // raised cap even with no throttle held, so a released mini-turbo always
    // produces a visible surge. (Forward only — boost never pushes reverse.)
    state.speed += PHYSICS.ENGINE_ACCEL * accelMult * boostMult * offroadAccelMult * dt;
  } else if (input.brake > 0) {
    // Brake pushes speed DOWN. If we are already stopped or moving forward,
    // this slows us toward 0 and then keeps going into negative (reverse).
    // tractionMult (M5) scales the brake bite: a high-traction kart hauls down
    // harder; 1.0 at neutral so this stays legacy-identical without stats.
    state.speed -= PHYSICS.BRAKE_DECEL * tractionMult * input.brake * dt;
  } else {
    // Coasting: no throttle, no brake -> drift speed toward 0 by COAST_DECEL.
    // We never overshoot past 0, so the kart settles to a clean stop.
    const coast = PHYSICS.COAST_DECEL * dt;
    if (state.speed > coast) {
      state.speed -= coast; // still moving forward, ease down
    } else if (state.speed < -coast) {
      state.speed += coast; // still moving in reverse, ease down
    } else {
      state.speed = 0; // close enough to stopped: snap to exactly 0
    }
  }

  // ----------------------------------------------------------------------
  // 2b. SLOPE (TERRAIN) — ROLLERCOASTER uphill/downhill speed effect.
  // ----------------------------------------------------------------------
  // state.slope is the signed grade along the driving tangent (+ = uphill),
  // set by the caller from the track sampler. We turn it into an acceleration
  // (SLOPE_ACCEL * slope), clamp the magnitude so even a near-vertical drop
  // can't fling the engine, then bias speed by it: downhill (slope < 0) ADDS
  // speed, uphill (slope > 0) BLEEDS speed. Only applies while grounded (slope
  // is meaningless mid-jump) and only when actually rolling, so a parked kart
  // never creeps on a hill. Deterministic: depends only on state.slope + speed.
  //
  // R12: amplified so the tall hills / steep drops feel like a rollercoaster.
  // The DOWNHILL (speed-adding) side is allowed to overspeed past the rolling
  // cap (see SLOPE_OVERSPEED in the clamp below); the UPHILL side just bleeds.
  // We remember whether the slope pushed UP this step (downhillBoost) so the
  // clamp can grant the overspeed headroom only then.
  let downhillBoost = 0;
  if (!state.airborne && state.slope && Math.abs(state.speed) > 0.001) {
    let slopeAccel = -PHYSICS.SLOPE_ACCEL * state.slope; // downhill (slope<0) -> +; uphill -> -
    const cap = PHYSICS.SLOPE_ACCEL_CLAMP;
    if (slopeAccel > cap) slopeAccel = cap;
    else if (slopeAccel < -cap) slopeAccel = -cap;
    if (slopeAccel > 0) downhillBoost = slopeAccel; // rolling downhill: grant overspeed headroom
    state.speed += slopeAccel * dt;
  }

  // Clamp speed into the legal band: [ -REVERSE_MAX , maxForward ].
  // Rollercoaster overspeed: while a downhill is actively ADDING speed we let
  // the kart briefly exceed maxForward by up to SLOPE_OVERSPEED, so a steep
  // plunge genuinely pulls past the rolling cruise. The instant the ground
  // levels (downhillBoost == 0) the cap snaps back to maxForward, so the
  // overspeed washes off and the steady ~44 cruise is unchanged. Boosts still
  // exceed the cap via maxForward (boostMult) exactly as before.
  const forwardCap = downhillBoost > 0 ? maxForward + PHYSICS.SLOPE_OVERSPEED : maxForward;
  if (state.speed > forwardCap) {
    state.speed = forwardCap;
  } else if (state.speed < -PHYSICS.REVERSE_MAX) {
    state.speed = -PHYSICS.REVERSE_MAX;
  }

  // ----------------------------------------------------------------------
  // 3–5 (ANTI-GRAV variant) — SURFACE-RELATIVE wall/ceiling riding.
  // ----------------------------------------------------------------------
  // Gated behind agSection>=0. Inside an anti-grav section the kart is magnetic-
  // stuck to the (rolled) tube surface: steering rotates a travel yaw IN the surface
  // plane, motion advances TRACK-RELATIVE (down-track s + across-tube lateral), and
  // the world pose (x/y/z + heading) is DERIVED from the PURE surfaceFrameAt each
  // step — so a vertical wall / ceiling (multivalued heightfield y) is representable
  // and orientation is NEVER free-integrated (no per-machine float drift -> MP-safe).
  // The speed/drift/item/overdrive math above is reused verbatim; only the steer +
  // advance + vertical (steps 3,4,5) are swapped here. With agSection<0 this branch
  // never runs, so every normal section is byte-identical.
  if (state.agSection >= 0) {
    const trackId = state.agTrackId;
    const speedFactor = Math.min(Math.abs(state.speed) / PHYSICS.TURN_SPEED_REF, 1);
    const directionSign = Math.sign(state.speed);

    // STEER -> rotate the surface-plane travel yaw (SAME coefficients as the world-yaw
    // steering below; no airSteerMult — anti-grav is always grounded/magnetic).
    // INVERTED-CONTROL FIX: on the upside-down half of a corkscrew the surface up points
    // DOWN (fr.up.y < 0) and the chase camera has rolled past vertical WITH the kart, so a
    // fixed steer sign reads REVERSED to the player (A/D feel swapped on the ceiling). Flip
    // the steer there so left/right always match the player's rolled view. Pure
    // (surfaceFrameAt) + deterministic, so client and server stay byte-identical.
    const steerSign = surfaceFrameAt(trackId, state.agS, state.agLateral).up.y < 0 ? -1 : 1;
    if (state.drifting) {
      const steerToward = state.steerActual * state.driftDir;
      const arcFactor =
        1 + steerToward * DRIFT.COUNTER_STEER_INFLUENCE + (input.brake || 0) * DRIFT.BRAKE_DRIFT_TIGHTEN;
      state.agHeading -=
        steerSign * state.driftDir * PHYSICS.TURN_RATE * handlingMult * gripMult * driftWeightMult *
        DRIFT.DRIFT_TURN_MULT * arcFactor * dt * speedFactor;
    } else {
      state.agHeading -=
        steerSign * state.steerActual * PHYSICS.TURN_RATE * handlingMult * gripMult * dt * speedFactor * directionSign;
    }

    // GRAVITY = a magnetic stick toward the surface: the kart does NOT fall and is
    // never airborne in-section, so updateVertical is bypassed entirely (y comes ONLY
    // from the derived frame -> no vertical integration that could diverge).
    state.vy = 0;
    state.airborne = false;
    state.gliding = false;

    // ADVANCE the track-relative coords from the surface-velocity decomposition.
    const metersPerU = getLapLength(trackId) || 1;
    const along = state.speed * Math.cos(state.agHeading) * dt;  // metres down-track
    const across = state.speed * Math.sin(state.agHeading) * dt; // metres across the tube
    state.agS = ((state.agS + along / metersPerU) % 1 + 1) % 1;
    state.agLateral += across;

    // EDGE = the real ribbon edge (Track.js builds it at ±halfWidth). Inside the band
    // the kart is magnet-stuck (vy=0/airborne=false above); steering is FREE across the
    // tube — no clamp, no heading override — so the magnet HOLDS wherever you stop
    // steering, and being inverted never drops you. Cross the rim and you FALL OFF.
    const latMax = getHalfWidth(trackId); // true rim; was *0.9 — let the player ride to the edge
    if (Math.abs(state.agLateral) > latMax) {
      // STEERED PAST THE RIM: release the magnet -> airborne -> fall. Deterministic
      // (pure surfaceFrameAt + arithmetic), so client and server compute it byte-identically.
      const edge = state.agLateral > 0 ? latMax : -latMax;     // launch AT the rim
      const fr = surfaceFrameAt(trackId, state.agS, edge);
      const ch = Math.cos(state.agHeading), sh = Math.sin(state.agHeading);
      // 3D surface-forward = current travel direction (tangent/right orthonormal, ch^2+sh^2=1).
      const fwx = fr.tangent.x * ch + fr.right.x * sh;
      const fwy = fr.tangent.y * ch + fr.right.y * sh;
      const fwz = fr.tangent.z * ch + fr.right.z * sh;
      const hyp = Math.hypot(fwx, fwz) || 1e-6;                // horizontal fraction of travel
      const spd = state.speed;                                 // scalar surface speed (along unit fwd)
      // Convert surface velocity -> the normal model's (x/y/z, heading, speed, vy):
      state.x = fr.worldPos.x; state.y = fr.worldPos.y; state.z = fr.worldPos.z;
      state.heading = Math.atan2(fwx, fwz);                    // world yaw from XZ of travel
      state.velHeading = state.heading;                        // travel = facing as it leaves the surface
      state.speed = spd * hyp;                                 // horizontal scalar (vx = sin*speed = fwx*spd)
      state.vy = spd * fwy;                                    // keep any wall-climb vertical momentum
      state.airborne = true;
      state.gliding = false;
      state.agSection = -1;                                    // leave the section
      return state;                                            // next tick runs the normal airborne path
    }

    // DERIVE the world pose from the surface frame (the ONLY source of x/y/z +
    // orientation in-section).
    const fr = surfaceFrameAt(trackId, state.agS, state.agLateral);
    state.x = fr.worldPos.x;
    state.y = fr.worldPos.y;
    state.z = fr.worldPos.z;
    // world-yaw heading = XZ projection of the surface forward, so the mesh yaw AND
    // all the XZ lap/checkpoint/standings logic keep working unchanged.
    const ch = Math.cos(state.agHeading), sh = Math.sin(state.agHeading);
    const fwx = fr.tangent.x * ch + fr.right.x * sh;
    const fwz = fr.tangent.z * ch + fr.right.z * sh;
    state.heading = Math.atan2(fwx, fwz);
    state.velHeading = state.heading; // surface-relative motion already IS the travel; keep velHeading aligned

    // COSMETIC lean/pitch/suspension (R12, visual only) — same easing as step 4b so
    // the body banks into the corkscrew and the in/out transition doesn't pop the lean.
    const turnDir = state.drifting ? -(state.driftDir || 0) : -state.steerActual;
    const leanTarget = turnDir * speedFactor * PHYSICS.LEAN_ROLL_MAX;
    const leanAlpha = 1 - Math.exp(-PHYSICS.LEAN_RATE * dt);
    state.lean += (leanTarget - state.lean) * leanAlpha;
    const pitchInput = (input.throttle || 0) - (input.brake || 0);
    const pitchTarget = pitchInput * speedFactor * PHYSICS.LEAN_PITCH_MAX;
    state.pitch += (pitchTarget - state.pitch) * leanAlpha;
    if (state.suspension > 0) {
      const springAlpha = 1 - Math.exp(-PHYSICS.SUSPENSION_SPRING_RATE * weightMult * dt);
      state.suspension -= state.suspension * springAlpha;
      if (state.suspension < 0.0005) state.suspension = 0;
    }
    return state;
  }

  // ----------------------------------------------------------------------
  // 3. Steering: rotate the heading, scaled so you can't turn in place.
  // ----------------------------------------------------------------------
  // speedFactor ramps 0..1 with how fast we are going (either direction).
  // At a standstill it is 0, so steering does nothing — a kart only turns
  // while it is actually rolling. It reaches 1 at TURN_SPEED_REF and stays
  // capped at 1 above that.
  const speedFactor = Math.min(Math.abs(state.speed) / PHYSICS.TURN_SPEED_REF, 1);

  // While airborne the kart's wheels aren't on the ground, so steering bites
  // much less — fold airSteerMult into both the drift and normal yaw terms below.
  // 1.0 when grounded keeps the legacy/flat behaviour identical. Instead of an
  // instant cliff to AIR_STEER_MULT, a normal jump BLENDS the grip in over the
  // first AIR_STEER_BLEND_TIME (state.airTime, accumulated in updateVertical): the
  // launch frame keeps near-full grip to aim, fading to AIR_STEER_MULT as the kart
  // commits to the arc. GLIDE EXCEPTION (R12): a glide is always airborne and is
  // meant to STEER to a landing, so it skips the blend and uses GLIDE_STEER_MULT.
  let airSteerMult = 1;
  if (state.airborne) {
    if (state.gliding) {
      airSteerMult = PHYSICS.GLIDE_STEER_MULT;
    } else {
      const airFrac = Math.min(state.airTime / PHYSICS.AIR_STEER_BLEND_TIME, 1);
      airSteerMult = 1 + (PHYSICS.AIR_STEER_MULT - 1) * airFrac;
    }
  }

  // Reversing inverts steering, just like a real vehicle backing up: holding
  // "right" while reversing should swing the tail the other way. Math.sign
  // gives +1 forward, -1 reverse, 0 stopped (which zeroes the turn anyway).
  const directionSign = Math.sign(state.speed);

  // *** STEERING SIGN — VERIFIED CONVENTION ***
  // Forward vector = (sin(heading), 0, cos(heading)); the kart mesh sets
  // mesh.rotation.y = heading. With Input giving D = +1 / A = -1, turning the
  // kart visually RIGHT requires heading to DECREASE (and LEFT to increase).
  // Both the normal-steer and drift-curve heading updates therefore SUBTRACT
  // their turn term (note the `-=` below) so D steers right and A steers left.
  if (state.drifting) {
    // --- Drifting (M2): turn toward the LOCKED drift direction ----------
    // The yaw direction is driftDir (set when the drift started), NOT the live
    // steer — so the kart commits to the slide. The live steer only widens or
    // tightens the arc via COUNTER_STEER_INFLUENCE:
    //   steering INTO the drift  (steer same sign as driftDir) -> tighter arc
    //   counter-steering         (steer opposite driftDir)     -> wider arc
    // steerToward is +1 full-into / -1 full-counter, so the factor stays within
    // [1 - INFLUENCE, 1 + INFLUENCE] and can never flip the drift's direction.
    // driftDir = +1 (drift RIGHT) subtracts from heading -> curves RIGHT, which
    // matches the corrected normal-steering convention above.
    const steerToward = state.steerActual * state.driftDir; // -1..1 (eased steer)
    // Holding brake while drifting tightens the arc (BRAKE_DRIFT_TIGHTEN), added on
    // top of the counter-steer influence — a small extra bite for a tight hairpin.
    const arcFactor =
      1 + steerToward * DRIFT.COUNTER_STEER_INFLUENCE + (input.brake || 0) * DRIFT.BRAKE_DRIFT_TIGHTEN;
    // handlingMult (M5) scales the yaw rate per-kart; driftWeightMult makes a lighter
    // kart rotate a touch faster in the slide. Both 1.0 for a neutral kart.
    state.heading -=
      state.driftDir *
      PHYSICS.TURN_RATE *
      handlingMult *
      gripMult *
      driftWeightMult *
      DRIFT.DRIFT_TURN_MULT *
      arcFactor *
      airSteerMult *
      dt *
      speedFactor;
  } else {
    // --- Normal steering: D (+1) decreases heading -> turns RIGHT ---------
    // handlingMult (M5) scales the yaw rate per-kart; 1.0 for a neutral kart, so
    // this is legacy-identical without stats. The sign was flipped (+= -> -=) to
    // un-mirror the steering (see the verified convention note above).
    state.heading -=
      state.steerActual * PHYSICS.TURN_RATE * handlingMult * gripMult * airSteerMult * dt * speedFactor * directionSign;
  }

  // ----------------------------------------------------------------------
  // 3b. DRIFT SLIP ANGLE — ease velHeading (travel dir) toward heading (facing).
  // ----------------------------------------------------------------------
  // velHeading is the direction the kart actually TRAVELS; heading is where it
  // FACES. Easing velHeading toward heading with a state-dependent rate gives a
  // real slip angle instead of the kart pivoting exactly where its nose points:
  //   - grounded & not drifting -> VEL_REALIGN_RATE (fast): travel tracks facing, so
  //     straight-line + normal-cornering feel stays close to the pre-slip model.
  //   - drifting                -> DRIFT_SLIP_RATE (slow): facing LEADS travel, so the
  //     tail steps out and the kart slides wide (a drift, not an on-rails turn).
  //   - released boost          -> DRIFT_RELEASE_REALIGN_RATE (snap): the stored slip
  //     collapses fast so the mini-turbo launch fires along the facing, dead straight.
  // Angles are wound (heading integrates unbounded), so the delta is normalized to
  // [-PI,PI] (atan2 of its sin/cos) to ease the SHORT way; the clamp then re-pins
  // velHeading within DRIFT_SLIP_MAX of heading — which also snaps a stale velHeading
  // back after a respawn teleport (speed is 0 there, so the snap is invisible).
  // Deterministic: only state.{heading,velHeading,drifting,boostTimer} + dt.
  let velRealignRate;
  if (state.drifting) velRealignRate = PHYSICS.DRIFT_SLIP_RATE;
  else if (state.boostTimer > 0) velRealignRate = PHYSICS.DRIFT_RELEASE_REALIGN_RATE;
  else velRealignRate = PHYSICS.VEL_REALIGN_RATE;
  let velDelta = state.heading - state.velHeading;
  velDelta = Math.atan2(Math.sin(velDelta), Math.cos(velDelta)); // shortest signed angle
  state.velHeading += velDelta * (1 - Math.exp(-velRealignRate * dt));
  let slip = state.heading - state.velHeading;
  slip = Math.atan2(Math.sin(slip), Math.cos(slip));
  if (slip > PHYSICS.DRIFT_SLIP_MAX) state.velHeading = state.heading - PHYSICS.DRIFT_SLIP_MAX;
  else if (slip < -PHYSICS.DRIFT_SLIP_MAX) state.velHeading = state.heading + PHYSICS.DRIFT_SLIP_MAX;

  // ----------------------------------------------------------------------
  // 4. Advance position along the TRAVEL vector (velHeading, the slip dir).
  // ----------------------------------------------------------------------
  // *** HEADING SIGN — THE ONE PLACE IT IS DEFINED ***
  // Forward vector = (sin(angle), 0, cos(angle)).
  //   angle 0      -> faces +Z
  //   angle +PI/2  -> faces +X
  // The kart mesh elsewhere sets mesh.rotation.y = heading (the FACING). Position
  // now advances along velHeading (the TRAVEL dir from the slip ease above), which
  // equals heading whenever not sliding, so straight-line motion is unchanged.
  // If steering ever looks mirrored in the browser, flip the sign of the steering
  // term in step 3 above (state.steerActual * ...) — keep the change HERE-adjacent
  // and commented, do not scatter sign flips across the codebase.
  const forwardX = Math.sin(state.velHeading);
  const forwardZ = Math.cos(state.velHeading);

  state.x += forwardX * state.speed * dt;
  state.z += forwardZ * state.speed * dt;

  // ----------------------------------------------------------------------
  // 4b. SUSPENSION / LEAN FEEL (R12) — VISUAL ONLY, never affects handling.
  // ----------------------------------------------------------------------
  // Track three cosmetic values the renderer reads to tilt + squash the kart:
  //   lean  — body ROLL into the current turn. Target = (yaw direction) x
  //           (how hard we're turning) x (how fast we're going). While drifting
  //           the kart commits to its locked driftDir; otherwise it rolls with
  //           the live steer. Eased toward the target by LEAN_RATE so it banks
  //           smoothly instead of snapping.
  //   pitch — nose up under throttle, nose down under brake, scaled by speed so
  //           a standstill rev doesn't tilt the kart. Eased the same way.
  //   suspension — only DECAYS here (spring-back). It is SPIKED on landings by
  //           updateVertical (step 5) and on glide touchdowns, so the kart
  //           visibly compresses then rebounds. Clamped to 0..1.
  // updateDrift already resolved drifting/driftDir; speedFactor (0..1) is the
  // same rolling-speed ramp used by steering. Deterministic: only state+input.
  const turnDir = state.drifting ? -(state.driftDir || 0) : -state.steerActual;
  const leanTarget = turnDir * speedFactor * PHYSICS.LEAN_ROLL_MAX;
  const leanAlpha = 1 - Math.exp(-PHYSICS.LEAN_RATE * dt);
  state.lean += (leanTarget - state.lean) * leanAlpha;
  // Pitch: +throttle noses up, brake noses down; faded in with speed so a
  // launch from a stop reads as a squat, not a wheelie at 0 m/s.
  const pitchInput = (input.throttle || 0) - (input.brake || 0); // -1..1
  const pitchTarget = pitchInput * speedFactor * PHYSICS.LEAN_PITCH_MAX;
  state.pitch += (pitchTarget - state.pitch) * leanAlpha;
  // Suspension springs back toward 0; the landing spikes happen in updateVertical.
  // weightMult (M5) stiffens the spring-back: a heavier kart settles a touch faster
  // (more planted), a lighter one rebounds softer. 1.0 at neutral => unchanged.
  if (state.suspension > 0) {
    const springAlpha = 1 - Math.exp(-PHYSICS.SUSPENSION_SPRING_RATE * weightMult * dt);
    state.suspension -= state.suspension * springAlpha;
    if (state.suspension < 0.0005) state.suspension = 0;
  }

  // ----------------------------------------------------------------------
  // 4c. AIR TRICKS (signature hook) — bank STYLE while working a mid-air arc.
  // ----------------------------------------------------------------------
  // Only REAL ramp/gap air counts (airTime past MIN_AIRTIME, not tiny terrain
  // bumps), and never while GLIDING (a glide is its own steered descent). The
  // longer you stay up and the harder you steer, the more STYLE banks; the steer
  // also spins a VISUAL barrel roll (trickRot) that does NOT touch heading — the
  // weak air-steer above already nudges that. This runs BEFORE updateVertical, so
  // on the landing frame it banks one last bit of style while the kart is still
  // airborne, then updateVertical detects the touchdown and cashes it in (the
  // award + reset live there, since it owns the airborne->grounded transition).
  // Grounded with a leftover roll: ease trickRot back upright over a few frames.
  // The spin-out early-return above skips this entirely (a spun kart banks no
  // style). Neutral: a kart that never gets real air leaves trickActive/trickStyle/
  // trickRot at 0 and this whole block is inert + byte-identical to before.
  if (state.airborne && !state.gliding && state.airTime > TRICK.MIN_AIRTIME) {
    state.trickActive = true;
    state.trickStyle += (TRICK.STYLE_PER_SEC + Math.abs(input.steer) * TRICK.STYLE_INPUT_BONUS) * dt;
    state.trickRot += input.steer * TRICK.SPIN_RATE * dt;
  } else if (!state.airborne && state.trickRot !== 0) {
    const uprightAlpha = 1 - Math.exp(-TRICK.UPRIGHT_RATE * dt);
    state.trickRot -= state.trickRot * uprightAlpha;
    if (Math.abs(state.trickRot) < 0.001) state.trickRot = 0;
  }

  // ----------------------------------------------------------------------
  // 5. VERTICAL (TERRAIN) — ride hills when grounded, arc when airborne.
  // ----------------------------------------------------------------------
  // The track is now hilly. The CALLER sets state.groundY (centerline elevation
  // under the kart) every tick before this step. We resolve y here so it is part
  // of the deterministic model and matches byte-for-byte on client + server.
  updateVertical(state, dt);

  return state;
}

/**
 * Resolve the kart's vertical motion for one step: either follow the terrain
 * (grounded) or integrate a gravity arc (airborne). Pure + deterministic —
 * depends only on state.{y,vy,airborne,groundY} and dt. Called at the end of
 * stepKart, and also from the spin-out early-return so a kart spun out mid-jump
 * still falls correctly.
 *
 * Grounded: ease state.y toward state.groundY by an exponential lerp with time
 *   constant GROUND_FOLLOW_RATE — framerate-independent (1 - exp(-rate*dt)) and
 *   never overshoots, so hills are followed smoothly instead of snapping.
 *
 * Airborne: integrate state.y += vy*dt, then vy -= GRAVITY*dt. Land when the
 *   kart reaches/passes the ground under it (y <= groundY) WHILE descending
 *   (vy <= 0): clamp y = groundY, vy = 0, airborne = false. (The vy<=0 guard
 *   stops an instant re-land on the launch frame if groundY rises under the kart.)
 *
 * Gliding (R12): while state.gliding the kart uses GLIDE_GRAVITY (a much weaker
 *   pull, so it falls slow + floaty), keeps almost all its forward speed (only a
 *   tiny GLIDE_DRAG bleed), and is steered hard via GLIDE_STEER_MULT (handled in
 *   stepKart). On touchdown the glide is CLEARED (gliding=false) with a soft
 *   GLIDE_LAND_SUSPENSION compression. A normal jump landing spikes a smaller
 *   SUSPENSION_LAND_HOP. Either way the renderer reads state.suspension to squash.
 *
 * @param {object} state - kart state (mutated in place).
 * @param {number} dt    - timestep in seconds.
 * @private
 */
function updateVertical(state, dt) {
  if (state.airborne) {
    // Track time in this arc so stepKart can ramp air-steer grip in over the launch.
    state.airTime += dt;
    // Glides fall slow + floaty (GLIDE_GRAVITY); normal jumps fall snappy (GRAVITY).
    const grav = state.gliding ? PHYSICS.GLIDE_GRAVITY : PHYSICS.GRAVITY;
    // Integrate the arc. Position first, then gravity decelerates vy.
    state.y += state.vy * dt;
    state.vy -= grav * dt;
    // While gliding the kart keeps its momentum (low drag) so it carries forward
    // across the gap; a tiny bleed toward 0 keeps it from feeling frictionless.
    if (state.gliding && state.speed > 0) {
      state.speed -= PHYSICS.GLIDE_DRAG * dt;
      if (state.speed < 0) state.speed = 0;
    }
    // Land once we've fallen back to (or below) the ground under us. COYOTE-TIME:
    // on a descending frame we also land when within LAND_COYOTE_EPSILON ABOVE the
    // ground, not only once y has dipped below, so a frame-perfect gap landing snaps
    // onto the far edge instead of grazing past it. The epsilon is sub-meter, far
    // smaller than the -1000 groundY RaceManager parks over a real gap, so it can
    // never catch a kart that is genuinely hovering over a void.
    if (state.vy <= 0 && state.y <= state.groundY + PHYSICS.LAND_COYOTE_EPSILON) {
      state.y = state.groundY; // clamp exactly onto the surface
      state.vy = 0;
      state.airborne = false;
      state.airTime = 0; // grounded again: reset the air-steer ramp for the next jump
      // Soft landing compression — bigger for a glide touchdown (it's a real
      // set-down) than a quick jump hop. Take the MAX so an existing spike isn't
      // shortened. Clears the glide so the next step is grounded.
      const hop = state.gliding ? PHYSICS.GLIDE_LAND_SUSPENSION : PHYSICS.SUSPENSION_LAND_HOP;
      if (hop > state.suspension) state.suspension = hop;
      state.gliding = false;
      // AIR-TRICK PAYOUT (signature hook): a kart that banked style mid-air just
      // made a CLEAN landing on real road — a kart that fell in a gap keeps falling
      // and never reaches this branch. Cash the style as a mini-turbo-style boost
      // (REUSES boostTimer so it feels/sounds/VFXes exactly like a drift boost — no
      // parallel surge to wire) and charge the overdrive meter. trickLandStyle is a
      // transient signal the render/HUD/SFX read + clear. Forgiving by design: there
      // is no bail — landing always banks whatever you earned. Neutral: trickActive
      // is only true after real air, so a no-trick landing does nothing here.
      if (state.trickActive) {
        const boost = Math.min(TRICK.MAX_TRICK_BOOST, state.trickStyle * TRICK.STYLE_TO_BOOST);
        state.boostTimer = Math.max(state.boostTimer, boost);
        state.overdrive = Math.min(1, state.overdrive + state.trickStyle * OVERDRIVE.CHARGE_PER_STYLE);
        state.trickLandStyle = state.trickStyle;
        state.trickStyle = 0;
        state.trickActive = false;
      }
    }
    return;
  }

  // Grounded: smoothly ease y toward the terrain height under the kart.
  // alpha = 1 - exp(-rate*dt) is the framerate-independent lerp factor; it is
  // in (0,1) for any dt>0, so y approaches groundY without ever overshooting.
  const target = state.groundY || 0;
  // RAMPS: a steep wedge climbs too fast for the soft hill ease (rate 30) to keep up, so
  // the nose phases into the ramp top. On a ramp ONLY, near-snap onto the surface and add a
  // one-sided "never below the wedge" clamp — pure arithmetic, identical client + server.
  // The wedge groundY starts at rampLift 0 on the entry edge, so the clamp only ever lifts
  // the kart UP onto the climbing surface (continuous at the footprint boundary, no pop).
  const onRamp = state.surface === 'ramp';
  const rate = onRamp ? PHYSICS.RAMP_FOLLOW_RATE : PHYSICS.GROUND_FOLLOW_RATE;
  const alpha = 1 - Math.exp(-rate * dt);
  state.y += (target - state.y) * alpha;
  if (onRamp && state.y < target) state.y = target; // glue to the ramp top; never sink in
  // FAR-SAFETY MAX-LAG BACKSTOP (grounded only): now that groundY is SMOOTH the rate-30
  // ease above keeps the kart glued to the road on its own, so this clamp RARELY fires —
  // GROUND_MAX_LAG is intentionally generous (3.5m). It is only an anomaly backstop for a
  // sudden groundY discontinuity, NOT a per-frame clamp. The old tight 0.9m cap toggled
  // every frame on steep ground and caused a visible per-frame snap (shake); the wide cap
  // never engages in normal driving. Deterministic (pure arithmetic) so client + server stay in sync.
  const lag = state.y - target;
  const cap = PHYSICS.GROUND_MAX_LAG;
  if (lag > cap) state.y = target + cap;
  else if (lag < -cap) state.y = target - cap;
}

/**
 * Drift + 3-tier mini-turbo state machine. Mutates the drift-related fields on
 * `state` from `input.drift`. Called at the very top of stepKart, before any
 * speed/steer math, so the rest of the step can read the resolved drift state.
 *
 * Lifecycle:
 *   1. drift key held, speed >= MIN_DRIFT_SPEED, AND steering -> start a hop;
 *      lock driftDir to the sign of the current steer and set drifting = true.
 *   2. while drifting -> tick down hopTimer, accumulate driftCharge, and derive
 *      miniTurboTier (0/1/2/3) from the charge thresholds.
 *   3. drift key released -> if a tier was reached, arm boostTimer for that
 *      tier's BOOST_DURATION; then clear all drift bookkeeping.
 *   4. boostTimer always counts down by dt (independent of drift state).
 *
 * Deterministic: no randomness, no time-of-day — only state, input.drift, dt.
 *
 * @param {object} state - kart state (mutated in place).
 * @param {object} input - input snapshot; only input.drift and input.steer used here.
 * @param {number} dt    - timestep in seconds.
 * @param {number} [miniTurboMult=1] - per-kart mini-turbo multiplier (M5). Scales
 *        BOTH the drift-charge accrual rate and the released boost duration.
 *        Defaults to 1 so callers (and the legacy/no-stats path) are unchanged.
 * @private
 */
function updateDrift(state, input, dt, miniTurboMult = 1) {
  // Boost surge always bleeds down on its own clock, even mid-drift.
  if (state.boostTimer > 0) {
    state.boostTimer -= dt;
    if (state.boostTimer < 0) state.boostTimer = 0;
  }

  // The initial hop window ticks down regardless; the renderer reads hopTimer.
  if (state.hopTimer > 0) {
    state.hopTimer -= dt;
    if (state.hopTimer < 0) state.hopTimer = 0;
  }

  if (input.drift) {
    if (!state.drifting) {
      // Try to START a drift. Needs enough forward speed AND an actual steer
      // direction to lock onto (you can't drift straight or while crawling).
      // input.steer is -1..1; a tiny deadzone avoids latching on near-zero noise.
      if (state.spinTimer <= 0 && state.speed >= DRIFT.MIN_DRIFT_SPEED && Math.abs(input.steer) > 0.05) {
        state.drifting = true;
        state.driftDir = Math.sign(input.steer); // -1 left / +1 right, locked
        state.driftCharge = 0;
        state.miniTurboTier = 0;
        state.hopTimer = DRIFT.HOP_TIME; // pop up, then the slide bites
      }
      // If we can't start (too slow / no steer), leave everything neutral and
      // let normal steering handle this frame.
    } else {
      // Already drifting: bank charge time and update the mini-turbo tier.
      // miniTurboMult (M5) scales the accrual rate, so a high-miniTurbo kart
      // reaches each tier sooner. Neutral kart => mult 1 => legacy timing.
      state.driftCharge += dt * miniTurboMult;
      const t = DRIFT.MINI_TURBO_THRESHOLDS;
      if (state.driftCharge >= t.purple) {
        state.miniTurboTier = 3;
      } else if (state.driftCharge >= t.orange) {
        state.miniTurboTier = 2;
      } else if (state.driftCharge >= t.blue) {
        state.miniTurboTier = 1;
      } else {
        state.miniTurboTier = 0;
      }
    }
  } else if (state.drifting) {
    // RELEASE: drift key let go while sliding. Cash in any charged tier as a
    // boost, then clear the drift bookkeeping back to neutral.
    if (state.miniTurboTier > 0) {
      // miniTurboMult (M5) also stretches the released boost duration, so the
      // surge lasts longer on a high-miniTurbo kart. Neutral => mult 1 => legacy.
      state.boostTimer = DRIFT.BOOST_DURATION[state.miniTurboTier] * miniTurboMult;
      // BOOST-KICK: a one-time INSTANT speed impulse keyed by tier, so the mini-turbo
      // launch is felt on frame 1 instead of the kart creeping up to the boosted cap.
      // updateDrift runs at the TOP of stepKart, so the speed clamp in step 2 (which now
      // sees boostTimer > 0 -> the boosted cap) bounds the kick to the boosted forward cap.
      state.speed += DRIFT.BOOST_KICK[state.miniTurboTier];
      // OVERDRIVE charge (signature hook): every mini-turbo that fires also tops up
      // the overdrive meter, so steady drifting builds toward an overdrive surge.
      state.overdrive = Math.min(1, state.overdrive + OVERDRIVE.CHARGE_PER_MINITURBO);
    }
    state.drifting = false;
    state.driftDir = 0;
    state.driftCharge = 0;
    state.miniTurboTier = 0;
  }
}

// =========================================================================
// M3: PURE STATUS-EFFECT MUTATORS
// =========================================================================
// These are imported by the items + projectiles layers to apply effects to a
// kart state from the outside (e.g. a shell hit calls applySpin). They stay
// PURE: no three, no DOM, no Math.random — they only set/clamp timer fields, so
// stepKart's per-step decay does the rest. Calling them is always deterministic.

/**
 * Return true if the kart currently cannot be spun out — i.e. it is invincible.
 * Right now that means a star is active (starTimer > 0). Centralised here so
 * applySpin and any caller share one definition of "invincible".
 *
 * @param {object} state - kart state.
 * @returns {boolean} true while the kart is invincible.
 */
export function isInvincible(state) {
  return state.starTimer > 0;
}

/**
 * Spin the kart out for `secs` seconds (hit by a shell/banana). Sets spinTimer,
 * which stepKart honors by ignoring input and bleeding speed while it counts
 * down. No-op if the kart is invincible (see isInvincible) — a star tanks the hit.
 *
 * @param {object} state - kart state (mutated in place).
 * @param {number} [secs=EFFECTS.SPIN_DURATION] - spin duration in seconds.
 * @returns {object} the same state.
 */
export function applySpin(state, secs = EFFECTS.SPIN_DURATION) {
  if (isInvincible(state)) return state; // star (or other invincibility) absorbs the hit
  // Take the longer of any existing spin and the new one so overlapping hits
  // never shorten an in-progress spin-out.
  if (secs > state.spinTimer) state.spinTimer = secs;
  // A spin cancels any drift in progress so the kart doesn't resume sliding mid-spin.
  state.drifting = false;
  state.driftDir = 0;
  state.driftCharge = 0;
  state.miniTurboTier = 0;
  // A spin also cancels any in-progress AIR TRICK — getting hit mid-flip shouldn't
  // still pay out a trick boost on landing (mirrors the drift cancel above).
  state.trickActive = false;
  state.trickStyle = 0;
  state.trickRot = 0;
  return state;
}

/**
 * Give the kart a mushroom boost: reuse the existing mini-turbo boost surge so
 * the speed/accel kick is identical to a drift boost. A consumed mushroom charge
 * ALWAYS adds boost time, so firing one while a drift boost (or another mushroom)
 * is already active extends the surge instead of being silently eaten — the old
 * `if (dur > boostTimer)` guard no-op'd whenever a boost was already near/at the
 * tier-3 duration, burning the charge for no extra speed. The total is capped so
 * stacking charges can't snowball into an unbounded boost, but the floor of `dur`
 * guarantees a single mushroom from a standstill still gives a full surge.
 *
 * @param {object} state - kart state (mutated in place).
 * @returns {object} the same state.
 */
export function applyMushroomBoost(state) {
  const dur = DRIFT.BOOST_DURATION[3]; // reuse the strongest mini-turbo duration
  // Top up the existing boost by a full mushroom duration so every consumed charge
  // yields real extra boost, then clamp the total to MUSHROOM_BOOST_MAX so rapid
  // golden/triple presses extend rather than no-op (but can't stack to infinity).
  state.boostTimer = Math.min(state.boostTimer + dur, EFFECTS.MUSHROOM_BOOST_MAX);
  return state;
}

/**
 * Grant the kart a star for `secs` seconds: invincible + a small top-speed bump,
 * both handled by stepKart while starTimer > 0.
 *
 * @param {object} state - kart state (mutated in place).
 * @param {number} [secs=EFFECTS.STAR_DURATION] - star duration in seconds.
 * @returns {object} the same state.
 */
export function applyStar(state, secs = EFFECTS.STAR_DURATION) {
  if (secs > state.starTimer) state.starTimer = secs; // extend, never shorten
  // Picking up a star clears an in-progress spin-out (you shake it off) AND any
  // shrink (lightning) effect — a star is a full cleanse plus the speed bump, so
  // grabbing one mid-spin or mid-shrink instantly frees you. This makes the star
  // read as a genuinely strong "get out of trouble + go fast" button.
  state.spinTimer = 0;
  state.shrinkTimer = 0;
  return state;
}

/**
 * Shrink the kart for `secs` seconds (hit by lightning): reduced top speed while
 * tiny, handled by stepKart while shrinkTimer > 0.
 *
 * @param {object} state - kart state (mutated in place).
 * @param {number} [secs=EFFECTS.SHRINK_DURATION] - shrink duration in seconds.
 * @returns {object} the same state.
 */
export function applyShrink(state, secs = EFFECTS.SHRINK_DURATION) {
  if (isInvincible(state)) return state; // a star shrugs off lightning too
  if (secs > state.shrinkTimer) state.shrinkTimer = secs; // extend, never shorten
  return state;
}

/**
 * Add one coin to the kart's purse, capped at EFFECTS.COIN_MAX. Each coin adds a
 * flat top-speed bonus (applied in stepKart). Coins are a held count, not a timer.
 *
 * @param {object} state - kart state (mutated in place).
 * @returns {object} the same state.
 */
export function addCoin(state) {
  state.coins = Math.min((state.coins || 0) + 1, EFFECTS.COIN_MAX);
  return state;
}

// =========================================================================
// TERRAIN: PURE JUMP MUTATOR
// =========================================================================
// Launching is the only vertical event the model can't infer on its own — it
// depends on the kart crossing a ramp footprint, which the CALLER detects from
// trackData.listFeatures()/sampleSurface(). So the CALLER fires this on the
// RISING EDGE (first frame over a ramp at speed), exactly like boost-pad/hazard
// effects. stepKart then owns the arc + landing via updateVertical. PURE: no
// three, no DOM, no Math.random — it only sets vy/airborne, so it is deterministic.

/**
 * Launch the kart into a jump arc (called by the caller when a kart crosses a
 * ramp at speed). Sets airborne = true and vy to the upward launch velocity;
 * stepKart's updateVertical then integrates the arc and lands the kart when it
 * falls back to the ground (state.groundY) under it.
 *
 * No-op if the kart is already airborne, so re-triggering on consecutive frames
 * over the same ramp footprint can't re-launch (or stack) the jump — the caller
 * gets rising-edge behaviour for free even if it forgets to debounce.
 *
 * The launch is purely vertical: horizontal speed/heading are untouched, so the
 * kart keeps its momentum and sails forward through the arc.
 *
 * @param {object} state  - kart state (mutated in place).
 * @param {number} [vyUp=PHYSICS.RAMP_LAUNCH_VY] - upward velocity in m/s.
 * @returns {object} the same state.
 */
export function launchKart(state, vyUp = PHYSICS.RAMP_LAUNCH_VY) {
  if (state.airborne) return state; // already in the air: don't re-launch / stack
  state.airborne = true;
  state.vy = vyUp;
  state.airTime = 0; // fresh arc: air-steer grip ramps in from the launch frame
  // A fresh launch is a NORMAL jump by default — clear any stale glide so a
  // plain ramp never inherits gliding from a prior glide. The GLIDE contract is:
  // the caller (Stream R) calls launchKart(state, bigVy) for a `glide` ramp and
  // THEN sets state.gliding = true; updateVertical clears it again on landing.
  state.gliding = false;
  // A launch cancels any drift slide in progress: the wheels leave the ground,
  // so it makes no sense to keep banking drift charge mid-air. (Matches applySpin
  // clearing drift bookkeeping; the released-boost path is unaffected.)
  state.drifting = false;
  state.driftDir = 0;
  state.driftCharge = 0;
  state.miniTurboTier = 0;
  // FRESH AIR SESSION (signature hook): clear any banked trick style/roll from a
  // prior jump so each launch starts a new trick — the previous one was already
  // cashed on its landing. (trickLandStyle is left alone: it's a transient the
  // renderer/HUD consume, not part of the in-air bookkeeping.)
  state.trickActive = false;
  state.trickStyle = 0;
  state.trickRot = 0;
  return state;
}
