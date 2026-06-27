// shared/constants.js
//
// Central tuning numbers for the deterministic arcade kart model.
// This file is SHARED between the browser client and the (future) server,
// so it MUST stay pure data — NO three import, NO DOM, NO randomness here.
//
// Units used throughout:
//   - distance:  meters (m)        (world units == meters)
//   - speed:     meters / second   (m/s)
//   - accel:     meters / second^2 (m/s^2)
//   - time:      seconds (s)
//   - angle:     radians (rad)
//   - turn rate: radians / second  (rad/s)
//
// For a rough feel reference: 32 m/s is about 115 km/h, which reads as a
// fast-but-controllable arcade kart, not a sim car.

export const PHYSICS = {
  // --- Simulation timing -------------------------------------------------
  TICK_RATE: 60, // physics ticks per second (Hz). The server will run at this rate.
  DT: 1 / 60, // fixed timestep in seconds. One physics step covers this much time.

  // --- Speed limits ------------------------------------------------------
  MAX_SPEED: 44, // m/s  top forward speed on normal road
  REVERSE_MAX: 10, // m/s  top reverse speed (stored as a magnitude; reverse uses negative speed)

  // --- Acceleration / deceleration --------------------------------------
  ENGINE_ACCEL: 34, // m/s^2  how hard the throttle pushes speed toward MAX_SPEED (snappier launch to the higher top speed)
  BRAKE_DECEL: 52, // m/s^2  how hard braking slows the kart (and then pushes into reverse) (braking authority kept proportional to the new speed)
  COAST_DECEL: 12, // m/s^2  natural slow-down when neither throttle nor brake is held (friction/drag)

  // --- Steering ----------------------------------------------------------
  TURN_RATE: 2.9, // rad/s  max yaw (heading change) per second at full steer AND full speed factor (slightly tighter so 44 m/s stays controllable).
  // The actual turn each step is also scaled by a speedFactor (0..1) so the
  // kart cannot pivot in place when stopped — see TURN_SPEED_REF below.
  TURN_SPEED_REF: 15, // m/s  speed at which steering reaches its full effect (full steer authority reached a bit higher, smoother at speed).
  // speedFactor = min(|speed| / TURN_SPEED_REF, 1). Below this speed the kart
  // turns more slowly; at or above it the kart turns at the full TURN_RATE.

  // --- Analog steer ramp (deterministic) ---------------------------------
  // A keyboard reports steer as an instant 0 -> +/-1, which darts the kart. stepKart
  // eases a private state.steerActual toward input.steer and uses THAT for all
  // continuous yaw, so the steer angle builds + releases smoothly instead of snapping.
  // Asymmetric: returning toward center is quicker than turning in, which keeps the
  // kart feeling crisp rather than floaty. A gamepad stick is already analog, so its
  // steerActual tracks within a frame or two (near-no-op). Framerate-independent
  // (1 - exp(-rate*dt)); the drift START still reads RAW input.steer so a flick locks instantly.
  STEER_TURN_RATE: 9, // 1/s  ease rate toward a LARGER steer magnitude (turn-in)
  STEER_CENTER_RATE: 16, // 1/s  ease rate back toward center (return) — snappier than turn-in

  // --- Drift slip angle (velHeading) -------------------------------------
  // state.velHeading is the direction the kart actually TRAVELS; state.heading is
  // where it FACES. velHeading eases toward heading every tick at one of three rates,
  // giving a real slip angle (tail-out drift) instead of pivoting exactly on the nose:
  //   - grounded & not drifting -> VEL_REALIGN_RATE (fast): travel ~= facing, so the
  //     straight-line + normal-turn feel stays close to the pre-slip model.
  //   - drifting                -> DRIFT_SLIP_RATE (slow): facing LEADS travel -> the
  //     tail steps out and the kart slides wide instead of turning on rails.
  //   - released mini-turbo     -> DRIFT_RELEASE_REALIGN_RATE (snap): the slip collapses
  //     fast so the boost launch fires along the facing (dead straight), not the slide.
  // The slip is hard-clamped to DRIFT_SLIP_MAX so a slide can never become a spin.
  VEL_REALIGN_RATE: 20, // 1/s  grounded & not drifting: travel snaps toward facing
  DRIFT_SLIP_RATE: 5, // 1/s  while drifting: travel lags facing (the tail-out slide)
  DRIFT_RELEASE_REALIGN_RATE: 28, // 1/s  during the released boost: snap travel straight
  DRIFT_SLIP_MAX: 0.5, // rad  hard clamp on |heading - velHeading| (~28.6 deg) — slide, never spin

  // --- Surfaces ----------------------------------------------------------
  OFFROAD_SPEED_MULT: 0.55, // multiplier applied to MAX_SPEED while state.surface === 'offroad'
  // (e.g. grass/dirt). Caps the kart's top speed off the track without
  // instantly killing momentum.
  OFFROAD_ACCEL_MULT: 0.6, // multiplier applied to ENGINE_ACCEL while offroad. Heavy but
  // not a hard stop: leaving the road is punishing yet recoverable.

  // --- Hills / terrain following (TERRAIN) -------------------------------
  // The track is now hilly: the CALLER samples the track surface and sets
  // state.groundY (centerline elevation under the kart) and state.slope
  // (signed d(y)/d(arclength) along the driving tangent; + = uphill) BEFORE
  // calling stepKart. stepKart consumes them — identical client + server.
  GROUND_FOLLOW_RATE: 30, // 1/s  rate the kart eases its y toward groundY while grounded.
  // Higher = snappier terrain follow, lower = floatier. An exponential lerp
  // (1 - exp(-rate*dt)) keeps it framerate-independent and never overshoots.
  // Bumped 12->30 for the Round-13 coaster terrain: the ~2x-steeper grades made the
  // old soft follow lag the road by up to ~1.8m (kart visibly floating above / sunk
  // into the surface on steep climbs/drops). 30 hugs the road while still smoothing
  // small bumps; the GROUND_MAX_LAG clamp below is now just a far-safety backstop.
  GROUND_MAX_LAG: 3.5, // m  far-safety backstop on |y - groundY| while grounded. Now that
  // groundY is SMOOTH (no more staircase sampling) the rate-30 ease stays glued to the
  // road on its own, so this cap is intentionally generous and should NEVER engage during
  // normal driving. It is only an anomaly backstop (e.g. a sudden groundY discontinuity),
  // NOT a per-frame clamp — the old 0.9 value toggled every frame on steep ground and
  // caused a visible per-frame snap (shake), which raising it to 3.5 removes.
  RAMP_FOLLOW_RATE: 120, // 1/s  near-snap onto the hard wedge surface — RAMPS ONLY (surface==='ramp').
  // A steep up-and-over wedge climbs groundY ~18 m/s; the soft GROUND_FOLLOW_RATE (30) lagged
  // ~0.6m BELOW it so the nose phased into the ramp top. 120 hugs the wedge while the soft ease
  // still smooths hills everywhere else. Paired with a one-sided "never below the wedge" clamp.

  // SLOPE: an arcade-feel ROLLERCOASTER speed effect. Going uphill bleeds
  // speed, downhill adds speed. Applied as an acceleration (m/s^2) equal to
  // SLOPE_ACCEL * slope, then clamped so even a near-vertical drop can't fling
  // the engine to infinity. slope is dimensionless rise/run (~ -1..1 for sane
  // tracks). AMPLIFIED (R12): the new terrain has tall hills + steep drops, so
  // these were raised (9->16 accel, 6->14 clamp) to make a downhill plunge
  // genuinely PULL the kart well past its rolling cruise and a steep climb
  // visibly BLEED it — the slope effect is allowed to add over the base cruise
  // (a downhill rush momentarily overspeeds, like coasting a real hill) while
  // the maxForward clamp below still bounds the steady top speed.
  SLOPE_ACCEL: 16.0, // m/s^2  speed change per unit slope (downhill +, uphill -)
  SLOPE_ACCEL_CLAMP: 14.0, // m/s^2  hard cap on the magnitude of the slope effect
  // How far a downhill rush is allowed to push speed ABOVE the rolling cap, in
  // m/s. Only the DOWNHILL (speed-adding) side of the slope effect gets this
  // headroom — uphill bleed always clamps to the normal band. This is what lets
  // a steep drop feel like a rollercoaster (a brief overspeed that washes off as
  // the ground levels) without raising the steady ~44 cruise. 0 => no overspeed.
  SLOPE_OVERSPEED: 8.0, // m/s  downhill headroom above the rolling cap (trimmed 10->8: the tall coasters hit ~54 m/s on big drops, a touch chaotic; ~52 keeps the rush, less twitchy)

  // --- Jumps / airborne (ramps) -----------------------------------------
  GRAVITY: 26, // m/s^2  downward accel applied to vy while airborne. Tuned for a
  // short, snappy arcade hop rather than a realistic fall.
  AIR_STEER_MULT: 0.5, // multiplier on yaw rate while airborne once fully committed to the arc
  // (bumped 0.35->0.5 so you can still aim a landing). It now BLENDS in over the
  // first AIR_STEER_BLEND_TIME of the jump (see stepKart) instead of snapping on.
  AIR_STEER_BLEND_TIME: 0.1, // s  ramp window from near-full grounded grip to AIR_STEER_MULT after launch.
  RAMP_LAUNCH_MIN_SPEED: 12, // m/s  the CALLER should only launch a kart crossing a ramp at
  // or above this speed (informational default for the caller; not enforced here).
  RAMP_LAUNCH_VY: 9, // m/s  default upward velocity a ramp imparts (caller passes this to launchKart).
  // COYOTE-TIME landing grace: on a DESCENDING frame, land if the kart is within this
  // small margin ABOVE the ground under it (not only once it has dipped below), so a
  // frame-perfect gap landing stops "just missing" the far edge and sinking. MUST stay
  // well under the gap depth — RaceManager parks groundY at -1000 over a real gap, so a
  // sub-meter epsilon can never catch a kart hovering over a void.
  LAND_COYOTE_EPSILON: 0.5, // m

  // --- Glider (R12) ------------------------------------------------------
  // A glide is a special air phase: the kart is launched off a `glide` ramp
  // (Stream T flags it), Stream R fires launchKart(...) and sets state.gliding,
  // and WHILE state.gliding is true the vertical/steer math below uses these
  // floaty values instead of the snappy jump ones. The point is a long, slow,
  // steerable descent where the player aims for a landing.
  GLIDE_GRAVITY: 7, // m/s^2  much weaker downward accel while gliding (slow, floaty fall).
  GLIDE_STEER_MULT: 0.9, // multiplier on yaw rate while gliding — STRONG air-steer (vs the
  // 0.35 normal-jump AIR_STEER_MULT) so the player can clearly steer to a landing.
  GLIDE_DRAG: 1.5, // m/s^2  tiny forward-speed bleed while gliding so the kart keeps almost
  // all its momentum through the glide (low drag) rather than decelerating like a brake.
  GLIDE_LAND_SUSPENSION: 0.7, // 0..1  suspension compression applied on a glide touchdown.

  // --- Suspension / lean feel (R12, VISUAL ONLY) -------------------------
  // These shape state.lean (body roll into turns + pitch under accel/brake) and
  // state.suspension (0..1 compression that spikes on landing then springs back).
  // The model SETS these every step; the renderer (Kart.js) READS them to tilt +
  // squash the mesh. They do NOT feed back into handling — pure cosmetics.
  LEAN_ROLL_MAX: 0.20, // rad  max body roll into a turn (~11.5 deg) at full steer + speed.
  LEAN_PITCH_MAX: 0.10, // rad  max pitch under hard accel (nose up) / brake (nose down) (~5.7 deg).
  LEAN_RATE: 8, // 1/s  how fast state.lean eases toward its target (framerate-independent lerp).
  SUSPENSION_LAND_HOP: 0.45, // 0..1  suspension compression added on a normal (non-glide) landing.
  SUSPENSION_SPRING_RATE: 9, // 1/s  how fast state.suspension decays back to 0 (spring-back).

  // --- Ground / collision (used by src/physics/KartPhysics.js) ----------
  GROUND_DEFAULT_Y: 0, // m  ground height assumed when a downward raycast hits nothing (flat M1 ground)
  RAY_START_HEIGHT: 2, // m  how far above the kart we begin the downward ground ray
  RAY_GROUND_LENGTH: 10, // m  how far down the ground ray reaches before giving up
  WALL_PROBE_DIST: 1.0, // m  forward distance at which a wall counts as "about to hit"
  WALL_SPEED_KEEP: 0.3, // fraction of speed retained after bumping a wall (0.3 == lose 70%)
  WALL_PUSHBACK: 0.5, // m  how far to nudge the kart back along its own forward axis on a wall hit

};

