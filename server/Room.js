// server/Room.js
//
// The AUTHORITATIVE race. One Room runs one race for its members. It owns the
// full field of kart states and steps EVERY kart with the SAME shared stepKart
// the client uses for prediction, so the server's state and the client's
// predicted state agree given the same inputs. The server is the source of truth:
// it resolves laps, item pickups, item effects, and projectile hits, then
// broadcasts compact snapshots ~20Hz that clients reconcile against.
//
// Determinism / prediction parity:
//   - stepKart (shared/kartModel.js) is the ONE step function. Human karts step
//     from their latest received input; empty/AI seats step from a server-side
//     AIRacer that emits the SAME input shape. No special server physics.
//   - We run a FIXED 60Hz accumulator loop (DT = 1/60) so the timestep matches
//     the client exactly. setInterval jitter is absorbed by the accumulator.
//
// Server-safe dependencies (all of these run fine in Node):
//   - shared/kartModel.js  : pure math + pure mutators (createKartState/stepKart/...).
//   - shared/trackData.js  : pure track DATA + helpers (buildCheckpoints,
//                            buildStartGrid, isOnRoad). Owned by the track-data
//                            module; consumed here. We degrade gracefully to an
//                            inline stadium fallback if it isn't present yet, so
//                            the server always boots.
//   - src/race/LapSystem.js: pure lap/checkpoint logic (no three).
//   - src/items/ItemSystem.js + items.js : pure item roll/hold/use (no three).
//   - src/ai/racingline.js + AIRacer.js  : use THREE *math* (Vector3 / curves),
//                            which works in Node — no DOM, no renderer.
//
// What we DO NOT import: Track.js / ItemBox.js / Kart.js / Projectiles.js — those
// build DOM/canvas/Three meshes in their constructors and are client-only. We
// reimplement the tiny logical bits we need (item-box positions, projectile
// stepping) here against pure data.

import { PHYSICS, EFFECTS, KART_COLORS } from '../shared/constants.js';
import {
  createKartState,
  stepKart,
  applySpin,
  applyMushroomBoost,
  launchKart,
  isInvincible,
} from '../shared/kartModel.js';
import { LapSystem } from '../src/race/LapSystem.js';
import { ItemSystem } from '../src/items/ItemSystem.js';
import { RacingLine } from '../src/ai/racingline.js';
import { AIRacer, buildAISlot, difficultyFactorFor } from '../src/ai/AIRacer.js';

// shared/trackData.js is produced by the track-data module. Import it eagerly;
// if it is missing or incomplete we fall back to an inline stadium so the server
// still runs. The contract we consume:
//   buildCheckpoints() -> [{ x, z, index }]      (ordered centerline gates)
//   buildStartGrid(fieldSize) -> [{ x, y, z, heading }]  (grid poses, pole first)
//   isOnRoad(x, z) -> boolean                    (drivable-surface test)
//   roadWidth (number, optional)                 (used for item-box layout)
let trackData = null;
try {
  trackData = await import('../shared/trackData.js');
} catch {
  trackData = null; // module not present yet — inline fallback used below.
}

// --- Race configuration ----------------------------------------------------
const FIELD_SIZE = 13;        // total karts on track (humans + AI fill)
const TOTAL_LAPS = 3;         // laps to finish
const TICK_HZ = 60;           // fixed sim rate (matches PHYSICS.TICK_RATE / DT)
const DT = PHYSICS.DT;        // 1/60 s per step
const SNAPSHOT_EVERY = 3;     // emit a snapshot every N ticks -> ~20Hz
const RACE_TIMEOUT_S = 300;   // hard cap: end the race after 5 minutes regardless
// Once every HUMAN kart has finished (or, in an all-AI room, the leader finishes),
// give the remaining field this many seconds to cross the line before ending the
// race anyway. Prevents one wedged/slow AI back-marker from freezing results for
// up to RACE_TIMEOUT_S after the humans are already done.
const POST_FINISH_GRACE_S = 15;

// Item-box logical positions live here (the client's ItemBox.js is render-only).
// We must place boxes at the SAME checkpoint rows the client renders, so a server
// pickup lines up with a visible box. The client now spreads NUM_BOX_ROWS rows
// EVENLY across the whole (long) loop instead of a fixed [2,5,8,11,14] list — we
// mirror that here with boxRowCheckpoints() so both sides agree on every track.
const NUM_BOX_ROWS = 5;
const BOXES_PER_ROW = 3;
const BOX_PICKUP_RADIUS = 2.2;   // m (matches client)
const BOX_RESPAWN_S = 3.0;       // s (matches client)

// Projectile tuning for the simple server-side hazard list. Kept intentionally
// lightweight — straight/forward motion with a distance-based hit test. (The
// client renders richer meshes; the server only needs the authoritative hit.)
const PROJECTILE_LIFETIME_S = 6;  // s before a stray projectile is recycled
const PROJECTILE_HIT_RADIUS = 2.5; // m to count a contact

// ORBIT-SHIELD (mirrors src/entities/Projectiles.js so MP agrees): a rival within
// ORBIT_HIT_DIST of a kart holding an orbit-able item gets spun out, and the
// holder's orbit item is consumed. Centre-distance test = deterministic, no rng.
const ORBIT_HIT_DIST = 3.6;        // m  MUST match Projectiles.ORBIT_HIT_DIST
const ORBIT_HIT_R2 = ORBIT_HIT_DIST * ORBIT_HIT_DIST;
const ORBIT_SPIN_SECS = 1.5;       // s  MUST match Projectiles.ORBIT_SPIN_SECS
const ORBIT_VERTICAL_HIT = 2.5;    // m  same-deck gate (mirrors Projectiles.VERTICAL_HIT)
// Items that ride as a held orbit/shield (mirrors RaceManager.ORBIT_ITEM_IDS).
const ORBIT_ITEM_IDS = new Set([
  'greenShell', 'redShell', 'tripleGreen', 'tripleRed', 'banana', 'tripleBanana',
]);

// If a human's most-recent input is older than this, we stop driving it and coast
// to neutral. Without this, a player who stops sending input (lag spike, tab
// freeze, or the gap before Socket.IO's ~20s disconnect timeout fires) keeps
// driving their LAST input — e.g. full-throttle into a wall — every tick. A few
// hundred ms is well beyond the normal client send cadence (one input per frame),
// so a connected player is never affected; only a stalled/gone one coasts.
const INPUT_STALE_MS = 500;

// MP AI fill plays at HARD difficulty so empty seats / disconnect takeovers are a
// genuine threat against the human field (matches the single-player HARD feel). The
// per-slot cc/pace + the five PERSONALITY archetypes come from the SHARED
// buildAISlot in AIRacer.js, so a given grid slot drives identically here and in
// single-player.
const AI_DIFFICULTY = 'hard';

