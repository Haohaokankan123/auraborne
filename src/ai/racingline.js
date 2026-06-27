// src/ai/racingline.js
//
// The "racing line": a smooth, closed curve threaded through the track's
// centerline checkpoints that the AI karts aim along. This is CLIENT-SIDE only
// (it imports three) because it is just steering geometry — it never touches the
// shared physics model, so it can use THREE.Vector3 / CatmullRomCurve3 freely.
//
// Why a curve and not just the raw checkpoints?
//   - The checkpoints are 16 discrete points around the stadium. Steering at one
//     point at a time produces jerky zig-zag driving. A Catmull-Rom spline
//     interpolates a smooth path THROUGH those points, so the AI gets a
//     continuous direction to follow and a continuous "look-ahead" target.
//   - CatmullRomCurve3 with closed=true joins the last point back to the first
//     with matching tangents, so the loop has no seam at the start/finish line.
//
// Coordinate convention (matches the rest of the project):
//   - Y is up; the track lies in the XZ plane; world units = meters.
//   - We keep every curve point at y = 0 (the AI only steers in XZ; ground height
//     is owned by the physics raycast layer, not by the racing line).
//
// Source of the control points:
//   RacingLine can be built from EITHER a full Track instance (client, with
//   meshes) OR any plain object that exposes `checkpoints` (server, built from
//   shared/trackData.js with NO meshes). Both expose the same
//   `checkpoints` = ordered [{x,z,index}] array, which is all this needs.
//
// Public surface (consumed by src/ai/AIRacer.js):
//   - new RacingLine(trackOrData)   // anything with `.checkpoints` (+ optional .roadWidth)
//   - getNearest(pos) -> { t, point: THREE.Vector3, tangent: THREE.Vector3 }
//   - getLookahead(pos, distanceAhead) -> THREE.Vector3
//   - getOffsetLookahead(pos, distanceAhead, laneOffset, nearScratch, outVec) -> THREE.Vector3
//   - halfWidth -> number  (half the drivable road width, for lane offsets)
//   - length() -> number   (approximate loop length in meters)

import * as THREE from 'three';

export class RacingLine {
  /**
   * @param {object} track  EITHER a Track instance OR a plain object such as
   *                        { checkpoints } (e.g. from shared/trackData.js).
   *                        It only needs to expose `checkpoints`: an ordered
   *                        [{x,z,index}] array (index 0 = start/finish, in the
   *                        driving direction). This lets the headless server
   *                        build a racing line with no Three.js meshes.
   */
  constructor(track) {
    this.track = track;

    // --- Half the drivable road width, for LANE OFFSETS. ------------------
    // The AI spreads itself across the road by aiming at a point shifted
    // sideways from the line by (laneOffset * halfWidth). We read the full
    // `roadWidth` off whatever was passed (Track instance OR plain data object;
    // both expose it — see shared/trackData.js, full drivable width in meters)
    // and halve it. Fall back to a sane ~10 m half-width (20 m road) if a caller
    // passes something with no roadWidth, so offset aiming still works. We pull
    // a 1.5 m safety margin off the edge so an AI parked at laneOffset = +-1
    // still keeps its tyres on the tarmac rather than straddling the grass.
    const fullWidth = (track && track.roadWidth) || 20;
    this.halfWidth = Math.max(1, fullWidth / 2 - 1.5);

    // --- Build the control points for the spline. -------------------------
    // One THREE.Vector3 per checkpoint, in driving order. y = 0 (flat plane).
    // These are the points the curve is guaranteed to pass through. We read
    // `checkpoints` off whatever was passed (Track or plain {checkpoints}).
    const cps = (track && track.checkpoints) || [];
    const controlPoints = cps.map((c) => new THREE.Vector3(c.x, 0, c.z));

    // --- The closed Catmull-Rom spline. -----------------------------------
    // closed=true   : the curve wraps the last point back to the first with
    //                 continuous tangents (no kink at the start/finish seam).
    // 'catmullrom'  : the spline type — passes through every control point.
    // tension 0.5   : the standard Catmull-Rom tension (centripetal-ish feel);
    //                 lower = looser/rounder, higher = tighter to the points.
    this.curve = new THREE.CatmullRomCurve3(controlPoints, true, 'catmullrom', 0.5);

    // --- Precompute a dense sampled polyline for FAST nearest lookup. ------
    // CatmullRomCurve3 has no analytic "closest point" query, so getNearest()
    // would otherwise have to search the continuous curve numerically every
    // call (expensive, and this runs for 12 karts every tick). Instead we
    // sample the curve once into N evenly-parameterised points and, at query
    // time, just scan that list for the nearest sample. N = 200 over a ~520 m
    // loop gives a sample roughly every ~2.6 m — plenty fine for steering.
    this.sampleCount = 200;

    // _samples[i]       = THREE.Vector3 position of sample i.
    // _sampleT[i]       = the curve parameter t in [0,1) for that sample.
    // _sampleTangents[i] = unit THREE.Vector3 tangent at sample i (driving dir).
    // We store t alongside each point so getNearest can report WHERE on the loop
    // the kart is (used by getLookahead to step further along the curve). The
    // tangents are precomputed ONCE here instead of via curve.getTangent(t) per
    // query — getTangent allocates a fresh Vector3 every call, and getNearest is
    // called several times per AI per tick (12 AI * 60 Hz), so caching them kills
    // that allocation churn / GC stutter under a full field.
    this._samples = [];
    this._sampleT = [];
    this._sampleTangents = [];
    for (let i = 0; i < this.sampleCount; i++) {
      const t = i / this.sampleCount; // 0 .. <1, evenly spaced in parameter
      // getPoint(t) returns the spline position at parameter t.
      this._samples.push(this.curve.getPoint(t));
      this._sampleT.push(t);
      // getTangent(t) returns the UNIT tangent (driving direction) at t.
      this._sampleTangents.push(this.curve.getTangent(t));
    }

    // Reusable scratch Vector3 for getLookahead's getPoint() call, so the common
    // steering path allocates nothing per tick. getLookahead returns a reference
    // to this scratch; the only caller (AIRacer) reads it immediately and copies
    // the components into its own vector before the next getLookahead call.
    this._lookaheadScratch = new THREE.Vector3();

    // Cache the approximate total length once (sum of segment lengths between
    // consecutive samples, including the wrap from the last sample back to the
    // first since the loop is closed). Used to convert a "distance ahead" in
    // meters into a parameter step for getLookahead.
    this._length = 0;
    for (let i = 0; i < this.sampleCount; i++) {
      const a = this._samples[i];
      const b = this._samples[(i + 1) % this.sampleCount]; // wrap closes the loop
      this._length += a.distanceTo(b);
    }
  }

