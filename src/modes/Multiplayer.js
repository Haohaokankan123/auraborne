// src/modes/Multiplayer.js
//
// The CLIENT-SIDE online race. This is the multiplayer counterpart to the
// single-player RaceManager: it owns the visible karts, the camera follow, the
// HUD updates, and projectile visuals — but it does NOT own the authoritative
// simulation. The SERVER is authoritative: it steps every kart at a fixed 60Hz
// with stepKart and broadcasts ~20Hz snapshots. This class makes that feel
// smooth on the client using two standard netcode techniques:
//
//   1. CLIENT-SIDE PREDICTION (local player only)
//      We don't wait for the server to tell us where WE are. Every client tick
//      we read Input, send it to the server (tagged with a sequence number),
//      and immediately step OUR OWN kart locally with the same shared stepKart.
//      So the local kart responds instantly with zero input lag.
//
//   2. SERVER RECONCILIATION (local player only)
//      When a snapshot arrives it carries ackSeq[ourId] = the last input seq the
//      server has processed for us. We SNAP our predicted state to the server's
//      authoritative state for us, then REPLAY every input we've sent since that
//      ack on top of it. This corrects drift/divergence without ever rubber-
//      banding visibly (in the common case the replay reproduces what we already
//      had locally).
//
//   3. ENTITY INTERPOLATION (remote karts)
//      Remote karts only update at the snapshot rate (~20Hz) and arrive over the
//      network. Rendering them at their latest snapshot would look choppy. So we
//      buffer the last few snapshots per remote kart and RENDER THEM IN THE PAST
//      by a small delay (INTERP_DELAY), interpolating position/heading between
//      the two buffered snapshots that straddle that past time. Result: smooth
//      remote motion at the local frame rate.
//
// The Predictor and Interpolator are defined at the bottom of this file as small
// focused helper classes (this module owns them).
//
// Reuses src/entities/Kart.js for ALL kart visuals (local + remote), and a tiny
// pooled set of meshes for projectile visuals (we don't simulate projectiles on
// the client — the server does — we just draw the positions from the snapshot).

import * as THREE from 'three';

// The authoritative, deterministic kart model — SAME file the server steps with.
// Using it on the client is what makes prediction match the server.
import {
  createKartState,
  stepKart,
  applyMushroomBoost,
  launchKart,
} from '../../shared/kartModel.js';
import { PHYSICS, KART_COLORS } from '../../shared/constants.js';

// PURE shared track surface sampler (NO three): the local Predictor sets
// groundY/slope/surface from this BEFORE each (re)played stepKart, EXACTLY as the
// server does, so prediction rides the same hills and matches the authority. Used
// only on the local predicted kart — remote karts are drawn straight from snapshots.
import { sampleSurface, updateAntigravTransition } from '../../shared/trackData.js';

// Fixed timestep + render-interpolation helper (shared by all mode managers).
// DT is the fixed physics step; makeRenderState blends prev->cur transforms by
// the loop's render alpha to kill the 60Hz-vs-display-rate judder while turning.
import { DT } from '../core/Loop.js';
import { makeRenderState } from '../core/interpolate.js';

// Procedural kart visual (body, wheels, drift sparks, status-effect FX).
import { Kart } from '../entities/Kart.js';
import { getItem } from '../items/items.js'; // resolve the snapshot's held-item id -> icon/name for the HUD slot

// A small palette so each kart gets a distinct, recognizable color. Lives in
// shared/constants.js (KART_COLORS) so the server lobby swatch matches the kart.

// How far in the PAST we render remote karts, in seconds. Must be a touch larger
// than the snapshot interval (~1/20 = 50ms) so there are almost always two
// snapshots straddling the render time to interpolate between. 100ms is a
// common, comfortable default for a 20Hz snapshot stream.
export const INTERP_DELAY = 0.1;

// CONNECTION WATCHDOG: the server streams snapshots ~20Hz (every ~50ms). If they
// stop arriving for this long mid-race the link is effectively dead — the
// Interpolator just holds the last frame, which reads as a silent freeze. We use
// the snapshot gap itself (rather than a transport 'status' event) so the notice
// is fully self-contained in this client orchestration file. 1.5s ≈ 30 missed
// snapshots: long enough to ignore a brief packet hiccup, short enough to be honest.
const CONN_LOST_SECS = 1.5;

