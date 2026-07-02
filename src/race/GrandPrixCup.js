// src/race/GrandPrixCup.js
//
// GRAND PRIX CUP — the championship wrapper around the single-race RaceManager.
//
// A "cup" runs all three circuits back-to-back ('circuit' -> 'oval' -> 'figure'),
// awarding Mario-Kart-style points by finish position each race and crowning the
// racer with the most cumulative points after the third.
//
// This is PLAIN CLIENT LOGIC — no three.js / DOM / Math.random — so it stays
// deterministic and trivially testable. It does NOT run any races itself: main.js
// drives the chain (start a race on currentTrack(), feed the finish order into
// recordRaceResults(), then either advance to nextRace() or show the champion).
//
// It keys everything by the RaceManager's stable racer id ('player' / 'ai1'..),
// which is identical across all three races (same field, same colours, same
// personalities), so points accumulate coherently per racer.
//
// It also OWNS the cup-completion rewards: when the final race is tallied it banks a
// CC-scaled championship coin bonus, records the tier trophy by final standing, and
// opens the next engine class on a win. Those writes go through playerStats (which
// guards localStorage), so this file stays trivially testable — the writes simply
// no-op outside a browser.

import {
  addCoins,
  recordCupTrophy,
  unlockTier,
  getActiveTier,
} from '../data/playerStats.js';

// The fixed cup running order. Three tracks => three races.
const TRACK_ORDER = ['circuit', 'oval', 'figure'];

// Points per FINISH POSITION, indexed by (place - 1): 1st=15 ... 13th=0. Mirrors a
// Mario-Kart 12-place table extended to the 13-kart field with a 0-point tail.
const POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];

// CHAMPIONSHIP COIN PAYOUT by the player's FINAL cup standing, indexed by (place-1).
// This is a separate, bigger reward than the per-race placement coins
// (playerStats.coinsForPlace) — it's the cup bonus, then CC-SCALED below.
const CUP_COINS = [80, 60, 48, 40, 34, 29, 25, 21, 17, 14, 11, 8, 5];

// CC multiplier on the cup bonus by difficulty/tier — a 200cc championship pays
// far more than a 100cc one, so the harder classes are worth chasing.
const CUP_CC_MULT = { easy: 1.0, medium: 1.4, hard: 1.8 };

// Difficulty ids in ladder order (mirrors playerStats.TIER_IDS / AIRacer.CC_TIERS).
// Kept tiny + local so this file imports nothing that drags in THREE.
const TIER_ORDER = ['easy', 'medium', 'hard'];

export class GrandPrixCup {
  /**
   * @param {Object}  [opts]
   * @param {boolean} [opts.persistRewards=true]  false for COUCH/TV cups: the
   *   points/standings machinery is id-keyed and works for N humans as-is, but
   *   the completion rewards (coin bonus, trophy, tier unlock) belong to the
   *   Mac owner's playerStats and must never be written for a phone's finish.
   */
  constructor({ persistRewards = true } = {}) {
    this.persistRewards = persistRewards;
    // The track running order + a 0-based index into it (the current race).
    this.trackOrder = TRACK_ORDER;
    this.raceIndex = 0;

    // racerId -> cumulative cup points across the races run so far.
    this._cumulative = new Map();
    // racerId -> points earned in the MOST RECENT race (for the standings screen).
    this._thisRace = new Map();
    // racerId -> { name, color, isPlayer } display info, captured from results so
    // the standings/champion screens can render without the live RaceManager.
    this._meta = new Map();

    // HEAD-TO-HEAD vs the designated RIVAL (AIRacer slot 3, tagged on each result
    // row): how many of the three races each of you finished ahead. `name` is the
    // rival's display name, captured from the rows.
    this._rivalTally = { playerWins: 0, rivalWins: 0, name: null };

    // CUP-COMPLETE bookkeeping: the banked championship bonus (for the results
    // screen) and a guard so the rewards fire EXACTLY once per championship.
    this._cupBonus = 0;
    this._finalized = false;
  }