  /**
   * Approximate total length of the racing line loop, in meters.
   * @returns {number}
   */
  length() {
    return this._length;
  }

  /**
   * Find the point on the racing line nearest to a world position.
   *
   * Implementation: brute-force scan of the precomputed samples for the one with
   * the smallest squared XZ distance to `pos`. Squared distance avoids a sqrt
   * per sample; we never need the true distance here, only the argmin. 200
   * samples * 12 karts = 2400 cheap comparisons per tick — trivial at 60fps.
   *
   * @param {THREE.Vector3|{x:number,z:number}} pos  query position (XZ used).
   * @param {{point?:THREE.Vector3}} [out]  optional caller-owned scratch result.
   *   If provided, the nearest sample position is COPIED into `out.point`
   *   (instead of cloning the cached sample) and `out` is returned. This lets the
   *   hot path (AIRacer, 12 karts * 60 Hz) reuse one object and avoid allocating
   *   a fresh Vector3 + result object every call. The returned `tangent` is a
   *   reference to the cached per-sample tangent in BOTH cases — read it, do not
   *   mutate it.
   * @returns {{t:number, point:THREE.Vector3, tangent:THREE.Vector3}}
   *   t       - curve parameter [0,1) of the nearest sample.
   *   point   - THREE.Vector3 position on the line (y = 0).
   *   tangent - unit THREE.Vector3 pointing along the driving direction there.
   */
  getNearest(pos, out) {
    const px = pos.x;
    const pz = pos.z;

    let bestI = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < this.sampleCount; i++) {
      const s = this._samples[i];
      const dx = s.x - px;
      const dz = s.z - pz;
      const d2 = dx * dx + dz * dz; // squared XZ distance (no sqrt needed)
      if (d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
      }
    }

    const t = this._sampleT[bestI];
    // Precomputed UNIT tangent for this sample (driving direction). Returned by
    // reference — callers must not mutate it.
    const tangent = this._sampleTangents[bestI];
    const sample = this._samples[bestI];

    if (out) {
      // Reuse the caller's result object/vector — no allocation.
      if (out.point) out.point.copy(sample);
      else out.point = sample.clone();
      out.t = t;
      out.tangent = tangent;
      return out;
    }

