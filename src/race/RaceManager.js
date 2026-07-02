// src/race/RaceManager.js
//
// The RACE MANAGER: the orchestrator that owns the FULL FIELD of karts and runs
// one fixed-timestep tick of the whole race. It is the single place where all
// the M3 subsystems meet — AI, items, item boxes, projectiles, physics, and lap
// tracking — so main.js can stay a thin bootstrap.
//
// What it owns (built once in the constructor):
//   - racers[]      : 13 racer records { id, state, kart, ai, progressScore }
//                     (1 player + 12 AI). `state` is the deterministic kart
//                     state; `kart` is its Three.js mesh; `ai` is the AIRacer
//                     brain (null for the player).
//   - lapSystem     : laps / checkpoints / standings for every racer.
//   - racingLine    : the smooth curve the AI steers along.
//   - itemSystem    : rolls + holds + "uses" items into action descriptors.
//   - itemBoxes     : the world item boxes + pickup detection.
//   - projectiles   : the flying/dropped hazard pool + collision.
//   - physics       : ONE KartPhysics reused for every kart (sequential ground/
//                     surface/wall raycasts — safe because we call it one kart
//                     at a time, never concurrently).
//
// Two clocks, mirroring main.js's old split (see core/Loop.js):
//   - update(dt, raceClock) runs at a FIXED 60Hz. All simulation + game logic.
//   - render(alpha)         runs once per painted frame. Visual sync only.
//
// Why a "karts list" shape of { id, state, progressScore }:
//   ItemBoxManager and ProjectileSystem both consume an array of objects exposing
//   `.id` + `.state` (+ optional `.progressScore` for red-shell homing). Our
//   racer records already carry id/state; we additionally refresh `progressScore`
//   off the LapSystem every tick so projectile targeting "ahead of me" works.

import * as THREE from 'three';

// Entities / systems built in the parallel M3 workstreams.
import { Kart } from '../entities/Kart.js';
import { KartPhysics } from '../physics/KartPhysics.js';
import { LapSystem } from '../race/LapSystem.js';
import { RacingLine } from '../ai/racingline.js';
import { AIRacer, buildAISlot, difficultyFactorFor, RIVAL_NAME } from '../ai/AIRacer.js';
import { ItemSystem } from '../items/ItemSystem.js';
// Persistent rewards: the placement coin payout banked into the wallet on finish.
import { addCoins, coinsForPlace } from '../data/playerStats.js';
import { getItem } from '../items/items.js'; // resolve held-item id -> icon/name for the HUD slot
import { ItemBoxManager } from '../entities/ItemBox.js';
import { ProjectileSystem } from '../entities/Projectiles.js';

// The pure kart-state factory + the status-effect mutators the RaceManager needs
// to resolve a few item descriptors itself (superHorn shockwave, blueShell spin).
import {
  createKartState,
  applySpin,
  applyMushroomBoost,
  launchKart,
  isInvincible,
} from '../../shared/kartModel.js';

// Pure track-surface + feature helpers (NO three): identical math client + server.
//   sampleSurface(trackId,x,z) -> { onRoad, surface, groundY, slope, s } — drives
//     hill-riding (groundY), the slope speed effect, and the surface cap each tick.
//   listFeatures(trackId)      -> resolved world-space features (boost/ramp/hazard/
//     shortcut) so we can detect ramp/hazard contact without re-deriving spline math.
//   respawnPoint(trackId, cpIndex) -> on-road pose for the offroad/fallen safety net.
//   respawnIfFallen(...) -> legacy fell-into-the-void snap (kept as a backstop).
import {
  sampleSurface,
  sampleCenter,
  listFeatures,
  respawnPoint,
  respawnIfFallen,
  getHalfWidth,
  updateAntigravTransition,
} from '../../shared/trackData.js';

// PHYSICS constants for the ramp-launch gate (min speed + base launch velocity).
// STAT_RANGES carries the top-speed multiplier band so we can compute the
// PLAYER's effective max cruise (44 * topSpeedMult) the SAME way the physics does
// — that cap is what the AI's target top speed is clamped to (AI never out-cruise).
import { PHYSICS, STAT_RANGES } from '../../shared/constants.js';

// Fixed step (for the kart's internal wheel/spark/lerp animation) + the render
// interpolation helper that blends each kart's PREVIOUS and CURRENT physics-tick
// transform by the loop's alpha, so the 60Hz sim renders smoothly at the (much
// higher) paint rate instead of juddering on discrete tick steps.
import { DT } from '../core/Loop.js';
import { makeRenderState } from '../core/interpolate.js';

// ---------------------------------------------------------------------------
// Field configuration.
// ---------------------------------------------------------------------------
// 13 karts total: 1 player + 12 AI. Distinct bright colors so each kart is easy
// to tell apart on track (the player gets the first one). The list is long
// enough to cover all 13; index 0 is the player.
const KART_COLORS = [
  0xff3b30, // player — bright red
  0x34c759, // green
  0x0a84ff, // blue
  0xffd60a, // yellow
  0xff9f0a, // orange
  0xbf5af2, // purple
  0xff2d55, // pink
  0x5ac8fa, // cyan
  0x30d158, // lime
  0xffcc00, // gold
  0x64d2ff, // sky
  0xff6482, // coral
  0xac8e68, // tan
];

// How many AI opponents to build (player + this = the field size).
const AI_COUNT = 12;
const FIELD_SIZE = AI_COUNT + 1; // 13

// Laps required to finish the race.
const TOTAL_LAPS = 3;

// ORBIT-ABLE item ids (per the cross-stream CONTRACT): the items that ride
// around your kart as a visible orbit AND act as a shield until thrown. Stream R
// mirrors the kart's currently-held item into kart.state.heldOrbitId only when it
// is one of these; Stream I reads that to render the orbiting mesh / shield.
const ORBIT_ITEM_IDS = new Set([
  'greenShell',
  'redShell',
  'tripleGreen',
  'tripleRed',
  'banana',
  'tripleBanana',
]);

// A dead-neutral control input (matches Input.getState()'s shape exactly). Fed to
// stepKart for EVERY kart while the race is LOCKED (countdown) or OVER, so the
// field holds its grid pose with zero throttle/brake/steer/drift and never fires
// an item. Frozen + shared (read-only) so it costs nothing per tick.
const NEUTRAL_INPUT = Object.freeze({
  steer: 0,
  throttle: 0,
  brake: 0,
  drift: false,
  useItem: false,
  overdrive: false,
});

// --- PACK DRAMA tuning (slipstream draft + light bumping). -----------------
// Local consts (NOT in shared/constants.js — that file is owned elsewhere and the
// server doesn't need these client-feel numbers). All distances in meters, speeds
// in m/s. Tuned gentle so the pack feels alive without shoving anyone off-road or
// blowing past the ~44 m/s top-speed feel.
//
// SLIPSTREAM: a kart is "drafting" when another kart is within DRAFT_DIST ahead of
// it AND roughly in front (heading-aligned cone). While drafting it gets a small
// additive top-speed assist, ramped in/out over time so it eases on and off rather
// than popping. The assist is a flat few m/s, applied as a post-physics nudge that
// is itself clamped to DRAFT_CAP (≈ MAX_SPEED + a hair) so the top-speed feel holds.
const DRAFT_DIST = 11;        // m  max distance to the kart ahead to catch its draft
const DRAFT_MIN_SPEED = 18;   // m/s draft only matters at speed (no draft when crawling)
const DRAFT_CONE = 0.55;      // min forward-alignment (dot) to count as "behind" them
const DRAFT_BONUS = 3.2;      // m/s peak additive top-speed assist while fully drafting
const DRAFT_RAMP = 2.0;       // 1/s how fast the draft assist eases in/out
const DRAFT_CAP = 47;         // m/s hard ceiling on a drafted kart's speed (keeps ~44 feel)

// BUMPING: when two kart centers come within BUMP_DIST they overlap; we push them
// apart along the line between them by BUMP_PUSH (split between the pair) and scrub
// a little speed off each so a touch feels physical, never a hard wall.
const BUMP_DIST = 2.7;          // m  touch a hair earlier (was 2.6)
const BUMP_PUSH = 1.5;          // m  firmer separation, split 50/50 (was 0.9)
const BUMP_SCRUB_MIN = 0.965;   // gentle parallel rub keeps ~96.5% speed
const BUMP_SCRUB_MAX = 0.80;    // hard T-bone bleeds ~20%
const BUMP_CLOSING_REF = 26;    // m/s of closing speed that pegs a "hard" hit
const BUMP_HEADING_KICK = 0.07; // rad knocked off line at a full-impact hit

// Grid stagger: how the 13 karts are arranged behind the start line. We lay them
// out in rows of GRID_COLS across the road, each row GRID_ROW_GAP meters further
// back along the centerline's incoming direction. The start line is checkpoints[0]
// on the right straight facing +Z, so "behind" the line is toward -Z and "across"
// the road is along X.
const GRID_COLS = 2;          // karts side by side per row
const GRID_ROW_GAP = 5.0;     // m  spacing between rows (front-to-back)
const GRID_COL_GAP = 4.0;     // m  spacing between the two columns (side-to-side)

// The per-AI cc/pace LADDER and the five PERSONALITY archetypes now live in
// src/ai/AIRacer.js (buildAISlot / difficultyFactorFor / PERSONALITIES), SHARED so
// the client field here and the server fill in server/Room.js build identical
// personalities for the same grid slot — MP matches single-player. The difficulty
// scales BOTH the cc/pace ladder AND the skill traits there; HARD makes the front
// of the field a genuine threat, EASY stays clearly beatable.

