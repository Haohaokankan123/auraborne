// src/modes/TimeTrial.js
//
// TIME TRIAL (solo time attack with a GHOST).
//
// A single-player driving mode that strips the race down to ONE kart and one
// goal: set the fastest lap you can. There are no AI rivals, no items, and no
// projectiles — just you, the clock, and the translucent "ghost" of your own
// previous best lap replaying alongside you so you can race the line you drove.
//
// It reuses the EXACT same simulation pieces as the Grand Prix race so the
// physics feel is identical:
//   - shared/kartModel.js  via  src/physics/KartPhysics.js  (deterministic step
//     + ground/surface/wall resolution against the Track),
//   - src/race/LapSystem.js                                 (checkpoint + lap +
//     best-lap tracking, totally pure logic),
//   - src/entities/Kart.js                                  (the procedural kart
//     mesh, used once for the player and once — translucent — for the ghost).
//
// What this module adds on top of those:
//   1. RECORDING. Every fixed tick we push a compact sample
//        { t, x, y, z, heading }
//      (t = seconds since THIS lap began) into a per-lap buffer. When a lap is
//      completed we hand that buffer to the lap system's best-lap check.
//   2. PERSISTENCE. When a lap beats the stored best, we save that lap's
//      recording + time to localStorage (key 'tt_ghost_v1'). On construction we
//      load any stored ghost so a fresh session immediately has something to
//      chase. Saved per-track so different tracks keep separate ghosts.
//   3. GHOST PLAYBACK. A SECOND kart mesh, rendered translucent (opacity ~0.4),
//      replays the saved best-lap buffer by elapsed lap time, interpolating
//      between the two samples that bracket the current lap clock. Hidden until
//      a ghost exists.
//   4. HUD. We feed the shared HUD the current lap time + best lap, and compute
//      a live DELTA vs the ghost (how far ahead/behind the ghost you are right
//      now) which we surface on a small dedicated overlay element.
//
// Two-clock contract (matches RaceManager / main.js):
//   - update(dt)  runs at a FIXED 60Hz. All simulation + recording happens here.
//   - render(dt)  runs once per painted frame. Visual sync only (kart meshes,
//                 chase camera, ghost playback, HUD).
//
// PRESERVES the rest of the game: this is a brand-new, self-contained mode file.
// It owns its kart meshes and one HUD overlay element, all removed in dispose().

import * as THREE from 'three';

import { Kart } from '../entities/Kart.js';
import { KartPhysics } from '../physics/KartPhysics.js';
import { LapSystem } from '../race/LapSystem.js';

// Fixed-timestep render interpolation. DT is the fixed sim step; makeRenderState
// blends a kart's PREVIOUS physics-tick transform with its CURRENT one by the
// loop's `alpha` so the kart draws a smooth in-between frame instead of stepping
// at a discrete 60Hz (which reads as turn judder at 120-240fps paint rates).
import { DT } from '../core/Loop.js';
import { makeRenderState } from '../core/interpolate.js';

// The pure kart-state factory. createKartState({ stats, ...spawnPose }) gives us
// a deterministic state seeded with the player's chosen stat profile (or a
// neutral mid profile when omitted — see the M5 stats contract).
import {
  createKartState,
  applyMushroomBoost,
  applySpin,
  launchKart,
} from '../../shared/kartModel.js';

// Pure track-surface + feature helpers (NO three): the SAME math the race + server
// use, so the time-trial kart rides the identical hills / ramps / boost pads.
// TARGET_LAP_TIMES is the pure per-track gold/silver/bronze medal threshold data.
import {
  sampleSurface,
  listFeatures,
  respawnPoint,
  respawnIfFallen,
  TARGET_LAP_TIMES,
  updateAntigravTransition,
} from '../../shared/trackData.js';

// Persistent records: store the best lap per track and decide the medal earned.
import { recordBestLap, medalFor } from '../data/playerStats.js';

// Ramp-launch gate constants (min speed + base launch velocity).
import { PHYSICS } from '../../shared/constants.js';

// localStorage key for the persisted best-lap ghost. Versioned ('_v1') so a
// future change to the sample shape can bump the key and ignore stale data.
const GHOST_STORAGE_KEY = 'tt_ghost_v1';

// Medal -> emoji, for the lap-complete banner + the ghost badge.
const MEDAL_EMOJI = { gold: '🥇', silver: '🥈', bronze: '🥉' };

