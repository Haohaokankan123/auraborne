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
// spin stand as the hit reaction. A kart at 0 balloons is briefly DOWN, then RESPAWNS
// with fresh balloons (classic balloon battle). Most balloons POPPED (your score /
// kill count) at the TIME_LIMIT wins.
//
// Conventions (match the project): Y up; XZ plane; forward = (sin h, 0, cos h).

import * as THREE from 'three';

import { Arena } from '../entities/Arena.js';
import { Kart } from '../entities/Kart.js';
import { KartPhysics } from '../physics/KartPhysics.js';
import { ItemSystem } from '../items/ItemSystem.js';
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
const TIME_LIMIT = 90;           // s  match length; most balloons POPPED (score) at TIME wins
// A TIGHTER arena (was the Arena default 120) packs the field together so karts cross paths
// constantly — the density is what drives the pop count up into the brutal 20-40-per-bot range.
const ARENA_SIZE = 64;           // m  full edge length of the battle floor
const HIT_POP_SPIN = 0.30;       // s  brief spin applied as the balloon-pop reaction. ALSO the global per-victim immunity window (a spinning kart can't be re-popped), so this is the dominant throttle on field-wide pop rate — kept short so the brawl stays high-volume.
const SPIN_EDGE_EPS = 0.05;      // s  spinTimer above this counts as "freshly hit"

// SCORE RACE WITH RESPAWNS (per Charles): the classic Mario-Kart balloon battle.
// When a kart's last balloon pops it is briefly DOWN, then RE-INFLATES with a fresh
// THREE balloons at a safe spawn point and keeps fighting. The match runs the full
// TIME_LIMIT and `score` = how many balloons YOU popped on others (your kill count)
// is the win metric — most pops wins. With respawns feeding a constant stream of
// targets, brutally aggressive bots each rack up ~20-40 pops over the 90s match.
const RESPAWN_DELAY = 0.6;       // s  popped kart stays down this long, then re-inflates (short = back in the brawl fast = more total pops)
const RESPAWN_INVULN = 0.7;      // s  brief invincibility on respawn so you aren't instantly re-popped
                                 //     (reuses starTimer => the classic respawn glow + applySpin no-op)

// RAM-to-pop tuning (client-only bumper-car combat; never touches shared physics).
// Tuned for a HIGH-VOLUME score brawl: rams connect readily so aggression constantly
// pays off and the pop count climbs into the 20-40-per-bot range Charles wants.
const RAM_CONTACT = 6.5;         // m   center distance counting as a body-to-body hit. Deliberately > the ~5.2m min turn radius so a bot circling a rival is already inside pop range (kills the orbit-at-arm's-length stall) and far more brawl contacts convert.
const RAM_APPROACH = 1.5;        // m/s how hard the attacker must be driving TOWARD the other to pop it (lower = more glancing crashes land)
const RAM_COOLDOWN = 0.25;        // s   per-victim guard so one crash pops one balloon (short = fast follow-up pops)
const POP_CREDIT_RADIUS = 3.0;   // m   how near a player projectile must be to credit a pop

