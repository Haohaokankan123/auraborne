// src/core/interpolate.js
//
// Render interpolation helpers for the fixed-timestep loop.
//
// Physics runs at a fixed 60Hz (see core/Loop.js), but the browser paints at
// whatever rate it can (often 120-240fps). If the renderer read the LIVE physics
// state every frame it would only ever see the latest 60Hz tick, so the same
// position would be drawn for several paints in a row and then jump — visible as
// JUDDER, especially while turning.
//
// The fix is the classic "render between two physics ticks" technique: each
// manager keeps the PREVIOUS tick's transform and the CURRENT one, and the loop
// hands render() an `alpha` in [0, 1) describing how far real time sits between
// them. We blend prev->cur by alpha to draw a smooth in-between frame.
//
// These helpers are PURE (no three, no DOM, no globals) so they're trivial to
// reason about and reuse from every mode manager.

/**
 * Linear interpolation between two scalars.
 *   lerp(a, b, 0) === a ; lerp(a, b, 1) === b.
 *
 * @param {number} a  value at t = 0 (previous tick).
 * @param {number} b  value at t = 1 (current tick).
 * @param {number} t  blend factor, normally 0..1 (the render alpha).
 * @returns {number} the blended value.
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Shortest-arc interpolation between two angles (radians).
 *
 * A naive lerp(a, b, t) breaks when the two angles straddle the +/-PI wrap: e.g.
 * blending from 3.1 rad to -3.1 rad would sweep the long way around (~6.2 rad)
 * instead of the short ~0.08 rad hop across the wrap. We instead take the raw
 * delta (b - a), wrap it into [-PI, PI] so it always represents the SHORTEST
 * rotation, then add the fraction of that delta back onto a.
 *
 * @param {number} a  angle at t = 0 (previous tick), radians.
 * @param {number} b  angle at t = 1 (current tick), radians.
 * @param {number} t  blend factor, normally 0..1 (the render alpha).
 * @returns {number} the blended angle in radians (not re-normalized; callers
 *                   feed it straight to mesh.rotation.y which is fine with any range).
 */
export function lerpAngle(a, b, t) {
  // Raw difference, then wrap into [-PI, PI] for the shortest direction.
  let delta = (b - a) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * t;
}

/**
 * Build the RENDER state for one kart: a shallow copy of the CURRENT physics
 * state with only its position (x, y, z) linearly interpolated and its heading
 * shortest-arc interpolated between the previous and current ticks by `alpha`.
 *
 * Every OTHER field (speed, drifting, driftDir, miniTurboTier, spinTimer,
 * starTimer, shrinkTimer, hopTimer, ...) is taken straight from `cur`, because
 * those are visual flags Kart.syncFromState reads live — only the world
 * position + facing need smoothing to kill the judder.
 *
 * If `prev` is missing (very first frame before any tick has been banked) we
 * simply return `cur` unblended so nothing snaps from a zeroed transform.
 *
 * @param {object} prev   previous tick's transform { x, y, z, heading }.
 * @param {object} cur    the current (live) kart state object.
 * @param {number} alpha  blend factor in [0, 1) from the loop.
 * @returns {object} a shallow copy of `cur` with interpolated x/y/z/heading.
 */
export function makeRenderState(prev, cur, alpha) {
  if (!prev) return cur;
  // Shallow copy so we never mutate the authoritative physics state, and so all
  // non-positional visual fields come through unchanged from `cur`.
  const rs = { ...cur };
  rs.x = lerp(prev.x, cur.x, alpha);
  rs.y = lerp(prev.y, cur.y, alpha);
  rs.z = lerp(prev.z, cur.z, alpha);
  rs.heading = lerpAngle(prev.heading, cur.heading, alpha);
  return rs;
}