export class RaceManager {
  /**
   * @param {THREE.Scene} scene  the render scene; every kart/box/projectile mesh
   *                             is added here.
   * @param {object} track       the Track instance (checkpoints, colliders,
   *                             isOnRoad, startPosition, roadWidth).
   * @param {object} input       the player Input instance (getState()).
   * @param {object} [opts]      optional overrides:
   *                             { totalLaps, aiCount, rng, playerSelection }.
   *                             rng seeds item drops. playerSelection (M5) lets
   *                             the player's kart use a chosen stat profile +
   *                             color: { stats?: StatProfile, color?: number|string }.
   *                             Omitted => the player uses defaults (identical to
   *                             pre-M5 behavior). AI always use neutral defaults.
   */
  constructor(scene, track, input, opts = {}) {
    this.scene = scene;
    this.track = track;
    this.input = input;

    // START LOCK: the race begins LOCKED so the 13-kart grid sits still on its
    // staggered slots through the 3-2-1 countdown (no pile-up, no early bumping).
    // While locked, update() forces every kart's input to neutral and SKIPS the
    // pack-contact pass. main.js calls release() at GO (2100ms) to free the field.
    this._locked = true;
    // RACE OVER: flipped true the tick the PLAYER finishes their laps. Freezes
    // control (re-locks) and arms getResults() for the ResultsScreen. main.js
    // watches manager.raceOver to show the board once.
    this.raceOver = false;
    // Cached final standings snapshot, computed once when raceOver flips true so
    // getResults() returns a stable ranking even as karts keep rolling to a stop.
    this._results = null;

    // TERRAIN (Phase 3): the registry key for the shared track-surface math. The
    // Track instance carries it (defaults to 'circuit'); we pass it to the PURE
    // sampleSurface/listFeatures/respawnPoint so the client computes hills,
    // slopes, surfaces and feature placements IDENTICALLY to the server.
    this.trackId = (track && track.trackId) || 'circuit';
    // The track's half-width (m): the lateral distance from the centerline to a
    // road edge. The respawn logic measures surf.lateral against this to tell
    // "just off the edge" from "out in the void", so a kart can never hover at
    // road height far off to the side. Read ONCE (pure, deterministic).
    this.halfWidth = getHalfWidth(this.trackId);
    // Resolve the track's features ONCE (absolute world positions). Ramp/hazard
    // contact tests read these each tick without re-deriving any spline math.
    this.features = listFeatures(this.trackId);
    // Pre-filter just the HAZARD features (oil/cone) ONCE. The AI reads this list
    // each tick to steer AROUND hazards before they spin it out — we filter here so
    // the hot path never re-scans non-hazard features 12 karts * 60 Hz.
    this.hazardFeatures = this.features.filter((f) => f.type === 'hazard');
    // Pre-filter the BOOST/RAMP features ONCE: the AI reads this list each tick to
    // steer TOWARD a speed pad / launch ramp just ahead (see AIRacer step 5d). Same
    // reasoning as hazardFeatures — keep the hot path off the full feature scan.
    this.boostRampFeatures = this.features.filter((f) => f.type === 'boost' || f.type === 'ramp');

    // The player's M5 car selection (stats + color), or null for default behavior.
    this.playerSelection = opts.playerSelection || null;

    // COUCH/TV (M6): optional roster of HUMAN players (phones on the couch): each
    // { id, name, color, inputProvider } where inputProvider.getState() returns the
    // exact Input.getState() shape. When present, the humans occupy the first grid
    // slots (replacing the single 'player') and AI fill the rest. When absent, the
    // field is the classic 1 player + N AI — the solo path is untouched.
    this.humans = Array.isArray(opts.humans) && opts.humans.length ? opts.humans : null;

    // TIME-TRIAL-ON-TV switches: strip items and pack contact so N humans race the
    // clock exactly like solo Time Trial (same physics + laps, no interference).
    this.noItems = !!opts.noItems;
    this.noContact = !!opts.noContact;

    // DIFFICULTY: 'easy'|'medium'|'hard', default 'medium' so a skipped
    // DifficultySelect screen still yields a balanced field. It drives two things:
    // difficultyFactor (multiplies the AI's player-capped target top speed — <=1 on
    // easy/medium, ~1.06 on hard) and the per-slot cc/pace + skill scaling baked into
    // buildAISlot (shared with the server in AIRacer.js).
    this.difficulty = opts.difficulty === 'easy' || opts.difficulty === 'hard'
      ? opts.difficulty
      : 'medium';
    this.difficultyFactor = difficultyFactorFor(this.difficulty);

    // PLAYER'S EFFECTIVE MAX TOP SPEED (CONTRACT): the cruise cap the AI is clamped
    // to so it can MATCH the player but never OUT-CRUISE. Computed the SAME way the
    // physics scales the player's cap: 44 * topSpeedMult, where topSpeedMult =
    // statMult(topSpeedStat, TOP_SPEED_MULT_MIN, TOP_SPEED_MULT_MAX). A neutral
    // player (no stats => topSpeed 0.5) yields topSpeedMult 1.0 => playerMax 44.
    const sel = this.playerSelection;
    const topStat = sel && sel.stats && typeof sel.stats.topSpeed === 'number'
      ? Math.max(0, Math.min(1, sel.stats.topSpeed))
      : 0.5; // neutral default
    const topSpeedMult = STAT_RANGES.TOP_SPEED_MULT_MIN
      + topStat * (STAT_RANGES.TOP_SPEED_MULT_MAX - STAT_RANGES.TOP_SPEED_MULT_MIN);
    this.playerMaxTopSpeed = PHYSICS.MAX_SPEED * topSpeedMult;

    this.totalLaps = opts.totalLaps != null ? opts.totalLaps : TOTAL_LAPS;
    const aiCount = opts.aiCount != null ? opts.aiCount : AI_COUNT;
    this.fieldSize = aiCount + (this.humans ? this.humans.length : 1);

    // --- Core race subsystems (built ONCE). ---------------------------------
    // Lap / checkpoint / standings tracker. Every racer registers below.
    this.lapSystem = new LapSystem(track, this.totalLaps);

    // The smooth racing line through the checkpoints — shared by every AIRacer.
    this.racingLine = new RacingLine(track);

    // Meters per unit of progressScore, computed ONCE. progressScore advances by 1
    // per checkpoint (plus a 0..1 fraction toward the next), so one score unit is
    // (loop length / checkpoint count) meters. The AI multiplies its signed score
    // gap to the player by this to get a real-meters gap for rubber-banding. Guard
    // against a 0 checkpoint count (degenerate track) so we never divide by zero.
    const cpCount = this.lapSystem.checkpointCount || 0;
    this.progressMetersPerScore =
      cpCount > 0 ? this.racingLine.length() / cpCount : 0;

    // The item roller / holder. opts.rng makes drops reproducible if supplied.
    this.itemSystem = new ItemSystem({ rng: opts.rng });

    // World item boxes (adds its own .group to the scene in its constructor).
    // Skipped entirely in noItems (TV Time Trial) so no boxes appear on track.
    this.itemBoxes = this.noItems ? null : new ItemBoxManager(track, scene);

    // Projectile pool (adds its own .group to the scene in its constructor).
    this.projectiles = this.noItems ? null : new ProjectileSystem(scene, track);

    // ONE physics wrapper reused for every kart. KartPhysics holds only scratch
    // vectors + a raycaster and is called strictly one kart at a time per tick,
    // so a single instance is safe (and avoids 13 raycasters).
    this.physics = new KartPhysics();

    // --- Build the field of racers. -----------------------------------------
    // racers[0] is the player; racers[1..] are AI. We keep two parallel handles:
    //   this.racers   — the full record list (id/state/kart/ai/progressScore)
    //   this.karts    — the SAME records, but the shape ItemBox/Projectiles read
    //                   (.id/.state/.progressScore). It's literally the same
    //                   array of objects, so updating progressScore on a racer is
    //                   visible to the projectile system with no copying.
    this.racers = [];
    this._racerById = new Map(); // id -> racer record, for O(1) lookups.

    this._buildField(aiCount);

    // The karts list handed to ItemBox/Projectile systems is just the racer
    // records (they expose id/state/progressScore, which is all those systems read).
    this.karts = this.racers;

    // Register every racer with the lap system and add its mesh to the scene.
    for (const racer of this.racers) {
      this.lapSystem.addRacer(racer.id);
      this.scene.add(racer.kart.group);
    }

    // COMEBACK REWARD (R5-B): when the PLAYER falls off and respawns, _maybeRespawn
    // grants a strong catch-up item and stashes its display name here for render()
    // to flash as a HUD banner. _maybeRespawn runs in update() (no hud reference),
    // so we hand the message to render() via this flag. null = nothing pending.
    this._fallRewardPending = null;

    // FX EVENT QUEUE (Round-13 bespoke power-up VFX): the sim layer can't import the
    // Three.js VFX pool (parity + separation), so item-use / explosion / impact /
    // blue-shell events are pushed here as plain descriptors and DRAINED by main.js
    // each frame, which calls the matching itemVfx flourish. The projectile pool has
    // its own queue (this.projectiles.fxEvents); consumeFxEvents() merges both.
    // Each event: { type, ... , x, y, z } (+ heading/itemId/color where relevant).
    this._fxEvents = [];

    // BLUE-SHELL guard: only ONE blue shell may be "live" (bearing down on the
    // leader) at a time, so the leader can't be chain-spun into oblivion when the
    // rebalanced item brackets put a couple of blue shells in the back of the pack.
    // Counts down in update(); while >0 a fresh blueShell use is absorbed (no second
    // strike) — see _fireBlueShell.
    this._blueShellLiveTimer = 0;

    // Scratch context object reused for AI computeInput each tick (avoid per-kart
    // per-tick allocation of the context literal across 12 AIs * 60 Hz).
    this._aiContext = {
      dt: 1 / 60,
      standings: null,
      playerProgressScore: 0,
      myProgressScore: 0,
      // Meters-per-score-unit for the AI's rubber-band gap math (constant for the
      // whole race; see this.progressMetersPerScore). Set once here.
      progressMetersPerScore: this.progressMetersPerScore,
      // AI-BEATABLE CONTRACT (constant for the whole race): the PLAYER's effective
      // max cruise + the difficulty factor. AIRacer clamps its target top speed to
      // min(44*pace, playerMaxTopSpeed) * difficultyFactor, so an AI can match the
      // player but never out-cruise, and runs slower at easier difficulties.
      playerMaxTopSpeed: this.playerMaxTopSpeed,
      difficultyFactor: this.difficultyFactor,
      allKarts: this.karts,
      // Static hazards (oil/cone) the AI steers around, filtered once above. Read-
      // only from the AI's side, so sharing the one array across all 12 AIs is safe.
      hazards: this.hazardFeatures,
      // Boost pads + ramps the AI deliberately steers TOWARD to grab a speed pad /
      // line up a launch (AIRacer step 5d). Same read-only shared-array reasoning.
      boostRamps: this.boostRampFeatures,
      // The current AI's own id, refreshed per-racer in update() so each AI skips
      // ITSELF when scanning allKarts for separation neighbours.
      selfId: null,
      // The current AI's held item ({ id, count } or null), refreshed per-racer in
      // update() so the AI fires it TACTICALLY (forward shells when a rival's just
      // ahead, traps when one's close behind) instead of on a blind cooldown.
      selfHeldItem: null,
    };

    // Scratch map reused for 'global' item actions (lightning/boo) so we don't
    // rebuild a { racerId: state } object every time an item fires. Filled on use.
    this._allKartsMap = {};
  }

