// src/data/playerStats.js
//
// Tiny persistent PLAYER STATS / RECORDS store. One localStorage key, one JSON
// blob, a handful of plain functions — no class hierarchy, no deps. Tracks the
// player's lifetime achievements across sessions:
//   - racesWon      : Grand Prix single races finished 1st.
//   - cupsWon        : Grand Prix cups won as champion.
//   - bestLaps        : { trackId -> fastest lap seconds } (per track).
//   - totals          : { drifts, tricks, coins } lifetime counts.
//   - longestCombo    : best single air-trick style score banked (points).
//   - coinBalance     : spendable coin wallet (earned in races, spent in the coin shop).
//   - bought          : ids of cosmetics purchased in the coin shop (unlock everywhere).
//
// EVERY read goes through getStats(), which merges the stored blob onto fresh
// defaults — so a missing key, corrupt JSON, or a partial older blob all degrade
// to sane defaults instead of throwing. Writes are best-effort (localStorage can
// throw in private mode / when full); failures are swallowed so gameplay never
// breaks over a stat write.

const KEY = 'mk_player_stats_v1';

// A fresh, fully-populated stats object. Returned on a miss/corruption and used
// as the merge base so the shape is always complete.
function defaults() {
  return {
    racesWon: 0,
    cupsWon: 0,
    bestLaps: {},        // trackId -> seconds
    totals: { drifts: 0, tricks: 0, coins: 0 },
    longestCombo: 0,     // best single trick style (points, = style*100)
    coinBalance: 0,      // SPENDABLE coin wallet (separate from lifetime totals.coins)
    bought: [],          // ids of cosmetics bought in the coin shop (unlock everywhere)
    unlockedTier: 0,     // CC LADDER: highest unlocked tier index (0=100cc,1=150cc,2=200cc)
    cupTrophies: {},     // tier id ('easy'|'medium'|'hard') -> 'gold'|'silver'|'bronze' earned
  };
}

// CC-LADDER tier ids, lowest -> highest (100cc / 150cc / 200cc). `unlockedTier`
// indexes this; difficulty ids stay 'easy'|'medium'|'hard' (the AI-tuning CONTRACT).
export const TIER_IDS = ['easy', 'medium', 'hard'];

// Per-RACE placement payout (coins), indexed by (place-1). 1st earns the most; the
// long tail still pays a coin so every finish feeds the shop wallet a little.
const PLACE_COINS = [20, 16, 13, 11, 9, 8, 7, 6, 5, 4, 3, 2, 1];

// Medal rank (higher = better), so a cup trophy only ever UPGRADES, never downgrades.
const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };

// Safe localStorage access — returns null if storage is unavailable.
function read() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage.getItem(KEY) : null;
  } catch (e) {
    return null;
  }
}
function write(str) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, str);
  } catch (e) {
    // best-effort; ignore quota / private-mode failures
  }
}

/**
 * Load the player's stats, merged onto fresh defaults so the shape is always
 * complete and every field is the right type. Never throws.
 * @returns {{racesWon:number, cupsWon:number, bestLaps:Object,
 *            totals:{drifts:number,tricks:number,coins:number}, longestCombo:number}}
 */
export function getStats() {
  const d = defaults();
  const raw = read();
  if (!raw) return d;
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return d; // corrupt JSON -> defaults
  }
  if (!data || typeof data !== 'object') return d;

  if (Number.isFinite(data.racesWon)) d.racesWon = data.racesWon;
  if (Number.isFinite(data.cupsWon)) d.cupsWon = data.cupsWon;
  if (Number.isFinite(data.longestCombo)) d.longestCombo = data.longestCombo;
  if (Number.isFinite(data.coinBalance) && data.coinBalance >= 0) d.coinBalance = data.coinBalance;
  if (Array.isArray(data.bought)) d.bought = data.bought.filter((x) => typeof x === 'string');
  if (Number.isFinite(data.unlockedTier)) {
    d.unlockedTier = Math.max(0, Math.min(TIER_IDS.length - 1, Math.floor(data.unlockedTier)));
  }
  if (data.cupTrophies && typeof data.cupTrophies === 'object') {
    for (const k of TIER_IDS) {
      const m = data.cupTrophies[k];
      if (MEDAL_RANK[m]) d.cupTrophies[k] = m;
    }
  }

  if (data.bestLaps && typeof data.bestLaps === 'object') {
    for (const k in data.bestLaps) {
      const v = data.bestLaps[k];
      if (Number.isFinite(v) && v > 0) d.bestLaps[k] = v;
    }
  }
  if (data.totals && typeof data.totals === 'object') {
    for (const k of ['drifts', 'tricks', 'coins']) {
      if (Number.isFinite(data.totals[k])) d.totals[k] = data.totals[k];
    }
  }
  return d;
}

