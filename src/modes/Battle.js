// src/modes/Battle.js
//
// BALLOON BATTLE mode. No laps, no racing line — an arena free-for-all where
// every kart carries THREE balloons and the goal is to pop everyone else's.
//
// One player (driven by Input + the selection's stats/color) fights N-1 simple
// AI bots inside an Arena. Combat reuses the EXACT same systems the race uses:
//   - ItemSystem      rolls/holds/uses items (we feed it a flat rank so the
//                     position-weighted table still works in a lap-less mode).
//   - ProjectileSystem the flying/dropped hazards + their kart collisions.
//   - ItemBoxManager   the world "?" boxes + pickup detection (driven against an
//                     Arena ADAPTER so the boxes land on the arena's scattered
//                     itemSpawns instead of a circuit's checkpoint rows).
//   - KartPhysics     ground height + wall response against the Arena.
//   - Kart            the procedural kart visual (body, wheels, drift sparks).
//
// THE BALLOON TWIST
// The projectile/item systems already spin a kart out on a hit by setting
// state.spinTimer (via applySpin in the shared model). We DON'T modify those
// systems. Instead, each tick we watch every kart's spinTimer for a rising edge
// (was ~0, now > 0): that means "this kart just got hit". On that edge we POP one
// balloon (decrement the count, hide one floating balloon mesh) and let the brief
// spin stand as the hit reaction. A kart at 0 balloons is OUT — hidden and pulled
// from the combat lists. Last kart (or balloon leader at the time limit) wins.
//
// Conventions (match the project): Y up; XZ plane; forward = (sin h, 0, cos h).

import * as THREE from 'three';

import { Arena } from '../entities/Arena.js';
import { Kart } from '../entities/Kart.js';
import { KartPhysics } from '../physics/KartPhysics.js';
import { ItemSystem } from '../items/ItemSystem.js';
import { getItem } from '../items/items.js'; // resolve held-item id -> icon/name for the HUD slot
import { ItemBoxManager } from '../entities/ItemBox.js';
import { ProjectileSystem } from '../entities/Projectiles.js';

import { DT } from '../core/Loop.js';
import { makeRenderState } from '../core/interpolate.js';

import {
  createKartState,
  isInvincible,
} from '../../shared/kartModel.js';

// --- Battle tuning (local to this mode; not shared kart physics) -------------
const START_BALLOONS = 3;        // balloons each kart begins with
const TIME_LIMIT = 120;          // s  hard cap; highest balloon count wins at 0
const HIT_POP_SPIN = 1.0;        // s  brief spin applied as the balloon-pop reaction
const SPIN_EDGE_EPS = 0.05;      // s  spinTimer above this counts as "freshly hit"
const ITEM_BOX_RESPAWN_HINT = 3; // (boxes respawn via ItemBoxManager's own timer)

// RAM-to-pop tuning (client-only bumper-car combat; never touches shared physics).
const RAM_CONTACT = 2.3;         // m   center distance counting as a body-to-body hit
const RAM_CLOSING = 10;          // m/s closing speed needed for a contact to pop a balloon
const RAM_COOLDOWN = 0.6;        // s   per-victim guard so one crash pops exactly one balloon
const POP_CREDIT_RADIUS = 3.0;   // m   how near a player projectile must be to credit a pop

// Distinct kart colors (player color is overridden by the selection if given).
const BOT_COLORS = [
  0x34c759, 0x0a84ff, 0xffd60a, 0xff9f0a, 0xbf5af2,
  0xff2d55, 0x5ac8fa, 0x30d158, 0xffcc00, 0x64d2ff, 0xff6482,
];

// Balloon colors cycled across a kart's three balloons so the cluster reads.
const BALLOON_COLORS = [0xff5566, 0x44bbff, 0xffe14d];

// TACTICAL item categories for the battle AI (ids must match items.js). FORWARD
// items are fired when a rival is lined up AHEAD; DEFENSIVE traps are dropped on a
// chaser closing from BEHIND (or while evading). Everything else (mushroom/star/
// lightning/boo/coin/superHorn) is a self/area effect the bot uses to commit while
// hunting, fleeing, or dodging. Mirrors AIRacer's by-category firing idea.
const FORWARD_ITEMS = new Set(['greenShell', 'redShell', 'tripleGreen', 'tripleRed', 'bulletBill', 'blueShell']);
const DEFENSIVE_ITEMS = new Set(['banana', 'tripleBanana', 'fakeBox', 'bobOmb']);

export class Battle {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene      scene to add the arena + kart meshes to.
   * @param {object} opts.renderer        Renderer (chase camera follows the player).
   * @param {object} opts.input           Input instance (getState()).
   * @param {object} opts.hud             HUD instance (update(state, info)).
   * @param {object} [opts.selection]     player pick: { stats, color, name }.
   *        - stats  : { topSpeed, accel, handling, weight, traction, miniTurbo },
   *                   each ~0..1. Passed straight into createKartState({stats}) so
   *                   stepKart scales the player's physics. Omitted => neutral.
   *        - color  : player kart body color (any THREE.Color input).
   * @param {number} [opts.fieldSize=8]   total karts = 1 player + (fieldSize-1) bots.
   */
  constructor({ scene, renderer, input, hud, audio = null, vfx = null, selection = {}, fieldSize = 8 }) {
    this.scene = scene;
    this.renderer = renderer;
    this.input = input;
    this.hud = hud;
    // AudioManager (optional): used for the balloon-pop SFX + final-10s beeps. All
    // calls are guarded so a missing audio system never throws.
    this.audio = audio;
    // VFX pool (optional): the win confetti burst on a player victory. Guarded.
    this.vfx = vfx;
    this.selection = selection || {};
    this.fieldSize = Math.max(2, fieldSize); // need at least the player + 1 bot

    // --- Build the arena and add it to the scene. --------------------------
    this.arena = new Arena({ fieldSize: this.fieldSize });
    this.scene.add(this.arena.group);
    // Apply the arena's NEON/SPACE theme: dark starry backdrop + fog so the
    // glowing floor grid and neon rails pop (and the bloom isn't washed out).
    if (typeof this.arena.applyTheme === 'function') {
      this._prevSceneBackground = this.scene.background;
      this._prevSceneFog = this.scene.fog;
      this.arena.applyTheme(this.scene);
    }

    // --- Combat subsystems (reused from the race), built once. -------------
    // ONE physics wrapper reused for every kart (sequential per-kart raycasts).
    this.physics = new KartPhysics();
    // Item roller/holder. We don't seed an rng so battles vary run to run.
    this.itemSystem = new ItemSystem();
    // Projectile pool. It reads arena.isOnRoad (alias of isInside) for bounces.
    this.projectiles = new ProjectileSystem(scene, this.arena);
    // World item boxes. ItemBoxManager places boxes along a Track's checkpoints,
    // so we hand it a thin ADAPTER that presents the arena's scattered itemSpawns
    // as single-box "checkpoints" (see _makeBoxAdapter). Reused unchanged.
    this.itemBoxes = new ItemBoxManager(this._makeBoxAdapter(), scene);

    // --- Build the field of karts. -----------------------------------------
    // Each record: { id, state, kart, isPlayer, balloons, balloonMeshes[],
    //                alive, prevSpin, _input, _prevUseItem, aiState }.
    this.karts = [];           // ALL karts (alive + out); combat lists filter alive.
    this._kartById = new Map();
    this._buildField();

    // Combat clock + match state.
    this.clock = 0;            // seconds elapsed this battle.
    this.finished = false;     // true once results are shown (main.js reads this).
    this.winnerId = null;
    // END FLOURISH: when a winner is decided we DON'T snap straight to results —
    // we freeze the sim, flash a banner ("TIME!" / "YOU WIN!"), let the win
    // confetti play, then flip `finished` so main.js shows the polished board.
    this._ending = false;      // true during the brief end flourish (sim frozen).
    this._endTimer = 0;        // seconds left in the flourish before results.
    this._endReason = null;    // 'timeout' | 'lastStanding' (shapes the banner).
    // Monotonic knockout counter -> survival ranking (later out = better place).
    this._knockoutSeq = 0;
    // Last integer second we beeped, so the final-10s countdown beeps once/second.
    this._lastBeepSec = null;
    // One-shot guard for the match-start objective banner (shows HOW to pop).
    this._objectiveShown = false;
    // Reused flat [x,z,x,z,...] snapshot of the player's live projectiles, taken
    // BEFORE projectiles.update so a pop can be credited to the player's shell/bomb
    // (the hitting projectile is recycled by the time pops resolve). Alloc-free.
    this._playerProjScratch = [];

    // Scratch context reused for the simple bot AI each tick (no per-tick alloc).
    this._aiCtx = {};

    // Remember the player's last steer so render() angles the front wheels.
    this._playerLastSteer = 0;
  }

