// shared/trackData.js
//
// The SINGLE SOURCE OF TRUTH for every circuit's LAYOUT geometry.
//
// This file is PURE math — NO `three`, NO DOM, NO rendering — so the headless
// Node server and the Three.js browser client can BOTH derive identical track
// data from it. The client (src/entities/Track.js) reads these numbers to build
// its meshes; the server reads the same numbers to build checkpoints, a racing
// line, a starting grid, surface/hill queries and feature placements WITHOUT
// ever loading a renderer.
//
// ===========================================================================
// PHASE 3 — LONG, WINDING, HILLY SPLINE COURSES (this rewrite)
// ===========================================================================
// The old tracks were short (~350m) flat "stadium" ovals defined by 5 numbers.
// They are replaced here by ~10x longer (~3000-4000m lap) courses defined as a
// CLOSED-LOOP Catmull-Rom SPLINE through a list of 3D control points. Each
// control point carries its own `y` (elevation) so the course climbs and dips
// for real — karts ride the hills identically on client and server because both
// read `groundY` from the SAME centerline math here.
//
// WHY a spline (and not formulas per-segment like before): a spline lets us draw
// any winding shape — sweeping bends, tight hairpins, S-curves, gentle climbs —
// from a handful of points, while staying PURE and deterministic. We sample the
// spline densely once (a cached polyline with cumulative arc-length), then every
// query (is-this-on-road? what's the ground height? where's the racing line?)
// is just a nearest-point lookup against that polyline. No `three`, no random.
//
// Coordinate convention (unchanged, matches the rest of the project):
//   - Y is up; the course winds through the XZ plane; world units = meters.
//   - heading is in radians; forward = (sin(heading), 0, cos(heading)).
//
// Determinism: NOTHING in this module uses Math.random. Track geometry, surface
// classification and hill height are pure functions of the control points, so
// the server's authority and the client's prediction compute byte-identically.

// ---------------------------------------------------------------------------
// PURE CATMULL-ROM SPLINE MATH
//
// A Catmull-Rom spline draws a smooth curve that PASSES THROUGH every control
// point (unlike a Bezier, whose middle points only "pull" the curve). For a
// CLOSED loop we wrap the neighbor indices so the end joins the start smoothly.
//
// The position on the segment between control points p1 and p2, given the
// surrounding points p0 (before p1) and p3 (after p2) and a local parameter
// t in [0,1], is the standard centripetal-free (uniform) Catmull-Rom formula:
//
//   q(t) = 0.5 * ( (2*p1)
//                + (-p0 + p2) * t
//                + (2*p0 - 5*p1 + 4*p2 - p3) * t^2
//                + (-p0 + 3*p1 - 3*p2 + p3) * t^3 )
//
// We evaluate it independently per axis (x, y, z). This is the SAME curve type
// THREE.CatmullRomCurve3 produces with its default ('catmullrom') tension, so
// the rendered ribbon and the server math line up.
// ---------------------------------------------------------------------------

/**
 * Evaluate a uniform Catmull-Rom spline on ONE axis.
 * @param {number} p0  control value before the segment start.
 * @param {number} p1  segment start value (curve passes through this at t=0).
 * @param {number} p2  segment end value   (curve passes through this at t=1).
 * @param {number} p3  control value after the segment end.
 * @param {number} t   local parameter in [0,1] along this segment.
 * @returns {number} the interpolated value at t.
 */
function catmullRom1D(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Evaluate a CLOSED-LOOP Catmull-Rom spline (x,y,z) at a global parameter.
 *
 * `u` is the GLOBAL spline parameter: u in [0,1) walks the whole loop once.
 * We map u to a segment index + local t, wrapping neighbor indices so the loop
 * is seamless (point[N-1] connects back to point[0]).
 *
 * @param {Array<{x:number,y:number,z:number}>} pts  closed-loop control points.
 * @param {number} u  global loop parameter; wrapped into [0,1).
 * @returns {{x:number,y:number,z:number}} the 3D point on the curve.
 */
function evalClosedSpline(pts, u) {
  const n = pts.length;
  // Wrap u into [0,1) so callers can pass any real number safely.
  let uu = u - Math.floor(u);
  const scaled = uu * n;          // which segment (0..n) we're on
  const seg = Math.floor(scaled); // integer segment index
  const t = scaled - seg;         // local parameter inside the segment

  // Closed-loop neighbor indices (wrap with +n then %n so negatives are safe).
  const i0 = (seg - 1 + n) % n;
  const i1 = seg % n;
  const i2 = (seg + 1) % n;
  const i3 = (seg + 2) % n;

  const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2], p3 = pts[i3];
  return {
    x: catmullRom1D(p0.x, p1.x, p2.x, p3.x, t),
    y: catmullRom1D(p0.y, p1.y, p2.y, p3.y, t),
    z: catmullRom1D(p0.z, p1.z, p2.z, p3.z, t),
  };
}

// ---------------------------------------------------------------------------
// SHARED ROAD BANKING (single source of truth for render + physics)
//
// The renderer (src/entities/Track.js) tilts the road ribbon into each turn by a
// bank angle derived from local turn curvature, scaled by BANK_GAIN and clamped to
// ±MAX_BANK. To make the kart sit FLUSH on that visibly-tilted road, the physics
// must use the IDENTICAL numbers — so we own MAX_BANK / BANK_GAIN here and export
// them, and Track.js imports them verbatim. `bankAngleAt` reproduces the renderer's
// exact bank formula at any spline param `u`, so render and sim never disagree.
//
// Sign convention (matches Track.js geometry): bank = clamp(cross * BANK_GAIN),
// where cross is the signed XZ turn rate of the tangent (positive = turning right).
// The renderer raises the edge on the +normal side ((tz,-tx)) by +sin(bank)*halfW
// and lowers the opposite edge — i.e. it tilts INTO the turn. The cross-section is
// therefore height(L) = -sin(bank) * L for a SIGNED lateral L (+ = left of the
// driving direction, the convention nearest() returns). sampleSurface applies that
// exact relation so a kart at any side offset rides the tilted plane flush.
// ---------------------------------------------------------------------------

// Maximum road bank (roll) in radians, applied in the tightest corners.
export const MAX_BANK = 0.10; // ~5.7 degrees
// How hard local turn curvature drives the bank before the MAX_BANK clamp.
export const BANK_GAIN = 5;

/**
 * Bank (roll) angle of the road, in radians, at spline param `u`.
 *
 * Computed deterministically from LOCAL curvature: we sample the centerline
 * tangent slightly before and after `u` and take the signed XZ turn rate
 * (cross product), scale by BANK_GAIN, and clamp to ±MAX_BANK — byte-identical
 * to the inline formula the renderer uses on the road ribbon. PURE (no three,
 * no DOM, no Math.random).
 *
 * @param {string} trackId  a registry key OR a track's inner id.
 * @param {number} u  spline param 0..1 (wrapped).
 * @returns {number} bank angle in radians, in [-MAX_BANK, MAX_BANK].
 */
export function bankAngleAt(trackId, u) {
  const t = TRACKS[resolveKey(trackId)];
  const path = t.path;
  // Tangent here and a tiny step ahead (same finite-step style as sampleCenter /
  // the renderer's per-sample tangents), then the signed turn rate between them.
  const eps = 1e-4;
  const p0 = evalClosedSpline(path, u);
  const p1 = evalClosedSpline(path, u + eps);
  const p2 = evalClosedSpline(path, u + 2 * eps);
  let t1x = p1.x - p0.x, t1z = p1.z - p0.z;
  let t2x = p2.x - p1.x, t2z = p2.z - p1.z;
  const l1 = Math.hypot(t1x, t1z) || 1e-6;
  const l2 = Math.hypot(t2x, t2z) || 1e-6;
  t1x /= l1; t1z /= l1;
  t2x /= l2; t2z /= l2;
  // Signed curvature: how the unit tangent rotates from one step to the next.
  const cross = t1x * t2z - t1z * t2x;
  return Math.max(-MAX_BANK, Math.min(MAX_BANK, cross * BANK_GAIN));
}

// ---------------------------------------------------------------------------
// ANTI-GRAV: SURFACE-RELATIVE WALL/CEILING RIDING (PURE — no three, no random)
//
// Within an `antigrav` section the road's cross-section ROLLS about the driving
// tangent by a per-section ROLL PROFILE (0 -> 2π over a full 360° corkscrew).
// The centerline spline (XZ + hill y) is UNCHANGED — only the cross-section
// frame rotates — so every existing corner/checkpoint/AI/lap test is untouched.
// surfaceFrameAt() derives the (tangent, up, right, worldPos) frame deterministically
// from the SAME track data on client + server, so orientation is never free-integrated.
// ---------------------------------------------------------------------------

/** Wrap a spline param into [0,1). @private */
function wrapU(u) { return ((u % 1) + 1) % 1; }
/** Wrap an angle into [-PI, PI]. @private */
function wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

/**
 * Smootherstep (C2): zero 1st AND 2nd derivative at both ends, so a roll profile
 * built from it has zero roll-RATE at the section boundaries (no orientation pop).
 * @param {number} x  0..1.
 * @returns {number}
 */
function smootherstep(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (x * (6 * x - 15) + 10);
}

/**
 * Corkscrew roll (radians) contributed by anti-grav sections at spline param `s`.
 * 0 outside any section; smootherstep-ramped to 2π*revolutions across a section.
 * @param {string} key  resolved registry key.
 * @param {number} s    spline param 0..1.
 * @returns {number} roll-about-tangent angle from the corkscrew, in radians.
 * @private
 */
function corkscrewAt(key, s) {
  const list = TRACKS[key].antigrav;
  if (!list) return 0;
  for (let i = 0; i < list.length; i++) {
    const sec = list[i];
    if (s >= sec.startU && s <= sec.endU) {
      const f = smootherstep((s - sec.startU) / (sec.endU - sec.startU));
      return 2 * Math.PI * (sec.revolutions || 1) * f;
    }
  }
  return 0;
}

/**
 * Total roll (radians) of the road cross-section about the driving tangent at `s`:
 * the existing road BANK plus the anti-grav corkscrew. Folding bankAngleAt in means
 * OUTSIDE any section rollAt == the existing road bank, so the surface frame's y at a
 * section boundary equals groundY's -sin(bank)*lateral term -> no vertical pop on entry/exit.
 * @param {string} trackId
 * @param {number} s  spline param 0..1.
 * @returns {number}
 */
export function rollAt(trackId, s) {
  const key = resolveKey(trackId);
  return bankAngleAt(key, s) + corkscrewAt(key, s);
}