export class Room {
  /**
   * @param {string} id  unique room id (also the Socket.IO broadcast room name).
   * @param {import('socket.io').Server} io  the Socket.IO server (for emitting).
   */
  constructor(id, io) {
    this.id = id;
    this.io = io;

    // --- Lobby state ------------------------------------------------------
    // playerId -> { socketId, playerId, name, ready }. Insertion order matters:
    // the FIRST player to join is the host.
    this.players = new Map();
    this.hostPlayerId = null;
    this.started = false;
    this._autostartTimer = null; // set by GameServer for the auto-start countdown

    // M6: which track this room races on. The host can change it in the lobby via
    // a 'setTrack' event (GameServer -> setTrack). Defaults to the legacy circuit
    // so a room that never picks a track behaves exactly as before. We resolve it
    // to a known id through trackData (unknown ids fall back to 'circuit').
    this.trackId = 'circuit';

    // --- Per-player latest input (filled by setInput, read each tick) -----
    // playerId -> { seq, steer, throttle, brake, drift, useItem, lookBack }
    this.inputs = new Map();
    // playerId -> last input seq we have PROCESSED (echoed back in ackSeq so the
    // client can drop acknowledged inputs from its prediction buffer).
    this.ackSeq = {};

    // --- Sim state (built in start()) ------------------------------------
    this.karts = [];          // [{ id, isAI, state, ai, progressScore, _prevUseItem }]
    this._kartById = new Map();
    this.lapSystem = null;
    this.itemSystem = null;
    this.racingLine = null;
    this.checkpoints = null;
    this.boxes = [];          // [{ x, z, active, respawn }]
    this.projectiles = [];    // [{ id, type, x, y, z, vx, vz, ownerId, spinSecs, life }]
    this._nextProjId = 1;

    this._loop = null;        // setInterval handle for the sim
    this._accumulator = 0;    // leftover real time to convert into fixed steps
    this._lastTime = 0;       // hrtime ms of the previous loop iteration
    this._tick = 0;           // fixed-step counter (drives snapshot cadence)
    this._raceClock = 0;      // monotonic sim seconds (laps + timeout)
    this._graceDeadline = -1; // sim-clock time at which the post-finish grace ends (-1 = not armed)
    this._onEnd = null;       // callback invoked once the race ends

    // Scratch context reused for AI computeInput (avoid per-kart allocation). The
    // feature / cap / tactical fields are filled in start() once the racing line +
    // features exist; selfId / selfHeldItem / myProgressScore are refreshed per-AI
    // each tick in _stepOnce. Threading these is what makes the SERVER AI as smart
    // as the single-player AI: rubber-banding (progressMetersPerScore), the AI-
    // beatable speed cap (playerMaxTopSpeed/difficultyFactor), hazard dodging
    // (hazards), boost/ramp seeking (boostRamps) and TACTICAL item use (selfHeldItem
    // + selfId + standings) — none of which fired before because the context was bare.
    this._aiContext = {
      dt: DT, standings: null, playerProgressScore: 0,
      myProgressScore: 0, allKarts: null,
      progressMetersPerScore: 0,
      playerMaxTopSpeed: PHYSICS.MAX_SPEED, // MP karts are neutral -> 44 m/s base cap
      difficultyFactor: difficultyFactorFor(AI_DIFFICULTY),
      hazards: null,
      boostRamps: null,
      selfId: null,
      selfHeldItem: null,
    };
  }

  // ========================================================================
  // LOBBY
  // ========================================================================

  /**
   * Seat a new human player. The first to join becomes the host.
   * @param {{socketId:string, playerId:string, name:string}} p
   */
  addPlayer(p) {
    if (this.players.has(p.playerId)) return;
    this.players.set(p.playerId, { ...p, ready: false });
    if (this.hostPlayerId == null) this.hostPlayerId = p.playerId;
  }

  /**
   * Remove a human player. In the lobby this frees the seat; mid-race the seat is
   * converted to AI so the field size stays constant and the sim keeps running.
   * @param {string} playerId
   */
  removePlayer(playerId) {
    const seat = this.players.get(playerId); // capture BEFORE delete (name for the toast)
    this.players.delete(playerId);
    this.inputs.delete(playerId);
    delete this.ackSeq[playerId];

    // Host left: promote the next remaining player to host (if any).
    if (this.hostPlayerId === playerId) {
      const next = this.players.keys().next();
      this.hostPlayerId = next.done ? null : next.value;
    }

    // Mid-race: turn the abandoned kart into an AI so it keeps driving.
    if (this.started) {
      const kart = this._kartById.get(playerId);
      if (kart && !kart.isAI) {
        kart.isAI = true;
        // Give the takeover AI a profile matching the kart's FIELD SLOT (its index
        // in the field), not a hardcoded mid-pack one — so a former pole-sitter keeps
        // driving like a front-runner. Same SHARED slot builder + seed as start().
        const slot = this.karts.indexOf(kart);
        const { cc, profile } = buildAISlot(slot >= 0 ? slot : 0, AI_DIFFICULTY);
        kart.ai = new AIRacer({
          racingLine: this.racingLine,
          cc,
          profile,
          seed: slot >= 0 ? slot : 0,
        });
        // Tell clients a human dropped and an AI took over, so they can toast it.
        this.io.to(this.id).emit('playerLeft', {
          id: playerId,
          name: seat ? seat.name : 'A racer',
        });
      }
    }
  }

  /** @param {string} playerId @param {boolean} ready */
  setReady(playerId, ready) {
    const p = this.players.get(playerId);
    if (p) p.ready = ready;
  }

  /**
   * M6: set the track this room will race on (lobby-only — ignored once started).
   * The id is resolved through trackData so an unknown/missing id safely falls
   * back to the default 'circuit'. getTrackMeta returns the canonical registry
   * KEY as `id`, which is what the builders + the client Track expect.
   * @param {string} trackId  a registry key ('circuit'|'oval'|'figure') or inner id.
   */
  setTrack(trackId) {
    if (this.started) return;
    if (trackData && typeof trackData.getTrackMeta === 'function') {
      this.trackId = trackData.getTrackMeta(trackId).id;
    } else if (typeof trackId === 'string' && trackId) {
      this.trackId = trackId;
    }
  }

  /** @returns {boolean} true if any seated human is marked ready. */
  anyReady() {
    for (const p of this.players.values()) if (p.ready) return true;
    return false;
  }

  /** @returns {number} number of seated humans. */
  humanCount() {
    return this.players.size;
  }

  /** @returns {Array<{id:string,name:string,ready:boolean,color:number}>} lobby list. */
  lobbyList() {
    const out = [];
    let slot = 0;
    for (const p of this.players.values()) {
      // color: humans seat into the front grid slots in this same join order at
      // start(), so the seat index is the kart color the player will actually drive.
      out.push({
        id: p.playerId,
        name: p.name,
        ready: p.ready,
        color: KART_COLORS[slot % KART_COLORS.length],
      });
      slot++;
    }
    return out;
  }

  /**
   * Buffer the latest input for a player. We only keep the MOST RECENT input per
   * player (the sim is authoritative and steps once per tick from whatever the
   * latest input is); the seq lets us ack the newest processed input.
   * @param {string} playerId
   * @param {object} input  { seq, steer, throttle, brake, drift, useItem, lookBack }
   */
  setInput(playerId, input) {
    // Stamp the arrival time so the per-tick loop can detect a stale input (a
    // player who stopped sending) and coast to neutral instead of driving the
    // last input forever. We tag the input object itself (cheap, no extra map).
    if (input) input._rxMs = nowMs();
    this.inputs.set(playerId, input);
  }

  // ========================================================================
  // RACE START
  // ========================================================================