// PACE + ANTI-STUCK tuning (client-only; battle is single-player vs bots, so no parity concern).
// HARDER + FASTER (Charles: "make it ~10x harder, enemies aggressive, everything fast"):
// every bot now cruises FASTER than the player and aces ride the race top speed, so they
// genuinely run the player down — you can't simply outrun them; you have to out-play them.
const PLAYER_SPEED_CAP = 34;     // m/s player cruise (bumped from 31; still below the bot floor so bots pressure you)
// Bot cruise caps span a personality range, ALL above the player: even the slowest bot
// out-cruises you, and aces hit the 44 race top. cap = MIN + aggression*(MAX-MIN). Boosts exempt.
const BOT_SPEED_CAP_MIN = 40;    // m/s slowest bot — every bot is genuinely fast (tight spread)
const BOT_SPEED_CAP_MAX = 44;    // m/s ace cruise (the full race top speed)
const STUCK_MOVE = 0.04;         // m   per-tick (60Hz) actual displacement below this = barely progressing (~2.4 m/s)
const STUCK_TIME = 0.6;          // s   barely-moving this long => the bot is pinned (wall/corner) and triggers an escape
const ESCAPE_TIME = 0.7;         // s   how long a pinned bot reverses + hard-steers toward center to free itself
const BOT_SEP_RADIUS = 9;        // m   bots inside this of ANOTHER BOT (not their prey) repel apart — kills the clump
const BOT_SEP_PUSH = 14;         // m   how far the separation vector nudges the heading goal away from a crowding bot

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
    this.arena = new Arena({ fieldSize: this.fieldSize, size: ARENA_SIZE });
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
    // START LOCK: like RaceManager/TimeTrial, freeze the field until the 3-2-1-GO
    // overlay calls release(). Without this, bots ram/fire and this.clock (=>
    // TIME_LIMIT + final-10s beeps) advance during the countdown.
    this._locked = true;
    this.finished = false;     // true once results are shown (main.js reads this).
    this.winnerId = null;
    // END FLOURISH: when a winner is decided we DON'T snap straight to results —
    // we freeze the sim, flash a banner ("TIME!" / "YOU WIN!"), let the win
    // confetti play, then flip `finished` so main.js shows the polished board.
    this._ending = false;      // true during the brief end flourish (sim frozen).
    this._endTimer = 0;        // seconds left in the flourish before results.
    this._endReason = null;    // 'timeout' (the only end condition now; shapes the banner).
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

    // SUPER-HORN shockwave: one reusable flat ring on the floor, expanded + faded by
    // render() on each blast so the horn reads as a real area pulse (it was invisible).
    this._shockwave = this._buildShockwave();
  }

  /**
   * Build the single reusable Super-Horn shockwave ring: a flat translucent ring on
   * the floor, hidden until a blast fires. _emitShockwave arms it; render() expands +
   * fades it. Returns the animation state object.
   * @returns {{mesh:THREE.Mesh, active:boolean, t:number, x:number, z:number}}
   * @private
   */
  _buildShockwave() {
    const geo = new THREE.RingGeometry(0.5, 1.0, 40);
    geo.rotateX(-Math.PI / 2); // lie flat on the XZ floor
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffaa00, transparent: true, opacity: 0.0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    return { mesh, active: false, t: 0, x: 0, z: 0 };
  }

  /**
   * Arm the shockwave ring at a world point (the horn user). render() animates it.
   * @param {number} x
   * @param {number} z
   * @private
   */
  _emitShockwave(x, z) {
    const sw = this._shockwave;
    if (!sw) return;
    sw.active = true;
    sw.t = 0;
    sw.x = x;
    sw.z = z;
    sw.mesh.position.set(x, 0.3, z);
    sw.mesh.visible = true;
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

      // --- BOT PERSONALITY: a per-bot spread so the field plays unpredictably and
      //     not as 7 identical drones. aggression drives hunt range / item eagerness /
      //     top speed (elite bots match the player and genuinely threaten); the weave
      //     adds an organic, hard-to-read wobble to their pathing; skill sharpens
      //     steering + reactions. Randomised per battle so no two matches feel the same.
      // HARDER FIELD: no rookies anymore — every bot is aggressive and sharp, aces near max.
      const aggression = isPlayer ? 0 : 0.88 + Math.random() * 0.12;  // 0.88 .. 1.0 (uniformly brutal)
      const skill = isPlayer ? 0 : 0.90 + Math.random() * 0.10;       // 0.90 .. 1.0 (all razor-sharp)

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
        // SCORE = balloons this kart has popped on others — the win metric in the score race.
        score: 0,

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
        // Roam state for the bot AI: a persistent random arena point it heads toward
        // when not hunting/fleeing, so the field stays spread out instead of clumping.
        aiRoamX: null,
        aiRoamZ: null,
        aiRoamTimer: 0,
        aiItemCooldown: 0,
        // Anti-stuck watchdog: how long this bot has been barely moving, and an
        // escape countdown. While escaping, the bot reverses + hard-steers toward
        // center to peel off a wall/corner — guarantees a pinned bot can never
        // freeze forever (a kart at ~0 speed has no steering authority to turn out).
        _stuckTimer: 0,
        _escapeTimer: 0,
        // Personality (see above). aiSpeedCap: elite bots (high aggression) approach the
        // player's top speed so they can run the player down; rookies stay slower.
        aiAggression: aggression,
        aiSkill: skill,
        // SCORE RACE: only ~25% of bots dedicate to the human, so the player still feels
        // constant pressure but the rest BRAWL EACH OTHER aggressively — that spread is
        // what lets every bot rack up its own 20-40 pops (not just whoever ganks the
        // player). The opportunistic majority always hunts the nearest/weakest rival.
        aiHunter: !isPlayer && Math.random() < 0.4,
        aiSpeedCap: BOT_SPEED_CAP_MIN + aggression * (BOT_SPEED_CAP_MAX - BOT_SPEED_CAP_MIN),
        aiWeavePhase: Math.random() * Math.PI * 2,       // desync each bot's wobble
        aiWeaveFreq: 1.1 + Math.random() * 1.4,          // rad/s of the steering wobble
        aiWeaveAmp: 0.10 + (1 - skill) * 0.18,           // lower-skill bots wander more visibly
        _lastX: null,
        _lastZ: null,
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
   * Called by main.js when the 3-2-1-GO countdown reaches GO. Lifts the start
   * lock so combat and the match clock begin (mirrors RaceManager/TimeTrial).
   */
  release() { this._locked = false; }

  /** @returns {boolean} true while the pre-GO start lock is held. */
  isLocked() { return this._locked; }

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

    // START LOCK: held true until the 3-2-1-GO overlay calls release(). Freeze all
    // combat AND the clock during the countdown so bots can't pop a balloon early
    // and TIME_LIMIT/final-10s beeps aren't offset by the ~2.1s countdown.
    if (this._locked) return;

    this.clock += dt;

    // MATCH-START OBJECTIVE: the moment combat begins, name HOW to pop a balloon
    // using the REAL controls (items = SHIFT/E held, ram = drive into a rival at
    // speed). This is the single biggest comprehension fix — the player no longer
    // has to guess. One DOM/GSAP banner (low-tier safe), fired exactly once.
    if (!this._objectiveShown) {
      this._objectiveShown = true;
      if (this.hud && typeof this.hud.showRewardBanner === 'function') {
        this.hud.showRewardBanner(
          '🎈 POP TO SCORE — ram rivals or hit them with items (SHIFT / CLICK). Most pops in 90s wins!',
          'alert',
          2.0
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

    // RESPAWNS: tick down each downed kart's timer and re-inflate it when ready, so a
    // popped kart is back in the fight within ~1.2s. This keeps a constant stream of
    // targets — the engine that drives the pop count up into the 20-40-per-bot range.
    this._tickRespawns(dt);

    // Live combat list = only karts that currently have balloons (i.e. NOT mid-respawn).
    // ItemBox/Projectile systems read .id/.state, which our records expose, so we hand
    // them the alive subset directly.
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

      // BATTLE PACE: cap cruise speed below the 44 m/s race top so the whole match
      // is slower and easier to line up rams. Bots are capped LOWER than the player so
      // the player can chase them down and crash in. Active boost/star/overdrive is
      // exempt so a mushroom/star still surges. Re-clamped every tick = a clean
      // top-speed limiter; sub-cap accel is untouched, so it stays responsive.
      const st = rec.state;
      const boosting = st.boostTimer > 0 || st.starTimer > 0 || st.overdriveTimer > 0;
      const cap = rec.isPlayer ? PLAYER_SPEED_CAP : rec.aiSpeedCap;
      if (!boosting && st.speed > cap) st.speed = cap;
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
    // VISUAL: an expanding shockwave ring so the horn reads as a real area pulse.
    this._emitShockwave(ox, oz);
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
   * RAM pops (bumper-car combat). For every pair of alive karts in body contact, the
   * ATTACKER is whoever is driving INTO the other harder — i.e. the kart with the
   * greater approach velocity along the separation axis — and the OTHER kart's balloon
   * pops if that approach clears RAM_APPROACH. This is BIDIRECTIONAL and speed-
   * INDEPENDENT on purpose: a slower bot that T-bones the faster player still pops the
   * player (an earlier "faster kart always wins" rule made the player — the fastest
   * kart — immune to every bot ram, so bots could never eliminate the human). We set
   * the victim's spinTimer to HIT_POP_SPIN so the rising-edge resolver converts it to a
   * normal pop (free burst VFX + pop SFX), credit the rammer, and arm a brief per-victim
   * cooldown so one crash pops exactly one balloon (not a chain while bodies stay locked).
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
        // How fast is each kart driving TOWARD the other (its velocity along the axis
        // that points at the other kart)? The one driving in harder is the rammer.
        const approachA = avx * nx + avz * nz;     // a -> b
        const approachB = bvx * -nx + bvz * -nz;   // b -> a
        let attacker, victim, approach;
        if (approachA >= approachB) { attacker = a; victim = b; approach = approachA; }
        else { attacker = b; victim = a; approach = approachB; }
        if (approach < RAM_APPROACH) continue; // glancing / drafting — not a real crash
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

    // SCORE: the popper earns a point for every balloon they burst (player AND bots —
    // bots compete for the win too). poppedBy is the attacker id from the ram pass /
    // projectile credit / a player special; ignore self-pops (shouldn't happen).
    const scoredByPlayer = rec.poppedBy === 'player';
    const attacker = rec.poppedBy ? this._kartById.get(rec.poppedBy) : null;
    if (attacker && attacker.id !== rec.id) attacker.score += 1;

    // READABLE CUE so every balloon change is understood (the feedback loop the
    // player said was missing). When the player LOSES one: an urgent "-1" cue (the
    // red screen flash already comes from main.js). When the player SCORES one off
    // a rival: a green "+1" confirm naming the victim. Suppressed on the KILLING
    // pop — _knockOut's "wiped" banner says it better and would otherwise be clobbered.
    if (rec.balloons > 0 && this.hud && typeof this.hud.showRewardBanner === 'function') {
      if (rec.isPlayer) {
        this.hud.showRewardBanner('POP!  -1 balloon', 'alert');
      } else if (scoredByPlayer) {
        this.hud.showRewardBanner('POP! 🎈 +1  ' + this._displayName(rec));
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
   * KNOCK OUT a kart whose last balloon just popped. In the SCORE-RACE meta this is
   * NOT permanent — the kart goes briefly DOWN (hidden, items dropped) and _tickRespawns
   * re-inflates it after RESPAWN_DELAY.
   * @param {object} rec
   * @param {boolean} [scoredByPlayer]  the player landed the finishing pop.
   * @private
   */
  _knockOut(rec, scoredByPlayer = false) {
    rec.alive = false;
    rec.knockouts = (rec.knockouts || 0) + 1; // times this kart has been wiped (results tiebreak)
    rec.kart.group.visible = false;
    rec._respawnTimer = RESPAWN_DELAY;    // _tickRespawns re-inflates when this hits 0
    this.itemSystem.clear(rec.id);

    const canBanner = this.hud && typeof this.hud.showRewardBanner === 'function';

    if (rec.isPlayer) {
      // Player popped out -> a quick, punchy "respawning" cue + rose wash. They are back
      // in the fight in ~0.6s (no spectator dead-end now — it's a score race), so the
      // banner is short enough to clear about when control returns.
      if (canBanner) this.hud.showRewardBanner('💥 POPPED — respawning…', 'alert', 0.7);
      if (typeof this.hud._pulseFlash === 'function') {
        this.hud._pulseFlash('rgba(244, 63, 94, 0.55)', 0.6, 0.7); // rose-500 wash
      }
      return;
    }

    // Bot KO feed: name who got wiped, crediting the player when they landed it.
    if (canBanner) {
      const who = this._displayName(rec);
      this.hud.showRewardBanner(
        scoredByPlayer ? '💥 You wiped ' + who + '!' : '💥 ' + who + ' got wiped!'
      );
    }
  }

  /**
   * RESPAWN engine: tick every downed kart's timer; when it elapses, re-inflate the
   * kart with a fresh set of balloons in the central brawl zone and grant a brief
   * RESPAWN_INVULN window. Called once per update()
   * before the combat list is built, so a re-inflated kart fights again the same tick.
   * @param {number} dt
   * @private
   */
  _tickRespawns(dt) {
    for (let i = 0; i < this.karts.length; i++) {
      const rec = this.karts[i];
      if (rec.alive) continue;
      rec._respawnTimer -= dt;
      if (rec._respawnTimer <= 0) this._respawn(rec);
    }
  }

  /**
   * Re-inflate a downed kart: restore all START_BALLOONS (show the meshes), drop it in
   * the central brawl zone, clear its spin, and grant RESPAWN_INVULN (via starTimer so
   * applySpin no-ops and the kart wears the classic respawn glow). Bots re-enter MOVING
   * (anti-pin kick); the player re-enters stationary under their own control. Resets the
   * anti-stuck + ram bookkeeping so it drives clean immediately.
   * @param {object} rec
   * @private
   */
  _respawn(rec) {
    // Restore balloons + reveal their meshes.
    rec.balloons = START_BALLOONS;
    for (let i = 0; i < rec.balloonMeshes.length; i++) {
      if (rec.balloonMeshes[i]) rec.balloonMeshes[i].visible = true;
    }

    // Respawn back in the CENTRAL brawl zone (not scattered to a far corner — that just
    // wasted time driving back). Take a spawn-ring point, pull it ~60% toward center, and
    // face the kart inward so it drives straight into the action. The RESPAWN_INVULN window
    // covers the moment of reappearance, so we don't need a far-from-everyone safe spot.
    const spawns = this.arena.spawnPoints;
    const b = this.arena.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    // Rotate which ring point we use by how many times this kart has died, so repeated
    // respawns don't stack on the same spot (deterministic, no rng needed).
    const sp = spawns[(rec.knockouts || 0) % spawns.length];
    const s = rec.state;
    s.x = cx + (sp.x - cx) * 0.55;
    s.y = sp.y;
    s.z = cz + (sp.z - cz) * 0.55;
    s.heading = Math.atan2(cx - s.x, cz - s.z); // face the center / the melee
    // BOTS respawn ALREADY MOVING toward the melee (not from a standstill). A motionless
    // bot in the dense center got pinned at speed 0 and focus-farmed: it was popped again
    // the instant invuln dropped, spun out (which bleeds speed to 0), knocked out, and
    // respawned motionless again — racking up deaths but never moving enough to score.
    // Entering at speed means it's already clearing the kill zone when invuln ends.
    // The PLAYER respawns STATIONARY and takes over with their own input — an uncommanded
    // 22 m/s lurch every respawn would feel like a loss of control; they have the invuln
    // window + immediate steering to escape the pile themselves, so they don't need it.
    s.speed = rec.isPlayer ? 0 : 22;
    s.spinTimer = 0;
    s.starTimer = Math.max(s.starTimer, RESPAWN_INVULN); // brief invuln + respawn glow
    if ('boostTimer' in s) s.boostTimer = 0;

    // Seed render interp + anti-stuck/ram bookkeeping to the fresh pose (no snap).
    const pt = rec.prevTransform;
    pt.x = s.x; pt.y = s.y; pt.z = s.z; pt.heading = s.heading;
    rec._lastX = null; rec._lastZ = null;
    rec._stuckTimer = 0; rec._escapeTimer = 0;
    rec._ramCooldownUntil = 0;
    rec.prevSpin = 0;
    rec.poppedBy = null;

    rec.alive = true;
    rec.kart.group.visible = true;
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
   * Decide the battle outcome. SCORE RACE: the match always runs the full TIME_LIMIT
   * (karts respawn, so nobody is ever eliminated for good) and the kart that POPPED the
   * most balloons (score) wins — ties broken by most balloons currently held, then by
   * fewest times wiped (knockouts). On the clock running out we set winnerId + begin
   * the end flourish.
   * @private
   */
  _checkWinner() {
    if (this._ending || this.finished) return;
    if (this.clock < TIME_LIMIT) return;

    let best = this.karts[0];
    for (let i = 1; i < this.karts.length; i++) {
      const r = this.karts[i];
      if (r.score > best.score) { best = r; continue; }
      if (r.score === best.score) {
        if (r.balloons > best.balloons) { best = r; continue; }
        if (r.balloons === best.balloons && (r.knockouts || 0) < (best.knockouts || 0)) best = r;
      }
    }
    this.winnerId = best ? best.id : null;
    this._beginEnding('timeout');
  }

  /**
   * Begin the brief, NON-abrupt end flourish: freeze the sim, flash the outcome
   * banner, and let the win celebration (confetti + fanfare, fired by main.js on
   * the `finished` edge) play. After a short beat, _finish() flips `finished` so
   * the polished results board is shown by the mode router.
   * @param {'timeout'} reason  why the match ended (only TIME_LIMIT ends a score race).
   * @private
   */
  _beginEnding(reason) {
    if (this._ending || this.finished) return;
    this._ending = true;
    this._endReason = reason;
    this._endTimer = 1.6; // s — banner + confetti beat before the board

    // Banner: "TIME!" + the winner and their pop count (the score-race headline).
    const winner = this.winnerId ? this._kartById.get(this.winnerId) : null;
    const playerWon = this.winnerId === 'player';
    let msg;
    if (!winner) {
      msg = "⏱ TIME! It's a draw!";
    } else if (playerWon) {
      msg = '⏱ TIME! 🏆 You win with ' + winner.score + ' pops!';
    } else {
      msg = '⏱ TIME! 🏆 ' + this._displayName(winner) + ' wins with ' + winner.score + ' pops';
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
   * Build the final standings for the results board, best-first. Ranking is by
   * SCORE (pops landed) DESC, then by balloons currently held, then by surviving
   * longest since the last wipeout — matching _checkWinner's winner pick. Each entry
   * carries what the board needs: place, name, colour chip, isPlayer, score, balloons.
   * @returns {Array<{place:number,id:string,name:string,color:number,
   *                   isPlayer:boolean,score:number,balloons:number,eliminated:boolean}>}
   */
  getBattleResults() {
    const ranked = this.karts.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;             // most pops (the win metric)
      if (b.balloons !== a.balloons) return b.balloons - a.balloons; // then balloons held
      return (a.knockouts || 0) - (b.knockouts || 0);                // then fewest times wiped
    });
    return ranked.map((rec, i) => ({
      place: i + 1,
      id: rec.id,
      name: this._displayName(rec),
      color: rec.color,
      isPlayer: rec.isPlayer,
      score: rec.score,            // pops landed — the headline stat / win metric
      balloons: Math.max(0, rec.balloons),
      eliminated: false,           // score race: everyone respawns, nobody is knocked out for good
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

    // --- ANTI-STUCK WATCHDOG (the real freeze fix). A bot that drives into a wall or
    //     corner gets its POSITION clamped to the bound, but its state.speed stays
    //     HIGH (the model keeps integrating throttle; only position is clamped). So a
    //     speed test never catches the pin — we must watch ACTUAL per-tick movement.
    //     When a bot is trying to drive yet barely moves for STUCK_TIME, it's pinned:
    //     reverse STRAIGHT (steer 0) to back off the wall toward open space. CRITICAL: we
    //     do NOT steer while reversing — the physics multiplies yaw by directionSign, so
    //     steering in reverse rotates the WRONG way and the kart oscillates against the
    //     corner forever (the real freeze bug). Backing straight out perpendicular always
    //     moves the nose away from the wall; the normal forward AI then turns it cleanly.
    const moved = rec._lastX != null
      ? Math.hypot(s.x - rec._lastX, s.z - rec._lastZ)
      : 1; // first call: assume moving, don't false-trigger
    rec._lastX = s.x;
    rec._lastZ = s.z;

    if (rec._escapeTimer > 0) {
      rec._escapeTimer -= dt;
      return { steer: 0, throttle: 0, brake: 1, drift: false, useItem: false, lookBack: false };
    }
    // ~0.04 m/tick at 60Hz ≈ 2.4 m/s of real progress — below that means something is
    // eating forward motion. CRITICAL: only treat it as a STUCK (reverse-and-escape)
    // when actually near a WALL. Slow in OPEN arena means the bot is in a body-to-body
    // SCRUM with rivals — exactly where balloons pop — so we must NOT reverse out of it
    // (that scattered the field and tanked the pop count). In a scrum we just keep
    // driving into the target; rams fire on the approach.
    const STUCK_WALL_MARGIN = 8; // m from a bound to count low movement as a real wall-pin
    const nearBound =
      s.x < b.minX + STUCK_WALL_MARGIN || s.x > b.maxX - STUCK_WALL_MARGIN ||
      s.z < b.minZ + STUCK_WALL_MARGIN || s.z > b.maxZ - STUCK_WALL_MARGIN;
    if (moved < STUCK_MOVE && nearBound) {
      rec._stuckTimer += dt;
      if (rec._stuckTimer >= STUCK_TIME) { rec._escapeTimer = ESCAPE_TIME; rec._stuckTimer = 0; }
    } else {
      rec._stuckTimer = 0;
    }

    // --- TARGET: the rival to hunt. Not merely the nearest — we WEIGHT toward the
    //     player (bots should gang up on the human) and toward low-balloon rivals
    //     (finish the wounded), scaled by this bot's aggression. nearestD2 still tracks
    //     the closest rival (any) for the dodge/flee geometry. ---------------------
    let target = null;
    let bestScore = Infinity;
    let bestD2 = Infinity;       // squared distance to the CHOSEN target
    let nearestD2 = Infinity;    // squared distance to the NEAREST rival (any)
    for (let i = 0; i < alive.length; i++) {
      const o = alive[i];
      if (o.id === rec.id) continue;
      const dx = o.state.x - s.x;
      const dz = o.state.z - s.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < nearestD2) nearestD2 = d2;
      // score = distance minus attraction bonuses (lower = more attractive prey). In the
      // SCORE RACE every bot is a hunter: it goes for the NEAREST kill, biased toward the
      // WOUNDED (one ram finishes a 1-balloon kart = a fast point) with only a MILD player
      // bias, so pops spread across the whole field and each bot racks up its own tally.
      const score = Math.sqrt(d2)
        - (o.isPlayer ? 26 : 0)                           // human bias — even opportunistic bots lean toward ganking you
        - (START_BALLOONS - o.balloons) * 14;             // strongly prefer finishing the wounded (fast pops)
      if (score < bestScore) { bestScore = score; target = o; bestD2 = d2; }
    }

    // DEDICATED HUNTERS: a portion of the field (aiHunter) ALWAYS locks onto the human
    // while they're alive, no matter who's closer — so the player is under constant
    // pressure and can't turtle in a corner while the bots brawl each other. The rest
    // stay opportunistic (the weighted target above). This is the core "harder" lever.
    if (rec.aiHunter) {
      const human = this._kartById.get('player');
      if (human && human.alive) {
        const dx = human.state.x - s.x;
        const dz = human.state.z - s.z;
        target = human;
        bestD2 = dx * dx + dz * dz;
      }
    }

    // --- Nearest ACTIVE item box, so an UNARMED bot can go arm itself (then it's a
    //     real threat) — and seeking boxes naturally fans the bots out across the map.
    let boxX = null;
    let boxZ = null;
    let boxD2 = Infinity;
    const boxList = this.itemBoxes && this.itemBoxes._boxes;
    if (boxList) {
      for (let i = 0; i < boxList.length; i++) {
        const bxn = boxList[i];
        if (!bxn.active) continue;
        const p = bxn.mesh.position;
        const dx = p.x - s.x;
        const dz = p.z - s.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < boxD2) { boxD2 = d2; boxX = p.x; boxZ = p.z; }
      }
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

    // --- Pick the heading GOAL by priority: dodge > flee > ram > arm-up > hunt > roam.
    //     Hunt range scales with aggression so rookies only commit to a near rival
    //     (~26m) while aces pursue from across the arena (~50m). A SHORT base range +
    //     separation keeps the field from collapsing into one clump (the old bug);
    //     unarmed bots peel off to grab a box, which spreads them out further.
    const hasItem = this.itemSystem.hasItem(rec.id);
    const RAM_RANGE2 = 34 * 34;                              // commit to a kill on any rival this near
    // SCORE RACE: there is no fleeing and no idle roaming while a target exists — every
    // bot is a relentless hunter that chases the chosen rival across the ENTIRE arena.
    // Dying just respawns you (no score penalty), so the optimal play is pure aggression.
    let goalX;
    let goalZ;
    let chasing = false;
    if (dodgeX != null) {
      // DODGE an incoming projectile — staying un-popped means more time on offense.
      goalX = dodgeX;
      goalZ = dodgeZ;
    } else if (!hasItem && boxX != null && boxD2 < 30 * 30 && (!target || bestD2 > RAM_RANGE2)) {
      // Unarmed AND no kill is right in front: grab a nearby power-up so the bot can also
      // pop with shells/bombs (more pop sources = higher score). Only detours for a CLOSE
      // box — it never abandons an in-range ram for a far box.
      goalX = boxX;
      goalZ = boxZ;
    } else if (target) {
      // HUNT: chase the chosen rival anywhere on the map. From RANGE, aim at an INTERCEPT
      // point (lead the target by its velocity) to cut it off; when CLOSE, aim straight at
      // its BODY so the ram lands instead of leading the aim off to the side (which spun
      // the bot into an endless orbit).
      const lead = bestD2 < RAM_RANGE2 ? 0.12 : 0.4;
      goalX = target.state.x + Math.sin(target.state.heading) * target.state.speed * lead;
      goalZ = target.state.z + Math.cos(target.state.heading) * target.state.speed * lead;
      chasing = true;
    } else {
      // ROAM: drive toward a persistent random point spread across the arena, re-rolled
      // on arrival or every few seconds. NOT center-biased — a center bias just re-clumps
      // everyone at the middle. Random spread points keep the bots fanned out.
      rec.aiRoamTimer -= dt;
      const rdx = (rec.aiRoamX == null ? s.x : rec.aiRoamX) - s.x;
      const rdz = (rec.aiRoamZ == null ? s.z : rec.aiRoamZ) - s.z;
      if (rec.aiRoamX == null || rec.aiRoamTimer <= 0 || rdx * rdx + rdz * rdz < 8 * 8) {
        rec.aiRoamTimer = 2 + Math.random() * 2.5;
        const inset = 15; // keep roam targets off the rails
        rec.aiRoamX = b.minX + inset + Math.random() * ((b.maxX - b.minX) - 2 * inset);
        rec.aiRoamZ = b.minZ + inset + Math.random() * ((b.maxZ - b.minZ) - 2 * inset);
      }
      goalX = rec.aiRoamX;
      goalZ = rec.aiRoamZ;
    }

    // COMMITTING: this bot is locked onto a rival in ram range and driving in for the
    // kill. When committing we damp BOTH separation and the weave so the bot actually
    // connects the crash — otherwise separation rings several attackers around the prey
    // at arm's length and nobody ever lands the hit (the player would never get popped).
    const committing = chasing && bestD2 < RAM_RANGE2;

    // --- SEPARATION (anti-clump) — applied ONLY while ROAMING (no target in sight). In
    //     the score-race brawl we WANT bots to converge and grind on each other (that's
    //     where balloons pop), so a HUNTING bot gets zero separation and drives straight
    //     through to contact. A roaming bot still fans out a little so an idle field
    //     spreads to find new targets instead of stacking in one corner.
    if (!chasing) {
      let sepX = 0;
      let sepZ = 0;
      for (let i = 0; i < alive.length; i++) {
        const o = alive[i];
        if (o.id === rec.id || o.isPlayer) continue;
        if (target && o.id === target.id) continue;
        const ox = s.x - o.state.x;
        const oz = s.z - o.state.z;
        const od2 = ox * ox + oz * oz;
        if (od2 > 1e-4 && od2 < BOT_SEP_RADIUS * BOT_SEP_RADIUS) {
          const od = Math.sqrt(od2);
          const w = 1 - od / BOT_SEP_RADIUS;
          sepX += (ox / od) * w;
          sepZ += (oz / od) * w;
        }
      }
      goalX += sepX * BOT_SEP_PUSH;
      goalZ += sepZ * BOT_SEP_PUSH;
    }

    // --- WALL-SAFE FORWARD DRIVE (potential field — the robust corner-pin fix). The kart's
    //     MIN turn radius is ~5.2m and the wall KILLS its speed (a stopped kart can't steer,
    //     since yaw scales with speed), so the only reliable way to stay off the rails is to
    //     never aim into them. We blend the GOAL direction with a CENTERWARD direction,
    //     weighting center more the closer we are to the wall, and drive that heading at FULL
    //     throttle. Full speed = bots cover ground and collide constantly (= pops); the
    //     centerward blend curves them back in well before a wall, so they never pin. We
    //     NEVER brake/reverse here — reverse-steering (yaw * directionSign) just spins a kart
    //     into the corner. The straight-reverse escape above is the only (rare) reverse.
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const half = Math.min(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
    const distC = Math.hypot(s.x - cx, s.z - cz);
    const nearWall = distC > half - 16;  // kept for drift suppression

    // CLAMP the goal into a central DISC: no bot ever AIMS at (or builds outward momentum
    // toward) the walls. If the chased point is outside the disc, aim at where the line to
    // it crosses the disc edge. Every kart's goals stay central, so the whole field is held
    // in a tight, fast, collision-dense melee — and momentum never carries anyone into a
    // wall (where contact bleeds 70% of their speed and they bog down to a useless crawl).
    const DISC = half * 0.6; // ~34m of a 57m half
    const gdC = Math.hypot(goalX - cx, goalZ - cz);
    if (gdC > DISC) {
      goalX = cx + ((goalX - cx) / gdC) * DISC;
      goalZ = cz + ((goalZ - cz) / gdC) * DISC;
    }

    // Unit vectors toward the goal and toward arena center.
    let gx = goalX - s.x, gz = goalZ - s.z;
    const gl = Math.hypot(gx, gz) || 1; gx /= gl; gz /= gl;
    let cgx = cx - s.x, cgz = cz - s.z;
    const cgl = Math.hypot(cgx, cgz) || 1; cgx /= cgl; cgz /= cgl;
    // Centerward weight: 0 inside the central ~25%, ramping to FULLY centerward by ~63% of
    // the way out (~36m of a 57m half) — so a bot is turned hard inward well before it can
    // reach a wall. Confining the whole field to this central disc is what keeps every kart
    // OFF the walls (where contact bleeds their speed to a crawl) and fast in the melee.
    const wallW = Math.min(1, Math.max(0, (distC - half * 0.15) / (half * 0.38)));
    const dirX = gx * (1 - wallW) + cgx * wallW;
    const dirZ = gz * (1 - wallW) + cgz * wallW;

    // --- Steering toward the blended direction. GAIN modest so the wheel can't saturate at
    //     ±1 and carve a tiny orbit; a small WEAVE adds organic wobble (damped on a commit).
    const targetAngle = Math.atan2(dirX, dirZ);
    let delta = targetAngle - s.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    let steer = delta * (1.0 + rec.aiSkill * 0.4);   // ~1.0 .. 1.4
    steer += Math.sin(this.clock * rec.aiWeaveFreq + rec.aiWeavePhase) * rec.aiWeaveAmp * (committing ? 0.2 : 1);

    // ANTI-ORBIT (the key to landing rams). Min turn radius (~5.2m) exceeds the ram-contact
    // radius, so a bot chasing a CLOSE rival that's off to the SIDE can never turn tight
    // enough to touch it — it orbits at arm's length forever (tangential = ~0 approach = no
    // pop). When close + off-axis + central, STRAIGHTEN OUT and slice straight THROUGH the
    // target (a fast crossing = high approach velocity = a ram lands), then loop back wide
    // and charge again. Gated to the central zone so it never fights the wall-safe blend.
    if (chasing && bestD2 < 10 * 10 && Math.abs(delta) > 0.7 && wallW < 0.2) {
      steer *= 0.12;
    }

    if (steer > 1) steer = 1;
    else if (steer < -1) steer = -1;
    const absSteer = Math.abs(steer);

    // --- Throttle: ALWAYS FULL, eased only on the hardest turns so they still bite. SPEED
    //     is the entire game — it's what makes karts cover ground and collide at the high
    //     approach velocity a ram needs. We NEVER cut throttle for containment (that just
    //     caps the field slow); the centerward STEERING blend alone keeps bots off the walls.
    let throttle = 1 - absSteer * 0.2;
    if (throttle < 0.7) throttle = 0.7;

    // --- Drift on hard, fast turns for a mini-turbo — but NOT while hugging a wall (drift
    //     cuts the turn authority needed to peel away). -----------------------------------
    const drift = absSteer > 0.55 && Math.abs(s.speed) > 14 && !nearWall;

    // --- TACTICAL item use by held-item category + geometry. Aces fire from further
    //     and more often (shorter cooldown) than rookies. ---------------------------
    let useItem = false;
    if (rec.aiItemCooldown <= 0) {
      const held = this.itemSystem.getHeld(rec.id);
      const heldId = held && held.id;
      if (heldId) {
        // Where is the CHOSEN target relative to our facing?
        let inFront = false;
        let behindClose = false;
        if (target) {
          const tAng = Math.atan2(target.state.x - s.x, target.state.z - s.z);
          const td = Math.atan2(Math.sin(tAng - s.heading), Math.cos(tAng - s.heading));
          inFront = Math.abs(td) < 1.15;                             // within ~66deg ahead (fire readily)
          behindClose = Math.abs(td) > 2.2 && nearestD2 < 22 * 22;   // a close chaser
        }
        const fireRange = 42 + rec.aiAggression * 16;                // ~42..58 m — shoot from distance
        const fireRange2 = fireRange * fireRange;
        if (FORWARD_ITEMS.has(heldId)) {
          useItem = !!target && inFront && bestD2 < fireRange2;       // rival lined up ahead
        } else if (DEFENSIVE_ITEMS.has(heldId)) {
          // Drop a trap on a close chaser/while evading — OR, since the bot is almost
          // always charging a target, just lay it in the rival's path when close ahead.
          useItem = behindClose || dodgeX != null || (inFront && bestD2 < 12 * 12);
        } else {
          // Self / area effect (boost/star/lightning/boo/superHorn): fire it to commit —
          // the bot is essentially always hunting, so boosts close the gap relentlessly.
          useItem = chasing || dodgeX != null;
        }
        if (useItem) rec.aiItemCooldown = 0.45 - rec.aiAggression * 0.25; // aces fire very often (~0.2s)
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

    // 1.5) Super-horn shockwave ring: expand to the 7m blast radius + fade over ~0.45s.
    const sw = this._shockwave;
    if (sw && sw.active) {
      sw.t += DT;
      const DUR = 0.45;
      const k = Math.min(sw.t / DUR, 1);
      const scale = 1 + k * 7;                 // grows out to ~radius 7 (matches the blast)
      sw.mesh.scale.set(scale, scale, scale);
      sw.mesh.material.opacity = 0.7 * (1 - k); // fade out
      if (k >= 1) { sw.active = false; sw.mesh.visible = false; }
    }

    // 2) Camera: a normal chase cam on the player. The player respawns (score race), so
    //    the camera always has a live player to follow — no spectator hand-off needed.
    const cameraTarget = this._cameraTarget();
    if (cameraTarget && this.renderer &&
        typeof this.renderer.updateChaseCamera === 'function') {
      const camRs = makeRenderState(cameraTarget.prevTransform, cameraTarget.state, alpha);
      this.renderer.updateChaseCamera(camRs, DT);
    }

    // 3) HUD: the player's balloons + KILLS + a live standings panel of the field.
    if (this.hud) {
      const player = this._kartById.get('player');
      if (player) {
        // M6: feed the HUD's dedicated BATTLE layout. mode:'battle' switches the HUD.
        this.hud.update(player.state, {
          mode: 'battle',
          balloons: player.balloons,
          maxBalloons: START_BALLOONS,
          score: player.score,                       // the player's KILL count (pops landed)
          standings: this._buildStandings(),         // live mini-leaderboard (most pops first)
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
   * Live standings for the HUD leaderboard: every kart sorted best-first by SCORE
   * (then balloons held), each with the fields the panel renders. Small (<= fieldSize)
   * and the HUD only rewrites the DOM when the data actually changes, so building this
   * each frame is cheap.
   * @returns {Array<{id:string,name:string,color:number,isPlayer:boolean,
   *                  score:number,balloons:number,down:boolean}>}
   * @private
   */
  _buildStandings() {
    return this.karts
      .slice()
      .sort((a, b) =>
        (b.score - a.score) ||                 // most pops (the win metric) first
        (b.balloons - a.balloons) ||           // then most balloons currently held
        (Number(b.alive) - Number(a.alive)))   // then live above mid-respawn
      .map((rec) => ({
        id: rec.id,
        name: this._displayName(rec),
        color: rec.color,
        isPlayer: rec.isPlayer,
        score: rec.score,
        balloons: Math.max(0, rec.balloons),
        down: !rec.alive,
      }));
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
   * The kart the camera should follow: ALWAYS the player (it stays positioned at its
   * respawn point during the brief down beat, so the camera tracks it the whole match
   * with no survivor hand-off). Falls back to the first alive kart only if there's
   * somehow no player record.
   * @returns {object|null}
   * @private
   */
  _cameraTarget() {
    const player = this._kartById.get('player');
    if (player) return player;
    const alive = this._aliveKarts();
    return alive.length > 0 ? alive[0] : null;
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

    // Remove the super-horn shockwave ring + free its geo/mat.
    if (this._shockwave && this._shockwave.mesh) {
      const sm = this._shockwave.mesh;
      if (sm.parent) sm.parent.remove(sm);
      if (sm.geometry) sm.geometry.dispose();
      if (sm.material) sm.material.dispose();
      this._shockwave = null;
    }

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

    // Remove the super-horn shockwave ring.
    if (this._shockwave && this._shockwave.mesh && this._shockwave.mesh.parent) {
      this._shockwave.mesh.parent.remove(this._shockwave.mesh);
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
}