export class MultiplayerRace {
  /**
   * @param {Object} opts
   * @param {THREE.Scene}    opts.scene        Scene to add kart/projectile meshes to.
   * @param {Object}         opts.track        Track instance (surface tests, etc.).
   * @param {Object}         opts.renderer     Renderer instance (chase camera follow).
   * @param {Object}         opts.input        Input instance (getState()).
   * @param {Object}         opts.hud          HUD instance (update(state, info)).
   * @param {Object}         opts.socketClient Netcode client (see CONTRACT below).
   *
   * ---------------------------------------------------------------------------
   * socketClient CONTRACT (provided by the integration agent's netcode module):
   *   socketClient.on(event, handler)  -> subscribe to a server->client event.
   *   socketClient.sendInput(input)    -> send a client->server 'input' for this
   *                                       tick AND return its sequence number
   *                                       (an incrementing integer). We tag each
   *                                       locally-applied input with that seq so
   *                                       reconciliation can replay un-acked ones.
   *   socketClient.id?                 -> OPTIONAL: our playerId. We also capture
   *                                       it from the first snapshot's ackSeq if
   *                                       not provided (see _resolveLocalId).
   * ---------------------------------------------------------------------------
   */
  constructor({ scene, track, renderer, input, hud, socketClient }) {
    this.scene = scene;
    this.track = track;
    this.renderer = renderer;
    this.input = input;
    this.hud = hud;
    this.socket = socketClient;

    // --- Kart bookkeeping -------------------------------------------------
    // For each kart id we keep a record:
    //   { id, isAI, kart (Kart visual), color }
    // plus, for the local player only, a Predictor; for remotes, the
    // Interpolator buffers their snapshots.
    this.karts = new Map();       // id -> record
    this.localId = null;          // our playerId (resolved from 'raceStart'/snapshots)
    this.predictor = null;        // Predictor for the local kart
    this.interpolator = new Interpolator(); // buffers + samples remote karts

    // Race meta from 'raceStart'.
    this.totalLaps = 3;
    this.fieldSize = 13;

    // --- The most recent snapshot (read by render() for HUD + projectiles) ---
    this.lastSnapshot = null;

    // Per-id race info pulled from snapshots (lap / position), so render() can
    // feed the HUD without recomputing standings on the client.
    this._infoById = new Map(); // id -> { lap, pos, item }

    // Wall-clock reference (seconds) used to time interpolation. We use
    // performance.now() converted to seconds.
    this._now = () => performance.now() / 1000;

    // --- Live standings + connection watchdog ----------------------------
    // The 'raceStart' grid + snapshots carry NO player names (only ids), so we
    // cache id->name from the replayable 'lobby' roster to label the standings.
    this._nameById = new Map();
    // The standings panel DOM (built in start(), torn down in dispose()) and its
    // per-kart row elements, keyed by kart id so we relabel/reorder in place
    // (no per-frame DOM rebuild — just textContent + a flex `order` reshuffle).
    this.standingsPanel = null;
    this._standingsRows = new Map(); // id -> { row, left, lap, last, hi }
    this._standingsTitle = null;     // header label, doubles as a connection state
    this._standingsDot = null;       // header status dot (green live / amber lost)
    // Connection watchdog state: time of the last snapshot and whether we've
    // currently flagged the link as lost (so we toast the transition only once).
    this._lastSnapTime = this._now();
    this._connLost = false;

    // --- Projectile visual pool ------------------------------------------
    // We do NOT simulate projectiles on the client. Each snapshot lists the live
    // projectiles ({id,type,x,y,z}); we just place a few reusable meshes at those
    // positions. A small pool (grown on demand) keeps this allocation-free in the
    // steady state. Built lazily in _ensureProjectilePool().
    this._projPool = [];          // array of { mesh } reusable records
    this._projGroup = new THREE.Group();
    this._projGroup.name = 'MultiplayerProjectiles';
    this.scene.add(this._projGroup);
    this._projGeo = null;         // shared geometry (built once)
    this._projMatByType = null;   // type -> shared material (built once)

    // Whether the race has ended (stops camera/HUD churn after results show).
    this.finished = false;
    this.resultsScreen = null;

    // Unsubscribe functions returned by socket.onEvent, captured so dispose()
    // can detach our listeners (the SocketClient instance is reused across MP
    // sessions, so failing to detach leaks listeners bound to a disposed race).
    this._offs = [];

    // True once dispose() has run. A defensive guard for the socket handlers in
    // case a fan-out (_emit) is mid-iteration when we detach: a disposed race
    // must never touch its dead karts/predictor/interpolator.
    this.disposed = false;

    // Bind + subscribe to the server events we care about.
    this._wireSocket();
  }

  // ------------------------------------------------------------------------
  // Socket wiring
  // ------------------------------------------------------------------------
  _wireSocket() {
    if (!this.socket || typeof this.socket.onEvent !== 'function') return;

    // Subscribe via onEvent (SocketClient's real pub/sub API), NOT raw .on.

    // 'raceStart' may be delivered by the Lobby (which calls our start()) OR
    // arrive here directly depending on how the caller wires things. We support
    // both: subscribe here, and also expose start(payload) for the Lobby path.
    this._offs.push(this.socket.onEvent('raceStart', (payload) => this.start(payload)));

    // The authoritative state stream.
    this._offs.push(this.socket.onEvent('snapshot', (snap) => this._onSnapshot(snap)));

    // Final standings.
    this._offs.push(this.socket.onEvent('raceEnd', (payload) => this._onRaceEnd(payload)));

    // Roster names for the live standings. Snapshots/startGrid are id-only, but
    // the 'lobby' payload carries {id,name}. 'lobby' is replayable, so even though
    // the Lobby screen has been disposed by the time we wire up, SocketClient
    // replays the last roster to this late subscriber. Names may also update mid-
    // session (a join/ready broadcast), so we refresh the labels on each one.
    this._offs.push(this.socket.onEvent('lobby', (payload) => {
      if (this.disposed) return;
      const players = (payload && payload.players) || [];
      for (const p of players) {
        if (p && p.id != null) this._nameById.set(p.id, p.name || 'Racer');
      }
      this._updateStandings();
    }));

    // A human dropped mid-race and the server handed their kart to an AI — toast it
    // through the existing reward banner so everyone sees who left.
    this._offs.push(this.socket.onEvent('playerLeft', (p) => {
      if (this.disposed || !p) return;
      if (this.hud && typeof this.hud.showRewardBanner === 'function') {
        this.hud.showRewardBanner((p.name || 'A racer') + ' left — AI took over');
      }
    }));
  }

  // ------------------------------------------------------------------------
  // Race start: build a Kart visual for every kart in the start grid.
  // ------------------------------------------------------------------------
  /**
   * @param {Object} payload  'raceStart' contract:
   *   { fieldSize, totalLaps, startGrid:[{id,isAI,x,y,z,heading}], trackId }
   */
  start(payload) {
    if (!payload || !Array.isArray(payload.startGrid)) return;

    this.totalLaps = payload.totalLaps != null ? payload.totalLaps : 3;
    this.fieldSize = payload.fieldSize != null ? payload.fieldSize : payload.startGrid.length;

    // Resolve our own id as early as possible (socket may expose it).
    if (this.socket && this.socket.id != null) {
      this.localId = this.socket.id;
    }

    // Build one visual kart per grid entry.
    payload.startGrid.forEach((entry, index) => {
      const color = KART_COLORS[index % KART_COLORS.length];
      const kart = new Kart({ color });
      // ANTI-GRAV: tell the visual which track it is on so syncFromState can re-derive
      // the surface frame to ride walls/ceiling while a kart is in a section.
      kart._trackId = (this.track && this.track.trackId) || 'circuit';

      // Seed the visual at its grid pose so the first frame isn't at the origin.
      kart.group.position.set(entry.x, entry.y || 0, entry.z);
      kart.group.rotation.y = entry.heading || 0;
      this.scene.add(kart.group);

      const record = { id: entry.id, isAI: !!entry.isAI, kart, color };
      this.karts.set(entry.id, record);
    });

    // If we can already tell which kart is ours, set up the Predictor for it.
    this._ensurePredictor(payload.startGrid);

    // Build the live standings panel now that we know the full field.
    this._buildStandings();

    // The first snapshot resets this, but seed it here so the watchdog doesn't
    // fire during the pre-race countdown before any snapshot has arrived.
    this._lastSnapTime = this._now();
  }