  /**
   * Build the field and begin the fixed-step sim. Emits 'raceStart' to the room.
   * @param {() => void} [onEnd]  invoked once when the race ends (for cleanup).
   */
  start(onEnd) {
    if (this.started) return;
    this.started = true;
    this._onEnd = onEnd || null;

    // --- Track data: checkpoints + grid + road test ----------------------
    this.checkpoints = this._buildCheckpoints();
    const grid = this._buildStartGrid(FIELD_SIZE);

    // TERRAIN (Phase 3): resolve THIS track's features (boost/ramp/hazard) ONCE to
    // absolute world positions, so the per-tick ramp/hazard contact tests don't
    // re-derive spline math. Empty array when the track-data module predates the
    // feature API (older fallback) — the server then simply has no features.
    this.features =
      trackData && typeof trackData.listFeatures === 'function'
        ? trackData.listFeatures(this.trackId)
        : [];

    // A tiny track-like object so LapSystem / RacingLine (which read
    // `.checkpoints`) work unchanged with our pure checkpoint data.
    const trackLike = { checkpoints: this.checkpoints };

    this.lapSystem = new LapSystem(trackLike, TOTAL_LAPS);
    this.racingLine = new RacingLine(trackLike);
    // Inject a deterministic-ish RNG seed point would go here; default Math.random
    // is fine — item drops are allowed to be random (only kartModel must be pure).
    this.itemSystem = new ItemSystem();

    // --- Build the kart field --------------------------------------------
    // Humans first (in join order) into the front grid slots, then AI fill the
    // rest up to FIELD_SIZE. Each kart shares the SAME state/step contract.
    this.karts = [];
    this._kartById.clear();

    const humanIds = [...this.players.keys()];
    const startGrid = []; // for the raceStart payload

    for (let slot = 0; slot < FIELD_SIZE; slot++) {
      const pose = grid[slot] || grid[grid.length - 1];
      const isHuman = slot < humanIds.length;
      const id = isHuman ? humanIds[slot] : 'ai_' + slot;

      const state = createKartState({
        x: pose.x, y: pose.y || 0, z: pose.z, heading: pose.heading,
      });

      let ai = null;
      if (!isHuman) {
        // SHARED slot builder: archetype + cc keyed to the grid SLOT (so a front
        // slot drives like a front-runner) at the MP fill difficulty. Identical to
        // single-player's field for the same slot, and seeded by slot so the
        // deterministic mistake/wander sines are uncorrelated kart-to-kart.
        const { cc, profile } = buildAISlot(slot, AI_DIFFICULTY);
        ai = new AIRacer({ racingLine: this.racingLine, cc, profile, seed: slot });
      }

      const kart = {
        id,
        isAI: !isHuman,
        state,
        ai,
        progressScore: 0,
        _prevUseItem: false, // for rising-edge item firing
        finished: false,
        // TERRAIN feature bookkeeping (Phase 3), mirrors RaceManager exactly so the
        // server authority and the client prediction resolve features identically.
        _prevSurface: 'road', // last tick's surface, for rising-edge boost/ramp
        _offroadTime: 0,      // continuous seconds off the road (respawn trigger)
        _lastCp: 0,           // last checkpoint passed (respawn target)
      };
      this.karts.push(kart);
      this._kartById.set(id, kart);
      this.lapSystem.addRacer(id);

      startGrid.push({
        id,
        isAI: !isHuman,
        x: pose.x, y: pose.y || 0, z: pose.z, heading: pose.heading,
      });
    }

    this._aiContext.allKarts = this.karts;
    // Now that the racing line + features exist, fill the constant AI-context fields
    // (the per-tick ones are refreshed in _stepOnce). progressMetersPerScore turns a
    // signed score gap into meters for rubber-banding + tactical item ranges; the
    // hazard / boost-ramp lists let the server AI dodge oil and chase speed pads.
    const cpCount = this.checkpoints.length || 0;
    this._aiContext.progressMetersPerScore =
      cpCount > 0 ? this.racingLine.length() / cpCount : 0;
    this._aiContext.hazards = this.features.filter((f) => f.type === 'hazard');
    this._aiContext.boostRamps =
      this.features.filter((f) => f.type === 'boost' || f.type === 'ramp');

    // --- Item boxes: logical positions only ------------------------------
    this._buildBoxes();

    // --- Tell clients to enter the race ----------------------------------
    this.io.to(this.id).emit('raceStart', {
      fieldSize: FIELD_SIZE,
      totalLaps: TOTAL_LAPS,
      startGrid,
      trackId: this.trackId, // M6: the room's chosen track (defaults to 'circuit')
    });

    // --- Spin up the fixed-step loop -------------------------------------
    this._tick = 0;
    this._raceClock = 0;
    this._graceDeadline = -1;
    this._accumulator = 0;
    this._lastTime = nowMs();
    // ~16ms cadence; the accumulator below converts elapsed real time into an
    // integer number of fixed DT steps, so the SIM rate stays exactly 60Hz even
    // if the interval fires late.
    this._loop = setInterval(() => this._loopOnce(), 1000 / TICK_HZ);
  }

  /**
   * Stop the sim loop and release timers. Idempotent.
   */
  stop() {
    if (this._loop) {
      clearInterval(this._loop);
      this._loop = null;
    }
    if (this._autostartTimer) {
      clearTimeout(this._autostartTimer);
      this._autostartTimer = null;
    }
  }

  // ========================================================================
  // FIXED-STEP LOOP
  // ========================================================================

  /**
   * One real-time loop iteration: drain accumulated time into fixed 60Hz steps,
   * then emit a snapshot on the snapshot cadence. The accumulator pattern keeps
   * the simulation deterministic regardless of setInterval jitter.
   * @private
   */
  _loopOnce() {
    const t = nowMs();
    let frame = (t - this._lastTime) / 1000; // seconds since last iteration
    this._lastTime = t;
    // Guard against huge frames (e.g. the process was paused): cap to 0.25s so we
    // never try to simulate hundreds of steps in one burst.
    if (frame > 0.25) frame = 0.25;
    this._accumulator += frame;

    // Consume whole DT steps from the accumulator.
    while (this._accumulator >= DT) {
      this._stepOnce(DT);
      this._accumulator -= DT;
      this._tick++;
      this._raceClock += DT;

      // Emit a snapshot every SNAPSHOT_EVERY ticks (~20Hz).
      if (this._tick % SNAPSHOT_EVERY === 0) {
        this._emitSnapshot();
      }

      // End conditions checked each step (cheap).
      if (this._checkRaceOver()) {
        this._endRace();
        return;
      }
    }
  }

