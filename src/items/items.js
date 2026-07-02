// src/items/items.js
//
// Item DEFINITIONS for the kart racer's item box system.
//
// This file is PURE DATA: a catalog describing every item the game can hand
// out. It contains NO game logic, NO three import, NO DOM — just a map of
// definitions that other systems read:
//   - ItemSystem.js          (this folder) rolls/holds/uses items and reads
//                            `kind` + the triple/global params to build actions.
//   - the projectile system  (owned elsewhere) reads `kind`, `color`, speed and
//                            homing params to spawn the actual meshes.
//   - the HUD                reads `name`/`color`/`description` to draw the
//                            held-item icon and tooltip.
//
// Keeping this as plain data (instead of classes) means the same catalog can be
// shared with a future server and tweaked without touching behavior code.
//
// ---------------------------------------------------------------------------
// THE `kind` FIELD — how ItemSystem decides what happens on use:
//   'projectile' : spawns a moving hazard (shells, bullet bill, blue shell).
//                  Travels forward or backward; may home onto a target.
//   'trap'       : drops a stationary hazard behind/under the kart (banana,
//                  bob-omb, fake box). Just sits there until something hits it.
//   'self'       : applies an effect to the USER's own kart state via a mutator
//                  helper from shared/kartModel.js (mushroom boost, star, etc).
//   'global'     : affects EVERY other kart at once (lightning shrinks the field;
//                  boo steals an item). Handled as a field-wide action.
//
// Params are intentionally per-item and optional; a definition only carries the
// fields its `kind` needs. ItemSystem and the projectile system read what they
// understand and ignore the rest.
// ---------------------------------------------------------------------------

/**
 * The master item catalog, keyed by item id.
 *
 * Common fields on every definition:
 *   id          {string}  stable key (matches the map key; used everywhere).
 *   name        {string}  human label for the HUD.
 *   kind        {string}  'projectile' | 'trap' | 'self' | 'global' (see above).
 *   color       {number}  0xRRGGBB tint for the HUD icon / spawned mesh / sparks.
 *   description {string}  one-line tooltip describing what it does.
 *
 * Behavior params (present only where relevant):
 *   triple      {string}  for the "triple" variants: the SINGLE item id each of
 *                         the three charges fires. ItemSystem expands a triple
 *                         into a queue of `count` single uses.
 *   count       {number}  how many charges a multi-use item grants when given.
 *   forward     {boolean} projectile travel direction (true = ahead, false = behind).
 *   homing      {boolean} projectile seeks the kart ahead of the user.
 *   speed       {number}  m/s travel speed hint for the projectile system.
 *   targetsLeader {boolean} projectile flies straight to the race LEADER (blue shell).
 *   spinSecs    {number}  seconds of spin-out inflicted on a kart it hits.
 *   boost       {boolean} grants the user a speed surge (mushroom family).
 *   starSecs    {number}  seconds of star invincibility granted to the user.
 *   shrinkSecs  {number}  seconds the lightning shrinks every rival.
 *   global      {string}  'lightning' | 'boo' — the field-wide effect to run.
 */