export class TimeTrial {
  /**
   * @param {object} args
   * @param {THREE.Scene} args.scene      render scene; kart + ghost meshes are added here.
   * @param {object} args.track           the Track instance (checkpoints, colliders,
   *                                       startPosition, roadWidth, isOnRoad). Same
   *                                       object the RaceManager consumes.
   * @param {object} args.renderer        the Renderer (chase camera follows the player).
   * @param {object} args.input           the player Input instance (getState()).
   * @param {object} args.hud             the shared HUD instance (lap/best/speed panel).
   * @param {object} [args.selection]     the player's car selection:
   *                                       { color:number|string, stats:StatProfile }.
   *                                       Both optional — color defaults to red and
   *                                       stats default to the neutral mid profile.
   * @param {string} [args.trackId]        M6: the chosen track id, so the ghost is
   *                                       stored per-track. Defaults to the track's
   *                                       own id ('circuit') when omitted.
   */
  constructor({ scene, track, renderer, input, hud, audio, selection = {}, trackId }) {
    this.scene = scene;
    this.track = track;
    this.renderer = renderer;
    this.input = input;
    this.hud = hud;
    // Optional AudioManager — used for the respawn chirp + a new-record fanfare.
    // Absent in headless/test glue, so every use is guarded.
    this.audio = audio || null;
    this.selection = selection;

    // Track identity for per-track ghost storage. Prefer an explicit trackId (M6
    // track-select passes the registry key), then the Track's own .trackId/.id,
    // and finally a constant so a track without an id still gets a stable slot.
    this.trackId = trackId || (track && (track.trackId || track.id)) || 'circuit';

    // TERRAIN (Phase 3): resolve this track's features ONCE (boost/ramp/hazard in
    // world space) + per-tick bookkeeping for rising-edge feature effects and the
    // offroad/fallen respawn safety net. Identical math to the race + server.
    this.features = listFeatures(this.trackId);
    this._prevSurface = 'road'; // last surface, for rising-edge ramp/boost
    this._offroadTime = 0;      // continuous seconds off the road (respawn trigger)
    this._lastCp = 0;           // last checkpoint passed (respawn target)

    // --- Player kart: deterministic state + procedural mesh. -----------------
    // Spawn at the track's start pose, seeded with the selection's stat profile.
    // createKartState spreads its opts LAST, so { stats, ...startPosition } sets
    // both the stats and the spawn x/y/z/heading in one go. Omitting stats keeps
    // the neutral default (identical to today's karts).
    const startPose = track.startPosition;
    this.playerState = createKartState({
      stats: selection.stats, // undefined -> neutral mid profile (backward compatible)
      ...startPose,
    });

    // The visible player kart (procedural geometry). Color from the selection.
    this.playerKart = new Kart({
      color: selection.color !== undefined ? selection.color : 0xff3b30,
    });
    // ANTI-GRAV: let the visual re-derive the surface frame so it rides walls/ceiling.
    this.playerKart._trackId = this.trackId;
    this.scene.add(this.playerKart.group);

    // Render interpolation: the player kart's PREVIOUS physics-tick transform.
    // Seeded to the spawn pose so the very first frame has a valid prev to blend
    // from. Each fixed update() copies the live state into this BEFORE stepping
    // physics, so render() can lerp prev->cur by the loop's alpha (see render()).
    this.playerPrevTransform = {
      x: this.playerState.x,
      y: this.playerState.y,
      z: this.playerState.z,
      heading: this.playerState.heading,
    };

    // ONE physics wrapper, reused every tick for the single player kart (the
    // ghost is pure playback — it never runs physics). KartPhysics holds only a
    // raycaster + scratch vectors, so one instance is all we need.
    this.physics = new KartPhysics();

    // --- Lap system: one racer ('player'). ----------------------------------
    // Same pure lap/checkpoint tracker the race uses; it gives us nextCp, lap
    // counting, lapStart, lapTimes, and bestLap for free.
    // ENDLESS hot-lapping: pass Infinity so the racer is never marked finished.
    // With a finite cap, LapSystem.update() flips rec.finished at lap N and then
    // returns early every tick — freezing checkpoint/lap counting, so
    // _onLapCompleted would never fire again and no later lap could beat the PB
    // without quitting the mode. It also stops main.js firing a phantom finish
    // fanfare + confetti mid-session. The HUD lap label is derived in render().
    this.lapSystem = new LapSystem(track, Infinity);
    this.lapSystem.addRacer('player');

    // --- Recording state. ----------------------------------------------------
    // Monotonic simulation clock (seconds), advanced by dt every tick. Drives
    // lap timing AND each sample's absolute time; sample.t below is RELATIVE to
    // the current lap's start so playback can index by elapsed lap time.
    this.simClock = 0;

    // The buffer of samples for the CURRENT (in-progress) lap. Each entry is
    // { t, x, y, z, heading } with t = seconds since this lap began. Reset to a
    // fresh array each time a lap boundary is crossed (see _onLapBoundary).
    this.currentRecording = [];

    // The lap count we last saw from the lap system, so we can detect the
    // moment a lap completes (lap counter increments) and react to it.
    this._lastLap = 0;

    // True once the player has crossed the start line for the first time (the
    // lap clock has actually started). Until then we don't record — the kart is
    // sitting on the grid and those samples would pollute the buffer.
    this._lapTimingStarted = false;

    // START LOCK: the kart is frozen on the grid until the 3-2-1-GO countdown
    // hits GO, exactly like the Grand Prix. main.js drives the countdown overlay
    // + beeps and calls release() on GO. While locked, update() does nothing — no
    // physics, no clock, no recording — so the run has a clean, gated start and
    // the lap timer only begins once the player actually launches.
    this._locked = true;

    // --- Ghost: the saved best-lap recording + a translucent replay kart. ----
    // Load any persisted ghost for this track. ghost = { time, samples } or null.
    this.ghost = this._loadGhost();

    // Build the translucent ghost kart mesh (same procedural Kart, dimmed). It
    // is hidden until a ghost recording exists to play back.
    this.ghostKart = new Kart({
      color: selection.color !== undefined ? selection.color : 0xff3b30,
    });
    this._makeKartTranslucent(this.ghostKart, 0.4);
    this.ghostKart.group.visible = !!this.ghost; // hidden if no ghost saved yet
    this.scene.add(this.ghostKart.group);

    // Floating "GHOST · <best time>" badge that hovers above the ghost kart so it
    // reads as a replay, not a confusing twin. A canvas-textured sprite parented
    // to the ghost group, so it follows + always faces the camera for free.
    this._buildGhostBadge();
    if (this.ghost) this._setGhostBadge(this.ghost.time);

    // A neutral state object the ghost kart's syncFromState reads each frame.
    // We only ever set x/y/z/heading on it (from interpolated samples); every
    // other field stays at its createKartState default so no drift/star/spin
    // visuals fire on the ghost.
    this.ghostState = createKartState({});

    // --- HUD delta overlay. --------------------------------------------------
    // A small element showing the live time delta vs the ghost (e.g. "-0.42s"
    // means you're 0.42s AHEAD of where the ghost was at the same lap distance,
    // "+0.42s" means behind). Built here, removed in dispose().
    this.deltaElement = this._buildDeltaElement();

    // The player's best REAL lap so far (their PB), used to compute the live medal
    // goal AND the HUD's BEST field. Seed from the persisted ghost ONLY when it's a
    // real recorded PB — never the bundled STAFF benchmark — otherwise null until
    // the first completed lap.
    this._bestLap = (this.ghost && !this.ghost.staff) ? this.ghost.time : null;

    // Persistent medal-goal hint ("NEXT 🥈 2:25") sitting just under the delta, so
    // the run always has a visible target instead of only a transient lap banner.
    this.goalElement = this._buildGoalElement();
    this._updateGoalDisplay();

    // The player's last steer, mirrored so render() can angle the front wheels
    // to match the live input (render must not poll Input itself — same reason
    // the RaceManager caches _playerLastSteer).
    this._playerLastSteer = 0;

    // QUICK RESTART: tap R to soft-reset the run in place (see _restart). R is the
    // one free key — W/S/A/D/Space/Shift/E/F/Q are all bound in Input.js. Ignored
    // while locked on the grid (pre-GO) and on auto-repeat. Removed in dispose().
    this._onRestartKey = (e) => {
      if (e.code === 'KeyR' && !e.repeat && !this._locked) this._restart();
    };
    window.addEventListener('keydown', this._onRestartKey);
  }