// --- M2: DRIFT / MINI-TURBO ---------------------------------------------
// The hop-drift + 3-tier mini-turbo system. Hold the drift key (Space) while
// steering at speed to slide; the longer you hold, the higher the boost tier
// you bank, released as a speed surge when you let go. Pure data — read by
// stepKart in shared/kartModel.js (so the server can reuse it). NO randomness.
export const DRIFT = {
  // Minimum forward speed (m/s) required to BEGIN a drift. Below this, pressing
  // the drift key does nothing (you can't slide a near-stopped kart).
  MIN_DRIFT_SPEED: 8, // m/s  (lowered 10->8 so you can commit a slide a touch earlier out of a slow corner)

  // Length of the initial "hop" when a drift starts. During this brief window
  // state.hopTimer > 0; the kart pops up slightly (the renderer reads hopTimer)
  // before the slide locks in. Purely a feel/visual lead-in. Snappier (0.12->0.10)
  // so the slide bites almost immediately — the corners on the new tracks demand a
  // quick commit, and a long hop made the drift feel laggy to start.
  HOP_TIME: 0.10, // s

  // While drifting the kart turns toward the locked drift direction at TURN_RATE
  // scaled by this multiplier. >1 makes the drift arc TIGHTER than normal
  // steering (a committed slide bites harder than a gentle turn). Bumped 1.35->1.45
  // so a committed slide genuinely BITES through the new tight hairpins (~18-22m)
  // instead of understeering wide: at full speedFactor the drift yaw is now
  // TURN_RATE*1.45 = ~4.2 rad/s, tight enough to hold (and tighten into) every bend.
  DRIFT_TURN_MULT: 1.45, // multiplier on PHYSICS.TURN_RATE while drifting

  // How much the live steer input can widen/tighten the locked drift arc.
  // Counter-steering (steer opposite the drift) opens the radius; steering INTO
  // the drift tightens it. Applied as: turn *= 1 + steerToward*COUNTER_STEER_INFLUENCE.
  // Bounded so the kart can never reverse its drift direction mid-slide. Nudged
  // 0.4->0.45 so the slide feels adjustable mid-corner (tighten the apex, then open
  // the exit), which is what makes chaining drifts corner-to-corner feel natural.
  COUNTER_STEER_INFLUENCE: 0.45, // unitless (fraction of turn rate swung by steer)

  // While drifting, holding BRAKE tightens the slide arc by this fraction of the drift
  // yaw — a small extra bite for threading a tight hairpin. Added to the arc factor
  // alongside COUNTER_STEER_INFLUENCE. 0 => brake has no effect on the drift arc.
  BRAKE_DRIFT_TIGHTEN: 0.2, // unitless

  // Seconds of CONTINUOUS drifting needed to reach each mini-turbo tier.
  // driftCharge (accumulated drift time) is compared against these to set
  // state.miniTurboTier: 1=blue, 2=orange, 3=purple. BLUE pulled in 0.6->0.45 so
  // even a short corner slide banks a boost — this is the heart of the drift loop:
  // the reward comes quickly and reliably, so drifting every bend always pays off.
  // Orange/purple pulled in proportionally (1.4->1.2, 2.4->2.1) so committing to a
  // longer slide through a hairpin still reaches the higher tiers within the corner.
  MINI_TURBO_THRESHOLDS: {
    blue: 0.45, // s  -> tier 1
    orange: 1.2, // s  -> tier 2
    purple: 2.1, // s  -> tier 3
  },

  // How long (seconds) the boost lasts when released, keyed by tier reached.
  // Higher tiers surge for longer. Indexed by tier number (1/2/3). Blue bumped
  // 0.6->0.7 so the quick-banked blue surge actually carries you OUT of the corner
  // and toward the next one (it lands right on the exit boost pad), which is what
  // makes the drift->boost->drift chain flow. Orange/purple unchanged.
  BOOST_DURATION: {
    1: 0.7, // s  blue
    2: 1.0, // s  orange
    3: 1.5, // s  purple
  },

  // Speed/accel multiplier applied to the kart's top speed AND engine accel
  // while state.boostTimer > 0. 1.7 == a 70% surge over the normal cap, so a
  // mushroom / mini-turbo reads as a real launch rather than a gentle nudge.
  BOOST_MULT: 1.7, // unitless top-speed / accel multiplier during a boost

  // One-time INSTANT speed impulse (m/s) added the frame a mini-turbo FIRES, keyed by
  // tier (1 blue / 2 orange / 3 purple). This is the "kick" of the launch — without it
  // a released boost only raises the cap and the kart creeps up to it over several
  // frames; the kick makes the surge felt on frame 1. ENGINE_ACCEL*BOOST_MULT then
  // sustains it, and stepKart's speed clamp bounds the kick to the boosted forward cap.
  BOOST_KICK: {
    1: 2.0, // m/s  blue
    2: 3.5, // m/s  orange
    3: 5.0, // m/s  purple
  },
};