  /**
   * Build the 13 racer records: createKartState at a staggered grid position,
   * a Kart mesh in a distinct color, and (for the AI) an AIRacer brain.
   * @param {number} aiCount  number of AI opponents to create.
   * @private
   */
  _buildField(aiCount) {
    // COUCH/TV: the humans roster (phones) replaces the single 'player' in the
    // first grid slots; AI fill the rest. Solo (no roster) = 1 player + aiCount AI.
    const humans = this.humans;
    const humanCount = humans ? humans.length : 1;
    const total = aiCount + humanCount;
    for (let i = 0; i < total; i++) {
      const isHuman = i < humanCount;
      const roster = isHuman && humans ? humans[i] : null;
      const id = roster ? roster.id : (isHuman ? 'player' : 'ai' + i);

      // Grid pose: stagger each kart behind the start line.
      const pose = this._gridPose(i);

      // The PLAYER (i === 0) may carry an M5 selection: a chosen stat profile
      // (so stepKart scales their physics) and a body color. AI always use the
      // neutral default (no stats => identical to pre-M5). When no selection is
      // given the player also falls back to the default — fully backward-compatible.
      // TV humans always use the neutral default (phones pick no stats) but carry
      // their lobby color so each split-screen kart matches its phone's swatch.
      let state;
      let color = KART_COLORS[i % KART_COLORS.length];
      if (isHuman && !roster && this.playerSelection) {
        const sel = this.playerSelection;
        // Spread the pose LAST so x/y/z/heading set the spawn; stats (if present)
        // seed the profile, undefined stats => neutral default in createKartState.
        state = createKartState({ stats: sel.stats, ...pose });
        if (sel.color != null) color = sel.color;
      } else {
        state = createKartState(pose);
        if (roster && roster.color != null) color = roster.color;
      }

      // A distinctly-colored kart mesh (wrap the palette if the field is bigger).
      const kart = new Kart({ color });
      // ANTI-GRAV: the visual re-derives the surface frame from this to ride
      // walls/ceiling through a section (render-only; no parity impact).
      kart._trackId = this.trackId;

      // AI brain for everyone but the player. Each AI gets a cc/skill class for
      // the base pace/rubber spread, PLUS a distinct per-racer PERSONALITY profile
      // (pace, lane, drift, aggression, mistakes, reaction lag) seeded by the racer
      // index so the field is visibly varied yet identical every race. The `seed`
      // (the racer index) makes the AIRacer's internal wander sines uncorrelated
      // between karts — the other half of the "stop driving in unison" fix.
      let ai = null;
      let isRival = false;
      if (!isHuman) {
        // SHARED slot builder: one of five PERSONALITY archetypes + a cc tuned to the
        // grid slot AND the chosen difficulty (HARD = fast/competitive field, EASY =
        // beatable). Identical to the server's fill for the same slot, so MP matches.
        const { cc, profile } = buildAISlot(i, this.difficulty);
        isRival = !!profile.rival; // slot-3 nemesis (see AIRacer.buildAISlot)
        ai = new AIRacer({
          racingLine: this.racingLine,
          cc,
          profile,
          seed: i,
        });
      }

      const racer = {
        id,
        state,
        kart,
        ai,
        // COUCH/TV: the phone's input source ({ getState() }) for this human, or
        // null (the solo player reads this.input; AI compute their own).
        inputProvider: roster ? roster.inputProvider || null : null,
        // Grid slot, kept so a mid-race AI takeover (phone dropped) can build the
        // same buildAISlot personality the server/solo field would use here.
        _slotIndex: i,
        // Display fields for the end-of-race RESULTS board. color is the kart's
        // body tint (player's M5 choice or the palette swatch); name is a friendly
        // label ("YOU" for the player, "CPU N" for each AI) since AI have no chosen
        // character. getResults() reads these straight off the record.
        color,
        // The designated RIVAL takes the fixed nemesis name (so it reads as a
        // recurring foe across the cup, not an anonymous "CPU N").
        name: roster
          ? (roster.name || 'P' + (i + 1))
          : (isHuman ? 'YOU' : (isRival ? RIVAL_NAME : 'CPU ' + i)),
        // RIVAL flag exposed on the record so the HUD minimap / nameplate can tag the
        // nemesis and the results board / cup head-to-head can find it. Read-only
        // metadata — nothing in the deterministic sim reads it.
        rival: isRival,
        // Live ranking score, refreshed from LapSystem each tick. Read by the
        // projectile system for red-shell "homes on the kart ahead" targeting.
        progressScore: 0,
        // COINS COLLECTED this race (running total). state.coins itself caps at
        // COIN_MAX and DROPS on a spin-out, so the held count understates how many
        // were grabbed — we sum the rising edges (see update step 5) instead, and
        // surface this as coinsEarned in getResults() for the board + coin wallet.
        coinsEarned: 0,
        _prevCoins: state.coins || 0,
        // The AI's last steer, used to animate its front wheels in render().
        lastSteer: 0,
        // Previous tick's useItem intent, for rising-edge item firing (one
        // press == one item). Set false so the very first held tick can fire.
        _prevUseItem: false,
        // TERRAIN feature bookkeeping (Phase 3), all per-kart + deterministic:
        //   _prevSurface  last tick's sampled surface, for rising-edge boost/ramp.
        //   _offroadTime  seconds spent continuously off the road (respawn trigger).
        //   _lastCp       last checkpoint index the kart passed (respawn target).
        _prevSurface: 'road',
        _offroadTime: 0,
        _lastCp: 0,
        // RAMP launch-off-the-lip: the ramp feature + entry speedFrac stashed while
        // ON the ramp, read at the falling edge (the lip) to fire the launch.
        _rampFeat: null,
        _rampEntrySpeedFrac: null,
        // SLIPSTREAM: current eased-in draft assist in m/s (0 = no draft). Ramped
        // toward DRAFT_BONUS while tailing a kart ahead, toward 0 otherwise, so the
        // top-speed help fades on/off smoothly instead of snapping (see
        // _resolvePackContact). Per-kart so each draft state is independent.
        _draftAssist: 0,
        // Previous physics-tick transform, for render interpolation. Seeded to
        // the spawn pose so the very first frame (before any tick) interpolates
        // against itself and is perfectly stable — no snap from a zeroed pose.
        prevTransform: {
          x: state.x,
          y: state.y,
          z: state.z,
          heading: state.heading,
        },
      };

      this.racers.push(racer);
      this._racerById.set(id, racer);
    }
  }

  /**
   * Compute a staggered starting-grid pose for racer index `i`, lined up behind
   * the start/finish line (checkpoints[0]) on the right straight (heading +Z).
   *
   * The grid fans out in rows of GRID_COLS across the road and steps backward
   * (toward -Z, i.e. behind the line) row by row, so no two karts overlap at the
   * start. We clamp the across-road offset so karts never spawn inside a wall.
   *
   * @param {number} i  racer index (0 = pole position, nearest the line).
   * @returns {{x:number, y:number, z:number, heading:number}}
   * @private
   */
  _gridPose(i) {
    const start = this.track.startPosition; // { x, y, z, heading } on right straight
    const heading = start.heading;           // 0 -> faces +Z up the right straight

    // Forward unit vector at the start (sin,cos convention). "Behind" the line is
    // the negative of this, so rows step back along -forward.
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    // Right vector (perpendicular, in XZ): rotate forward -90deg about Y => (fz,-fx).
    const rx = fz;
    const rz = -fx;

    const row = Math.floor(i / GRID_COLS);   // 0,0,1,1,2,2,...
    const col = i % GRID_COLS;               // 0,1,0,1,...

    // Across-road offset centered on the centerline: columns straddle the middle.
    const colOffset = (col - (GRID_COLS - 1) / 2) * GRID_COL_GAP;
    // Keep karts comfortably inside the road band (leave a margin from the walls).
    const maxOffset = (this.track.roadWidth / 2) - 1.5;
    const clampedCol = Math.max(-maxOffset, Math.min(maxOffset, colOffset));

    // Back-off distance grows with the row; start a touch behind the line so the
    // pole kart isn't sitting exactly on checkpoint 0.
    const backOff = 3.0 + row * GRID_ROW_GAP;

    const x = start.x - fx * backOff + rx * clampedCol;
    const z = start.z - fz * backOff + rz * clampedCol;

    return { x, y: start.y, z, heading };
  }

  // ========================================================================
  // FIXED-STEP UPDATE (called at exactly 60Hz; dt === DT).
  // ========================================================================
  /**
   * Advance the whole race by one fixed step.
   *
   * @param {number} dt         fixed timestep in seconds (DT).
   * @param {number} raceClock  monotonic simulation clock in seconds (for laps).
   */
  update(dt, raceClock) {
    // Standings drive both AI rubber-banding and item-bracket rolls. Compute
    // them ONCE up front from last tick's scores; cheap (sort of 13 entries).
    const standings = this.lapSystem.getStandings();
    // Rubber-band reference: the LEADING human's progress. Solo this is exactly
    // the one player's score; on TV the AI pace off whichever phone is furthest.
    let playerScore = 0;
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (!r.ai && r.progressScore > playerScore) playerScore = r.progressScore;
    }

    // Fill the shared AI context (reused object — just refresh the fields).
    this._aiContext.dt = dt;
    this._aiContext.standings = standings;
    this._aiContext.playerProgressScore = playerScore;

    // Tick down the blue-shell "live" window (one strike on the leader at a time).
    if (this._blueShellLiveTimer > 0) this._blueShellLiveTimer -= dt;