/** Record a Grand Prix single-race win (player finished 1st). */
export function recordRaceWin() {
  const s = getStats();
  s.racesWon += 1;
  write(JSON.stringify(s));
  return s;
}

/** Record a Grand Prix cup championship win. */
export function recordCupWin() {
  const s = getStats();
  s.cupsWon += 1;
  write(JSON.stringify(s));
  return s;
}

/**
 * Record a lap time for a track, keeping only the fastest.
 * @param {string} trackId  registry key ('circuit'|'oval'|'figure').
 * @param {number} seconds  the lap duration in seconds.
 * @returns {boolean} true if this lap is a NEW best for that track.
 */
export function recordBestLap(trackId, seconds) {
  if (!trackId || !Number.isFinite(seconds) || seconds <= 0) return false;
  const s = getStats();
  const prev = s.bestLaps[trackId];
  if (prev == null || seconds < prev) {
    s.bestLaps[trackId] = seconds;
    write(JSON.stringify(s));
    return true;
  }
  return false;
}

/**
 * Add to the lifetime totals (and bump longestCombo if a bigger one is passed).
 * Call once per race/session with the accumulated counts so localStorage isn't
 * written every frame.
 * @param {{drifts?:number, tricks?:number, coins?:number, longestCombo?:number}} delta
 */
export function addTotals({ drifts = 0, tricks = 0, coins = 0, longestCombo = 0 } = {}) {
  const s = getStats();
  s.totals.drifts += drifts | 0;
  s.totals.tricks += tricks | 0;
  s.totals.coins += coins | 0;
  if ((longestCombo | 0) > s.longestCombo) s.longestCombo = longestCombo | 0;
  write(JSON.stringify(s));
  return s;
}

/**
 * Add earned coins to the SPENDABLE wallet (call once per race with the player's
 * coinsEarned). Mirrors addTotals: safe-parse the delta, swallow write failures.
 * Negative / non-finite deltas are ignored so a bad caller can't drain the purse.
 * @param {number} n  coins to add.
 * @returns {object} the updated stats.
 */
export function addCoins(n) {
  const add = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const s = getStats();
  s.coinBalance += add;
  write(JSON.stringify(s));
  return s;
}

/**
 * Buy a cosmetic in the coin shop. Atomic spend-and-mark: if the item isn't
 * already owned and the wallet can afford `price`, deduct the coins, record the
 * id in `bought` (so isUnlocked() opens it everywhere), and persist.
 * @param {string} id     the cosmetic id (character/body/wheel).
 * @param {number} price  its coinsPrice.
 * @returns {boolean} true if the item is owned afterwards (bought now or already).
 */
export function buyItem(id, price) {
  if (!id) return false;
  const cost = Number.isFinite(price) ? Math.max(0, Math.floor(price)) : 0;
  const s = getStats();
  if (s.bought.includes(id)) return true;   // already owned — nothing to spend
  if (s.coinBalance < cost) return false;    // can't afford — no change
  s.coinBalance -= cost;
  s.bought.push(id);
  write(JSON.stringify(s));
  return true;
}

/** Wipe all stats back to defaults. */
export function resetStats() {
  const d = defaults();
  write(JSON.stringify(d));
  return d;
}

/**
 * Is a cosmetic item available to the player yet? Three kinds of gate:
 *   - `coinsPrice` item   : LOCKED until bought in the coin shop (id in stats.bought).
 *                           The price alone never grants it — owning it does.
 *   - `unlock {stat,thr}` : the named stat must have reached the threshold (race/cup wins).
 *   - neither             : ALWAYS available (the free defaults).
 * PURE — pass getStats() as `stats`. Used by CharacterSelect + the CoinShop to gate picks.
 * @param {{id?:string, coinsPrice?:number, unlock?:{stat:string,threshold:number}}} item
 * @param {Object} stats - a getStats() blob.
 * @returns {boolean}
 */
export function isUnlocked(item, stats) {
  if (!item) return true;
  // Coin-shop item: available only once its id has been bought.
  if (item.coinsPrice != null) {
    return !!(stats && Array.isArray(stats.bought) && stats.bought.includes(item.id));
  }
  const u = item.unlock;
  if (!u) return true;
  return ((stats && stats[u.stat]) ?? 0) >= u.threshold;
}

/**
 * Medal earned for a lap time against a track's target thresholds. PURE — pass
 * TARGET_LAP_TIMES[trackId] from shared/trackData.js.
 * @param {number} seconds  lap time.
 * @param {{gold:number,silver:number,bronze:number}} targets
 * @returns {'gold'|'silver'|'bronze'|null}
 */
