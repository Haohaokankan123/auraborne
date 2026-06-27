// src/items/ItemSystem.js
//
// The ITEM SYSTEM: rolls items from item boxes, holds them per racer, and turns
// a "use item" press into an ACTION descriptor for the RaceManager to execute.
//
// What this module DOES:
//   - rollItem(rank, totalRacers): position-weighted random draw (front-runners
//     get weak items, back-runners get strong ones — the Mario-Kart "catch-up"
//     idea, see the weight tables below).
//   - giveItem / getHeld / hasItem / clear: per-racer "currently holding" slot,
//     with a small queue so triples (and the golden mushroom) fire one charge at
//     a time.
//   - useItem(racerId, userState, context): consumes one held charge and returns
//     a descriptor like { kind:'projectile', item:'redShell', homing:true } or
//     { kind:'self', apply:(state)=>... }. It does NOT spawn meshes or mutate
//     other karts directly — the RaceManager / projectile system does that.
//
// What this module does NOT do:
//   - No THREE, no DOM, no mesh spawning (that's the projectile system).
//   - No direct mutation of OTHER karts (RaceManager applies global actions).
//   - The ONLY state it mutates directly is the USER's own kart, and only via
//     the pure mutator helpers imported from shared/kartModel.js.
//
// Randomness lives HERE (not in the shared model) on purpose: the shared kart
// model must stay deterministic, but item drops are allowed to be random. A
// seedable RNG can be injected via opts.rng so a server could reproduce draws.

// Pure mutator helpers from the shared kart model. We import only the ones a
// 'self'/'global' action applies HERE. Spin/contact effects (applySpin) are
// applied by the projectile/RaceManager layer from the descriptors we return,
// so applySpin is intentionally NOT imported in this file.
import {
  applyMushroomBoost,
  applyStar,
  applyShrink,
  addCoin,
} from '../../shared/kartModel.js';
import { ITEMS, getItem } from './items.js';

// ---------------------------------------------------------------------------
// POSITION-WEIGHTED DISTRIBUTION
// ---------------------------------------------------------------------------
// Mario Kart hands out items based on how far BACK you are: the idea is roughly
// "distance from the leader" — the further behind, the better your odds at a
// strong, race-changing item, while the leader is stuck with weak/defensive
// stuff. We approximate that with a normalized position p = rank / (N-1) in
// [0,1], where 0 = leader (1st place) and 1 = dead last, then bucket into three
// brackets and use a weight table per bracket.
//
// Each table maps item id -> relative weight (any positive number; they don't
// need to sum to 1, rollItem normalizes them). Higher weight = more likely.
//
// Design rules baked into the tables:
//   - FRONT (leader & near-leaders): coins, bananas, green shells, the odd
//     mushroom. Defensive/weak. The leader can get blue-shell-AVOIDANCE items
//     (super horn) but NEVER bulletBill or blueShell (you don't hand the
//     leader the catch-up nukes).
//   - MID: a balanced spread — red shells, triples, mushrooms, the occasional
//     star. Some offense, some defense.
//   - BACK: the strong stuff — star, bulletBill, blueShell, tripleRed,
//     lightning, golden mushroom. This is where comebacks come from.
// ---------------------------------------------------------------------------

// FRONT bracket (top of the pack, p < ~0.33). Weak & defensive only.
// REBALANCED: the old table handed the leader a 30-weight COIN a third of the time
// — a near-dead pull that left them with no answer to an incoming blue shell. Coin
// is trimmed (~30 -> 12) and that weight redistributed into USABLE leader defense:
// more bananas / green shells / fake boxes to guard the line, and a much higher
// superHorn (3 -> 7) so blue-shell COUNTERPLAY is actually reachable up front. The
// total weight is held ~constant so MID/BACK odds are untouched. Still deliberately
// NO bulletBill / blueShell / lightning / star here (never hand the leader a nuke).
const WEIGHTS_FRONT = {
  coin: 12, // trimmed filler — the leader now usually draws something usable
  banana: 24, // drop-behind defense (primary leader tool)
  greenShell: 20, // straight shot, no homing
  fakeBox: 8, // decoy box to bait pursuers
  superHorn: 7, // blue-shell counterplay — reachable now, allowed even for the leader
  tripleBanana: 7,
  tripleGreen: 6,
  mushroom: 6, // a small boost is OK up front
  boo: 2, // rare item-steal up front
  // NOTE: deliberately NO bulletBill / blueShell / lightning / star here.
};