  /**
   * Advance the whole race by ONE fixed step. Mirrors RaceManager.update but
   * server-side: every kart steps from a human input OR an AI input through the
   * SAME stepKart, then laps / pickups / item use / projectiles resolve.
   * @param {number} dt  fixed timestep (DT).
   * @private
   */
  _stepOnce(dt) {
    // Standings from last tick drive AI rubber-banding and item brackets.
    const standings = this.lapSystem.getStandings();
    const playerScore = standings.length ? this._leaderHumanScore(standings) : 0;

    this._aiContext.dt = dt;
    this._aiContext.standings = standings;
    this._aiContext.playerProgressScore = playerScore;

    // --- 1. Per-kart: resolve input, step physics, advance laps ----------
    const events = []; // lightweight gameplay events surfaced in the snapshot
    for (let i = 0; i < this.karts.length; i++) {
      const kart = this.karts[i];

      // Resolve input: AI computes one; humans use their latest buffered input.
      let input;
      if (kart.isAI) {
        this._aiContext.myProgressScore = kart.progressScore;
        // Tell the AI which kart it is (skips itself in scans) + what it holds, so it
        // fires items TACTICALLY (forward shells when a rival's just ahead, traps when
        // chased) instead of never — the bare old context left selfHeldItem undefined,
        // so server AIs sat on every item they picked up.
        this._aiContext.selfId = kart.id;
        this._aiContext.selfHeldItem = this.itemSystem.getHeld(kart.id);
        input = kart.ai.computeInput(kart.state, this._aiContext);
      } else {
        const buffered = this.inputs.get(kart.id);
        // Coast to neutral if the last input is stale (player stopped sending):
        // a missing OR old input both normalize to a neutral coast, so a stalled
        // player no longer drives their last full-throttle input into a wall.
        const stale = buffered && (nowMs() - (buffered._rxMs || 0)) > INPUT_STALE_MS;
        input = normalizeInput(stale ? null : buffered);
        // Ack the latest processed input seq so the client can prune its buffer.
        if (buffered && typeof buffered.seq === 'number') {
          this.ackSeq[kart.id] = buffered.seq;
        }
      }
      kart._input = input;

      // TERRAIN (Phase 3): sample the shared surface at the kart's CURRENT
      // (pre-step) position and set groundY/slope/surface BEFORE stepKart, so it
      // rides the hills + applies the slope/offroad effects. This is the SAME pure
      // math + ordering the client Predictor uses (derive-at-pos, then step), so
      // the server authority and the client prediction stay byte-identical.
      const surf = this._sampleSurface(kart.state.x, kart.state.z, kart.state.y, kart.state.lastS);
      // Carved gap/chasm: park groundY 1000m below so updateVertical never clamps
      // the kart onto the invisible centerline height inside the rendered hole — it
      // plunges and _maybeRespawn's fellOff fires. IDENTICAL to RaceManager (SP) so
      // the void mechanic works online and stays byte-identical to the client predictor.
      const overGap = !surf.onRoad && surf.inGap;
      kart.state.groundY = overGap ? surf.groundY - 1000 : surf.groundY;
      kart.state.slope = surf.slope;
      kart.state.surface = surf.surface;
      kart.state.lastS = surf.s; // continuity hint for next frame (overpass fix)

      // ANTI-GRAV (MK8 wall/ceiling riding): drive the section ENTRY/EXIT transition
      // BEFORE the ramp/boost edges + stepKart, IDENTICALLY to the client predictor
      // (Multiplayer._stepWithTerrain) — same pure helper, same place. While the kart
      // is inside a section stepKart runs its surface-relative branch; outside, this is
      // a no-op (and a no-op on tracks without anti-grav data). Guarded so an older
      // trackData fallback (no updateAntigravTransition) simply skips it.
      if (trackData && typeof trackData.updateAntigravTransition === 'function') {
        trackData.updateAntigravTransition(kart.state, this.trackId, surf);
      }

      // RAMP launch (rising edge): first tick over a ramp footprint at speed kicks
      // a jump arc; vyUp scales with approach speed. No-op while already airborne.
      if (
        surf.surface === 'ramp' &&
        kart._prevSurface !== 'ramp' &&
        kart.state.speed >= PHYSICS.RAMP_LAUNCH_MIN_SPEED
      ) {
        const speedFrac = Math.min(kart.state.speed / PHYSICS.MAX_SPEED, 1.4);
        launchKart(kart.state, PHYSICS.RAMP_LAUNCH_VY * (0.7 + 0.5 * speedFrac));
      }
      // BOOST pad (rising edge): entering a boost footprint surges the kart.
      if (surf.surface === 'boost' && kart._prevSurface !== 'boost') {
        applyMushroomBoost(kart.state);
      }
      kart._prevSurface = surf.surface;

      // Authoritative physics: the SAME shared step the client predicts with.
      // stepKart now OWNS y (eases toward groundY / integrates the jump arc), so
      // we no longer force y to 0 — the kart rides the spline's hills.
      stepKart(kart.state, input, dt);

      // HAZARD contact: spin out on touching an oil/cone hazard (distance test vs
      // the resolved feature positions). applySpin honors invincibility.
      this._checkHazards(kart);

      // Lap / checkpoint progress on the sim clock, then mirror the score.
      this.lapSystem.update(kart.id, kart.state, this._raceClock);
      const prog = this.lapSystem.getProgress(kart.id);
      if (prog) {
        // Detect a freshly-finished kart so we can surface a 'finish' event once.
        if (prog.finished && !kart.finished) {
          kart.finished = true;
          events.push({ kind: 'finish', id: kart.id });
        }
        kart.progressScore = prog.progressScore;
        // Remember the last checkpoint passed as the respawn target.
        const n = this.checkpoints.length;
        kart._lastCp = ((prog.nextCp - 1) % n + n) % n;
      }

      // RESPAWN safety net (no walls): off-road too long OR fallen below the track
      // surface -> snap back onto the road at the last checkpoint. Lap untouched.
      this._maybeRespawn(kart, surf, dt, events);
    }

    // --- 2. Item boxes: detect pickups, roll an item if hands are empty ---
    this._updateBoxes(dt, standings, events);

    // --- 3. Item USE on the rising edge of useItem ------------------------
    for (let i = 0; i < this.karts.length; i++) {
      const kart = this.karts[i];
      const useNow = !!(kart._input && kart._input.useItem);
      const fire = useNow && !kart._prevUseItem;
      kart._prevUseItem = useNow;
      if (!fire) continue;
      if (!this.itemSystem.hasItem(kart.id)) continue;
      this._useItemFor(kart, standings, events);
    }

    // --- 4. Projectiles: step + hit test ----------------------------------
    this._updateProjectiles(dt, events);

    // --- 4b. Orbit-shield contact: rivals brushing a held orbit ring spin out. --
    this._updateOrbitShields(events);

    // Stash this step's events for the next snapshot (snapshots are every 3 ticks,
    // so we accumulate events between snapshots to avoid dropping any).
    if (events.length) {
      (this._pendingEvents || (this._pendingEvents = [])).push(...events);
    }
  }

  // ========================================================================
  // ITEM BOXES (logical)
  // ========================================================================

  /**
   * Build the logical item-box positions from the checkpoints — same rows the
   * client's ItemBox.js renders, so a server pickup lines up with a visible box.
   * @private
   */
  _buildBoxes() {
    this.boxes = [];
    const cps = this.checkpoints;
    // Use THIS room's track road width so boxes spread correctly on every track.
    // Fall back to the legacy default width (14) if the registry isn't available.
    let roadW = 14;
    if (trackData && trackData.TRACKS && trackData.TRACKS[this.trackId]) {
      roadW = trackData.TRACKS[this.trackId].roadWidth;
    } else if (trackData && trackData.roadWidth) {
      roadW = trackData.roadWidth;
    }
    const halfW = roadW / 2;

    for (const cpIndex of boxRowCheckpoints(cps.length)) {
      if (cpIndex >= cps.length) continue;
      const gate = cps[cpIndex];
      const next = cps[(cpIndex + 1) % cps.length];

      // Forward + right vectors along the centerline (match ItemBox.js layout).
      let fx = next.x - gate.x;
      let fz = next.z - gate.z;
      const flen = Math.hypot(fx, fz) || 1;
      fx /= flen; fz /= flen;
      const rx = fz, rz = -fx;

      const usableHalf = halfW * 0.62;
      for (let i = 0; i < BOXES_PER_ROW; i++) {
        const tt = BOXES_PER_ROW === 1 ? 0 : i / (BOXES_PER_ROW - 1);
        const offset = (tt - 0.5) * 2 * usableHalf;
        this.boxes.push({
          x: gate.x + rx * offset,
          z: gate.z + rz * offset,
          active: true,
          respawn: 0,
        });
      }
    }
  }