  /**
   * Create the local Predictor once we know which grid entry is ours. We seed it
   * with a fresh kart state at our grid pose so prediction starts from the right
   * place. If localId isn't known yet, this no-ops; _onSnapshot will retry.
   * @param {Array} startGrid
   * @private
   */
  _ensurePredictor(startGrid) {
    if (this.predictor || this.localId == null) return;
    const mine = startGrid && startGrid.find((e) => e.id === this.localId);
    const seed = createKartState(
      mine
        ? { x: mine.x, y: mine.y || 0, z: mine.z, heading: mine.heading || 0 }
        : {}
    );
    this.predictor = new Predictor(seed);
  }

  // ------------------------------------------------------------------------
  // Per CLIENT TICK (fixed 60Hz, driven by the game loop's update(dt)).
  // ------------------------------------------------------------------------
  /**
   * Read local input, send it to the server, and predict the local kart forward
   * one step. Remote karts are NOT stepped here — they're driven by snapshots +
   * interpolation in render().
   * @param {number} dt  Fixed timestep (should be PHYSICS.DT).
   */
  update(dt) {
    if (this.finished) return;
    if (!this.socket) return;

    // Read this tick's control state.
    const raw = this.input.getState();

    // Send to the server and get the sequence number it was tagged with. The
    // netcode client owns the seq counter so the server's ackSeq lines up.
    let seq = null;
    if (typeof this.socket.sendInput === 'function') {
      seq = this.socket.sendInput(raw);
    }

    // Predict our own kart immediately with the SAME input, recording (seq,input)
    // so reconciliation can replay everything the server hasn't acked yet.
    if (this.predictor) {
      this.predictor.applyInput(seq, raw, dt, this.track);
    }
  }

  // ------------------------------------------------------------------------
  // On 'snapshot': reconcile local + buffer remotes + cache HUD info.
  // ------------------------------------------------------------------------
  /**
   * @param {Object} snap  'snapshot' contract:
   *   { tick, t, ackSeq:{<id>:lastSeq}, karts:[{id,isAI,x,y,z,heading,speed,
   *     drifting,driftDir,miniTurboTier,boostTimer,spinTimer,starTimer,
   *     shrinkTimer,lap,nextCp,pos,item}], projectiles:[{id,type,x,y,z}], events }
   * @private
   */
  _onSnapshot(snap) {
    if (this.disposed) return;
    if (!snap) return;
    this.lastSnapshot = snap;

    // CONNECTION WATCHDOG: a snapshot just arrived, so the link is alive. Record
    // when, and if we had previously flagged the connection as lost, clear that
    // state and toast the recovery (the green default tone vs the alert tone the
    // loss used). render() owns the loss-detection side of this watchdog.
    this._lastSnapTime = this._now();
    if (this._connLost) {
      this._connLost = false;
      this._setConnState(false);
      if (this.hud && typeof this.hud.showRewardBanner === 'function') {
        this.hud.showRewardBanner('Reconnected');
      }
    }

    // Resolve our local id if we still don't know it (the ackSeq map is keyed by
    // player id; if the socket didn't hand us an id, we can't reconcile until we
    // know which kart is ours — the caller normally sets socket.id on 'joined').
    this._resolveLocalId(snap);

    const renderArrival = this._now();

    // Walk every kart in the snapshot.
    for (const ks of snap.karts) {
      if (ks.id === this.localId) {
        // ----- LOCAL PLAYER: reconcile prediction against the server -----
        if (this.predictor) {
          const ackSeq = snap.ackSeq ? snap.ackSeq[this.localId] : undefined;
          this.predictor.reconcile(ks, ackSeq, PHYSICS.DT, this.track);
        }
      } else {
        // ----- REMOTE KART: buffer this snapshot for interpolation -------
        // Stamp with the local arrival time so the Interpolator can render it in
        // the past by INTERP_DELAY. (We use arrival time rather than snap.t so we
        // don't need the client and server clocks to be synchronized.)
        this.interpolator.push(ks.id, renderArrival, ks);
      }

      // Cache lap/position (and the held-item id) for the HUD regardless of
      // local/remote. `ks.item` is the server's held-item id ('' when empty).
      this._infoById.set(ks.id, { lap: ks.lap, pos: ks.pos, item: ks.item });
    }

    // Refresh the live standings from the freshly-cached lap/position data. Done
    // here (snapshot rate ~20Hz) rather than per render frame: the order/laps only
    // change when a snapshot arrives, so re-laying them out every frame would be
    // wasted work on the 60fps-Chromebook floor we must not regress.
    this._updateStandings();
  }

  /**
   * Best-effort resolve of which kart is "ours". Prefers an explicit socket.id;
   * otherwise, if the snapshot's ackSeq has exactly the karts we know about, the
   * one id present in ackSeq that we haven't already classified as remote is us.
   * In practice the netcode client sets socket.id on 'joined', so this is just a
   * safety net. Once resolved, it also lazily creates the Predictor.
   * @private
   */
  _resolveLocalId(snap) {
    if (this.localId != null) return;
    if (this.socket && this.socket.id != null) {
      this.localId = this.socket.id;
    } else if (snap.ackSeq) {
      // ackSeq is keyed only by HUMAN player ids. If there's exactly one and it
      // matches a kart we have, treat it as ours.
      const ids = Object.keys(snap.ackSeq);
      if (ids.length === 1) this.localId = ids[0];
    }
    if (this.localId != null && !this.predictor) {
      // Seed a predictor from the current server state for our kart so we don't
      // start prediction from the origin.
      const mine = snap.karts.find((k) => k.id === this.localId);
      const seed = createKartState(mine ? snapshotToState(mine) : {});
      this.predictor = new Predictor(seed);
    }
  }

