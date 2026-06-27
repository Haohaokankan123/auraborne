// src/data/karts.js
//
// M5 customization data: the kart BODIES and WHEELS a player bolts onto their
// chosen character, plus combineStats() — the function that blends character +
// body + wheels into the final stat profile shared/kartModel.js consumes.
//
// All ORIGINAL designs/names — no third-party IP.
//
// HOW THE PARTS WORK (the tradeoff design):
//   - A character contributes a full `statBias` (see characters.js): six numbers
//     in 0..1. That is the dominant term — your driver defines the base feel.
//   - A body and a set of wheels each contribute small DELTAS (typically
//     -0.15..+0.15) that NUDGE individual stats. Deltas are deliberately small
//     so parts tune a build rather than override the character.
//   - Every part is a TRADEOFF: a delta that raises one stat lowers another, so
//     there is no strictly-best body or wheel — only builds that suit a driver
//     or a track. Example: the "Bullet" body trades handling for top speed; the
//     "Slick" wheels trade traction for top speed; "Knobby" wheels do the
//     reverse. Picking parts is about leaning into or patching your driver.
//
// combineStats() sums character base + body delta + wheel delta per stat, then
// CLAMPS each result back to 0..1 so a build can never escape the legal band the
// model expects. The output is a complete, clamped stat profile.

/**
 * @typedef {Object} StatDelta
 * Partial stat profile of signed nudges. Any of the six keys may be present;
 * missing keys count as 0. Values are small (~-0.15..+0.15).
 * @property {number} [topSpeed]
 * @property {number} [accel]
 * @property {number} [handling]
 * @property {number} [weight]
 * @property {number} [traction]
 * @property {number} [miniTurbo]
 */

/**
 * @typedef {Object} BodyGeometry
 * Procedural shape recipe Kart.js reads to build a VISUALLY DISTINCT silhouette
 * per body. These are pure numbers/flags (no three.js, no DOM) so the headless
 * server can import this file safely. Every field is optional — Kart.js merges
 * each body over ARCHETYPE_DEFAULTS, so a partial recipe still produces a
 * complete kart. All linear values are MULTIPLIERS on Kart.js's base
 * dimensions (1.0 = the original sleek-racer size) unless noted.
 *
 * @property {number} [chassisW]   - chassis width multiplier (stance).
 * @property {number} [chassisH]   - chassis height multiplier (how tall/bulky).
 * @property {number} [chassisL]   - chassis length multiplier (short pod .. long F1).
 * @property {number} [round]      - corner-bevel multiplier (1=soft/toy, <1=sharp/aggressive).
 * @property {number} [wheelScale] - tire radius+width multiplier (small kart .. big off-roader).
 * @property {number} [trackW]     - half-track multiplier (how far the wheels sit out).
 * @property {number} [hoodScale]  - front hood-pod size multiplier (0 hides the hood).
 * @property {number} [noseLen]    - nose-wedge length multiplier (0 hides the nose).
 * @property {('wedge'|'snub'|'point')} [noseShape] - silhouette of the front.
 * @property {('wing'|'ducktail'|'rollbar'|'none')} [rear] - rear furniture archetype.
 * @property {boolean} [fins]      - add small upright tail fins beside the rear.
 * @property {boolean} [sidePods]  - keep the bulging engine cowls over the rear wheels.
 * @property {('stripe'|'chevron'|'dot'|'none')} [accent] - shape of the painted accent panel.
 * @property {number} [rideHeight] - chassis lift multiplier (1=low racer, >1=raised off-roader).
 */

/**
 * @typedef {Object} KartBody
 * @property {string} id        - stable unique key.
 * @property {string} name      - display name (original).
 * @property {StatDelta} stats  - signed stat deltas applied to the build.
 * @property {BodyGeometry} [geometry] - procedural shape recipe (Kart.js reads this).
 */

/**
 * @typedef {Object} KartWheels
 * @property {string} id        - stable unique key.
 * @property {string} name      - display name (original).
 * @property {StatDelta} stats  - signed stat deltas applied to the build.
 */