  /**
   * Tick item boxes: respawn timers + pickup detection. On a pickup we roll a
   * position-weighted item (back-runners get stronger items) and hand it over if
   * the kart's hands are empty. Surfaces a 'pickup' event.
   * @param {number} dt
   * @param {Array} standings  current leader-first standings for the item bracket.
   * @param {Array} events
   * @private
   */
  _updateBoxes(dt, standings, events) {
    const r2 = BOX_PICKUP_RADIUS * BOX_PICKUP_RADIUS;
    for (let b = 0; b < this.boxes.length; b++) {
      const box = this.boxes[b];
      if (!box.active) {
        box.respawn -= dt;
        if (box.respawn <= 0) { box.respawn = 0; box.active = true; }
        continue;
      }
      for (let k = 0; k < this.karts.length; k++) {
        const kart = this.karts[k];
        const dx = kart.state.x - box.x;
        const dz = kart.state.z - box.z;
        if (dx * dx + dz * dz <= r2) {
          box.active = false;
          box.respawn = BOX_RESPAWN_S;
          // Award while there's a free slot (hold up to 3 items, not just one).
          if (this.itemSystem.hasFreeSlot(kart.id)) {
            const rank = this._rankOf(kart.id, standings);
            const itemId = this.itemSystem.rollItem(rank, FIELD_SIZE);
            this.itemSystem.giveItem(kart.id, itemId);
            events.push({ kind: 'pickup', id: kart.id, item: itemId });
          }
          break; // box taken this step
        }
      }
    }
  }

  // ========================================================================
  // ITEM USE  (mirrors RaceManager._useItemFor, server-authoritative)
  // ========================================================================

  /**
   * Resolve a held item for one kart: spawn projectiles/traps into the logical
   * projectile list, apply self effects, or run field-wide globals. Effects use
   * the SAME pure kartModel mutators the client uses, so outcomes match.
   * @param {object} kart
   * @param {Array} standings  leader-first standings (for targeting).
   * @param {Array} events
   * @private
   */
  _useItemFor(kart, standings, events) {
    const action = this.itemSystem.useItem(kart.id, kart.state, {
      standings,
      fieldSize: FIELD_SIZE,
    });
    if (!action) return;

    switch (action.kind) {
      case 'self': {
        if (typeof action.apply === 'function') action.apply(kart.state);
        if (action.item === 'superHorn') this._resolveSuperHorn(kart);
        events.push({ kind: 'item', id: kart.id, item: action.item });
        break;
      }
      case 'projectile': {
        if (action.item === 'blueShell' || action.targetsLeader) {
          this._fireBlueShell(kart, standings, action);
        } else {
          this._spawnProjectile(action.item, kart, action);
        }
        events.push({ kind: 'item', id: kart.id, item: action.item });
        break;
      }
      case 'trap': {
        this._spawnProjectile(action.item, kart, action);
        events.push({ kind: 'item', id: kart.id, item: action.item });
        break;
      }
      case 'global': {
        const map = this._allKartsMap();
        if (typeof action.apply === 'function') action.apply(map, kart.id);
        if (action.item === 'boo') this._stealItemFor(kart.id);
        events.push({ kind: 'item', id: kart.id, item: action.item });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Blue shell: spin the standings leader (not the firer) unless invincible. We
   * also push a fast forward projectile as a visual cue (clients render it).
   * @private
   */
  _fireBlueShell(kart, standings, action) {
    let leaderId = null;
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].id !== kart.id) { leaderId = standings[i].id; break; }
    }
    if (leaderId == null) return;
    const target = this._kartById.get(leaderId);
    if (!target) return;
    const secs = action && action.spinSecs ? action.spinSecs : 2.0;
    if (!isInvincible(target.state)) applySpin(target.state, secs);
    // Visual-cue projectile toward the leader (hit is already applied above).
    // COSMETIC: it flies/renders but never collides, so it can't extend the
    // leader's spin or strike an unintended kart en route.
    this._spawnProjectile('redShell', kart, action, true);
  }

  /**
   * Super horn: spin every non-invincible rival within RADIUS and destroy any
   * projectile inside that radius.
   * @private
   */
  _resolveSuperHorn(kart) {
    const RADIUS = 7, R2 = RADIUS * RADIUS, SPIN = 1.0;
    const ox = kart.state.x, oz = kart.state.z;
    for (let i = 0; i < this.karts.length; i++) {
      const other = this.karts[i];
      if (other.id === kart.id) continue;
      const dx = other.state.x - ox, dz = other.state.z - oz;
      if (dx * dx + dz * dz <= R2 && !isInvincible(other.state)) {
        applySpin(other.state, SPIN);
      }
    }
    // Remove projectiles caught in the blast.
    this.projectiles = this.projectiles.filter((p) => {
      const dx = p.x - ox, dz = p.z - oz;
      return dx * dx + dz * dz > R2;
    });
  }