  // ------------------------------------------------------------------------
  // Per RENDER FRAME: sync visuals, follow camera, draw projectiles, HUD.
  // ------------------------------------------------------------------------
  /**
   * @param {number} alpha  Loop interpolation factor in [0, 1): how far real time
   *                        sits between the previous and current physics ticks.
   *                        (First arg, matching the other mode managers — NOT dt.)
   */
  render(alpha) {
    // 1) LOCAL kart: blend the predicted state's PREVIOUS tick -> CURRENT tick by
    //    alpha so the local kart draws a smooth in-between frame instead of
    //    stepping at the discrete 60Hz prediction rate (which reads as judder
    //    while turning). Only x/y/z/heading are interpolated; all visual flags
    //    come straight from the live predicted state via makeRenderState.
    if (this.localId != null && this.predictor) {
      const record = this.karts.get(this.localId);
      const state = this.predictor.state;
      const rs = makeRenderState(this.predictor.prevTransform, state, alpha);
      if (record) {
        // Pass the fixed DT (not alpha) for wheel-roll/spark FX, and the live
        // steer so the front wheels visibly turn (cosmetic only).
        record.kart.syncFromState(rs, DT, this.predictor.lastSteer);
      }
      // Chase camera follows the interpolated local pose (smooth, no judder). Pass the
      // trackId so the camera can roll with the kart through an anti-grav section.
      if (this.renderer && typeof this.renderer.updateChaseCamera === 'function') {
        this.renderer.updateChaseCamera(rs, DT, (this.track && this.track.trackId) || 'circuit');
      }
    }

    // 2) REMOTE karts: sample the interpolation buffer at (now - INTERP_DELAY).
    //    Remotes are server-authoritative and already smoothed by the snapshot
    //    Interpolator — that path is independent of the loop's alpha, so it stays.
    const renderTime = this._now() - INTERP_DELAY;
    for (const [id, record] of this.karts) {
      if (id === this.localId) continue; // local handled above
      const sampled = this.interpolator.sample(id, renderTime);
      if (sampled) {
        record.kart.syncFromState(sampled, DT, 0);
      }
    }

    // 3) Projectiles: place pooled meshes at the snapshot's projectile positions.
    this._renderProjectiles();

    // 4) HUD: show the local player's lap + position from the snapshot info.
    if (this.hud && this.localId != null) {
      const info = this._infoById.get(this.localId);
      const localState = this.predictor ? this.predictor.state : null;
      if (localState) {
        this.hud.update(localState, {
          lap: info ? info.lap : 1,
          totalLaps: this.totalLaps,
          position: info ? info.pos : 1,
          totalRacers: this.karts.size,
          // Lap timing isn't streamed per-snapshot in this contract; leave the
          // timer fields out so the HUD shows its placeholders rather than wrong
          // numbers. miniTurboTier comes from our predicted state for instant FX.
          miniTurboTier: localState.miniTurboTier,
          // Held power-up for the top-center item slot, derived from the server's
          // per-kart item id in the snapshot (null when empty -> slot hidden).
          // The snapshot carries no charge count, so triples just show ×1 here.
          heldItem: this._heldItemFrom(info ? info.item : null),
        });
      }
    }

    // 5) CONNECTION WATCHDOG (loss side): if we've received at least one snapshot
    //    but the stream has since gone quiet for CONN_LOST_SECS, the link is
    //    effectively down (the Interpolator is just holding the last frame, a
    //    silent freeze). Flag it once and tell the player — clearing happens in
    //    _onSnapshot when the stream resumes. Skipped once finished so a normal
    //    post-race snapshot stop never reads as a disconnect.
    if (!this.finished && this.lastSnapshot && !this._connLost &&
        this._now() - this._lastSnapTime > CONN_LOST_SECS) {
      this._connLost = true;
      this._setConnState(true);
      if (this.hud && typeof this.hud.showRewardBanner === 'function') {
        this.hud.showRewardBanner('Connection lost — reconnecting…', 'alert');
      }
    }
  }

  /**
   * Build the HUD's held-item descriptor from a raw item id (the server sends
   * the local player's held id in each snapshot). Joins the id with the item's
   * display fields (name/icon/color) from the ITEMS table. Returns null for an
   * empty/unknown id, which the HUD reads as "hide the slot". The snapshot has
   * no charge count, so count is fixed at 1 (no ×N badge in multiplayer).
   *
   * @param {string|null|undefined} itemId  the held item id ('' / null = empty).
   * @returns {{ id:string, name:string, icon:string, color:number, count:number } | null}
   * @private
   */
  _heldItemFrom(itemId) {
    if (!itemId) return null; // '' or null -> HUD hides the panel
    const def = getItem(itemId);
    if (!def) return null; // unknown id -> treat as empty
    return {
      id: def.id,
      name: def.name,
      icon: def.icon,
      color: def.color,
      count: 1, // snapshot carries no charge count; show a single item
    };
  }

  // ------------------------------------------------------------------------
  // Live standings panel (DOM/CSS only — cheap, low-quality-tier safe).
  // ------------------------------------------------------------------------
  /**
   * Build the compact standings panel once, after the start grid is known. One
   * row per kart is created up front (a color swatch + a name line + a lap line);
   * thereafter _updateStandings only re-labels and reorders these existing rows
   * via the flex `order` property, so there's no per-frame DOM churn. Pinned to
   * the mid-left edge so it clears the HUD's top-left timer, bottom-left speed/
   * coin pills, top-center lap/item slots, and bottom-right minimap.
   * pointer-events-none so it never intercepts clicks (e.g. on the results card).
   * @private
   */
  _buildStandings() {
    if (this.standingsPanel || this.karts.size === 0) return;

    const panel = document.createElement('div');
    panel.id = 'mp-standings';
    panel.className = [
      'fixed', 'left-3', 'top-1/2', '-translate-y-1/2', 'z-20',
      'pointer-events-none', 'select-none', 'text-white',
      'w-44', 'max-w-[40vw]', 'max-h-[70vh]', 'overflow-hidden',
      'rounded-2xl', 'px-3', 'py-2.5',
      'bg-slate-900/60', 'ring-1', 'ring-white/10', 'backdrop-blur-sm',
      'shadow-lg', 'shadow-black/40',
      'flex', 'flex-col', 'gap-1',
    ].join(' ');

    // Header: a label that doubles as the connection state, plus a status dot.
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between mb-0.5';
    const title = document.createElement('span');
    title.className = 'text-[0.6rem] font-bold tracking-[0.2em] text-slate-400';
    title.textContent = 'STANDINGS';
    const dot = document.createElement('span');
    dot.className =
      'inline-block w-2 h-2 rounded-full bg-emerald-400 shadow shadow-emerald-400/60';
    header.appendChild(title);
    header.appendChild(dot);
    panel.appendChild(header);
    this._standingsTitle = title;
    this._standingsDot = dot;

    // List body. Rows live here and reorder purely via CSS `order` (no DOM moves).
    const list = document.createElement('div');
    list.className = 'flex flex-col gap-1';
    panel.appendChild(list);

    let idx = 0;
    for (const [id, rec] of this.karts) {
      const row = document.createElement('div');
      row.className = [
        'flex', 'items-center', 'gap-2',
        'px-2', 'py-1', 'rounded-lg', 'text-xs', 'leading-none',
        'bg-slate-800/40',
      ].join(' ');
      row.style.order = String(idx + 1); // grid order until the first snapshot

      // Kart color swatch so you can match a row to the kart on track (mirrors
      // the lobby roster swatch).
      const swatch = document.createElement('span');
      swatch.className = 'shrink-0 inline-block w-2.5 h-2.5 rounded-full ring-1 ring-white/30';
      swatch.style.backgroundColor = this._hex(rec.color);
      row.appendChild(swatch);

      // "{pos}. {name}" — grows to fill, truncates a long name rather than wrap.
      const left = document.createElement('span');
      left.className = 'flex-1 min-w-0 truncate font-semibold';
      row.appendChild(left);

      // Current lap "/" total, monospaced so the column stays aligned.
      const lap = document.createElement('span');
      lap.className = 'shrink-0 font-mono text-[0.65rem] text-slate-300';
      row.appendChild(lap);

      list.appendChild(row);
      this._standingsRows.set(id, { row, left, lap, last: '', hi: false });
      idx++;
    }

    document.body.appendChild(panel);
    this.standingsPanel = panel;

    // Initial fill (grid order; real positions/laps arrive with the first snapshot).
    this._updateStandings();
  }