/** @type {KartBody[]} */
export const KART_BODIES = [
  {
    id: 'roadster',
    name: 'Standard Roadster',
    // The neutral body: no deltas. Picks up the character's feel unchanged.
    stats: {},
    // SLEEK RACER archetype — the original baseline silhouette: low, softly
    // rounded toy-kart with a small hood, a short ducktail, side pods and a
    // stripe accent. Everything ~1.0 so this reads as the "standard" shape.
    geometry: {
      chassisW: 1.0, chassisH: 1.0, chassisL: 1.0, round: 1.0,
      wheelScale: 1.0, trackW: 1.0, hoodScale: 1.0, noseLen: 1.0,
      noseShape: 'wedge', rear: 'ducktail', fins: false, sidePods: true,
      accent: 'stripe', rideHeight: 1.0,
    },
  },
  {
    id: 'bullet',
    name: 'Bullet Frame',
    // Speed/weight body: faster top end and heavier, at the cost of cornering
    // and a touch of acceleration. Rewards confident, straight-line driving.
    // Pro speed body — unlocks after 3 race wins.
    unlock: { stat: 'racesWon', threshold: 3 },
    stats: { topSpeed: 0.12, weight: 0.1, handling: -0.12, accel: -0.06 },
    // LONG F1 archetype — stretched, very low and narrow with a sharp pointed
    // nose and a big high rear wing. The longest, flattest silhouette in the
    // field: unmistakably the straight-line speed body.
    geometry: {
      chassisW: 0.86, chassisH: 0.78, chassisL: 1.34, round: 0.55,
      wheelScale: 0.94, trackW: 1.04, hoodScale: 0.7, noseLen: 1.5,
      noseShape: 'point', rear: 'wing', fins: false, sidePods: true,
      accent: 'chevron', rideHeight: 0.82,
    },
  },
  {
    id: 'nimbus',
    name: 'Nimbus Shell',
    // Agility body: better handling, accel and mini-turbo, but lighter and
    // slower flat-out. The inverse of the Bullet — built for technical tracks.
    stats: { handling: 0.12, accel: 0.08, miniTurbo: 0.08, topSpeed: -0.1, weight: -0.08 },
    // COMPACT POD archetype — short, tall-ish bubble with NO hood and NO nose
    // wedge (a stubby round shell), small wheels and a narrow track. Reads as a
    // cute, nimble little pod that turns on a dime.
    geometry: {
      chassisW: 0.94, chassisH: 1.05, chassisL: 0.74, round: 1.35,
      wheelScale: 0.86, trackW: 0.9, hoodScale: 0, noseLen: 0,
      noseShape: 'snub', rear: 'none', fins: false, sidePods: false,
      accent: 'dot', rideHeight: 1.0,
    },
  },
  {
    id: 'tank',
    name: 'Ironclad Tank',
    // Bruiser body: heaviest and grippiest, holds top speed well, but the worst
    // handling and accel. Shoves lighter karts around; ponderous to turn.
    // Heavyweight reward body — unlocks with your first cup win.
    unlock: { stat: 'cupsWon', threshold: 1 },
    stats: { weight: 0.15, traction: 0.08, topSpeed: 0.05, handling: -0.15, accel: -0.1 },
    // BULKY HEAVY archetype — wide, tall and slab-sided with a heavy snub nose,
    // a protective roll-bar at the back, and a chunky stance. The biggest,
    // most imposing body — clearly the bruiser.
    geometry: {
      chassisW: 1.22, chassisH: 1.28, chassisL: 1.06, round: 0.8,
      wheelScale: 1.1, trackW: 1.12, hoodScale: 1.15, noseLen: 0.6,
      noseShape: 'snub', rear: 'rollbar', fins: false, sidePods: true,
      accent: 'chevron', rideHeight: 1.05,
    },
  },
  {
    id: 'darter',
    name: 'Quick Darter',
    // Sprinter body: strong accel and mini-turbo for snappy launches and drift
    // boosts, but light and low on top speed. Great for stop-start circuits.
    // Coin-shop body — bought with coins, not race wins.
    coinsPrice: 60,
    stats: { accel: 0.12, miniTurbo: 0.1, weight: -0.1, topSpeed: -0.08 },
    // CHUNKY OFF-ROADER archetype — raised ride height on FAT oversized wheels
    // with a wide track, a stubby wedge nose and a pair of upright tail fins.
    // Sits visibly higher off the ground than every other body.
    geometry: {
      chassisW: 1.08, chassisH: 1.08, chassisL: 0.96, round: 1.1,
      wheelScale: 1.26, trackW: 1.16, hoodScale: 0.85, noseLen: 0.8,
      noseShape: 'wedge', rear: 'none', fins: true, sidePods: true,
      accent: 'stripe', rideHeight: 1.35,
    },
  },
];