export function medalFor(seconds, targets) {
  if (!targets || !Number.isFinite(seconds)) return null;
  if (seconds <= targets.gold) return 'gold';
  if (seconds <= targets.silver) return 'silver';
  if (seconds <= targets.bronze) return 'bronze';
  return null;
}

/**
 * Coins paid out for a finishing PLACE (per race). PURE — no state. Used by the
 * RaceManager to bank a placement bonus into the wallet the tick the race ends.
 * @param {number} place  1-based finish position.
 * @returns {number} coins to award (0 for a bad/non-finite place).
 */
export function coinsForPlace(place) {
  const i = Math.floor(place) - 1;
  if (!Number.isFinite(place) || i < 0) return 0;
  return i < PLACE_COINS.length ? PLACE_COINS[i] : 1;
}

/**
 * Record the cup TROPHY earned at a tier, keeping only the BEST (a later worse run
 * never downgrades a gold to bronze). Best-effort write (mirrors addCoins).
 * @param {('easy'|'medium'|'hard')} tierId
 * @param {('gold'|'silver'|'bronze')} medal
 * @returns {object} the updated stats.
 */
export function recordCupTrophy(tierId, medal) {
  const s = getStats();
  if (!TIER_IDS.includes(tierId) || !MEDAL_RANK[medal]) return s;
  const prev = s.cupTrophies[tierId];
  if (!prev || MEDAL_RANK[medal] > MEDAL_RANK[prev]) {
    s.cupTrophies[tierId] = medal;
    write(JSON.stringify(s));
  }
  return s;
}

/**
 * Raise the unlocked-tier ceiling to (at least) `tierIndex`, clamped to the ladder.
 * Bumped when the player wins a cup, opening the next engine class. Never lowers it.
 * @param {number} tierIndex  the tier index to unlock up to (0..TIER_IDS.length-1).
 * @returns {object} the updated stats.
 */
export function unlockTier(tierIndex) {
  const n = Math.max(0, Math.min(TIER_IDS.length - 1, Math.floor(tierIndex)));
  const s = getStats();
  if (n > s.unlockedTier) {
    s.unlockedTier = n;
    write(JSON.stringify(s));
  }
  return s;
}

// ---------------------------------------------------------------------------
// ACTIVE-TIER SESSION BRIDGE (in-memory, NOT persisted).
// The chosen difficulty/tier for the CURRENT run. DifficultySelect sets it on
// confirm; the cup payout / trophy logic reads it at completion — because the
// difficulty is never threaded into the GrandPrixCup object itself. In-memory is
// enough: a cup is always run within one session.
// ponytail: in-memory bridge; if cups must survive a reload mid-championship,
// thread the difficulty into GrandPrixCup directly instead.
// ---------------------------------------------------------------------------
let _activeTier = 'medium';
export function setActiveTier(difficulty) {
  if (TIER_IDS.includes(difficulty)) _activeTier = difficulty;
}
export function getActiveTier() {
  return _activeTier;
}