  /**
   * Boo steal: move a random rival's held item to userId.
   * @private
   */
  _stealItemFor(userId) {
    const victims = [];
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      if (k.id === userId) continue;
      if (this.itemSystem.hasItem(k.id)) victims.push(k.id);
    }
    if (!victims.length) return;
    const pick = Math.floor(this.itemSystem.rng() * victims.length);
    const victimId = victims[Math.min(pick, victims.length - 1)];
    const stolen = this.itemSystem.getHeld(victimId);
    if (!stolen) return;
    this.itemSystem.giveItem(userId, stolen.id);
    this.itemSystem.clear(victimId);
  }

  // ========================================================================
  // PROJECTILES (simple server-side logical list)
  // ========================================================================

  /**
   * Spawn a logical projectile/trap from a kart. Forward items launch ahead at
   * their item speed; traps (forward:false) drop behind, stationary. We only
   * model position + a distance hit test — enough to be authoritative; the client
   * renders the richer visuals.
   * @param {string} type   item id (e.g. 'greenShell', 'banana').
   * @param {object} kart   the firing kart.
   * @param {object} action the action descriptor (carries forward/speed/spinSecs).
   * @private
   */
  _spawnProjectile(type, kart, action, cosmetic = false) {
    const s = kart.state;
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const forward = action.forward !== false; // default forward
    const speed = forward ? (action.speed || 38) : 0; // traps don't move
    const dir = forward ? 1 : -1;

    // Spawn a little ahead/behind the kart so it doesn't instantly hit the owner.
    const spawnOffset = 2.0 * dir;

    this.projectiles.push({
      id: this._nextProjId++,
      type,
      x: s.x + fx * spawnOffset,
      y: 0.6,
      z: s.z + fz * spawnOffset,
      vx: fx * speed * dir,
      vz: fz * speed * dir,
      ownerId: kart.id,
      spinSecs: action.spinSecs || EFFECTS.SPIN_DURATION,
      blastRadius: action.blastRadius || 0,
      cosmetic,
      life: PROJECTILE_LIFETIME_S,
    });
  }

  /**
   * Step every projectile and resolve hits. A projectile that touches a kart
   * (not its owner, not invincible) spins it out and is recycled. Traps sit still
   * and wait. Anything that outlives its lifetime is recycled.
   * @param {number} dt
   * @param {Array} events
   * @private
   */
  _updateProjectiles(dt, events) {
    if (!this.projectiles.length) return;
    const hitR2 = PROJECTILE_HIT_RADIUS * PROJECTILE_HIT_RADIUS;
    const survivors = [];

    for (let p = 0; p < this.projectiles.length; p++) {
      const proj = this.projectiles[p];
      // Move (traps have zero velocity).
      proj.x += proj.vx * dt;
      proj.z += proj.vz * dt;
      proj.life -= dt;

      let consumed = false;
      // Cosmetic projectiles fly/render but never collide — their effect was
      // applied deterministically at spawn (e.g. the blue-shell leader hit).
      for (let k = 0; !proj.cosmetic && k < this.karts.length; k++) {
        const kart = this.karts[k];
        // A moving projectile shouldn't hit its owner; a dropped trap can't hit
        // the owner immediately either (we offset the spawn behind them).
        if (kart.id === proj.ownerId) continue;
        const dx = kart.state.x - proj.x;
        const dz = kart.state.z - proj.z;
        if (dx * dx + dz * dz <= hitR2) {
          if (proj.blastRadius > 0) {
            // Bob-omb style: spin everyone in the blast radius (incl. could-be
            // multiple karts), then consume the projectile.
            this._explode(proj, events);
          } else if (!isInvincible(kart.state)) {
            applySpin(kart.state, proj.spinSecs);
            events.push({ kind: 'hit', id: kart.id, by: proj.type });
          }
          consumed = true;
          break;
        }
      }

      if (!consumed && proj.life > 0) survivors.push(proj);
    }
    this.projectiles = survivors;
  }

  /**
   * Resolve a blast-radius explosion: spin every non-invincible kart within the
   * projectile's blastRadius.
   * @private
   */
  _explode(proj, events) {
    const r2 = proj.blastRadius * proj.blastRadius;
    for (let k = 0; k < this.karts.length; k++) {
      const kart = this.karts[k];
      const dx = kart.state.x - proj.x;
      const dz = kart.state.z - proj.z;
      if (dx * dx + dz * dz <= r2 && !isInvincible(kart.state)) {
        applySpin(kart.state, proj.spinSecs);
        events.push({ kind: 'hit', id: kart.id, by: proj.type });
      }
    }
  }

  /**
   * ORBIT-SHIELD hit (mirrors the client Projectiles._orbitHit so MP agrees): for
   * every kart holding an orbit-able item, spin the first rival brushing its orbit
   * ring (unless invincible) and CONSUME the holder's item (clear() drops the held
   * set, matching the client's shield handshake). Centre-distance test with the
   * SAME numbers the client uses — deterministic, no rng.
   * @param {Array} events
   * @private
   */
  _updateOrbitShields(events) {
    for (let i = 0; i < this.karts.length; i++) {
      const holder = this.karts[i];
      const held = this.itemSystem.getHeld(holder.id);
      if (!held || !ORBIT_ITEM_IDS.has(held.id)) continue;
      const hs = holder.state;
      for (let j = 0; j < this.karts.length; j++) {
        const other = this.karts[j];
        if (other.id === holder.id) continue; // your own orbit never hits you
        const os = other.state;
        if (Math.abs((os.y || 0) - (hs.y || 0)) > ORBIT_VERTICAL_HIT) continue;
        const dx = os.x - hs.x;
        const dz = os.z - hs.z;
        if (dx * dx + dz * dz > ORBIT_HIT_R2) continue;
        if (!isInvincible(os)) {
          applySpin(os, ORBIT_SPIN_SECS);
          events.push({ kind: 'hit', id: other.id, by: held.id });
        }
        // Consume the holder's orbit item (drop the held set, like the client).
        this.itemSystem.clear(holder.id);
        break; // one rival per holder per step
      }
    }
  }

  // ========================================================================
  // SNAPSHOT + RACE END
  // ========================================================================

  /**
   * Broadcast a compact authoritative snapshot to the room (~20Hz). Includes the
   * minimal kart fields the client needs to render + reconcile, the logical
   * projectile positions, ackSeq (last processed input seq per human), and any
   * gameplay events accumulated since the last snapshot.
   * @private
   */
  _emitSnapshot() {
    const karts = new Array(this.karts.length);
    for (let i = 0; i < this.karts.length; i++) {
      const k = this.karts[i];
      const s = k.state;
      const prog = this.lapSystem.getProgress(k.id);
      const held = this.itemSystem.getHeld(k.id);
      karts[i] = {
        id: k.id,
        isAI: k.isAI,
        x: round2(s.x), y: round2(s.y), z: round2(s.z),
        heading: round3(s.heading),
        speed: round2(s.speed),
        drifting: s.drifting,
        driftDir: s.driftDir,
        miniTurboTier: s.miniTurboTier,
        boostTimer: round2(s.boostTimer),
        // AURABORNE: stream the overdrive meter + active surge so the LOCAL player's
        // reconcile can correct them. They charge deterministically on both sides, but
        // without streaming there's no correction path and the meter rubberbands/desyncs.
        overdrive: round2(s.overdrive),
        overdriveTimer: round2(s.overdriveTimer),
        spinTimer: round2(s.spinTimer),
        starTimer: round2(s.starTimer),
        shrinkTimer: round2(s.shrinkTimer),
        lap: prog ? prog.lap : 0,
        nextCp: prog ? prog.nextCp : 1,
        pos: 0, // filled below from standings (1-based race position)
        item: held ? held.id : '',
      };
      // FULL 3-SLOT inventory, streamed ONLY when the kart is actually holding
      // something (empty hands = zero extra bytes). Lets the phone + TV show all
      // three power-up slots, not just the first. Each entry is {id,count} or null.
      if (this.itemSystem.hasItem(k.id)) {
        karts[i].slots = this.itemSystem.getSlots(k.id);
      }
      // ANTI-GRAV: stream the 4 surface-relative fields ONLY while in a section, so a
      // normal lap (the common case, 13 karts) costs zero extra bytes. agS needs round5
      // (round3 ≈ 3.9 m granularity on a ~3870 m lap would jitter the derived
      // lateral/orientation on every reconcile); agLateral/agHeading are coarser-tolerant.
      if (s.agSection >= 0) {
        karts[i].agSection = s.agSection;
        karts[i].agS = round5(s.agS);
        karts[i].agLateral = round2(s.agLateral);
        karts[i].agHeading = round3(s.agHeading);
      }
      // TERRAIN: stream the vertical arc fields ONLY while airborne, so a normal
      // grounded lap costs zero extra bytes (mirrors the agSection gate above).
      // Without these the local player's reconcile flattens every mid-air arc:
      // snapshotToState would default vy:0/airborne:false and updateVertical's
      // grounded branch yanks the predicted y down to the road, then the next
      // snapshot snaps it back up -> jitter. gliding is essential too -> a glide
      // arc must replay with GLIDE_GRAVITY (kartModel.js), not GRAVITY (~3.7x
      // faster), or it re-diverges; airTime restores the air-steer grip ramp +
      // trick payout timing. Deterministic (round2 like x/y/z).
      if (s.airborne) {
        karts[i].vy = round2(s.vy);
        karts[i].airborne = true;
        karts[i].gliding = s.gliding;
        karts[i].airTime = round2(s.airTime);
      }
    }

    // Fill 1-based race positions from the standings (leader = pos 1).
    const standings = this.lapSystem.getStandings();
    const posById = new Map();
    for (let i = 0; i < standings.length; i++) posById.set(standings[i].id, i + 1);
    for (let i = 0; i < karts.length; i++) karts[i].pos = posById.get(karts[i].id) || 0;

    // Projectiles: only the fields the client renders.
    const projectiles = this.projectiles.map((p) => ({
      id: p.id, type: p.type, x: round2(p.x), y: round2(p.y), z: round2(p.z),
    }));

    const events = this._pendingEvents || [];
    this._pendingEvents = null;

    this.io.to(this.id).emit('snapshot', {
      tick: this._tick,
      t: round3(this._raceClock),
      ackSeq: { ...this.ackSeq },
      karts,
      projectiles,
      events,
    });
  }

  /**
   * @returns {boolean} true if the race should end (every kart finished, all
   *   humans gone mid-race with the field done, or the hard timeout elapsed).
   * @private
   */
  _checkRaceOver() {
    if (this._raceClock >= RACE_TIMEOUT_S) return true;

    // Over immediately when every kart has finished its laps.
    let allFinished = true;
    for (let i = 0; i < this.karts.length; i++) {
      if (!this.karts[i].finished) { allFinished = false; break; }
    }
    if (allFinished) return true;

    // Early end: once the humans are done we should not make them wait for a
    // wedged/slow AI back-marker to crawl across the line. Decide whether the
    // "primary" field is done: all HUMAN karts finished, or — in an all-AI room
    // (e.g. every human left mid-race) — the current leader has finished.
    let humanCount = 0;
    let humansAllFinished = true;
    for (let i = 0; i < this.karts.length; i++) {
      const kart = this.karts[i];
      if (kart.isAI) continue;
      humanCount++;
      if (!kart.finished) humansAllFinished = false;
    }

    let primaryDone;
    if (humanCount > 0) {
      primaryDone = humansAllFinished;
    } else {
      // No humans: end shortly after the leader finishes rather than waiting on
      // the whole AI field.
      const standings = this.lapSystem.getStandings();
      const leaderId = standings.length ? standings[0].id : null;
      const leader = leaderId ? this._kartById.get(leaderId) : null;
      primaryDone = !!(leader && leader.finished);
    }

    if (primaryDone) {
      // Arm the grace timer on the first tick the primary field is done, then
      // end the race once it elapses regardless of remaining AI stragglers.
      if (this._graceDeadline < 0) {
        this._graceDeadline = this._raceClock + POST_FINISH_GRACE_S;
      } else if (this._raceClock >= this._graceDeadline) {
        return true;
      }
    } else {
      // A human re-entered the "not finished" set (shouldn't normally happen):
      // disarm so we don't end prematurely.
      this._graceDeadline = -1;
    }

    return false;
  }

  /**
   * Stop the loop and broadcast final results, then invoke the end callback so
   * GameServer can drop the room.
   * @private
   */
  _endRace() {
    this.stop();

    // Build results sorted by finishing standings (leader first).
    const standings = this.lapSystem.getStandings();
    const results = [];
    for (let i = 0; i < standings.length; i++) {
      const id = standings[i].id;
      const kart = this._kartById.get(id);
      const prog = this.lapSystem.getProgress(id);
      const player = this.players.get(id);
      results.push({
        id,
        name: player ? player.name : (kart && kart.isAI ? 'CPU' : id),
        isAI: kart ? kart.isAI : true,
        pos: i + 1,
        bestLap: prog ? prog.bestLap : null,
      });
    }

    this.io.to(this.id).emit('raceEnd', { results });

    if (typeof this._onEnd === 'function') {
      const cb = this._onEnd;
      this._onEnd = null;
      cb();
    }
  }

  // ========================================================================
  // SMALL HELPERS
  // ========================================================================

  /** Build the { id: state } map a 'global' item action walks. @private */
  _allKartsMap() {
    const map = {};
    for (let i = 0; i < this.karts.length; i++) map[this.karts[i].id] = this.karts[i].state;
    return map;
  }

  /** 0-based rank of an id in leader-first standings (0 = leader). @private */
  _rankOf(id, standings) {
    for (let i = 0; i < standings.length; i++) if (standings[i].id === id) return i;
    return standings.length ? standings.length - 1 : 0;
  }

  /**
   * The best (highest) progress score among HUMAN karts, used as the AI's
   * rubber-band reference "playerProgressScore". With multiple humans we band
   * against the leading human so the AI fights the front of the human pack.
   * @private
   */
  _leaderHumanScore(standings) {
    for (let i = 0; i < standings.length; i++) {
      const kart = this._kartById.get(standings[i].id);
      if (kart && !kart.isAI) return standings[i].progressScore;
    }
    return 0;
  }

  // ------------------------------------------------------------------------
  // TRACK DATA (delegate to shared/trackData.js; inline fallback otherwise).
  // ------------------------------------------------------------------------

  /** @returns {Array<{x:number,z:number,index:number}>} @private */
  _buildCheckpoints() {
    if (trackData && typeof trackData.buildCheckpoints === 'function') {
      // M6: build the gates for THIS room's track (defaults to 'circuit').
      return trackData.buildCheckpoints(this.trackId);
    }
    return fallbackCheckpoints();
  }

  /** @returns {Array<{x:number,y:number,z:number,heading:number}>} @private */
  _buildStartGrid(fieldSize) {
    if (trackData && typeof trackData.buildStartGrid === 'function') {
      // buildStartGrid(trackId, fieldSize) — pass the room's track first.
      return trackData.buildStartGrid(this.trackId, fieldSize);
    }
    return fallbackStartGrid(fieldSize, this.checkpoints);
  }

  /** @returns {boolean} @private */
  _isOnRoad(x, z) {
    if (trackData && typeof trackData.isOnRoad === 'function') {
      // isOnRoad(trackId, x, z) — pass the room's track first.
      return trackData.isOnRoad(this.trackId, x, z);
    }
    return fallbackIsOnRoad(x, z);
  }

  /**
   * TERRAIN (Phase 3): sample the shared track surface at (x,z). Returns the same
   * { onRoad, surface, groundY, slope } shape the client uses so hill-riding +
   * the surface cap match exactly. Falls back to a FLAT surface (groundY 0, slope
   * 0) derived from the legacy road test when the track-data module predates the
   * sampleSurface API — that reproduces the old flat-stadium behaviour exactly.
   *
   * `y` (the kart's current height) is OPTIONAL and forwarded to sampleSurface so
   * the centerline pick is height-aware at overpasses (the kart no longer floats
   * up onto the section crossing above). The legacy flat fallback ignores y.
   * @param {number} x
   * @param {number} z
   * @param {number} [y]  kart's current height (for overpass disambiguation).
   * @returns {{onRoad:boolean, surface:string, groundY:number, slope:number}}
   * @private
   */
  _sampleSurface(x, z, y, sHint) {
    if (trackData && typeof trackData.sampleSurface === 'function') {
      return trackData.sampleSurface(this.trackId, x, z, y, sHint);
    }
    const onRoad = this._isOnRoad(x, z);
    return { onRoad, surface: onRoad ? 'road' : 'offroad', groundY: 0, slope: 0 };
  }

  /**
   * HAZARD contact: spin the kart out if touching a hazard feature this tick.
   * Distance test against the resolved feature world positions (cached in start()).
   * applySpin honors invincibility. No-op when the track has no features.
   * @param {object} kart
   * @private
   */
  _checkHazards(kart) {
    const feats = this.features;
    if (!feats || feats.length === 0) return;
    const sx = kart.state.x, sz = kart.state.z;
    for (let f = 0; f < feats.length; f++) {
      const feat = feats[f];
      if (feat.type !== 'hazard') continue;
      const r = (feat.params && feat.params.radius) || 4;
      const dx = sx - feat.x, dz = sz - feat.z;
      if (dx * dx + dz * dz <= r * r) {
        // RISING EDGE only: applySpin takes the max of the new duration and whatever's
        // left, so re-firing every tick a stationary kart sits in the hazard kept
        // resetting the timer back to full — the kart never left the puddle, so it
        // spun forever. Only (re-)trigger once the previous spin has fully expired.
        if (kart.state.spinTimer <= 0) applySpin(kart.state);
        break;
      }
    }
  }

  /**
   * RESPAWN safety net (no containment walls on the spline course): a kart that
   * has been off the road too long OR fallen well below the track surface is
   * snapped back onto the road centerline at its last passed checkpoint with speed
   * cut + the jump cleared. Lap progress is left intact. Mirrors RaceManager.
   * @param {object} kart
   * @param {{onRoad:boolean, groundY:number}} surf  this tick's surface sample.
   * @param {number} dt
   * @private
   */
  _maybeRespawn(kart, surf, dt, events) {
    if (surf.onRoad) kart._offroadTime = 0;
    else kart._offroadTime += dt;

    const fellOff = kart.state.y < surf.groundY - 25;
    if (kart._offroadTime < 2.5 && !fellOff) return;

    // Resolve an on-road pose at the last checkpoint. Prefer the shared
    // respawnPoint (gives a proper heading + hill height); fall back to the raw
    // checkpoint if the track-data module predates that API.
    let pose;
    if (trackData && typeof trackData.respawnPoint === 'function') {
      pose = trackData.respawnPoint(this.trackId, kart._lastCp);
    } else {
      const cp = this.checkpoints[kart._lastCp] || this.checkpoints[0];
      const next = this.checkpoints[(kart._lastCp + 1) % this.checkpoints.length];
      pose = {
        x: cp.x, y: cp.y || 0, z: cp.z,
        heading: Math.atan2(next.x - cp.x, next.z - cp.z),
      };
    }
    kart.state.x = pose.x;
    kart.state.y = pose.y || 0;
    kart.state.z = pose.z;
    kart.state.heading = pose.heading;
    kart.state.speed = 0;
    kart.state.vy = 0;
    kart.state.airborne = false;
    kart.state.groundY = pose.y || 0;
    kart.state.lastS = undefined; // re-acquire section after respawn teleport
    kart.state.agSection = -1;    // a respawn drops out of any anti-grav section
    kart._offroadTime = 0;

    // CATCH-UP: getting sent back (fell off the edge / stuck off-road) hands a HUMAN
    // a comeback power-up, like Mario Kart — so "you get a power-up after dying".
    // Only when a slot is free (a full hand keeps what it holds); emits a pickup so
    // the phone + TV item HUD update immediately.
    if (!kart.isAI && this.itemSystem.hasFreeSlot(kart.id)) {
      const REWARDS = ['mushroom', 'star', 'tripleMushroom', 'bulletBill'];
      const reward = REWARDS[Math.floor(Math.random() * REWARDS.length)];
      this.itemSystem.giveItem(kart.id, reward);
      if (events) events.push({ kind: 'pickup', id: kart.id, item: reward });
    }
  }
}