  /**
   * Build a minimal Track-like ADAPTER so the unmodified ItemBoxManager drops one
   * box at each of the arena's itemSpawns. ItemBoxManager reads:
   *   .checkpoints  ordered [{x,z}] — it places a row of boxes at chosen indices.
   *   .roadWidth    the band width it spreads a row across.
   *   .isOnRoad     (unused for placement; provided for safety).
   * We map every itemSpawn to a checkpoint and use a tiny roadWidth so the 3
   * boxes a "row" spreads collapse onto (essentially) one point per spawn — i.e.
   * one grab-able box per arena itemSpawn.
   * @returns {object} the adapter.
   * @private
   */
  _makeBoxAdapter() {
    // ItemBoxManager now spreads its box rows EVENLY across the whole checkpoint
    // list (see ItemBox._rowCheckpoints) rather than the old fixed [2,5,8,11,14].
    // To stay robust to WHICHEVER indices it picks, we make EVERY checkpoint a
    // real arena itemSpawn (cycling through the spawns), and include a `y` so the
    // box rides the spawn height. The manager only builds a row at a handful of
    // indices, so each chosen index lands on a genuine spawn point either way.
    const spawns = this.arena.itemSpawns;
    const checkpoints = [];
    // A comfortable length so the spread always has room (>= the manager's needs).
    const LEN = Math.max(20, spawns.length + 2);
    for (let i = 0; i < LEN; i++) {
      const sp = spawns.length ? spawns[i % spawns.length] : { x: 0, y: 0, z: 0 };
      checkpoints.push({ x: sp.x, y: sp.y || 0, z: sp.z, index: i });
    }
    return {
      checkpoints,
      // Tiny width so a 3-box row collapses to a single visible box per spawn.
      roadWidth: 0.001,
      isOnRoad: (x, z) => this.arena.isOnRoad(x, z),
    };
  }

  /**
   * Build the 1 player + (fieldSize-1) bot kart records at the arena's spawn
   * poses. The player gets the selection's stats + color; bots get neutral stats
   * (createKartState default) and palette colors.
   * @private
   */
  _buildField() {
    const spawns = this.arena.spawnPoints;
    for (let i = 0; i < this.fieldSize; i++) {
      const isPlayer = i === 0;
      const id = isPlayer ? 'player' : 'bot' + i;

      // Spawn pose from the arena ring (wrap if somehow short).
      const pose = spawns[i % spawns.length];

      // State: the player's carries the selection stats so stepKart scales its
      // physics; bots use the neutral default (no stats => identical to today).
      const stateOpts = {
        x: pose.x, y: pose.y, z: pose.z, heading: pose.heading,
      };
      if (isPlayer && this.selection.stats) {
        stateOpts.stats = this.selection.stats;
      }
      const state = createKartState(stateOpts);

      // Visual kart, colored per player selection / bot palette.
      const color = isPlayer
        ? (this.selection.color != null ? this.selection.color : 0xff3b30)
        : BOT_COLORS[(i - 1) % BOT_COLORS.length];
      const kart = new Kart({ color });
      this.scene.add(kart.group);

      // Three floating balloon meshes above the kart (parented to the kart group
      // so they ride along with position + heading automatically).
      const balloonMeshes = this._buildBalloons(kart);

      const record = {
        id,
        state,
        kart,
        color,            // kart body tint (echoed as the results-row colour chip)
        isPlayer,
        balloons: START_BALLOONS,
        balloonMeshes,
        alive: true,
        outOrder: 0,      // knockout sequence (0 = still alive); higher = out later

        // Previous-tick spinTimer, for the rising-edge "just got hit" detection.
        prevSpin: 0,
        // Who caused this kart's pending pop ('player' | bot id | null). Set by the
        // ram pass + the player-fired specials + the projectile-proximity credit,
        // then read once by _popBalloon for the scoring cue and cleared.
        poppedBy: null,
        // Timestamp (battle clock) until which this kart can't be ram-popped again,
        // so a single crash pops one balloon, not a chain while bodies stay locked.
        _ramCooldownUntil: 0,
        // Per-kart input + rising-edge item bookkeeping (mirrors RaceManager).
        _input: null,
        _prevUseItem: false,
        // Tiny bit of wander state for the bot AI (deterministic-ish heading goal).
        aiWanderHeading: pose.heading,
        aiWanderTimer: 0,
        aiItemCooldown: 0,
        // Previous physics-tick transform, for render interpolation. Seeded to the
        // spawn pose so the very first frame (before any tick) interpolates against
        // itself and is perfectly stable — no snap from a zeroed pose.
        prevTransform: {
          x: state.x,
          y: state.y,
          z: state.z,
          heading: state.heading,
        },
      };

      this.karts.push(record);
      this._kartById.set(id, record);
    }
  }