// --- M3: ITEMS / STATUS EFFECTS -----------------------------------------
// Tuning for the item-driven status effects layered on top of the kart model.
// Items themselves (pickups, projectiles) live elsewhere; this block only holds
// the deterministic numbers stepKart reads while honoring spin/star/shrink/coins.
// Pure data — read by shared/kartModel.js (so the server can reuse it). NO randomness.
export const EFFECTS = {
  // How long (seconds) a kart spins out after being hit (shell/banana). While
  // state.spinTimer > 0 the kart ignores throttle/steer and bleeds speed. SOFTENED
  // 1.8->1.5 (paired with the gentler SPIN_SLOWDOWN below): a hit still costs ~3
  // places, but the victim keeps enough momentum to recover within the SAME lap
  // instead of being parked — less rage-quit for an 8-14yo arcade racer. Still a
  // real momentum-killer, just not a race-ender.
  SPIN_DURATION: 1.5, // s

  // How long (seconds) the star power-up lasts. While state.starTimer > 0 the
  // kart is invincible (cannot be spun) and gets a small top-speed bump.
  STAR_DURATION: 7.0, // s

  // How long (seconds) the shrunk/lightning state lasts. While
  // state.shrinkTimer > 0 the kart's top speed is reduced (it's tiny and slow).
  SHRINK_DURATION: 6.0, // s

  // Flat top-speed bonus (m/s) added PER coin held, up to COIN_MAX coins.
  // 10 coins * 0.6 = +6 m/s at a full purse — a slightly punchier coin reward so
  // a full purse is a noticeable edge, not just a rounding error.
  COIN_SPEED_BONUS: 0.6, // m/s per coin
  COIN_MAX: 10, // coins  hard cap on state.coins (each above this is ignored)

  // Top-speed multiplier applied while a star is active (state.starTimer > 0).
  // 1.3 == a 30% surge on top of the normal cap — a star is now a genuine
  // overtake button (invincible AND clearly faster), not a mild nudge.
  STAR_SPEED_MULT: 1.3, // unitless top-speed multiplier during a star

  // Top-speed multiplier applied while shrunk (state.shrinkTimer > 0).
  // 0.7 == capped at 70% of normal top speed while tiny.
  SHRINK_SPEED_MULT: 0.7, // unitless top-speed multiplier while shrunk

  // How hard a spin-out bleeds speed (m/s^2), applied while state.spinTimer > 0.
  // The kart can't accelerate during a spin, so this drags it down toward a crawl.
  // SOFTENED 30->25 to match the shorter SPIN_DURATION above: a hit still sheds the
  // bulk of the kart's momentum (a clear, punchy stop) but leaves a little more roll
  // to recover with — getting hit stings without parking the victim for the lap.
  SPIN_SLOWDOWN: 25, // m/s^2  deceleration while spinning out

  // Hard cap (seconds) on state.boostTimer from stacking mushrooms. Each mushroom
  // tops up the timer by the tier-3 boost duration (1.5s); this clamp stops rapid
  // golden/triple presses from snowballing into an absurdly long boost. 3.0s lets
  // a couple of charges stack for a meaningful chain without being unbounded.
  MUSHROOM_BOOST_MAX: 3.0, // s  ceiling on stacked mushroom boost time

  // --- CLIENT VFX TUNING (read by src/effects/ItemVFX.js only) -----------
  // These numbers shape the PURELY-VISUAL item effects. They live here so the
  // tuning is in one place with the gameplay values, but the server NEVER reads
  // them (it has no renderer); they are inert data on the headless side. Keeping
  // them in this pure-data block does NOT break the parity rule — no three, no DOM.
  VFX: {
    // How often (seconds) the boost exhaust trail re-emits a puff while
    // boostTimer > 0. Lower = denser flame trail (more particles). 0.03s ≈ a puff
    // every other frame at 60fps, which reads as a continuous jet without draining
    // the pool.
    BOOST_TRAIL_INTERVAL: 0.03, // s
    // How often (seconds) the star aura re-emits a shimmer sparkle while
    // starTimer > 0. Sparkles are the rainbow twinkle orbiting a starred kart.
    STAR_SPARKLE_INTERVAL: 0.04, // s
    // How long (seconds) the spin-stars ring orbits after a fresh hit. We emit one
    // burst of orbiting stars on the rising edge of spinTimer; they live this long.
    SPIN_STARS_LIFE: 1.2, // s
    // How long (seconds) the pickup flash ring expands+fades when an item is
    // collected (a quick celebratory pop at the kart).
    PICKUP_FLASH_LIFE: 0.5, // s
  },
};