  /**
   * Release the start lock — the kart can now drive. Called by main.js's start
   * countdown the instant it hits GO (it calls manager.release() for any mode
   * that defines it), so the time-trial launch is gated to GO just like the GP.
   */
  release() {
    this._locked = false;
  }

  /**
   * QUICK RESTART (the R key): soft-reset the run in place — kart back to the grid
   * pose, clock + recording + lap progress zeroed — WITHOUT rebuilding the scene or
   * replaying main.js's 3-2-1 countdown. The loaded ghost is KEPT so you instantly
   * re-race the same line. Mirrors the constructor's fresh-start conditions exactly,
   * so the first timed lap after a restart times identically to a fresh launch.
   * No-op while still locked on the grid (pre-GO).
   * ponytail: stays unlocked (release() already fired on the first GO); add a
   * countdown-on-restart only if main.js later exposes a re-arm hook.
   * @private
   */
  _restart() {
    // Re-seed the deterministic state at the start pose: this resets EVERY field
    // (speed, vy, airborne, drift, miniTurbo, agSection, spinTimer, …) to its
    // createKartState default, so no stale momentum/spin carries into the retry.
    this.playerState = createKartState({
      stats: this.selection.stats,
      ...this.track.startPosition,
    });

    // Reset the render-interpolation prev-pose to the new spawn so the first frame
    // after the restart doesn't streak the kart from its old mid-track position.
    const pt = this.playerPrevTransform;
    pt.x = this.playerState.x;
    pt.y = this.playerState.y;
    pt.z = this.playerState.z;
    pt.heading = this.playerState.heading;
    this._playerLastSteer = 0;

    // Fresh lap record (addRacer overwrites the 'player' entry: nextCp=1,
    // started=false, lapStart=0, lap=0).
    this.lapSystem.addRacer('player');

    // Zero all timing + recording + terrain bookkeeping back to construction state.
    this.simClock = 0;
    this.currentRecording = [];
    this._lastLap = 0;
    this._lapTimingStarted = false;
    this._prevSurface = 'road';
    this._offroadTime = 0;
    this._lastCp = 0;

    // Quick screen-flash so the reset reads as deliberate, not a glitch (reuses the
    // pooled respawn flash; guarded — it's a TT-added HUD method).
    if (this.hud && typeof this.hud.respawnFlash === 'function') this.hud.respawnFlash();
  }

  // ========================================================================
  // FIXED-STEP UPDATE (called at exactly 60Hz; dt === DT).
  // ========================================================================
  /**
   * Advance the time trial by one fixed step: read input, step the player kart,
   * advance lap progress, record this tick's sample, and handle lap boundaries
   * (which is where a new best lap gets saved as the ghost).
   *
   * @param {number} dt  fixed timestep in seconds (DT).
   */
  update(dt) {
    // START LOCK: frozen on the grid until GO. Skip the whole step so nothing
    // moves, no clock advances, and no samples are recorded pre-launch.
    if (this._locked) return;

    // Advance the monotonic sim clock first so this tick's lap timing + sample
    // timestamps use post-step time (mirrors main.js's raceClock ordering).
    this.simClock += dt;

    // 1. Read the player's controls and step the deterministic model against the
    //    track (ground height, road/offroad surface, wall response).
    const input = this.input.getState();
    this._playerLastSteer = input.steer;
    // BEFORE stepping: bank this tick's pre-step pose as the "previous" transform
    // (mutate in place — no per-tick allocation). After physics.update() runs,
    // playerState becomes the "current" transform; render() blends prev->cur.
    const pt = this.playerPrevTransform;
    pt.x = this.playerState.x;
    pt.y = this.playerState.y;
    pt.z = this.playerState.z;
    pt.heading = this.playerState.heading;

    // TERRAIN (Phase 3): sample the shared surface at the kart's CURRENT position
    // and hand groundY/slope/surface to stepKart so it rides the hills + applies
    // the slope/offroad effects. The _hillTerrain flag tells KartPhysics stepKart
    // now owns y (no raycast overwrite). Same pure math as the race + server.
    const surf = sampleSurface(this.trackId, this.playerState.x, this.playerState.z, this.playerState.y, this.playerState.lastS);
    this.playerState.groundY = surf.groundY;
    this.playerState.slope = surf.slope;
    this.playerState.surface = surf.surface;
    this.playerState.lastS = surf.s; // continuity hint for next frame (overpass fix)
    this.playerState._hillTerrain = true;

    // ANTI-GRAV (MK8 wall/ceiling riding): same pure entry/exit transition + ordering
    // as the race + server, so a Time Trial on Rainbow Ridge rides the corkscrew too.
    // No-op on tracks without an anti-grav section.
    updateAntigravTransition(this.playerState, this.trackId, surf);

    // RAMP launch (rising edge) + BOOST pad (rising edge), scaled by speed.
    if (
      surf.surface === 'ramp' &&
      this._prevSurface !== 'ramp' &&
      this.playerState.speed >= PHYSICS.RAMP_LAUNCH_MIN_SPEED
    ) {
      const speedFrac = Math.min(this.playerState.speed / PHYSICS.MAX_SPEED, 1.4);
      launchKart(this.playerState, PHYSICS.RAMP_LAUNCH_VY * (0.7 + 0.5 * speedFrac));
    }
    if (surf.surface === 'boost' && this._prevSurface !== 'boost') {
      applyMushroomBoost(this.playerState);
    }
    this._prevSurface = surf.surface;

    this.physics.update(this.playerState, input, dt, this.track);

    // HAZARD contact: spin out on touching an oil/cone hazard feature.
    this._checkHazards();

    // 2. Advance lap / checkpoint progress on the sim clock. The lap system sets
    //    `started` when the kart first leaves the line and bumps `lap` (and
    //    records the lap time into bestLap) when the line is re-crossed.
    const prog = this.lapSystem.update('player', this.playerState, this.simClock);

    // Remember the last checkpoint passed (nextCp - 1) as the respawn target.
    if (prog) {
      const n = this.track.checkpoints.length;
      this._lastCp = ((prog.nextCp - 1) % n + n) % n;
    }

    // SAFETY NET (no walls): respawn the player if it has been off the road too
    // long OR fallen below the track surface — back onto the road centerline at
    // the last checkpoint, speed cut + jump cleared. Lap progress is untouched.
    this._maybeRespawn(surf, dt);

    // BACKSTOP: the legacy fell-into-the-void snap, for the rare deep-fall case.
    // No-op on flat tracks (elevation 0).
    const elevation = this.track.elevation || 0;
    if (elevation > 0) {
      respawnIfFallen(
        this.playerState,
        this.track.checkpoints,
        elevation,
        prog ? prog.nextCp : 0,
      );
    }

    // 3. Detect the start of lap timing. Once the kart has crossed the line the
    //    first time, lapStart is set and `started` is true — from that point on
    //    we record samples relative to the current lapStart.
    if (prog && prog.started && !this._lapTimingStarted) {
      this._lapTimingStarted = true;
      // Begin a fresh recording for the first timed lap.
      this.currentRecording = [];
    }

    // 4. Detect a completed lap (the lap counter went up since last tick). When
    //    it does, the just-finished lap's buffer is in currentRecording and its
    //    time is the most recent entry in prog.lapTimes — decide if it's a new
    //    best and, if so, persist it as the ghost. Then start a fresh buffer.
    if (prog && prog.lap > this._lastLap) {
      this._lastLap = prog.lap;
      this._onLapCompleted(prog);
    }

    // 5. Record THIS tick's sample for the current lap (only once timing has
    //    begun). t is seconds since the current lap's start so ghost playback
    //    can index purely by elapsed lap time.
    if (this._lapTimingStarted && prog) {
      const lapT = this.simClock - prog.lapStart;
      this.currentRecording.push({
        t: lapT,
        x: this.playerState.x,
        y: this.playerState.y,
        z: this.playerState.z,
        heading: this.playerState.heading,
      });
    }
  }