  /**
   * Build three small balloon meshes and attach them above a kart. Each balloon
   * is a stretched sphere on a thin string, parented to the kart group so it
   * follows the kart. Returned as an array we hide one-by-one as balloons pop.
   * @param {Kart} kart
   * @returns {THREE.Object3D[]} the three balloon pivot groups (index 0..2).
   * @private
   */
  _buildBalloons(kart) {
    const meshes = [];
    // Sphere geometry shared across this kart's three balloons (cheap).
    const balloonGeo = new THREE.SphereGeometry(0.32, 10, 8);
    const stringGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.6, 4);
    const stringMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });

    // Spread the three balloons in a small arc above and behind the driver.
    const offsets = [
      { x: -0.4, z: -0.1 },
      { x: 0.0, z: -0.25 },
      { x: 0.4, z: -0.1 },
    ];

    for (let i = 0; i < START_BALLOONS; i++) {
      const pivot = new THREE.Group();
      const off = offsets[i] || { x: 0, z: 0 };
      // Float the cluster ~2.2 m up so it clears the driver's head.
      pivot.position.set(off.x, 2.2, off.z);

      const mat = new THREE.MeshStandardMaterial({
        color: BALLOON_COLORS[i % BALLOON_COLORS.length],
        emissive: BALLOON_COLORS[i % BALLOON_COLORS.length],
        emissiveIntensity: 0.25,
        roughness: 0.4,
        metalness: 0.0,
      });
      const balloon = new THREE.Mesh(balloonGeo, mat);
      // Stretch slightly taller than wide for a balloon shape.
      balloon.scale.set(1, 1.25, 1);
      balloon.castShadow = true;
      pivot.add(balloon);

      // A short string hanging below the balloon down toward the kart.
      const string = new THREE.Mesh(stringGeo, stringMat);
      string.position.y = -0.5;
      pivot.add(string);

      kart.group.add(pivot);
      meshes.push(pivot);
    }
    return meshes;
  }

  // ========================================================================
  // FIXED-STEP UPDATE (called at 60Hz; dt === DT).
  // ========================================================================
  /**
   * Advance the battle by one fixed step: gather input, step physics, run item
   * boxes/uses/projectiles, then resolve balloon pops from fresh hits and check
   * for a winner.
   * @param {number} dt  fixed timestep in seconds.
   */
  update(dt) {
    if (this.finished) return;

    // END FLOURISH: a winner is decided but we hold the sim for a brief beat so the
    // banner + confetti land before the results board. Tick it down, then finish.
    if (this._ending) {
      this._endTimer -= dt;
      if (this._endTimer <= 0) this._finish();
      return; // freeze combat during the flourish
    }

    this.clock += dt;

    // MATCH-START OBJECTIVE: the moment combat begins, name HOW to pop a balloon
    // using the REAL controls (items = SHIFT/E held, ram = drive into a rival at
    // speed). This is the single biggest comprehension fix — the player no longer
    // has to guess. One DOM/GSAP banner (low-tier safe), fired exactly once.
    if (!this._objectiveShown) {
      this._objectiveShown = true;
      if (this.hud && typeof this.hud.showRewardBanner === 'function') {
        this.hud.showRewardBanner(
          '🎈 POP THEIR BALLOONS — ram rivals at speed, or hit them with items (SHIFT)',
          'alert',
          1.8
        );
      }
    }

    // FINAL-10s urgency beep: once per second over the last 10 seconds, rising in
    // pitch as it closes (sfxCountdown: lower n = higher/urgent). The visual pulse
    // lives on the HUD clock (fed timeLeft in render()).
    const secsLeft = Math.ceil(TIME_LIMIT - this.clock);
    if (secsLeft <= 10 && secsLeft > 0 && secsLeft !== this._lastBeepSec) {
      this._lastBeepSec = secsLeft;
      if (this.audio && typeof this.audio.sfxCountdown === 'function') {
        this.audio.sfxCountdown(Math.max(1, Math.min(3, secsLeft)));
      }
    }

    // Live combat list = only karts that still have balloons. ItemBox/Projectile
    // systems read .id/.state, which our records expose, so we hand them the
    // alive subset directly.
    const alive = this._aliveKarts();

    // --- 1. Per-kart: input -> physics. ------------------------------------
    for (let i = 0; i < alive.length; i++) {
      const rec = alive[i];

      // Record the PRE-step spin so the post-step rising-edge test is clean.
      rec.prevSpin = rec.state.spinTimer;

      // Snapshot the transform we are ABOUT to step away from. render() blends
      // this PREVIOUS tick against the CURRENT one by alpha to kill judder.
      // Mutate-copy in place so there's no per-tick allocation.
      const pt = rec.prevTransform;
      pt.x = rec.state.x;
      pt.y = rec.state.y;
      pt.z = rec.state.z;
      pt.heading = rec.state.heading;

      // Input: player reads the controls; bots compute the same input shape.
      let input;
      if (rec.isPlayer) {
        input = this.input.getState();
        this._playerLastSteer = input.steer;
      } else {
        input = this._botInput(rec, alive, dt);
      }
      rec._input = input;

      // Step the deterministic model + resolve ground/surface/wall vs the arena.
      this.physics.update(rec.state, input, dt, this.arena);

      // Keep karts inside the bounds as a hard backstop (walls already push back,
      // but clamp so a fast corner hit can never escape the floor).
      this._clampToArena(rec.state);
    }

    // --- 2. Item boxes: award an item while the grabber has a free slot (up to 3). --
    const pickups = this.itemBoxes.update(alive, dt);
    for (let p = 0; p < pickups.length; p++) {
      const racerId = pickups[p].racerId;
      if (!this.itemSystem.hasFreeSlot(racerId)) continue;
      // Battle has no lap rank; use a flat MID-ish rank so the weighted table
      // hands out a balanced spread (rank = half the field).
      const rank = Math.floor(this.fieldSize / 2);
      const itemId = this.itemSystem.rollItem(rank, this.fieldSize);
      this.itemSystem.giveItem(racerId, itemId);
    }

    // --- 3. Item USE on the rising edge of useItem. -------------------------
    for (let i = 0; i < alive.length; i++) {
      const rec = alive[i];
      const input = rec._input;
      const useNow = !!(input && input.useItem);
      const fire = useNow && !rec._prevUseItem;
      rec._prevUseItem = useNow;
      if (!fire) continue;
      if (!this.itemSystem.hasItem(rec.id)) continue;
      this._useItemFor(rec, alive);
    }

    // --- 4. Projectiles: move/home/bounce/collide vs the alive karts. -------
    // On a hit the projectile system sets state.spinTimer (via applySpin). We do
    // NOT let that stand as a full race spin-out — step 5 converts it to a pop.
    // Snapshot the player's live projectiles FIRST: a hitting projectile is recycled
    // during update(), so this pre-shot positions list is how we credit a shell/bomb
    // pop to the player (see _playerProjectileNear).
    this._snapshotPlayerProjectiles();
    this.projectiles.update(dt, alive);

    // --- 4.5 RAM pops: a hard body-to-body contact at speed pops the struck
    //     kart's balloon, so "drive into them" actually works (the headline fun +
    //     clarity fix). Runs BEFORE the resolver so the spin it sets converts to a
    //     normal pop — inheriting the pooled burst VFX + pop SFX for free. Client
    //     -only (no kart-kart collision in the shared sim is touched).
    this._resolveRamHits(alive);

    // --- 5. Balloon pops: detect fresh hits (spinTimer rising edge). --------
    this._resolveBalloonHits(alive);

    // --- 6. Win check: one kart left, or the timer ran out. -----------------
    this._checkWinner();
  }

  /**
   * Resolve a held item for one kart, mirroring RaceManager but with a flat
   * "standings" list (alive karts) for the few items that need targets. Most
   * battle items are projectiles/traps/self, which don't need real standings.
   * @param {object} rec    the firing kart record.
   * @param {Array}  alive  the alive kart list (combat list).
   * @private
   */
  _useItemFor(rec, alive) {
    // Flat standings: order alive karts by balloon count (leader-first-ish) so
    // leader-seeking items (blue shell) still pick a sensible victim.
    const standings = alive
      .slice()
      .sort((a, b) => b.balloons - a.balloons)
      .map((r) => ({ id: r.id }));

    const action = this.itemSystem.useItem(rec.id, rec.state, {
      standings,
      fieldSize: this.fieldSize,
    });
    if (!action) return;

    switch (action.kind) {
      case 'self': {
        // Mushroom/star/coin apply straight to the user. (superHorn's area effect
        // would need the full field; we resolve a simple version inline below.)
        if (typeof action.apply === 'function') action.apply(rec.state);
        if (action.item === 'superHorn') this._resolveSuperHorn(rec, alive);
        break;
      }
      case 'projectile': {
        // blueShell / leader-seeker: spin the balloon leader (that isn't us).
        if (action.item === 'blueShell' || action.targetsLeader) {
          this._fireLeaderStrike(rec, alive, action);
        } else {
          this.projectiles.spawn(action.item, rec.state, {
            karts: alive,
            ownerId: rec.id,
          });
        }
        break;
      }
      case 'trap': {
        this.projectiles.spawn(action.item, rec.state, {
          karts: alive,
          ownerId: rec.id,
        });
        break;
      }
      case 'global': {
        // lightning shrinks everyone else; boo ghosts the user. Build a flat
        // { id: state } map of alive karts for the descriptor to walk.
        const map = {};
        for (let i = 0; i < alive.length; i++) map[alive[i].id] = alive[i].state;
        if (typeof action.apply === 'function') action.apply(map, rec.id);
        if (action.item === 'boo') this._stealItemFor(rec.id, alive);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Blue-shell-style strike: spin the alive kart with the MOST balloons (that
   * isn't the firer), unless invincible. We also launch a redShell visual toward
   * the field for on-screen feedback. The spin becomes a balloon pop in step 5.
   * @private
   */
  _fireLeaderStrike(rec, alive, action) {
    let leader = null;
    for (let i = 0; i < alive.length; i++) {
      const r = alive[i];
      if (r.id === rec.id) continue;
      if (!leader || r.balloons > leader.balloons) leader = r;
    }
    if (!leader) return;
    const secs = action && action.spinSecs ? action.spinSecs : HIT_POP_SPIN;
    if (!isInvincible(leader.state)) {
      // Apply the spin directly (the model's applySpin guards invincibility); the
      // rising-edge detector then pops a balloon.
      if (secs > leader.state.spinTimer) leader.state.spinTimer = secs;
      // Credit the firer so a player leader-strike shows the green "POP!" confirm.
      leader.poppedBy = rec.id;
    }
    // Visual flourish only — COSMETIC so it never collides and can't pop a
    // balloon off an unintended kart. The real hit was applied above.
    this.projectiles.spawn('redShell', rec.state, { karts: alive, ownerId: rec.id, cosmetic: true });
  }

  /**
   * Super horn: spin every nearby rival (and clear nearby projectiles). Reads the
   * alive list directly. Mirrors RaceManager's resolver, scaled to the arena.
   * @private
   */
  _resolveSuperHorn(rec, alive) {
    const R2 = 7 * 7;
    const ox = rec.state.x;
    const oz = rec.state.z;
    for (let i = 0; i < alive.length; i++) {
      const other = alive[i];
      if (other.id === rec.id) continue;
      const dx = other.state.x - ox;
      const dz = other.state.z - oz;
      if (dx * dx + dz * dz <= R2 && !isInvincible(other.state)) {
        if (HIT_POP_SPIN > other.state.spinTimer) other.state.spinTimer = HIT_POP_SPIN;
        // Credit the horn user so a player blast shows the green "POP!" confirm.
        other.poppedBy = rec.id;
      }
    }
    // Destroy projectiles in the blast (reuse the pool the projectile system owns).
    const pool = this.projectiles._pool;
    if (pool) {
      for (let i = 0; i < pool.length; i++) {
        const proj = pool[i];
        if (!proj.active) continue;
        const dx = proj.mesh.position.x - ox;
        const dz = proj.mesh.position.z - oz;
        if (dx * dx + dz * dz <= R2) this.projectiles._recycle(proj);
      }
    }
  }

  /**
   * RAM pops (bumper-car combat). For every pair of alive karts in body contact,
   * compute the closing speed along their separation axis from each kart's scalar
   * speed + heading; if they're crashing together fast enough, the SLOWER (struck)
   * kart's balloon pops. We set its spinTimer to HIT_POP_SPIN so the existing
   * rising-edge resolver converts it to a normal pop (free burst VFX + pop SFX),
   * record the rammer for the scoring cue, and arm a brief per-victim cooldown so
   * one crash pops exactly one balloon (not a chain while bodies stay locked).
   *
   * O(n^2/2) over <= 8 karts (~28 pairs) — trivial at 60Hz. Client-only: the
   * shared sim has no kart-kart collision, and we touch nothing it owns.
   * @param {Array} alive
   * @private
   */
  _resolveRamHits(alive) {
    const R2 = RAM_CONTACT * RAM_CONTACT;
    const now = this.clock;
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      const sa = a.state;
      const avx = Math.sin(sa.heading) * sa.speed;
      const avz = Math.cos(sa.heading) * sa.speed;
      for (let j = i + 1; j < alive.length; j++) {
        const b = alive[j];
        const sb = b.state;
        const dx = sb.x - sa.x;
        const dz = sb.z - sa.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2 || d2 < 1e-4) continue; // out of contact (or exactly overlapping)
        const dist = Math.sqrt(d2);
        const nx = dx / dist; // unit a->b separation axis
        const nz = dz / dist;
        const bvx = Math.sin(sb.heading) * sb.speed;
        const bvz = Math.cos(sb.heading) * sb.speed;
        // Closing speed = how fast the gap is shrinking along that axis.
        const closing = (avx * nx + avz * nz) - (bvx * nx + bvz * nz);
        if (closing < RAM_CLOSING) continue; // glancing / drafting — no pop
        // The faster kart is the rammer; the slower/tied one takes the pop.
        const aFaster = Math.abs(sa.speed) >= Math.abs(sb.speed);
        const victim = aFaster ? b : a;
        const attacker = aFaster ? a : b;
        const vs = victim.state;
        if (now < (victim._ramCooldownUntil || 0)) continue; // still in pop cooldown
        if (vs.spinTimer > SPIN_EDGE_EPS || isInvincible(vs)) continue; // mid-pop / starred
        vs.spinTimer = HIT_POP_SPIN;          // -> a pop in _resolveBalloonHits
        victim.poppedBy = attacker.id;        // attribution for the scoring cue
        victim._ramCooldownUntil = now + RAM_COOLDOWN;
      }
    }
  }

  /**
   * Snapshot the player's live (non-cosmetic) projectile positions into a reused
   * flat [x,z,x,z,...] array. Taken BEFORE projectiles.update, because a projectile
   * that lands a hit is recycled the same tick — this pre-impact list is how
   * _playerProjectileNear later credits a shell/bomb pop to the player.
   * @private
   */
  _snapshotPlayerProjectiles() {
    const snap = this._playerProjScratch;
    snap.length = 0;
    const pool = this.projectiles && this.projectiles._pool;
    if (!pool) return;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (p && p.active && p.ownerId === 'player' && !p.cosmetic) {
        snap.push(p.mesh.position.x, p.mesh.position.z);
      }
    }
  }

  /**
   * True if one of the player's snapshotted projectiles was within POP_CREDIT_RADIUS
   * of this kart state — i.e. the player's shell/bomb most likely caused the pop.
   * ponytail: positional heuristic (a projectile is recycled before pops resolve, so
   * exact owner isn't readable without editing the shared projectile system). Worst
   * case is a rare cosmetic mis-credit when two shots overlap — never a sim bug.
   * @param {object} state
   * @returns {boolean}
   * @private
   */
  _playerProjectileNear(state) {
    const snap = this._playerProjScratch;
    const R2 = POP_CREDIT_RADIUS * POP_CREDIT_RADIUS;
    for (let i = 0; i < snap.length; i += 2) {
      const dx = snap[i] - state.x;
      const dz = snap[i + 1] - state.z;
      if (dx * dx + dz * dz <= R2) return true;
    }
    return false;
  }

  /**
   * Boo steal: hand a random rival's held item to userId and clear the victim.
   * @private
   */
  _stealItemFor(userId, alive) {
    const victims = [];
    for (let i = 0; i < alive.length; i++) {
      const r = alive[i];
      if (r.id === userId) continue;
      if (this.itemSystem.hasItem(r.id)) victims.push(r.id);
    }
    if (victims.length === 0) return;
    const pick = Math.floor(this.itemSystem.rng() * victims.length);
    const victimId = victims[Math.min(pick, victims.length - 1)];
    const stolen = this.itemSystem.getHeld(victimId);
    if (!stolen) return;
    this.itemSystem.giveItem(userId, stolen.id);
    this.itemSystem.clear(victimId);
  }

  /**
   * Convert fresh hits into balloon pops. A kart whose spinTimer just rose from
   * ~0 to > 0 (and isn't invincible) was hit this tick: pop one balloon. We cap
   * the standing spin to a brief HIT_POP_SPIN so a battle hit is a quick stumble,
   * not a long race-style spin-out. A kart reaching 0 balloons is knocked OUT.
   * @param {Array} alive
   * @private
   */
  _resolveBalloonHits(alive) {
    for (let i = 0; i < alive.length; i++) {
      const rec = alive[i];
      const s = rec.state;
      // Rising edge: it was effectively not spinning before, and is now.
      const justHit = rec.prevSpin <= SPIN_EDGE_EPS && s.spinTimer > SPIN_EDGE_EPS;
      if (!justHit) continue;
      // A starred kart shouldn't have been spun at all, but guard anyway.
      if (isInvincible(s)) {
        s.spinTimer = 0;
        continue;
      }
      // Trim the spin to a brief pop reaction.
      if (s.spinTimer > HIT_POP_SPIN) s.spinTimer = HIT_POP_SPIN;
      // Credit a projectile pop to the player if (and only if) one of the player's
      // own shells/bombs was right beside this victim just before impact, and the
      // pop wasn't already attributed by the ram pass / a player special.
      if (!rec.poppedBy && rec.id !== 'player' && this._playerProjectileNear(s)) {
        rec.poppedBy = 'player';
      }
      this._popBalloon(rec);
    }
  }

  /**
   * Pop one balloon on a kart: hide the highest remaining balloon mesh, decrement
   * the count, and if it hits 0 knock the kart OUT (hide it + clear its items).
   * @param {object} rec
   * @private
   */
  _popBalloon(rec) {
    if (rec.balloons <= 0) return;
    rec.balloons -= 1;
    // Hide the mesh at the new count index (e.g. going 3->2 hides mesh[2]).
    const mesh = rec.balloonMeshes[rec.balloons];
    if (mesh) mesh.visible = false;

    // POP feedback: a punchy pop SFX for EVERY pop (player + bots). The VISUAL
    // burst (shockwave ring + debris + dazed spin-stars) is fired by ItemVFX on
    // the same spinTimer rising edge for every kart in getKarts() — see main.js's
    // itemVfx.update per-kart pass. The PLAYER additionally gets the full race
    // hit-juice (red hitFlash + amped camera shake + thud) from main.js's existing
    // player spin-edge hook, so we don't duplicate it here.
    if (this.audio && typeof this.audio.sfxPop === 'function') this.audio.sfxPop();

    // READABLE CUE so every balloon change is understood (the feedback loop the
    // player said was missing). When the player LOSES one: an urgent "-1" cue (the
    // red screen flash already comes from main.js). When the player SCORES one off
    // a rival: a green "POP!" confirm naming the victim. Suppressed on the KILLING
    // pop — _knockOut's banner says it better and would otherwise be clobbered.
    const scoredByPlayer = rec.poppedBy === 'player';
    if (rec.balloons > 0 && this.hud && typeof this.hud.showRewardBanner === 'function') {
      if (rec.isPlayer) {
        this.hud.showRewardBanner('POP!  -1 balloon', 'alert');
      } else if (scoredByPlayer) {
        this.hud.showRewardBanner('POP! 🎈  ' + this._displayName(rec) + ' -1');
      }
    }

    if (rec.balloons <= 0) {
      this._knockOut(rec, scoredByPlayer);
    }
    // Attribution is single-use: clear it so a later pop from another source can't
    // inherit a stale "scored by" credit.
    rec.poppedBy = null;
  }

  /**
   * Knock a kart out of the battle: mark it dead, hide its whole visual, and drop
   * any held item. It stays in this.karts (for the final tally) but is filtered
   * out of every combat list by _aliveKarts().
   * @param {object} rec
   * @param {boolean} [scoredByPlayer]  the player landed the finishing pop.
   * @private
   */
  _knockOut(rec, scoredByPlayer = false) {
    rec.alive = false;
    rec.outOrder = ++this._knockoutSeq; // later knockout = survived longer = better place
    rec.kart.group.visible = false;
    this.itemSystem.clear(rec.id);

    const canBanner = this.hud && typeof this.hud.showRewardBanner === 'function';

    // THE PLAYER'S OWN ELIMINATION is always announced, loud and distinct — even
    // when it's the match-decider (the camera is about to pan to a survivor, which
    // is otherwise a confusing silent jump). A bold, longer alert banner + a red
    // screen wash so "you're out, now spectating" is unmissable.
    if (rec.isPlayer) {
      if (canBanner) this.hud.showRewardBanner("YOU'RE OUT — spectating", 'alert', 1.6);
      if (typeof this.hud._pulseFlash === 'function') {
        this.hud._pulseFlash('rgba(244, 63, 94, 0.5)', 0.5, 0.6); // rose-500 wash
      }
      return;
    }

    // ELIMINATION FEED for a bot: a brief centered toast naming who's out (and
    // crediting the player when they landed it, to reward aggression). Skip when
    // the knockout IS the match-ender — _beginEnding's win banner says it better
    // and would otherwise be clobbered the same frame.
    const aliveLeft = this.getAliveCount();
    if (aliveLeft > 1 && canBanner) {
      const who = this._displayName(rec);
      this.hud.showRewardBanner(
        scoredByPlayer ? '💥 You knocked out ' + who + '!' : '💥 ' + who + ' knocked out!'
      );
    }
  }

  /**
   * Friendly display name for a kart record: the player shows their character
   * name (or "You"); bots read "CPU N" from their id. Used by the elimination
   * feed + the results board.
   * @param {object} rec
   * @returns {string}
   * @private
   */
  _displayName(rec) {
    if (rec.isPlayer) return this.selection.name || 'You';
    return 'CPU ' + String(rec.id).replace('bot', '');
  }

  /**
   * Decide the battle outcome. Win conditions:
   *   - exactly one kart still has balloons -> that kart wins, OR
   *   - the time limit elapsed -> the kart with the most balloons wins (first by
   *     balloon count; ties broken by id order, which is fine for a casual mode).
   * On a decision we set finished + winnerId and show the result overlay.
   * @private
   */
  _checkWinner() {
    if (this._ending || this.finished) return;
    const alive = this._aliveKarts();

    if (alive.length <= 1) {
      this.winnerId = alive.length === 1 ? alive[0].id : null;
      this._beginEnding('lastStanding');
      return;
    }
    if (this.clock >= TIME_LIMIT) {
      // Most balloons wins; first max in record order takes ties.
      let best = alive[0];
      for (let i = 1; i < alive.length; i++) {
        if (alive[i].balloons > best.balloons) best = alive[i];
      }
      this.winnerId = best.id;
      this._beginEnding('timeout');
    }
  }

  /**
   * Begin the brief, NON-abrupt end flourish: freeze the sim, flash the outcome
   * banner, and let the win celebration (confetti + fanfare, fired by main.js on
   * the `finished` edge) play. After a short beat, _finish() flips `finished` so
   * the polished results board is shown by the mode router.
   * @param {'timeout'|'lastStanding'} reason  why the match ended (shapes the banner).
   * @private
   */
  _beginEnding(reason) {
    if (this._ending || this.finished) return;
    this._ending = true;
    this._endReason = reason;
    this._endTimer = 1.4; // s — banner + confetti beat before the board

    // Banner: a clear, kid-friendly outcome. Timeout leads with "TIME!".
    const playerWon = this.winnerId === 'player';
    let msg;
    if (this.winnerId == null) {
      msg = reason === 'timeout' ? "TIME! It's a draw!" : "It's a draw!";
    } else if (playerWon) {
      msg = reason === 'timeout' ? '⏱ TIME! You win!' : '🎉 You win!';
    } else {
      const winner = this._kartById.get(this.winnerId);
      const who = winner ? this._displayName(winner) : 'CPU';
      msg = (reason === 'timeout' ? 'TIME! ' : '') + who + ' wins';
    }
    if (this.hud && typeof this.hud.showRewardBanner === 'function') {
      this.hud.showRewardBanner(msg);
    }

    // WIN celebration (player victory only): a confetti fountain over the player +
    // the triumphant fanfare, fired NOW so it lands with the banner — before the
    // results board appears. (main.js's generic finish fanfare is gated off for
    // battle via isPlayerFinished, so this is the single, win-only celebration.)
    if (playerWon) {
      const p = this._kartById.get('player');
      if (p && this.vfx && typeof this.vfx.confettiBurst === 'function') {
        this.vfx.confettiBurst({ x: p.state.x, y: (p.state.y || 0) + 1, z: p.state.z });
      }
      if (this.audio && typeof this.audio.sfxFinish === 'function') this.audio.sfxFinish();
    }
  }

  /**
   * Flip the battle to finished so the mode router (main.js) shows the polished
   * results board (and fires the win confetti/fanfare on this rising edge).
   * @private
   */
  _finish() {
    if (this.finished) return;
    this.finished = true;
  }

  /**
   * Build the final standings for the results board, best-first. Ranking:
   *   1) karts still holding balloons, by balloons DESC, then
   *   2) eliminated karts by SURVIVAL (later knockout = better),
   * so the last kart out beats the first kart out. Each entry carries what the
   * board needs: place, display name, colour chip, isPlayer, balloons, eliminated.
   * @returns {Array<{place:number,id:string,name:string,color:number,
   *                   isPlayer:boolean,balloons:number,eliminated:boolean}>}
   */
  getBattleResults() {
    const ranked = this.karts.slice().sort((a, b) => {
      const aOut = a.balloons <= 0;
      const bOut = b.balloons <= 0;
      if (aOut !== bOut) return aOut ? 1 : -1;       // survivors above the eliminated
      if (!aOut) return b.balloons - a.balloons;      // both alive: more balloons first
      return b.outOrder - a.outOrder;                 // both out: later knockout first
    });
    return ranked.map((rec, i) => ({
      place: i + 1,
      id: rec.id,
      name: this._displayName(rec),
      color: rec.color,
      isPlayer: rec.isPlayer,
      balloons: Math.max(0, rec.balloons),
      eliminated: rec.balloons <= 0,
    }));
  }

  // ========================================================================
  // BOT AI — simple roam-and-chase (no racing line).
  // ========================================================================
  /**
   * Produce an input snapshot for one FIGHTING bot. Decision order each tick:
   *   1. DODGE — if an enemy projectile/trap is closing inside the dodge radius,
   *      swerve perpendicular to it (toward open space) to evade the hit.
   *   2. FLEE — if down to its last balloon and a rival is near, run from them
   *      (biased back toward center) to protect the lead it has left.
   *   3. HUNT — otherwise chase the nearest balloon-carrying rival.
   *   4. WANDER — nobody in range: roam toward a slowly-changing center-biased goal.
   * Plus: TACTICAL item use by held-item category (forward shells when a rival is
   * lined up ahead, traps when chased, boosts/effects while committing), drift for
   * mini-turbos on hard fast turns, and hard wall avoidance so bots never grind the
   * rail (the goal is bent toward center near a bound + drift is suppressed there).
   * @param {object} rec    the bot record.
   * @param {Array}  alive  the alive kart list.
   * @param {number} dt
   * @returns {{steer:number,throttle:number,brake:number,drift:boolean,
   *            useItem:boolean,lookBack:boolean}}
   * @private
   */
  _botInput(rec, alive, dt) {
    const s = rec.state;
    const b = this.arena.bounds;
    if (rec.aiItemCooldown > 0) rec.aiItemCooldown -= dt;

    // --- Nearest balloon-carrying rival (the hunt target). ------------------
    let target = null;
    let bestD2 = Infinity;
    for (let i = 0; i < alive.length; i++) {
      const o = alive[i];
      if (o.id === rec.id) continue;
      const dx = o.state.x - s.x;
      const dz = o.state.z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; target = o; }
    }

    // --- Incoming hazard to DODGE: nearest active projectile we don't own,
    //     within the dodge radius. We evade PERPENDICULAR to the bot->hazard
    //     line, choosing the side that points more toward the arena center so the
    //     swerve keeps us in play instead of into a wall. ---------------------
    let dodgeX = null;
    let dodgeZ = null;
    const pool = this.projectiles && this.projectiles._pool;
    if (pool) {
      let near = null;
      let nearD2 = 17 * 17; // ~17 m reaction bubble
      for (let i = 0; i < pool.length; i++) {
        const proj = pool[i];
        if (!proj || !proj.active || proj.ownerId === rec.id) continue;
        const dx = proj.mesh.position.x - s.x;
        const dz = proj.mesh.position.z - s.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearD2) { nearD2 = d2; near = proj; }
      }
      if (near) {
        const dx = near.mesh.position.x - s.x;
        const dz = near.mesh.position.z - s.z;
        // Two perpendiculars to (dx,dz); pick the one pointing more toward center.
        const c1 = -dz * (-s.x) + dx * (-s.z);
        const c2 = dz * (-s.x) + -dx * (-s.z);
        const ex = c1 >= c2 ? -dz : dz;
        const ez = c1 >= c2 ? dx : -dx;
        const el = Math.hypot(ex, ez) || 1;
        dodgeX = s.x + (ex / el) * 20;
        dodgeZ = s.z + (ez / el) * 20;
      }
    }

    // --- Pick the heading GOAL by priority: dodge > flee > hunt > wander. ----
    const CHASE_RANGE2 = 50 * 50;
    let goalX;
    let goalZ;
    let chasing = false;
    let fleeing = false;
    if (dodgeX != null) {
      goalX = dodgeX;
      goalZ = dodgeZ;
    } else if (rec.balloons <= 1 && target && bestD2 < 34 * 34) {
      // Last balloon: run from the nearest rival, biased back toward center.
      const ax = s.x - target.state.x;
      const az = s.z - target.state.z;
      const al = Math.hypot(ax, az) || 1;
      goalX = s.x + (ax / al) * 20 - s.x * 0.25;
      goalZ = s.z + (az / al) * 20 - s.z * 0.25;
      fleeing = true;
    } else if (target && bestD2 < CHASE_RANGE2) {
      goalX = target.state.x;
      goalZ = target.state.z;
      chasing = true;
    } else {
      // Wander: re-roll a center-biased heading goal every couple of seconds.
      rec.aiWanderTimer -= dt;
      if (rec.aiWanderTimer <= 0) {
        rec.aiWanderTimer = 1.5 + Math.random() * 1.5;
        const toCenter = Math.atan2(-s.x, -s.z);
        rec.aiWanderHeading = toCenter + (Math.random() - 0.5) * Math.PI;
      }
      goalX = s.x + Math.sin(rec.aiWanderHeading) * 20;
      goalZ = s.z + Math.cos(rec.aiWanderHeading) * 20;
    }

    // --- Wall avoidance: near a bound, bend the goal HARD toward center (0,0)
    //     so the bot peels inward instead of grinding the rail. ---------------
    const MARGIN = 12;
    const nearWall =
      s.x < b.minX + MARGIN || s.x > b.maxX - MARGIN ||
      s.z < b.minZ + MARGIN || s.z > b.maxZ - MARGIN;
    if (nearWall) {
      goalX = goalX * 0.2; // 80% toward center
      goalZ = goalZ * 0.2;
    }

    // --- Steering: signed angle from heading to the goal (AIRacer convention).
    const dx = goalX - s.x;
    const dz = goalZ - s.z;
    const targetAngle = Math.atan2(dx, dz);
    let delta = targetAngle - s.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    let steer = delta * 1.7;
    if (steer > 1) steer = 1;
    else if (steer < -1) steer = -1;
    const absSteer = Math.abs(steer);

    // --- Throttle: full, eased on hard turns; ease MORE when carving off a wall
    //     so the inward turn actually bites instead of plowing the rail. -------
    let throttle = 1 - absSteer * 0.35;
    if (nearWall && absSteer > 0.6) throttle = 0.55;
    if (throttle < 0.4) throttle = 0.4;

    // --- Drift on hard, fast turns for a mini-turbo — but NOT while hugging a
    //     wall (drift cuts the turn authority needed to peel away). -----------
    const drift = absSteer > 0.55 && Math.abs(s.speed) > 12 && !nearWall;

    // --- TACTICAL item use by held-item category + geometry. ----------------
    let useItem = false;
    if (rec.aiItemCooldown <= 0) {
      const held = this.itemSystem.getHeld(rec.id);
      const heldId = held && held.id;
      if (heldId) {
        // Where is the nearest rival relative to our facing?
        let inFront = false;
        let behindClose = false;
        if (target) {
          const tAng = Math.atan2(target.state.x - s.x, target.state.z - s.z);
          const td = Math.atan2(Math.sin(tAng - s.heading), Math.cos(tAng - s.heading));
          inFront = Math.abs(td) < 0.9;                 // within ~50deg ahead
          behindClose = Math.abs(td) > 2.2 && bestD2 < 16 * 16; // a close chaser
        }
        if (FORWARD_ITEMS.has(heldId)) {
          useItem = !!target && inFront && bestD2 < 34 * 34; // rival lined up ahead
        } else if (DEFENSIVE_ITEMS.has(heldId)) {
          useItem = behindClose || dodgeX != null;            // chaser / evading
        } else {
          // Self / area effect (boost/star/lightning/boo/...): use it to commit
          // whenever actively hunting, fleeing, or dodging.
          useItem = chasing || fleeing || dodgeX != null;
        }
        if (useItem) rec.aiItemCooldown = 0.7;
      }
    }

    return { steer, throttle, brake: 0, drift, useItem, lookBack: false };
  }

  // ========================================================================
  // RENDER (once per painted frame).
  // ========================================================================
  /**
   * Sync every kart visual, float the balloons, follow the camera on the player
   * (or a survivor if the player is out), and refresh the HUD.
   * @param {number} alpha  the loop's [0, 1) interpolation factor between the
   *                        PREVIOUS and CURRENT physics ticks. We blend each kart's
   *                        prevTransform->state by this to draw a smooth in-between
   *                        frame (kills the 60Hz judder when painting at 120-240fps).
   *                        Wheel-roll / spark FX still advance by the fixed DT.
   */
  render(alpha) {
    // 1) Sync all kart meshes from their states (alive ones; out ones are hidden).
    //    makeRenderState blends position by alpha and heading shortest-arc; every
    //    visual flag (drifting, spinTimer, miniTurboTier, ...) comes through live
    //    from the copy of state. Wheel roll/steer still uses the fixed DT.
    for (let i = 0; i < this.karts.length; i++) {
      const rec = this.karts[i];
      if (!rec.alive) continue;
      const steer = rec.isPlayer ? this._playerLastSteer : (rec._input ? rec._input.steer : 0);
      const rs = makeRenderState(rec.prevTransform, rec.state, alpha);
      rec.kart.syncFromState(rs, DT, steer);
      // Gently bob the remaining balloons so they read as floating.
      this._animateBalloons(rec, DT);
    }

    // 2) Chase camera: follow the player if alive, else any survivor so the
    //    knocked-out player still sees the finish. Use the interpolated transform
    //    so the camera tracks the smoothed kart, not the discrete 60Hz one.
    const cameraTarget = this._cameraTarget();
    if (cameraTarget && this.renderer &&
        typeof this.renderer.updateChaseCamera === 'function') {
      const camRs = makeRenderState(cameraTarget.prevTransform, cameraTarget.state, alpha);
      this.renderer.updateChaseCamera(camRs, DT);
    }

    // 3) HUD: show the player's remaining balloons + how many karts are alive.
    if (this.hud) {
      const player = this._kartById.get('player');
      const alive = this._aliveKarts();
      if (player) {
        // M6: feed the HUD's dedicated BATTLE layout (balloon icons + ALIVE count)
        // instead of the old lap/position misuse. mode:'battle' switches the HUD.
        this.hud.update(player.state, {
          mode: 'battle',
          balloons: player.balloons,
          maxBalloons: START_BALLOONS,
          alive: alive.length,
          // Once the player is out, the HUD swaps the survivor count to a
          // "SPECTATING" standing so they know they're watching, not playing.
          playerOut: player.balloons <= 0,
          // Remaining match time -> HUD mm:ss clock (+ final-10s red pulse).
          timeLeft: Math.max(0, TIME_LIMIT - this.clock),
          miniTurboTier: player.state.miniTurboTier,
          // Held power-up for the top-center item slot (null when empty -> hidden).
          heldItem: this._heldItemFor('player'),
        });
      }
    }
  }

  /**
   * Bob/rotate a kart's remaining balloon pivots so they look alive. Uses the
   * battle clock so the motion is smooth and cheap (no per-balloon state).
   * @param {object} rec
   * @param {number} dt
   * @private
   */
  _animateBalloons(rec, dt) {
    for (let i = 0; i < rec.balloonMeshes.length; i++) {
      const pivot = rec.balloonMeshes[i];
      if (!pivot.visible) continue;
      // A small per-balloon phase so they don't bob in lockstep.
      const phase = i * 1.7;
      pivot.rotation.y += dt * 1.5;
      // Bob the local Y a few cm around the rest height (2.2 m, set at build).
      pivot.position.y = 2.2 + Math.sin(this.clock * 2 + phase) * 0.08;
    }
  }

  /**
   * The kart the camera should follow: the player if alive, otherwise the first
   * alive kart (so a knocked-out player still watches the action).
   * @returns {object|null}
   * @private
   */
  _cameraTarget() {
    const player = this._kartById.get('player');
    if (player && player.alive) return player;
    const alive = this._aliveKarts();
    return alive.length > 0 ? alive[0] : player || null;
  }

  // ========================================================================
  // Helpers.
  // ========================================================================
  /**
   * The alive subset of karts (still holding balloons). Built fresh each call —
   * a tiny array of <= fieldSize entries, cheap at 60Hz.
   * @returns {Array}
   * @private
   */
  _aliveKarts() {
    const out = [];
    for (let i = 0; i < this.karts.length; i++) {
      if (this.karts[i].alive) out.push(this.karts[i]);
    }
    return out;
  }

  /**
   * Hard-clamp a kart state inside the arena bounds. The wall raycast already
   * pushes karts back, but a fast diagonal hit could nudge a kart a hair past a
   * bound; this guarantees it can never leave the floor.
   * @param {object} state
   * @private
   */
  _clampToArena(state) {
    const b = this.arena.bounds;
    if (state.x < b.minX) state.x = b.minX;
    else if (state.x > b.maxX) state.x = b.maxX;
    if (state.z < b.minZ) state.z = b.minZ;
    else if (state.z > b.maxZ) state.z = b.maxZ;
  }

  /**
   * Tear down everything this battle created: kart meshes, the arena (+ its GPU
   * resources), projectile + item-box groups, and the result overlay. Mirrors the
   * dispose contract the mode router (main.js) calls on teardown.
   */
  dispose() {
    // Remove every kart visual.
    for (let i = 0; i < this.karts.length; i++) {
      const g = this.karts[i].kart.group;
      if (g && g.parent) g.parent.remove(g);
    }
    this.karts = [];
    this._kartById.clear();

    // Remove + free the arena.
    if (this.arena) {
      if (this.arena.group && this.arena.group.parent) {
        this.arena.group.parent.remove(this.arena.group);
      }
      if (typeof this.arena.dispose === 'function') this.arena.dispose();
    }
    // Restore the scene background/fog the arena theme overrode, so other modes
    // (or the menu) aren't left with the battle's space backdrop.
    if (this._prevSceneBackground !== undefined) {
      this.scene.background = this._prevSceneBackground;
      this._prevSceneBackground = undefined;
    }
    if (this._prevSceneFog !== undefined) {
      this.scene.fog = this._prevSceneFog;
      this._prevSceneFog = undefined;
    }

    // Remove the projectile + item-box groups from the scene.
    if (this.projectiles && this.projectiles.group && this.projectiles.group.parent) {
      this.projectiles.group.parent.remove(this.projectiles.group);
    }
    if (this.itemBoxes && this.itemBoxes.group && this.itemBoxes.group.parent) {
      this.itemBoxes.group.parent.remove(this.itemBoxes.group);
    }
    // (The end-of-battle results board is the shared ResultsScreen owned by the
    // mode router; main.js hides it on teardown / return to menu.)
  }

  // ------------------------------------------------------------------------
  // Small accessors (handy for debug / a future battle HUD).
  // ------------------------------------------------------------------------
  /** @returns {object|undefined} the player record. */
  getPlayer() {
    return this._kartById.get('player');
  }

  /**
   * Live kart records the central ItemVFX layer reads each frame (main.js passes
   * getKarts() into itemVfx.update). Exposing it lights up the SAME power-up VFX
   * the races get — per-kart hit bursts + dazed spin-stars on a pop, drift sparks,
   * boost-exhaust trails, and star auras — for the whole arena, for free. Returns
   * the ALIVE subset so knocked-out karts stop emitting.
   * @returns {Array}
   */
  getKarts() {
    return this._aliveKarts();
  }

  /**
   * Build the HUD's held-item descriptor for a racer: the held record's id/count
   * joined with the item's display fields (name/icon/color) from the ITEMS table.
   * Returns null when the racer holds nothing, which the HUD reads as "hide slot".
   *
   * @param {string} racerId
   * @returns {{ id:string, name:string, icon:string, color:number, count:number } | null}
   * @private
   */
  _heldItemFor(racerId) {
    // Full 3-slot strip for the HUD (resolves icons from ITEMS); null when empty.
    if (!this.itemSystem.hasItem(racerId)) return null;
    return { slots: this.itemSystem.getSlots(racerId) };
  }

  /** @returns {number} how many karts still hold balloons. */
  getAliveCount() {
    return this._aliveKarts().length;
  }
}