  /**
   * Relabel + reorder the standings rows from the per-kart lap/position data
   * cached in _infoById each snapshot. Cheap: a flex `order` write reshuffles
   * without moving DOM nodes, and textContent is only rewritten when the row's
   * text actually changes. The local player's row is highlighted once (it never
   * stops being "us"). Safe to call before the panel exists (no-ops).
   * @private
   */
  _updateStandings() {
    if (!this.standingsPanel) return;
    const total = this.totalLaps;
    for (const [id, ui] of this._standingsRows) {
      const info = this._infoById.get(id);
      const rec = this.karts.get(id);
      const pos = info && info.pos != null ? info.pos : null;
      const lap = info && info.lap != null ? info.lap : 1;
      const isMe = id === this.localId;

      // Reorder via flex `order` (unknown position sinks to the bottom).
      ui.row.style.order = String(pos != null ? pos : 99);

      const posText = pos != null ? pos + '.' : '–';
      const nameText = posText + ' ' + this._displayName(id, rec) + (isMe ? ' (you)' : '');
      const lapText = Math.min(Math.max(lap, 1), total) + '/' + total;
      const key = nameText + '|' + lapText;
      if (ui.last !== key) {
        ui.left.textContent = nameText;
        ui.lap.textContent = lapText;
        ui.last = key;
      }

      // Highlight our own row once localId is known (it never changes after).
      if (isMe && !ui.hi) {
        ui.row.classList.remove('bg-slate-800/40');
        ui.row.classList.add('bg-cyan-500/20', 'ring-1', 'ring-cyan-400/40', 'font-bold');
        ui.hi = true;
      }
    }
  }

  /**
   * Display name for a kart id: the lobby roster name if known, else 'CPU' for an
   * AI seat or 'Racer' for a human we have no name for yet.
   * @private
   */
  _displayName(id, rec) {
    const n = this._nameById.get(id);
    if (n) return n;
    return rec && rec.isAI ? 'CPU' : 'Racer';
  }

  /**
   * Reflect the connection state in the standings header. On loss the label turns
   * amber 'RECONNECTING…' with a pulsing amber dot; on recovery it returns to the
   * neutral 'STANDINGS' label + green live dot. A persistent indicator that
   * outlasts the transient reward-banner toast so the player isn't left guessing.
   * @param {boolean} lost
   * @private
   */
  _setConnState(lost) {
    if (!this._standingsTitle || !this._standingsDot) return;
    if (lost) {
      this._standingsTitle.textContent = 'RECONNECTING…';
      this._standingsTitle.classList.remove('text-slate-400');
      this._standingsTitle.classList.add('text-amber-300');
      this._standingsDot.classList.remove('bg-emerald-400', 'shadow-emerald-400/60');
      this._standingsDot.classList.add('bg-amber-400', 'shadow-amber-400/70', 'animate-pulse');
    } else {
      this._standingsTitle.textContent = 'STANDINGS';
      this._standingsTitle.classList.remove('text-amber-300');
      this._standingsTitle.classList.add('text-slate-400');
      this._standingsDot.classList.remove('bg-amber-400', 'shadow-amber-400/70', 'animate-pulse');
      this._standingsDot.classList.add('bg-emerald-400', 'shadow-emerald-400/60');
    }
  }

  /** Convert a 0xRRGGBB color number to a '#rrggbb' CSS string. @private */
  _hex(n) {
    return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  }

  // ------------------------------------------------------------------------
  // Projectile visuals (pooled; positions come straight from the snapshot).
  // ------------------------------------------------------------------------
  _renderProjectiles() {
    const list = this.lastSnapshot ? this.lastSnapshot.projectiles : null;
    if (!list) {
      // No projectile data this frame: hide the whole pool and bail.
      for (const rec of this._projPool) rec.mesh.visible = false;
      return;
    }

    this._ensureProjectileAssets();

    // Place one pooled mesh per live projectile; recolor by type. Grow the pool
    // if the snapshot has more projectiles than we've built meshes for.
    let i = 0;
    for (; i < list.length; i++) {
      const proj = list[i];
      const rec = this._getProjSlot(i);
      rec.mesh.visible = true;
      rec.mesh.position.set(proj.x, proj.y != null ? proj.y : 0.6, proj.z);
      // Swap the material to match the projectile type (shared singletons).
      const mat = this._projMatByType[proj.type] || this._projMatByType._default;
      if (rec.mesh.material !== mat) rec.mesh.material = mat;
    }
    // Hide any leftover pooled meshes from a busier previous frame.
    for (; i < this._projPool.length; i++) {
      this._projPool[i].mesh.visible = false;
    }
  }

