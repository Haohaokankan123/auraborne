// src/ai/AIRacer.js
//
// The AI "brain" for a single non-player kart. It does NOT move the kart itself
// — it only produces the SAME input shape the human Input.js produces, which the
// shared physics model then consumes. That keeps AI and player perfectly
// symmetric: ONE stepKart, fed by either a keyboard or this brain. Nothing
// outside this file ever touches an AI kart's position/heading — that was the
// cause of the old "glitch in place" bug, where post-physics position clamps
// fought the engine every frame. The kart drives PURELY from these inputs.
//
//   computeInput(state, context) -> { steer, throttle, brake, drift, useItem, lookBack }
//
// The controller is a clean PURE-PURSUIT driver:
//   1. Find the nearest point on the racing line + a look-ahead point.
//   2. Steer toward the look-ahead (offset a little for a per-AI lane).
//   3. Brake down to a speed the upcoming corner can actually be taken at — this
//      is what keeps the AI ON the road (slowing for a bend instead of
//      understeering wide off it), the natural way a real driver stays on track.
//   4. Drift through sharp corners for mini-turbos; fire items on a cooldown.
// Per-AI PERSONALITY (pace / cornerSkill / driftSkill / laneOffset) makes every
// kart distinct: different top speeds (the field strings out), different lanes
// (the field fans across the road), different corner commitment.
//
// CLIENT-SIDE (imports three) — works in world space with THREE.Vector3 and the
// RacingLine. It never imports the shared model; it just reads `state` and emits
// input.

import * as THREE from 'three';

// --- Per-cc tuning. -------------------------------------------------------
// cc is the "engine class" (50/100/150/200). Higher cc = faster target pace.
//   rubberGain  how hard this class flexes its top speed toward the PLAYER: an
//               AI behind the player speeds up by up to (rubberGain * behindAmount),
//               so the pack stays tight and a rival is always near. Higher cc = a
//               stronger band, EASED at the very top: 200cc now matches 150cc (0.22)
//               so the lead AI still chases dramatically but is no longer "always on
//               you". This is a STRAIGHT-ONLY catch-up bonus (faded to 0 into every
//               corner — see RUBBER_BONUS_FADE / computeInput step 5b), so easing it
//               does NOT change lap times or corner pace, only the straight-line chase.
const CC_TABLE = {
  50:  { paceFloor: 0.78, rubberGain: 0.10, corner: 0.85 },
  100: { paceFloor: 0.86, rubberGain: 0.16, corner: 0.92 },
  150: { paceFloor: 0.92, rubberGain: 0.22, corner: 0.97 },
  200: { paceFloor: 0.97, rubberGain: 0.22, corner: 1.00 }, // eased 0.30->0.22 (= 150cc): chases hard but not relentlessly
};

// --- RUBBER-BAND tuning (Mario-Kart pack drama). --------------------------
// The gap to the PLAYER (in meters, signed: + = player is ahead of this AI) is
// turned into a top-speed multiplier so the field never strings out:
//   behind the player  -> top speed * (1 + rubberGain * behindAmount)  (chase up)
//   ahead of the player -> top speed * (1 - EASE_OFF * aheadAmount)     (back off)
// behindAmount / aheadAmount ramp 0..1 over RUBBER_REF_DIST meters of gap, so the
// flex is proportional to how far apart we are and saturates once the gap is big.
// The final multiplier is clamped to [RUBBER_MIN, RUBBER_MAX] so even a huge gap
// can't make an AI absurdly fast or crawl. These are the ONLY rubber-band knobs;
// they scale the STRAIGHT-LINE target only (the corner brake is applied separately
// and is never raised — see computeInput step 5).
const RUBBER_REF_DIST = 70;   // m  gap at which the flex reaches full strength
const RUBBER_EASE_OFF = 0.16; // max fractional top-speed cut for a leading AI
const RUBBER_MIN = 0.80;      // never slower than 80% of base pace
const RUBBER_MAX = 1.25;      // never faster than 125% of base pace
// Corner sharpness (cornerForSpeed, 0=straight) at which the CHASE bonus fully
// fades to 0. Kept small so the bonus lives only on near-straight road; any real
// bend gets none, so the corner brake (computed from base pace) is never raised.
const RUBBER_BONUS_FADE = 0.18;

// --- Per-AI PERSONALITY PROFILE. ------------------------------------------
// Layered ON TOP of the cc tuning so two same-cc AIs still drive differently.
//   pace        top-speed scale (genuinely faster/slower → field strings out).
//   aggression  proactive item use (sets the item cooldown).
//   cornerSkill how much speed they carry through a bend.
//   driftSkill  how readily they drift for mini-turbos.
//   laneOffset  preferred lateral position (fraction of half-width → field fans
//               across the road).
// DEFAULT_PROFILE is the neutral "ace" used when no profile is passed.
const DEFAULT_PROFILE = {
  pace: 1.0,
  aggression: 0.7,
  cornerSkill: 1.0,
  driftSkill: 1.0,
  mistakeRate: 0.0,
  reactionLag: 0.0,
  laneOffset: 0.0,
};