// ===========================================================================
// PURE INPUT NORMALIZER
// ===========================================================================
/**
 * Coerce a (possibly partial / untrusted) network input into the exact shape
 * stepKart expects, clamping numeric ranges. A missing input (player hasn't sent
 * one yet) becomes a neutral "coast" input so a fresh kart sits still rather than
 * crashing the step.
 * @param {object|undefined} input
 * @returns {{steer:number,throttle:number,brake:number,drift:boolean,useItem:boolean,lookBack:boolean}}
 */
function normalizeInput(input) {
  if (!input) {
    return { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, lookBack: false, overdrive: false };
  }
  return {
    steer: clamp(num(input.steer), -1, 1),
    throttle: clamp(num(input.throttle), 0, 1),
    brake: clamp(num(input.brake), 0, 1),
    drift: !!input.drift,
    useItem: !!input.useItem,
    lookBack: !!input.lookBack,
    overdrive: !!input.overdrive, // AURABORNE: must pass through or MP desyncs (client predicts the surge)
  };
}

// ===========================================================================
// SMALL UTILITIES
// ===========================================================================
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function round5(v) { return Math.round(v * 100000) / 100000; }
function nowMs() {
  // High-resolution monotonic clock in milliseconds.
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

/**
 * Checkpoint indices that get a row of item boxes, spaced EVENLY across the loop.
 * MUST match the client's ItemBox._rowCheckpoints byte-for-byte so a server pickup
 * lines up with a rendered box on every (now-long) track. Skips index 0 (start
 * line) and never asks for more rows than there are gates. Deterministic.
 * @param {number} cpCount
 * @returns {number[]}
 */
function boxRowCheckpoints(cpCount) {
  if (cpCount <= 1) return [];
  const rows = Math.min(NUM_BOX_ROWS, cpCount - 1);
  const out = [];
  let prev = -1;
  for (let r = 0; r < rows; r++) {
    let idx = 1 + Math.round(((r + 0.5) / rows) * (cpCount - 1));
    if (idx >= cpCount) idx = cpCount - 1;
    if (idx <= prev) idx = prev + 1;
    if (idx >= cpCount) break;
    out.push(idx);
    prev = idx;
  }
  return out;
}

// ===========================================================================
// INLINE TRACK FALLBACK
// ===========================================================================
// Mirrors src/entities/Track.js's stadium geometry EXACTLY so the server can run
// before shared/trackData.js exists. Once the track-data module is present, the
// Room delegates to it and these are never called. Kept here (not exported) so we
// don't fight the track-data module over the shared namespace.

const FB = { roadWidth: 14, straightX: 35, halfStraight: 45 };
FB.endRadius = FB.straightX;
const FB_START = { x: FB.straightX, y: 0, z: -35, heading: 0 };

/** Stadium centerline gates, ordered in driving direction, index 0 at start. */
function fallbackCheckpoints() {
  const sx = FB.straightX, hs = FB.halfStraight, r = FB.endRadius;
  const pts = [];
  const straightGates = 3, arcGates = 5;
  for (let i = 0; i < straightGates; i++) pts.push({ x: sx, z: -hs + (i / straightGates) * (2 * hs) });
  for (let i = 0; i < arcGates; i++) { const a = (i / arcGates) * Math.PI; pts.push({ x: r * Math.cos(a), z: hs + r * Math.sin(a) }); }
  for (let i = 0; i < straightGates; i++) pts.push({ x: -sx, z: hs - (i / straightGates) * (2 * hs) });
  for (let i = 0; i < arcGates; i++) { const a = (i / arcGates) * Math.PI; pts.push({ x: -r * Math.cos(a), z: -hs - r * Math.sin(a) }); }

  let bestIdx = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - FB_START.x, dz = pts[i].z - FB_START.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  const ordered = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(bestIdx + i) % pts.length];
    ordered.push({ x: p.x, z: p.z, index: i });
  }
  ordered[0].x = FB_START.x;
  ordered[0].z = FB_START.z;
  return ordered;
}