  /** (Re)start a fresh championship: back to race 1 with the tallies cleared. */
  start() {
    this.raceIndex = 0;
    this._cumulative.clear();
    this._thisRace.clear();
    this._meta.clear();
    this._rivalTally = { playerWins: 0, rivalWins: 0, name: null };
    this._cupBonus = 0;
    this._finalized = false;
  }

  /** @returns {string} the trackId for the current race. */
  currentTrack() {
    return this.trackOrder[this.raceIndex];
  }

  /** @returns {number} the current race number, 1-based (1..3). */
  raceNumber() {
    return this.raceIndex + 1;
  }

  /** @returns {number} how many races the cup runs (3). */
  totalRaces() {
    return this.trackOrder.length;
  }

  /**
   * Tally one finished race. Adds POINTS[place-1] to each racer's cumulative total
   * and records this-race points + display meta for the standings screen.
   *
   * @param {Array<{place:number, id:string, name:string, color:number|string,
   *                isPlayer:boolean}>} results  RaceManager.getResults(): the
   *   leader-first ranking (place 1 = winner).
   */
  recordRaceResults(results) {
    this._thisRace.clear();
    const list = Array.isArray(results) ? results : [];
    let playerPlace = null;
    let rivalPlace = null;
    for (const r of list) {
      const pts = POINTS[r.place - 1] != null ? POINTS[r.place - 1] : 0;
      this._cumulative.set(r.id, (this._cumulative.get(r.id) || 0) + pts);
      this._thisRace.set(r.id, pts);
      this._meta.set(r.id, { name: r.name, color: r.color, isPlayer: r.isPlayer });
      if (r.isPlayer) playerPlace = r.place;
      if (r.rival) { rivalPlace = r.place; this._rivalTally.name = r.name; }
    }

    // HEAD-TO-HEAD vs the nemesis: who crossed the line ahead THIS race.
    if (playerPlace != null && rivalPlace != null) {
      if (playerPlace < rivalPlace) this._rivalTally.playerWins += 1;
      else this._rivalTally.rivalWins += 1;
    }

    // CUP COMPLETE (this was the final race): bank the championship rewards once.
    if (this.raceIndex >= this.trackOrder.length - 1) this._finalize();
  }

  /**
   * Award the end-of-cup rewards EXACTLY once: a CC-scaled coin bonus for the
   * player's final standing, the tier trophy (gold/silver/bronze by place), and —
   * on a championship WIN — unlocking the next engine class on the ladder. All
   * writes go through playerStats (guarded localStorage), so this is a no-op
   * outside a browser. The difficulty/tier comes from the session bridge set when
   * the player picked their engine class (the cup object isn't threaded difficulty).
   * @private
   */
  _finalize() {
    if (this._finalized) return;
    this._finalized = true;

    // COUCH/TV cup: no local player — skip every playerStats write (coins,
    // trophy, tier unlock). The champion still comes from getStandings().
    if (!this.persistRewards) return;

    const standings = this.getStandings();
    if (!standings.length) return;
    const champion = standings[0];

    // The player's FINAL standing place (1-based), or bail if they're not in the field.
    let place = null;
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].isPlayer) { place = i + 1; break; }
    }
    if (place == null) return;

    const difficulty = getActiveTier();
    const mult = CUP_CC_MULT[difficulty] || 1.0;
    const base = CUP_COINS[place - 1] != null ? CUP_COINS[place - 1] : 5;
    this._cupBonus = Math.round(base * mult);
    addCoins(this._cupBonus);

    // Trophy by final standing (kept best-of in playerStats): 🥇1st / 🥈2nd / 🥉3rd.
    const medal = place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : null;
    if (medal) recordCupTrophy(difficulty, medal);

    // WIN -> open the next engine class up the ladder.
    if (champion.isPlayer) {
      const tierIdx = TIER_ORDER.indexOf(difficulty);
      if (tierIdx >= 0) unlockTier(tierIdx + 1);
    }
  }

  /**
   * @returns {{playerWins:number, rivalWins:number, name:string|null}} the running
   *   head-to-head tally vs the rival across the cup's races so far (a copy).
   */
  getRivalTally() {
    return { ...this._rivalTally };
  }

  /** @returns {number} the championship coin bonus banked at completion (0 until). */
  getCupBonus() {
    return this._cupBonus || 0;
  }

  /**
   * @returns {boolean} true once the FINAL race has been run (we're on the last
   *   index). Call after recordRaceResults to decide standings-vs-champion.
   */
  isComplete() {
    return this.raceIndex >= this.trackOrder.length - 1;
  }

  /** Advance to the next race (no-op past the last). @returns {string} new track. */
  nextRace() {
    if (this.raceIndex < this.trackOrder.length - 1) this.raceIndex++;
    return this.currentTrack();
  }

  /**
   * Current standings, sorted by cumulative points (highest first). Ties break by
   * this-race points then id, so the order is stable + deterministic.
   *
   * @returns {Array<{id:string, name:string, color:number|string, isPlayer:boolean,
   *                  cumulativePoints:number, thisRacePoints:number}>}
   */
  getStandings() {
    const rows = [];
    for (const [id, meta] of this._meta) {
      rows.push({
        id,
        name: meta.name,
        color: meta.color,
        isPlayer: meta.isPlayer,
        cumulativePoints: this._cumulative.get(id) || 0,
        thisRacePoints: this._thisRace.get(id) || 0,
      });
    }
    rows.sort((a, b) =>
      b.cumulativePoints - a.cumulativePoints ||
      b.thisRacePoints - a.thisRacePoints ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    return rows;
  }

  /** @returns {object|null} the standings leader (the champion), or null if empty. */
  getChampion() {
    const s = this.getStandings();
    return s.length ? s[0] : null;
  }
}