/** @type {KartWheels[]} */
export const WHEELS = [
  {
    id: 'standard',
    name: 'Standard Tires',
    // Neutral wheels: no deltas.
    stats: {},
  },
  {
    id: 'slick',
    name: 'Slick Racing',
    // Track wheels: faster top speed, but less grip (more slip on/off road) and
    // a little less handling. Pure tarmac speed, punished by rough surfaces.
    // Flashy race slicks — unlock after 5 race wins.
    unlock: { stat: 'racesWon', threshold: 5 },
    stats: { topSpeed: 0.1, traction: -0.12, handling: -0.05 },
  },
  {
    id: 'knobby',
    name: 'Knobby Off-Road',
    // Grip wheels: high traction and handling, slightly lower top speed. The
    // inverse of slicks — planted and forgiving, a bit slower flat-out.
    // Coin-shop wheels — bought with coins.
    coinsPrice: 30,
    stats: { traction: 0.12, handling: 0.06, topSpeed: -0.08 },
  },
  {
    id: 'sprint',
    name: 'Sprint Compound',
    // Launch wheels: better accel and mini-turbo at a small top-speed cost.
    // Pairs well with drift-heavy, technical driving.
    // Coin-shop wheels — bought with coins.
    coinsPrice: 35,
    stats: { accel: 0.1, miniTurbo: 0.08, topSpeed: -0.05 },
  },
  {
    id: 'heavyduty',
    name: 'Heavy-Duty',
    // Stability wheels: more weight and traction, less handling. Steadies a
    // twitchy light build at the cost of nimbleness.
    // Champion stability set — unlocks at 2 cup wins.
    unlock: { stat: 'cupsWon', threshold: 2 },
    stats: { weight: 0.1, traction: 0.08, handling: -0.1 },
  },
];

// The six stat keys, in profile order. Centralized so combineStats and any
// consumer iterate the same canonical set.
const STAT_KEYS = ['topSpeed', 'accel', 'handling', 'weight', 'traction', 'miniTurbo'];

/**
 * Clamp a number into the legal 0..1 stat band. Non-finite inputs fall back to
 * the neutral 0.5 so a malformed part can never knock a build out of band.
 *
 * @param {number} v
 * @returns {number} v clamped to [0, 1], or 0.5 if v is not finite.
 * @private
 */
function clamp01(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Blend a character + kart body + wheels into a final stat profile.
 *
 * For each of the six stats: start from the character's statBias (the base,
 * defaulting to neutral 0.5 if the character omits it), ADD the body's delta and
 * the wheels' delta (each defaulting to 0), then CLAMP back into 0..1. The result
 * is a complete, clamped profile ready for createKartState({ stats }).
 *
 * Any argument may be omitted/partial — missing parts contribute nothing, so
 * combineStats() with no body/wheels just returns the clamped character base.
 *
 * @param {import('./characters.js').Character} character - chosen driver (statBias is the base).
 * @param {KartBody} [body]    - chosen body (stat deltas).
 * @param {KartWheels} [wheels]- chosen wheels (stat deltas).
 * @returns {{topSpeed:number,accel:number,handling:number,weight:number,traction:number,miniTurbo:number}}
 *          a complete stat profile, every field clamped to 0..1.
 */
export function combineStats(character, body, wheels) {
  const base = (character && character.statBias) || {};
  const bodyDelta = (body && body.stats) || {};
  const wheelDelta = (wheels && wheels.stats) || {};

  const out = {};
  for (const key of STAT_KEYS) {
    // Character base defaults to neutral 0.5; part deltas default to 0.
    const baseVal = typeof base[key] === 'number' ? base[key] : 0.5;
    const bodyVal = typeof bodyDelta[key] === 'number' ? bodyDelta[key] : 0;
    const wheelVal = typeof wheelDelta[key] === 'number' ? wheelDelta[key] : 0;
    out[key] = clamp01(baseVal + bodyVal + wheelVal);
  }
  return out;
}

/**
 * Look up a kart body by id, falling back to the first (neutral) body so a stale
 * selection never crashes the build.
 * @param {string} id
 * @returns {KartBody}
 */
export function getBodyById(id) {
  return KART_BODIES.find((b) => b.id === id) || KART_BODIES[0];
}

/**
 * Deterministically pick a kart body for a racer INDEX, so the 13-kart field
 * gets a spread of all five archetypes without anyone choosing one. Wraps the
 * list with modulo, so racers 0..4 get bodies 0..4, racer 5 wraps to 0, etc.
 * Kart.js uses this when the caller doesn't pass an explicit body (the AI grid).
 *
 * @param {number} index - non-negative racer index.
 * @returns {KartBody}
 */
export function getBodyByIndex(index) {
  const n = KART_BODIES.length;
  // (((i % n) + n) % n) keeps a negative or non-integer index in range.
  const i = ((((index | 0) % n) + n) % n);
  return KART_BODIES[i];
}

/**
 * Look up a wheel set by id, falling back to the first (neutral) wheels.
 * @param {string} id
 * @returns {KartWheels}
 */
export function getWheelsById(id) {
  return WHEELS.find((w) => w.id === id) || WHEELS[0];
}