/**
 * Membership test: is normalized spline param `s` inside an anti-grav section?
 * Wrap-safe (a section may straddle the start line). PURE.
 * @param {string} trackId
 * @param {number} s  spline param 0..1.
 * @returns {{index:number, startU:number, endU:number}|null} the section, or null.
 */
export function antigravAt(trackId, s) {
  const key = resolveKey(trackId);
  const list = TRACKS[key].antigrav;
  if (!list) return null;
  const u = wrapU(s);
  for (let i = 0; i < list.length; i++) {
    const a = list[i].startU;
    const b = list[i].endU;
    const hit = a <= b ? (u >= a && u <= b) : (u >= a || u <= b);
    if (hit) return { index: i, startU: a, endU: b };
  }
  return null;
}

/**
 * The DETERMINISTIC surface frame at (s, lateral): a right-handed basis
 * (tangent, up, right) plus the world position of the point `lateral` metres
 * across the (rolled) tube cross-section. This is the ONLY source of a kart's
 * world pose while it is inside an anti-grav section — so a vertical wall (where
 * the heightfield y is multivalued) is representable. Identical math on client +
 * server (no three, no random); the same tangent/normal construction as
 * Track._surfaceBasisAt, plus a rigid roll of (N0,B0) about the tangent by rollAt.
 *
 * Identities: roll 0 -> up=N0 (road up); 90° -> up=B0 (vertical wall); 180° ->
 * up=-N0 (ceiling). The tangent never points straight up (the corkscrew rolls the
 * cross-section, it does NOT make the spline vertical), so B0 never degenerates.
 *
 * @param {string} trackId
 * @param {number} s             spline param 0..1.
 * @param {number} [lateral=0]   signed-LEFT offset across the tube, in metres
 *                               (nearest()'s lateralSigned convention: + = left).
 * @returns {{tangent:{x,y,z}, up:{x,y,z}, right:{x,y,z}, worldPos:{x,y,z}, roll:number}}
 */
export function surfaceFrameAt(trackId, s, lateral = 0) {
  const key = resolveKey(trackId);
  const path = TRACKS[key].path;
  const ss = wrapU(s);
  const d = 0.0009;
  const a = evalClosedSpline(path, wrapU(ss - d));
  const b = evalClosedSpline(path, wrapU(ss + d));
  // 3D tangent (carries hill pitch via its y component).
  let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
  const tl = Math.hypot(tx, ty, tz) || 1e-6;
  tx /= tl; ty /= tl; tz /= tl;
  // Horizontal road-right B0 = normalize((-T.z, 0, T.x)) — matches Track._surfaceBasisAt.
  let b0x = -tz, b0y = 0, b0z = tx;
  const b0l = Math.hypot(b0x, b0y, b0z) || 1e-6;
  b0x /= b0l; b0y /= b0l; b0z /= b0l;
  // Road up-normal N0 = B0 x T (== today's road up; verified against Track._surfaceBasisAt).
  let n0x = b0y * tz - b0z * ty;
  let n0y = b0z * tx - b0x * tz;
  let n0z = b0x * ty - b0y * tx;
  const n0l = Math.hypot(n0x, n0y, n0z) || 1e-6;
  n0x /= n0l; n0y /= n0l; n0z /= n0l;
  // Rigid rotation of (N0,B0) about the tangent by phi.
  const phi = rollAt(key, ss);
  const c = Math.cos(phi), sp = Math.sin(phi);
  const upx = n0x * c + b0x * sp;
  const upy = n0y * c + b0y * sp;
  const upz = n0z * c + b0z * sp;
  const rx = b0x * c - n0x * sp;
  const ry = b0y * c - n0y * sp;
  const rz = b0z * c - n0z * sp;
  const center = evalClosedSpline(path, ss);
  // worldPos = center + right*lateral. SIGN NOTE (the design's #1 risk): the renderer
  // places the LEFT road edge (nearest()'s lateralSigned = +halfW) at
  // center + B0_xz*halfW with y = cy - sin(bank)*halfW. With right == B0 at phi=0,
  // `+ right*lateral` reproduces BOTH the kart's exact XZ spot AND its banked y at a
  // section boundary (verified). (The design wrote `- B*lateral`; that is mirrored.)
  return {
    tangent: { x: tx, y: ty, z: tz },
    up: { x: upx, y: upy, z: upz },
    right: { x: rx, y: ry, z: rz },
    worldPos: {
      x: center.x + rx * lateral,
      y: center.y + ry * lateral,
      z: center.z + rz * lateral,
    },
    roll: phi,
  };
}

// ---------------------------------------------------------------------------
// TRACK DEFINITIONS
//
// Each track is PURE DATA: an id, display name, theme + colors, a closed-loop
// list of control points (with baked-in `y` hills), a road width, and a list of
// features (boosts, ramps, hazards, shortcuts) placed by spline parameter.
//
// Control points are spaced so the lap is ~3000-4000m and corners stay drivable
// (min radius ~18m). `y` rises and falls to make 2-3 clear hills per course.
//
// @typedef {Object} Feature
// @property {('ramp'|'boost'|'hazard'|'shortcut')} type
// @property {number} at      spline param 0..1 where the feature centers.
// @property {number} offset  lateral placement as a FRACTION of halfWidth
//                            (-1 = left edge, 0 = center, +1 = right edge).
// @property {Object} params  type-specific tuning (size, strength, length...).
//
// @typedef {Object} TrackData
// @property {string} id            stable inner id (legacy: circuit's id stays 'stadium').
// @property {string} name          display name.
// @property {number} color         accent color (hex int) for UI swatches.
// @property {number} groundSize    side length (m) of the square ground plane.
// @property {number} roadWidth     full drivable width (m).
// @property {Array<{x,y,z}>} path  closed-loop Catmull-Rom control points (y=hills).
// @property {Feature[]} features   placed features.
// @property {number} checkpointCount how many lap gates to spread along the loop.
// @property {number} startU        spline param 0..1 of the start/finish line.
// @property {string} theme         'rainbow' | 'space' | 'sky'.
// @property {number} elevation     baseline slab height the course floats at.
// @property {Object} themeColors   render hints {road, rail, rail2}.
// ---------------------------------------------------------------------------