// ---------------------------------------------------------------------------
// Runnable self-check (ponytail): `node src/data/playerStats.js`.
// Installs a tiny in-memory localStorage shim (node has none) and round-trips a
// record through every API. NEVER runs in the browser bundle — guarded on the
// absence of `window` AND the presence of a node argv that ends in this file —
// and uses a local assert so no node-only module is statically imported (which
// would break the vite build).
// ---------------------------------------------------------------------------
function demo() {
  if (typeof globalThis.localStorage === 'undefined') {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
  const assert = (cond, msg) => { if (!cond) throw new Error('playerStats demo: ' + msg); };

  resetStats();
  let s = getStats();
  assert(s.racesWon === 0 && s.cupsWon === 0, 'fresh defaults are zero');
  assert(s.totals.coins === 0 && s.longestCombo === 0, 'fresh totals are zero');
  assert(s.coinBalance === 0 && Array.isArray(s.bought) && s.bought.length === 0, 'fresh wallet + no purchases');
  assert(s.unlockedTier === 0 && s.cupTrophies && Object.keys(s.cupTrophies).length === 0, 'fresh ladder: only 100cc unlocked, no trophies');

  recordRaceWin();
  recordCupWin();
  s = getStats();
  assert(s.racesWon === 1 && s.cupsWon === 1, 'win counters increment + persist');

  assert(recordBestLap('circuit', 120) === true, 'first lap is a record');
  assert(recordBestLap('circuit', 130) === false, 'slower lap is not a record');
  assert(recordBestLap('circuit', 99) === true, 'faster lap is a record');
  assert(getStats().bestLaps.circuit === 99, 'best lap kept the fastest');
  assert(recordBestLap('', 50) === false && recordBestLap('oval', -1) === false, 'bad input rejected');

  addTotals({ drifts: 3, tricks: 2, coins: 10, longestCombo: 240 });
  addTotals({ coins: 5, longestCombo: 100 });
  s = getStats();
  assert(s.totals.coins === 15 && s.totals.drifts === 3 && s.totals.tricks === 2, 'totals accumulate');
  assert(s.longestCombo === 240, 'longestCombo keeps the max');

  // Coin WALLET + shop purchases.
  addCoins(50);
  addCoins(25);
  assert(getStats().coinBalance === 75, 'addCoins accumulates the wallet');
  assert(addCoins(-10) && getStats().coinBalance === 75, 'addCoins ignores negatives');
  const shopItem = { id: 'zigzag', coinsPrice: 30 };
  assert(isUnlocked(shopItem, getStats()) === false, 'coin item is locked before purchase');
  assert(buyItem('zigzag', 30) === true, 'affordable purchase succeeds');
  s = getStats();
  assert(s.coinBalance === 45, 'purchase deducts the price');
  assert(s.bought.includes('zigzag'), 'purchase records the bought id');
  assert(isUnlocked(shopItem, s) === true, 'bought coin item is unlocked');
  assert(buyItem('zigzag', 30) === true && getStats().coinBalance === 45, 're-buying an owned item is free');
  assert(buyItem('darter', 9999) === false && getStats().coinBalance === 45, 'unaffordable purchase fails, wallet untouched');

  // Unlocks: no field = always available; threshold gates on a stat.
  s = { racesWon: 3, cupsWon: 0 };
  assert(isUnlocked({}, s) === true, 'no unlock field = always available');
  assert(isUnlocked({ unlock: { stat: 'racesWon', threshold: 3 } }, s) === true, 'met threshold unlocks');
  assert(isUnlocked({ unlock: { stat: 'racesWon', threshold: 5 } }, s) === false, 'unmet threshold stays locked');
  assert(isUnlocked({ unlock: { stat: 'cupsWon', threshold: 1 } }, s) === false, 'missing/zero stat stays locked');

  // Corrupt blob -> defaults, not a throw.
  globalThis.localStorage.setItem(KEY, '{not json');
  assert(getStats().racesWon === 0, 'corrupt JSON degrades to defaults');

  // Medal thresholds.
  const tgt = { gold: 100, silver: 120, bronze: 150 };
  assert(medalFor(95, tgt) === 'gold', 'gold');
  assert(medalFor(110, tgt) === 'silver', 'silver');
  assert(medalFor(140, tgt) === 'bronze', 'bronze');
  assert(medalFor(200, tgt) === null, 'no medal');

  // Placement payout: 1st > 2nd, a deep place still pays, bad input pays nothing.
  assert(coinsForPlace(1) > coinsForPlace(2) && coinsForPlace(2) > coinsForPlace(3), 'placement payout descends');
  assert(coinsForPlace(13) >= 1 && coinsForPlace(0) === 0 && coinsForPlace(NaN) === 0, 'placement payout edges');

  // CC ladder: unlockTier only ever raises, clamps to the top of the ladder.
  resetStats();
  unlockTier(1);
  assert(getStats().unlockedTier === 1, 'unlockTier raises to 150cc');
  unlockTier(0);
  assert(getStats().unlockedTier === 1, 'unlockTier never lowers');
  unlockTier(99);
  assert(getStats().unlockedTier === TIER_IDS.length - 1, 'unlockTier clamps to the top tier');

  // Cup trophies: best-medal-wins, bad inputs ignored.
  resetStats();
  recordCupTrophy('easy', 'bronze');
  assert(getStats().cupTrophies.easy === 'bronze', 'trophy recorded');
  recordCupTrophy('easy', 'gold');
  assert(getStats().cupTrophies.easy === 'gold', 'better trophy upgrades');
  recordCupTrophy('easy', 'silver');
  assert(getStats().cupTrophies.easy === 'gold', 'worse trophy never downgrades');
  recordCupTrophy('bogus', 'gold');
  assert(getStats().cupTrophies.bogus === undefined, 'bad tier ignored');

  // Active-tier session bridge (in-memory).
  setActiveTier('hard');
  assert(getActiveTier() === 'hard', 'active tier set');
  setActiveTier('nope');
  assert(getActiveTier() === 'hard', 'bad active tier ignored');

  console.log('playerStats self-check OK');
}

if (typeof window === 'undefined'
  && typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && process.argv[1].includes('playerStats')) {
  demo();
}