// --- FIVE PERSONALITY ARCHETYPES. -----------------------------------------
// Every AI is one of five distinct "drivers", so a grid reads as a dozen humans
// instead of one robot copied twelve times. Each archetype is a full trait bundle
// (same shape as DEFAULT_PROFILE); buildAISlot() picks one per grid slot, adds a
// little SEEDED jitter (no Math.random) so two same-archetype karts still differ,
// then scales the skill traits by the chosen difficulty.
//   ace     fast, clean, aggressive with items — the front-runner threat.
//   brawler bumps, takes risks, fires items early, makes the odd mistake.
//   nervous cautious, brakes early, hesitates on items, bobbles often (back-marker).
//   drifter lives in the drift, chains mini-turbos, slightly risky lines.
//   clean   smooth + defensive — no mistakes, holds traps, plays it safe.
// Bumped across the board for a BRUTAL, FAST, SHARP field (Charles): higher aggression
// (more proactive, well-aimed item use), fewer bobbles (lower mistakeRate) and quicker
// reactions (lower reactionLag) so even the back-markers are crisp. pace/cornerSkill keep
// the archetype spread so the field still strings out instead of driving as one block.
export const PERSONALITIES = {
  ace:     { pace: 1.18, aggression: 0.95, cornerSkill: 0.99, driftSkill: 0.92, mistakeRate: 0.00, reactionLag: 0.02 },
  brawler: { pace: 1.10, aggression: 1.00, cornerSkill: 0.85, driftSkill: 0.65, mistakeRate: 0.06, reactionLag: 0.06 },
  nervous: { pace: 1.00, aggression: 0.45, cornerSkill: 0.70, driftSkill: 0.25, mistakeRate: 0.10, reactionLag: 0.15 },
  drifter: { pace: 1.12, aggression: 0.85, cornerSkill: 0.92, driftSkill: 1.00, mistakeRate: 0.03, reactionLag: 0.04 },
  clean:   { pace: 1.08, aggression: 0.70, cornerSkill: 0.96, driftSkill: 0.72, mistakeRate: 0.00, reactionLag: 0.03 },
};

// Which archetype each grid slot gets (0 = pole). Front of the grid is stacked
// with the fast/clean types, the tail with nervous back-markers — so the field
// has a couple of elite threats AND a couple of genuine stragglers (the "real
// spread within each difficulty" the brief asks for). Indexed by grid slot; wraps
// for larger fields. Pure by slot — no randomness.
const ARCHETYPE_ORDER = [
  'ace', 'ace', 'drifter', 'brawler', 'clean', 'drifter', 'brawler',
  'clean', 'drifter', 'nervous', 'clean', 'nervous', 'nervous',
];

// Per-difficulty SKILL scaling + the top-speed cap factor. `factor` multiplies the
// AI's already-player-capped target top speed: EASY/MEDIUM stay <= 1.0 (the AI
// cruises at or below the player's BASE cap, clearly beatable); HARD is a touch
// ABOVE 1.0 so the top cars keep pace with a player who is constantly drifting/
// boosting PAST their base cruise — that's what makes HARD a real threat without
// being uncatchable. cornerMult/aggrMult trim those traits at easier settings;
// mistakeMult/lagMult scale the MISTAKE channels (easy bobbles far more; hard a
// little LESS than its base, so the front-runners are genuinely sharp).
// HARD is now genuinely BRUTAL: faster top end (factor 1.12), near-zero bobbles and
// minimal reaction lag, full aggression — the front cars hound the player relentlessly.
// MEDIUM is sharpened to a real challenge; EASY stays clearly beatable (still cruises
// below the player's base and bobbles often) so the difficulty ladder still means
// something and beginners can win.
const DIFFICULTY = {
  easy:   { factor: 0.86, cornerMult: 0.84, aggrMult: 0.80, mistakeMult: 1.60, lagMult: 1.50 },
  medium: { factor: 0.97, cornerMult: 0.95, aggrMult: 1.00, mistakeMult: 1.00, lagMult: 1.00 },
  hard:   { factor: 1.12, cornerMult: 1.00, aggrMult: 1.15, mistakeMult: 0.45, lagMult: 0.55 },
};

// --- CC LADDER (the "engine class" the player picks). ----------------------
// The difficulty CONTRACT id stays 'easy'|'medium'|'hard' (that's what scales the
// AI tuning above + threads into RaceManager/Room). This surfaces it as the
// player-facing CC ladder so DifficultySelect renders one source of truth, and the
// unlock gate keys off `tier`: 100cc is open, each higher class unlocks by WINNING
// the class below (see playerStats.unlockedTier). Lowest -> highest.
export const CC_TIERS = [
  { id: 'easy',   cc: 100, label: '100cc', tier: 0 },
  { id: 'medium', cc: 150, label: '150cc', tier: 1 },
  { id: 'hard',   cc: 200, label: '200cc', tier: 2 },
];

// The designated RIVAL's fixed name — the slot-3 AI is the nemesis for the whole
// cup (its rubber band flexes harder, see step 5a), so it carries a stable name
// the HUD/results board can tag instead of a generic "CPU N".
export const RIVAL_NAME = 'VEX';

/**
 * The top-speed cap factor for a difficulty. RaceManager/Room thread this into the
 * AI context as context.difficultyFactor; AIRacer multiplies its player-capped
 * target top speed by it. Shared so the client (GP) and server (MP) agree.
 * @param {('easy'|'medium'|'hard')} difficulty
 * @returns {number}
 */
export function difficultyFactorFor(difficulty) {
  return (DIFFICULTY[difficulty] || DIFFICULTY.medium).factor;
}