export const ITEMS = {
  // --- GREEN SHELL: fires straight, no homing. Bounces off walls, spins out
  //     whatever it touches. The bread-and-butter offensive item. ----------
  greenShell: {
    id: 'greenShell',
    name: 'Green Shell',
    kind: 'projectile',
    color: 0x22cc44,
    icon: '🐢', // shell emoji (green) — the HUD draws this in the item slot
    description: 'Fires straight ahead and spins out the first kart it hits.',
    forward: true,
    homing: false,
    speed: 58, // missile-fast: above kart top speed (MAX_SPEED 44 * 1.15 ≈ 50.6). Server reads this; client SHELL_SPEED matches.
    spinSecs: 1.8, // strong stop — matches EFFECTS.SPIN_DURATION so a clean hit halts the victim
  },

  // --- RED SHELL: homing. Locks onto the kart directly ahead and chases it. -
  redShell: {
    id: 'redShell',
    name: 'Red Shell',
    kind: 'projectile',
    color: 0xdd2222,
    icon: '🔴', // red circle reads as the homing red shell at HUD size
    description: 'Homes in on the racer ahead and spins them out.',
    forward: true,
    homing: true,
    speed: 58, // missile-fast homing: outruns any kart so it's hard to dodge. Matches client SHELL_SPEED.
    spinSecs: 1.8, // strong stop — a tracked hit reliably halts the target
  },

  // --- TRIPLE GREEN: three green shells that orbit the kart, fired one at a
  //     time. Expands into a queue of 3 single greenShell uses. -------------
  tripleGreen: {
    id: 'tripleGreen',
    name: 'Triple Green Shells',
    kind: 'projectile',
    color: 0x22cc44,
    icon: '🐢', // base shell emoji; HUD adds a ×N badge from the held count
    description: 'Three green shells you can fire one after another.',
    triple: 'greenShell', // each charge behaves like a single green shell
    count: 3,
    forward: true,
    homing: false,
    speed: 58, // matches the single greenShell missile speed
    spinSecs: 1.8, // matches the single greenShell stop strength
  },

  // --- TRIPLE RED: three homing red shells, fired one at a time. -----------
  tripleRed: {
    id: 'tripleRed',
    name: 'Triple Red Shells',
    kind: 'projectile',
    color: 0xdd2222,
    icon: '🔴', // base red shell emoji; HUD adds a ×N badge from the held count
    description: 'Three homing red shells you can fire one after another.',
    triple: 'redShell', // each charge behaves like a single red shell
    count: 3,
    forward: true,
    homing: true,
    speed: 58, // matches the single redShell missile speed
    spinSecs: 1.8, // matches the single redShell stop strength
  },

  // --- BANANA: dropped behind the kart. Stationary; spins out anyone who
  //     drives over it. Classic defensive trap. ----------------------------
  banana: {
    id: 'banana',
    name: 'Banana',
    kind: 'trap',
    color: 0xeedd22,
    icon: '🍌', // banana emoji — the classic drop-behind trap
    description: 'Drop behind you; spins out any kart that drives over it.',
    forward: false, // drops behind the user
    spinSecs: 1.5, // a banana hit is a solid spin (a touch shorter than a direct shell)
  },

  // --- TRIPLE BANANA: three bananas dropped one at a time (or trailing). ----
  tripleBanana: {
    id: 'tripleBanana',
    name: 'Triple Bananas',
    kind: 'trap',
    color: 0xeedd22,
    icon: '🍌', // base banana emoji; HUD adds a ×N badge from the held count
    description: 'Three bananas you can drop one after another.',
    triple: 'banana', // each charge drops a single banana
    count: 3,
    forward: false,
    spinSecs: 1.5, // matches the single banana stop strength
  },

  // --- MUSHROOM: instant self speed boost (a mini-turbo-like surge). -------
  mushroom: {
    id: 'mushroom',
    name: 'Mushroom',
    kind: 'self',
    color: 0xff5533,
    icon: '🍄', // mushroom emoji — the speed-boost item
    description: 'A quick burst of speed.',
    boost: true,
  },

  // --- TRIPLE MUSHROOM: three boosts, used one at a time. -----------------
  tripleMushroom: {
    id: 'tripleMushroom',
    name: 'Triple Mushrooms',
    kind: 'self',
    color: 0xff5533,
    icon: '🍄', // base mushroom emoji; HUD adds a ×N badge from the held count
    description: 'Three speed bursts you can use one after another.',
    triple: 'mushroom', // each charge is a single mushroom boost
    count: 3,
    boost: true,
  },

  // --- GOLDEN MUSHROOM: many rapid boosts for a short window. Modeled here
  //     as a large queue of mushroom boosts (count tuned for ~spammable feel). -
  goldenMushroom: {
    id: 'goldenMushroom',
    name: 'Golden Mushroom',
    kind: 'self',
    color: 0xffcc22,
    icon: '🌟', // glowing star reads as the special golden mushroom
    description: 'Rapid-fire speed boosts for a short time.',
    triple: 'mushroom', // each charge is a single mushroom boost
    count: 8, // many charges -> feels like spammable golden mushroom
    boost: true,
  },

  // --- STAR: temporary invincibility + speed bump. Cannot be spun while
  //     active; bumping rivals spins THEM out (projectile system handles
  //     the contact side). Self effect that arms starTimer. ----------------
  star: {
    id: 'star',
    name: 'Star',
    kind: 'self',
    color: 0xffee44,
    icon: '⭐', // star emoji — the invincibility item
    description: 'Brief invincibility and a speed boost.',
    starSecs: 7, // seconds of star invincibility
  },

  // --- LIGHTNING: GLOBAL. Shrinks and slows every OTHER kart for a while. ---
  lightning: {
    id: 'lightning',
    name: 'Lightning',
    kind: 'global',
    color: 0x66ddff,
    icon: '⚡', // lightning-bolt emoji — the field-wide shrink item
    description: 'Shrinks and slows every other racer.',
    global: 'lightning',
    shrinkSecs: 6, // seconds rivals stay shrunk/slowed
  },

  // --- BULLET BILL: GLOBAL-ish self auto-pilot rocket. Modeled as a strong
  //     forward projectile the user "rides": big speed, plows through karts.
  //     Kept as a projectile descriptor so the projectile system can drive the
  //     user along it; spins out anyone in the path. Back-of-pack only. -----
  bulletBill: {
    id: 'bulletBill',
    name: 'Bullet Bill',
    kind: 'projectile',
    color: 0x223344,
    icon: '🚀', // rocket emoji — the autopilot bullet you ride
    description: 'Rocket forward on autopilot, plowing through rivals.',
    forward: true,
    homing: false, // follows the track, not a single target
    ridesUser: true, // the projectile system carries the user along it
    speed: 55,
    spinSecs: 1.8, // plows rivals with a full-strength spin as it rockets through
  },

  // --- BLUE SHELL (SPINY): targets the race LEADER specifically, ignoring
  //     everyone in between, and spins them out. Back-of-pack equalizer. ----
  blueShell: {
    id: 'blueShell',
    name: 'Blue Shell',
    kind: 'projectile',
    color: 0x2244ee,
    icon: '🐚', // spiral-shell emoji — the leader-seeking blue shell
    description: 'Flies to the race leader and spins them out.',
    forward: true,
    homing: true,
    targetsLeader: true, // ignores nearby karts, seeks the standings leader
    speed: 50,
    spinSecs: 2.0, // longer spin than a normal shell
  },

  // --- BOB-OMB: dropped/thrown trap that explodes, spinning out anyone in a
  //     radius. The projectile system reads `blastRadius` for the explosion. -
  bobOmb: {
    id: 'bobOmb',
    name: 'Bob-omb',
    kind: 'trap',
    color: 0x111111,
    icon: '💣', // bomb emoji — the explosive blast-radius trap
    description: 'Drops an explosive that spins out karts in a blast radius.',
    forward: false,
    blastRadius: 6, // m  explosion radius for the projectile system
    spinSecs: 1.8,
  },

  // --- FAKE ITEM BOX: a decoy that looks like an item box; spins out anyone
  //     who grabs it. Stationary trap, dropped behind. --------------------
  fakeBox: {
    id: 'fakeBox',
    name: 'Fake Item Box',
    kind: 'trap',
    color: 0x99662e,
    icon: '🎁', // gift box — the decoy item box (distinct from the ❓ mystery box)
    description: 'A decoy item box that spins out whoever touches it.',
    forward: false,
    spinSecs: 1.5, // a fake-box grab is a solid spin, like a banana
  },

  // --- SUPER HORN: short-range shockwave that spins nearby karts AND can
  //     destroy an incoming blue shell. Modeled as a self/area pulse; the
  //     projectile system reads `pulseRadius` to resolve hits. ------------
  superHorn: {
    id: 'superHorn',
    name: 'Super Horn',
    kind: 'self',
    color: 0xffaa00,
    icon: '📯', // horn emoji — the shockwave-pulse item
    description: 'A shockwave that knocks back karts and destroys a blue shell.',
    pulse: true, // area shockwave (projectile system resolves the area)
    pulseRadius: 7, // m  radius of the shockwave
    spinSecs: 1.0,
  },

  // --- COIN: weak filler. Adds a coin to the user's count (each coin gives a
  //     small flat top-speed bonus, capped at 10 by the kart model). The most
  //     common item for front-runners. ------------------------------------
  coin: {
    id: 'coin',
    name: 'Coin',
    kind: 'self',
    color: 0xffd700,
    icon: '🪙', // coin emoji — the weak filler item
    description: 'Adds a coin for a small permanent top-speed bonus.',
    coin: true,
  },

  // --- BOO: GLOBAL. Turns the user briefly invincible (star-like ghost) AND
  //     steals a random rival's item. The steal is resolved by the field-wide
  //     action; here we also give the user a brief star window so the ghost
  //     phase feels safe. -------------------------------------------------
  boo: {
    id: 'boo',
    name: 'Boo',
    kind: 'global',
    color: 0xddddff,
    icon: '👻', // ghost emoji — the ghost-and-steal item
    description: 'Go ghostly for a moment and steal a rival\'s item.',
    global: 'boo',
    starSecs: 3, // brief invincible ghost window for the user
  },
};

/**
 * Convenience: look up a definition by id. Returns undefined for unknown ids
 * (callers should treat that as "no item"). Kept tiny so other modules don't
 * have to import the whole map just to resolve one id.
 *
 * @param {string} id - item id (e.g. 'redShell').
 * @returns {object|undefined} the item definition, or undefined if not found.
 */
export function getItem(id) {
  return ITEMS[id];
}