export const TRACKS = {
  // =========================================================================
  // 'circuit' — RAINBOW RIDGE  (theme: rainbow)
  // DRIFT-FIRST + ROLLERCOASTER redesign: a flowing opener rises to a BLIND CREST
  // that hides the plunge into TURN 1, a genuine RIGHT HAIRPIN in the dip, a GLIDE
  // RAMP that launches you up onto a towering ~+68m ridge, a tight S-CHICANE across
  // the peak, a STEEP PLUNGE off the ridge into a LEFT HAIRPIN, a second GLIDE RAMP
  // off the fast sweeper, and a long low straight home. Every hairpin/chicane exit
  // carries a BOOST PAD so a clean drift -> mini-turbo fires you out of the corner —
  // Mario Kart's core loop. Min radius ~16-18m (drift-worthy, comfortably AI-holdable).
  // Inner id stays 'stadium' so old saved netcode that referenced the legacy id resolves.
  // =========================================================================
  circuit: {
    id: 'stadium',
    name: 'Rainbow Ridge',
    color: 0xff4fd8,
    groundSize: 2200,
    roadWidth: 20,
    elevation: 60,
    theme: 'rainbow',
    // PINK RAIL REMOVED: the lurid magenta edge rail (was rail: 0xff2fd0) is gone
    // — Track.js no longer builds a glowing edge rail strip, and the remaining
    // `rail`-tinted props (banner posts / shortcut glow) now read a clean warm
    // amber that fits the candied rainbow palette instead of the harsh pink.
    themeColors: { road: 0x222233, rail: 0xffc24d, rail2: 0x2fd0ff },
    checkpointCount: 32,
    startU: 0.0,
    // ---- ANTI-GRAV (MK8-style wall/ceiling riding) — ADDITIVE FEATURE FLAG ----
    // A list of track SECTIONS (by spline param) where the kart goes SURFACE-RELATIVE
    // and the road's cross-section ROLLS about the driving tangent (a "corkscrew"):
    // road -> right wall -> ceiling -> left wall -> road over `revolutions` full turns.
    // ONLY the 'circuit' track carries this; 'oval'/'figure' omit it, so they are
    // byte-identical to before. EVERY other system ignores this field unless the
    // kart's agSection flag is set, so normal driving everywhere is untouched.
    //
    // [0.72,0.78] is the fast, gently-left OPEN back sweep (control pts 20-23): the
    // nearest features are the airtime ramp at 0.70 (landed by 0.72) and the
    // switchback cone at 0.79 — so this window contains NO ramp/gap/boost/hazard.
    // A single 360° revolution: roll(startU)=0 and roll(endU)=2π≡0 (smootherstep
    // gives zero roll-RATE at both ends), so the section blends seamlessly into the
    // normal road and the kart exits upright.
    antigrav: [{ startU: 0.72, endU: 0.78, revolutions: 1 }],
    // Control points. y is ABSOLUTE world height (elevation baked in). MAX-SPECTACLE
    // COASTER REBUILD: the XZ layout is UNCHANGED (every corner/apex + the AI
    // corner-cut keep working), but `y` now swings VIOLENTLY — ~120m of total
    // verticality (44..164) instead of the old gentle 60..130. The ride now hits a
    // distinct set-piece every few seconds: a steep launch up to a BLIND CREST that
    // plunges off a near-cliff into turn 1, a GLIDE RAMP that rockets you onto a
    // TOWERING ridge (~+100m), an S-CHICANE on the knife-edge peak, a STEEP PLUNGE
    // that free-falls ~70m into the left hairpin, a second GLIDE RAMP off the back
    // sweeper, a rolling drop across the top, then a low fast straight home that is
    // CUT BY A REAL FALL-IN GAP (a launch ramp fires you across the chasm). The tight
    // corners keep their entry / pulled-in apex / exit triplets so the drift band
    // (~16-18m radius) is intact and AI-holdable — drama is in y + ramps + the gap.
    path: [
      { x:   0, y:  48, z: -360 }, // start/finish straight (low base)
      { x: 165, y:  72, z: -345 }, // opening straight ROCKETS up to a BLIND CREST...
      { x: 330, y: 104, z: -290 }, // ...crest top (+56m, hides the cliff drop into turn 1)
      { x: 400, y:  64, z: -200 }, // ---- RIGHT HAIRPIN: entry — near-cliff plunge off the crest
      { x: 462, y:  50, z: -158 }, //      apex (deep low point of the dip, ~19m radius)
      { x: 400, y:  56, z: -116 }, //      exit (bottom of the U), now heading back
      { x: 250, y:  78, z:  -98 }, // hairpin exit run, climbing steeply (boost ~0.14)
      { x: 148, y: 112, z:    8 }, // GLIDE-RAMP launch face (steep ramp up, ~0.24) — nudged NW so the climb clears the return run below
      { x:  98, y: 150, z:   72 }, // SOARING onto the towering ridge — curved WEST so the climb peels off the return run below
      { x: 190, y: 162, z:  140 }, // ---- S-CHICANE on the PEAK: kink right (~+102m)
      { x: 150, y: 164, z:  205 }, //      crest, snap left (KNIFE-EDGE PEAK ~+104m) ----
      { x:  60, y: 154, z:  215 }, //      chicane mid, opening left (still sky-high)
      { x:  -5, y: 124, z:  170 }, // chicane exit, ridge starts to fall hard (boost ~0.38)
      { x: -55, y:  92, z:   85 }, // running left along the ridge shoulder, dropping
      { x: -95, y:  72, z:    0 }, // STEEP PLUNGE off the ridge — near free-fall begins
      { x: -60, y:  50, z:  -60 }, // ---- LEFT HAIRPIN: entry (deep at the bottom of the bowl)
      { x:  10, y:  44, z: -165 }, //      apex (deepest low point, ~20m, deep in the bowl)
      { x:  80, y:  52, z:  -60 }, //      exit (right top of the U), heading back
      { x: 120, y:  74, z:  -48 }, // hairpin exit run, climbing again (boost ~0.58) — held SOUTH/low so it passes under nothing, then sweeps east
      { x: 290, y: 108, z:   90 }, // airtime-ramp climb on the back sweeper (~0.66) — pushed EAST into open space (no longer under the peak)
      { x: 245, y:  74, z:  250 }, // back sweeper crest/landing (low, open road) — EAST of the peak so nothing floats overhead
      { x:  55, y:  64, z:  330 }, // rolling down across the back
      { x:-120, y:  58, z:  335 }, // sweeping left across the top (low)
      { x:-305, y:  78, z:  290 }, // rise into the switchback (a hump)
      { x:-375, y:  92, z:  165 }, // ---- back-left SWITCHBACK: entry (on a tall hump)
      { x:-480, y:  78, z:   95 }, //      apex (poked far out left, ~20m)
      { x:-400, y:  58, z:   15 }, //      exit (dropping fast), pointing home
      { x:-315, y:  50, z:  -95 }, // exit run home, low & flat — LAUNCH RAMP sits here (~0.88)
      { x:-215, y:  50, z: -230 }, // long bottom straight, low flat base — GAP is carved here
      { x: -90, y:  50, z: -350 }, // long bottom straight back to start (low flat base)
    ],
    features: [
      { type: 'boost',    at: 0.02, offset:  0.0, params: { strength: 1.6, length: 14 } }, // launch off the line
      { type: 'hazard',   at: 0.055, offset: -0.5, params: { kind: 'cone', radius: 3 } },    // cone on the opening-straight blind crest (fast-straight drama)
      { type: 'hazard',   at: 0.10, offset:  0.5, params: { kind: 'oil', radius: 5 } },      // oil on the RIGHT-HAIRPIN entry (apex ~0.133)
      { type: 'boost',    at: 0.18, offset:  0.0, params: { strength: 1.7, length: 16 } },   // RIGHT-HAIRPIN exit boost (drift reward)
      { type: 'ramp',     at: 0.24, offset:  0.0, params: { length: 26, rise: 11, kick: 16 } },// airtime ramp up onto the towering ridge (no gap ahead — ordinary boost ramp)
      { type: 'hazard',   at: 0.29, offset: -0.5, params: { kind: 'cone', radius: 3 } },     // cone mid-CHICANE (apex ~0.299)
      { type: 'hazard',   at: 0.325, offset:  0.5, params: { kind: 'cone', radius: 3 } },    // cone on the S-CHICANE's second kink (opposite side — a slalom)
      { type: 'boost',    at: 0.34, offset:  0.0, params: { strength: 1.8, length: 16 } },   // S-CHICANE exit boost (drift reward)
      { type: 'shortcut', at: 0.39, offset:  0.0, params: { branchSide: -1, width: 11, rejoinAt: 0.46, jump: true } }, // ridge-top cut (clear of the left hairpin)
      { type: 'hazard',   at: 0.49, offset:  0.5, params: { kind: 'oil', radius: 5 } },      // oil into the LEFT-HAIRPIN (apex ~0.533)
      { type: 'boost',    at: 0.58, offset:  0.0, params: { strength: 1.8, length: 16 } },   // LEFT-HAIRPIN exit boost (drift reward)
      { type: 'ramp',     at: 0.66, offset:  0.0, params: { length: 24, rise: 10, kick: 14 } },// airtime ramp off the back sweeper (no gap ahead — ordinary boost ramp)
      { type: 'ramp',     at: 0.70, offset:  0.0, params: { length: 20, rise: 8, kick: 12 } }, // airtime ramp on the fast rolling back stretch (no gap ahead — trick airtime)
      { type: 'hazard',   at: 0.79, offset: -0.5, params: { kind: 'cone', radius: 3 } },     // cone into the SWITCHBACK (apex ~0.833)
      // ---- REAL FALL-IN GAP on the low bottom straight ----
      // A LAUNCH RAMP fires the kart off the flat run; ~34m of road is REMOVED (onRoad
      // false, no ribbon rendered) so a kart that misses the launch FALLS IN. The road
      // is low+flat+straight on both sides so a cruise-speed launch clears it cleanly.
      { type: 'boost',   at: 0.879, offset: 0.0, params: { strength: 1.9, length: 18 } }, // PRE-LAUNCH boost — guarantees the kart hits the ramp fast enough to clear the gap
      { type: 'ramp', at: 0.899, offset: 0.0, params: { length: 22, rise: 11, kick: 16, glide: true, launch: true } }, // LAUNCH RAMP right at the chasm rim
      { type: 'gap',  at: 0.904, offset: 0.0, params: { startU: 0.9015, endU: 0.9065, lengthM: 30, requiredLaunchSpeed: 28 } }, // THE CHASM (~30 m arc — crossable with the rim ramp + pre-launch boost)
      { type: 'boost',    at: 0.94, offset:  0.0, params: { strength: 1.7, length: 16 } },   // landing-run boost after the gap (recover speed)
      { type: 'ramp',     at: 0.965, offset: 0.0, params: { length: 18, rise: 7, kick: 11 } }, // airtime ramp on the low home straight (flat landing — trick airtime)
    ],
  },

  // =========================================================================
  // 'oval' — COSMIC SPEEDWAY  (theme: space)
  // A FAST + ROLLERCOASTER course: a huge flowing turn-1 sweeper and long straights
  // keep the top-end speed, but the lap now rolls over a BIG blind-crest hill (~+52m),
  // dives into a low chicane bowl, climbs a TALL crest-2, and a GLIDE RAMP launches a
  // long flight into an open landing run. The back half still packs a TIGHT CHICANE,
  // a RIGHT HAIRPIN and a LEFT SWITCHBACK so the drift loop lives between the fast
  // sections. Exit boosts reward nailing each drift. Widest road of the three.
  // =========================================================================
  oval: {
    id: 'oval',
    name: 'Cosmic Speedway',
    color: 0x4ea1ff,
    groundSize: 2400,
    roadWidth: 22,
    elevation: 60,
    theme: 'space',
    themeColors: { road: 0x0c0c14, rail: 0x00e5ff, rail2: 0xff00e5 },
    checkpointCount: 30,
    startU: 0.0,
    // ---- ANTI-GRAV (MK8-style wall/ceiling riding) — same data-driven flag as circuit ----
    // A single 360° corkscrew on the fast turn-1-exit straight. [0.24,0.31] sits BETWEEN
    // the oil hazards at 0.22 and 0.34, so the window holds NO ramp/gap/boost/hazard.
    // roll(startU)=0 and roll(endU)=2π≡0 (smootherstep => zero roll-RATE at both ends),
    // so it blends seamlessly into the road and the kart exits upright. Read purely by
    // antigravAt/surfaceFrameAt/updateAntigravTransition — no code change needed.
    antigrav: [{ startU: 0.24, endU: 0.31, revolutions: 1 }],
    // XZ scaled large for a fast ~3500m lap (UNCHANGED). MAX-SPECTACLE COASTER REBUILD:
    // `y` now rolls HARD — ~100m of verticality (50..150) instead of the old 58..118.
    // A long opening climb ROCKETS over a BIG rolling hill (~+74m) that blind-crests
    // into turn 1, a sweeping plunge feeds the chicane in a deep low bowl, the right
    // hairpin CLIMBS onto a TALL crest-2 (~+100m), a GLIDE RAMP off that crest launches
    // a long flight into an open low landing run, the switchback sits low, and the long
    // turn-4 sweep home is low+flat and CUT BY A REAL FALL-IN GAP (a launch ramp jumps
    // it). Tight corners keep their entry/poked-apex/exit triplets (drift band ~18-24m).
    // Fastest course, so the hills are long and rolling, not kinked — AI-holdable.
    path: [
      { x:   0, y:  50, z: -470 }, // start straight (low base)
      { x: 200, y:  84, z: -450 }, // long opening straight — climbing HARD
      { x: 380, y: 124, z: -380 }, // BIG ROLLING HILL crest (~+74m, blind into turn 1)
      { x: 485, y: 132, z: -225 }, // crest top of the hill (~+82m)
      { x: 515, y: 100, z:  -40 }, // long plunge off the hill
      { x: 470, y:  74, z:  140 }, // rolling down toward the chicane bowl
      { x: 370, y:  60, z:  300 }, // dropping into the deep low bowl
      { x: 215, y:  52, z:  400 }, // sweeping down toward the chicane (deep low point)
      { x: 110, y:  52, z:  430 }, // ---- TIGHT CHICANE in the bowl: snap left ... ----
      { x:  35, y:  56, z:  370 }, //      ... then hard right (~22m) ...
      { x: 100, y:  64, z:  300 }, //      ... chicane exit, climbing out (boost ~0.43)
      { x:  35, y:  80, z:  235 }, // climbing back up steeply
      { x:-110, y: 100, z:  255 }, // link toward the back hairpin, still rising
      { x:-255, y: 124, z:  320 }, // ---- RIGHT HAIRPIN (poked far up) entry, high ----
      { x:-320, y: 138, z:  410 }, //      apex (~20m, climbing onto TALL crest 2)
      { x:-385, y: 150, z:  320 }, //      exit onto crest-2 PEAK (~+100m, boost ~0.56)
      { x:-470, y: 110, z:  175 }, // GLIDE-RAMP launch off crest 2 (~0.64), long flight
      { x:-505, y:  64, z:   25 }, // open LANDING ZONE (low, steep ~86m drop landed into)
      { x:-470, y:  54, z: -110 }, // ---- LEFT SWITCHBACK entry (low) ----
      { x:-540, y:  50, z: -190 }, //      apex (poked far out left, ~21m, low)
      { x:-470, y:  50, z: -270 }, //      exit (boost ~0.78), low & flat — LAUNCH RAMP here
      { x:-355, y:  50, z: -385 }, // GAP carved here — STRAIGHT chute (collinear with the launch so the vertical jump flies straight across)
      { x:-240, y:  50, z: -500 }, // gap LANDING run — continues the launch line (no sweep, so the kart lands back on road)
      { x: -90, y:  52, z: -495 }, // landing run, then curves back toward the start line
    ],
    features: [
      { type: 'boost',  at: 0.03, offset:  0.0, params: { strength: 1.7, length: 18 } },  // off the line down the straight
      { type: 'hazard', at: 0.05, offset:  0.55, params: { kind: 'cone', radius: 3 } },    // cone on the long opening straight (fast-straight drama)
      { type: 'ramp',   at: 0.095, offset: 0.0, params: { length: 24, rise: 9, kick: 13 } },// airtime ramp off the BIG rolling hill crest (no gap ahead — trick airtime into turn 1)
      { type: 'boost',  at: 0.18, offset:  0.0, params: { strength: 1.9, length: 20 } },  // mid turn-1 exit, big sweeper
      { type: 'hazard', at: 0.22, offset: -0.55, params: { kind: 'oil', radius: 6 } },     // oil on the fast plunge toward the bowl (sets up a weave into the chicane)
      { type: 'hazard', at: 0.34, offset:  0.55, params: { kind: 'oil', radius: 6 } },     // oil into the CHICANE
      { type: 'boost',  at: 0.43, offset:  0.0, params: { strength: 1.8, length: 18 } },   // TIGHT-CHICANE exit boost (drift reward)
      { type: 'hazard', at: 0.53, offset: -0.55, params: { kind: 'cone', radius: 3 } },     // cone into the RIGHT HAIRPIN (apex ~0.583)
      { type: 'boost',  at: 0.62, offset:  0.0, params: { strength: 1.9, length: 20 } },   // RIGHT-HAIRPIN exit boost (drift reward)
      { type: 'ramp',   at: 0.64, offset:  0.0, params: { length: 30, rise: 12, kick: 18 } },// airtime ramp off TALL crest 2 (no gap ahead — ordinary boost ramp)
      { type: 'hazard', at: 0.72, offset:  0.5, params: { kind: 'oil', radius: 6 } },       // oil into the SWITCHBACK
      { type: 'boost',  at: 0.79, offset:  0.0, params: { strength: 1.8, length: 20 } },   // LEFT-SWITCHBACK exit boost (drift reward)
      // ---- REAL FALL-IN GAP on the long low turn-4 sweep home ----
      // A LAUNCH RAMP fires the kart off the flat sweep; ~25m of road is REMOVED so a
      // missed launch FALLS IN. The widest+fastest course, so the gap is the longest of
      // the three; the road is low+flat on both sides for a clean cruise-speed clearance.
      { type: 'boost',  at: 0.838, offset: 0.0, params: { strength: 1.9, length: 20 } }, // PRE-LAUNCH boost — guarantees gap-jump speed on the fastest course
      { type: 'ramp', at: 0.861, offset: 0.0, params: { length: 26, rise: 12, kick: 18, glide: true, launch: true } }, // LAUNCH RAMP at the chasm rim
      { type: 'gap',  at: 0.868, offset: 0.0, params: { startU: 0.864, endU: 0.870, lengthM: 30, requiredLaunchSpeed: 28 } }, // THE CHASM (~30 m, straight aligned chute)
      { type: 'shortcut', at: 0.90, offset: 0.0, params: { branchSide: 1, width: 12, rejoinAt: 0.98, jump: false } }, // inside-line cut to the line (after the gap)
    ],
  },

  // =========================================================================
  // 'figure' — CLOUDTOP CIRCUIT  (theme: sky)
  // The TWISTIEST course and the real DRIFT PLAYGROUND, a sky ROLLERCOASTER: a GLIDE
  // RAMP launches a steep climb to a soaring CLOUD PEAK (~+125m, by far the highest
  // point of all three tracks), then a sharp plunge, a TIGHT RIGHT HAIRPIN, a high
  // S-CHICANE, and a LEFT SWITCHBACK before a low return run home. Narrowest road so
  // the line matters; every tight corner exits onto a BOOST PAD so a clean drift fires
  // you out. REDESIGNED as a SIMPLE NON-SELF-CROSSING LOOP (was a figure-of-eight):
  // the path never passes over/under itself in plan view, so no section of road ever
  // floats overhead. The hairpin + switchback poke OUTWARD (tight corners without any
  // crossing); the peak/plunge/chicane are spread into their own XZ lanes.
  // =========================================================================
  figure: {
    id: 'figure',
    name: 'Cloudtop Circuit',
    color: 0xfff0a8,
    groundSize: 2200,
    roadWidth: 17,
    elevation: 60,
    theme: 'sky',
    themeColors: { road: 0xaec4e2, rail: 0xffffff, rail2: 0xffd34d },
    checkpointCount: 34,
    startU: 0.0,
    // ---- ANTI-GRAV (MK8-style wall/ceiling riding) — same data-driven flag as circuit ----
    // A single 360° corkscrew on the climbing approach to T1. [0.12,0.19] sits BETWEEN
    // the cone at 0.10 and the glide-ramp at 0.20, and is well clear of the figure-8
    // crossing, so the window holds NO ramp/gap/boost/hazard. roll(startU)=0 and
    // roll(endU)=2π≡0 (smootherstep => zero roll-RATE at both ends), so it blends
    // seamlessly into the road and the kart exits upright. Read purely by
    // antigravAt/surfaceFrameAt/updateAntigravTransition — no code change needed.
    antigrav: [{ startU: 0.12, endU: 0.19, revolutions: 1 }],
    // Twistiest course: XZ scaled large for a ~3400m technical lap (UNCHANGED).
    // MAX-SPECTACLE COASTER REBUILD: `y` is now the MOST EXTREME of the three —
    // ~125m of verticality (52..177) instead of the old 58..143. A GLIDE RAMP rockets
    // you up a steep climb toward a SOARING CLOUD PEAK (~+125m — the highest point of
    // all three tracks by far), a SHARP PLUNGE free-falls ~70m off it, the right
    // hairpin sits in a mid dip, a twisty high shelf feeds the far-left sweep home,
    // and the low far-left sweep is CUT BY A REAL FALL-IN GAP (a launch ramp jumps it).
    // CRUCIAL (PRESERVED for the figure-8 continuity): the low RETURN LOOP near the
    // start stays LOW (~50-52) while the hairpin's exit run passes well ABOVE it (~80+),
    // and the crossing-near point over the start area stays clearly higher than the
    // low base under it — the crossings remain far apart in ARC-LENGTH AND clearly
    // different in height, so the continuity-aware nearest() never floats a kart onto
    // the road overhead (still 0 level-flips at the overpass).
    path: [
      { x:   10, y:  52, z: -470 }, // START (bottom, low)
      { x:  113, y:  54, z: -460 }, // bottom-right
      { x:  211, y:  62, z: -431 }, // T1 approach, climbing
      { x:  301, y:  80, z: -384 }, // ---- TURN 1 (sweeping right), climbing
      { x:  378, y: 106, z: -321 }, // climbing the right side
      { x:  439, y: 138, z: -245 }, // GLIDE-RAMP launch face (steep, ~0.20)
      { x:  481, y: 162, z: -159 }, // SOARING up toward the cloud
      { x:  502, y: 176, z:  -67 }, // cloud peak approach
      { x:  502, y: 177, z:   27 }, // CLOUD PEAK (~+125m, by far the highest point of all)
      { x:  481, y: 150, z:  119 }, // SHARP PLUNGE off the peak — near free-fall begins
      { x:  439, y: 108, z:  205 }, // plunge bottoming out (steep ~85m drop, oil ~0.32)
      { x:  403, y:  84, z:  304 }, // descending toward the hairpin (cone ~0.38)
      { x:  380, y:  74, z:  453 }, // ---- RIGHT HAIRPIN entry (pokes far OUT, top of loop)
      { x:  299, y:  66, z:  588 }, //      apex (~35m, the loop's far point)
      { x:  137, y:  72, z:  536 }, //      exit (boost ~0.47), heading back in
      { x:   10, y:  90, z:  430 }, // climbing onto the high chicane shelf
      { x: -103, y: 104, z:  467 }, // ---- S-CHICANE: kink out ... ----
      { x: -169, y: 108, z:  342 }, //      ... then back in (high shelf) ...
      { x: -281, y: 104, z:  344 }, //      chicane exit (boost ~0.62)
      { x: -398, y:  94, z:  317 }, // link toward the switchback, dropping
      { x: -570, y:  84, z:  293 }, // ---- LEFT SWITCHBACK apex (pokes far OUT left, ~35m)
      { x: -527, y:  70, z:  141 }, //      switchback exit dropping fast (UNCHANGED — AI-holdable)
      { x: -482, y:  56, z:   27 }, // LAUNCH RAMP before the gap (low+flat)
      { x: -437, y:  52, z:  -87 }, // gap LANDING run — continues the launch line (no kink, so the jump flies STRAIGHT across)
      { x: -396, y:  52, z: -190 }, // post-gap low, same straight line (shortcut ~0.80)
      { x: -419, y:  54, z: -245 }, // little airtime ramp (~0.84)
      { x: -358, y:  54, z: -321 }, // return run, low along the bottom-left
      { x: -281, y:  52, z: -384 }, // return run, low
      { x: -191, y:  52, z: -431 }, // return curve (oil ~0.93)
      { x:  -93, y:  52, z: -460 }, // low base into the start line
    ],
    features: [
      { type: 'boost',    at: 0.02, offset:  0.0, params: { strength: 1.6, length: 14 } }, // launch
      { type: 'hazard',   at: 0.05, offset:  0.5, params: { kind: 'cone', radius: 3 } },     // cone on the bottom-right opening straight (fast-straight drama before T1)
      { type: 'hazard',   at: 0.10, offset:  0.5, params: { kind: 'cone', radius: 3 } },     // cone in T1
      { type: 'ramp',     at: 0.20, offset:  0.0, params: { length: 24, rise: 11, kick: 16 } },// airtime ramp up toward the cloud peak (no gap ahead — ordinary boost ramp)
      { type: 'boost',    at: 0.26, offset:  0.0, params: { strength: 1.7, length: 14 } },   // over-the-peak speed
      { type: 'hazard',   at: 0.32, offset: -0.55, params: { kind: 'oil', radius: 4 } },      // oil on the plunge
      { type: 'hazard',   at: 0.38, offset:  0.5, params: { kind: 'cone', radius: 3 } },      // cone into the RIGHT HAIRPIN (apex ~0.43)
      { type: 'boost',    at: 0.47, offset:  0.0, params: { strength: 1.8, length: 14 } },   // RIGHT-HAIRPIN exit boost (drift reward)
      { type: 'hazard',   at: 0.55, offset:  0.5, params: { kind: 'cone', radius: 3 } },      // cone mid S-CHICANE
      { type: 'boost',    at: 0.62, offset:  0.0, params: { strength: 1.8, length: 14 } },   // S-CHICANE exit boost (drift reward)
      { type: 'boost',    at: 0.715, offset: 0.0, params: { strength: 1.8, length: 16 } },   // PRE-LAUNCH boost on the runway — surges approach speed so the gap jump always clears
      // ---- REAL FALL-IN GAP on the low far-left sweep ----
      // A LAUNCH RAMP fires the kart off the descending sweep; ~28m of road is REMOVED
      // (narrowest course, so the shortest gap) so a missed launch FALLS IN. The road
      // is low+flat on both sides for a clean cruise-speed clearance.
      { type: 'ramp', at: 0.736, offset: 0.0, params: { length: 20, rise: 9, kick: 14, glide: true, launch: true } }, // LAUNCH RAMP just before the chasm (narrowest gap, clears with margin)
      { type: 'gap',  at: 0.744, offset: 0.0, params: { startU: 0.7415, endU: 0.7458, lengthM: 18, requiredLaunchSpeed: 26 } }, // THE CHASM (~18 m, narrowest course — crossable with margin)
      { type: 'shortcut', at: 0.80, offset:  0.0, params: { branchSide: 1, width: 9, rejoinAt: 0.88, jump: false } }, // inside-line cut on the low return run
      { type: 'ramp',     at: 0.84, offset:  0.0, params: { length: 13, rise: 4, kick: 9 } },  // little airtime on the far-left sweep
      { type: 'ramp',     at: 0.885, offset: 0.0, params: { length: 16, rise: 6, kick: 11 } }, // airtime ramp on the low home straight (flat landing — trick airtime)
      { type: 'hazard',   at: 0.93, offset: -0.45, params: { kind: 'oil', radius: 4 } },        // oil on the return curve
    ],
  },
};