/** Staggered grid behind the start line (mirrors RaceManager._gridPose). */
function fallbackStartGrid(fieldSize) {
  const start = FB_START;
  const heading = start.heading;
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const rx = fz, rz = -fx;
  const GRID_COLS = 2, GRID_ROW_GAP = 5.0, GRID_COL_GAP = 4.0;
  const maxOffset = (FB.roadWidth / 2) - 1.5;
  const grid = [];
  for (let i = 0; i < fieldSize; i++) {
    const row = Math.floor(i / GRID_COLS);
    const col = i % GRID_COLS;
    const colOffset = (col - (GRID_COLS - 1) / 2) * GRID_COL_GAP;
    const clampedCol = Math.max(-maxOffset, Math.min(maxOffset, colOffset));
    const backOff = 3.0 + row * GRID_ROW_GAP;
    grid.push({
      x: start.x - fx * backOff + rx * clampedCol,
      y: start.y,
      z: start.z - fz * backOff + rz * clampedCol,
      heading,
    });
  }
  return grid;
}

/** Point-in-road test for the stadium (mirrors Track.isOnRoad). */
function fallbackIsOnRoad(x, z) {
  const sx = FB.straightX, hs = FB.halfStraight, r = FB.endRadius, halfW = FB.roadWidth / 2;
  let dist;
  if (z >= -hs && z <= hs) {
    dist = Math.abs(Math.abs(x) - sx);
  } else {
    const cz = z > hs ? hs : -hs;
    const dz = z - cz;
    const radial = Math.sqrt(x * x + dz * dz);
    dist = Math.abs(radial - r);
  }
  return dist <= halfW;
}
