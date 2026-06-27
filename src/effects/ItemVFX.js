// src/effects/ItemVFX.js
//
// ItemVFX = the POWER-UP visual-effects layer. It is a self-contained class that
// lives entirely in the CLIENT (it imports three + gsap). It paints the punchy,
// readable feedback for the item/boost systems WITHOUT editing the kart, the
// renderer, or the track:
//
//   - BOOST exhaust trail : a continuous jet of flame particles streaming out the
//                           back of any kart whose state.boostTimer > 0.
//   - SPEED-LINES overlay : a DOM vignette of radial streak lines that fades in
//                           while the PLAYER is boosting, selling the speed surge.
//   - STAR aura/shimmer    : a rainbow-cycling glow sprite that wraps any kart
//                           whose state.starTimer > 0, plus orbiting sparkles.
//   - SPIN stars           : a one-shot ring of little ⭐ stars that orbits a kart
//                           on the rising edge of state.spinTimer (it got hit).
//   - PICKUP flash         : a quick expanding ring + pop when an item is grabbed.
//
// DESIGN / OWNERSHIP NOTES
// ------------------------
//   * It NEVER mutates kart state, the camera, or the track. It only reads
//     positions (state.x/y/z + heading) and timers (boostTimer/starTimer/
//     spinTimer) that the shared model already maintains, and adds its OWN meshes
//     to the scene it is given.
//   * The CAMERA FOV-kick + shake the task mentions are ALREADY owned by the
//     Renderer (renderer.applyCameraFeel, driven from main.js). We deliberately do
//     NOT duplicate them here — two systems writing camera.fov / camera.position in
//     the same frame would fight. Our boost contribution is the flame trail +
//     screen speed-lines, which complement (not collide with) the Renderer's lens.
//   * PERFORMANCE: every particle is drawn from a fixed POOL allocated once in the
//     constructor. emit*() just wakes sleeping particles; the per-frame update only
//     touches awake ones. The star aura sprites are a small fixed pool keyed by
//     kart id (re-used frame to frame). There are NO per-frame allocations in the
//     hot loops — no new THREE.Vector3 / Color / array per frame.
//
// USAGE (wired from main.js):
//   const itemVfx = new ItemVFX(renderer.scene);
//   // each frame, AFTER the manager positioned its karts:
//   itemVfx.update(DT, { camera, karts, playerState, playerItemId });
// where `karts` is manager.getKarts() (records with { id, state, ai }) and
// playerState/playerItemId come from main.js's existing getPlayerState()/
// getPlayerItem() helpers.

import * as THREE from 'three';
import gsap from 'gsap';
import { EFFECTS } from '../../shared/constants.js';
// QUALITY TIER: scales the particle-pool budget so weak GPUs draw fewer particles.
import qualitySettings from '../core/QualitySettings.js';

// --- LOCAL VFX TUNING (this file only; we may READ shared EFFECTS.VFX but must
// NOT edit shared/constants.js, so the new juice numbers live here). -----------
//
// DRIFT_SPARK_INTERVAL — seconds between drift-spark puffs while a kart is
//   drifting at tier >= 1. Tight so the sparks read as a continuous shower.
// DRIFT_TIER_COLORS — the mini-turbo tier -> spark color map. Tier 1 = blue,
//   tier 2 = orange, tier 3 = purple, matching the charge climbing. Index 0 is
//   an unused placeholder (tier 0 emits no sparks).
const DRIFT_SPARK_INTERVAL = 0.02; // s — dense spark shower under the wheels
const DRIFT_TIER_COLORS = [0xffffff, 0x4ab8ff, 0xff8a1e, 0xc24aff];

export class ItemVFX {
  /**
   * @param {THREE.Scene} scene  The render scene to attach effect meshes to.
   * @param {object} [opts]
   * @param {number} [opts.poolSize=320]  Particle pool size (boost trail + star
   *        sparkles + spin stars + pickup flash all draw from this one pool).
   * @param {number} [opts.auraPool=8]    How many reusable star-aura sprites to
   *        pre-build (one per starred kart on screen at once; 8 covers the field).
   */
  constructor(scene, opts = {}) {
    this.scene = scene;

    // QUALITY TIER budget: particleScale (0..1) shrinks the pools below so a weak
    // GPU draws fewer particles. A smaller pool self-throttles every emitter for
    // free — _acquire() returns null when exhausted, so a busy frame simply drops
    // the extra particles rather than allocating. Read once at construction (the
    // pool is built once for the page); a tier change settles in on the next load.
    const qcfg = qualitySettings.getConfig();

    // ----------------------------------------------------------------------
    // 1. SHARED PARTICLE POOL (flames, sparkles, spin-stars, flash rings).
    // ----------------------------------------------------------------------
    // One flat plane geometry reused by every particle; each particle scales it
    // via mesh.scale. depthWrite:false stops overlapping particles from punching
    // holes in each other; transparent lets us fade via opacity.
    // Floor of 48 so even LOW keeps effects readable (just less dense).
    const basePool = opts.poolSize != null ? opts.poolSize : 320;
    const poolSize = Math.max(48, Math.round(basePool * qcfg.particleScale));
    this._geometry = new THREE.PlaneGeometry(1, 1);
    this._particles = [];
    for (let i = 0; i < poolSize; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        // AdditiveBlending makes flames/sparkles GLOW (colours add toward white)
        // which reads as energetic neon — exactly the look boost/star want.
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this._geometry, material);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 3; // draw over the karts/track so glow isn't occluded
      this.scene.add(mesh);
      this._particles.push({
        mesh,
        material,
        active: false,
        life: 0,
        maxLife: 1,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 0,
        startScale: 1,
        endScale: 1,
        startOpacity: 1,
        spin: 0, // z-rotation speed (rad/s) for fluttering particles
        roll: 0, // accumulated z-rotation
        // ORBIT fields (used by spin-stars + star sparkles): when orbitR > 0 the
        // particle circles its anchor instead of flying ballistically. The anchor
        // is read from a live kart state by id so it tracks a moving kart.
        orbitR: 0, // orbit radius (m); 0 = ballistic particle
        orbitA: 0, // current orbit angle (rad)
        orbitSpd: 0, // orbit angular speed (rad/s)
        orbitY: 0, // vertical offset above the anchor (m)
        anchor: null, // a kart STATE object to orbit ({x,y,z}); null = world-fixed
        rainbow: false, // cycle hue over the lifetime (star shimmer)
        hue: 0, // current hue (0..1) when rainbow
        // FLAT particles (boost scorch streaks) stay laid on the ground with their
        // own fixed rotation instead of billboarding to the camera. Default off.
        flat: false,
        // customScale particles (lightning bolt segments) keep the non-uniform
        // mesh.scale set at emit time; the step loop must NOT overwrite it via
        // setScalar. Default off (normal particles scale uniformly over life).
        customScale: false,
      });
    }