// MID bracket (the middle of the pack, ~0.33 <= p < ~0.66). Balanced spread.
const WEIGHTS_MID = {
  greenShell: 12,
  redShell: 14, // homing offense becomes common in the midfield
  banana: 10,
  tripleGreen: 8,
  tripleRed: 7,
  mushroom: 10,
  tripleMushroom: 6,
  fakeBox: 5,
  bobOmb: 5,
  star: 4, // occasional star to fight back
  superHorn: 4,
  coin: 6, // still some filler
  boo: 4,
};

// BACK bracket (the rear of the pack, p >= ~0.66). The strong, race-changing items.
const WEIGHTS_BACK = {
  redShell: 8,
  tripleRed: 12, // strong homing offense for the back
  tripleMushroom: 10, // big catch-up speed
  goldenMushroom: 9, // spammable boosts
  star: 12, // invincible comeback
  bulletBill: 11, // back-of-pack ONLY (auto-pilot rocket)
  blueShell: 8, // back-of-pack ONLY (leader equalizer)
  lightning: 7, // shrink the whole field
  bobOmb: 5,
  mushroom: 6,
};

// Bracket cut points on normalized position p (0 = leader, 1 = last).
// Tuned so a 13-kart grid splits roughly 1-4 / 5-9 / 10-13.
const FRONT_MAX_P = 0.33; // p below this -> FRONT bracket
const MID_MAX_P = 0.66; // p below this (and >= FRONT_MAX_P) -> MID bracket
// p at or above MID_MAX_P -> BACK bracket.