// ---------------------------------------------------------------------------
// TIME-TRIAL TARGET LAP TIMES (medals) — PURE DATA.
//
// Per-track gold / silver / bronze lap-time thresholds in SECONDS. A finished
// time-trial lap earns the best medal whose threshold it beats (lap <= gold ->
// gold, etc). Chosen from each course's measured XZ lap length (~3.5-3.9 km)
// against a clean-run average pace: gold ~32 m/s (all boosts, tidy drifts),
// bronze ~22 m/s (cruise). Kids' arcade targets — bronze is easy, gold is hard.
// ponytail: tuning knob — these are plain numbers, bump them after real laps if
// the field plays faster/slower than the pace estimate above.
export const TARGET_LAP_TIMES = {
  circuit: { gold: 120, silver: 145, bronze: 175 }, // Rainbow Ridge    (~3870 m)
  oval:    { gold: 108, silver: 130, bronze: 158 }, // Cosmic Speedway  (~3531 m, fastest)
  figure:  { gold: 110, silver: 132, bronze: 160 }, // Cloudtop Circuit (~3504 m, twistiest)
};

// The default / legacy track id. No-trackId callers resolve to this.
const DEFAULT_TRACK_ID = 'circuit';

// ---------------------------------------------------------------------------
// DENSE SAMPLED-POLYLINE CACHE
//
// Evaluating the spline directly is fine for a few points, but the per-frame
// queries (isOnRoad, sampleSurface) need a FAST "nearest point on the loop"
// answer. So once per track we sample the spline at many evenly-stepped `u`
// values into a polyline, recording for each sample:
//   - position (x,y,z),
//   - unit XZ tangent (tx,tz) = driving direction,
//   - cumulative arc-length `s` (meters from the start of the loop),
//   - the spline param `u` (0..1) it came from.
// `isOnRoad`/`sampleSurface` then just scan the polyline for the closest sample
// and refine onto the local segment — all pure, allocation-light, deterministic.
//
// SAMPLES is chosen in the 800-1400 range the contract suggests; more samples =
// finer nearest-point resolution at a tiny one-time build cost.
// ---------------------------------------------------------------------------