  /**
   * Handle a just-completed lap: if its time beats the stored best, save its
   * recording + time as the new ghost (in memory + localStorage). Either way,
   * start a fresh recording buffer for the lap now underway.
   *
   * The completed lap's time is the LAST entry pushed into prog.lapTimes by the
   * lap system this tick; its samples are the buffer we were filling.
   *
   * @param {object} prog  the player's lap-system progress record.
   * @private
   */
  _onLapCompleted(prog) {
    // The duration of the lap that just finished (seconds).
    const lapTime = prog.lapTimes.length > 0
      ? prog.lapTimes[prog.lapTimes.length - 1]
      : null;

    // The buffer we filled during that lap. Copy the reference; we replace
    // currentRecording with a fresh array below so the next lap records cleanly.
    const finishedSamples = this.currentRecording;

    // A lap is a new best when it has a valid time AND either no ghost exists
    // yet or it is faster than the stored ghost time.
    const beatsBest =
      lapTime != null &&
      finishedSamples.length > 1 &&
      (!this.ghost || lapTime < this.ghost.time);

    if (beatsBest) {
      // Promote this lap to the active ghost and persist it.
      this.ghost = { time: lapTime, samples: finishedSamples };
      this._saveGhost(this.ghost);
      // Reveal the ghost kart now that we have a recording to play back.
      this.ghostKart.group.visible = true;
    }

    // RECORDS + MEDAL + SPLIT feedback. Persist the lap to the player's stats
    // (best-per-track) and work out the medal it earned against this track's
    // targets, then flash a HUD banner: a celebratory "NEW RECORD!" when it beats
    // the stored best, otherwise the lap SPLIT with its medal. recordBestLap is the
    // source of truth for "is this a record"; the ghost above is just the replay.
    if (lapTime != null) {
      const isRecord = recordBestLap(this.trackId, lapTime);
      // Track the player's best REAL lap (drives the medal goal + HUD BEST field).
      if (this._bestLap == null || lapTime < this._bestLap) this._bestLap = lapTime;
      const medal = medalFor(lapTime, TARGET_LAP_TIMES[this.trackId]);
      if (this.hud && typeof this.hud.showRewardBanner === 'function') {
        const lapStr = this._fmtLap(lapTime);
        const badge = medal ? MEDAL_EMOJI[medal] + ' ' : '';
        this.hud.showRewardBanner(
          isRecord
            ? 'NEW RECORD! ' + badge + lapStr
            : 'LAP ' + lapStr + (medal ? '  ' + badge + medal.toUpperCase() : '')
        );
      }
      // A little fanfare for a fresh personal best.
      if (isRecord && this.audio && typeof this.audio.sfxFinish === 'function') {
        this.audio.sfxFinish();
      }
      // Keep the floating ghost badge in sync with the (possibly new) best time.
      if (beatsBest) this._setGhostBadge(this.ghost.time);
      // Refresh the persistent medal-goal hint now this lap may have earned a medal.
      this._updateGoalDisplay();
    }

    // Start a clean buffer for the lap now in progress.
    this.currentRecording = [];
  }