// ---------------------------------------------------------------------------
// Runnable self-check (ponytail): `node src/race/GrandPrixCup.js`.
// Exercises the points tally, the rival head-to-head, and the once-only cup
// finalize (the playerStats writes no-op outside a browser, so the bonus is still
// COMPUTED but nothing persists). Guarded so it never runs in the vite bundle.
// ---------------------------------------------------------------------------
function demo() {
  const assert = (cond, msg) => { if (!cond) throw new Error('GrandPrixCup demo: ' + msg); };
  const cup = new GrandPrixCup();
  cup.start();

  // Race 1: rival (VEX) leads the player.
  cup.recordRaceResults([
    { place: 1, id: 'ai3', name: 'VEX', isPlayer: false, rival: true },
    { place: 2, id: 'player', name: 'YOU', isPlayer: true },
  ]);
  assert(cup.getRivalTally().rivalWins === 1 && cup.getRivalTally().playerWins === 0, 'rival led race 1');
  assert(cup.getRivalTally().name === 'VEX', 'rival name captured');
  assert(!cup._finalized, 'not finalized mid-cup');

  // Race 2: player takes it back.
  cup.nextRace();
  cup.recordRaceResults([
    { place: 1, id: 'player', name: 'YOU', isPlayer: true },
    { place: 3, id: 'ai3', name: 'VEX', isPlayer: false, rival: true },
  ]);
  assert(cup.getRivalTally().playerWins === 1 && cup.getRivalTally().rivalWins === 1, 'tied after race 2');

  // Race 3 (final): player wins -> finalize fires once + banks a bonus.
  cup.nextRace();
  cup.recordRaceResults([
    { place: 1, id: 'player', name: 'YOU', isPlayer: true },
    { place: 2, id: 'ai3', name: 'VEX', isPlayer: false, rival: true },
  ]);
  assert(cup._finalized && cup.getCupBonus() > 0, 'cup finalized + bonus computed');
  assert(cup.getRivalTally().playerWins === 2 && cup.getRivalTally().rivalWins === 1, 'player leads 2-1');
  const champ = cup.getChampion();
  assert(champ && champ.isPlayer, 'player is champion on points');

  // Idempotent: tallying again on the final index must NOT re-finalize.
  const bonus = cup.getCupBonus();
  cup.recordRaceResults([{ place: 1, id: 'player', name: 'YOU', isPlayer: true }]);
  assert(cup.getCupBonus() === bonus, 'finalize is idempotent');

  console.log('GrandPrixCup self-check OK');
}

if (typeof window === 'undefined'
  && typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && process.argv[1].includes('GrandPrixCup')) {
  demo();
}