const SAMPLES = 1200;

/** Per-track cache, built lazily on first use and reused thereafter. */
const _cache = Object.create(null);

/**
 * Build (or fetch) the dense sampled-polyline cache for a track.
 * @param {string} key  the registry KEY ('circuit' | 'oval' | 'figure').
 * @returns {{
 *   pts:Array, samples:Array<{x,y,z,tx,tz,s,u}>, total:number,
 *   feats:Array, checkpoints:Array
 * }}
 */
function getCache(key) {
  if (_cache[key]) return _cache[key];

  const t = TRACKS[key];
  const pts = t.path;
  const samples = new Array(SAMPLES);

  // Pass 1: sample positions evenly in `u`.
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / SAMPLES;
    const p = evalClosedSpline(pts, u);
    samples[i] = { x: p.x, y: p.y, z: p.z, tx: 0, tz: 0, s: 0, u };
  }

  // Pass 2: cumulative arc-length (XZ distance between consecutive samples) and
  // unit XZ tangents (driving direction). The loop is closed, so the last
  // segment connects sample[N-1] back to sample[0].
  let acc = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % SAMPLES];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1e-6;
    // Tangent for sample i points toward sample i+1 (driving forward).
    a.tx = dx / len;
    a.tz = dz / len;
    a.s = acc;
    acc += len;
  }
  const total = acc; // full lap length in meters (XZ arc-length)

  const cache = { pts, samples, total, feats: null, checkpoints: null, gaps: null };
  _cache[key] = cache;
  return cache;
}

/**
 * Find the nearest sample on a track's polyline to (x,z), returning a small
 * descriptor used by the surface/road queries. PURE, allocation-light: it
 * scans the cached samples (no allocation) and returns plain numbers.
 *
 * @param {string} key  registry key.
 * @param {number} x
 * @param {number} z
 * @param {number} [y]  OPTIONAL kart height. When a finite number, selection is
 *   HEIGHT-AWARE so the sample at the kart's OWN height wins at overpasses (two
 *   samples share nearly the same XZ but very different cy): we pick the sample
 *   minimizing dx*dx + dz*dz + (cy - y)^2. When undefined/NaN, selection is the
 *   EXACT pure-XZ nearest (backward compatible). `dist` below is ALWAYS the pure
 *   XZ distance to the selected sample (so lateral/onRoad stay correct).
 * @param {number} [sHint]  OPTIONAL the kart's progress (spline param u, 0..1) on
 *   the PREVIOUS frame. When finite, selection is ALSO CONTINUITY-AWARE: samples
 *   whose arc-length is more than CONTINUITY_DEADZONE_M beyond sHint get a strong
 *   quadratic penalty, so the kart stays on the road SECTION it is already driving.
 *   This is what actually stops the "sucked onto the track above" overpass bug:
 *   the height term alone only clears half the vertical gap (it flips at the
 *   midpoint), but the upper section is ~1/3 of a lap away in arc-length, so the
 *   continuity penalty makes it impossible to select regardless of the kart's
 *   height/bumps. Omitted/NaN => no continuity bias (backward compatible).
 * @returns {{i:number, dist:number, lateral:number, s:number, u:number,
 *            cx:number, cy:number, cz:number, tx:number, tz:number}}
 *   i = index of nearest sample, dist = XZ distance to centerline,
 *   lateral = signed left/right offset (+ = right of driving dir),
 *   s/u = arc-length / spline param at that point, c* = centerline pos,
 *   t* = unit driving tangent there.
 */
// Continuity tuning: a kart may move this far in arc-length per frame with NO
// penalty (covers top speed + spin/knockback slack). Beyond it, the penalty grows
// quadratically and KW makes a far-away (overpass) section impossible to select.
const CONTINUITY_DEADZONE_M = 40;
const CONTINUITY_WEIGHT = 6;
function nearest(key, x, z, y, sHint) {
  const c = getCache(key);
  const samples = c.samples;
  // Height-aware only when y is a finite number; otherwise pure XZ (unchanged).
  const useY = typeof y === 'number' && Number.isFinite(y);
  // Continuity-aware only when sHint is a finite number; otherwise no bias.
  const useHint = typeof sHint === 'number' && Number.isFinite(sHint);
  const total = c.total || 1;
  let bestI = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const sdx = x - samples[i].x;
    const sdz = z - samples[i].z;
    let d2 = sdx * sdx + sdz * sdz;
    if (useY) {
      // Add the height term so the sample at the kart's OWN height wins where two
      // sections overlap in XZ (overpass). Deterministic — no randomness.
      const sdy = samples[i].y - y;
      d2 += sdy * sdy;
    }
    if (useHint) {
      // Wrapped arc-length distance from where the kart was last frame. Samples
      // beyond the deadzone (i.e. a different part of the lap, like the section
      // crossing overhead) are pushed far away so they can't be selected.
      let du = Math.abs(samples[i].u - sHint);
      if (du > 0.5) du = 1 - du; // shorter way around the loop
      const over = du * total - CONTINUITY_DEADZONE_M;
      if (over > 0) d2 += over * over * CONTINUITY_WEIGHT;
    }
    if (d2 < bestD2) { bestD2 = d2; bestI = i; }
  }
  const a = samples[bestI];
  // Signed lateral offset: cross product of tangent and (point - center) in XZ.
  // tangent (tx,tz); point offset (px,pz). cross = tx*pz - tz*px. + => left side
  // (the convention bankAngleAt / sampleSurface's bank offset rely on).
  const px = x - a.x;
  const pz = z - a.z;
  const lateral = a.tx * pz - a.tz * px;
  // `dist` stays the PURE XZ distance to the SELECTED sample (selection may be
  // height-aware, but lateral/onRoad must measure side-offset, not 3D distance).
  const dist = Math.hypot(px, pz);

  // ---- SMOOTH (interpolated) centerline height ----------------------------
  // Returning the nearest VERTEX height makes groundY a staircase (it jumps each
  // time a different sample wins), which shakes the kart. Instead we project the
  // point onto the two centerline segments adjacent to bestI, pick whichever the
  // point is genuinely closer to, and LERP the baked heights along it. This gives
  // a continuous groundY (cyInterp) and a continuous arc-length param (uProj).
  const n = samples.length;
  const iPrev = (bestI - 1 + n) % n; // segment [iPrev, bestI]
  const iNext = (bestI + 1) % n;     // segment [bestI, iNext]

  // Project (x,z) onto a segment [j0,j1]; return clamped param t and squared
  // distance from the point to the projected position. Closed-loop safe.
  function projectSeg(j0, j1) {
    const s0 = samples[j0], s1 = samples[j1];
    const ex = s1.x - s0.x;
    const ez = s1.z - s0.z;
    const len2 = ex * ex + ez * ez || 1e-12;
    let tt = ((x - s0.x) * ex + (z - s0.z) * ez) / len2;
    if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
    const qx = s0.x + ex * tt;
    const qz = s0.z + ez * tt;
    const ddx = x - qx, ddz = z - qz;
    return { t: tt, d2: ddx * ddx + ddz * ddz, j0, j1 };
  }
  const segA = projectSeg(iPrev, bestI);
  const segB = projectSeg(bestI, iNext);
  const seg = segA.d2 <= segB.d2 ? segA : segB;
  const s0 = samples[seg.j0], s1 = samples[seg.j1];
  // Interpolated baked height along the chosen segment (the smooth groundY).
  const cyInterp = s0.y + (s1.y - s0.y) * seg.t;
  // Interpolated arc-length param u along the segment. The closing segment wraps
  // sample[n-1] -> sample[0] (u goes ...->~1 then 0); add 1 before lerp so the
  // wrap interpolates monotonically, then fold back into [0,1).
  let u0 = s0.u;
  let u1 = s1.u;
  if (u1 < u0) u1 += 1; // wrapped closing segment
  let uProj = u0 + (u1 - u0) * seg.t;
  uProj -= Math.floor(uProj);

  return {
    i: bestI, dist, lateral, s: a.s, u: a.u,
    cx: a.x, cy: cyInterp, cz: a.z, tx: a.tx, tz: a.tz,
    // New smooth fields (added; existing fields above are unchanged):
    cyInterp, uProj, lateralSigned: lateral, seg: seg.j0, segT: seg.t,
  };
}