export class ItemSystem {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.rng] - returns a float in [0,1). Defaults to
   *        Math.random. Inject a seeded RNG to make drops reproducible (e.g. on
   *        a server). Only rollItem uses randomness.
   */
  constructor(opts = {}) {
    // RNG is injectable so item draws can be made deterministic if needed.
    this.rng = opts.rng || Math.random;

    // Per-racer held items: a fixed THREE-SLOT inventory. Map<racerId, Array(3)>
    // where each slot is either null (empty) or a record { id, count }:
    //   id    - the item id held in that slot
    //   count - charges remaining (1 for singles; 3 for triples; N for golden)
    // giveItem fills the next empty slot (cap 3); useItem fires a RANDOM filled
    // slot (via this.rng so client + server agree). Absent key == empty inventory.
    this.held = new Map();
  }

  // How many distinct item slots each racer carries at once.
  static get MAX_SLOTS() { return 3; }

  // ------------------------------------------------------------------------
  // ROLLING
  // ------------------------------------------------------------------------

  /**
   * Pick the weight table for a given finishing position.
   *
   * @param {number} rank        0-based race position (0 = 1st place leader).
   * @param {number} totalRacers number of racers in the field (>= 1).
   * @returns {object} one of WEIGHTS_FRONT / WEIGHTS_MID / WEIGHTS_BACK.
   * @private
   */
  _tableFor(rank, totalRacers) {
    // Normalize position to [0,1]: 0 = leader, 1 = last. Guard the single-racer
    // case (totalRacers <= 1) so we don't divide by zero — a lone racer is the
    // leader, so treat them as FRONT.
    const denom = Math.max(totalRacers - 1, 1);
    const p = Math.min(Math.max(rank, 0), denom) / denom;

    if (p < FRONT_MAX_P) return WEIGHTS_FRONT;
    if (p < MID_MAX_P) return WEIGHTS_MID;
    return WEIGHTS_BACK;
  }

  /**
   * Roll a random item id using the position-weighted table for `rank`.
   *
   * @param {number} rank        0-based race position (0 = 1st). Lower = better
   *                             placed -> weaker items.
   * @param {number} totalRacers size of the field.
   * @returns {string} an item id from ITEMS (e.g. 'redShell', 'coin').
   *
   * Weighted pick: sum all weights in the bracket table, draw a uniform value in
   * [0, total), then walk the entries subtracting weights until we cross the
   * value — the entry we land on is the result. This makes higher-weight items
   * proportionally more likely without any per-item probability bookkeeping.
   */
  rollItem(rank, totalRacers) {
    const table = this._tableFor(rank, totalRacers);
    const ids = Object.keys(table);

    // Sum of all relative weights in this bracket.
    let total = 0;
    for (const id of ids) total += table[id];

    // Draw a point in [0, total) and find which item's slice it falls in.
    let r = this.rng() * total;
    for (const id of ids) {
      r -= table[id];
      if (r < 0) return id;
    }

    // Floating-point safety net: if rounding left us at the very end, return the
    // last id. (Practically unreachable, but avoids ever returning undefined.)
    return ids[ids.length - 1];
  }

  // ------------------------------------------------------------------------
  // HOLDING  (per-racer slot + triple queue)
  // ------------------------------------------------------------------------

  /**
   * Give a racer an item, filling the NEXT EMPTY slot (up to MAX_SLOTS). When the
   * inventory is already full the pickup is ignored. Triples/golden occupy one
   * slot with a `count` so that slot fires one charge per use.
   *
   * @param {string} racerId
   * @param {string} itemId  must be a key in ITEMS.
   */
  giveItem(racerId, itemId) {
    const def = getItem(itemId);
    if (!def) return; // unknown id -> ignore (defensive; should not happen)

    let slots = this.held.get(racerId);
    if (!slots) {
      slots = new Array(ItemSystem.MAX_SLOTS).fill(null);
      this.held.set(racerId, slots);
    }
    // `count` defaults to 1; triples and the golden mushroom carry their own.
    const count = def.count || 1;
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i]) {
        slots[i] = { id: itemId, count };
        return;
      }
    }
    // ponytail: all 3 slots full -> drop the pickup. Mario-Kart caps the hand too.
  }

  /**
   * What is this racer holding? Returns the FIRST filled slot as the "active"
   * record so existing single-slot callers (HUD descriptor, orbit/shield mirror,
   * AI context, Boo steal) keep working unchanged. Use getSlots() for the full
   * three-slot view.
   *
   * @param {string} racerId
   * @returns {{ id: string, count: number } | null} the active record, or null.
   */
  getHeld(racerId) {
    const slots = this.held.get(racerId);
    if (!slots) return null;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) return slots[i];
    }
    return null;
  }

  /**
   * The full three-slot inventory for a racer, as a copy safe for the HUD to read
   * (each entry is { id, count } or null). Always returns a MAX_SLOTS-long array.
   *
   * @param {string} racerId
   * @returns {Array<{ id:string, count:number }|null>}
   */
  getSlots(racerId) {
    const slots = this.held.get(racerId);
    const out = new Array(ItemSystem.MAX_SLOTS).fill(null);
    if (!slots) return out;
    for (let i = 0; i < slots.length && i < out.length; i++) {
      if (slots[i]) out[i] = { id: slots[i].id, count: slots[i].count };
    }
    return out;
  }

  /**
   * Does this racer hold an item in ANY slot?
   *
   * @param {string} racerId
   * @returns {boolean}
   */
  hasItem(racerId) {
    const slots = this.held.get(racerId);
    if (!slots) return false;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) return true;
    }
    return false;
  }

  /**
   * Is there an EMPTY slot to collect another item into? Box pickups gate on this
   * (not hasItem) so a racer can hold up to MAX_SLOTS items, not just one.
   *
   * @param {string} racerId
   * @returns {boolean}
   */
  hasFreeSlot(racerId) {
    const slots = this.held.get(racerId);
    if (!slots) return true; // no inventory yet -> all slots free
    for (let i = 0; i < slots.length; i++) {
      if (!slots[i]) return true;
    }
    return false;
  }

  /**
   * Drop EVERYTHING a racer is holding (e.g. after a Boo steal, a respawn, or a
   * shield break). Empties all slots.
   *
   * @param {string} racerId
   */
  clear(racerId) {
    this.held.delete(racerId);
  }

  // ------------------------------------------------------------------------
  // USING  ->  returns an ACTION descriptor for the RaceManager
  // ------------------------------------------------------------------------

  /**
   * Use one charge of the racer's held item.
   *
   * Decrements the held charge (clearing the slot when the last charge is spent)
   * and returns an ACTION descriptor telling the RaceManager what to do. This
   * method never spawns meshes and never touches other karts — for 'self' items
   * it only closes over a mutator helper that the RaceManager calls on the
   * appropriate state.
   *
   * @param {string} racerId
   * @param {object} userState  the USER's kart state (passed through for context;
   *                            self actions are applied by the caller, not here).
   * @param {object} [context]  optional race context the RaceManager may need,
   *                            e.g. { standings, rank, totalRacers }. Passed back
   *                            inside global descriptors so the executor has it.
   * @returns {object|null} an action descriptor, or null if nothing was held.
   *
   * Descriptor shapes (by item kind):
   *   projectile : { kind:'projectile', item, forward, homing,
   *                  targetsLeader?, speed, spinSecs, ridesUser? }
   *   trap       : { kind:'trap', item, forward, spinSecs, blastRadius? }
   *   self       : { kind:'self', item, apply:(state)=>... }
   *   global     : { kind:'global', item, apply:(allKarts, exceptId)=>...,
   *                  context }
   */
  useItem(racerId, userState, context = {}) {
    const slots = this.held.get(racerId);
    if (!slots) return null; // nothing to use

    // Gather the indices of filled slots (slot order is deterministic: 0,1,2).
    const filled = [];
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) filled.push(i);
    }
    if (!filled.length) return null;

    // Pick a RANDOM filled slot via the injected rng (NOT Math.random) so a server
    // and a client driven by the same seed fire the SAME slot — the parity hinge.
    const pick = filled[Math.min(filled.length - 1, Math.floor(this.rng() * filled.length))];
    const record = slots[pick];

    const def = getItem(record.id);
    if (!def) {
      // Slot held an id with no definition (shouldn't happen): empty it and bail.
      slots[pick] = null;
      if (this._isEmpty(slots)) this.held.delete(racerId);
      return null;
    }

    // Spend ONE charge from the picked slot. Triples/golden keep the slot until
    // their count hits 0; singles empty the slot on the first use.
    record.count -= 1;
    if (record.count <= 0) slots[pick] = null;
    if (this._isEmpty(slots)) this.held.delete(racerId);

    // For multi-use items the firing behavior is the SINGLE variant (def.triple
    // names it); for everything else the item fires as itself.
    const fireId = def.triple || def.id;
    const fireDef = getItem(fireId) || def;

    return this._buildAction(fireDef, userState, context);
  }

  /** @returns {boolean} true if every slot in the array is empty. @private */
  _isEmpty(slots) {
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) return false;
    }
    return true;
  }

  /**
   * Translate one item definition into an executable action descriptor.
   * Split out from useItem so the queue/charge bookkeeping stays readable.
   *
   * @param {object} def        the (single-use) item definition to fire.
   * @param {object} userState  the user's kart state (context for the caller).
   * @param {object} context    race context to forward to global actions.
   * @returns {object} action descriptor (see useItem doc for shapes).
   * @private
   */
  _buildAction(def, userState, context) {
    switch (def.kind) {
      // --- PROJECTILE: hand the projectile system everything it needs to spawn
      //     and steer the hazard. We pass params straight through from the def. -
      case 'projectile':
        return {
          kind: 'projectile',
          item: def.id,
          forward: def.forward !== false, // default to firing ahead
          homing: !!def.homing,
          targetsLeader: !!def.targetsLeader, // blue shell flies to the leader
          ridesUser: !!def.ridesUser, // bullet bill carries the user
          speed: def.speed,
          spinSecs: def.spinSecs,
        };

      // --- TRAP: a stationary hazard dropped relative to the kart. ----------
      case 'trap':
        return {
          kind: 'trap',
          item: def.id,
          forward: def.forward !== false, // most traps drop BEHIND (forward:false)
          spinSecs: def.spinSecs,
          blastRadius: def.blastRadius, // bob-omb only; undefined otherwise
        };

      // --- SELF: closes over the right pure mutator from kartModel.js. The
      //     RaceManager calls action.apply(userState) to mutate the user. We
      //     pick the mutator by which param the definition carries. ----------
      case 'self':
        return {
          kind: 'self',
          item: def.id,
          apply: this._selfMutator(def),
        };

      // --- GLOBAL: a field-wide effect. apply(allKarts, exceptId) lets the
      //     RaceManager walk every OTHER kart. We also forward `context` (e.g.
      //     standings) so a Boo steal can find a victim. ---------------------
      case 'global':
        return {
          kind: 'global',
          item: def.id,
          context,
          apply: this._globalMutator(def),
        };

      // Defensive default: an unknown kind becomes a no-op self action so the
      // caller never crashes on a malformed definition.
      default:
        return { kind: 'self', item: def.id, apply: () => {} };
    }
  }

  /**
   * Build the apply(state) function for a 'self' item, choosing the pure mutator
   * from shared/kartModel.js that matches the definition's effect param.
   *
   * @param {object} def - a 'self' item definition.
   * @returns {(state: object) => void} mutator the caller runs on the user state.
   * @private
   */
  _selfMutator(def) {
    if (def.boost) {
      // Mushroom family: instant speed surge.
      return (state) => applyMushroomBoost(state);
    }
    if (def.starSecs) {
      // Star: invincibility + speed bump for starSecs seconds.
      return (state) => applyStar(state, def.starSecs);
    }
    if (def.coin) {
      // Coin: bump the coin count (kart model caps it and applies the bonus).
      return (state) => addCoin(state);
    }
    if (def.pulse) {
      // Super horn: the area shockwave itself is resolved by the projectile/
      // RaceManager layer (it needs to see other karts); the self side is a
      // no-op so the user isn't affected by their own horn.
      return () => {};
    }
    // Unknown self item: do nothing rather than crash.
    return () => {};
  }

  /**
   * Build the apply(allKarts, exceptId) function for a 'global' item.
   *
   * @param {object} def - a 'global' item definition.
   * @returns {(allKarts: object, exceptId: string) => void} field-wide mutator.
   * @private
   *
   * `allKarts` is expected to be a map/object of racerId -> kart state (the
   * RaceManager owns the real collection; we only iterate it). `exceptId` is the
   * USER, who is never hit by their own global effect.
   */
  _globalMutator(def) {
    if (def.global === 'lightning') {
      // Lightning: shrink+slow EVERY other kart for shrinkSecs seconds. Skips
      // the user and any kart that is currently invincible (a star rider shrugs
      // it off) — invincibility check lives in the kart model so we stay
      // consistent with applyShrink's own guard.
      const secs = def.shrinkSecs;
      return (allKarts, exceptId) => {
        for (const id of Object.keys(allKarts)) {
          if (id === exceptId) continue;
          applyShrink(allKarts[id], secs);
        }
      };
    }

    if (def.global === 'boo') {
      // Boo: give the USER a brief invincible ghost window. The item-STEAL part
      // (taking a random rival's held item) is performed by the RaceManager,
      // because it owns this ItemSystem and can call giveItem/clear on the
      // victim — we can't reach into another racer's slot from inside a single
      // descriptor cleanly. So here we only handle the user's ghost effect; the
      // RaceManager reads action.item === 'boo' to also run the steal.
      const secs = def.starSecs;
      return (allKarts, exceptId) => {
        const me = allKarts[exceptId];
        if (me) applyStar(me, secs);
      };
    }

    // Unknown global: no-op.
    return () => {};
  }
}