    // ----------------------------------------------------------------------
    // 2. STAR AURA sprite pool (one glowing shell per starred kart).
    // ----------------------------------------------------------------------
    // A larger, soft additive plane that hovers ON a starred kart and cycles
    // through rainbow colours. We keep a small fixed pool and lease one to each
    // starred kart each frame (keyed by kart id), so a kart keeps the SAME sprite
    // frame to frame and we never allocate mid-race.
    // Aura sprites scale with the tier too (floor of 2 so a couple of starred
    // karts still glow on LOW).
    const baseAura = opts.auraPool != null ? opts.auraPool : 8;
    const auraPool = Math.max(2, Math.round(baseAura * qcfg.particleScale));
    this._auras = [];
    for (let i = 0; i < auraPool; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this._geometry, material);
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 2;
      mesh.scale.setScalar(3.2); // big soft glow around the ~1.5m kart body
      this.scene.add(mesh);
      this._auras.push({ mesh, material, ownerId: null, hue: 0 });
    }
    // Map<kartId, auraIndex> tracking which aura a starred kart currently holds,
    // so the same kart re-uses its sprite (no flicker) and we can free it on expiry.
    this._auraByKart = new Map();

    // ----------------------------------------------------------------------
    // 3. SPEED-LINES DOM overlay (boost-only screen vignette).
    // ----------------------------------------------------------------------
    // A full-screen, pointer-transparent layer of radial streak lines drawn with a
    // repeating conic-gradient mask. We fade its opacity in/out with GSAP off the
    // PLAYER's boost state. It is a DOM element (not a three object) so it needs no
    // Renderer changes and sits above the canvas via a high z-index. pointer-events
    // none so it never eats clicks.
    this._speedLines = document.createElement('div');
    this._speedLines.id = 'item-vfx-speedlines';
    const s = this._speedLines.style;
    s.position = 'fixed';
    s.inset = '0';
    s.pointerEvents = 'none';
    s.zIndex = '5'; // above the canvas, below the HUD text panels
    s.opacity = '0';
    s.mixBlendMode = 'screen'; // lighten-only so lines glow over the scene
    // Radial streaks: a tight repeating conic-gradient of thin white wedges,
    // masked to a ring so the screen CENTRE stays clear (you look THROUGH the
    // tunnel) and the streaks crowd the edges. The mask fades the inner disc out.
    s.background =
      'repeating-conic-gradient(from 0deg at 50% 50%, ' +
      'rgba(255,255,255,0.0) 0deg, rgba(255,255,255,0.55) 0.4deg, ' +
      'rgba(255,255,255,0.0) 1.1deg)';
    const ring =
      'radial-gradient(circle at 50% 50%, ' +
      'transparent 0%, transparent 38%, #000 78%, #000 100%)';
    s.webkitMaskImage = ring;
    s.maskImage = ring;
    document.body.appendChild(this._speedLines);
    // GSAP tween handle so we can retarget the fade without stacking tweens.
    this._speedLinesTween = null;
    this._speedLinesShown = false;

    // ----------------------------------------------------------------------
    // 3b. HIT FLASH DOM overlay (player damage feedback).
    // ----------------------------------------------------------------------
    // A full-screen red vignette that flashes briefly when the PLAYER is hit, for
    // a punchy "ow!" jolt. A radial gradient keeps the screen CENTRE clear (you
    // can still see the road) while the edges pulse red — a classic damage flash,
    // far punchier than a flat red wash. Pointer-transparent; fired by hitFlash().
    this._hitFlash = document.createElement('div');
    this._hitFlash.id = 'item-vfx-hitflash';
    const hf = this._hitFlash.style;
    hf.position = 'fixed';
    hf.inset = '0';
    hf.pointerEvents = 'none';
    hf.zIndex = '20'; // above the canvas + speed-lines, below the menus/pause
    hf.opacity = '0';
    hf.background =
      'radial-gradient(circle at 50% 50%, rgba(255,0,0,0) 30%, rgba(255,28,28,0.6) 100%)';
    document.body.appendChild(this._hitFlash);
    this._hitFlashTween = null; // GSAP handle so rapid hits don't stack tweens

    // ----------------------------------------------------------------------
    // 4. EDGE-DETECTION bookkeeping (rising edges -> one-shot bursts).
    // ----------------------------------------------------------------------
    // Per-kart previous spin timer (to fire spin-stars once on a fresh hit) and
    // emit accumulators for the throttled continuous emitters (boost trail / star
    // sparkles). Maps keyed by kart id; cleaned up when a kart leaves the field.
    this._prevSpin = new Map(); // id -> last frame's spinTimer
    this._boostAccum = new Map(); // id -> seconds since last boost-trail puff
    this._sparkleAccum = new Map(); // id -> seconds since last star sparkle
    this._driftAccum = new Map(); // id -> seconds since last drift-spark puff
    this._prevBoost = new Map(); // id -> last frame's boostTimer (boost-release edge)
    // id -> highest miniTurboTier seen during the current drift. The kart model
    // ZEROES miniTurboTier in the SAME step it arms boostTimer on release, so by
    // the time we see the boost rising edge the tier is already 0 — we stash the
    // peak here while drifting so the release flash can be colored by it.
    this._driftPeakTier = new Map();
    // Player pickup edge: the held item id last frame, to fire the pickup flash
    // when it changes from empty -> something (or swaps to a different item).
    this._prevPlayerItem = null;
    // id -> last frame's shrinkTimer (lightning victim). Used to fire the one-shot
    // shrink POOF on the rising edge, and to throttle the struggle sparks below.
    this._prevShrink = new Map();
    this._shrinkAccum = new Map(); // id -> seconds since last struggle spark
    // id -> seconds since last boost ground-scorch puff (separate throttle from the
    // flame trail so the ground streak reads as its own continuous scorch mark).
    this._scorchAccum = new Map();
    // id -> seconds since last boo ghost flicker puff (only used if st.ghostTimer).
    this._ghostAccum = new Map();

    // Scratch hue array for the rainbow cycle so setHSL never allocates.
    this._tmpColor = new THREE.Color();

    // ----------------------------------------------------------------------
    // 5. LAST-CAMERA cache (so one-shot event methods can billboard + parent).
    // ----------------------------------------------------------------------
    // The state-driven update() receives ctx.camera; we stash it here so the
    // CENTRALLY-CALLED one-shot methods (itemUseBurst/explosion/impactSpark/
    // lightningStrike/lightningFlash/...) can billboard to the same camera and
    // parent the full-screen flash quad WITHOUT needing it passed each call. It
    // stays null until the first update(), and every one-shot is null-safe.
    this._camera = null;

    // ----------------------------------------------------------------------
    // 6. LIGHTNING / SCREEN FLASH quad (one pre-built full-screen plane).
    // ----------------------------------------------------------------------
    // A single large additive plane that fills the view for the lightning
    // whiteout. The game's CAMERA is NOT part of the scene graph (renderer.render
    // (scene, camera) won't draw camera children), so we add this quad to the
    // SCENE and each active frame REPOSITION it just in front of the live camera
    // in world space (facing it), which guarantees it renders AND rides the view.
    // Built once; reused for every flash. depthTest:false so it always draws on
    // top regardless of scene depth.
    this._flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this._flashQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._flashMat);
    this._flashQuad.scale.set(40, 30, 1); // generously oversize so it fills any FOV
    this._flashQuad.visible = false;
    this._flashQuad.renderOrder = 999; // draw last = truly on top of everything
    this._flashQuad.frustumCulled = false;
    this.scene.add(this._flashQuad);
    this._flashLife = 0; // seconds remaining on the active flash (0 = idle)
    this._flashMaxLife = 0.25;
    // Scratch vector reused to place the flash quad in front of the camera each
    // frame (no per-frame allocation in _stepFlash).
    this._flashPos = new THREE.Vector3();

    // ----------------------------------------------------------------------
    // 7. BLUE-SHELL target reticle pool (hovering marker meshes).
    // ----------------------------------------------------------------------
    // A tiny pool of additive ring sprites that HOVER over a doomed kart's spot,
    // bobbing + pulsing until blueShellImpact() clears them (or they time out).
    // Kept separate from the particle pool so a long-lived reticle never starves
    // the short-lived burst particles. Pool of 4 covers concurrent blue shells.
    this._reticles = [];
    for (let i = 0; i < 4; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0x3aa0ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this._geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      this._reticles.push({ mesh, material, active: false, life: 0, t: 0, x: 0, y: 0, z: 0 });
    }
  }

  // ===========================================================================
  // POOL HELPERS
  // ===========================================================================

  // Find the next sleeping particle, or null if the pool is exhausted (a busy
  // frame then simply drops extra particles rather than allocating more).
  _acquire() {
    for (let i = 0; i < this._particles.length; i++) {
      if (!this._particles[i].active) return this._particles[i];
    }
    return null;
  }

  // Reset a particle's per-emit fields to safe defaults so each emitter only has
  // to set what it cares about (keeps the emit functions short + correct).
  _resetParticle(p) {
    p.gravity = 0;
    p.spin = 0;
    p.roll = 0;
    p.orbitR = 0;
    p.orbitA = 0;
    p.orbitSpd = 0;
    p.orbitY = 0;
    p.anchor = null;
    p.rainbow = false;
    p.flat = false;
    p.customScale = false;
  }

  // ===========================================================================
  // EMITTERS
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // _emitBoostPuff(state) — one small cluster of flame out the back of a kart.
  // Called on a throttle while state.boostTimer > 0, so over time it reads as a
  // continuous exhaust jet. `state` carries {x,y,z,heading}; flames shoot OPPOSITE
  // the kart's forward vector (out the tailpipe) with a little spread + lift.
  // ---------------------------------------------------------------------------
  _emitBoostPuff(state) {
    const fx = Math.sin(state.heading);
    const fz = Math.cos(state.heading);
    const backX = -fx;
    const backZ = -fz;
    const perpX = -backZ; // sideways axis (back-vector rotated 90°)
    const perpZ = backX;

    const count = 7; // DENSER trail (was 4): a fatter, more energetic exhaust jet
    for (let i = 0; i < count; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);

      // Hot core -> orange -> red gradient, additive so it glows like fire.
      const t = Math.random();
      const color = t < 0.45 ? 0xfff0a0 : t < 0.78 ? 0xff9a30 : 0xff3a1a;
      const side = (Math.random() - 0.5) * 1.0;
      const speed = 7 + Math.random() * 6;

      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.mesh.position.set(
        state.x + backX * 0.7 + perpX * side * 0.25,
        (state.y || 0) + 0.35 + Math.random() * 0.2,
        state.z + backZ * 0.7 + perpZ * side * 0.25,
      );
      p.vx = backX * speed + perpX * side;
      p.vy = 0.8 + Math.random() * 1.2;
      p.vz = backZ * speed + perpZ * side;
      p.maxLife = 0.22 + Math.random() * 0.12;
      p.life = p.maxLife;
      p.startScale = 0.8 + Math.random() * 0.5;
      p.endScale = 0.08; // shrink to a spark as it burns out
      p.mesh.scale.setScalar(p.startScale);
      p.roll = Math.random() * Math.PI;
    }
  }

  // ---------------------------------------------------------------------------
  // _emitScorch(state) — a flat, ground-hugging scorch streak dropped UNDER a
  // boosting kart. A dark-orange additive disc laid near the ground (it does not
  // billboard — it stays flat to the floor) that fades fast, so a boosting kart
  // leaves a glowing burnt streak on the track. Called on its own throttle while
  // boostTimer > 0, complementing the flame jet out the back.
  // ---------------------------------------------------------------------------
  _emitScorch(state) {
    const p = this._acquire();
    if (!p) return;
    this._resetParticle(p);
    const fx = Math.sin(state.heading);
    const fz = Math.cos(state.heading);
    p.active = true;
    p.mesh.visible = true;
    p.flat = true; // lay flat on the ground (NOT billboarded) — see _stepParticles
    p.material.color.setHex(0xff5a18);
    p.material.opacity = 0.7;
    p.startOpacity = 0.7;
    p.maxLife = 0.45;
    p.life = p.maxLife;
    p.startScale = 1.1 + Math.random() * 0.4;
    p.endScale = 2.2; // spread as it cools
    p.mesh.scale.setScalar(p.startScale);
    // Lay the plane flat (face up) at ground level, slightly behind the kart.
    p.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI);
    p.mesh.position.set(state.x - fx * 0.6, (state.y || 0) + 0.06, state.z - fz * 0.6);
  }

  // ---------------------------------------------------------------------------
  // _emitShrinkPoof(state) — a quick puff of pale smoke + a shrink ring the
  // INSTANT a kart is zapped small by lightning (rising edge of shrinkTimer). Sells
  // the "squish". `state` carries {x,y,z}.
  // ---------------------------------------------------------------------------
  _emitShrinkPoof(state) {
    // A pale compression ring snapping inward-then-out.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(0xc8e0ff);
        p.material.opacity = 0.9;
        p.startOpacity = 0.9;
        p.maxLife = 0.3;
        p.life = p.maxLife;
        p.startScale = 2.2;
        p.endScale = 0.4; // collapse inward = a squish
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(state.x, (state.y || 0) + 0.7, state.z);
      }
    }
    // A ring of pale smoke puffs popping outward + up.
    const puffs = 8;
    for (let i = 0; i < puffs; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = (i / puffs) * Math.PI * 2;
      const spd = 2.5 + Math.random() * 1.5;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(0xe6eeff);
      p.material.opacity = 0.85;
      p.startOpacity = 0.85;
      p.vx = Math.cos(ang) * spd;
      p.vy = 1.2 + Math.random();
      p.vz = Math.sin(ang) * spd;
      p.gravity = 3;
      p.maxLife = 0.35 + Math.random() * 0.15;
      p.life = p.maxLife;
      p.startScale = 0.4;
      p.endScale = 0.9;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(state.x, (state.y || 0) + 0.5, state.z);
    }
  }

  // ---------------------------------------------------------------------------
  // _emitShrinkSpark(state) — a tiny "struggle" spark above a shrunk kart, on a
  // throttle while shrinkTimer > 0, so the victim visibly fizzles while small.
  // ---------------------------------------------------------------------------
  _emitShrinkSpark(state) {
    const p = this._acquire();
    if (!p) return;
    this._resetParticle(p);
    p.active = true;
    p.mesh.visible = true;
    p.material.color.setHex(0x9ad0ff);
    p.material.opacity = 1;
    p.startOpacity = 1;
    p.vx = (Math.random() - 0.5) * 1.5;
    p.vy = 1.5 + Math.random();
    p.vz = (Math.random() - 0.5) * 1.5;
    p.gravity = 6;
    p.maxLife = 0.28;
    p.life = p.maxLife;
    p.startScale = 0.18;
    p.endScale = 0.02;
    p.mesh.scale.setScalar(p.startScale);
    p.mesh.position.set(
      state.x + (Math.random() - 0.5) * 0.4,
      (state.y || 0) + 0.4 + Math.random() * 0.3,
      state.z + (Math.random() - 0.5) * 0.4,
    );
  }

  // ---------------------------------------------------------------------------
  // _emitGhostFlicker(state) — a translucent ghostly wisp that drifts up off a
  // kart cloaked by Boo. Pale blue-white, soft, slow. Only emitted when the kart
  // exposes st.ghostTimer > 0 (optional field); otherwise this never runs.
  // ---------------------------------------------------------------------------
  _emitGhostFlicker(state) {
    const p = this._acquire();
    if (!p) return;
    this._resetParticle(p);
    p.active = true;
    p.mesh.visible = true;
    p.material.color.setHex(0xbfe0ff);
    p.material.opacity = 0.5;
    p.startOpacity = 0.5;
    p.vx = (Math.random() - 0.5) * 0.5;
    p.vy = 0.8 + Math.random() * 0.6;
    p.vz = (Math.random() - 0.5) * 0.5;
    p.gravity = -1; // float gently upward
    p.maxLife = 0.6 + Math.random() * 0.3;
    p.life = p.maxLife;
    p.startScale = 0.5 + Math.random() * 0.3;
    p.endScale = 1.1;
    p.mesh.scale.setScalar(p.startScale);
    p.mesh.position.set(
      state.x + (Math.random() - 0.5) * 0.8,
      (state.y || 0) + 0.6 + Math.random() * 0.5,
      state.z + (Math.random() - 0.5) * 0.8,
    );
  }

  // ---------------------------------------------------------------------------
  // _emitDriftSparks(state, tier) — a shower of sparks kicking out from UNDER a
  // drifting kart, colored by the mini-turbo tier (blue->orange->purple). Called
  // on a tight throttle while state.drifting && miniTurboTier >= 1, so it reads as
  // a continuous shower. Sparks spit out to the drift side + backward + up a touch,
  // then fall under gravity for a brief, bright skitter. `state` carries
  // {x,y,z,heading,driftDir}; the tier picks the color from DRIFT_TIER_COLORS.
  // ---------------------------------------------------------------------------
  _emitDriftSparks(state, tier) {
    const color = DRIFT_TIER_COLORS[tier] || DRIFT_TIER_COLORS[1];
    const fx = Math.sin(state.heading);
    const fz = Math.cos(state.heading);
    const backX = -fx;
    const backZ = -fz;
    // Sideways axis (back-vector rotated 90°); the spark fan leans toward the
    // OUTSIDE of the drift (opposite the lock direction) so it kicks off the wheel.
    const perpX = -backZ;
    const perpZ = backX;
    const dir = state.driftDir || (Math.random() < 0.5 ? -1 : 1);

    const count = 5; // dense per-puff so the shower reads continuous
    for (let i = 0; i < count; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);

      const side = dir * (0.3 + Math.random() * 0.9); // bias to the outboard side
      const back = 0.4 + Math.random() * 0.6;
      const speed = 4 + Math.random() * 5;

      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;
      // Spawn just behind + slightly outboard of the kart, near ground level.
      p.mesh.position.set(
        state.x + backX * back + perpX * side * 0.5,
        (state.y || 0) + 0.18 + Math.random() * 0.12,
        state.z + backZ * back + perpZ * side * 0.5,
      );
      // Skitter out sideways + backward + a small upward pop, then fall.
      p.vx = perpX * side * speed + backX * speed * 0.4;
      p.vy = 1.6 + Math.random() * 1.8;
      p.vz = perpZ * side * speed + backZ * speed * 0.4;
      p.gravity = 16; // pull the sparks back down fast = a tight skitter
      p.maxLife = 0.18 + Math.random() * 0.14;
      p.life = p.maxLife;
      p.startScale = 0.22 + Math.random() * 0.18;
      p.endScale = 0.04; // shrink to a pinpoint as it dies
      p.mesh.scale.setScalar(p.startScale);
    }
  }

  // ---------------------------------------------------------------------------
  // emitBoostRelease(state, tier) — a satisfying one-shot FLASH + flame burst when
  // a drift boost fires (rising edge of boostTimer). A bright tier-colored central
  // pop plus a fan of flames blasting out the back, so releasing a mini-turbo
  // FEELS explosive. `state` carries {x,y,z,heading}; tier tints the flash.
  // ---------------------------------------------------------------------------
  emitBoostRelease(state, tier) {
    const flashColor = DRIFT_TIER_COLORS[tier] || 0xfff0a0;
    const fx = Math.sin(state.heading);
    const fz = Math.cos(state.heading);
    const backX = -fx;
    const backZ = -fz;
    const perpX = -backZ;
    const perpZ = backX;

    // 1. A bright central FLASH ring at the tail that expands + fades fast.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(flashColor);
        p.material.opacity = 1;
        p.startOpacity = 1;
        p.maxLife = 0.32;
        p.life = p.maxLife;
        p.startScale = 0.7;
        p.endScale = 3.4; // bloom outward like a shockwave
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(
          state.x + backX * 0.6,
          (state.y || 0) + 0.5,
          state.z + backZ * 0.6,
        );
      }
    }
    // 2. A fan of hot flames blasting straight out the back.
    const flames = 14;
    for (let i = 0; i < flames; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const t = Math.random();
      const color = t < 0.4 ? 0xffffff : t < 0.75 ? 0xfff0a0 : 0xff8a1e;
      const side = (Math.random() - 0.5) * 1.6;
      const speed = 11 + Math.random() * 8;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.mesh.position.set(
        state.x + backX * 0.7,
        (state.y || 0) + 0.4 + Math.random() * 0.2,
        state.z + backZ * 0.7,
      );
      p.vx = backX * speed + perpX * side;
      p.vy = 0.8 + Math.random() * 1.4;
      p.vz = backZ * speed + perpZ * side;
      p.maxLife = 0.3 + Math.random() * 0.18;
      p.life = p.maxLife;
      p.startScale = 0.9 + Math.random() * 0.7;
      p.endScale = 0.08;
      p.mesh.scale.setScalar(p.startScale);
      p.roll = Math.random() * Math.PI;
    }
  }

  // ---------------------------------------------------------------------------
  // emitHitBurst(state) — a punchy radial IMPACT burst when a kart is hit (rising
  // edge of spinTimer). A bright white shockwave ring + a spray of debris sparks
  // exploding outward, so getting bonked lands with weight. Pairs with the orbiting
  // spin-stars (emitSpinStars) that follow. `state` carries {x,y,z}.
  // ---------------------------------------------------------------------------
  emitHitBurst(state) {
    // 1. A bright white shockwave ring.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(0xffffff);
        p.material.opacity = 1;
        p.startOpacity = 1;
        p.maxLife = 0.28;
        p.life = p.maxLife;
        p.startScale = 0.5;
        p.endScale = 4.0; // snap outward = an impact pop
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(state.x, (state.y || 0) + 0.9, state.z);
      }
    }
    // 2. A spray of debris sparks flying out in all directions, falling under
    // gravity so the hit feels physical, not just a flash.
    const sparks = 12;
    for (let i = 0; i < sparks; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = (i / sparks) * Math.PI * 2 + Math.random() * 0.4;
      const spd = 5 + Math.random() * 4;
      const t = Math.random();
      const color = t < 0.5 ? 0xfff0a0 : 0xff5a2a; // hot sparks
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.vx = Math.cos(ang) * spd;
      p.vy = 3 + Math.random() * 2.5;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 14;
      p.maxLife = 0.4 + Math.random() * 0.25;
      p.life = p.maxLife;
      p.startScale = 0.3 + Math.random() * 0.2;
      p.endScale = 0.04;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(state.x, (state.y || 0) + 0.8, state.z);
    }
  }

  // ---------------------------------------------------------------------------
  // _emitStarSparkle(state) — one rainbow twinkle orbiting a starred kart. The
  // sparkle is anchored to the kart STATE so it tracks a moving kart, circling at
  // a random radius/height with a rainbow hue cycle over its short life.
  // ---------------------------------------------------------------------------
  _emitStarSparkle(state) {
    const p = this._acquire();
    if (!p) return;
    this._resetParticle(p);

    p.active = true;
    p.mesh.visible = true;
    p.anchor = state; // orbit THIS kart (live state object; we read x/y/z each frame)
    p.orbitR = 0.9 + Math.random() * 0.7;
    p.orbitA = Math.random() * Math.PI * 2;
    p.orbitSpd = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3);
    p.orbitY = 0.4 + Math.random() * 1.2;
    p.rainbow = true;
    p.hue = Math.random();
    p.material.opacity = 1;
    p.startOpacity = 1;
    p.maxLife = 0.35 + Math.random() * 0.25;
    p.life = p.maxLife;
    p.startScale = 0.35 + Math.random() * 0.25;
    p.endScale = 0.05;
    p.mesh.scale.setScalar(p.startScale);
    // Position is computed from the anchor+orbit in update(); set a sane initial.
    p.mesh.position.set(state.x, (state.y || 0) + p.orbitY, state.z);
  }

  // ---------------------------------------------------------------------------
  // emitSpinStars(state) — a one-shot ring of little ⭐ stars orbiting a kart that
  // just got hit. Fired on the rising edge of spinTimer. The whole ring shares one
  // anchor (the kart state) so it follows the kart as it spins to a halt.
  // ---------------------------------------------------------------------------
  emitSpinStars(state) {
    const count = 7;
    const baseA = Math.random() * Math.PI * 2;
    const life = EFFECTS.VFX.SPIN_STARS_LIFE;
    for (let i = 0; i < count; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      p.active = true;
      p.mesh.visible = true;
      p.anchor = state;
      p.orbitR = 1.0;
      p.orbitA = baseA + (i / count) * Math.PI * 2; // evenly spaced ring
      p.orbitSpd = 6.5; // brisk spin so it reads as "dazed"
      p.orbitY = 1.5; // ring sits above the kart's roof
      p.material.color.setHex(0xffe14a); // bright cartoon star yellow
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.maxLife = life;
      p.life = life;
      p.startScale = 0.55;
      p.endScale = 0.45; // hold size; fade carries the disappearance
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(state.x, (state.y || 0) + p.orbitY, state.z);
    }
  }

  // ---------------------------------------------------------------------------
  // emitPickupFlash(state, color) — a quick expanding ring + bright pop where an
  // item was just collected. `color` (0xRRGGBB) tints it to the item if known.
  // ---------------------------------------------------------------------------
  emitPickupFlash(state, color) {
    const hex = color != null ? color : 0xffffff;
    const life = EFFECTS.VFX.PICKUP_FLASH_LIFE;
    // A bright central pop...
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(hex);
        p.material.opacity = 1;
        p.startOpacity = 1;
        p.maxLife = life;
        p.life = life;
        p.startScale = 0.6;
        p.endScale = 2.6; // expand outward like a flash ring
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(state.x, (state.y || 0) + 1.0, state.z);
      }
    }
    // ...plus a small burst of sparks flying up/out so the pickup feels juicy.
    const sparks = 8;
    for (let i = 0; i < sparks; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = (i / sparks) * Math.PI * 2;
      const spd = 3 + Math.random() * 2;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(hex);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.vx = Math.cos(ang) * spd;
      p.vy = 2.5 + Math.random() * 1.5;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 8;
      p.maxLife = life * 0.8;
      p.life = p.maxLife;
      p.startScale = 0.3;
      p.endScale = 0.05;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(state.x, (state.y || 0) + 0.8, state.z);
    }
  }

  // ===========================================================================
  // ONE-SHOT EVENT METHODS (called CENTRALLY by the integrator on item events).
  // All are pooled, billboard to the cached camera (this._camera, populated by
  // update()), and are no-op-safe if called before the first update().
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // itemUseBurst(itemId, state) — the flourish the INSTANT an item is used.
  // Switches on itemId to give each family its own signature pop. `state` carries
  // {x,y,z,heading}. Falls through to a small generic puff for unlisted items.
  // ---------------------------------------------------------------------------
  itemUseBurst(itemId, state) {
    if (!state) return;
    const x = state.x || 0;
    const y = state.y || 0;
    const z = state.z || 0;
    const heading = state.heading || 0;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);

    switch (itemId) {
      case 'mushroom':
      case 'tripleMushroom':
      case 'goldenMushroom': {
        // Forward flame POP: a fan of hot flames blasting out the FRONT as the
        // kart lurches forward on the speed surge.
        const flames = 16;
        for (let i = 0; i < flames; i++) {
          const p = this._acquire();
          if (!p) break;
          this._resetParticle(p);
          const t = Math.random();
          const color = t < 0.4 ? 0xffffff : t < 0.75 ? 0xfff0a0 : 0xff7a1e;
          const side = (Math.random() - 0.5) * 1.4;
          const perpX = -fz;
          const perpZ = fx;
          const speed = 9 + Math.random() * 7;
          p.active = true;
          p.mesh.visible = true;
          p.material.color.setHex(color);
          p.material.opacity = 1;
          p.startOpacity = 1;
          p.vx = fx * speed + perpX * side;
          p.vy = 0.7 + Math.random() * 1.2;
          p.vz = fz * speed + perpZ * side;
          p.maxLife = 0.28 + Math.random() * 0.14;
          p.life = p.maxLife;
          p.startScale = 0.8 + Math.random() * 0.6;
          p.endScale = 0.08;
          p.mesh.scale.setScalar(p.startScale);
          p.mesh.position.set(x + fx * 0.7, y + 0.4, z + fz * 0.7);
          p.roll = Math.random() * Math.PI;
        }
        break;
      }
      case 'superHorn': {
        // Big expanding TRANSLUCENT sonic shockwave ring (three concentric rings
        // for a thicker pulse) blasting outward from the kart.
        for (let r = 0; r < 3; r++) {
          const p = this._acquire();
          if (!p) break;
          this._resetParticle(p);
          p.active = true;
          p.mesh.visible = true;
          p.material.color.setHex(0x9af0ff);
          p.material.opacity = 0.7;
          p.startOpacity = 0.7;
          p.maxLife = 0.45 + r * 0.06;
          p.life = p.maxLife;
          p.startScale = 1.0 + r * 0.8;
          p.endScale = 9 + r * 2; // huge expanding pulse
          p.mesh.scale.setScalar(p.startScale);
          p.mesh.position.set(x, y + 0.9, z);
        }
        break;
      }
      case 'star': {
        // A burst of rainbow sparkles spraying up and out (separate from the
        // ongoing orbiting aura sparkles) to punctuate the moment of use.
        const n = 18;
        for (let i = 0; i < n; i++) {
          const p = this._acquire();
          if (!p) break;
          this._resetParticle(p);
          const ang = (i / n) * Math.PI * 2;
          const spd = 4 + Math.random() * 4;
          p.active = true;
          p.mesh.visible = true;
          p.rainbow = true;
          p.hue = Math.random();
          p.material.opacity = 1;
          p.startOpacity = 1;
          p.vx = Math.cos(ang) * spd;
          p.vy = 3 + Math.random() * 3;
          p.vz = Math.sin(ang) * spd;
          p.gravity = 6;
          p.maxLife = 0.5 + Math.random() * 0.3;
          p.life = p.maxLife;
          p.startScale = 0.35 + Math.random() * 0.2;
          p.endScale = 0.05;
          p.mesh.scale.setScalar(p.startScale);
          p.mesh.position.set(x, y + 0.9, z);
        }
        break;
      }
      case 'lightning':
        // Lightning's flourish is the screen-wide flash + bolt; delegate.
        this.lightningStrike(state);
        break;
      case 'bulletBill': {
        // Rocket launch SMOKE: a thick billow of grey puffs out the back as the
        // kart blasts off, plus a bright launch flash.
        {
          const p = this._acquire();
          if (p) {
            this._resetParticle(p);
            p.active = true;
            p.mesh.visible = true;
            p.material.color.setHex(0xfff4d0);
            p.material.opacity = 1;
            p.startOpacity = 1;
            p.maxLife = 0.3;
            p.life = p.maxLife;
            p.startScale = 1.0;
            p.endScale = 3.5;
            p.mesh.scale.setScalar(p.startScale);
            p.mesh.position.set(x - fx * 0.8, y + 0.5, z - fz * 0.8);
          }
        }
        const smoke = 14;
        for (let i = 0; i < smoke; i++) {
          const p = this._acquire();
          if (!p) break;
          this._resetParticle(p);
          const g = 0.5 + Math.random() * 0.3;
          const side = (Math.random() - 0.5) * 2;
          const perpX = -fz;
          const perpZ = fx;
          p.active = true;
          p.mesh.visible = true;
          p.material.color.setRGB(g, g, g);
          p.material.opacity = 0.8;
          p.startOpacity = 0.8;
          p.vx = -fx * (5 + Math.random() * 4) + perpX * side;
          p.vy = 0.6 + Math.random() * 1.0;
          p.vz = -fz * (5 + Math.random() * 4) + perpZ * side;
          p.gravity = -1;
          p.maxLife = 0.55 + Math.random() * 0.3;
          p.life = p.maxLife;
          p.startScale = 0.7;
          p.endScale = 2.4;
          p.mesh.scale.setScalar(p.startScale);
          p.mesh.position.set(x - fx * 0.8, y + 0.5, z - fz * 0.8);
        }
        break;
      }
      default: {
        // Generic small puff for shells/bananas/coin/etc. used directly.
        const n = 6;
        for (let i = 0; i < n; i++) {
          const p = this._acquire();
          if (!p) break;
          this._resetParticle(p);
          const ang = (i / n) * Math.PI * 2;
          const spd = 2 + Math.random() * 2;
          p.active = true;
          p.mesh.visible = true;
          p.material.color.setHex(0xffffff);
          p.material.opacity = 0.9;
          p.startOpacity = 0.9;
          p.vx = Math.cos(ang) * spd;
          p.vy = 1.5 + Math.random();
          p.vz = Math.sin(ang) * spd;
          p.gravity = 5;
          p.maxLife = 0.3;
          p.life = p.maxLife;
          p.startScale = 0.35;
          p.endScale = 0.05;
          p.mesh.scale.setScalar(p.startScale);
          p.mesh.position.set(x, y + 0.6, z);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // explosion(pos) — bob-omb: a big expanding fireball flash + shockwave ring +
  // billowing smoke + a few flung debris bits. pos = {x,y,z}.
  // ---------------------------------------------------------------------------
  explosion(pos) {
    if (!pos) return;
    const x = pos.x || 0;
    const y = pos.y || 0;
    const z = pos.z || 0;

    // 1. A blinding white-hot core flash.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(0xffffff);
        p.material.opacity = 1;
        p.startOpacity = 1;
        p.maxLife = 0.22;
        p.life = p.maxLife;
        p.startScale = 2.5;
        p.endScale = 5.5;
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(x, y + 1.0, z);
      }
    }
    // 2. An orange shockwave ring snapping outward.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(0xff7a1e);
        p.material.opacity = 0.9;
        p.startOpacity = 0.9;
        p.maxLife = 0.4;
        p.life = p.maxLife;
        p.startScale = 1.0;
        p.endScale = 8.0;
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(x, y + 0.9, z);
      }
    }
    // 3. A fireball of hot flame chunks billowing up + out.
    const fire = 20;
    for (let i = 0; i < fire; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = Math.random() * Math.PI * 2;
      const spd = 4 + Math.random() * 6;
      const t = Math.random();
      const color = t < 0.4 ? 0xfff0a0 : t < 0.75 ? 0xff7a1e : 0xff3010;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.vx = Math.cos(ang) * spd;
      p.vy = 2 + Math.random() * 5;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 5;
      p.maxLife = 0.4 + Math.random() * 0.3;
      p.life = p.maxLife;
      p.startScale = 1.0 + Math.random() * 0.8;
      p.endScale = 0.2;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(x, y + 0.8, z);
    }
    // 4. Lingering smoke billows.
    const smoke = 10;
    for (let i = 0; i < smoke; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = Math.random() * Math.PI * 2;
      const spd = 1.5 + Math.random() * 2.5;
      const g = 0.25 + Math.random() * 0.2;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setRGB(g, g, g);
      p.material.opacity = 0.7;
      p.startOpacity = 0.7;
      p.vx = Math.cos(ang) * spd;
      p.vy = 1.5 + Math.random() * 2;
      p.vz = Math.sin(ang) * spd;
      p.gravity = -1.5;
      p.maxLife = 0.7 + Math.random() * 0.4;
      p.life = p.maxLife;
      p.startScale = 0.8;
      p.endScale = 3.0;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(x, y + 0.7, z);
    }
    // 5. A few bright debris bits flung on arcs.
    const debris = 6;
    for (let i = 0; i < debris; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = Math.random() * Math.PI * 2;
      const spd = 6 + Math.random() * 5;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(0xffcf6a);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.vx = Math.cos(ang) * spd;
      p.vy = 5 + Math.random() * 4;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 18;
      p.spin = (Math.random() - 0.5) * 14;
      p.maxLife = 0.6 + Math.random() * 0.3;
      p.life = p.maxLife;
      p.startScale = 0.3;
      p.endScale = 0.1;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(x, y + 0.9, z);
    }
  }

  // ---------------------------------------------------------------------------
  // impactSpark(pos, color) — a sharp spark burst where a shell / blue-shell HITS.
  // pos = {x,y,z}; color is a hex number (0xRRGGBB) tinting the sparks.
  // ---------------------------------------------------------------------------
  impactSpark(pos, color) {
    if (!pos) return;
    const x = pos.x || 0;
    const y = pos.y || 0;
    const z = pos.z || 0;
    const hex = color != null ? color : 0xffffff;
    // A quick bright flash core.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(hex);
        p.material.opacity = 1;
        p.startOpacity = 1;
        p.maxLife = 0.18;
        p.life = p.maxLife;
        p.startScale = 0.6;
        p.endScale = 2.4;
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(x, y + 0.7, z);
      }
    }
    // A tight radial spray of sparks.
    const n = 14;
    for (let i = 0; i < n; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const spd = 5 + Math.random() * 5;
      p.active = true;
      p.mesh.visible = true;
      // Mix the tint with a hot white-yellow for spark variety.
      p.material.color.setHex(Math.random() < 0.4 ? 0xffffff : hex);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.vx = Math.cos(ang) * spd;
      p.vy = 2 + Math.random() * 3;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 16;
      p.maxLife = 0.3 + Math.random() * 0.2;
      p.life = p.maxLife;
      p.startScale = 0.3;
      p.endScale = 0.03;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(x, y + 0.7, z);
    }
  }

  // ---------------------------------------------------------------------------
  // lightningStrike(state) — a bright bolt descending onto the user plus the
  // screen-wide flash. `state` carries {x,y,z}. The bolt is a stack of stretched
  // additive segments dropping from above onto the target; pairs with the flash.
  // ---------------------------------------------------------------------------
  lightningStrike(state) {
    if (!state) return;
    const x = state.x || 0;
    const y = state.y || 0;
    const z = state.z || 0;

    // The screen whiteout flash.
    this.lightningFlash();

    // A vertical bolt: a column of tall, jagged-offset bright segments from high
    // above down onto the target. They fade fast for a snappy strike.
    const segs = 8;
    for (let i = 0; i < segs; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(i % 2 === 0 ? 0xffffff : 0xbfe0ff);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.maxLife = 0.18 + Math.random() * 0.08;
      p.life = p.maxLife;
      // Tall thin segment: keep the non-uniform scale we set below by flagging
      // customScale so the step loop won't overwrite it with setScalar.
      p.customScale = true;
      p.startScale = 1;
      p.endScale = 1;
      const jitterX = (Math.random() - 0.5) * 0.6;
      const jitterZ = (Math.random() - 0.5) * 0.6;
      p.mesh.position.set(x + jitterX, y + 1.2 + i * 1.4, z + jitterZ);
      p.mesh.scale.set(0.5, 1.6, 1); // thin, tall bolt segment
    }
    // A bright ground burst where the bolt lands.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(0xffffff);
        p.material.opacity = 1;
        p.startOpacity = 1;
        p.maxLife = 0.25;
        p.life = p.maxLife;
        p.startScale = 0.8;
        p.endScale = 4.5;
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(x, y + 0.4, z);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // lightningFlash() — a brief full-screen white/blue whiteout. Implemented as the
  // pre-built additive quad (added to the scene in the constructor) which
  // _stepFlash repositions in front of the live camera each frame and fades over
  // ~0.25s. No-op-safe: if no camera has been seen yet, it silently does nothing
  // (the quad would have nowhere to sit, so we skip rather than flash at origin).
  // ---------------------------------------------------------------------------
  lightningFlash() {
    if (!this._camera) return; // no camera cached yet — nothing to anchor to
    // Place the quad in front of the camera immediately so the very first frame of
    // the flash is already positioned (don't wait for _stepFlash next frame).
    this._flashPos.set(0, 0, -1).applyQuaternion(this._camera.quaternion).add(this._camera.position);
    this._flashQuad.position.copy(this._flashPos);
    this._flashQuad.quaternion.copy(this._camera.quaternion);
    this._flashQuad.visible = true;
    this._flashLife = this._flashMaxLife;
    this._flashMat.opacity = 0; // _stepFlash ramps it up from 0
  }

  // ---------------------------------------------------------------------------
  // bananaDrop(pos) — a small slip/poof when a banana is dropped. pos = {x,y,z}.
  // ---------------------------------------------------------------------------
  bananaDrop(pos) {
    if (!pos) return;
    const x = pos.x || 0;
    const y = pos.y || 0;
    const z = pos.z || 0;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = (i / n) * Math.PI * 2;
      const spd = 1.5 + Math.random() * 1.5;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(0xffe14a); // banana yellow
      p.material.opacity = 0.9;
      p.startOpacity = 0.9;
      p.vx = Math.cos(ang) * spd;
      p.vy = 1.2 + Math.random() * 0.8;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 8;
      p.maxLife = 0.3 + Math.random() * 0.15;
      p.life = p.maxLife;
      p.startScale = 0.3;
      p.endScale = 0.6; // little dust puff expanding
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(x, y + 0.3, z);
    }
  }

  // ---------------------------------------------------------------------------
  // blueShellTarget(pos) — a hovering target reticle marker over a doomed kart's
  // current spot. Leases one reticle from the small pool; it bobs + pulses until
  // blueShellImpact() clears it (or a generous safety timeout). pos = {x,y,z}.
  // ---------------------------------------------------------------------------
  blueShellTarget(pos) {
    if (!pos) return;
    // Reuse an already-active reticle near this spot, else lease a free one.
    let r = null;
    for (let i = 0; i < this._reticles.length; i++) {
      if (!this._reticles[i].active) {
        r = this._reticles[i];
        break;
      }
    }
    if (!r) return;
    r.active = true;
    r.t = 0;
    r.life = 8; // safety timeout; normally cleared by blueShellImpact
    r.x = pos.x || 0;
    r.y = pos.y || 0;
    r.z = pos.z || 0;
    r.mesh.visible = true;
    r.material.color.setHex(0x3aa0ff);
    r.material.opacity = 0.7;
    r.mesh.scale.setScalar(1.4);
    r.mesh.position.set(r.x, r.y + 2.4, r.z);
  }

  // ---------------------------------------------------------------------------
  // blueShellImpact(pos) — the big blue impact explosion where the spiny shell
  // lands. Clears any hovering reticle, then a large blue fireball + shockwave +
  // electric sparks. pos = {x,y,z}.
  // ---------------------------------------------------------------------------
  blueShellImpact(pos) {
    if (!pos) return;
    const x = pos.x || 0;
    const y = pos.y || 0;
    const z = pos.z || 0;
    // Clear any reticle (whichever is closest in XZ to this impact).
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < this._reticles.length; i++) {
      const r = this._reticles[i];
      if (!r.active) continue;
      const d = (r.x - x) * (r.x - x) + (r.z - z) * (r.z - z);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    if (best) {
      best.active = false;
      best.mesh.visible = false;
    }

    // 1. A blue-white core flash.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(0xeaf6ff);
        p.material.opacity = 1;
        p.startOpacity = 1;
        p.maxLife = 0.24;
        p.life = p.maxLife;
        p.startScale = 2.2;
        p.endScale = 5.5;
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(x, y + 1.0, z);
      }
    }
    // 2. A big blue shockwave ring.
    {
      const p = this._acquire();
      if (p) {
        this._resetParticle(p);
        p.active = true;
        p.mesh.visible = true;
        p.material.color.setHex(0x3aa0ff);
        p.material.opacity = 0.9;
        p.startOpacity = 0.9;
        p.maxLife = 0.45;
        p.life = p.maxLife;
        p.startScale = 1.0;
        p.endScale = 9.0;
        p.mesh.scale.setScalar(p.startScale);
        p.mesh.position.set(x, y + 0.9, z);
      }
    }
    // 3. A burst of electric-blue flame chunks + sparks.
    const n = 22;
    for (let i = 0; i < n; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = Math.random() * Math.PI * 2;
      const spd = 4 + Math.random() * 6;
      const t = Math.random();
      const color = t < 0.4 ? 0xffffff : t < 0.75 ? 0x6ec8ff : 0x2a6cff;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.vx = Math.cos(ang) * spd;
      p.vy = 2 + Math.random() * 5;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 8;
      p.maxLife = 0.4 + Math.random() * 0.3;
      p.life = p.maxLife;
      p.startScale = 0.7 + Math.random() * 0.6;
      p.endScale = 0.1;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(x, y + 0.8, z);
    }
  }

  // ---------------------------------------------------------------------------
  // coinSparkle(state) — a small gold sparkle on coin grab/use. `state` carries
  // {x,y,z}. A few twinkling gold bits popping up and fading.
  // ---------------------------------------------------------------------------
  coinSparkle(state) {
    if (!state) return;
    const x = state.x || 0;
    const y = state.y || 0;
    const z = state.z || 0;
    const n = 8;
    for (let i = 0; i < n; i++) {
      const p = this._acquire();
      if (!p) break;
      this._resetParticle(p);
      const ang = (i / n) * Math.PI * 2;
      const spd = 1.5 + Math.random() * 2;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(Math.random() < 0.5 ? 0xffd84a : 0xfff0a0);
      p.material.opacity = 1;
      p.startOpacity = 1;
      p.vx = Math.cos(ang) * spd;
      p.vy = 2.5 + Math.random() * 1.5;
      p.vz = Math.sin(ang) * spd;
      p.gravity = 7;
      p.spin = (Math.random() - 0.5) * 10;
      p.maxLife = 0.4 + Math.random() * 0.2;
      p.life = p.maxLife;
      p.startScale = 0.28;
      p.endScale = 0.04;
      p.mesh.scale.setScalar(p.startScale);
      p.mesh.position.set(
        x + (Math.random() - 0.5) * 0.4,
        y + 0.8 + Math.random() * 0.4,
        z + (Math.random() - 0.5) * 0.4,
      );
    }
  }

  // ===========================================================================
  // STAR AURA leasing
  // ===========================================================================

  // _auraFor(kartId) returns the aura record leased to this kart, leasing a free
  // one on first request. Returns null if the (small) aura pool is exhausted.
  _auraFor(kartId) {
    const idx = this._auraByKart.get(kartId);
    if (idx != null) return this._auras[idx];
    for (let i = 0; i < this._auras.length; i++) {
      if (this._auras[i].ownerId == null) {
        this._auras[i].ownerId = kartId;
        this._auraByKart.set(kartId, i);
        return this._auras[i];
      }
    }
    return null;
  }

  // _releaseAura(kartId) frees the kart's leased aura (star expired / kart gone),
  // hiding the sprite and returning it to the pool for another kart to use.
  _releaseAura(kartId) {
    const idx = this._auraByKart.get(kartId);
    if (idx == null) return;
    const a = this._auras[idx];
    a.ownerId = null;
    a.material.opacity = 0;
    a.mesh.visible = false;
    this._auraByKart.delete(kartId);
  }

  // ===========================================================================
  // SPEED-LINES (player boost) — GSAP-driven DOM fade.
  // ===========================================================================

  // _setSpeedLines(on) fades the radial speed-line overlay in (on=true) or out.
  // GSAP retargets the same tween so toggling rapidly doesn't stack animations.
  _setSpeedLines(on) {
    if (on === this._speedLinesShown) return; // already in the target state
    this._speedLinesShown = on;
    if (this._speedLinesTween) this._speedLinesTween.kill();
    this._speedLinesTween = gsap.to(this._speedLines, {
      opacity: on ? 0.5 : 0,
      duration: on ? 0.18 : 0.35, // snap in, ease out
      ease: on ? 'power2.out' : 'power2.in',
    });
  }

  // hitFlash() snaps the red damage vignette in hard then fades it out — a short,
  // satisfying thump of red, NOT a lingering wash. Called by main.js ONLY on a
  // real player spin-out hit (the same rising edge that fires the hit SFX), so it
  // never flashes on smooth driving. Retargets one timeline so back-to-back hits
  // re-punch instead of stacking.
  hitFlash() {
    if (this._hitFlashTween) this._hitFlashTween.kill();
    gsap.set(this._hitFlash, { opacity: 0 });
    this._hitFlashTween = gsap.timeline()
      .to(this._hitFlash, { opacity: 1, duration: 0.06, ease: 'power2.out' })
      .to(this._hitFlash, { opacity: 0, duration: 0.34, ease: 'power2.in' });
  }

  // ===========================================================================
  // PER-FRAME UPDATE
  // ===========================================================================
  /**
   * Advance every active effect by dt and (re)emit the continuous ones. Call once
   * per render frame from main.js, AFTER the active manager has positioned its
   * karts this frame (so we read fresh positions).
   *
   * @param {number} dt  seconds since last frame (the fixed sim step is fine).
   * @param {object} ctx
   *   @param {THREE.Camera} ctx.camera        camera for billboarding (required).
   *   @param {Array} [ctx.karts]              manager.getKarts() records:
   *                                           { id, state:{x,y,z,heading,
   *                                             boostTimer,starTimer,spinTimer} }.
   *   @param {object} [ctx.playerState]       the player's kart state (for the
   *                                           speed-lines + pickup-flash anchor).
   *   @param {string} [ctx.playerItemId]      the player's held item id ('' none).
   *   @param {number} [ctx.playerItemColor]   tint for the pickup flash (optional).
   */
  update(dt, ctx = {}) {
    if (!dt || dt <= 0) return;
    const camera = ctx.camera || null;
    if (camera) this._camera = camera; // cache for one-shot event methods
    const karts = ctx.karts || null;

    // --- 1. PER-KART continuous + edge effects -----------------------------
    // Track which kart ids we saw this frame so we can free auras for karts that
    // either lost their star or left the field, without allocating a Set per frame
    // (we reuse the _auraByKart map and reconcile against the live karts below).
    if (karts && karts.length) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const st = k && k.state;
        if (!st) continue;
        const id = k.id;

        // BOOST exhaust trail: throttle puffs by an accumulator so the trail is
        // framerate-independent and pool-friendly.
        const boost = st.boostTimer || 0;
        if (boost > 0) {
          const acc = (this._boostAccum.get(id) || 0) + dt;
          if (acc >= EFFECTS.VFX.BOOST_TRAIL_INTERVAL) {
            this._emitBoostPuff(st);
            this._boostAccum.set(id, 0);
          } else {
            this._boostAccum.set(id, acc);
          }
          // Ground SCORCH streak on its own slightly-slower throttle, so a boosting
          // kart leaves a glowing burnt trail on the floor under the flame jet.
          const sacc = (this._scorchAccum.get(id) || 0) + dt;
          if (sacc >= 0.045) {
            this._emitScorch(st);
            this._scorchAccum.set(id, 0);
          } else {
            this._scorchAccum.set(id, sacc);
          }
        } else if (this._boostAccum.get(id)) {
          this._boostAccum.set(id, 0);
          this._scorchAccum.set(id, 0);
        }

        // DRIFT SPARKS: while a kart is drifting AND has charged a mini-turbo tier
        // (miniTurboTier >= 1), shower tier-colored sparks from under it on a tight
        // throttle. The tier picks the color: blue (1) -> orange (2) -> purple (3),
        // so the building charge reads at a glance. Below tier 1 (no charge banked
        // yet) we emit nothing — the sparks ONLY appear once a boost is earning.
        const tier = st.miniTurboTier || 0;
        if (st.drifting && tier >= 1) {
          // Remember the peak tier this drift so the release flash can be colored
          // by it (the model zeroes the tier the instant the boost arms).
          const peak = this._driftPeakTier.get(id) || 0;
          if (tier > peak) this._driftPeakTier.set(id, tier);
          const dacc = (this._driftAccum.get(id) || 0) + dt;
          if (dacc >= DRIFT_SPARK_INTERVAL) {
            this._emitDriftSparks(st, tier);
            this._driftAccum.set(id, 0);
          } else {
            this._driftAccum.set(id, dacc);
          }
        } else if (this._driftAccum.get(id)) {
          this._driftAccum.set(id, 0);
        }

        // BOOST RELEASE: fire a satisfying flash + flame burst on the RISING edge
        // of boostTimer (a fresh mini-turbo just released). Color it by the PEAK
        // tier reached during the drift (stashed above) since the live tier is 0 by
        // now. Comparing against last frame's boost so HOLDING a boost doesn't
        // re-fire — only the launch instant pops.
        const kBoost = st.boostTimer || 0;
        const kPrevBoost = this._prevBoost.get(id) || 0;
        if (kBoost > kPrevBoost + 1e-3 && kPrevBoost <= 1e-3) {
          const peakTier = this._driftPeakTier.get(id) || 1;
          this.emitBoostRelease(st, peakTier >= 1 ? peakTier : 1);
          this._driftPeakTier.set(id, 0); // consumed — reset for the next drift
        }
        this._prevBoost.set(id, kBoost);

        // STAR aura + sparkles: lease an aura sprite while starTimer > 0; emit
        // rainbow sparkles on a throttle. Release the aura the moment it expires.
        const star = st.starTimer || 0;
        if (star > 0) {
          const aura = this._auraFor(id);
          if (aura) {
            aura.mesh.visible = true;
            // Cycle the aura hue over time for the rainbow shimmer. We advance the
            // stored hue (no allocation) and write it via the scratch colour.
            aura.hue = (aura.hue + dt * 0.8) % 1;
            this._tmpColor.setHSL(aura.hue, 1, 0.6);
            aura.material.color.copy(this._tmpColor);
            // Soft pulsing opacity so the glow breathes; fade out in the last
            // 0.6s of the star so it doesn't pop off.
            const fade = star < 0.6 ? star / 0.6 : 1;
            aura.material.opacity = (0.5 + 0.2 * Math.sin(aura.hue * Math.PI * 4)) * fade;
            aura.mesh.position.set(st.x, (st.y || 0) + 0.9, st.z);
            if (camera) aura.mesh.quaternion.copy(camera.quaternion);
          }
          const acc = (this._sparkleAccum.get(id) || 0) + dt;
          if (acc >= EFFECTS.VFX.STAR_SPARKLE_INTERVAL) {
            this._emitStarSparkle(st);
            this._sparkleAccum.set(id, 0);
          } else {
            this._sparkleAccum.set(id, acc);
          }
        } else if (this._auraByKart.has(id)) {
          this._releaseAura(id); // star ended this frame -> free the sprite
        }

        // HIT JUICE: one-shot on the rising edge of spinTimer (~0 -> >0). We fire a
        // punchy impact burst (shockwave ring + debris sparks) AND the orbiting
        // spin-stars, so getting bonked reads as a real, weighty hit.
        const spin = st.spinTimer || 0;
        const prevSpin = this._prevSpin.get(id) || 0;
        if (spin > 0.05 && prevSpin <= 0.05) {
          this.emitHitBurst(st);
          this.emitSpinStars(st);
        }
        this._prevSpin.set(id, spin);

        // SHRINK (lightning victim): one-shot squish poof on the rising edge of
        // shrinkTimer, then a steady fizzle of struggle sparks while shrunk so the
        // victim visibly suffers. Reads as "zapped + small".
        const shrink = st.shrinkTimer || 0;
        const prevShrink = this._prevShrink.get(id) || 0;
        if (shrink > 0.05 && prevShrink <= 0.05) {
          this._emitShrinkPoof(st);
        }
        if (shrink > 0) {
          const acc = (this._shrinkAccum.get(id) || 0) + dt;
          if (acc >= 0.09) {
            this._emitShrinkSpark(st);
            this._shrinkAccum.set(id, 0);
          } else {
            this._shrinkAccum.set(id, acc);
          }
        } else if (this._shrinkAccum.get(id)) {
          this._shrinkAccum.set(id, 0);
        }
        this._prevShrink.set(id, shrink);

        // BOO ghost flicker: ONLY if the kart exposes an optional st.ghostTimer.
        // While cloaked, drift up translucent wisps on a slow throttle. If the
        // field is absent the whole effect is skipped (no wiring required).
        const ghost = st.ghostTimer || 0;
        if (ghost > 0) {
          const acc = (this._ghostAccum.get(id) || 0) + dt;
          if (acc >= 0.12) {
            this._emitGhostFlicker(st);
            this._ghostAccum.set(id, 0);
          } else {
            this._ghostAccum.set(id, acc);
          }
        } else if (this._ghostAccum.get(id)) {
          this._ghostAccum.set(id, 0);
        }
      }

      // Reconcile auras: free any aura whose owner kart is no longer in the field
      // (e.g. mode teardown didn't call reset). Cheap — pool is tiny (8).
      for (let i = 0; i < this._auras.length; i++) {
        const a = this._auras[i];
        if (a.ownerId == null) continue;
        let stillHere = false;
        for (let j = 0; j < karts.length; j++) {
          if (karts[j].id === a.ownerId) {
            stillHere = true;
            break;
          }
        }
        if (!stillHere) this._releaseAura(a.ownerId);
      }
    }

    // --- 2. PLAYER speed-lines (boost-only screen overlay) -----------------
    const ps = ctx.playerState || null;
    this._setSpeedLines(!!(ps && (ps.boostTimer || 0) > 0));

    // --- 3. PLAYER pickup flash (held item appeared / changed) -------------
    const item = ctx.playerItemId != null ? ctx.playerItemId : '';
    if (ps && item && item !== this._prevPlayerItem) {
      this.emitPickupFlash(ps, ctx.playerItemColor);
    }
    this._prevPlayerItem = item;

    // --- 4. Advance every awake particle -----------------------------------
    this._stepParticles(dt, camera);

    // --- 5. Advance the screen flash quad + hovering blue-shell reticles ----
    this._stepFlash(dt);
    this._stepReticles(dt, camera);
  }

  // _stepFlash(dt) fades the active lightning/screen flash quad, repositions it
  // just in front of the live camera (so it fills the view), and hides it when
  // done. No-op when idle. Uses the cached camera + a scratch vector — no alloc.
  _stepFlash(dt) {
    if (this._flashLife <= 0) return;
    this._flashLife -= dt;
    if (this._flashLife <= 0) {
      this._flashMat.opacity = 0;
      this._flashQuad.visible = false;
      return;
    }
    const cam = this._camera;
    if (cam) {
      // Place the quad ~1m in front of the camera along its forward axis and face
      // it back at the camera, so it always blankets the screen wherever we look.
      this._flashPos.set(0, 0, -1).applyQuaternion(cam.quaternion).add(cam.position);
      this._flashQuad.position.copy(this._flashPos);
      this._flashQuad.quaternion.copy(cam.quaternion);
    }
    // Punchy attack, smooth decay: ramp up over the first 20% then ease out.
    const frac = this._flashLife / this._flashMaxLife; // 1 -> 0
    const peak = 0.92;
    this._flashMat.opacity = frac > 0.8 ? peak * ((1 - frac) / 0.2) : peak * (frac / 0.8);
  }

  // _stepReticles(dt, camera) bobs + pulses each active blue-shell target marker
  // and billboards it to the camera. Reticles persist until blueShellImpact()
  // clears them or their (generous) life times out as a safety net.
  _stepReticles(dt, camera) {
    for (let i = 0; i < this._reticles.length; i++) {
      const r = this._reticles[i];
      if (!r.active) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      r.t += dt;
      const bob = Math.sin(r.t * 5) * 0.25;
      const pulse = 1.4 + Math.sin(r.t * 9) * 0.35; // throbbing reticle
      r.mesh.position.set(r.x, r.y + 2.4 + bob, r.z);
      r.mesh.scale.setScalar(pulse);
      r.material.opacity = 0.55 + 0.25 * Math.sin(r.t * 9);
      if (camera) r.mesh.quaternion.copy(camera.quaternion);
    }
  }

  // _stepParticles(dt, camera) integrates and ages every awake particle: ballistic
  // ones move by velocity+gravity; orbiting ones circle their live anchor. All
  // fade + scale over their lifetime and billboard to the camera, then sleep.
  _stepParticles(dt, camera) {
    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        p.anchor = null; // drop the anchor ref so a torn-down state can be GC'd
        continue;
      }

      if (p.orbitR > 0 && p.anchor) {
        // ORBIT: circle the anchor kart. Reading the live anchor each frame means
        // the ring/sparkle follows a moving kart for free. No allocation.
        p.orbitA += p.orbitSpd * dt;
        const ax = p.anchor.x || 0;
        const ay = p.anchor.y || 0;
        const az = p.anchor.z || 0;
        p.mesh.position.set(
          ax + Math.cos(p.orbitA) * p.orbitR,
          ay + p.orbitY,
          az + Math.sin(p.orbitA) * p.orbitR,
        );
      } else {
        // BALLISTIC: velocity + gravity integration (gravity pulls vy down).
        p.vy -= p.gravity * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
      }

      const lifeFraction = p.life / p.maxLife; // 1 -> 0 over the lifetime
      const age = 1 - lifeFraction;

      if (!p.customScale) {
        const scale = p.startScale + (p.endScale - p.startScale) * age;
        p.mesh.scale.setScalar(scale);
      }
      p.material.opacity = lifeFraction * p.startOpacity;

      // Rainbow hue cycle for star sparkles: advance hue over the lifetime.
      if (p.rainbow) {
        p.hue = (p.hue + dt * 1.5) % 1;
        this._tmpColor.setHSL(p.hue, 1, 0.65);
        p.material.color.copy(this._tmpColor);
      }

      if (p.spin) p.roll += p.spin * dt;

      if (p.flat) {
        // FLAT (ground scorch): keep the fixed floor-facing rotation set at emit;
        // do NOT billboard or it would lift off the ground and face the camera.
      } else if (camera) {
        // Billboard so flat planes always face the camera (never edge-on/invisible),
        // then re-apply the per-particle roll on top of the camera orientation.
        p.mesh.quaternion.copy(camera.quaternion);
        if (p.roll) p.mesh.rotateZ(p.roll);
      } else if (p.roll) {
        p.mesh.rotation.z = p.roll;
      }
    }
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  // reset() sleeps every particle + aura and clears edge-detection state. Call on
  // a mode teardown / race restart so effects from the previous race don't linger
  // (and so anchor references to old kart states are dropped for GC).
  reset() {
    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      p.active = false;
      p.mesh.visible = false;
      p.anchor = null;
    }
    for (let i = 0; i < this._auras.length; i++) {
      const a = this._auras[i];
      a.ownerId = null;
      a.material.opacity = 0;
      a.mesh.visible = false;
    }
    this._auraByKart.clear();
    this._prevSpin.clear();
    this._boostAccum.clear();
    this._sparkleAccum.clear();
    this._driftAccum.clear();
    this._prevBoost.clear();
    this._driftPeakTier.clear();
    this._prevShrink.clear();
    this._shrinkAccum.clear();
    this._scorchAccum.clear();
    this._ghostAccum.clear();
    this._prevPlayerItem = null;
    this._setSpeedLines(false);
    // Clear any in-flight red hit flash so it doesn't linger into the next race.
    if (this._hitFlashTween) { this._hitFlashTween.kill(); this._hitFlashTween = null; }
    if (this._hitFlash) this._hitFlash.style.opacity = '0';
    // Sleep the screen flash + every hovering reticle.
    this._flashLife = 0;
    this._flashMat.opacity = 0;
    this._flashQuad.visible = false;
    for (let i = 0; i < this._reticles.length; i++) {
      const r = this._reticles[i];
      r.active = false;
      r.mesh.visible = false;
      r.material.opacity = 0;
    }
  }

  // dispose() frees GPU resources + removes the DOM overlay. Call when the page /
  // game is torn down (the game keeps ONE ItemVFX for its lifetime, like VFX, so
  // this is mostly for completeness / tests).
  dispose() {
    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      this.scene.remove(p.mesh);
      p.material.dispose();
    }
    for (let i = 0; i < this._auras.length; i++) {
      const a = this._auras[i];
      this.scene.remove(a.mesh);
      a.material.dispose();
    }
    for (let i = 0; i < this._reticles.length; i++) {
      const r = this._reticles[i];
      this.scene.remove(r.mesh);
      r.material.dispose();
    }
    // Flash quad: remove from the scene + free its own geometry/material.
    this.scene.remove(this._flashQuad);
    this._flashQuad.geometry.dispose();
    this._flashMat.dispose();
    this._geometry.dispose();
    this._particles.length = 0;
    this._auras.length = 0;
    this._reticles.length = 0;
    if (this._speedLinesTween) this._speedLinesTween.kill();
    if (this._speedLines && this._speedLines.parentNode) {
      this._speedLines.parentNode.removeChild(this._speedLines);
    }
    if (this._hitFlashTween) this._hitFlashTween.kill();
    if (this._hitFlash && this._hitFlash.parentNode) {
      this._hitFlash.parentNode.removeChild(this._hitFlash);
    }
  }
}