// --- M5: PER-KART STATS (CHARACTER / KART CUSTOMIZATION) -----------------
// The customization layer (src/data/characters.js + src/data/karts.js) builds a
// "stat profile" — six numbers, each normalized to 0.0..1.0 (0 = worst, 1 = best
// of that stat). stepKart turns each stat into a MULTIPLIER on the matching
// PHYSICS value by interpolating linearly between a MIN and MAX multiplier:
//
//     mult = MIN + stat * (MAX - MIN)
//
// So stat 0.0 => MIN multiplier, stat 1.0 => MAX multiplier, and the neutral
// stat 0.5 lands exactly halfway. The ranges below are chosen so that a NEUTRAL
// profile (all stats 0.5) yields a multiplier of EXACTLY 1.0 for every stat —
// that is what guarantees backward compatibility: a kart with no custom stats
// (default 0.5 across) behaves byte-for-byte like the pre-M5 model.
//
// To keep the 0.5 => 1.0 invariant, every range below is SYMMETRIC about 1.0
// (i.e. MAX - 1 == 1 - MIN). Pure data — read by shared/kartModel.js. NO randomness.
export const STAT_RANGES = {
  // topSpeed -> scales PHYSICS.MAX_SPEED (the forward top-speed cap).
  // 0.85x at the low end .. 1.15x at the high end (+/- 15%). A heavy speedster
  // tops out ~15% faster than a featherweight; the neutral 0.5 stays at 1.0x.
  TOP_SPEED_MULT_MIN: 0.85,
  TOP_SPEED_MULT_MAX: 1.15,

  // accel -> scales PHYSICS.ENGINE_ACCEL (how hard throttle pushes toward top).
  // Wider spread (+/- 25%) than top speed because acceleration is the stat
  // players feel most off the line; light karts launch noticeably quicker.
  ACCEL_MULT_MIN: 0.75,
  ACCEL_MULT_MAX: 1.25,

  // handling -> scales PHYSICS.TURN_RATE (max yaw per second while steering).
  // +/- 20%. Higher handling = tighter cornering; lower = a wide, floaty turn.
  HANDLING_MULT_MIN: 0.8,
  HANDLING_MULT_MAX: 1.2,

  // miniTurbo -> scales BOTH the drift charge rate AND the released boost
  // duration. +/- 20%. A high-miniTurbo kart banks tiers faster and keeps the
  // surge longer; applied as a multiplier on dt added to driftCharge and on the
  // armed boostTimer. (charge rate up => tiers reached sooner.)
  MINI_TURBO_MULT_MIN: 0.8,
  MINI_TURBO_MULT_MAX: 1.2,

  // traction -> scales the OFFROAD grip penalty (high traction = less harsh off
  // the road, but never better than full road grip — the result is capped at 1.0)
  // AND the brake bite. +/- 10%. Neutral 0.5 => 1.0 => identical to before.
  TRACTION_MULT_MIN: 0.9,
  TRACTION_MULT_MAX: 1.1,

  // weight -> scales suspension spring-back (heavier = stiffer, faster settle =
  // more planted) and, INVERTED, the drift turn rate (lighter = nimbler, snappier
  // slide rotation). +/- 10%, symmetric so neutral 0.5 => 1.0 => unchanged.
  WEIGHT_MULT_MIN: 0.9,
  WEIGHT_MULT_MAX: 1.1,
};

