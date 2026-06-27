// src/race/LapSystem.js
//
// Lap, checkpoint, and race-position tracking for the closed-loop circuit.
//
// This module is PURE LOGIC: it consumes track.checkpoints (the ordered
// centerline gates produced by src/entities/Track.js) and a kart state's
// { x, z } each tick, and reports how far each racer has progressed. It does
// not touch THREE, the DOM, or rendering — distance math is plain Math so the
// same logic can run on a server later.
//
// How it works (per racer):
//   - Each racer has a progress record with `nextCp`, the index of the next
//     checkpoint it must reach. Checkpoints are advanced SEQUENTIALLY only:
//     you must pass them in order, you cannot skip ahead by cutting the course.
//   - When the kart comes within CHECKPOINT_RADIUS of checkpoints[nextCp], that
//     gate counts as passed and nextCp advances (wrapping back to 0 after the
//     last gate).
//   - Passing checkpoint 0 (the start/finish line) AFTER having gone around the
//     loop increments the lap counter and records the lap time.
//   - At `totalLaps` completed laps the racer is marked finished.
//   - progressScore = lap*N + nextCp + fractionTowardNextCp gives a single
//     monotonic number for ranking racers (higher = further along).

// Radius (m) within which a checkpoint counts as reached. Tuned to the ~14 m
// road width and gate spacing of the default stadium track: generous enough
// that a kart driving normally always trips the gate, tight enough that gates
// are not registered out of order. (Kept local — constants.js is owned by the
// physics module; importing a not-yet-exported name would throw at load.)
const DEFAULT_CHECKPOINT_RADIUS = 12;

export class LapSystem {
  /**
   * @param {object} track       EITHER a Track instance OR any plain object
   *                             exposing `checkpoints` (ordered [{x,z,index}],
   *                             index 0 = start/finish). This module is pure
   *                             Math — no three import — so the headless server
   *                             can pass { checkpoints: buildCheckpoints() }
   *                             from shared/trackData.js directly.
   * @param {number} totalLaps   laps required to finish the race (default 3).
   */
  constructor(track, totalLaps = 3) {
    this.track = track;
    this.totalLaps = totalLaps;

    // Number of checkpoints in one loop. Used as the per-lap stride in
    // progressScore so lap N always outranks lap N-1 regardless of gate index.
    this.checkpointCount = (track.checkpoints && track.checkpoints.length) || 0;

    // Radius (m) within which a checkpoint counts as reached.
    this.checkpointRadius = DEFAULT_CHECKPOINT_RADIUS;

    // id -> progress record.
    this.records = new Map();

    // Reusable standings buffer. getStandings() refreshes these entry objects
    // in place and sorts the array in place, so a steady-state race produces
    // ZERO per-call allocations (the array + its N entry objects are created
    // once and then recycled every tick / frame). Entries are plain
    // { id, progressScore, lap } mirrors of the records, kept identical to the
    // old getStandings() output shape so all callers are unchanged.
    this._standings = [];
  }

  /**
   * Register a racer and create its progress record.
   *
   * @param {string|number} id  unique racer id (player slot, AI id, etc.).
   * @returns {object} the progress record (also stored internally):
   *   {
   *     lap:0,            // completed laps so far (0 until the first line cross)
   *     nextCp:1,         // index of the next checkpoint to reach
   *     started:false,    // true once the racer has left checkpoint 0 the 1st time
   *     finished:false,   // true once `totalLaps` laps are done
   *     lapStart:0,       // nowSeconds when the current lap began
   *     lapTimes:[],      // completed lap durations in seconds
   *     bestLap:null,     // fastest lap time so far (seconds) or null
   *     progressScore:0,  // monotonic ranking score (see _scoreOf)
   *   }
   *
   * nextCp starts at 1 because the racer spawns ON checkpoint 0 (start/finish);
   * the first gate it actually needs to reach is index 1.
   */
  addRacer(id) {
    const rec = {
      lap: 0,
      nextCp: 1,
      started: false,
      finished: false,
      lapStart: 0,
      lapTimes: [],
      bestLap: null,
      progressScore: 0,
    };
    this.records.set(id, rec);
    return rec;
  }

  /**
   * Squared planar distance from a kart position to a checkpoint gate.
   * Squared (no sqrt) is enough for radius comparisons and ranking fractions
   * when compared consistently; we sqrt only where a real distance is needed.
   * @private
   */
  _dist2(state, gate) {
    const dx = state.x - gate.x;
    const dz = state.z - gate.z;
    return dx * dx + dz * dz;
  }

  /**
   * Compute the fraction (0..1) of the way from the PREVIOUS gate to the next
   * gate, based on how close the kart is to the next gate. This makes
   * progressScore increase smoothly between checkpoints so two karts in the
   * same checkpoint segment still rank correctly.
   * @private
   */
  _fractionToNext(rec, state) {
    const cps = this.track.checkpoints;
    if (!cps || cps.length === 0) return 0;

    const nextGate = cps[rec.nextCp % cps.length];
    const prevIdx = (rec.nextCp - 1 + cps.length) % cps.length;
    const prevGate = cps[prevIdx];

    // Length of this segment (prev -> next) and remaining distance to next.
    const segDx = nextGate.x - prevGate.x;
    const segDz = nextGate.z - prevGate.z;
    const segLen = Math.sqrt(segDx * segDx + segDz * segDz);
    if (segLen < 1e-6) return 0;

    const remaining = Math.sqrt(this._dist2(state, nextGate));
    // fraction covered = 1 - remaining/segLen, clamped to [0,1].
    let frac = 1 - remaining / segLen;
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    return frac;
  }