// ---------------------------------------------------------------------------
// FEATURE RESOLUTION CACHE
//
// Features are stored by spline param `at` + lateral `offset` (fraction of
// halfWidth). To detect contact / place meshes we need ABSOLUTE world positions.
// We resolve each feature ONCE per track into {type,x,y,z,tx,tz,params} and
// cache it. Boost/ramp footprints are tested by sampleSurface using these.
// ---------------------------------------------------------------------------

/**
 * Resolve a track's features to absolute world positions (cached).
 * @param {string} key  registry key.
 * @returns {Array<{type,x,y,z,tx,tz,params}>}
 */
function getFeatures(key) {
  const c = getCache(key);
  if (c.feats) return c.feats;

  const t = TRACKS[key];
  const halfW = t.roadWidth / 2;
  const out = [];

  for (const f of t.features) {
    // Centerline point + tangent at the feature's spline param.
    const center = evalClosedSpline(t.path, f.at);
    // Tangent via a tiny finite step forward along u (pure, deterministic).
    const ahead = evalClosedSpline(t.path, f.at + 1e-4);
    let tx = ahead.x - center.x;
    let tz = ahead.z - center.z;
    const tl = Math.hypot(tx, tz) || 1e-6;
    tx /= tl; tz /= tl;
    // Right-hand normal in XZ (perpendicular to tangent): (tz, -tx).
    const nx = tz;
    const nz = -tx;
    const lat = (f.offset || 0) * halfW; // meters off-center
    out.push({
      type: f.type,
      x: center.x + nx * lat,
      y: center.y,
      z: center.z + nz * lat,
      tx, tz,
      params: { ...(f.params || {}) },
      at: f.at,
      offset: f.offset || 0,
    });
  }
  c.feats = out;
  return out;
}

// ---------------------------------------------------------------------------
// GAP (FALL-IN CHASM) RESOLUTION CACHE
//
// A 'gap' feature carves a REAL hole in the road: over its spline-param range
// [startU, endU] the road STOPS being drivable (isOnRoad/sampleSurface return
// onRoad:false) so a kart that misses the launch ramp FALLS IN — and Track.js
// skips the ribbon there so the void is visible. The CENTERLINE SPLINE stays
// fully defined across the gap (groundY/slope/s remain continuous for arc-length)
// — only the onRoad-ness drops out, exactly as the contract requires.
//
// We resolve each track's gaps ONCE into a tiny array of {startU,endU} ranges
// (normalized 0..1). The range can wrap past 1 (startU > endU) just like the
// shortcut u-range, and we test membership the same wrapped way.
// ---------------------------------------------------------------------------

/**
 * Resolve a track's gap ranges (cached). Each entry is { startU, endU } in
 * normalized spline param 0..1 (a wrapped range when startU > endU).
 * @param {string} key  registry key.
 * @returns {Array<{startU:number, endU:number}>}
 */
function getGaps(key) {
  const c = getCache(key);
  if (c.gaps) return c.gaps;
  const t = TRACKS[key];
  const out = [];
  for (const f of t.features) {
    if (f.type !== 'gap') continue;
    const p = f.params || {};
    // Default the range to a tight band around `at` if the data omits it, so a
    // gap is never zero-length by accident.
    const startU = p.startU != null ? p.startU : (f.at - 0.005);
    const endU = p.endU != null ? p.endU : (f.at + 0.005);
    out.push({ startU: ((startU % 1) + 1) % 1, endU: ((endU % 1) + 1) % 1 });
  }
  c.gaps = out;
  return out;
}

/**
 * True if a normalized spline param `u` lies inside ANY of a track's gaps. Used
 * by isOnRoad to drop the road out over the chasm. Wrapped-range aware. PURE.
 * @param {string} key  registry key.
 * @param {number} u    normalized spline param 0..1.
 * @returns {boolean}
 */