/**
 * Build the cc + PERSONALITY profile for one AI grid slot. PURE function of
 * (slot, difficulty) — no Math.random — so the client field (GP) and the server
 * fill (MP) are IDENTICAL for the same slot, the field is the same every race, and
 * MP stays in sync. Both RaceManager and server/Room (AI fill + disconnect
 * takeover) call this so MP personalities match single-player.
 *
 * @param {number} idx  0-based grid slot (0 = pole / front-runner).
 * @param {('easy'|'medium'|'hard')} [difficulty='medium']
 * @returns {{ cc:number, profile:object }}
 */
export function buildAISlot(idx, difficulty = 'medium') {
  const i = Math.max(0, Math.floor(idx));
  const ds = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const archetype = ARCHETYPE_ORDER[i % ARCHETYPE_ORDER.length];
  const base = PERSONALITIES[archetype] || PERSONALITIES.clean;

  // Seeded fract hash in [0,1) — deterministic per (slot, channel), no randomness.
  const frac = (n) => {
    const v = Math.sin((i + 1) * 12.9898 + n * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };

  // cc drives the rubber-band CHASE strength (CC_TABLE.rubberGain). Front of the
  // grid gets the bigger engine; the whole ladder shifts UP on HARD, DOWN on EASY,
  // so difficulty scales pace/chase, not just a flat speed multiplier.
  let cc;
  if (difficulty === 'hard')      cc = i <= 3 ? 200 : i <= 8 ? 150 : 100;
  else if (difficulty === 'easy') cc = i <= 2 ? 100 : 50;
  else                            cc = i <= 1 ? 200 : i <= 4 ? 150 : i <= 8 ? 100 : 50;

  // Lane fan: give each slot its own lane across the wide road (pole left .. tail
  // right) so the field spreads ACROSS the track instead of single-filing, with a
  // hair of jitter so it isn't a ruler-straight line.
  const laneBase = (i / 12) * 2 - 1; // -1 (left) .. +1 (right) across a 13-kart field
  const laneOffset = laneBase * 0.82 + (frac(6) - 0.5) * 0.16;

  const profile = {
    pace: clampRange(base.pace + (frac(0) - 0.5) * 0.05, 0.94, 1.18),
    aggression: clampRange(base.aggression * ds.aggrMult, 0.2, 1.0),
    cornerSkill: clampRange(base.cornerSkill * ds.cornerMult + (frac(2) - 0.5) * 0.04, 0.5, 1.0),
    driftSkill: clampRange(base.driftSkill + (frac(3) - 0.5) * 0.08, 0.0, 1.0),
    mistakeRate: clampRange(base.mistakeRate * ds.mistakeMult, 0.0, 0.18),
    reactionLag: clampRange(base.reactionLag * ds.lagMult, 0.0, 0.25),
    laneOffset: clampRange(laneOffset, -0.95, 0.95),
    // ALWAYS-A-RIVAL: tag the slot-3 brawler as the designated rival — its rubber
    // band flexes harder (see step 5a) so somebody is always battling the player.
    // It also carries the fixed nemesis NAME so the HUD/results board can label it
    // (and the cup can run a head-to-head tally) across all three races. The name is
    // purely metadata — computeInput never reads it, so the sim stays deterministic.
    rival: i === 3,
    rivalName: i === 3 ? RIVAL_NAME : null,
    archetype,
  };
  return { cc, profile };
}

function clampRange(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// --- TACTICAL ITEM CATEGORIES (by item id). -------------------------------
// The AI fires by category, not on a blind timer: FORWARD shells only when a
// rival is just AHEAD, DEFENSIVE traps only when one's close BEHIND (or we lead),
// SELF boosts promptly on a straighter stretch. coin/superHorn/lightning are
// handled as small special-cases in computeInput step 7. Ids must match items.js.
const FORWARD_ITEMS = new Set(['greenShell', 'redShell', 'tripleGreen', 'tripleRed', 'bulletBill', 'blueShell']);
const DEFENSIVE_ITEMS = new Set(['banana', 'tripleBanana', 'fakeBox', 'bobOmb']);
const BOOST_ITEMS = new Set(['mushroom', 'tripleMushroom', 'goldenMushroom', 'star', 'boo']);
// Progress gaps (meters) inside which a rival counts as "in range" to attack/defend.
// Widened for the more aggressive field — AIs fire shells from further back and guard
// against chasers sooner, so power-ups are weaponised constantly instead of hoarded.
const ITEM_FWD_RANGE = 36; // fire a forward shell when the kart ahead is this close
const ITEM_DEF_RANGE = 28; // drop a trap when the kart behind is this close

export class AIRacer {
  /**
   * @param {object} opts
   * @param {RacingLine} opts.racingLine  the shared racing line for this track.
   * @param {number} [opts.cc=150]        engine class.
   * @param {number} [opts.skill=1]       0..1 legacy competence (kept for compat).
   * @param {object} [opts.profile]       per-AI PERSONALITY (see DEFAULT_PROFILE).
   * @param {number} [opts.seed]          integer seed (racer index) for stable
   *                                      per-AI variation.
   */
  constructor({ racingLine, cc = 150, skill = 1, profile, seed }) {
    this.racingLine = racingLine;
    this.cc = cc;
    this.skill = Math.max(0, Math.min(1, skill));
    this.tune = CC_TABLE[cc] || CC_TABLE[150];
    this.profile = { ...DEFAULT_PROFILE, ...(profile || {}) };
    this._seed = typeof seed === 'number' ? seed : (cc * 0.013 + skill * 7.31);

    // Item-use cooldown: a more aggressive driver fires MUCH sooner (~0.25 s) than a
    // passive one (~0.65 s). Shortened from the old 0.4..0.8 so AIs use what they hold
    // promptly instead of sitting on items — they apply boosts/shells aggressively and
    // clear their slot to pick up the next box. The intent is held true; this spaces
    // it into clean rising-edge pulses (the RaceManager fires once per edge, and
    // ItemSystem.useItem is a no-op when the slot is empty, so firing often is safe).
    this._itemCooldown = 0;
    this._itemCooldownTime = 0.18 + (1 - this.profile.aggression) * 0.3;
    // Anti-hoard fallback: how long the CURRENT item has been held. If a tactical
    // shot never lines up within ~4s, fire it anyway so AIs don't sit on items.
    this._heldId = null;
    this._itemHold = 0;

    // Internal monotonic clock (seconds), advanced by dt each tick. Used ONLY to
    // drive the deterministic mistakeRate "bobble" — NO Math.random, so the field
    // is identical every race. Seeded per-racer (via _seed) so two AIs never
    // bobble in unison.
    this._clock = 0;
    // Remaining seconds of an active bobble (throttle lift + tiny steer wobble).
    // Counts down; >0 means we're mid-mistake this tick.
    this._bobbleTimer = 0;
    // Smoothed corner-sharpness reaction, for reactionLag: a laggier driver eases
    // toward the true corner value instead of reacting to it instantly. Seeded to
    // 0 (straight) so the first ticks are calm.
    this._cornerReact = 0;

    // Reused scratch result objects so the racing-line queries don't allocate per
    // tick (12 karts * 60 Hz). Each holds its own `point` Vector3.
    this._nearRes = { point: new THREE.Vector3() };
    this._lookNearRes = { point: new THREE.Vector3() };
    this._aheadRes = { point: new THREE.Vector3() };
    this._aimVec = new THREE.Vector3();
  }

  /**
   * Produce one input snapshot for this AI kart. PURE-PURSUIT controller — the
   * kart's position comes entirely from feeding this into the shared physics, the
   * same path the player uses, so motion is smooth (no external position hacks).
   *
   * @param {object} state  the kart state { x, z, heading, speed, ... }.
   * @param {object} context { dt, ... } — only dt is used now.
   * @returns {{steer:number, throttle:number, brake:number, drift:boolean,
   *            useItem:boolean, lookBack:boolean}}
   */
  computeInput(state, context = {}) {
    const dt = context.dt || 1 / 60;
    const spd = Math.abs(state.speed);
    const halfWidth = this.racingLine.halfWidth || 8.5;

    // Advance the internal deterministic clock. Everything time-based below reads
    // this (never wall-clock, never Math.random) so the race is reproducible.
    this._clock += dt;

    // Pull the personality traits once (all already clamped in RaceManager).
    const cornerSkill = this.profile.cornerSkill || 0.8; // 0.5..1.0 corner commitment
    const aggression = this.profile.aggression || 0;     // 0.2..1.0 pushiness
    const mistakeRate = this.profile.mistakeRate || 0;    // 0..0.18 bobble frequency
    const reactionLag = this.profile.reactionLag || 0;    // 0..0.25 reaction delay

    // --- 1. Locate us on the racing line. --------------------------------
    const near = this.racingLine.getNearest(state, this._nearRes);
    const dxLine = state.x - near.point.x;
    const dzLine = state.z - near.point.z;
    const offLine = Math.sqrt(dxLine * dxLine + dzLine * dzLine);

    // --- 2. Aim point: pure-pursuit look-ahead with a SMALL personal lane. -
    // Look further ahead the faster we go (stable steering — a short look-ahead at
    // speed makes a kart saw side to side). Each AI holds a small lane (a fraction
    // of the half-width) so the field fans across the road WITHOUT ever aiming off
    // it. If we've been knocked well off the line, aim at the nearest line point
    // to get straight back on.
    // Look-ahead distance scales with cornerSkill: a better driver reads further
    // down the road (smoother, plans the line earlier), a weaker one looks shorter
    // (a touch twitchier). TIGHTENED slightly (base 5.5+skill*4.5, speed term 0.40)
    // for CRISPER apex lines — a shorter look-ahead clips the corner closer instead
    // of rounding it off, so skilled AIs hold a tighter racing line. Still kept well
    // above the old fixed 7 at speed (a high-speed kart looks ~22m ahead) so steering
    // stays stable and never saws side to side.
    // SHRINK the look-ahead on corners (reads last tick's smoothed corner sharpness
    // this._cornerReact, 0=straight..1=hairpin). On the new tight hairpins a long
    // look-ahead aims the chord ACROSS the corner into the void; cutting it down on
    // bends keeps the aim point hugging the road around the apex so the kart no
    // longer drives off the outside. Straights are unaffected (factor ~1).
    const cornerCut = 1 - 0.6 * Math.min(1, this._cornerReact || 0);
    const lookAhead = ((5.5 + cornerSkill * 4.5) + spd * 0.40) * cornerCut;
    let aimX, aimZ;
    if (offLine > halfWidth * 1.15) {
      aimX = near.point.x;
      aimZ = near.point.z;
    } else {
      // Lane: each AI's persistent offset, plus a tiny aggression bias — a pushier
      // driver hugs its line a hair tighter toward the inside. Kept small (×0.06)
      // so it never nudges anyone off the road.
      const laneBias = (this.profile.laneOffset || 0) * 0.7 + aggression * 0.06;
      const lane = Math.max(-0.9, Math.min(0.9, laneBias)); // clamp: stay on road
      const aim = this.racingLine.getOffsetLookahead(
        state, lookAhead, lane, this._lookNearRes, this._aimVec);
      aimX = aim.x;
      aimZ = aim.z;
    }

    // --- 3. Steering: pure pursuit toward the aim point. -----------------
    // Heading frame (shared model): forward = (sin h, cos h); a point to the RIGHT
    // (+X at heading 0) gives a POSITIVE angle and steer=+1 turns toward it — so
    // steer has the SAME sign as the wrapped angle error (no flip).
    const toX = aimX - state.x;
    const toZ = aimZ - state.z;
    const targetAngle = Math.atan2(toX, toZ);
    let delta = targetAngle - state.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // wrap to [-PI, PI]
    // CRITICAL SIGN: the shared physics does `heading -= steer*rate` (steer +1 =
    // turn RIGHT / heading decreases). To rotate heading TOWARD the aim by +delta
    // we therefore need steer = -delta (NOT +delta). The old AI used +delta, which
    // was inverted ever since the physics flipped to `-=` — so the AI always
    // steered the WRONG way and circled off the road. This is the real root cause.
    let steer = -delta * 1.5;
    if (steer > 1) steer = 1;
    else if (steer < -1) steer = -1;
    const absSteer = Math.abs(steer);

    // --- 4. Corner sharpness: how much the line bends ahead. -------------
    // Dot of the unit tangent here vs. at the aim point: 1 = straight, lower = sharper.
    const ahead = this.racingLine.getNearest({ x: aimX, z: aimZ }, this._aheadRes);
    let corner = (1 - near.tangent.dot(ahead.tangent)) * 0.5;
    if (corner < 0) corner = 0;
    else if (corner > 1) corner = 1;

    // reactionLag: a laggier driver doesn't register the corner instantly — ease a
    // smoothed value toward the true corner. The lag only DELAYS reacting; it never
    // makes them carry MORE speed than the corner allows, because we brake on the
    // MAX of the true and smoothed corner (so a sudden sharpening still triggers an
    // immediate cut — laggy drivers brake a touch late, not dangerously late). Time
    // constant grows with reactionLag (0 = instant, 0.25 = ~0.25s ease).
    const tau = reactionLag; // seconds of lag (0..0.25)
    if (tau > 0.001) {
      // Exponential approach: react += (corner - react) * (dt / tau), clamped step.
      const k = Math.min(1, dt / tau);
      this._cornerReact += (corner - this._cornerReact) * k;
    } else {
      this._cornerReact = corner;
    }
    // Brake on the WORSE of the two so lag can never send a kart in too hot.
    const cornerForSpeed = Math.max(corner, this._cornerReact);

    // --- 5. Speed control — the AI's "stay on the road" mechanism. -------
    // Brake down to a speed the upcoming bend can be taken at, so the kart holds
    // the line instead of understeering wide off the edge. `pace` sets the
    // straight-line top speed (distinct fast/slow drivers → the field strings
    // out); `cornerSkill` lets a better driver carry more speed through corners.
    // Base is now 44 to match PHYSICS.MAX_SPEED (was 32) — karts genuinely top out
    // near the real cap scaled by their pace.
    //
    // DIFFICULTY-SCALED CAP: the AI's target top speed is the pace-scaled wish,
    // FIRST clamped to the player's BASE cruise cap, THEN scaled by the difficulty
    // factor. RaceManager/Room thread in:
    //   context.playerMaxTopSpeed  = 44 * (player kart topSpeed-stat mult), the
    //                                player's base cruise cap (defaults to 44 for a
    //                                neutral player), and
    //   context.difficultyFactor   = difficultyFactorFor(difficulty): EASY 0.82 /
    //                                MEDIUM 0.93 stay <=1 (AI sits at or below the
    //                                player's base, beatable); HARD 1.06 is a touch
    //                                ABOVE 1 so the top cars keep pace with a player
    //                                who is constantly drifting/boosting past base.
    // So: targetTop = min(44*pace, playerMax) * difficultyFactor.
    const playerMax = context.playerMaxTopSpeed || 44;     // player's base top-speed cap
    const diffFactor = context.difficultyFactor != null ? context.difficultyFactor : 1; // easy/med <=1, hard ~1.06
    const topSpeed = Math.min(44 * (this.profile.pace || 1), playerMax) * diffFactor;
    // STRONGER corner cut than before: at the higher top speed a kart covers ground
    // faster, so it must shed more speed to still hold every bend (target 0 off-
    // road). A skilled driver carries MORE apex speed than before — but the EXTRA
    // carry is TEMPERED as the corner sharpens, so even an ace still brakes hard on
    // the tightest bend (the 0%-off-road guarantee). The reduction has two parts:
    //   baseSkill = the flat per-skill reduction (0 at skill 0.5 → 0.45 at skill 1.0),
    //               same magnitude as the old `cornerSkill*0.45` term, applied at all
    //               sharpness levels (so a skilled driver is never SLOWER than before).
    //   apexCarry = an ADDITIONAL bonus (up to 0.22 at skill 1.0) that only applies on
    //               mild/medium bends — scaled by (1-cornerForSpeed)^1.4 so it fades to
    //               ~0 on the sharpest corner. This is the genuine "carry more apex
    //               speed" gain that drops skilled lap times, granted ONLY where there
    //               is braking margin, never on the tightest bend.
    //   aggression trims a hair more (brakes a touch later) — kept tiny.
    // Base multiplier 1.55 unchanged; clamp 0.92 unchanged. Verified worst case — at
    // cornerForSpeed=1, skill=1: baseSkill=0.45, apexCarry=0.22*(1-1)^1.4=0 →
    // cut=min(0.92, 1.55-0.45-0-0.05)=min(0.92,1.05)=0.92, IDENTICAL to the old
    // hardest brake. So corner-entry speed on the sharpest bend is NOT raised for any
    // driver; the extra speed appears only on mild/medium bends that have margin.
    const baseSkill = Math.max(0, cornerSkill - 0.5) * 0.9;          // 0..0.45
    const apexCarry = Math.max(0, cornerSkill - 0.5) * 0.44          // 0..0.22 cap
      * Math.pow(1 - cornerForSpeed, 1.4);
    const cut = Math.min(
      0.92,
      cornerForSpeed * (1.55 - baseSkill - apexCarry - aggression * 0.05),
    );

    // --- 5a. RUBBER-BANDING toward the PLAYER (keeps the pack tight). -----
    // Turn the signed gap to the player into a top-speed multiplier. The gap is
    // (playerProgressScore - myProgressScore) converted to METERS via the loop's
    // meters-per-score scale (RaceManager passes it in the context, computed once
    // from the racing-line length / checkpoint count). Positive gap = the player
    // is AHEAD of us, so we chase UP; negative = we're ahead, so we ease OFF. The
    // `rival` flag (one designated AI) flexes a touch harder so SOMEONE is always
    // hovering near the player to battle. NOTE: this multiplier is applied to the
    // STRAIGHT-LINE speed ONLY below — never to the corner brake — so the 0%-off-
    // road guarantee is untouched.
    let rubberMult = 1;
    {
      const playerScore = context.playerProgressScore || 0;
      const myScore = context.myProgressScore || 0;
      const m2score = context.progressMetersPerScore || 0;
      // Only flex when we actually know the scale + have a real gap (m2score is 0
      // before the racing line is measured; then we just drive at base pace).
      if (m2score > 0) {
        const gapM = (playerScore - myScore) * m2score; // + = player ahead of us
        const rubberGain = this.tune.rubberGain || 0.2;
        const rivalK = this.profile.rival ? 1.35 : 1; // designated rival chases harder
        if (gapM > 0) {
          // BEHIND the player: speed up, proportional to the gap, saturating.
          const behind = Math.min(1, gapM / RUBBER_REF_DIST);
          rubberMult = 1 + rubberGain * rivalK * behind;
        } else if (gapM < 0) {
          // AHEAD of the player: ease off so we don't run away with the race.
          const aheadAmt = Math.min(1, -gapM / RUBBER_REF_DIST);
          rubberMult = 1 - RUBBER_EASE_OFF * rivalK * aheadAmt;
        }
        if (rubberMult > RUBBER_MAX) rubberMult = RUBBER_MAX;
        else if (rubberMult < RUBBER_MIN) rubberMult = RUBBER_MIN;
      }
    }

    // --- 5b. Compose the target speed. -----------------------------------
    // corneredBase is the ABSOLUTE speed the upcoming bend can be taken at, from
    // the UNCHANGED base pace — this is the on-road safety limit and rubber-banding
    // must never raise it. When CHASING (rubberMult >= 1) we ADD a straight-line
    // bonus scaled by `straightness` (1 on a straight, 0 on the sharpest bend) so
    // the extra speed appears only where there is braking margin and fades to 0
    // into a corner (corner-entry speed identical to before). When EASING OFF
    // (rubberMult < 1) we scale the whole target down — slowing into a corner is
    // always safe, so that's fine to apply everywhere.
    const corneredBase = topSpeed * (1 - cut);
    let targetSpeed;
    if (rubberMult >= 1) {
      // `straightness` gates the chase bonus to NEAR-STRAIGHT road only: it is 1
      // when dead straight and falls LINEARLY to 0 by RUBBER_BONUS_FADE worth of
      // corner sharpness — so any real bend (cornerForSpeed beyond that small
      // threshold) gets ZERO rubber bonus and the corner-entry speed equals the
      // unchanged base. This is the 0%-off-road guarantee: rubber-banding can never
      // add speed into a corner, only on the straights where there is braking margin.
      const straightness = Math.max(0, 1 - cornerForSpeed / RUBBER_BONUS_FADE);
      const bonus = topSpeed * (rubberMult - 1) * straightness;
      targetSpeed = corneredBase + bonus;
      // AI-BEATABLE clamp (CONTRACT): even when CHASING the player on a straight,
      // the rubber-band bonus must never lift the AI's target ABOVE the player's
      // effective max cruise. Without this a behind-AI on a straight could reach
      // topSpeed*RUBBER_MAX (> playerMax) and out-cruise the player. We clamp to
      // playerMax * diffFactor — the same ceiling topSpeed already respects — so a
      // chasing AI tops out at that cap: at/below the player's base on easy/medium,
      // a touch above it on HARD (so the front cars keep pace with a player who is
      // boosting past base). Corner-entry speed is untouched (bonus fades to 0 there).
      const chaseCap = playerMax * diffFactor;
      if (targetSpeed > chaseCap) targetSpeed = chaseCap;
    } else {
      targetSpeed = corneredBase * rubberMult;
    }
    if (targetSpeed < 6) targetSpeed = 6;
    let throttle = 1;
    let brake = 0;
    if (spd > targetSpeed + 1.5) {
      brake = Math.min(1, (spd - targetSpeed) / 7);
      throttle = 0;
    } else if (spd > targetSpeed) {
      throttle = 0;
    }

    // --- 5b. mistakeRate: occasional brief bobble (deterministic, NO Math.random).
    // Periodically lift the throttle for ~0.3s and add a tiny steer wobble, so a
    // mistake-prone driver looks human (loses a little time) without ever steering
    // off the road. Trigger is seeded + clock-driven: a per-racer phase sine that,
    // when it crosses a threshold set by mistakeRate, starts a fresh bobble. Higher
    // mistakeRate => the threshold is easier to cross => bobbles more often. A driver
    // with mistakeRate 0 never bobbles (threshold unreachable).
    if (this._bobbleTimer > 0) {
      this._bobbleTimer -= dt;
    } else if (mistakeRate > 0.001) {
      // Slow seeded oscillator in [0,1): unique phase/period per racer via _seed.
      const osc = 0.5 + 0.5 * Math.sin(this._clock * (0.7 + this._seed * 0.11) + this._seed * 1.7);
      // Cross => start a ~0.3s bobble. mistakeRate up to 0.18 maps to a reachable
      // threshold; below the peak (1.0) so even the worst driver bobbles only now
      // and then, not constantly.
      if (osc > 1 - mistakeRate * 1.1) {
        this._bobbleTimer = 0.3;
      }
    }
    if (this._bobbleTimer > 0) {
      // Lift throttle (coast) and nudge steer by a small seeded wobble. The wobble
      // is tiny (≤0.08) and oscillates, so it never overpowers the pure-pursuit
      // correction that keeps the kart on the line.
      throttle = 0;
      // Only drop the brake on near-straight road — a bobble must NOT delete the
      // corner brake at a hairpin entry (that's the stay-on-road guarantee).
      if (cornerForSpeed < 0.2) brake = 0;
      const wob = Math.sin(this._clock * 9 + this._seed) * 0.08;
      steer += wob;
      if (steer > 1) steer = 1;
      else if (steer < -1) steer = -1;
    }

    // --- 5c. HAZARD DODGE: nudge around oil/cones in our short forward path. --
    // Scan context.hazards for the NEAREST one sitting in a short cone ahead (within
    // spd*0.7+12m, laterally within its radius + a kart half-width of our heading).
    // Add a GENTLE steer bias AWAY from it — but clamped to the same on-road lane
    // limit the lane logic respects, so a dodge can never push us off the road: if
    // the away side has no room, we brake slightly instead of steering off. Only
    // runs when we're ON the road (off-line recovery owns the wheel otherwise) and
    // moving. Pure math on state + context — deterministic, no Math.random.
    const hazards = context.hazards;
    if (hazards && hazards.length && offLine <= halfWidth && spd > 4) {
      const sh = Math.sin(state.heading), ch = Math.cos(state.heading);
      const range = spd * 0.7 + 12;
      let bestFwd = Infinity, bestLat = 0, bestBand = 0;
      for (let h = 0; h < hazards.length; h++) {
        const hz = hazards[h];
        const dxh = hz.x - state.x, dzh = hz.z - state.z;
        const fwd = dxh * sh + dzh * ch;          // distance ahead along heading
        if (fwd <= 0 || fwd > range) continue;
        const lat = dxh * ch - dzh * sh;          // + = hazard is to our +X side
        const band = ((hz.params && hz.params.radius) || 3) + 1.5; // + kart half-width
        if (Math.abs(lat) > band) continue;       // not in our path — ignore
        if (fwd < bestFwd) { bestFwd = fwd; bestLat = lat; bestBand = band; }
      }
      if (bestFwd < Infinity) {
        // Our signed lateral position on the road (+ = +X side), from the line frame.
        const rnx = near.tangent.z, rnz = -near.tangent.x; // road right-normal (unit)
        const roadPos = (state.x - near.point.x) * rnx + (state.z - near.point.z) * rnz;
        // Steer AWAY from the hazard. Same sign convention as step 3: a +X target
        // needs NEGATIVE steer, so to move toward -X (away from a +X hazard) we add
        // POSITIVE steer. dir>0 moves us toward -X (roadPos falls); dir<0 toward +X.
        let dir = bestLat >= 0 ? 1 : -1;
        const limit = halfWidth * 0.85;           // same on-road lane ceiling as the lane logic
        const room = dir > 0 ? (limit + roadPos) : (limit - roadPos); // headroom that way
        if (room < 1) {
          // No room to dodge without leaving the road — brake instead of steering off
          // (never reduce the corner brake; only ever raise it).
          dir = 0;
          if (brake < 0.35) brake = 0.35;
          throttle = 0;
        }
        if (dir !== 0) {
          const centered = 1 - Math.abs(bestLat) / bestBand; // 1 = dead ahead
          const close = Math.max(0.25, 1 - bestFwd / range);  // 1 = right on top of it
          steer += dir * 0.4 * centered * close;              // gentle — these are small
          if (steer > 1) steer = 1;
          else if (steer < -1) steer = -1;
        }
      }
    }

    // --- 5d. BOOST / RAMP seeking: detour to grab a speed pad or hit a ramp. ----
    // Scan the look-ahead for the nearest boost-pad / ramp in a short forward cone
    // and steer TOWARD it, so an AI holding a wide lane drifts back toward center to
    // grab the boost (or line up a launch ramp) instead of sailing past it. The pull
    // is AGGRESSION-GATED — bolder drivers detour harder and look further — and
    // clamped to the same on-road lane ceiling the hazard dodge uses, so chasing a
    // pad can never steer a kart off the road. Skipped on real corners (we never
    // fight the corner brake for a pad) and while off-line recovery owns the wheel.
    // Pure geometry on state + context — deterministic, no Math.random.
    const boostRamps = context.boostRamps;
    if (boostRamps && boostRamps.length && offLine <= halfWidth && spd > 8 && cornerForSpeed < 0.35) {
      const sh = Math.sin(state.heading), ch = Math.cos(state.heading);
      const range = 28 + aggression * 12; // bolder AIs look further to grab a pad
      let bestFwd = Infinity, bestLat = 0;
      for (let f = 0; f < boostRamps.length; f++) {
        const ft = boostRamps[f];
        const dxf = ft.x - state.x, dzf = ft.z - state.z;
        const fwd = dxf * sh + dzf * ch;          // distance ahead along heading
        if (fwd <= 2 || fwd > range) continue;
        const lat = dxf * ch - dzf * sh;          // + = pad is to our +X side
        if (Math.abs(lat) > halfWidth) continue;  // off the road — can't reach it cleanly
        if (fwd < bestFwd) { bestFwd = fwd; bestLat = lat; }
      }
      // Only bother if the pad is meaningfully off our current lane — otherwise the
      // pure-pursuit line already carries us over it.
      if (bestFwd < Infinity && Math.abs(bestLat) > 0.6) {
        const rnx = near.tangent.z, rnz = -near.tangent.x; // road right-normal (unit)
        const roadPos = (state.x - near.point.x) * rnx + (state.z - near.point.z) * rnz;
        const limit = halfWidth * 0.85;
        // Sign (same as step 3): a +X target needs NEGATIVE steer, so dir steers
        // TOWARD the pad. dir>0 moves toward -X (a left-side pad); dir<0 toward +X.
        const dir = bestLat > 0 ? -1 : 1;
        const room = dir > 0 ? (limit + roadPos) : (limit - roadPos); // headroom that way
        if (room > 1) {
          const close = Math.max(0.2, 1 - bestFwd / range); // 1 = right on top of it
          const pull = 0.45 * aggression * close * Math.min(1, Math.abs(bestLat) / halfWidth);
          steer += dir * pull;
          if (steer > 1) steer = 1;
          else if (steer < -1) steer = -1;
        }
      }
    }

    // --- 6. Drift through sharp corners for a mini-turbo. ----------------
    const driftThreshold = 0.42 - (this.profile.driftSkill || 0) * 0.22;
    const drift =
      offLine <= halfWidth * 1.15 &&
      spd > 12 &&
      corner > driftThreshold &&
      absSteer > 0.4 &&
      (this.profile.driftSkill || 0) > 0.15;

    // --- 7. TACTICAL item use. -------------------------------------------
    // Fire by CATEGORY using what we hold (context.selfHeldItem) and our standings
    // gaps, not on a blind timer. The cooldown stays as a MIN-SPACING so we still
    // hand the RaceManager clean rising-edge pulses (it fires once per edge). An
    // anti-hoard fallback fires anything held longer than ~4s.
    if (this._itemCooldown > 0) this._itemCooldown -= dt;
    const held = context.selfHeldItem; // { id, count } | null
    // Track how long THIS item has been held (resets when the slot changes/empties).
    if (held && held.id === this._heldId) {
      this._itemHold += dt;
    } else {
      this._heldId = held ? held.id : null;
      this._itemHold = 0;
    }
    let useItem = false;
    if (held && this._itemCooldown <= 0) {
      // Progress gaps (in meters) to the kart just AHEAD / just BEHIND in the order.
      const standings = context.standings;
      const m2s = context.progressMetersPerScore || 0;
      let aheadM = Infinity, behindM = Infinity, leading = false, haveAhead = false;
      if (standings) {
        let idx = -1;
        for (let s = 0; s < standings.length; s++) {
          if (standings[s].id === context.selfId) { idx = s; break; }
        }
        if (idx >= 0) {
          leading = idx === 0;
          if (idx > 0) {
            haveAhead = true;
            const g = standings[idx - 1].progressScore - standings[idx].progressScore;
            aheadM = m2s > 0 ? g * m2s : g;
          }
          if (idx < standings.length - 1) {
            const g = standings[idx].progressScore - standings[idx + 1].progressScore;
            behindM = m2s > 0 ? g * m2s : g;
          }
        }
      }
      const id = held.id;
      let want;
      if (FORWARD_ITEMS.has(id)) {
        want = aheadM < ITEM_FWD_RANGE;                 // a catchable rival just ahead
      } else if (DEFENSIVE_ITEMS.has(id)) {
        want = leading || behindM < ITEM_DEF_RANGE;     // someone pressuring from behind
      } else if (BOOST_ITEMS.has(id)) {
        want = cornerForSpeed < 0.12;                   // boost on a straighter stretch
      } else if (id === 'coin') {
        want = cornerForSpeed < 0.12;                   // small boost — same as a mushroom
      } else if (id === 'superHorn') {
        want = aheadM < ITEM_DEF_RANGE || behindM < ITEM_DEF_RANGE; // shockwave a close rival
      } else if (id === 'lightning') {
        want = haveAhead;                               // shrink the field when we can gain
      } else {
        want = true;                                    // unknown item: just use it
      }
      // Anti-hoard: never sit on an item longer than ~4s.
      if (want || this._itemHold > 4) {
        useItem = true;
        this._itemCooldown = this._itemCooldownTime;
      }
    }

    return { steer, throttle, brake, drift, useItem, lookBack: false };
  }
}

export default AIRacer;