  /**
   * Recompute and store the monotonic ranking score for a record.
   *   score = lap * checkpointCount + nextCp + fractionTowardNextCp
   * Higher score = further around the race.
   * @private
   */
  _scoreOf(rec, state) {
    const frac = this._fractionToNext(rec, state);
    rec.progressScore = rec.lap * this.checkpointCount + rec.nextCp + frac;
    return rec.progressScore;
  }

  /**
   * Advance a racer's lap/checkpoint progress for this tick.
   *
   * @param {string|number} id   racer id previously passed to addRacer.
   * @param {object} state       kart state with at least { x, z }.
   * @param {number} nowSeconds  current race clock in seconds (monotonic).
   * @returns {object|undefined} the updated progress record (or undefined if id
   *                             is unknown).
   */
  update(id, state, nowSeconds) {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    if (rec.finished) {
      // Still keep its score fresh so standings stay stable after finishing.
      this._scoreOf(rec, state);
      return rec;
    }

    const cps = this.track.checkpoints;
    if (!cps || cps.length === 0) return rec;

    const radius2 = this.checkpointRadius * this.checkpointRadius;

    // Only the NEXT checkpoint in sequence can be passed (no skipping). We use a
    // small while-loop guard so that if a fast kart covers several gates in one
    // tick (large dt / teleport), we still credit them one at a time in order.
    // The guard caps iterations at the number of checkpoints to avoid spinning.
    let guard = cps.length;
    while (guard-- > 0) {
      const target = cps[rec.nextCp % cps.length];
      if (this._dist2(state, target) > radius2) break; // not reached yet

      // Reached checkpoints[nextCp].
      if (rec.nextCp % cps.length === 0) {
        // We just touched the start/finish line (index 0).
        if (rec.started) {
          // Completed a full loop -> count the lap and record its time.
          const lapTime = nowSeconds - rec.lapStart;
          rec.lapTimes.push(lapTime);
          if (rec.bestLap === null || lapTime < rec.bestLap) {
            rec.bestLap = lapTime;
          }
          rec.lap += 1;
          rec.lapStart = nowSeconds; // next lap's clock starts now

          if (rec.lap >= this.totalLaps) {
            rec.finished = true;
            // Leave nextCp pointing past the line; score will reflect the final
            // lap. Stop advancing further this tick.
            rec.nextCp = rec.lap * 0 + cps.length; // = cps.length (loop complete)
            break;
          }
        } else {
          // First time leaving the line: the race lap clock starts here.
          rec.started = true;
          rec.lapStart = nowSeconds;
        }
        // Aim for gate 1 next (we are at gate 0).
        rec.nextCp = 1;
      } else {
        // Ordinary interior gate: just advance to the following gate. Wrapping
        // is handled by the modulo when we read cps[nextCp % len]; we keep
        // nextCp growing up to cps.length, then 0 maps back to the line above.
        rec.nextCp += 1;
        if (rec.nextCp > cps.length) rec.nextCp = cps.length; // safety clamp
        // When nextCp === cps.length, the next target (cps[len % len] = cps[0])
        // is the start/finish line — the lap-completion branch above.
        if (rec.nextCp === cps.length) {
          // Mark that we have at least started moving around the loop.
          rec.started = true;
        }
      }
    }

    this._scoreOf(rec, state);
    return rec;
  }

  /**
   * @param {string|number} id
   * @returns {object|undefined} the racer's progress record.
   */
  getProgress(id) {
    return this.records.get(id);
  }

  /**
   * Race standings, leader first (highest progressScore == 1st place).
   *
   * Returns a SHARED, reused array (this._standings): its entry objects are
   * refreshed in place from the current records and the array is sorted in
   * place, so repeated calls within a tick/frame allocate nothing. The result
   * is a live snapshot — read it immediately (do not retain it across a later
   * getStandings() call expecting the old contents). Callers in RaceManager
   * consume it synchronously, which is safe.
   *
   * @returns {Array<{id:*, progressScore:number, lap:number}>}
   */
  getStandings() {
    const out = this._standings;
    const n = this.records.size;

    // Refresh existing entries in place; grow/shrink the buffer only when the
    // racer count actually changes (it is fixed for the whole race in practice).
    let i = 0;
    for (const [id, rec] of this.records) {
      let entry = out[i];
      if (entry === undefined) {
        entry = { id, progressScore: rec.progressScore, lap: rec.lap };
        out[i] = entry;
      } else {
        entry.id = id;
        entry.progressScore = rec.progressScore;
        entry.lap = rec.lap;
      }
      i++;
    }
    if (out.length > n) out.length = n; // drop stale trailing entries if shrunk

    out.sort((a, b) => b.progressScore - a.progressScore);
    return out;
  }
}
