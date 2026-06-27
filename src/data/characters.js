// src/data/characters.js
//
// M5 customization data: the roster of selectable drivers. ALL ORIGINAL — these
// are our own characters, names, and colors. No Nintendo (or any third-party) IP.
//
// Each character carries a `statBias`: a partial stat profile, where every field
// is a normalized 0.0..1.0 number (0 = worst of that stat, 1 = best). These are
// the CHARACTER's contribution to the final kart stats; src/data/karts.js blends
// them with the chosen body + wheels via combineStats() into the profile that
// shared/kartModel.js consumes.
//
// WEIGHT-CLASS DESIGN (the core tradeoff):
//   - 'light'  drivers: strong accel / handling / miniTurbo, but LOWER topSpeed
//              and weight. They launch fast, corner tight, and bank boosts
//              quickly — but lose flat-out top-end and get shoved around in
//              contact. Great for technical, twisty driving.
//   - 'medium' drivers: balanced ~0.5 across the board. The safe all-rounder.
//   - 'heavy'  drivers: high topSpeed and weight (they bully lighter karts and
//              hold a straight line), but WORSE accel and handling. Slow to spin
//              up and wide through corners, devastating on long straights.
//
// `traction` (grip / how little you slip on corners + offroad) is tuned per
// character independently of class, so two same-class drivers still feel
// distinct. `color` is the kart's primary hex tint, read by the renderer.

/**
 * @typedef {Object} StatBias
 * @property {number} topSpeed  - 0..1 flat-out top speed contribution.
 * @property {number} accel     - 0..1 acceleration contribution.
 * @property {number} handling  - 0..1 cornering / turn-rate contribution.
 * @property {number} weight    - 0..1 mass (bump push / shove resistance) contribution.
 * @property {number} traction  - 0..1 grip contribution (less slip on/off road).
 * @property {number} miniTurbo - 0..1 drift charge-rate + boost-duration contribution.
 */

/**
 * @typedef {Object} DriverLook
 * Procedural appearance recipe for the seated driver. Pure data (no three.js,
 * no DOM) so the headless server can import this file. Kart.js merges each look
 * over its own defaults, so a partial recipe is fine. Linear values are
 * MULTIPLIERS on Kart.js's base driver size (1.0 = the original driver).
 *
 * @property {('round'|'aero'|'crown'|'visorless')} [helmet] - helmet silhouette.
 * @property {number} [helmetScale] - helmet size multiplier (small head .. big dome).
 * @property {number} [build]       - torso girth/height multiplier (slim .. burly).
 * @property {number} [accent]      - secondary trim color as a hex int (helmet stripe / visor tint).
 * @property {number} [visor]       - visor glow color as a hex int.
 */

/**
 * @typedef {Object} Character
 * @property {string} id         - stable unique key (used for selection + save).
 * @property {string} name       - display name (original, no third-party IP).
 * @property {number} color      - primary kart tint as a hex int (0xRRGGBB).
 * @property {('light'|'medium'|'heavy')} weightClass - drives the broad tradeoff.
 * @property {StatBias} statBias - this driver's contribution to the final stats.
 * @property {DriverLook} [look] - procedural driver appearance (Kart.js reads this).
 */