  // ========================================================================
  // RENDER (called once per painted frame).
  // ========================================================================
  /**
   * Sync the visuals: the player kart mesh, the chase camera, the ghost replay,
   * and the HUD (lap time, best lap, and live delta vs the ghost). No simulation
   * here — purely reads the latest state.
   *
   * @param {number} alpha  the loop's interpolation factor in [0, 1): how far
   *                        real time sits between the last two physics ticks.
   *                        Position + heading are blended prev->cur by alpha to
   *                        kill 60Hz turn judder. The fixed DT (imported from
   *                        core/Loop.js) still drives the kart's internal wheel /
   *                        spark / lerp animation so those stay rate-consistent.
   */
  render(alpha) {
    // 1. Player kart mesh. Build an interpolated render state: a shallow copy of
    //    the live state with x/y/z lerped and heading shortest-arc-lerped between
    //    the previous and current physics ticks by alpha. All other visual fields
    //    (drifting, miniTurboTier, spinTimer, ...) come through live from cur.
    //    syncFromState still gets the fixed DT for the wheel-roll animation.
    const playerRs = makeRenderState(this.playerPrevTransform, this.playerState, alpha);
    this.playerKart.syncFromState(playerRs, DT, this._playerLastSteer);

    // 2. Chase camera follows the player's interpolated transform (so the camera
    //    tracks the smooth render pose, not the discrete 60Hz one).
    if (this.renderer) {
      this.renderer.updateChaseCamera(playerRs, DT, this.trackId);
    }

    // 3. Ghost playback: place the translucent ghost kart at the position the
    //    saved best lap was at THIS many seconds into its lap. simClock only
    //    advances on fixed ticks, so we add alpha*DT to nudge the playback time
    //    smoothly between ticks — the ghost's time-indexed replay then advances
    //    at the paint rate and stops juddering alongside the player.
    const prog = this.lapSystem.getProgress('player');
    const lapElapsed = prog && this._lapTimingStarted
      ? this.simClock - prog.lapStart + alpha * DT
      : 0;
    this._updateGhost(lapElapsed, DT);

    // 4. HUD: current lap time, best lap, mini-turbo pill, speed (all via the
    //    shared HUD), then our own delta overlay.
    if (this.hud) {
      // ENDLESS laps: show the REAL climbing lap number (4, 5, …) — never a frozen
      // "3/3". The shared HUD clamps the displayed lap to totalLaps, so the
      // denominator must stay AT LEAST the current lap. We keep it exactly one
      // above (lap+1) so the lap is always shown in full AND the HUD's "FINAL LAP"
      // alert (fires on lap >= totalLaps) never false-triggers — there is no final
      // lap in an endless time attack, and a sticky red lap pill would be a bug.
      const displayLap = (prog ? prog.lap : 0) + 1;
      const info = {
        lap: displayLap,
        totalLaps: displayLap + 1,
        // Solo run: always 1st of 1 (the HUD still wants these to render).
        position: 1,
        totalRacers: 1,
        // Current lap elapsed time. Before the first line cross lapStart is 0,
        // so this reads the time-on-track so far (which is fine pre-start).
        lapTime: lapElapsed,
        // BEST = your PB only. Use the ghost's time as BEST only when it's a REAL
        // recorded lap, not the bundled STAFF benchmark (which isn't your record);
        // otherwise the lap system's in-session best (null until the first lap, so
        // the HUD shows its "--:--.---" placeholder).
        bestLap: (this.ghost && !this.ghost.staff) ? this.ghost.time : (prog ? prog.bestLap : null),
        miniTurboTier: this.playerState.miniTurboTier,
      };
      this.hud.update(this.playerState, info);
    }

    // 5. Live delta vs ghost, shown on our dedicated overlay.
    this._updateDeltaDisplay(lapElapsed);
  }

  /**
   * Position the ghost kart for the current lap-elapsed time by interpolating
   * between the two saved samples that bracket `lapElapsed`. If we are past the
   * end of the ghost recording (you've driven longer into the lap than the
   * ghost's lap lasted) the ghost simply rests on its final sample.
   *
   * @param {number} lapElapsed  seconds since the current lap began (already
   *                             nudged by alpha*DT so the time-indexed replay
   *                             advances smoothly between fixed ticks).
   * @param {number} dt          fixed DT for the ghost kart's wheel-roll visual
   *                             sync (position itself comes from lapElapsed).
   * @private
   */
  _updateGhost(lapElapsed, dt) {
    if (!this.ghost || !this.ghostKart.group.visible) return;

    const samples = this.ghost.samples;
    if (!samples || samples.length === 0) return;

    // Find the sample pair [a, b] with a.t <= lapElapsed <= b.t. A linear scan
    // from the end is fine: lapElapsed advances monotonically within a lap and
    // the buffers are small (~one lap of 60Hz samples). We keep it simple and
    // robust rather than caching an index across frames.
    let a = samples[0];
    let b = samples[samples.length - 1];

    if (lapElapsed <= samples[0].t) {
      // Before the recording starts: sit on the first sample.
      a = b = samples[0];
    } else if (lapElapsed >= samples[samples.length - 1].t) {
      // Past the end of the recording: rest on the last sample.
      a = b = samples[samples.length - 1];
    } else {
      // Walk forward to the first sample whose time is >= lapElapsed; that and
      // the previous sample bracket the moment we want.
      for (let i = 1; i < samples.length; i++) {
        if (samples[i].t >= lapElapsed) {
          a = samples[i - 1];
          b = samples[i];
          break;
        }
      }
    }

    // Interpolation factor between a and b (0 at a, 1 at b). Guard a zero-length
    // span (identical timestamps) so we never divide by zero.
    const span = b.t - a.t;
    const f = span > 1e-6 ? (lapElapsed - a.t) / span : 0;

    // Linearly interpolate position; for heading we lerp the shortest angular
    // way so the ghost doesn't spin the long way around at the +/-PI wrap.
    this.ghostState.x = a.x + (b.x - a.x) * f;
    this.ghostState.y = a.y + (b.y - a.y) * f;
    this.ghostState.z = a.z + (b.z - a.z) * f;
    this.ghostState.heading = this._lerpAngle(a.heading, b.heading, f);

    // Drive the ghost kart's visuals from the interpolated state. steer = 0:
    // the ghost's front wheels stay straight (we don't record steer input).
    this.ghostKart.syncFromState(this.ghostState, dt, 0);
  }