  /** Build the shared projectile geometry + per-type materials once. @private */
  _ensureProjectileAssets() {
    if (this._projGeo) return;
    // One small sphere geometry reused for every projectile visual. The client
    // only needs to SHOW where hazards are; exact shapes aren't important.
    this._projGeo = new THREE.SphereGeometry(0.5, 10, 8);
    const mk = (color, emissive) =>
      new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 0.5, roughness: 0.4 });
    this._projMatByType = {
      greenShell: mk(0x22cc44, 0x115522),
      redShell: mk(0xee3333, 0x661111),
      banana: mk(0xffdd33, 0x554400),
      bobOmb: mk(0x222230, 0x550000),
      fakeBox: mk(0xcc4444, 0x661122),
      bulletBill: mk(0x111111, 0x222222),
      _default: mk(0xffffff, 0x333333),
    };
  }

  /**
   * Get the i-th pooled projectile mesh, creating it (and adding it to the group)
   * if the pool isn't that large yet. @private
   */
  _getProjSlot(i) {
    while (this._projPool.length <= i) {
      const mesh = new THREE.Mesh(this._projGeo, this._projMatByType._default);
      mesh.visible = false;
      this._projGroup.add(mesh);
      this._projPool.push({ mesh });
    }
    return this._projPool[i];
  }

  // ------------------------------------------------------------------------
  // Race end: show a simple results overlay.
  // ------------------------------------------------------------------------
  /**
   * @param {Object} payload  'raceEnd' contract:
   *   { results:[{id,name,isAI,pos,bestLap}] }
   * @private
   */
  _onRaceEnd(payload) {
    if (this.disposed) return;
    this.finished = true;
    const results = (payload && payload.results) || [];

    // Build a plain HTML/CSS results overlay (Tailwind), same style family as the
    // Menu/Lobby. It takes clicks so the player can dismiss / return to menu.
    const overlay = document.createElement('div');
    overlay.id = 'race-results';
    overlay.className = [
      'fixed', 'inset-0', 'z-30',
      'pointer-events-auto',
      'flex', 'items-center', 'justify-center',
      'select-none', 'text-white',
      'bg-black/70', 'backdrop-blur-sm',
    ].join(' ');

    const card = document.createElement('div');
    card.className = [
      'w-[26rem]', 'max-w-[92vw]', 'rounded-3xl', 'p-8',
      'bg-slate-800/90', 'ring-1', 'ring-white/10', 'shadow-2xl',
      'flex', 'flex-col', 'gap-4',
    ].join(' ');

    const title = document.createElement('h2');
    title.textContent = 'RESULTS';
    title.className = 'text-2xl font-black tracking-wide text-center';
    card.appendChild(title);

    const list = document.createElement('ol');
    list.className = 'flex flex-col gap-2';
    // Sort by finishing position so first place is at the top.
    results
      .slice()
      .sort((a, b) => (a.pos || 0) - (b.pos || 0))
      .forEach((r) => {
        const row = document.createElement('li');
        row.className =
          'flex items-center justify-between px-4 py-2 rounded-xl bg-slate-900/60';
        const left = document.createElement('span');
        left.className = 'font-semibold';
        left.textContent = (r.pos != null ? r.pos + '. ' : '') +
          (r.name || (r.isAI ? 'CPU' : 'Player'));
        const right = document.createElement('span');
        right.className = 'text-sm font-mono text-slate-300';
        right.textContent = r.bestLap != null ? formatTime(r.bestLap) : '--:--.---';
        row.appendChild(left);
        row.appendChild(right);
        list.appendChild(row);
      });
    card.appendChild(list);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.resultsScreen = overlay;
  }

  // ------------------------------------------------------------------------
  // Cleanup: remove every mesh + overlay this race created.
  // ------------------------------------------------------------------------
  dispose() {
    this.disposed = true;

    // Detach our socket listeners so they don't fire on this disposed instance.
    // The SocketClient is reused across sessions, so leaving them attached
    // accumulates stale callbacks (and 'raceStart' would rebuild karts on a
    // dead race). offEvent is idempotent, so calling these is always safe.
    if (this._offs) {
      for (const off of this._offs) {
        if (typeof off === 'function') off();
      }
      this._offs = [];
    }

    // Remove kart visuals from the scene.
    for (const record of this.karts.values()) {
      if (record.kart && record.kart.group && record.kart.group.parent) {
        record.kart.group.parent.remove(record.kart.group);
      }
    }
    this.karts.clear();

    // Remove the projectile group.
    if (this._projGroup && this._projGroup.parent) {
      this._projGroup.parent.remove(this._projGroup);
    }

    // Remove the results overlay if present.
    if (this.resultsScreen && this.resultsScreen.parentNode) {
      this.resultsScreen.parentNode.removeChild(this.resultsScreen);
    }

    // Remove the live standings panel.
    if (this.standingsPanel && this.standingsPanel.parentNode) {
      this.standingsPanel.parentNode.removeChild(this.standingsPanel);
    }
    this.standingsPanel = null;
    this._standingsRows.clear();
  }
}

// ===========================================================================
// Predictor — client-side prediction + server reconciliation for ONE kart.
// ===========================================================================
//
// Owns the local player's PREDICTED kart state and a small history of the
// inputs we've sent but the server hasn't acked yet. Every tick applyInput()
// advances the predicted state with stepKart (the shared model) and records the
// (seq,input,dt) so it can be replayed. On a snapshot, reconcile() snaps to the
// server's authoritative state for us and replays the still-un-acked inputs.
class Predictor {
  /**
   * @param {Object} seedState  A kart state (from createKartState) to start from.
   */
  constructor(seedState) {
    // The live predicted state the renderer reads each frame.
    this.state = seedState;
    // Pending inputs not yet acknowledged by the server:
    //   [{ seq, input, dt }]  in send order.
    this.pending = [];
    // Last steer value applied, exposed so the renderer can turn the front wheels.
    this.lastSteer = 0;
    // PREVIOUS-tick transform of the predicted state, for render interpolation.
    // We blend prevTransform->state by the loop's alpha so the local kart draws a
    // smooth in-between frame instead of stepping at the discrete 60Hz tick rate
    // (which reads as judder while turning). Seeded to the spawn pose so the very
    // first blend has a sane "previous" value. Mutated (not reallocated) each tick.
    this.prevTransform = {
      x: seedState.x,
      y: seedState.y,
      z: seedState.z,
      heading: seedState.heading,
    };
    // TERRAIN (Phase 3): last surface seen, for rising-edge ramp/boost detection
    // during prediction + replay. Mirrors the server's per-kart _prevSurface so a
    // ramp launch / boost-pad surge fires on the same step on both sides.
    this._prevSurface = 'road';
  }