/** @type {Character[]} */
export const CHARACTERS = [
  // ---- LIGHT (4): quick, nimble, low top-end -----------------------------
  {
    id: 'pip',
    name: 'Pip Sparrow',
    color: 0x49c5ff, // sky blue
    weightClass: 'light',
    statBias: { topSpeed: 0.25, accel: 0.85, handling: 0.85, weight: 0.2, traction: 0.7, miniTurbo: 0.8 },
    // Small slim pilot in an aero helmet with a cyan visor.
    look: { helmet: 'aero', helmetScale: 0.92, build: 0.82, accent: 0xffffff, visor: 0x35e0ff },
  },
  {
    id: 'nim',
    name: 'Nimbus Vale',
    color: 0xb388ff, // soft violet
    weightClass: 'light',
    statBias: { topSpeed: 0.3, accel: 0.8, handling: 0.9, weight: 0.25, traction: 0.6, miniTurbo: 0.85 },
    // Slight build, rounded helmet, magenta visor.
    look: { helmet: 'round', helmetScale: 0.95, build: 0.85, accent: 0xe0c6ff, visor: 0xd86bff },
  },
  {
    id: 'clover',
    name: 'Clover Quill',
    color: 0x66e07a, // leaf green
    weightClass: 'light',
    statBias: { topSpeed: 0.2, accel: 0.9, handling: 0.8, weight: 0.15, traction: 0.8, miniTurbo: 0.75 },
    // Tiny build, open visorless cap-style helmet, green-tinted band.
    look: { helmet: 'visorless', helmetScale: 0.9, build: 0.8, accent: 0xc6ffd0, visor: 0x66e07a },
  },
  {
    id: 'zigzag',
    name: 'Zigzag Mott',
    color: 0xffd24a, // electric yellow
    weightClass: 'light',
    // Coin-shop pick: a flashy mini-turbo specialist bought with coins, not wins.
    coinsPrice: 75,
    statBias: { topSpeed: 0.35, accel: 0.78, handling: 0.82, weight: 0.3, traction: 0.55, miniTurbo: 0.9 },
    // Wiry build, crested 'crown' helmet, amber visor.
    look: { helmet: 'crown', helmetScale: 0.95, build: 0.84, accent: 0xfff0b0, visor: 0xffb13a },
  },

  // ---- MEDIUM (3): balanced all-rounders --------------------------------
  {
    id: 'rae',
    name: 'Rae Solano',
    color: 0xff7a3c, // warm orange
    weightClass: 'medium',
    statBias: { topSpeed: 0.5, accel: 0.5, handling: 0.5, weight: 0.5, traction: 0.5, miniTurbo: 0.5 },
    // The neutral build/helmet — exactly the original driver size.
    look: { helmet: 'round', helmetScale: 1.0, build: 1.0, accent: 0xffd0b0, visor: 0xff8a3a },
  },
  {
    id: 'koa',
    name: 'Koa Brightwood',
    color: 0x2ecaa8, // teal
    weightClass: 'medium',
    statBias: { topSpeed: 0.55, accel: 0.5, handling: 0.55, weight: 0.45, traction: 0.6, miniTurbo: 0.5 },
    // Standard build, aero helmet, teal visor.
    look: { helmet: 'aero', helmetScale: 1.0, build: 1.0, accent: 0xb6fff0, visor: 0x2ecaa8 },
  },
  {
    id: 'vera',
    name: 'Vera Cinder',
    color: 0xff5d8f, // hot pink
    weightClass: 'medium',
    // Coin-shop pick: a balanced all-rounder bought with coins.
    coinsPrice: 50,
    statBias: { topSpeed: 0.55, accel: 0.55, handling: 0.45, weight: 0.55, traction: 0.45, miniTurbo: 0.55 },
    // Standard build, crested helmet, pink visor.
    look: { helmet: 'crown', helmetScale: 1.02, build: 1.02, accent: 0xffc6d8, visor: 0xff5d8f },
  },

  // ---- HEAVY (3): top-end bruisers, slow to turn ------------------------
  {
    id: 'bolder',
    name: 'Bartholomew Bolder',
    color: 0x8a5a2b, // bronze brown
    weightClass: 'heavy',
    statBias: { topSpeed: 0.85, accel: 0.25, handling: 0.2, weight: 0.85, traction: 0.5, miniTurbo: 0.3 },
    // Burly build, big rounded dome, warm amber visor.
    look: { helmet: 'round', helmetScale: 1.16, build: 1.28, accent: 0xe0c090, visor: 0xffb45a },
  },
  {
    id: 'magnus',
    name: 'Magnus Tor',
    color: 0x9aa0a6, // gunmetal
    weightClass: 'heavy',
    // Prestige bruiser: the field's top-speed king — earned with 10 race wins.
    unlock: { stat: 'racesWon', threshold: 10 },
    statBias: { topSpeed: 0.9, accel: 0.2, handling: 0.25, weight: 0.9, traction: 0.45, miniTurbo: 0.25 },
    // Biggest, blockiest pilot, large aero helmet, steel-blue visor.
    look: { helmet: 'aero', helmetScale: 1.2, build: 1.34, accent: 0xc6ccd2, visor: 0x6fd0ff },
  },
  {
    id: 'cinderhoof',
    name: 'Greta Cinderhoof',
    color: 0xd23b3b, // deep red
    weightClass: 'heavy',
    // Cup-champion reward driver: a grippy heavy unlocked at 3 cup wins.
    unlock: { stat: 'cupsWon', threshold: 3 },
    statBias: { topSpeed: 0.8, accel: 0.3, handling: 0.25, weight: 0.8, traction: 0.6, miniTurbo: 0.35 },
    // Burly build, crested helmet, red visor.
    look: { helmet: 'crown', helmetScale: 1.16, build: 1.26, accent: 0xffb0b0, visor: 0xff4a4a },
  },
];

/**
 * Look up a character by id. Returns the first character as a safe fallback so
 * a stale/unknown id from a saved selection never crashes the selection flow.
 *
 * @param {string} id - character id.
 * @returns {Character} the matching character, or CHARACTERS[0] if not found.
 */
export function getCharacterById(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}

/**
 * Deterministically pick a character for a racer INDEX, so the 13-kart field
 * gets a spread of different drivers without anyone choosing one. Wraps the
 * roster with modulo. Kart.js uses this (with a phase offset vs the body index)
 * so body archetype and driver look don't move in lockstep across the grid.
 *
 * @param {number} index - non-negative racer index.
 * @returns {Character}
 */
export function getCharacterByIndex(index) {
  const n = CHARACTERS.length;
  // (((i % n) + n) % n) keeps a negative or non-integer index in range.
  const i = ((((index | 0) % n) + n) % n);
  return CHARACTERS[i];
}