    // --- 1. Per-racer: gather input, step physics, advance lap progress. -----
    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];

      // Input: the player reads the real controls; the AI computes an input that
      // is the SAME shape (so stepKart treats both identically). While LOCKED
      // (pre-race countdown) or after the race is OVER, EVERY kart is forced to a
      // neutral input — no throttle/brake/steer/drift/item — so the field sits
      // dead still on the grid (no creep, no early item use). We still set
      // lastSteer to 0 so the wheels render straight while held on the line.
      let input;
      if (this._locked || this.raceOver) {
        input = NEUTRAL_INPUT;
        racer.lastSteer = 0;
      } else if (racer.ai) {
        this._aiContext.myProgressScore = racer.progressScore;
        // Tell the AI which kart is itself, so separation/avoidance skips its own
        // record when scanning allKarts (otherwise it would shove away from itself).
        this._aiContext.selfId = racer.id;
        // What this AI is holding ({ id, count } | null) so it can fire tactically.
        this._aiContext.selfHeldItem = this.itemSystem.getHeld(racer.id);
        input = racer.ai.computeInput(racer.state, this._aiContext);
        racer.lastSteer = input.steer;
      } else if (racer.inputProvider) {
        // COUCH/TV: this human's phone input, relayed through the server. Same
        // shape as Input.getState(), so stepKart treats it identically.
        input = racer.inputProvider.getState();
        racer.lastSteer = input.steer;
      } else {
        input = this.input.getState();
        racer.lastSteer = input.steer;
      }
      // Stash the input so the item step below can read useItem without polling
      // a second time (and without re-running the AI heuristic).
      racer._input = input;

      // Snapshot the transform we are ABOUT to step away from. render() blends
      // this previous pose with the new (post-step) pose by the loop's alpha,
      // so the 60Hz sim is drawn smoothly between ticks instead of juddering.
      const pt = racer.prevTransform;
      pt.x = racer.state.x;
      pt.y = racer.state.y;
      pt.z = racer.state.z;
      pt.heading = racer.state.heading;

      // TERRAIN (Phase 3): sample the shared track surface at the kart's CURRENT
      // (pre-step) position and hand groundY/slope/surface to stepKart so it rides
      // the hills + applies the slope/offroad effects. The flag tells KartPhysics
      // that stepKart now OWNS y (don't raycast-overwrite it). This is the SAME
      // pure math + ordering the server uses, so prediction matches authority.
      const surf = sampleSurface(this.trackId, racer.state.x, racer.state.z, racer.state.y, racer.state.lastS);
      // REAL fall-in GAP: over a chasm there is NO ground, so the kart must PLUNGE
      // rather than hover on the (still-continuous) centerline height. We drop the
      // PHYSICS groundY far below over a gap so updateVertical never clamps the kart
      // onto invisible road — a missed jump keeps falling. _maybeRespawn still measures
      // the fall against the REAL road height (surf.groundY, untouched) and respawns
      // the kart before the gap once it has dropped into the void. A kart that cleared
      // the gap reads onRoad:true (past the chasm) and gets the real height back.
      // Use surf.inGap (computed in sampleSurface on the SAME vertex param isOnRoad
      // uses) rather than re-deriving from surf.s (the interpolated uProj) — keeps the
      // over-gap plunge decision byte-identical between client prediction and server.
      const overGap = !surf.onRoad && surf.inGap;
      racer.state.groundY = overGap ? surf.groundY - 1000 : surf.groundY;
      racer.state.slope = surf.slope;
      racer.state.surface = surf.surface;
      racer.state.lastS = surf.s; // continuity hint for next frame (overpass fix)
      racer.state._hillTerrain = true;

      // ANTI-GRAV (MK8 wall/ceiling riding): drive the section entry/exit transition
      // BEFORE the ramp/boost edges + the physics step (which routes to the SAME shared
      // stepKart). Same pure helper + same ordering the server/MP-predictor use, so the
      // surface-relative branch behaves identically. No-op outside a section / on tracks
      // without anti-grav data.
      updateAntigravTransition(racer.state, this.trackId, surf);

      // RAMP launch (FALLING edge = the LIP): while a kart is ON the ramp footprint
      // it rides UP the wedge (sampleSurface ride-up profile); the launch fires the
      // tick it LEAVES the footprint — off the raised lip — so it flies up off real
      // geometry instead of teleporting airborne at the entry and passing UNDER the
      // wedge. At the falling edge _glideRampAt returns null (kart left the footprint),
      // so we STASH the ramp + entry speed while still on it and read the stash at the
      // lip. vyUp scales with speed so a faster approach jumps higher. launchKart is a
      // no-op while already airborne.
      if (surf.surface === 'ramp') {
        // GLIDE TRIGGER lookup (Round-12 CONTRACT): a GLIDE ramp (params.glide === true)
        // returns the feature; a plain ramp returns null. Stash it now because at the
        // falling edge the kart is off the footprint and the lookup would miss.
        racer._rampFeat = this._glideRampAt(racer.state.x, racer.state.z);
        racer._rampEntrySpeedFrac = Math.min(racer.state.speed / PHYSICS.MAX_SPEED, 1.4);
      } else if (
        racer._prevSurface === 'ramp' &&
        racer.state.speed >= PHYSICS.RAMP_LAUNCH_MIN_SPEED
      ) {
        const speedFrac = racer._rampEntrySpeedFrac != null
          ? racer._rampEntrySpeedFrac
          : Math.min(racer.state.speed / PHYSICS.MAX_SPEED, 1.4);
        const glideRamp = racer._rampFeat;
        if (glideRamp && glideRamp.params && glideRamp.params.launch) {
          // GAP JUMP (Round-13): a fall-in chasm's launch ramp. Use a strong BALLISTIC
          // pop (normal gravity, gliding stays FALSE) so the kart arcs across the gap
          // and lands snappily on the far side — NOT the multi-second floaty glide,
          // which overshot the whole course. Now launched from the LIP (+rise height,
          // ~len/2 closer to the chasm); the ballistic oracle confirms all 3 gaps still
          // clear with margin at boosted speeds. The groundY-override above keeps the
          // kart falling (not landing on invisible road) until it's past the chasm.
          launchKart(racer.state, PHYSICS.RAMP_LAUNCH_VY * (2.0 + 0.7 * speedFrac));
        } else if (glideRamp) {
          // A glide launch is a bigger pop so there's airtime to actually glide; the
          // launch clears gliding (see launchKart), so we set it true RIGHT AFTER per
          // the contract. Stream P handles the descent + landing clear.
          launchKart(racer.state, PHYSICS.RAMP_LAUNCH_VY * (1.2 + 0.6 * speedFrac));
          racer.state.gliding = true;
        } else {
          // Plain ramp: the ride-up + lip height now supply most of the 'going up', so
          // a SMALLER pop reads as a natural fly-off the lip, not a teleport.
          launchKart(racer.state, PHYSICS.RAMP_LAUNCH_VY * (0.5 + 0.4 * speedFrac));
        }
        racer._rampFeat = null;
      }
      // BOOST pad (rising edge): entering a boost footprint surges the kart, reusing
      // the mushroom boost so it feels exactly like a drift/mushroom kick.
      if (surf.surface === 'boost' && racer._prevSurface !== 'boost') {
        applyMushroomBoost(racer.state);
      }
      racer._prevSurface = surf.surface;

      // Step the deterministic model + resolve walls against the track. ONE physics
      // instance, called sequentially per kart. After this, racer.state holds the
      // CURRENT tick and racer.prevTransform the PREVIOUS.
      this.physics.update(racer.state, input, dt, this.track);

      // NOTE: AI karts drive through the SAME pure physics path as the player
      // (input -> stepKart -> position). We deliberately do NOT touch their
      // position/heading afterward. Every previous attempt to clamp/nudge/rail
      // their position HERE fought the physics engine every frame and made the
      // karts GLITCH/stutter instead of drive. Keeping them on the road is the
      // AIRacer's job — it brakes for corners (like a real driver) — not this
      // loop's job to yank positions.

      // AI CONTAINMENT NET (fenceless course, tight new corners): if an AI ends a
      // step OFF the road, pull it back onto the road band at its current progress
      // and blend its heading toward the driving tangent — but DO NOT touch its
      // speed. Preserving forward motion (and only acting when genuinely off-road,
      // never on-road) is what keeps this smooth instead of the old glitch, which
      // came from yanking position/speed every frame. The player is exempt: falling
      // off is a wanted mechanic. This is the hard guarantee that AI never strand in
      // the void no matter how the racing-line look-ahead reads a hairpin.
      // The net SKIPS an airborne kart (it's mid-jump/glide over a ramp or a gap —
      // yanking it would kill the arc) and SKIPS a kart whose off-road is a real
      // fall-in GAP (the road genuinely isn't there; snapping to the centerline would
      // hover it over the void, so let it fall and respawn before the gap instead).
      if (racer.ai && !racer.state.airborne) {
        const s2 = sampleSurface(this.trackId, racer.state.x, racer.state.z, racer.state.y, racer.state.lastS);
        if (!s2.onRoad && !s2.inGap) {
          const c = sampleCenter(this.trackId, s2.s);
          const tlen = Math.hypot(c.tx, c.tz) || 1;
          const tx = c.tx / tlen, tz = c.tz / tlen;
          const nx = -tz, nz = tx; // left normal to the driving tangent
          const ox = racer.state.x - c.x, oz = racer.state.z - c.z;
          const signedLat = ox * nx + oz * nz; // signed side offset from centerline
          const edge = getHalfWidth(this.trackId) * 0.9;
          const clampedLat = Math.max(-edge, Math.min(edge, signedLat));
          // snap onto the road band at this progress point (drops the off-road excess)
          racer.state.x = c.x + nx * clampedLat;
          racer.state.z = c.z + nz * clampedLat;
          // blend heading toward the track tangent so it drives down the road, not off it
          const tangentHeading = Math.atan2(tx, tz);
          let dh = tangentHeading - racer.state.heading;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          racer.state.heading += dh * 0.35;
          racer.state.lastS = s2.s; // keep the continuity hint coherent after the nudge
        }
      }

      // HAZARD contact: spin out on touching an oil/cone hazard feature (distance
      // test vs the resolved feature world positions, like an item box). Honors
      // invincibility via applySpin's own star guard.
      this._checkHazards(racer);

      // Advance lap / checkpoint progress with the simulation clock, then mirror
      // the fresh score onto the racer so the projectile system can read it.
      this.lapSystem.update(racer.id, racer.state, raceClock);
      const prog = this.lapSystem.getProgress(racer.id);
      racer.progressScore = prog ? prog.progressScore : racer.progressScore;

      // Remember the last checkpoint this kart passed (nextCp - 1) as the respawn
      // target, so a recovery puts it back where it was, not at the start line.
      if (prog) racer._lastCp = ((prog.nextCp - 1) % this.track.checkpoints.length + this.track.checkpoints.length) % this.track.checkpoints.length;

      // SAFETY NET (no walls on the open spline course): respawn a kart that has
      // either spent too long off the road OR fallen below the track surface.
      this._maybeRespawn(racer, surf, dt);

      // BACKSTOP: the legacy fell-into-the-void snap, for the rare case a kart's y
      // drops far under the floating course before the offroad timer trips. No-op
      // on flat tracks (elevation 0). Cheap; keeps a kart from vanishing.
      const elevation = this.track.elevation || 0;
      if (elevation > 0) {
        respawnIfFallen(
          racer.state,
          this.track.checkpoints,
          elevation,
          prog ? prog.nextCp : 0,
        );
      }
    }

    // --- 1b. PACK DRAMA: slipstream draft + light bumping. -------------------
    // Runs ONCE after every kart has stepped this tick, over all kart states, so
    // it can compare pairs. SLIPSTREAM gives a kart closely tailing another a small
    // top-speed assist (the draft pulls you along); BUMPING shoves two overlapping
    // karts gently apart with a minor speed scrub so the pack feels physical. Both
    // apply to the PLAYER too. Kept gentle + post-physics so they never fight the
    // integrator or push a kart off the road.
    //
    // SKIP while LOCKED (countdown) or OVER: a bump pass on the stationary,
    // tightly packed grid would shove karts apart and ooze them off their staggered
    // slots before GO — so the grid sits perfectly still until release() frees it.
    if (!this._locked && !this.raceOver && !this.noContact) {
      this._resolvePackContact(dt);
    }

    // --- 2. Item boxes: detect pickups, award an item if the racer's hands
    //        are empty. (One pickup entry per box grabbed this frame.) ---------
    const pickups = this.itemBoxes ? this.itemBoxes.update(this.karts, dt) : [];
    if (pickups.length > 0) {
      // Re-read standings AFTER physics so the item bracket reflects this tick's
      // positions (front-runners get weak items, back-runners get strong ones).
      const freshStandings = this.lapSystem.getStandings();
      for (let p = 0; p < pickups.length; p++) {
        const racerId = pickups[p].racerId;
        // Award while there's a free slot (hold up to 3 items, not just one).
        if (!this.itemSystem.hasFreeSlot(racerId)) continue;
        const rank = this._rankOf(racerId, freshStandings); // 0 = leader
        const itemId = this.itemSystem.rollItem(rank, this.fieldSize);
        this.itemSystem.giveItem(racerId, itemId);
      }
    }

    // --- 3. Item USE: fire on the RISING EDGE of useItem only. ---------------
    // A held key/AI-intent stays useItem:true across many ticks; without edge
    // detection that would fire (and drain) an item ~60x/second. We track the
    // PREVIOUS tick's useItem per racer and only fire when it goes false->true,
    // so one press == one item (triples decrement one shell per fresh press).
    // The AI feeds clean rising edges via its own pulse cooldown (AIRacer).
    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];
      const input = racer._input;
      const useNow = !!(input && input.useItem);
      // Rising edge: pressed this tick but not the previous one.
      const fire = useNow && !racer._prevUseItem;
      // Remember this tick's intent for next tick's edge test.
      racer._prevUseItem = useNow;
      if (!fire) continue;
      if (!this.itemSystem.hasItem(racer.id)) continue;
      this._useItemFor(racer, standings);
    }

    // --- 4. Projectiles: move, home, bounce, and collide vs every kart. ------
    if (this.projectiles) this.projectiles.update(dt, this.karts);

    // --- 5. ITEM STATE MIRROR (cross-stream CONTRACT). -----------------------
    // For EVERY kart, publish its currently-held ORBIT-ABLE item onto its
    // kart.state so the VFX/projectile streams can render the orbiting shield and
    // read shield status without reaching into the ItemSystem:
    //   heldOrbitId    : the held item id if it's orbit-able (see ORBIT_ITEM_IDS),
    //                    else null. Empties to null the tick the item is thrown.
    //   heldOrbitCount : charges remaining (1 single .. 3 triple) -> meshes to draw.
    //   shield         : true whenever heldOrbitId is non-null (held orbit shields).
    // We ALSO consume Stream I's shieldHitPending flag here: when a projectile was
    // blocked by a kart's shield, that stream sets the flag; we clear the held item
    // (so the orbit/shield disappears) and reset the flag for next tick.
    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];
      const st = racer.state;

      // Shield-hit handshake: a blocked projectile consumes the held orbit item.
      if (st.shieldHitPending) {
        this.itemSystem.clear(racer.id);
        st.shieldHitPending = false;
      }

      // COINS COLLECTED tally: sum the rising edges of the held-coin count so the
      // end-of-race coinsEarned reflects every coin grabbed, not the capped/dropped
      // held purse. (Same per-tick edge approach main.js uses for the lifetime stat.)
      const coinsNow = st.coins || 0;
      if (coinsNow > racer._prevCoins) racer.coinsEarned += coinsNow - racer._prevCoins;
      racer._prevCoins = coinsNow;

      // Mirror the (possibly now-cleared) held item onto the state fields.
      const held = this.itemSystem.getHeld(racer.id);
      if (held && ORBIT_ITEM_IDS.has(held.id)) {
        st.heldOrbitId = held.id;
        st.heldOrbitCount = held.count || 1;
        st.shield = true;
      } else {
        st.heldOrbitId = null;
        st.heldOrbitCount = 0;
        st.shield = false;
      }
    }

    // --- 6. FINISH: end the race once EVERY human has crossed the final line. --
    // Solo this is exactly the old "the tick the PLAYER finishes" edge. On TV,
    // waiting on all phones would soft-lock if one player wanders off, so once the
    // FIRST human finishes a grace clock runs; when it expires the race ends and
    // the stragglers rank by progress (classic kart-game behavior). On the edge we
    // re-lock the field (karts coast to a stop via the neutral input), flag
    // raceOver for main.js, and snapshot the standings ONCE so getResults() is
    // stable while karts roll out.
    if (!this.raceOver) {
      let humansTotal = 0;
      let humansDone = 0;
      for (let i = 0; i < this.racers.length; i++) {
        const r = this.racers[i];
        if (r.ai) continue;
        humansTotal++;
        const prog = this.lapSystem.getProgress(r.id);
        if (prog && prog.finished) humansDone++;
      }
      if (humansDone > 0 && humansDone < humansTotal) {
        this._finishGrace = (this._finishGrace || 0) + dt;
      }
      const graceUp = (this._finishGrace || 0) >= 30;
      if (humansTotal > 0 && (humansDone === humansTotal || graceUp)) {
        this.raceOver = true;
        this._locked = true; // freeze control (neutral input for all karts)
        this._results = this._computeResults();
        // PLACEMENT PAYOUT: bank the player's finish-place coins into the spendable
        // wallet. SOLO ONLY — TV humans have no local wallet, and the shared screen
        // must never write the Mac owner's playerStats for a phone's finish.
        if (!this.humans) {
          const me = this._results.find((r) => r.isPlayer);
          if (me) addCoins(coinsForPlace(me.place));
        }
      }
    }
  }

  /**
   * Resolve and execute a held item for one racer. Reads the action descriptor
   * from ItemSystem and acts on it: spawning projectiles, dropping traps, applying
   * self effects, or running field-wide globals (with the Boo steal handled here).
   *
   * @param {object} racer      the firing racer record.
   * @param {Array}  standings  current standings (leader-first) for targeting.
   * @private
   */
  _useItemFor(racer, standings) {
    // Context handed to ItemSystem.useItem — forwarded into global descriptors.
    const action = this.itemSystem.useItem(racer.id, racer.state, {
      standings,
      fieldSize: this.fieldSize,
    });
    if (!action) return; // nothing was held (shouldn't happen — we checked hasItem)

    // VFX: flag the USE moment so main.js can play this item's bespoke flourish
    // (mushroom flame pop / star sparkle spray / super-horn sonic ring / bullet
    // rocket smoke / lightning bolt+flash / banana drop / coin sparkle / etc.). The
    // fired id (action.item) is what reads on screen; blueShell additionally pushes
    // its big impact from _fireBlueShell below.
    const us = racer.state;
    this._fxEvents.push({ type: 'use', itemId: action.item, x: us.x, y: us.y, z: us.z, heading: us.heading });

    switch (action.kind) {
      // --- SELF: mushroom/star/coin apply straight to the user. superHorn is a
      //     'self' descriptor whose apply() is a no-op; its area shockwave is
      //     resolved separately below (the descriptor carries pulse params). ----
      case 'self': {
        if (typeof action.apply === 'function') action.apply(racer.state);
        // Super horn: the descriptor's apply is intentionally inert; the actual
        // area effect (spin nearby rivals + destroy incoming blue shells) is the
        // RaceManager's job because it needs the whole field.
        if (action.item === 'superHorn') {
          this._resolveSuperHorn(racer);
        }
        break;
      }

      // --- PROJECTILE: hand to the projectile pool. blueShell is special: the
      //     projectile system has no blueShell type, so we resolve it as a
      //     leader-seeking strike here. ---------------------------------------
      case 'projectile': {
        if (action.item === 'blueShell' || action.targetsLeader) {
          this._fireBlueShell(racer, standings, action);
        } else {
          this.projectiles.spawn(action.item, racer.state, {
            karts: this.karts,
            ownerId: racer.id,
            ownerProgress: racer.progressScore,
          });
        }
        break;
      }

      // --- TRAP: a dropped/thrown hazard (banana, bob-omb, fake box). The
      //     projectile system handles the drop + later contact. -----------------
      case 'trap': {
        this.projectiles.spawn(action.item, racer.state, {
          karts: this.karts,
          ownerId: racer.id,
          ownerProgress: racer.progressScore,
        });
        break;
      }

      // --- GLOBAL: lightning shrinks every rival; boo ghosts the user. We pass
      //     a { racerId: state } map so the descriptor can walk the field, then
      //     for Boo ALSO perform the item steal here (the descriptor only owns
      //     the user's ghost window). -------------------------------------------
      case 'global': {
        const map = this._buildAllKartsMap();
        if (typeof action.apply === 'function') action.apply(map, racer.id);
        if (action.item === 'boo') {
          this._stealItemFor(racer.id);
        }
        break;
      }

      default:
        // Unknown kind: ignore safely.
        break;
    }
  }

  /**
   * Blue shell: the leader equalizer. The projectile pool doesn't model a
   * blueShell type, so we resolve it directly — find the standings leader (that
   * isn't the firer) and spin them out unless invincible. We also launch a fast
   * forward redShell-style mesh purely as a visual cue toward the leader, so it
   * reads on screen; the actual hit is the deterministic spin applied here.
   *
   * @param {object} racer      the firing racer.
   * @param {Array}  standings  leader-first standings.
   * @param {object} action     the projectile descriptor (carries spinSecs).
   * @private
   */
  _fireBlueShell(racer, standings, action) {
    // ONE LIVE BLUE SHELL: if one is already bearing down on the leader, absorb this
    // one — don't stack a second strike (the leader's already being punished). The
    // 'use' VFX was already flagged by _useItemFor, so the fire still reads on screen.
    if (this._blueShellLiveTimer > 0) return;

    // Leader = first entry in the leader-first standings. If the firer IS the
    // leader (rare — back-of-pack item, but guard anyway), target 2nd place.
    let leaderId = null;
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].id !== racer.id) {
        leaderId = standings[i].id;
        break;
      }
    }
    if (leaderId == null) return;

    const target = this._racerById.get(leaderId);
    if (!target) return;

    const secs = action && action.spinSecs ? action.spinSecs : 2.0;
    // Arm the LIVE window (spin time + a short travel margin) so another blue shell
    // fired within it is absorbed by the guard above — one strike on the leader at a
    // time. Armed even if the leader is invincible (a shell still flew at them).
    this._blueShellLiveTimer = secs + 0.6;
    // Honor invincibility (a starred leader shrugs it off) — same rule the
    // projectile system uses on contact.
    if (!isInvincible(target.state)) {
      applySpin(target.state, secs);
    }

    // VFX: a big blue detonation at the leader so the strike reads on screen.
    const ts = target.state;
    this._fxEvents.push({ type: 'blueImpact', x: ts.x, y: ts.y, z: ts.z });

    // Visual flourish: a homing redShell mesh launched toward the leader so the
    // strike is visible. It is COSMETIC — it flies/renders but never collides,
    // so it can't extend the leader's spin or strike an unintended kart en
    // route. The real hit was applied deterministically above.
    this.projectiles.spawn('redShell', racer.state, {
      karts: this.karts,
      ownerId: racer.id,
      ownerProgress: racer.progressScore,
      cosmetic: true,
    });
  }

  /**
   * Super horn: an instant area shockwave around the firer. Spins every
   * non-invincible rival within the horn's radius, and destroys any projectile
   * (notably an incoming blue/red shell) inside that radius. Resolved here
   * because it needs the full field + the projectile pool.
   *
   * @param {object} racer  the firing racer.
   * @private
   */
  _resolveSuperHorn(racer) {
    const RADIUS = 7;          // m — matches the superHorn pulseRadius in items.js
    const R2 = RADIUS * RADIUS;
    const SPIN = 1.0;          // s — matches superHorn spinSecs
    const ox = racer.state.x;
    const oz = racer.state.z;

    // Spin nearby rivals (skip the firer; honor invincibility).
    for (let i = 0; i < this.racers.length; i++) {
      const other = this.racers[i];
      if (other.id === racer.id) continue;
      const dx = other.state.x - ox;
      const dz = other.state.z - oz;
      if (dx * dx + dz * dz <= R2) {
        if (!isInvincible(other.state)) applySpin(other.state, SPIN);
      }
    }

    // Destroy any projectiles inside the blast (cheap: recycle them). The
    // projectile system exposes its pool; we deactivate matching entries.
    const pool = this.projectiles._pool;
    if (pool) {
      for (let i = 0; i < pool.length; i++) {
        const proj = pool[i];
        if (!proj.active) continue;
        const dx = proj.mesh.position.x - ox;
        const dz = proj.mesh.position.z - oz;
        if (dx * dx + dz * dz <= R2) {
          this.projectiles._recycle(proj);
        }
      }
    }
  }

  /**
   * Boo's item steal: take a random rival's held item and hand it to `userId`,
   * clearing the victim. Only steals from racers that actually hold something.
   * (The user's ghost/star window is applied by the Boo descriptor itself.)
   *
   * @param {string} userId  the racer using Boo.
   * @private
   */
  _stealItemFor(userId) {
    // Collect every OTHER racer that currently holds an item.
    const victims = [];
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      if (r.id === userId) continue;
      if (this.itemSystem.hasItem(r.id)) victims.push(r.id);
    }
    if (victims.length === 0) return; // nobody to steal from

    // Pick one at random (use the item system's RNG so a seeded run is reproducible).
    const pick = Math.floor(this.itemSystem.rng() * victims.length);
    const victimId = victims[Math.min(pick, victims.length - 1)];

    const stolen = this.itemSystem.getHeld(victimId);
    if (!stolen) return;
    // Give the user the stolen item id (giveItem resets its count from the def),
    // then clear it from the victim.
    this.itemSystem.giveItem(userId, stolen.id);
    this.itemSystem.clear(victimId);
  }

  /**
   * Build / refresh the { racerId: kartState } map a 'global' item action walks.
   * Reuses the same object across calls to avoid per-use allocation.
   * @returns {object} racerId -> kart state.
   * @private
   */
  _buildAllKartsMap() {
    const map = this._allKartsMap;
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i];
      map[r.id] = r.state;
    }
    return map;
  }

  /**
   * 0-based rank of a racer id in a leader-first standings array (0 = leader).
   * Falls back to the back of the field if the id isn't found.
   * @private
   */
  _rankOf(racerId, standings) {
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].id === racerId) return i;
    }
    return standings.length > 0 ? standings.length - 1 : 0;
  }

  /**
   * HAZARD contact (Phase 3): spin the kart out if it is touching a hazard feature
   * (oil/cone) this tick. Distance test against the pre-resolved feature world
   * positions — the same shape the item-box pickup test uses. applySpin honors
   * invincibility (a starred kart shrugs it off). The hazard radius comes from the
   * feature's params (default 4m).
   * @param {object} racer
   * @private
   */
  _checkHazards(racer) {
    const feats = this.features;
    if (!feats || feats.length === 0) return;
    const sx = racer.state.x;
    const sz = racer.state.z;
    for (let f = 0; f < feats.length; f++) {
      const feat = feats[f];
      if (feat.type !== 'hazard') continue;
      const r = (feat.params && feat.params.radius) || 4;
      const dx = sx - feat.x;
      const dz = sz - feat.z;
      if (dx * dx + dz * dz <= r * r) {
        // RISING EDGE only: applySpin takes the max of the new duration and whatever's
        // left, so re-firing every tick a stationary racer sits in the hazard kept
        // resetting the timer to full — it never left the puddle, so it spun forever.
        // Only (re-)trigger once the previous spin has fully expired.
        if (racer.state.spinTimer <= 0) applySpin(racer.state);
        break; // one hazard hit per tick is plenty
      }
    }
  }

  /**
   * GLIDE-RAMP lookup (Round-12 CONTRACT): is the point (x,z) inside the footprint
   * of a GLIDE ramp — a `ramp` feature whose params.glide === true (placed by
   * Stream T)? Returns the matching feature (truthy) or null. Used ONLY on the
   * ramp-launch rising edge to decide whether to flip state.gliding, so it isn't a
   * per-tick cost. The footprint mirrors sampleSurface's ramp contact test (an
   * oriented rectangle: half-length len*0.5 along the tangent, half-width across),
   * so this fires on exactly the same ramp the surface sample classified as 'ramp'.
   * @param {number} x
   * @param {number} z
   * @returns {object|null} the glide ramp feature touching (x,z), or null.
   * @private
   */
  /**
   * Is the normalized arc-length param `s` inside any fall-in gap on this track?
   * Wrapped-range aware (a gap can straddle the start line). Used by the AI
   * containment net to NOT snap a kart back over a chasm (let it fall instead).
   * @param {number} s  normalized arc-length 0..1 (from sampleSurface().s)
   * @returns {boolean}
   * @private
   */
  /**
   * Drain the pending VFX events (this manager's + the projectile pool's) for
   * main.js to render as item flourishes. Returns a fresh array and clears both
   * queues, so each event fires exactly once. Plain descriptors only (no THREE).
   * @returns {Array<object>} events: { type:'use'|'explosion'|'impact'|'banana'|'blueImpact', x,y,z, ... }
   */
  consumeFxEvents() {
    const mine = this._fxEvents;
    const proj = this.projectiles ? this.projectiles.fxEvents : null;
    let out;
    if (proj && proj.length) {
      out = mine.length ? mine.concat(proj) : proj.slice();
      proj.length = 0;
    } else {
      out = mine.slice();
    }
    mine.length = 0;
    return out;
  }

  _glideRampAt(x, z) {
    const feats = this.features;
    if (!feats || feats.length === 0) return null;
    for (let f = 0; f < feats.length; f++) {
      const feat = feats[f];
      if (feat.type !== 'ramp') continue;
      if (!(feat.params && feat.params.glide)) continue;
      const len = (feat.params && feat.params.length) || 14;
      const dx = x - feat.x;
      const dz = z - feat.z;
      // Oriented-rect footprint (matches sampleSurface): half-length along the
      // feature tangent, half-width across — so the gap launch fires over the wedge.
      const along = dx * feat.tx + dz * feat.tz;
      const across = dx * feat.tz - dz * feat.tx;
      if (Math.abs(along) <= len * 0.5 && Math.abs(across) <= this.halfWidth) return feat;
    }
    return null;
  }

  /**
   * PACK DRAMA (slipstream draft + light bumping), resolved once per tick over all
   * kart states. Two passes share one O(N^2) scan of the 13-kart field (78 unique
   * pairs — trivial):
   *
   *   SLIPSTREAM: for each kart, find the NEAREST kart ahead within DRAFT_DIST and
   *     inside a forward cone (we're behind it, roughly aligned). If found, ramp the
   *     kart's _draftAssist toward DRAFT_BONUS; else ramp it toward 0. Then nudge the
   *     kart's speed up by the eased assist, clamped to DRAFT_CAP so the ~44 m/s top-
   *     speed feel holds. This is the draft "pull" — closing on a leader is easier, so
   *     overtakes happen and the pack stays tight. Applies to the PLAYER too.
   *
   *   BUMPING: any two kart centers closer than BUMP_DIST are overlapping; shove them
   *     apart along the line between them (BUMP_PUSH split 50/50). The scrub + a small
   *     heading kick + a render-only camera-thump flag all SCALE with the closing speed
   *     along the contact normal: a glancing draft-touch barely registers, a real
   *     side-swipe/rear-end bleeds momentum, knocks both off line, and is FELT. Skips
   *     karts that are spun out or airborne (a mid-air/spun kart shouldn't get yanked).
   *
   * Post-physics by design (GP-only; not shared/server): it only nudges position,
   * speed, and — on a real impact — heading, so it can't fight the integrator the way
   * the old AI position clamps did. The _bumpImpact it flags is a render-only transient.
   *
   * @param {number} dt  fixed timestep (for the draft ramp).
   * @private
   */
  _resolvePackContact(dt) {
    const racers = this.racers;
    const n = racers.length;
    if (n < 2) return;

    // --- Pass A: SLIPSTREAM. Per kart, is someone drafting-distance ahead? ----
    for (let i = 0; i < n; i++) {
      const a = racers[i];
      const sa = a.state;
      const spd = sa.speed;
      // Forward unit vector for kart A (same sin/cos convention as the model).
      const fxa = Math.sin(sa.heading);
      const fza = Math.cos(sa.heading);

      let drafting = false;
      if (spd > DRAFT_MIN_SPEED && !sa.airborne && !(sa.spinTimer > 0)) {
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const b = racers[j].state;
          const dx = b.x - sa.x;
          const dz = b.z - sa.z;
          const dist2 = dx * dx + dz * dz;
          if (dist2 > DRAFT_DIST * DRAFT_DIST || dist2 < 1e-4) continue;
          const dist = Math.sqrt(dist2);
          // Forward alignment: is B in front of A? Dot of A's forward with the
          // unit vector A->B. >= DRAFT_CONE means B is within A's forward cone.
          const align = (dx * fxa + dz * fza) / dist;
          if (align >= DRAFT_CONE) {
            drafting = true;
            break; // one kart ahead is enough to catch a draft
          }
        }
      }

      // Ease the assist toward its target (DRAFT_BONUS while drafting, else 0) with
      // a framerate-independent step, so the draft fades on/off smoothly.
      const target = drafting ? DRAFT_BONUS : 0;
      const k = Math.min(1, DRAFT_RAMP * dt);
      a._draftAssist += (target - a._draftAssist) * k;
      if (a._draftAssist < 0.01) a._draftAssist = 0;

      // Apply the assist as a gentle forward speed nudge, clamped to DRAFT_CAP so
      // the top-speed feel is preserved. Only ADD while moving forward (a draft
      // never pushes a reversing/stopped kart). The nudge scales with the eased
      // assist, so it grows in over ~half a second and decays just as smoothly.
      if (a._draftAssist > 0 && spd > 0 && spd < DRAFT_CAP) {
        sa.speed = Math.min(DRAFT_CAP, spd + a._draftAssist * dt * 6);
      }
    }

    // --- Pass B: BUMPING. Push overlapping pairs apart + scrub speed. ---------
    for (let i = 0; i < n; i++) {
      const sa = racers[i].state;
      if (sa.airborne || sa.spinTimer > 0) continue; // don't yank a jumping/spun kart
      for (let j = i + 1; j < n; j++) {
        const sb = racers[j].state;
        if (sb.airborne || sb.spinTimer > 0) continue;
        const dx = sb.x - sa.x;
        const dz = sb.z - sa.z;
        const dist2 = dx * dx + dz * dz;
        if (dist2 >= BUMP_DIST * BUMP_DIST || dist2 < 1e-6) continue;

        // Unit vector from A to B; push each kart half of BUMP_PUSH apart along it.
        const dist = Math.sqrt(dist2);
        const nx = dx / dist;
        const nz = dz / dist;
        const half = BUMP_PUSH * 0.5;
        sa.x -= nx * half; sa.z -= nz * half;
        sb.x += nx * half; sb.z += nz * half;

        // CLOSING SPEED along the contact normal = how hard they ran into each other.
        const fax = Math.sin(sa.heading), faz = Math.cos(sa.heading);
        const fbx = Math.sin(sb.heading), fbz = Math.cos(sb.heading);
        const vAn =  (fax * nx + faz * nz) * sa.speed; // A's speed toward B
        const vBn = -(fbx * nx + fbz * nz) * sb.speed; // B's speed toward A
        const closing = Math.max(0, vAn + vBn);
        const impact = Math.min(1, closing / BUMP_CLOSING_REF); // 0 graze .. 1 hard

        // Impact-scaled scrub: a gentle draft-touch barely slows, a real crash bleeds momentum.
        const scrub = BUMP_SCRUB_MIN + (BUMP_SCRUB_MAX - BUMP_SCRUB_MIN) * impact;
        sa.speed *= scrub; sb.speed *= scrub;

        // KNOCKED OFF LINE: nudge each heading away from the other, scaled by impact and
        // inverse weight (a lighter kart gets shoved further). 1.5 - weight: neutral 0.5 -> 1.0x,
        // lighter (->0) -> 1.5x, heavier (->1) -> 0.5x. cross picks which side to kick toward.
        const wA = 1.5 - (sa.stats ? sa.stats.weight : 0.5);
        const wB = 1.5 - (sb.stats ? sb.stats.weight : 0.5);
        const cross = fax * nz - faz * nx;
        sa.heading -= Math.sign(cross || 1) * BUMP_HEADING_KICK * impact * wA;
        sb.heading += Math.sign(cross || 1) * BUMP_HEADING_KICK * impact * wB;

        // FEEDBACK (render-only transient): flag the impact so the camera shakes + a thud
        // plays. Never read by stepKart, so it carries no sim/parity weight (like trickLandStyle).
        if (impact > 0.15) {
          sa._bumpImpact = Math.max(sa._bumpImpact || 0, impact);
          sb._bumpImpact = Math.max(sb._bumpImpact || 0, impact);
        }
      }
    }
  }

  /**
   * RESPAWN safety net (Phase 3): the open spline courses have no containment
   * walls, so a kart can wander off or sail off a ramp into the void. The old
   * version only had a slow 2.5s off-road timer plus a "fell far below groundY"
   * test — but groundY is the height of the NEAREST CENTERLINE point, so a kart
   * that strays straight out to the side keeps reading road-height groundY and
   * NEVER trips the fell-below test. It would hover at road height ~75m out in the
   * black void until the 2.5s timer finally fired. We fix that by reading
   * surf.lateral (how far OFF to the side the kart actually is) and respawning on
   * a tiered schedule: nearly instant when clearly in the void, quick when just
   * off the edge. Lap progress is untouched — we only reposition the kart.
   *
   * Thresholds:
   *   - FAST  (lateral > halfWidth * 1.6): clearly out in the void -> respawn after
   *     only ~0.4s, so a side-excursion can't sail far before the snap.
   *   - NORMAL (off-road but lateral <= halfWidth * 1.6): just past the edge ->
   *     respawn after ~1.1s, giving a brief grace to recover before the snap.
   *   - FELL backstop (y far below groundY): a true fall off a ramp/edge, kept so
   *     a kart that drops through is caught immediately regardless of lateral.
   *
   * EDGE GRACE (Round-12): merely BRUSHING the road edge — where surf.onRoad can
   * flicker on/off at the exact boundary and lateral barely exceeds the half-width
   * — must NOT start counting toward a respawn or cause boundary jitter. So we only
   * accumulate off-road time once the kart is CLEARLY past the edge (lateral beyond
   * the half-width by a small EDGE_GRACE margin); a brush right at the boundary just
   * holds the timer at 0, so a tyre on the line never trips a snap. This does NOT
   * weaken the genuine fell-off / far-void respawn: a real excursion blows straight
   * past the grace band, and the vertical-fall backstop is independent of lateral.
   *
   * @param {object} racer  the racer record (carries _offroadTime / _lastCp).
   * @param {{onRoad:boolean, groundY:number, lateral:number}} surf  this tick's surface sample.
   * @param {number} dt
   * @private
   */
  _maybeRespawn(racer, surf, dt) {
    // How far off to the side the kart is (unsigned XZ distance to the centerline).
    // >halfWidth means it's past the road edge; ~1.6x+ means it's clearly out in the
    // void. We read it FIRST so the edge-grace check below can use it.
    const lateral = surf.lateral != null ? surf.lateral : 0;
    const VOID_LATERAL = this.halfWidth * 1.6; // clearly out in the void past here

    // EDGE GRACE: only treat the kart as genuinely off-road (and start the respawn
    // timer) once it is CLEARLY past the edge — beyond the half-width by EDGE_GRACE
    // meters. A kart sitting exactly on the boundary (onRoad flickering, lateral ≈
    // halfWidth) holds the timer at 0, so a mere brush never trips a snap or jitter.
    const EDGE_GRACE = 1.5; // m past the road edge before off-road time accrues
    const clearlyOff = !surf.onRoad && lateral > this.halfWidth + EDGE_GRACE;

    // Accumulate continuous off-road time only while CLEARLY off; reset the instant
    // we're back on road OR merely brushing the edge inside the grace band.
    if (!clearlyOff) {
      racer._offroadTime = 0;
    } else {
      racer._offroadTime += dt;
    }

    // FAST respawn: clearly in the void off to the side -> snap after a short grace
    // so nothing floats. NORMAL respawn: merely off the edge -> a touch more grace.
    const FAST_TIME = 0.4;
    const NORMAL_TIME = 1.1;
    // Only the PLAYER trips the lateral off-road respawn (the wanted "fall off ->
    // recover + 3 items" mechanic). AI must NOT be teleported for going off the
    // side — that dumped them back at the last checkpoint with speed 0 every ~1s,
    // creating a respawn LOOP that pinned them at the start and looked like
    // glitching. AI instead recover by STEERING back to the line (see AIRacer's
    // off-line recovery), which keeps them moving smoothly. They still respawn on
    // a genuine vertical fall (fellOff below).
    const offroadTrip = !racer.ai && !surf.onRoad && (
      lateral > VOID_LATERAL
        ? racer._offroadTime >= FAST_TIME
        : racer._offroadTime >= NORMAL_TIME
    );

    // FELL backstop: y dropped well below the centerline terrain under the kart (a
    // true fall through a ramp/edge). groundY is the road height at the nearest
    // centerline point, so this only catches vertical drops, not side-excursions —
    // which is exactly why the lateral-based trips above are the primary trigger.
    const fellOff = racer.state.y < surf.groundY - 25;

    if (offroadTrip || fellOff) {
      const pose = respawnPoint(this.trackId, racer._lastCp);
      // STAGGER the landing laterally per racer so several karts respawning at
      // the same checkpoint don't stack on the exact same spot (the minPair~0
      // pile-up). Offset perpendicular to the driving direction by a stable
      // per-racer amount, kept well inside the road (~±5m of the ~10m half).
      let hsum = 0;
      for (let k = 0; k < racer.id.length; k++) hsum += racer.id.charCodeAt(k);
      const lateral = (hsum % 11) - 5; // -5..+5 m, deterministic per racer
      const h = pose.heading;
      racer.state.x = pose.x + Math.cos(h) * lateral;  // perpendicular to forward
      racer.state.y = pose.y;
      racer.state.z = pose.z - Math.sin(h) * lateral;
      racer.state.heading = pose.heading;
      racer.state.speed = 0;
      racer.state.vy = 0;
      racer.state.airborne = false;
      racer.state.agSection = -1; // a respawn drops out of any anti-grav section
      racer.state.groundY = pose.y;
      // Respawn teleports the kart in arc-length; drop the stale continuity hint
      // so the next surface sample re-acquires the section globally (height-aware)
      // from the known-good on-road respawn pose instead of biasing to the old s.
      racer.state.lastS = undefined;
      racer._offroadTime = 0;

      // COMEBACK REWARD (R5-B): the PLAYER keeps their progress on a fall-off
      // (they respawn at the last checkpoint), but falling still cost them ground.
      // Compensate with a strong catch-up item. PLAYER-ONLY: offroadTrip is already
      // gated to !racer.ai, but fellOff fires for AI too, so this guard is what
      // keeps AI from ever getting the reward (they recover by steering, not perks).
      // Suppress the reward during the pre-race countdown lock and after the race
      // is over: a kart rolling off an edge during the finish-line rollout must NOT
      // grant a useless item or flash "COMEBACK!" over the results screen. The
      // reposition above still runs (a kart always recovers); only the perk is gated.
      if (!racer.ai && !this._locked && !this.raceOver && !this.noItems) {
        // Pool of strong CATCH-UP items (3 boosts / rapid boosts / invincible-fast /
        // autopilot rocket) — the "3 strong comeback items" spirit in the one-id+count
        // held slot. Pick with the SEEDED rng (not Math.random) so the draw stays
        // deterministic and server-reproducible.
        const FALL_REWARDS = ['tripleMushroom', 'goldenMushroom', 'star', 'bulletBill'];
        const reward = FALL_REWARDS[Math.floor(this.itemSystem.rng() * FALL_REWARDS.length)];
        // OVERWRITES any currently-held item — intended: the fall cost you ground,
        // the reward compensates.
        this.itemSystem.giveItem(racer.id, reward);
        // Stash the reward's display name for render() to flash as a HUD banner
        // (update() has no hud reference; render() does — see render()).
        const def = getItem(reward);
        this._fallRewardPending = def ? def.name : reward;
      }
    }
  }

  // ========================================================================
  // RENDER (called once per painted frame).
  // ========================================================================
  /**
   * Sync every kart mesh to its state and refresh the player's HUD. Visual only —
   * no simulation here.
   *
   * @param {number} alpha  render interpolation factor in [0, 1) from the loop:
   *                        how far real time sits between the previous and current
   *                        physics ticks. Each kart's position + heading are blended
   *                        between racer.prevTransform and racer.state by this, which
   *                        kills the 60Hz turn judder at high paint rates.
   * @param {object} hud  the HUD instance (player lap/position/speed panel).
   * @param {object} renderer  the Renderer (chase camera follows the player).
   * @param {number} raceClock  current sim clock, for the player's lap timer.
   */
  render(alpha, hud, renderer, raceClock) {
    // 1. Sync all 13 kart meshes from an INTERPOLATED transform (body lean, drift
    //    sparks, spin/star/shrink visuals, wheel roll/steer). makeRenderState
    //    blends prevTransform->state position by alpha and heading shortest-arc by
    //    alpha, copying every other (visual) field live from state. We still pass
    //    the fixed DT for the internal wheel-roll / spark / lerp animation so those
    //    stay rate-consistent. The AI uses its own last steer; the player uses the
    //    live input steer captured in update().
    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];
      // lastSteer is captured in update() for every record (player, AI, phone), so
      // render never has to poll an input source (fixed-step contract preserved).
      const rs = makeRenderState(racer.prevTransform, racer.state, alpha);
      racer.kart.syncFromState(rs, DT, racer.lastSteer);
    }

    // 2. Chase camera follows the PLAYER, from the SAME interpolated transform the
    //    mesh used, so the camera tracks the smooth render pose rather than the
    //    discrete tick pose (otherwise the kart would slide within the frame).
    const player = this._racerById.get('player');
    if (player && renderer) {
      const playerRs = makeRenderState(player.prevTransform, player.state, alpha);
      renderer.updateChaseCamera(playerRs, DT, this.trackId);
    }

    // 3. HUD for the player: lap / position / lap-timer / mini-turbo.
    if (player && hud) {
      const standings = this.lapSystem.getStandings();
      const progress = this.lapSystem.getProgress('player');

      // Player's 1-based race position = index in the leader-first standings + 1.
      let position = 1;
      for (let i = 0; i < standings.length; i++) {
        if (standings[i].id === 'player') {
          position = i + 1;
          break;
        }
      }

      const info = {
        // lap is 0-based until the first line cross; show it 1-based, capped at
        // totalLaps so the counter reads "LAP 3/3" on the final lap, not 4.
        lap: Math.min((progress ? progress.lap : 0) + 1, this.totalLaps),
        totalLaps: this.totalLaps,
        position,
        totalRacers: standings.length,
        // Current-lap elapsed time (raceClock - lapStart). Before the first line
        // cross lapStart is 0, so this is just the time on track so far.
        lapTime: progress ? raceClock - progress.lapStart : 0,
        bestLap: progress ? progress.bestLap : null,
        miniTurboTier: player.state.miniTurboTier,
        // Held power-up for the top-center item slot (null when empty -> hidden).
        heldItem: this._heldItemFor('player'),
      };
      hud.update(player.state, info);

      // INCOMING-WARNING: a directional "!" arrow when a projectile is homing on
      // the player (Stream I flags .threat/.targetId). Wired here (not main.js) so
      // it reads the freshest projectile pool right after the sim tick. Safe no-op
      // if the HUD build predates the method.
      if (typeof hud.setIncomingThreat === 'function') {
        hud.setIncomingThreat(this._incomingThreatDir());
      }

      // COMEBACK REWARD banner: if _maybeRespawn granted a fall-off catch-up item
      // this tick, flash a brief centered HUD banner naming it, then clear the flag
      // so it fires exactly once. Safe no-op if the HUD build predates the method.
      if (this._fallRewardPending && typeof hud.showRewardBanner === 'function') {
        hud.showRewardBanner('COMEBACK! ' + this._fallRewardPending);
        this._fallRewardPending = null;
      }
    }
  }

  // ========================================================================
  // START LOCK + RESULTS (race lifecycle the orchestrator drives).
  // ========================================================================
  /**
   * Release the START LOCK at GO (called by main.js when the 3-2-1 countdown
   * hits 0). Clears _locked so the next update() reads real input again and the
   * field launches off the grid. No-op once the race is over (you can't un-finish
   * a race). Idempotent — calling it twice is harmless.
   */
  release() {
    if (this.raceOver) return;
    this._locked = false;
  }

  /**
   * @returns {boolean} true while the pre-race start lock is held (countdown).
   */
  isLocked() {
    return this._locked;
  }

  /**
   * Final results, leader-first. Returns the snapshot computed the tick the
   * player finished (stable while karts roll out); falls back to a live compute
   * if asked before the race ends.
   *
   * @returns {Array<{place:number, id:string, name:string, color:number,
   *                  isPlayer:boolean, time:number|null, coinsEarned:number}>}
   */
  getResults() {
    return this._results || this._computeResults();
  }

  /**
   * Build the full 1st..13th ranking. FIX (Round-12): the old version ranked by
   * lapSystem.getStandings() (progressScore), which placed the SLOWEST FINISHER
   * FIRST — e.g. a player who finished in 04:40 was shown ABOVE a CPU who finished
   * in 04:25, because progressScore tops out equal once everyone has done the laps
   * and the order then fell to checkpoint fractions, not finish time.
   *
   * The correct order for a finished race is by FINISH TIME:
   *   1. FINISHED racers (prog.finished) first, ASCENDING by total finish time
   *      (sum of lapTimes) — the EARLIEST finisher is 1st.
   *   2. UNFINISHED racers (still out on track) BELOW all finishers, DESCENDING by
   *      progressScore (the one furthest along is the best of the rest).
   * The player's place therefore = (# racers that finished before them) + 1, which
   * is exactly their index in this sorted list. The {place,id,name,color,isPlayer,
   * time} shape is unchanged; unfinished racers carry a null time.
   *
   * Computed once on the finish edge (cached in _results).
   *
   * @returns {Array<{place:number, id:string, name:string, color:number,
   *                  isPlayer:boolean, time:number|null, coinsEarned:number}>}
   * @private
   */
  _computeResults() {
    // Build a row per racer with its finish time (null if unfinished) and live
    // progressScore, then sort: finishers-by-time first, then the rest-by-progress.
    const rows = [];
    for (let i = 0; i < this.racers.length; i++) {
      const racer = this.racers[i];
      const prog = this.lapSystem.getProgress(racer.id);
      const finished = !!(prog && prog.finished);
      // Total race time = sum of completed lap times (seconds), or null if the
      // racer hasn't actually finished (an AI still out on track).
      let time = null;
      if (finished && prog.lapTimes && prog.lapTimes.length) {
        time = prog.lapTimes.reduce((a, b) => a + b, 0);
      }
      rows.push({
        id: racer.id,
        name: racer.name,
        color: racer.color,
        isPlayer: !racer.ai,
        rival: !!racer.rival, // designated nemesis (slot-3 AI) — for the rival tag/tally
        finished,
        time,
        coinsEarned: racer.coinsEarned || 0,
        progressScore: prog ? prog.progressScore : racer.progressScore,
      });
    }

    rows.sort((a, b) => {
      // Finishers always rank above non-finishers.
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) {
        // Both finished: EARLIEST finish time first (ascending). A null time here
        // would be a finished racer with no recorded laps (shouldn't happen) — sort
        // it last among finishers so a real time always wins.
        const ta = a.time != null ? a.time : Infinity;
        const tb = b.time != null ? b.time : Infinity;
        return ta - tb;
      }
      // Neither finished: furthest along (highest progressScore) first.
      return b.progressScore - a.progressScore;
    });

    return rows.map((r, i) => ({
      place: i + 1,
      id: r.id,
      name: r.name,
      color: r.color,
      isPlayer: r.isPlayer,
      rival: r.rival,
      time: r.time,
      coinsEarned: r.coinsEarned,
      // Placement payout for this finish (banked into the wallet on the finish edge;
      // surfaced here so the results board can show it).
      placeCoins: coinsForPlace(i + 1),
    }));
  }

  /**
   * Directional INCOMING-THREAT for the player's HUD: scans the projectile pool
   * for an active record flagged .threat with .targetId === 'player' (Stream I
   * sets these on a homing/closing projectile). Returns a signed turn direction
   * in [-1,1] — where the threat sits relative to where the player is facing
   * (negative = coming from the left, positive = from the right) — or null when
   * nothing is bearing down. The HUD draws a "!" arrow from this; main.js reads it
   * each frame (see the render hook) and also plays a subtle danger cue.
   *
   * @returns {number|null} signed left/right direction, or null if no threat.
   * @private
   */
  _incomingThreatDir() {
    const player = this._racerById.get('player');
    const pool = this.projectiles && this.projectiles._pool;
    if (!player || !pool) return null;
    const ps = player.state;
    // Player forward + right unit vectors (same sin/cos convention as the model).
    const fx = Math.sin(ps.heading), fz = Math.cos(ps.heading);
    const rx = fz, rz = -fx; // right = forward rotated -90deg about Y
    for (let i = 0; i < pool.length; i++) {
      const proj = pool[i];
      if (!proj || !proj.active) continue;
      if (!proj.threat || proj.targetId !== 'player') continue;
      // Where is the projectile relative to the player? Project the offset onto
      // the player's right axis -> a signed left/right value, normalized to ±1.
      const dx = proj.mesh.position.x - ps.x;
      const dz = proj.mesh.position.z - ps.z;
      const right = dx * rx + dz * rz;
      const fwd = dx * fx + dz * fz;
      // Sign by side; magnitude eased so a near-dead-ahead threat still reads.
      const dir = Math.atan2(right, Math.abs(fwd) + 1e-3) / (Math.PI / 2);
      return Math.max(-1, Math.min(1, dir));
    }
    return null;
  }

  // ========================================================================
  // Helpers for HUD / debug.
  // ========================================================================
  /**
   * @returns {object} the player's racer record { id, state, kart, ai, ... }.
   */
  getPlayer() {
    return this._racerById.get('player');
  }

  /**
   * @param {string} id
   * @returns {object|undefined} the racer record for `id`.
   */
  getRacer(id) {
    return this._racerById.get(id);
  }

  /**
   * @returns {Array} the live racer records (also the karts list the item/
   *                  projectile systems read).
   */
  getKarts() {
    return this.racers;
  }

  /**
   * COUCH/TV: one render-interpolated view per roster human, in join order, for
   * the split-screen renderer + overlay. A kart whose phone dropped (AI takeover)
   * KEEPS its view — the quadrant just watches the AI drive. Empty when solo.
   *
   * @param {number} alpha  render interpolation factor in [0, 1).
   * @returns {Array<{id:string, name:string, color:number|string, state:object}>}
   */
  getHumanViews(alpha) {
    if (!this.humans) return [];
    const out = [];
    for (let i = 0; i < this.humans.length; i++) {
      const racer = this._racerById.get(this.humans[i].id);
      if (!racer) continue;
      out.push({
        id: racer.id,
        name: racer.name,
        color: racer.color,
        state: makeRenderState(racer.prevTransform, racer.state, alpha),
      });
    }
    return out;
  }

  /**
   * COUCH/TV: a phone dropped mid-race — hand its kart to an AI brain built for
   * the SAME grid slot (identical personality/pace the solo field would have
   * there), so the race carries on seamlessly. Idempotent; returns whether a
   * takeover actually happened.
   *
   * @param {string} id  the human racer id (server playerId).
   * @returns {boolean}
   */
  replaceWithAI(id) {
    const racer = this._racerById.get(id);
    if (!racer || racer.ai) return false;
    const { cc, profile } = buildAISlot(racer._slotIndex, this.difficulty);
    racer.ai = new AIRacer({
      racingLine: this.racingLine,
      cc,
      profile,
      seed: racer._slotIndex,
    });
    racer.inputProvider = null;
    return true;
  }

  /**
   * @returns {string} held-item id for the player, or '' if empty (HUD/debug).
   */
  getPlayerItem() {
    const held = this.itemSystem.getHeld('player');
    return held ? held.id : '';
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
    // Feed the HUD the FULL 3-slot strip so all held items show (the HUD resolves
    // each slot's icon/name from ITEMS). Null when fully empty -> HUD hides the panel.
    if (!this.itemSystem.hasItem(racerId)) return null;
    return { slots: this.itemSystem.getSlots(racerId) };
  }

  /**
   * Tear down everything this manager added to the render scene: the 13 kart
   * groups, the item-box group, and the projectile group (all attached directly
   * to `this.scene`, NOT to track.group, so main.js's track removal misses them).
   *
   * main.js teardownMode() calls this conditionally (`if typeof dispose ===
   * 'function'`), so simply defining it stops Grand Prix from orphaning the
   * field on return-to-menu. Mirrors Battle.dispose() / MultiplayerRace.dispose().
   */
  dispose() {
    // Free every kart's materials and detach it (dispose() removes the group too).
    for (const racer of this.racers) {
      if (racer.kart && typeof racer.kart.dispose === 'function') racer.kart.dispose();
      else if (racer.kart && racer.kart.group && racer.kart.group.parent) racer.kart.group.parent.remove(racer.kart.group);
    }

    // Remove the item-box group, then free its GPU resources if it can.
    if (this.itemBoxes) {
      if (this.itemBoxes.group && this.itemBoxes.group.parent) {
        this.itemBoxes.group.parent.remove(this.itemBoxes.group);
      }
      if (typeof this.itemBoxes.dispose === 'function') this.itemBoxes.dispose();
    }

    // Remove the projectile group, then free its GPU resources if it can.
    if (this.projectiles) {
      if (this.projectiles.group && this.projectiles.group.parent) {
        this.projectiles.group.parent.remove(this.projectiles.group);
      }
      if (typeof this.projectiles.dispose === 'function') this.projectiles.dispose();
    }

    // Drop references so the field can be garbage-collected.
    this.racers = [];
    this.karts = [];
    if (this._racerById) this._racerById.clear();
  }
}