  /**
   * Apply one tick of local input: step the predicted state and remember the
   * input for possible replay. seq may be null if the socket didn't return one
   * (then this input simply can't be reconciled, which is harmless).
   * @param {number|null} seq
   * @param {Object} input  Input.getState() shape.
   * @param {number} dt
   * @param {Object} track  Track (carries .trackId for the surface sampler; see _stepWithTerrain).
   */
  applyInput(seq, input, dt, track) {
    this.lastSteer = input.steer || 0;
    // Bank the pre-step transform so render() can interpolate prev->current by the
    // loop's alpha. Mutate the existing object (no per-tick allocation). This is
    // the local predicted analogue of every other manager's per-racer prevTransform.
    this.prevTransform.x = this.state.x;
    this.prevTransform.y = this.state.y;
    this.prevTransform.z = this.state.z;
    this.prevTransform.heading = this.state.heading;
    // TERRAIN (Phase 3): mirror the server's per-tick protocol EXACTLY — sample
    // the surface at the CURRENT (pre-step) position, set groundY/slope/surface,
    // fire ramp/boost on the rising edge, THEN stepKart (which now owns y). The
    // server (Room._stepOnce) does the identical derive-at-pos-then-step, so the
    // predicted state matches the authority on hills, ramps and boost pads.
    this._stepWithTerrain(input, dt, track);
    if (seq != null) {
      this.pending.push({ seq, input, dt });
    }
  }

  /**
   * One terrain-aware prediction step: sample the shared surface at the kart's
   * current position, apply hill/slope/surface to the state, fire ramp-launch +
   * boost-pad on the rising edge, then advance the deterministic model. This is
   * the SAME sequence the server runs per tick, so it must stay in lock-step with
   * Room._stepOnce. Used by both applyInput (live) and reconcile (replay).
   * @param {Object} input
   * @param {number} dt
   * @param {Object} track  carries .trackId for the pure sampler.
   * @private
   */
  _stepWithTerrain(input, dt, track) {
    const trackId = (track && track.trackId) || 'circuit';
    const surf = sampleSurface(trackId, this.state.x, this.state.z, this.state.y, this.state.lastS);
    // Carved gap/chasm: park groundY 1000m below so the kart plunges into the void
    // instead of coasting across the invisible centerline height. IDENTICAL to the
    // server (Room._stepOnce) + RaceManager (SP) so prediction stays byte-identical.
    const overGap = !surf.onRoad && surf.inGap;
    this.state.groundY = overGap ? surf.groundY - 1000 : surf.groundY;
    this.state.slope = surf.slope;
    this.state.surface = surf.surface;
    this.state.lastS = surf.s; // continuity hint for next frame (overpass fix)

    // ANTI-GRAV section entry/exit — IDENTICAL pure helper, same spot, as the server
    // (Room._stepOnce). Living inside _stepWithTerrain means BOTH live prediction AND
    // reconcile-replay run it before each stepKart, so the surface-relative branch +
    // its agTrackId stamp stay in lock-step with the authority on every replayed input.
    updateAntigravTransition(this.state, trackId, surf);

    if (
      surf.surface === 'ramp' &&
      this._prevSurface !== 'ramp' &&
      this.state.speed >= PHYSICS.RAMP_LAUNCH_MIN_SPEED
    ) {
      const speedFrac = Math.min(this.state.speed / PHYSICS.MAX_SPEED, 1.4);
      launchKart(this.state, PHYSICS.RAMP_LAUNCH_VY * (0.7 + 0.5 * speedFrac));
    }
    if (surf.surface === 'boost' && this._prevSurface !== 'boost') {
      applyMushroomBoost(this.state);
    }
    this._prevSurface = surf.surface;

    stepKart(this.state, input, dt);
  }

  /**
   * Reconcile the predicted state against the server's authoritative state for
   * our kart. Snaps to the server state, drops every pending input the server
   * has already processed (seq <= ackSeq), then REPLAYS the rest on top so the
   * predicted state reflects inputs the server hasn't seen yet.
   * @param {Object} serverKart  Our entry from snapshot.karts.
   * @param {number|undefined} ackSeq  Last input seq the server processed for us.
   * @param {number} dt
   * @param {Object} track
   */
  reconcile(serverKart, ackSeq, dt, track) {
    // 1) Snap our state to the server's authoritative values for us. We copy the
    //    streamed fields onto our state object (keeping the same object identity
    //    the renderer already holds).
    Object.assign(this.state, snapshotToState(serverKart));

    // 2) Drop inputs the server has already applied.
    if (ackSeq != null) {
      this.pending = this.pending.filter((p) => p.seq > ackSeq);
    }

    // 3) Replay the still-pending inputs on top of the authoritative base so our
    //    predicted state ends up "ahead" exactly where our local inputs put us.
    //    Seed _prevSurface from the snapped authoritative position so the first
    //    replayed step's ramp/boost rising-edge test matches what the server saw,
    //    then replay each pending input through the SAME terrain-aware step the
    //    server + live prediction use (derive-at-pos, then step).
    const trackId = (track && track.trackId) || 'circuit';
    this._prevSurface = sampleSurface(trackId, this.state.x, this.state.z, this.state.y, this.state.lastS).surface;
    for (const p of this.pending) {
      this._stepWithTerrain(p.input, p.dt, track);
    }
  }
}

// ===========================================================================
// Interpolator — buffers remote-kart snapshots and samples them in the past.
// ===========================================================================
//
// For each remote kart id we keep a short, time-ordered buffer of snapshots,
// each tagged with the LOCAL arrival time. sample(id, renderTime) finds the two
// buffered snapshots that straddle renderTime and linearly interpolates position
// + (shortest-arc) heading between them, copying through the discrete FX fields
// (drifting tier, timers) from the newer one so the remote kart still shows
// drift sparks / star flash / shrink correctly.
export class Interpolator {
  constructor() {
    // id -> array of { t, state } sorted by t ascending.
    this.buffers = new Map();
    // How many snapshots to keep per kart (enough to always straddle the small
    // INTERP_DELAY; a handful is plenty and keeps memory tiny).
    this.maxBuffer = 12;
  }