    return {
      t,
      point: sample.clone(), // clone so callers can't mutate cache
      tangent,
    };
  }

  /**
   * Get a point further ALONG the line from where `pos` projects onto it — the
   * aim target the AI steers toward. Looking ahead (rather than at the nearest
   * point) is what makes the AI corner smoothly instead of hugging the apex
   * point it is currently next to.
   *
   * Math: find the nearest sample's parameter t, then advance the parameter by
   * (distanceAhead / loopLength). Because the loop is closed and t is in [0,1),
   * we wrap with modulo so looking ahead past the start/finish line works.
   *
   * @param {THREE.Vector3|{x:number,z:number}} pos  current kart position.
   * @param {number} distanceAhead  meters to look ahead along the line.
   * @param {object} [nearScratch]  optional caller-owned scratch result for the
   *   internal getNearest() call, so this method allocates nothing per call.
   * @returns {THREE.Vector3} the aim point on the line (y = 0). This is a
   *   reference to an internal reused scratch vector — read it immediately and
   *   copy out before calling getLookahead again.
   */
  getLookahead(pos, distanceAhead, nearScratch) {
    // Reuse a caller scratch if given, else a per-instance one, so the nearest
    // lookup here doesn't allocate. (nearScratch defaults are lazily created.)
    if (!nearScratch) {
      if (!this._nearScratch) this._nearScratch = { point: new THREE.Vector3() };
      nearScratch = this._nearScratch;
    }
    const near = this.getNearest(pos, nearScratch);

    // Convert "meters ahead" into a parameter delta. The curve is roughly
    // arc-length uniform across our even-t samples, so distance/length is a good
    // approximation of the parameter step for that distance.
    const len = this._length > 1e-6 ? this._length : 1;
    let aheadT = near.t + distanceAhead / len;

    // Wrap into [0,1) so we can read past the seam on a closed loop.
    aheadT -= Math.floor(aheadT);

    // getPoint(t, optionalTarget) writes into our reused scratch (no allocation).
    return this.curve.getPoint(aheadT, this._lookaheadScratch);
  }

  /**
   * Like getLookahead, but shifted SIDEWAYS off the racing line by a lane offset.
   * This is what spreads the field across the wide, fenceless road: each AI aims
   * at a point pushed laterally from the true line, so a dozen karts following
   * the same spline no longer drive nose-to-tail single-file.
   *
   * Math:
   *   1. Find the look-ahead point + its tangent (driving direction) on the line.
   *   2. The LATERAL NORMAL in the XZ plane is perpendicular to the tangent.
   *      For a unit tangent (tx, 0, tz), the right-hand normal is (tz, 0, -tx)
   *      — this matches the project's "right" convention (rotate forward -90deg
   *      about Y => (fz, -fx), see RaceManager._gridPose). A POSITIVE laneOffset
   *      therefore aims to the kart's RIGHT of the line, NEGATIVE to its left.
   *   3. aim = linePoint + normal * (laneOffset * halfWidth).
   *
   * laneOffset is a fraction in roughly [-1, 1] of the (margin-trimmed) half
   * road width, so +-1 sits near the edge of the tarmac and 0 is dead on the line.
   *
   * @param {THREE.Vector3|{x:number,z:number}} pos  current kart position.
   * @param {number} distanceAhead  meters to look ahead along the line.
   * @param {number} laneOffset     lateral fraction of halfWidth (+ = right).
   * @param {object} [nearScratch]  caller-owned scratch for the internal
   *   getNearest() (so this allocates nothing per call).
   * @param {THREE.Vector3} outVec  caller-owned vector the aim point is written
   *   into and returned. REQUIRED so this never clobbers _lookaheadScratch (the
   *   AIRacer reads the un-offset line point in the same tick for corner math).
   * @returns {THREE.Vector3} outVec, holding the offset aim point (y = 0).
   */
  getOffsetLookahead(pos, distanceAhead, laneOffset, nearScratch, outVec) {
    // Resolve the look-ahead parameter exactly as getLookahead does (we duplicate
    // the few lines instead of calling it so we can grab the TANGENT at aheadT,
    // which getLookahead does not return, without a second getNearest scan).
    if (!nearScratch) {
      if (!this._nearScratch) this._nearScratch = { point: new THREE.Vector3() };
      nearScratch = this._nearScratch;
    }
    const near = this.getNearest(pos, nearScratch);

    const len = this._length > 1e-6 ? this._length : 1;
    let aheadT = near.t + distanceAhead / len;
    aheadT -= Math.floor(aheadT); // wrap into [0,1) across the closed-loop seam.

    // Position on the line at the look-ahead parameter (into outVec, no alloc).
    this.curve.getPoint(aheadT, outVec);

    // Tangent at the look-ahead parameter, written into our own reused scratch so
    // we don't allocate a fresh Vector3 (curve.getTangent allocates without one).
    if (!this._tangentScratch) this._tangentScratch = new THREE.Vector3();
    const tan = this.curve.getTangent(aheadT, this._tangentScratch);

    // Right-hand lateral normal in XZ: (tz, 0, -tx). Push the aim point sideways.
    const shift = laneOffset * this.halfWidth;
    outVec.x += tan.z * shift;
    outVec.z += -tan.x * shift;
    return outVec;
  }
}