function inGap(key, u) {
  const gaps = getGaps(key);
  for (let i = 0; i < gaps.length; i++) {
    const a = gaps[i].startU;
    const b = gaps[i].endU;
    const hit = a <= b ? (u >= a && u <= b) : (u >= a || u <= b);
    if (hit) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * List the available track ids, in registry (display) order.
 * @returns {string[]} ['circuit', 'oval', 'figure']
 */
export function getTrackIds() {
  return Object.keys(TRACKS);
}

/**
 * Resolve a track id to its registry KEY. Accepts a registry key
 * ('circuit'|'oval'|'figure') OR a track's inner `id` ('stadium' -> circuit), so
 * old saved data keeps resolving. Unknown / missing ids fall back to default.
 * @param {string} [trackId]
 * @returns {string} the registry key.
 */
function resolveKey(trackId) {
  if (!trackId) return DEFAULT_TRACK_ID;
  if (TRACKS[trackId]) return trackId;
  for (const key of Object.keys(TRACKS)) {
    if (TRACKS[key].id === trackId) return key;
  }
  return DEFAULT_TRACK_ID;
}

/**
 * Lightweight metadata for a track (for menus / HUD / theming).
 * @param {string} [trackId]
 * @returns {{id:string, name:string, color:number}} the registry KEY as `id`.
 */
export function getTrackMeta(trackId) {
  const key = resolveKey(trackId);
  const t = TRACKS[key];
  return { id: key, name: t.name, color: t.color };
}

/**
 * Theme info for a track: theme id + elevation + color hints. PURE (no three).
 * @param {string} [trackId]
 * @returns {{theme:string, elevation:number, colors:Object}}
 */
export function getTrackTheme(trackId) {
  const t = TRACKS[resolveKey(trackId)];
  return {
    theme: t.theme || 'sky',
    elevation: t.elevation || 0,
    colors: { ...(t.themeColors || {}) },
  };
}

/**
 * Per-theme bloom strength hint (KEEP the Phase-2 values). PURE (no three).
 * @param {string} theme  'rainbow' | 'space' | 'sky'.
 * @returns {number} UnrealBloom strength.
 */
export function getThemeBloom(theme) {
  switch (theme) {
    case 'rainbow': return 0.13;
    case 'space': return 0.15;
    case 'sky': return 0.05;
    default: return 0.05;
  }
}

/**
 * Build ordered centerline checkpoints (gates) spread evenly by ARC-LENGTH along
 * the long spline loop. Index 0 is the start/finish line (track.startU). Many
 * gates (track.checkpointCount) make AI / lap progress smooth on the long course.
 *
 * Each gate carries 3D `y` (the hill height at that point) so markers, camera,
 * and AI splines ride the terrain. Ordered in the driving direction.
 *
 * @param {string} [trackId]
 * @returns {Array<{x:number, y:number, z:number, index:number}>} ordered gates.
 */
export function buildCheckpoints(trackId) {
  const key = resolveKey(trackId);
  const c = getCache(key);
  if (c.checkpoints) return c.checkpoints.map((g) => ({ ...g }));

  const t = TRACKS[key];
  const n = Math.max(4, t.checkpointCount | 0);
  const startU = t.startU || 0;
  const gates = new Array(n);

  for (let i = 0; i < n; i++) {
    // Evenly spaced in spline param, offset so gate 0 sits at the start line.
    const u = startU + i / n;
    const p = evalClosedSpline(t.path, u);
    gates[i] = { x: p.x, y: p.y, z: p.z, index: i };
  }
  c.checkpoints = gates;
  return gates.map((g) => ({ ...g }));
}

/**
 * The canonical spawn pose for a track: on the road centerline at the start line,
 * facing the driving direction (heading from the local tangent).
 * @param {string} [trackId]
 * @returns {{x:number, y:number, z:number, heading:number}}
 */
export function getStartPosition(trackId) {
  const key = resolveKey(trackId);
  const t = TRACKS[key];
  const startU = t.startU || 0;
  const p = evalClosedSpline(t.path, startU);
  const ahead = evalClosedSpline(t.path, startU + 1e-4);
  const heading = Math.atan2(ahead.x - p.x, ahead.z - p.z);
  return { x: p.x, y: p.y, z: p.z, heading };
}

/**
 * Point-in-road test: project (x,z) to the nearest centerline point; true if the
 * lateral distance is within roadWidth/2, OR the point lies within an active
 * shortcut branch band. PURE — byte-identical on client + server.
 *
 * BACKWARD-COMPAT: original signature was isOnRoad(x, z). If the first arg is a
 * number, treat it as x and use the default track.
 *
 * @param {string|number} [trackId]  a track id, OR (legacy) the x coordinate.
 * @param {number} x
 * @param {number} z
 * @param {number} [y]  OPTIONAL kart height; when finite, the centerline pick is
 *   height-aware (so an overpass's lower section isn't judged against the upper
 *   one). Omitted => pure-XZ pick, exactly as before.
 * @returns {boolean}
 */
export function isOnRoad(trackId, x, z, y, sHint) {
  if (typeof trackId === 'number') {
    z = x;
    x = trackId;
    trackId = undefined;
  }
  const key = resolveKey(trackId);
  const near = nearest(key, x, z, y, sHint);
  return _onRoadFromNear(key, near);
}

/**
 * On-road decision given an ALREADY-computed nearest() projection. Factored out of
 * isOnRoad so callers that already hold a `near` (e.g. sampleSurface) can reuse it
 * instead of re-running the O(SAMPLES) nearest() scan. Math is identical to the
 * old inline body — determinism + client/server parity preserved.
 */
function _onRoadFromNear(key, near) {
  const halfW = TRACKS[key].roadWidth / 2;

  // REAL FALL-IN GAP: if the nearest centerline point falls inside a carved gap's
  // spline-param range, the road is GONE here — the kart is over the void and must
  // NOT be judged on-road (so it falls in if it missed the launch ramp). The
  // centerline spline itself stays defined (groundY/slope/s are still continuous),
  // only onRoad-ness drops out, exactly as the gap contract requires. A shortcut
  // band can still bridge it (checked below), so we only suppress the MAIN road here.
  const overGap = inGap(key, near.u);
  if (!overGap && near.dist <= halfW) return true;

  // Shortcut branch test: a shortcut runs roughly parallel, offset to one side,
  // between its `at` and `rejoinAt` spline params. We approximate its band as a
  // lane of half-width params.width/2 centered params at branchSide*halfW off the
  // centerline over that param range. Pure + cheap.
  for (const f of getFeatures(key)) {
    if (f.type !== 'shortcut') continue;
    const p = f.params || {};
    const wHalf = (p.width || 10) / 2;
    // The branch centerline is offset to branchSide; check lateral distance to it.
    const offMeters = (p.branchSide || 1) * halfW;
    // near.lateral is signed distance from centerline; branch sits at offMeters.
    if (Math.abs(near.lateral - offMeters) <= wHalf) {
      // Only count it within the shortcut's u-range (with wrap).
      const u = near.u;
      const a = f.at;
      const b = p.rejoinAt != null ? p.rejoinAt : (a + 0.1);
      const inRange = a <= b
        ? (u >= a && u <= b)
        : (u >= a || u <= b); // wrapped range
      if (inRange) return true;
    }
  }
  return false;
}

/**
 * Full surface sample at a world XZ position. This is the workhorse the sim uses
 * to know what the kart is driving on and how the ground rises/falls.
 *
 * @param {string} [trackId]
 * @param {number} x
 * @param {number} z
 * @param {number} [y]  OPTIONAL kart height. When a finite number, the centerline
 *   sample is chosen HEIGHT-AWARE so at an overpass the section at the kart's OWN
 *   height wins (it no longer floats up onto the track crossing above). When
 *   undefined/NaN the selection is the EXACT pure-XZ nearest (backward compatible).
 *   An AIRBORNE kart simply prefers whichever section it is closest to in 3D, which
 *   is the desired behaviour. Deterministic — identical on client + server.
 * @returns {{onRoad:boolean, surface:string, groundY:number, slope:number, s:number, lateral:number}}
 *   onRoad  : within roadWidth/2 of the centerline (or a shortcut band).
 *   surface : 'boost' | 'ramp' | 'road' | 'offroad'.
 *   groundY : interpolated centerline height at the nearest point — karts ride
 *             this identically on client + server (this is how hills work).
 *   slope   : d(y)/d(arclength) along the driving tangent (signed; + = uphill).
 *   s       : spline param 0..1 of the nearest point.
 *   lateral : UNSIGNED perpendicular distance (m) from the nearest centerline
 *             point to (x,z). This is the magnitude of how far OFF to the side the
 *             kart is — the RaceManager respawn logic reads it to tell "just off
 *             the edge" (lateral ~ halfWidth) from "sailing out in the void"
 *             (lateral >> halfWidth), since groundY alone can't distinguish them.
 */
export function sampleSurface(trackId, x, z, y, sHint) {
  const key = resolveKey(trackId);
  const t = TRACKS[key];
  const halfW = t.roadWidth / 2;

  const near = nearest(key, x, z, y, sHint);
  const c = getCache(key);
  const samples = c.samples;
  const nS = samples.length;
  const i = near.i;

  // SMOOTH slope via a central difference around the projected point. A single
  // forward segment gives a piecewise-constant slope (a kink at every sample
  // boundary -> speed "kicks"); sampling W samples ahead and behind and dividing
  // the height change by the arc-length between them makes the slope continuous.
  const W = 4;
  const iAhead = (i + W) % nS;
  const iBehind = (i - W + nS) % nS;
  const fwd = samples[iAhead];
  const back = samples[iBehind];
  // Arc-length from `back` forward to `fwd` (wrap-aware: s is monotonic except at
  // the loop seam, so add the lap length when the forward sample wrapped past 0).
  let ds = fwd.s - back.s;
  if (ds <= 0) ds += c.total;
  if (ds <= 1e-6) ds = 1e-6;
  const slope = (fwd.y - back.y) / ds;

  // Reuse the `near` projection from above (same y+sHint-aware centerline pick)
  // instead of calling isOnRoad(), which would re-run the O(SAMPLES) nearest()
  // scan with identical args. Result is byte-identical; the redundant 1200-sample
  // second scan is eliminated.
  const onRoad = _onRoadFromNear(key, near);

  // Surface classification: boost/ramp footprints win over plain road.
  let surface = onRoad ? 'road' : 'offroad';
  let rampAlong = 0, rampLen = 0, rampRise = 0; // matched RAMP wedge ride-up (set on a ramp hit; boost leaves rise=0)
  if (onRoad) {
    for (const f of getFeatures(key)) {
      if (f.type !== 'boost' && f.type !== 'ramp') continue;
      const dx = x - f.x;
      const dz = z - f.z;
      // Footprint: an ORIENTED RECTANGLE matching the wedge/pad mesh — half-length
      // len*0.5 along the feature tangent (f.tx,f.tz), half-width roadWidth*0.5
      // across. Project (dx,dz) onto the tangent (along) and its perpendicular
      // (across); a circle was too wide laterally. Pure + deterministic.
      const len = (f.params && f.params.length) || 14;
      const along = dx * f.tx + dz * f.tz;
      const across = dx * f.tz - dz * f.tx; // perpendicular (tz,-tx)
      if (Math.abs(along) <= len * 0.5 && Math.abs(across) <= halfW) {
        surface = f.type === 'boost' ? 'boost' : 'ramp';
        if (f.type === 'ramp') { rampAlong = along; rampLen = len; rampRise = (f.params && f.params.rise) || 0; }
        break;
      }
    }
  }

  // BANK-FLUSH groundY: the renderer tilts the road into each turn, so a kart that
  // sits off-center on a banked section rides ABOVE/BELOW the smooth centerline
  // height. We add the SAME tilt the renderer uses so the kart hugs the visible
  // road. Sign: the renderer's cross-section is height(L) = -sin(bank) * L for a
  // SIGNED lateral L (+ = left of driving dir, near.lateralSigned), so we subtract.
  const bank = bankAngleAt(key, near.uProj);
  // RAMP RIDE-UP: a ramp footprint is a raised WEDGE (Track.js _buildRamp), not a
  // flat pad — so the kart must climb its height, not phase through it. The wedge
  // rises to `rise` over the first 75% of its length then flat-kicks to the lip;
  // this rampLift reproduces that exact mesh profile so client + server ride the
  // SAME wedge. alongFrac: 0 = entry, 1 = exit. Boost pads stay flat (rampRise=0).
  const alongFrac = rampRise > 0 ? (rampAlong + rampLen / 2) / rampLen : 0;
  const rampLift = rampRise > 0 ? rampRise * Math.min(1, Math.max(0, alongFrac) / 0.75) : 0;
  const groundY = (near.cyInterp + rampLift) - Math.sin(bank) * near.lateralSigned;

  // `near.dist` is the unsigned XZ distance from (x,z) to the nearest centerline
  // sample — i.e. how far off to the side the kart is. We surface it as `lateral`
  // so the RaceManager can respawn FAST when a kart is clearly out in the void
  // (lateral >> halfWidth) versus merely brushing the edge (lateral ~ halfWidth).
  //
  // `inGap` is the gap decision computed on the SAME vertex param (near.u) that
  // isOnRoad uses above — so a consumer (RaceManager) that needs "is this point
  // over a carved chasm?" reads it directly instead of re-deriving from `s`
  // (which is the interpolated uProj and can differ by up to one sample at the
  // rim). This keeps the client and server gap classification byte-identical.
  // `lateralSigned` (+ = LEFT of the driving direction) is ADDITIVE — every existing
  // consumer reads the unsigned `lateral` above; only the anti-grav entry transition
  // reads this to seed the kart's across-tube offset at the exact spot it entered.
  return {
    onRoad, surface, groundY, slope, s: near.uProj, lateral: near.dist,
    inGap: inGap(key, near.u), lateralSigned: near.lateralSigned,
  };
}

/**
 * The half-width (m) of a track's drivable band: roadWidth / 2. This is the
 * lateral distance from the centerline to either road edge, and the unit the
 * respawn + AI-containment logic measures `lateral` against. PURE (no three).
 * @param {string} [trackId]
 * @returns {number} half the road width in meters.
 */
export function getHalfWidth(trackId) {
  const t = TRACKS[resolveKey(trackId)];
  return t.roadWidth / 2;
}

/**
 * The full lap length (m) of a track's centerline — the cached XZ arc-length of
 * the sampled polyline. The anti-grav model uses it to convert metres-down-track
 * into a step in spline param (s += alongMetres / lapLength). PURE + cached.
 * @param {string} [trackId]
 * @returns {number} lap length in metres.
 */
export function getLapLength(trackId) {
  return getCache(resolveKey(trackId)).total;
}

/**
 * Drive the kart's anti-grav ENTRY/EXIT transitions for one tick. PURE (no three,
 * no random). EVERY caller (RaceManager.update, Room._stepOnce, Multiplayer
 * Predictor._stepWithTerrain) invokes this IDENTICALLY right after sampleSurface
 * (and after setting state.lastS), BEFORE the ramp/boost edges + stepKart — so the
 * one shared in-section physics branch in stepKart runs in lock-step on both sides.
 *
 * ENTRY (out -> in): when the kart is grounded + on-road inside an anti-grav section,
 * latch agSection and seed the surface-relative coords (agS = progress, agLateral =
 * the signed-left offset it entered at, agHeading = its heading relative to the
 * down-track tangent). Because corkscrewAt == 0 at the section START, the derived
 * frame == today's banked road point, so there is no teleport/orientation pop.
 *
 * EXIT (in -> out): once the AUTHORITATIVE progress agS leaves the section, hand the
 * world-yaw heading back (derived from the surface forward) and clear agSection. Again
 * corkscrewAt == 0 at the section END, so the recovered pose is continuous.
 *
 * Stores agTrackId on the state so stepKart's in-section branch can re-derive the
 * frame without changing stepKart's signature (the one caller-injected coupling;
 * kartModel never imports a renderer, stays pure + deterministic).
 *
 * @param {object} state    kart state (mutated): reads/writes agSection/agS/agLateral/agHeading.
 * @param {string} trackId
 * @param {{onRoad:boolean, s:number, lateralSigned:number}} surf  this tick's sampleSurface result.
 */
export function updateAntigravTransition(state, trackId, surf) {
  // Remember the track so stepKart's pure in-section branch can call surfaceFrameAt
  // (and getLapLength) without threading the id through every caller's stepKart call.
  state.agTrackId = trackId;
  if (state.agSection == null) state.agSection = -1; // legacy state safety

  if (state.agSection < 0) {
    // OUT -> maybe ENTER. Require grounded + on-road so a kart mid-jump off the
    // 0.70 ramp defers entry until it has landed back on the road.
    if (state.airborne || !surf || !surf.onRoad) return;
    const ag = antigravAt(trackId, surf.s);
    if (!ag) return;
    state.agSection = ag.index;
    state.agS = surf.s;
    state.agLateral = surf.lateralSigned || 0;
    // world yaw -> surface-plane travel yaw: project the world-forward (XZ) onto the
    // surface frame's (tangent,right) XZ basis. This is the EXACT inverse of the exit
    // derive below (and of stepKart's per-tick heading derive), so entry/exit and the
    // first in-section step never pop the orientation/trajectory.
    const fr = surfaceFrameAt(trackId, state.agS, state.agLateral);
    const wfx = Math.sin(state.heading), wfz = Math.cos(state.heading);
    const alongDot = wfx * fr.tangent.x + wfz * fr.tangent.z;
    const acrossDot = wfx * fr.right.x + wfz * fr.right.z;
    state.agHeading = Math.atan2(acrossDot, alongDot);
  } else {
    // IN -> maybe EXIT. Test the AUTHORITATIVE progress (agS), not the sampled XZ
    // param, so the decision is byte-identical between prediction + authority.
    if (!antigravAt(trackId, state.agS)) {
      const fr = surfaceFrameAt(trackId, state.agS, state.agLateral);
      const ch = Math.cos(state.agHeading), sh = Math.sin(state.agHeading);
      const fwx = fr.tangent.x * ch + fr.right.x * sh;
      const fwz = fr.tangent.z * ch + fr.right.z * sh;
      state.heading = Math.atan2(fwx, fwz);
      state.agSection = -1;
    }
  }
}

/**
 * Centerline position + unit XZ tangent at a spline param `s` (0..1). Used by the
 * renderer (to lay the road ribbon) and the AI racing line.
 * @param {string} [trackId]
 * @param {number} s  spline param 0..1 (wrapped).
 * @returns {{x:number, y:number, z:number, tx:number, tz:number}}
 */
export function sampleCenter(trackId, s) {
  const key = resolveKey(trackId);
  const t = TRACKS[key];
  const p = evalClosedSpline(t.path, s);
  const ahead = evalClosedSpline(t.path, s + 1e-4);
  let tx = ahead.x - p.x;
  let tz = ahead.z - p.z;
  const tl = Math.hypot(tx, tz) || 1e-6;
  tx /= tl; tz /= tl;
  return { x: p.x, y: p.y, z: p.z, tx, tz };
}

/**
 * Respawn pose on the road centerline at a given checkpoint, facing the driving
 * direction. Used when a kart falls off / needs resetting to a known-good spot.
 * @param {string} [trackId]
 * @param {number} checkpointIndex  index into buildCheckpoints (wrapped).
 * @returns {{x:number, y:number, z:number, heading:number}}
 */
export function respawnPoint(trackId, checkpointIndex) {
  const key = resolveKey(trackId);
  const gates = buildCheckpoints(key);
  const n = gates.length;
  const startU = TRACKS[key].startU || 0;
  let idx = ((Math.floor(checkpointIndex || 0) % n) + n) % n;
  // GAP-SAFE: checkpoints are spaced evenly in spline param, so a gate can land
  // INSIDE a carved fall-in gap. Respawning onto a gate over the void would drop
  // the kart straight back into the chasm -> an infinite respawn loop (and a
  // permanent AI strand, since the fall-off respawn fires for AI too). If the
  // chosen gate's spline param lies in a gap, step BACKWARD to the nearest earlier
  // gate on solid road (just before the gap's launch ramp). Bounded by n so a
  // degenerate all-gap track can never loop forever.
  for (let guard = 0; guard < n; guard++) {
    const u = (((startU + idx / n) % 1) + 1) % 1;
    if (!inGap(key, u)) break;
    idx = (idx - 1 + n) % n;
  }
  const here = gates[idx];
  const next = gates[(idx + 1) % n];
  const heading = Math.atan2(next.x - here.x, next.z - here.z);
  return { x: here.x, y: here.y, z: here.z, heading };
}

/**
 * Resolve a track's features to absolute world positions for render + RaceManager
 * so neither side re-derives spline math. Returns COPIES so callers can't mutate
 * the cache.
 * @param {string} [trackId]
 * @returns {Array<{type:string, x:number, y:number, z:number, tx:number, tz:number, params:Object}>}
 */
export function listFeatures(trackId) {
  const key = resolveKey(trackId);
  return getFeatures(key).map((f) => ({
    type: f.type,
    x: f.x, y: f.y, z: f.z,
    tx: f.tx, tz: f.tz,
    params: { ...f.params },
  }));
}

/**
 * SAFETY NET: if a kart has fallen far below the floating course (its y dropped
 * well under the track elevation), teleport it back onto the road at its last
 * passed checkpoint with speed 0 so it never disappears into the void.
 *
 * Unchanged semantics from the previous version: operates on a plain kart state +
 * a checkpoints array (from buildCheckpoints) + the track elevation. Mutates
 * `state` in place; returns true if a respawn happened.
 *
 * @param {object} state        kart state ({x,y,z,heading,speed,...}); mutated.
 * @param {Array<{x:number,y:number,z:number,index:number}>} checkpoints
 * @param {number} elevation    the track's baseline floating height (m).
 * @param {number} [nextCp=0]    index of the gate the kart is heading toward.
 * @param {number} [margin=30]   how far below `elevation` counts as "fallen".
 * @returns {boolean} true if the kart was respawned this call.
 */
export function respawnIfFallen(state, checkpoints, elevation, nextCp = 0, margin = 30) {
  if (!state || !checkpoints || checkpoints.length === 0) return false;
  if (state.y >= elevation - margin) return false;

  const n = checkpoints.length;
  const passedIdx = ((Math.floor(nextCp) - 1) % n + n) % n;
  const here = checkpoints[passedIdx];
  const toward = checkpoints[(passedIdx + 1) % n];

  state.x = here.x;
  state.y = (here.y != null ? here.y : elevation);
  state.z = here.z;
  const dx = toward.x - here.x;
  const dz = toward.z - here.z;
  state.heading = Math.atan2(dx, dz);
  state.speed = 0;
  return true;
}

/**
 * Build a staggered starting grid of `fieldSize` poses, lined up BEHIND the
 * start/finish line and ON the road. Karts are placed in two columns (inner /
 * outer lane) receding opposite the driving direction so they don't overlap, and
 * each pose sits at the centerline height there (so the grid rides the terrain).
 *
 * BACKWARD-COMPAT: original signature was buildStartGrid(fieldSize). If the first
 * arg is a number, treat it as fieldSize and use the default track.
 *
 * @param {string|number} [trackId]  a track id, OR (legacy) the fieldSize.
 * @param {number} [fieldSize]  number of poses (>= 1).
 * @returns {Array<{x:number, y:number, z:number, heading:number}>}
 *   index 0 is the front-most (pole) slot at the start line.
 */
export function buildStartGrid(trackId, fieldSize) {
  if (typeof trackId === 'number') {
    fieldSize = trackId;
    trackId = undefined;
  }
  const key = resolveKey(trackId);
  const t = TRACKS[key];
  const n = Math.max(1, Math.floor(fieldSize || 1));
  const startU = t.startU || 0;

  // Approx arc-length per unit of spline param near the start (for converting a
  // meters-of-spacing into a step in u). total / (#samples-per-loop step) ~ total.
  const c = getCache(key);
  const total = c.total;

  // Spread the field ACROSS the road in FOUR columns (not just two edge lanes),
  // so the grid fills the track width and the racers look distributed across the
  // track rather than lined up on the two edges with an empty middle. The columns
  // sit within the middle ~70% of the road so every start slot is well on-road.
  const spread = t.roadWidth * 0.35;
  const columns = [-spread, -spread / 3, spread / 3, spread];
  const rowSpacing = 6; // meters between successive rows (behind the line)

  const grid = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / columns.length);
    const lat = columns[i % columns.length];

    // Step back from the start line by row*rowSpacing meters => negative du.
    const du = (row * rowSpacing) / total;
    const u = startU - du;
    const center = sampleCenter(key, u);
    // Right-hand normal (tz,-tx) places the lateral lane offset.
    const nx = center.tz;
    const nz = -center.tx;
    const heading = Math.atan2(center.tx, center.tz);

    grid.push({
      x: center.x + nx * lat,
      y: center.y,
      z: center.z + nz * lat,
      heading,
    });
  }
  return grid;
}

// ---------------------------------------------------------------------------
// BACKWARD-COMPATIBLE EXPORTS
//
// Preserve the pre-existing module surface so old callers that import
// TRACK_DATA / startPosition / roadWidth keep working unchanged.
// ---------------------------------------------------------------------------

/**
 * Legacy single-track data object: the default 'circuit' track's raw data.
 * @type {TrackData}
 */
export const TRACK_DATA = TRACKS[DEFAULT_TRACK_ID];

/**
 * Legacy spawn pose for the default track (computed from the spline start).
 * @type {{x:number, y:number, z:number, heading:number}}
 */
export const startPosition = getStartPosition(DEFAULT_TRACK_ID);

/**
 * Legacy full road width (m) of the default track's drivable band.
 * @type {number}
 */
export const roadWidth = TRACKS[DEFAULT_TRACK_ID].roadWidth;