  /**
   * Append a remote snapshot for one kart.
   * @param {*} id
   * @param {number} t      Local arrival time (seconds).
   * @param {Object} ks     The kart entry from snapshot.karts.
   */
  push(id, t, ks) {
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = [];
      this.buffers.set(id, buf);
    }
    buf.push({ t, state: snapshotToState(ks) });
    // Trim the oldest entries beyond the cap.
    if (buf.length > this.maxBuffer) buf.splice(0, buf.length - this.maxBuffer);
  }

  /**
   * Sample a remote kart's interpolated state at renderTime (seconds, local).
   * Returns a plain state object the Kart visual can read, or null if we have no
   * data for that id yet.
   * @param {*} id
   * @param {number} renderTime
   * @returns {Object|null}
   */
  sample(id, renderTime) {
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) return null;

    // If renderTime is before our oldest sample, just show the oldest.
    if (renderTime <= buf[0].t) return buf[0].state;
    // If renderTime is after our newest sample (we've run out of future data,
    // e.g. a snapshot was dropped), hold on the newest (mild freeze, no snap).
    const last = buf[buf.length - 1];
    if (renderTime >= last.t) return last.state;

    // Find the pair (a,b) with a.t <= renderTime <= b.t.
    let a = buf[0];
    let b = buf[1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderTime && renderTime <= buf[i + 1].t) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }

    // Interpolation factor 0..1 across the [a,b] interval.
    const span = b.t - a.t;
    const f = span > 0 ? (renderTime - a.t) / span : 0;

    // Linear-interpolate position; shortest-arc interpolate heading.
    const out = Object.assign({}, b.state); // copy discrete FX fields from newer
    out.x = lerp(a.state.x, b.state.x, f);
    out.y = lerp(a.state.y, b.state.y, f);
    out.z = lerp(a.state.z, b.state.z, f);
    out.heading = lerpAngle(a.state.heading, b.state.heading, f);
    // speed is only used by the Kart visual for wheel-roll; blend it too.
    out.speed = lerp(a.state.speed, b.state.speed, f);
    // ANTI-GRAV: when BOTH samples are in the SAME section, lerp the surface-relative
    // scalars so the remote kart's mesh orientation (re-derived by Kart.syncFromState
    // via surfaceFrameAt) is smooth, not 20Hz-stepped. The streamed x/y/z above already
    // encode the on-wall position. If the section differs (a transition straddles the
    // pair) we keep the newer snapshot's values — no blend across the boundary.
    if (a.state.agSection >= 0 && a.state.agSection === b.state.agSection) {
      out.agS = lerp(a.state.agS, b.state.agS, f);
      out.agLateral = lerp(a.state.agLateral, b.state.agLateral, f);
      out.agHeading = lerpAngle(a.state.agHeading, b.state.agHeading, f);
    }
    return out;
  }
}

// ===========================================================================
// Small shared helpers (module-local; no allocation in hot paths beyond the
// single state object returned by sample()).
// ===========================================================================

/**
 * Convert a streamed snapshot kart entry into the field shape the Kart visual +
 * stepKart read. The snapshot uses the SAME field names as the kart state, so
 * this is mostly a shallow copy of the known fields (defaulting any missing one
 * so the visual never reads undefined).
 * @param {Object} ks  snapshot.karts[i]
 * @returns {Object} a kart-state-shaped plain object.
 */
export function snapshotToState(ks) {
  return {
    x: ks.x || 0,
    y: ks.y || 0,
    z: ks.z || 0,
    heading: ks.heading || 0,
    speed: ks.speed || 0,
    // surface isn't streamed; default to 'road'. Reconcile re-derives it from the
    // track each replayed step anyway, and the remote visual doesn't need it.
    surface: 'road',
    // TERRAIN: vy/airborne/groundY/slope aren't streamed either. Seed them neutral
    // (grounded) on a snap; reconcile re-derives groundY/slope from the snapped
    // position before replaying, and a short jump self-corrects within ~1 snapshot.
    // groundY defaults to the streamed y so a grounded kart doesn't ease away from
    // the surface it was snapped onto.
    vy: 0,
    airborne: false,
    groundY: ks.y || 0,
    slope: 0,
    drifting: !!ks.drifting,
    driftDir: ks.driftDir || 0,
    driftCharge: 0, // not streamed; FX uses miniTurboTier below, not the charge
    miniTurboTier: ks.miniTurboTier || 0,
    boostTimer: ks.boostTimer || 0,
    // AURABORNE: streamed (see Room._emitSnapshot) so reconcile snaps the meter +
    // active surge to authority — the trick land-boost already reconciled via boostTimer.
    overdrive: ks.overdrive || 0,
    overdriveTimer: ks.overdriveTimer || 0,
    hopTimer: 0, // not streamed; the brief hop is a local-feel detail only
    spinTimer: ks.spinTimer || 0,
    starTimer: ks.starTimer || 0,
    shrinkTimer: ks.shrinkTimer || 0,
    coins: 0,
    // ANTI-GRAV: streamed ONLY while in a section (else absent -> default inert).
    // `?? -1` (not `|| -1`) because section index 0 is valid. reconcile()'s
    // Object.assign snaps these to authority; the local predictor then replays its
    // pending inputs through the same in-section stepKart. agTrackId is set per-tick
    // by updateAntigravTransition during replay, so it isn't streamed.
    agSection: ks.agSection ?? -1,
    agS: ks.agS || 0,
    agLateral: ks.agLateral || 0,
    agHeading: ks.agHeading || 0,
  };
}

/** Linear interpolation. */
function lerp(a, b, f) {
  return a + (b - a) * f;
}

/**
 * Interpolate between two angles along the SHORTEST arc (so wrapping from +PI to
 * -PI doesn't spin the kart the long way around).
 */
function lerpAngle(a, b, f) {
  let delta = b - a;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return a + delta * f;
}

/** Format seconds as mm:ss.mmm for the results overlay (mirrors HUD._formatTime). */
function formatTime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '--:--.---';
  const totalMs = Math.max(0, Math.floor(seconds * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');
  return mm + ':' + ss + '.' + mmm;
}