// --- AIR TRICKS (the signature hook) ------------------------------------
// Steer in mid-air off the game's ramps + gaps to "work" a trick: the longer you
// stay up and the harder you steer, the more STYLE you bank, cashed on a CLEAN
// landing as a mini-turbo-style boost AND as overdrive-meter charge. Pure data —
// read by shared/kartModel.js so the server stays byte-identical. NO randomness.
export const TRICK = {
  MIN_AIRTIME: 0.35, // s  only real ramp/gap air counts (ignores tiny terrain bumps)
  STYLE_PER_SEC: 1.0, // style/s banked just for staying airborne in a trick
  STYLE_INPUT_BONUS: 0.6, // extra style/s while actively steering (working the trick)
  SPIN_RATE: 10, // rad/s VISUAL barrel-roll speed, scaled by |steer| (never changes heading)
  STYLE_TO_BOOST: 0.5, // s of boost granted per unit of banked style on a clean land
  MAX_TRICK_BOOST: 1.4, // s  hard cap on the trick-landing boost surge
  UPRIGHT_RATE: 12, // 1/s  how fast the barrel roll (trickRot) eases back upright on the ground
};

// --- OVERDRIVE (the signature hook) -------------------------------------
// A meter (0..1) that fills from clean trick landings AND every mini-turbo fired.
// When full, the player presses the overdrive key to SPEND it for a short, strong
// top-speed surge with a slight handling "edge". Pure data — read by
// shared/kartModel.js so the server stays byte-identical. NO randomness.
export const OVERDRIVE = {
  CHARGE_PER_STYLE: 0.18, // meter += banked style * this on a clean trick landing
  CHARGE_PER_MINITURBO: 0.12, // meter += this each time a mini-turbo boost fires
  DURATION: 2.2, // s  how long an activated overdrive surge lasts
  SPEED_MULT: 1.6, // top-speed cap multiplier while active (a strong boost)
  GRIP_EDGE: 0.92, // yaw (handling) multiplier while active — the trade-off "edge"
};

// --- KART_COLORS ---------------------------------------------------------
// One distinct body color per field SLOT. Single source of truth shared by the
// client kart visual (src/modes/Multiplayer.js, by start-grid index) AND the
// server lobby payload (server/Room.js lobbyList, by seat index) so a player's
// lobby swatch matches the kart they actually drive. Pure data (no three/DOM).
export const KART_COLORS = [
  0xff3b30, // red
  0x34c759, // green
  0x007aff, // blue
  0xffcc00, // yellow
  0xff9500, // orange
  0xaf52de, // purple
  0xff2d55, // pink
  0x5ac8fa, // cyan
  0x8e8e93, // gray
  0xa2845e, // brown
  0x30d158, // mint
  0xbf5af2, // violet
  0xffd60a, // gold
];