  /**
   * Compute and display the live delta vs the ghost: how far AHEAD (negative) or
   * BEHIND (positive) the player is compared to the ghost, in seconds.
   *
   * Method: find the ghost's lap time at the player's CURRENT track position by
   * locating the nearest saved sample to the player, then compare that sample's
   * `t` (when the ghost was at that spot) to the player's current lapElapsed.
   *   delta = playerLapElapsed - ghostTimeAtSamePlace
   *   delta < 0  -> player reached this spot SOONER than the ghost did = ahead.
   *   delta > 0  -> player is slower here = behind.
   *
   * @param {number} lapElapsed  player's seconds since the current lap began.
   * @private
   */
  _updateDeltaDisplay(lapElapsed) {
    // Label tracks whether we're chasing the bundled STAFF ghost or our own PB.
    const ghostLabel = (this.ghost && this.ghost.staff) ? 'STAFF' : 'GHOST';

    // No ghost or no timed lap yet: show a neutral placeholder.
    if (!this.ghost || !this._lapTimingStarted) {
      this.deltaElement.textContent = ghostLabel + ' --';
      this.deltaElement.style.color = '#cccccc';
      return;
    }

    const samples = this.ghost.samples;
    // Nearest saved sample to the player's current XZ position — but ONLY among
    // samples whose lap time is within DELTA_WINDOW seconds of the player's current
    // lap time. Both player and ghost progress monotonically through the lap, so the
    // ghost passed the player's CURRENT spot at roughly the player's CURRENT time;
    // the time gate stops a self-crossing track (Cloudtop's figure-8) from matching
    // the geometrically-near sample on the OTHER arm of the lap — which would snap
    // the delta by tens of seconds at the crossover.
    const DELTA_WINDOW = 4;
    let nearest = null;
    let bestD2 = Infinity;
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i].t - lapElapsed) > DELTA_WINDOW) continue;
      const dx = samples[i].x - this.playerState.x;
      const dz = samples[i].z - this.playerState.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        nearest = samples[i];
      }
    }
    // Fallback: the player is >DELTA_WINDOW off the ghost's pace here, so no sample
    // sits in the time window — use the globally nearest sample so the delta still
    // reads (the cross-arm ambiguity only matters near even pace, handled above).
    if (!nearest) {
      for (let i = 0; i < samples.length; i++) {
        const dx = samples[i].x - this.playerState.x;
        const dz = samples[i].z - this.playerState.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          nearest = samples[i];
        }
      }
    }

    // delta = how long the PLAYER has taken to reach this spot minus how long the
    // GHOST took. Negative = player ahead, positive = behind.
    const delta = lapElapsed - nearest.t;
    const ahead = delta <= 0;

    // Signed two-decimal gap, green ahead / red behind, with a trailing ▲/▼ so the
    // direction reads WITHOUT relying on colour alone (accessibility).
    const sign = ahead ? '-' : '+';
    const arrow = ahead ? '▲' : '▼';
    const secs = Math.abs(delta).toFixed(2);
    this.deltaElement.textContent = ghostLabel + ' ' + sign + secs + 's ' + arrow;
    this.deltaElement.style.color = ahead ? '#34c759' : '#ff453a';
  }

  // ========================================================================
  // Ghost persistence (localStorage).
  // ========================================================================
  /**
   * Load the ghost for the current track: the player's own persisted best-lap ghost
   * if one exists, else a bundled STAFF ghost so a first-time player always has a
   * credible line to chase. The player's first faster lap overwrites the staff ghost
   * (and persists), exactly as it overwrites a previous personal best.
   * @returns {{time:number, samples:Array, staff?:boolean}|null}
   * @private
   */
  _loadGhost() {
    return this._loadStoredGhost() || this._staffGhost();
  }

  /**
   * Load the persisted personal-best ghost for the current track from localStorage.
   * @returns {{time:number, samples:Array}|null} the stored ghost, or null if
   *   none exists / it's unreadable / it's for a different track.
   * @private
   */
  _loadStoredGhost() {
    try {
      const raw = localStorage.getItem(GHOST_STORAGE_KEY + '_' + this.trackId);
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Stored shape: { trackId, time, samples:[{t,x,y,z,heading}, ...] }.
      // Reject ghosts saved for a different track so lines never mismatch.
      if (!data || data.trackId !== this.trackId) return null;
      if (typeof data.time !== 'number' || !Array.isArray(data.samples)) return null;
      if (data.samples.length < 2) return null;
      return { time: data.time, samples: data.samples };
    } catch (err) {
      // Corrupt / unavailable storage: just play without a stored ghost.
      return null;
    }
  }

  /**
   * Build the bundled STAFF ghost for the current track: plain pre-derived
   * {t,x,y,z,heading} samples that pace the checkpoint loop at a constant speed,
   * timed so a lap takes the track's SILVER target (a solid, beatable benchmark).
   * It is DETERMINISTIC (pure geometry off the checkpoints — no Math.random) and
   * NEVER persisted; once the player sets a faster real lap it's replaced. Badged
   * 'STAFF' so it reads as the developer benchmark rather than a personal best.
   * ponytail: synthesized from the checkpoint loop rather than a recorded hot lap;
   * swap in baked samples here if a recording pipeline is ever added.
   * @returns {{time:number, samples:Array, staff:boolean}|null}
   * @private
   */
  _staffGhost() {
    const cps = this.track && this.track.checkpoints;
    if (!cps || cps.length < 2) return null;

    // Benchmark pace: this track's silver target (fallback ~80s if none defined).
    const targets = TARGET_LAP_TIMES[this.trackId];
    const targetTime = targets && Number.isFinite(targets.silver) ? targets.silver : 80;

    // Cumulative arc length around the checkpoint loop (closing back to cp0), so we
    // can time each sample by distance and hold a constant pace.
    const n = cps.length;
    const segLen = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const a = cps[i];
      const b = cps[(i + 1) % n];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      segLen[i] = d;
      total += d;
    }
    if (total <= 0) return null;

    // One sample per checkpoint (heading aims at the next, matching the model's
    // forward = (sin h, cos h) convention), plus a closing sample at t=targetTime.
    const samples = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const a = cps[i];
      const b = cps[(i + 1) % n];
      samples.push({
        t: (acc / total) * targetTime,
        x: a.x,
        y: a.y != null ? a.y : 0,
        z: a.z,
        heading: Math.atan2(b.x - a.x, b.z - a.z),
      });
      acc += segLen[i];
    }
    const first = cps[0];
    const second = cps[1 % n];
    samples.push({
      t: targetTime,
      x: first.x,
      y: first.y != null ? first.y : 0,
      z: first.z,
      heading: Math.atan2(second.x - first.x, second.z - first.z),
    });

    return { time: targetTime, samples, staff: true };
  }

  /**
   * Persist a ghost (best-lap recording + time) to localStorage, tagged with the
   * current track id. Failures (quota, privacy mode) are swallowed — the ghost
   * still works for the current session, it just won't survive a reload.
   *
   * @param {{time:number, samples:Array}} ghost  the ghost to save.
   * @private
   */
  _saveGhost(ghost) {
    try {
      const payload = {
        trackId: this.trackId,
        time: ghost.time,
        samples: ghost.samples,
      };
      localStorage.setItem(GHOST_STORAGE_KEY + '_' + this.trackId, JSON.stringify(payload));
    } catch (err) {
      // Storage unavailable/full: ignore; the in-memory ghost still plays.
    }
  }

  // ========================================================================
  // Small helpers.
  // ========================================================================
  /**
   * Make every mesh material in a Kart translucent so it reads as a "ghost".
   * Walks the kart's group and switches each material to transparent at the
   * given opacity. Clones the materials first so dimming the ghost never touches
   * the shared materials on the real player kart.
   *
   * @param {Kart} kart      the kart whose meshes to dim.
   * @param {number} opacity 0..1 target opacity (~0.4 for a clear ghost).
   * @private
   */
  _makeKartTranslucent(kart, opacity) {
    kart.group.traverse((object) => {
      if (object.isMesh && object.material) {
        // Clone so the ghost's transparency is independent of the player kart.
        object.material = object.material.clone();
        object.material.transparent = true;
        object.material.opacity = opacity;
        // Don't write depth, so the ghost never punches a hole in the scene or
        // occludes the player kart oddly; it just blends over what's behind it.
        object.material.depthWrite = false;
        // A ghost shouldn't cast shadows — it isn't really there.
        object.castShadow = false;
        // GHOST TINT: wash every part to a cool translucent blue with a soft
        // emissive glow so the replay reads as a hologram, NOT a same-coloured
        // twin of the player kart (which is what made it confusing before).
        if (object.material.color) object.material.color.setHex(0x7cc4ff);
        if (object.material.emissive) {
          object.material.emissive.setHex(0x2f7bff);
          object.material.emissiveIntensity = 0.55;
        }
      }
    });
  }

  /**
   * Build the floating "GHOST · <time>" badge: a canvas-textured sprite parented
   * to the ghost kart group. Sprites always face the camera, so it stays readable
   * from any angle and follows the ghost with zero per-frame work. Drawn empty;
   * _setGhostBadge writes the text (the constructor fills it if a ghost exists).
   * @private
   */
  _buildGhostBadge() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    this._ghostBadgeCanvas = canvas;
    this._ghostBadgeCtx = canvas.getContext('2d');

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter; // crisp text — no mipmaps
    this._ghostBadgeTex = tex;

    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,  // always visible, even through the ghost mesh
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(6, 1.5, 1);    // ~6m wide
    sprite.position.set(0, 3.4, 0); // hovering above the ghost kart
    sprite.renderOrder = 999;
    this._ghostBadge = sprite;
    this.ghostKart.group.add(sprite);
  }

  /**
   * (Re)draw the ghost badge canvas to "GHOST · m:ss.mmm" (or just "GHOST" when
   * no time is known). Cheap — called once on load and again whenever a faster
   * lap promotes the ghost, never per frame.
   * @param {number|null} time  the ghost's best-lap time in seconds.
   * @private
   */
  _setGhostBadge(time) {
    if (!this._ghostBadgeCtx) return;
    const ctx = this._ghostBadgeCtx;
    const c = this._ghostBadgeCanvas;
    ctx.clearRect(0, 0, c.width, c.height);
    // Translucent dark pill behind the text.
    ctx.fillStyle = 'rgba(8, 16, 32, 0.72)';
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(4, 8, c.width - 8, c.height - 16, 16);
      ctx.fill();
    } else {
      ctx.fillRect(4, 8, c.width - 8, c.height - 16);
    }
    // Glowing cyan label.
    ctx.font = 'bold 30px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fe8ff';
    // 'STAFF' for the bundled benchmark ghost, 'GHOST' once it's the player's own PB.
    const prefix = (this.ghost && this.ghost.staff) ? 'STAFF' : 'GHOST';
    const label = prefix + (time != null ? '  ·  ' + this._fmtLap(time) : '');
    ctx.fillText(label, c.width / 2, c.height / 2 + 1);
    this._ghostBadgeTex.needsUpdate = true;
  }

  /**
   * Format a lap time as mm:ss.mmm. Reuses the HUD's formatter when present so the
   * split/banner read identically to the lap timer; falls back to a local format.
   * @param {number} seconds
   * @returns {string}
   * @private
   */
  _fmtLap(seconds) {
    if (this.hud && typeof this.hud._formatTime === 'function') {
      return this.hud._formatTime(seconds);
    }
    const ms = Math.max(0, Math.floor(seconds * 1000));
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mmm = ms % 1000;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(mmm).padStart(3, '0');
  }

  /**
   * Interpolate between two angles the SHORT way around the circle, so a heading
   * that crosses the +/-PI boundary doesn't spin the long way. Returns an angle
   * a + (shortest signed difference to b) * f.
   *
   * @param {number} a  start angle (radians).
   * @param {number} b  end angle (radians).
   * @param {number} f  0..1 interpolation factor.
   * @returns {number}  interpolated angle (radians).
   * @private
   */
  _lerpAngle(a, b, f) {
    let diff = b - a;
    // Wrap the difference into (-PI, PI] so we always rotate the short way.
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return a + diff * f;
  }

  /**
   * Build the small HUD overlay that shows the live ghost delta. Appended to the
   * existing #hud container if present (so it sits with the rest of the HUD and
   * passes mouse input through), otherwise to <body> as a fallback.
   *
   * @returns {HTMLElement} the delta element (removed in dispose()).
   * @private
   */
  _buildDeltaElement() {
    const el = document.createElement('div');
    el.id = 'hud-ghost-delta';
    // Centered just below the lap counter (which sits at top-3). Bold + mono so
    // the +/-x.xx digits don't jitter as they tick.
    el.className =
      'absolute top-12 left-1/2 -translate-x-1/2 text-lg font-bold font-mono drop-shadow';
    el.textContent = 'GHOST --';

    // Prefer the shared HUD container so the layout/pointer rules apply.
    const host = document.getElementById('hud') || document.body;
    host.appendChild(el);
    return el;
  }

  /**
   * Build the persistent medal-goal hint: a small glass pill sitting just under the
   * delta overlay showing the NEXT medal threshold to beat for this track (e.g.
   * "NEXT 🥈 2:25"). DOM/CSS only — cheap, low-tier safe — and styled to match the
   * existing neon glass pills (translucent slate fill + faint ring + blur). Appended
   * to #hud; removed in dispose().
   * @returns {HTMLElement}
   * @private
   */
  _buildGoalElement() {
    const el = document.createElement('div');
    el.id = 'hud-tt-goal';
    // Centered at top-20 (just below #hud-ghost-delta at top-12). Glass pill in the
    // shared neon style; mono so the digits don't jitter; never blocks the canvas.
    el.className =
      'absolute top-20 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full ' +
      'bg-slate-900/55 ring-1 ring-white/15 backdrop-blur-sm text-xs font-bold font-mono ' +
      'tracking-wide drop-shadow pointer-events-none whitespace-nowrap';
    const host = document.getElementById('hud') || document.body;
    host.appendChild(el);
    return el;
  }

  /**
   * Refresh the medal-goal hint from the player's current best lap: show the next
   * faster threshold to chase (bronze -> silver -> gold), tinted to that medal, or
   * "🥇 GOLD" once gold is held. Cheap; called on construction, on each completed
   * lap, and on restart — never per frame.
   * @private
   */
  _updateGoalDisplay() {
    if (!this.goalElement) return;
    const targets = TARGET_LAP_TIMES[this.trackId];
    if (!targets) { this.goalElement.style.display = 'none'; return; }

    const best = this._bestLap;
    let text;
    let color;
    if (best == null || best > targets.bronze) {
      text = 'NEXT ' + MEDAL_EMOJI.bronze + ' ' + this._fmtGoal(targets.bronze);
      color = '#e8a87c'; // bronze
    } else if (best > targets.silver) {
      text = 'NEXT ' + MEDAL_EMOJI.silver + ' ' + this._fmtGoal(targets.silver);
      color = '#dbe4ee'; // silver
    } else if (best > targets.gold) {
      text = 'NEXT ' + MEDAL_EMOJI.gold + ' ' + this._fmtGoal(targets.gold);
      color = '#ffd76a'; // gold
    } else {
      text = MEDAL_EMOJI.gold + ' GOLD'; // top medal already held
      color = '#ffd76a';
    }
    this.goalElement.textContent = text;
    this.goalElement.style.color = color;
  }

  /**
   * Compact m:ss for a medal threshold (e.g. 145 -> "2:25"). The lap timer uses the
   * fuller mm:ss.mmm; the goal hint just needs a glanceable target.
   * @param {number} seconds
   * @returns {string}
   * @private
   */
  _fmtGoal(seconds) {
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return m + ':' + String(ss).padStart(2, '0');
  }

  /**
   * HAZARD contact (Phase 3): spin the player out if touching a hazard feature
   * (oil/cone) this tick. Distance test against the pre-resolved feature world
   * positions. applySpin honors invincibility (no star in time trial, but safe).
   * @private
   */
  _checkHazards() {
    const feats = this.features;
    if (!feats || feats.length === 0) return;
    const sx = this.playerState.x;
    const sz = this.playerState.z;
    for (let f = 0; f < feats.length; f++) {
      const feat = feats[f];
      if (feat.type !== 'hazard') continue;
      const r = (feat.params && feat.params.radius) || 4;
      const dx = sx - feat.x;
      const dz = sz - feat.z;
      if (dx * dx + dz * dz <= r * r) {
        applySpin(this.playerState);
        break;
      }
    }
  }

  /**
   * RESPAWN safety net (Phase 3): off-road too long OR fallen below the track
   * surface -> snap the player back onto the road centerline at the last
   * checkpoint (speed cut, jump cleared). Lap timing/recording is left alone.
   * @param {{onRoad:boolean, groundY:number}} surf  this tick's surface sample.
   * @param {number} dt
   * @private
   */
  _maybeRespawn(surf, dt) {
    if (surf.onRoad) this._offroadTime = 0;
    else this._offroadTime += dt;

    const fellOff = this.playerState.y < surf.groundY - 25;
    if (this._offroadTime < 2.5 && !fellOff) return;

    const pose = respawnPoint(this.trackId, this._lastCp);
    this.playerState.x = pose.x;
    this.playerState.y = pose.y;
    this.playerState.z = pose.z;
    this.playerState.heading = pose.heading;
    this.playerState.speed = 0;
    this.playerState.vy = 0;
    this.playerState.airborne = false;
    this.playerState.agSection = -1; // a respawn drops out of any anti-grav section
    this.playerState.groundY = pose.y;
    this.playerState.lastS = undefined; // re-acquire section after respawn teleport
    this._offroadTime = 0;

    // FEEDBACK so the teleport isn't silent: a quick HUD screen-flash + a chirp
    // (reusing the friendly item-pickup bloop). Both guarded — the HUD method is a
    // TT addition and audio is optional.
    if (this.hud && typeof this.hud.respawnFlash === 'function') this.hud.respawnFlash();
    if (this.audio && typeof this.audio.sfxItemPickup === 'function') this.audio.sfxItemPickup();
  }

  // ========================================================================
  // Teardown.
  // ========================================================================
  /**
   * Remove every mesh + DOM element this mode added, so returning to the menu /
   * switching modes leaves no leaks. Safe to call more than once.
   */
  dispose() {
    // Remove the kart meshes from the scene.
    if (this.playerKart && this.playerKart.group && this.playerKart.group.parent) {
      this.playerKart.group.parent.remove(this.playerKart.group);
    }
    if (this.ghostKart && this.ghostKart.group && this.ghostKart.group.parent) {
      this.ghostKart.group.parent.remove(this.ghostKart.group);
    }

    // Free the ghost badge's canvas texture + sprite material.
    if (this._ghostBadge && this._ghostBadge.material) {
      if (this._ghostBadge.material.map) this._ghostBadge.material.map.dispose();
      this._ghostBadge.material.dispose();
    }
    this._ghostBadge = null;

    // Remove the delta HUD overlay.
    if (this.deltaElement && this.deltaElement.parentNode) {
      this.deltaElement.parentNode.removeChild(this.deltaElement);
    }
    this.deltaElement = null;

    // Remove the medal-goal hint overlay.
    if (this.goalElement && this.goalElement.parentNode) {
      this.goalElement.parentNode.removeChild(this.goalElement);
    }
    this.goalElement = null;

    // Drop the quick-restart key listener.
    if (this._onRestartKey) {
      window.removeEventListener('keydown', this._onRestartKey);
      this._onRestartKey = null;
    }
  }

  // ========================================================================
  // Helpers for debug / external glue (mirrors RaceManager's surface).
  // ========================================================================
  /**
   * @returns {object} a player-record-shaped object so main.js's syncDebug() and
   *   any race-style glue can read { state, kart } the same way it does for the
   *   RaceManager's getPlayer().
   */
  getPlayer() {
    return { id: 'player', state: this.playerState, kart: this.playerKart };
  }
}
