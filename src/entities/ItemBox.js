// src/entities/ItemBox.js
//
// The world-side item boxes: the glowing "?" cubes you drive through to roll a
// random item. This file owns ONLY the world objects (Three.js meshes) and the
// pickup detection. It does NOT decide which item you get — that is the items
// manager's job. update() simply reports "racer R touched box B" and the caller
// awards the item.
//
// Design rules (must hold with 13 karts on screen at 60fps):
//   - OBJECT POOLING: every box mesh is created ONCE in the constructor and then
//     reused forever. We only ever toggle .visible and rotate them; we NEVER
//     create/destroy geometry, materials, or meshes per frame. That keeps the
//     garbage collector quiet (no per-frame allocation -> no stutter).
//   - Cheap detection: a flat squared-distance check (no sqrt) per box per kart.
//     A handful of boxes * 13 karts is a tiny number of comparisons.
//
// Conventions (match the rest of the project):
//   - Y is up; the track lies in the XZ plane; world units = meters.
//   - track.checkpoints is an ordered centerline; track.roadWidth is the band
//     width; track.isOnRoad(x,z) tests the drivable surface.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
// QUALITY TIER: scales how strongly the box's PBR shell/core sample the environment
// reflection (0 LOW = none, 1.0 MED = today, glossier on HIGH/ULTRA). Read once.
import qualitySettings from '../core/QualitySettings.js';

// --- Tuning (local to item boxes; not gameplay physics, so it lives here) ----
const BOX_SIZE = 2.2;          // m  edge length of each item-box cube (BIG so it reads from afar)
const BOX_Y = 1.3;             // m  height of the box center above the road
const SPIN_SPEED = 1.8;        // rad/s  how fast the boxes idly rotate
const PICKUP_RADIUS = 2.6;     // m  grabs the box — matches RING_RADIUS (the glowing ground
                               //     marker you drive through); also box half-extent 1.1m +
                               //     kart half-width ~0.9m + a small grab margin.
const RESPAWN_TIME = 3.0;      // s  how long a grabbed box stays hidden (default; opts.respawnTime overrides)
// --- "read me as a drive-through pickup" cues (all cosmetic) -----------------
const BOB_AMPLITUDE = 0.28;    // m  how far the box gently floats up/down
const BOB_SPEED = 2.2;         // rad/s  speed of the up/down bob
const RING_RADIUS = 2.6;       // m  radius of the glowing ground marker beneath a box
const POP_TIME = 0.32;         // s  duration of the pickup pop/flash before the box hides
const POP_SCALE = 1.9;         // x  how big the box swells during the pop before fading
// How many ROWS of boxes to scatter around the loop. The Phase-3 spline courses
// are ~10x longer (30+ checkpoints), so a fixed [2,5,8,11,14] list would clump
// every box in the first third. Instead we space NUM_BOX_ROWS rows EVENLY by
// checkpoint index across the WHOLE loop (see _rowCheckpoints), so boxes appear
// regularly the entire lap. (On the old short tracks this still yields a sane
// spread.)
const NUM_BOX_ROWS = 7;
const BOXES_PER_ROW = 4;       // boxes spread across the road width in each row

/**
 * Manages all item boxes in the world: builds them once, spins them, and
 * detects pickups.
 *
 * Public surface:
 *   - new ItemBoxManager(track, scene, opts)  builds the boxes and adds .group to scene.
 *   - .group                            THREE.Group holding every box mesh.
 *   - .update(karts, dt) -> pickups[]   spins boxes, returns [{ racerId }] for
 *                                        each box grabbed THIS frame.
 *
 * @param {object} track  the Track instance (uses checkpoints, roadWidth, isOnRoad).
 * @param {THREE.Scene} scene  the scene to add the box group to.
 * @param {{respawnTime?:number}} [opts]  per-manager overrides — battle passes a
 *        faster box respawn; races omit it and keep the 3s default.
 */
export class ItemBoxManager {
  constructor(track, scene, opts = {}) {
    this.track = track;
    this._respawnTime = opts.respawnTime != null ? opts.respawnTime : RESPAWN_TIME;

    // Per-tier env-reflection scale applied to the PBR box materials below (1.0 ==
    // today's look on MED; 0 on LOW = no reflections; glossier on HIGH/ULTRA).
    const envScale = qualitySettings.getConfig().envMapIntensity;

    // Root group for all boxes; we add it to the scene right away so the caller
    // doesn't have to remember to.
    this.group = new THREE.Group();
    this.group.name = 'ItemBoxes';
    if (scene) scene.add(this.group);

    // ONE shared geometry + ONE shared material for every box. Sharing them is
    // the cheapest possible setup: all boxes look identical and the GPU uploads
    // a single geometry/material. (We never tint individual boxes, so sharing is
    // safe — no per-box material state to clobber.) A BEVELED rounded cube reads as
    // a crafted power-up block rather than a flat crate.
    this._geometry = new RoundedBoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE, 4, BOX_SIZE * 0.12);

    // A canvas-drawn "?" sigil. Painting a bright "?" onto every face is what turns
    // a generic glowing cube into an obvious ITEM box — the universal "mystery /
    // power-up" symbol. The rounded-box UVs can't map a clean "?" per face, so we
    // no longer bake it into the body's emissive map; instead we float a crisp "?"
    // PANEL on each face (see _addBoxDecor). Built ONCE and shared.
    this._sigilTexture = this._makeQuestionTexture();

    // The box material: a translucent, brightly glowing cyan shell. transparent +
    // opacity lets you see it has volume/depth; a self-emissive cyan keeps it
    // reading as a beacon even in shadow. (The "?" now lives on the face panels.)
    this._material = new THREE.MeshStandardMaterial({
      color: 0x33ccff,            // cyan body
      emissive: 0x35d6ff,         // self-glow in the box hue
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.62,              // translucent — reads as an energy shell, not a crate
      roughness: 0.2,
      metalness: 0.0,
      envMapIntensity: envScale,  // per-tier reflection (0 LOW .. 1.5 ULTRA)
      depthWrite: false,          // translucent shells shouldn't fight the depth buffer
    });

    // Shared assets for the box decoration (a "?" panel per face + a soft halo).
    // PlaneGeometry defaults to facing +Z; _addBoxDecor rotates a copy onto each of
    // the six faces. The halo is a faint additive BackSide shell that blooms around
    // the whole box and rides it as a child (so it bobs + spins with the box).
    this._panelGeometry = new THREE.PlaneGeometry(BOX_SIZE * 0.66, BOX_SIZE * 0.66);
    this._panelMaterial = new THREE.MeshBasicMaterial({ map: this._sigilTexture });
    this._haloGeometry = new THREE.SphereGeometry(BOX_SIZE * 1.0, 18, 14);
    this._haloMaterial = new THREE.MeshBasicMaterial({
      color: 0x66e0ff,
      transparent: true,
      opacity: 0.16,
      side: THREE.BackSide,             // render the far shell -> a soft glow behind the box
      blending: THREE.AdditiveBlending, // blooms like light, doesn't paint a solid ball
      depthWrite: false,
    });

    // A faint inner "core" material (no "?" map) layered slightly smaller inside
    // each shell. It gives the box a solid glowing heart so the translucent shell
    // doesn't look hollow/flat. Shared like everything else.
    this._coreMaterial = new THREE.MeshStandardMaterial({
      color: 0x66ddff,
      emissive: 0x2299ff,
      emissiveIntensity: 1.6,
      transparent: true,
      opacity: 0.5,
      envMapIntensity: envScale,  // per-tier reflection (0 LOW .. 1.5 ULTRA)
    });
    this._coreGeometry = new THREE.BoxGeometry(
      BOX_SIZE * 0.5,
      BOX_SIZE * 0.5,
      BOX_SIZE * 0.5
    );

    // The glowing GROUND RING that sits flat on the road under each box. This is
    // the single biggest "drive through me" cue: a bright circle on the tarmac
    // tells the player exactly where to aim, visible long before the floating
    // cube itself is obvious. A RingGeometry lies in the XY plane by default, so
    // we rotate it flat (-90° about X) when we place each ring. Shared geometry +
    // material; additive blend so it reads as light cast on the road, not a decal.
    this._ringGeometry = new THREE.RingGeometry(RING_RADIUS * 0.62, RING_RADIUS, 40);
    this._ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x66e0ff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,     // visible whether the camera is above or skimming low
      blending: THREE.AdditiveBlending, // glows ON the road rather than painting over it
      depthWrite: false,          // never occlude karts/road; it's pure light
    });

    // The pool. Each entry is a plain record we reuse forever:
    //   mesh        the Three.js cube (we only toggle .visible + rotate it)
    //   core        the inner glowing heart mesh (rides with the shell)
    //   ring        the ground marker mesh (stays flat on the road, never hidden)
    //   baseY       the resting world-Y of the box center (bob oscillates around it)
    //   bobPhase    per-box phase offset so boxes don't all bob in lockstep
    //   active      true if currently grab-able; false while respawning
    //   respawn     seconds left until it pops back (0 when active)
    //   popT        seconds remaining in the pickup pop/flash (0 when not popping)
    this._boxes = [];

    // A single clock value advanced each update(); the bob uses it so every box
    // shares one sine source (cheap) and the motion is frame-rate independent.
    this._time = 0;

    this._buildBoxes();
  }

  /**
   * Paint a glowing "?" sigil onto a canvas and wrap it as a Three.js texture.
   * Used as the boxes' emissive map so the universal "mystery item" symbol shows
   * — brightly — on every face of every cube. Built once and shared.
   * @returns {THREE.CanvasTexture} a square texture with a centered cyan-white "?".
   * @private
   */
  _makeQuestionTexture() {
    const size = 256; // plenty sharp for a face this size; still tiny in VRAM
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Deep translucent backdrop so the cube body still reads as cyan glass while
    // the "?" pops in front of it.
    ctx.fillStyle = '#0a3b66';
    ctx.fillRect(0, 0, size, size);

    // A soft rounded inner panel so the symbol sits on a clean tile, not the raw
    // edge of the face.
    ctx.fillStyle = '#0e5a99';
    const m = size * 0.12; // margin
    ctx.beginPath();
    const r = size * 0.16; // corner radius
    ctx.moveTo(m + r, m);
    ctx.arcTo(size - m, m, size - m, size - m, r);
    ctx.arcTo(size - m, size - m, m, size - m, r);
    ctx.arcTo(m, size - m, m, m, r);
    ctx.arcTo(m, m, size - m, m, r);
    ctx.closePath();
    ctx.fill();

    // The "?" itself: big, bold, centered, bright white with a cyan glow so it
    // reads as energy. shadowBlur fakes the bloom without a post-process pass.
    ctx.font = `bold ${Math.floor(size * 0.66)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#9fefff';
    ctx.shadowBlur = size * 0.12;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('?', size / 2, size * 0.54);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace; // treat the painted colours as sRGB
    tex.anisotropy = 4;                    // stay crisp at grazing angles
    return tex;
  }

  /**
   * Choose the checkpoint indices that get a row of boxes, spaced EVENLY by index
   * across the whole loop. We skip index 0 (the start/finish line) so the grid is
   * clean, then place NUM_BOX_ROWS rows at roughly equal gaps through the rest of
   * the gates. On a long Phase-3 course (30+ gates) this scatters boxes the entire
   * lap instead of clumping them at the start; on a short course it still yields a
   * sensible spread. Deterministic (no randomness).
   * @param {number} cpCount  number of checkpoints on this track.
   * @returns {number[]} ascending, de-duplicated checkpoint indices (each >= 1).
   * @private
   */
  _rowCheckpoints(cpCount) {
    if (cpCount <= 1) return [];
    const rows = Math.min(NUM_BOX_ROWS, cpCount - 1); // never more rows than gates
    const out = [];
    let prev = -1;
    for (let r = 0; r < rows; r++) {
      // Spread across indices 1..cpCount-1 (skip the start line at 0). The +1
      // offset in the numerator pushes the first row off the line.
      let idx = 1 + Math.round(((r + 0.5) / rows) * (cpCount - 1));
      if (idx >= cpCount) idx = cpCount - 1;
      if (idx <= prev) idx = prev + 1; // keep strictly increasing on tiny tracks
      if (idx >= cpCount) break;
      out.push(idx);
      prev = idx;
    }
    return out;
  }

  /**
   * Build the full set of boxes ONCE. Rows are placed at chosen checkpoints and
   * spread across the road width using the centerline tangent so the row sits
   * perpendicular to the driving direction (a proper gate of boxes).
   * @private
   */
  _buildBoxes() {
    const cps = this.track.checkpoints;
    const halfW = this.track.roadWidth / 2;

    for (const cpIndex of this._rowCheckpoints(cps.length)) {
      // Guard against a track with fewer checkpoints than our row list expects.
      if (cpIndex >= cps.length) continue;

      const gate = cps[cpIndex];
      const next = cps[(cpIndex + 1) % cps.length];

      // Forward direction along the centerline at this gate (gate -> next).
      let fx = next.x - gate.x;
      let fz = next.z - gate.z;
      const flen = Math.hypot(fx, fz) || 1; // avoid divide-by-zero on a degenerate gate
      fx /= flen;
      fz /= flen;

      // Right vector (perpendicular to forward, in the XZ plane). Rotating
      // (fx,fz) by -90deg about Y gives (fz, -fx). We spread boxes along this.
      const rx = fz;
      const rz = -fx;

      // Spread BOXES_PER_ROW evenly across the road, leaving a margin from the
      // walls so karts can still thread between/around them.
      const usableHalf = halfW * 0.62; // keep boxes off the very edge
      for (let i = 0; i < BOXES_PER_ROW; i++) {
        // offset goes from -usableHalf .. +usableHalf across the row.
        const t = BOXES_PER_ROW === 1 ? 0 : i / (BOXES_PER_ROW - 1); // 0..1
        const offset = (t - 0.5) * 2 * usableHalf;                   // -uh..+uh

        const x = gate.x + rx * offset;
        const z = gate.z + rz * offset;
        // Skip any box that would land over a carved GAP (no road there) — else it
        // floats over the void. The denser box rows make this reachable, so guard it.
        if (this.track.isOnRoad && !this.track.isOnRoad(x, z)) continue;
        // The road surface elevation here. Gates carry `y` (centerline elevation),
        // so we anchor everything to it: boxes float BOX_Y above the road, rings
        // sit just on top of it. Falls back to 0 if a gate lacks elevation data.
        const roadY = gate.y || 0;
        const baseY = roadY + BOX_Y;

        const mesh = new THREE.Mesh(this._geometry, this._material);
        // Ride the hills: sit each box BOX_Y above the road surface at this point
        // rather than at a fixed world height (which would bury boxes inside
        // climbs / float them in dips on the elevated spline courses).
        mesh.position.set(x, baseY, z);
        mesh.name = `itemBox_cp${cpIndex}_${i}`;
        // Give each box a different starting spin phase so the row doesn't pulse
        // in lockstep (purely cosmetic, set once).
        mesh.rotation.y = (i / BOXES_PER_ROW) * Math.PI * 2;

        // Inner glowing core, parented to the shell so it inherits the shell's
        // position/rotation/scale automatically (we never have to move it again).
        const core = new THREE.Mesh(this._coreGeometry, this._coreMaterial);
        mesh.add(core);

        // A bright "?" panel on each face + a soft halo, all parented to the shell
        // so they bob/spin/pop with it for free.
        this._addBoxDecor(mesh);

        this.group.add(mesh);

        // The flat ground ring under this box. RingGeometry lies in the XY plane,
        // so rotating -90° about X lays it flat on the XZ road plane. We lift it a
        // hair above the road (+0.06m) to avoid z-fighting with the tarmac. The
        // ring stays put and visible at ALL times (even while the box respawns) so
        // the player always sees "a pickup lives here".
        const ring = new THREE.Mesh(this._ringGeometry, this._ringMaterial);
        ring.position.set(x, roadY + 0.06, z);
        ring.rotation.x = -Math.PI / 2;
        ring.name = `itemRing_cp${cpIndex}_${i}`;
        this.group.add(ring);

        this._boxes.push({
          mesh,
          core,
          ring,
          baseY,
          bobPhase: (i / BOXES_PER_ROW) * Math.PI * 2, // desync the bob too
          active: true,
          respawn: 0,
          popT: 0,
        });
      }
    }
  }

  /**
   * Decorate a box shell with a glowing "?" panel on each of its six faces plus a
   * soft additive halo, all parented to the shell mesh so they ride its bob, spin,
   * and pickup-pop automatically. Shared geo/material across every box (no per-box
   * allocation beyond the lightweight Mesh wrappers).
   * @param {THREE.Mesh} mesh  the box shell to decorate.
   * @private
   */
  _addBoxDecor(mesh) {
    const d = BOX_SIZE / 2 + 0.02; // float each panel just off its face
    const faces = [
      { p: [d, 0, 0], r: [0, Math.PI / 2, 0] },
      { p: [-d, 0, 0], r: [0, -Math.PI / 2, 0] },
      { p: [0, d, 0], r: [-Math.PI / 2, 0, 0] },
      { p: [0, -d, 0], r: [Math.PI / 2, 0, 0] },
      { p: [0, 0, d], r: [0, 0, 0] },
      { p: [0, 0, -d], r: [0, Math.PI, 0] },
    ];
    for (const f of faces) {
      const panel = new THREE.Mesh(this._panelGeometry, this._panelMaterial);
      panel.position.set(f.p[0], f.p[1], f.p[2]);
      panel.rotation.set(f.r[0], f.r[1], f.r[2]);
      mesh.add(panel);
    }
    mesh.add(new THREE.Mesh(this._haloGeometry, this._haloMaterial));
  }

  /**
   * Per-frame update: spin active boxes, tick respawning boxes back to life, and
   * detect pickups by distance to each kart.
   *
   * @param {Array} karts - the live karts. Each entry must expose an id and a
   *        world XZ position. We read kart.state.x / kart.state.z and kart.id
   *        (the same id LapSystem uses). Inactive/finished karts are fine to pass.
   * @param {number} dt - timestep in seconds.
   * @returns {Array<{racerId:*}>} one entry per box grabbed THIS frame. Empty
   *          (a reused-by-value array each call is fine; callers consume it now).
   */
  update(karts, dt) {
    // Reuse nothing fancy here: a fresh small array per frame is cheap and is the
    // clearest contract. The POOL we care about is the meshes, not this list.
    const pickups = [];

    // Advance the shared clock. The gentle bob reads off this so all boxes share
    // one sine source and the motion is frame-rate independent.
    this._time += dt;

    // Precompute the squared pickup radius once (compare squared distances so we
    // never call Math.sqrt in the hot loop).
    const pickR2 = PICKUP_RADIUS * PICKUP_RADIUS;

    // A slow pulse (0..1) shared by every ground ring so the markers gently
    // breathe in brightness — alive, not a static decal. cos -> [-1,1] -> [0,1].
    const ringPulse = 0.45 + 0.25 * (0.5 + 0.5 * Math.cos(this._time * 3.0));

    for (let b = 0; b < this._boxes.length; b++) {
      const box = this._boxes[b];

      // The ground ring is ALWAYS visible (even mid-respawn) and gently pulses,
      // so the player always knows a pickup lives at this spot. Cheap: writing one
      // shared material's opacity once would be enough, but rings share material
      // by reference, so setting it on the material itself (below) covers them all.
      // We instead spin each ring a touch for a subtle "active beacon" feel.
      box.ring.rotation.z += dt * 0.6;

      // --- Pickup POP/FLASH: a brief celebratory swell + fade before hiding ---
      // When a box is grabbed we don't hide it instantly; we run a short pop so
      // the pickup reads as a satisfying "got it!" beat. popT counts DOWN from
      // POP_TIME; when it reaches 0 we finally hide the cube and begin respawn.
      if (box.popT > 0) {
        box.popT -= dt;
        const p = 1 - Math.max(0, box.popT) / POP_TIME; // 0 -> 1 over the pop
        // Swell out (scale grows) while fading the shell out. ease-out for a snappy
        // burst that decelerates.
        const ease = 1 - (1 - p) * (1 - p); // quadratic ease-out
        const scale = 1 + (POP_SCALE - 1) * ease;
        box.mesh.scale.setScalar(scale);
        box.mesh.rotation.y += SPIN_SPEED * 4 * dt; // spin faster during the burst
        // Fade the shell + core via per-instance opacity. (These materials are
        // shared, so we briefly clone-free trick it: we cannot fade one box's
        // shared material without fading all — so during a pop we swap to a private
        // material set on first pop, restored on respawn. See _ensurePopMaterials.)
        this._ensurePopMaterials(box);
        const fade = 1 - ease;
        box.mesh.material.opacity = 0.62 * fade;
        box.core.material.opacity = 0.5 * fade;

        if (box.popT <= 0) {
          // Pop finished: hide the cube, restore its shared look + scale, and
          // start the respawn countdown.
          box.popT = 0;
          box.mesh.visible = false;
          box.mesh.scale.setScalar(1);
          this._restoreSharedMaterials(box);
          box.respawn = this._respawnTime;
        }
        continue; // a popping box can't be grabbed again
      }

      if (!box.active) {
        // Respawning: count down, and when the timer expires pop the box back.
        box.respawn -= dt;
        if (box.respawn <= 0) {
          box.respawn = 0;
          box.active = true;
          box.mesh.visible = true;
        }
        continue; // hidden boxes can't be grabbed and don't need to spin
      }

      // Idle spin (visual only). Spinning about Y reads as a floating powerup.
      box.mesh.rotation.y += SPIN_SPEED * dt;

      // Gentle bob: float the box up/down around its resting baseY using a sine
      // wave. The per-box bobPhase offset desyncs the row so they don't all rise
      // and fall together (looks more alive).
      box.mesh.position.y =
        box.baseY + Math.sin(this._time * BOB_SPEED + box.bobPhase) * BOB_AMPLITUDE;

      // Pickup test: first kart within range grabs it. We break on the first hit
      // so two karts can't both claim the same box on the same frame.
      const bx = box.mesh.position.x;
      const bz = box.mesh.position.z;
      for (let k = 0; k < karts.length; k++) {
        const kart = karts[k];
        const s = kart && kart.state;
        if (!s) continue; // defensive: skip a kart with no state yet

        const dx = s.x - bx;
        const dz = s.z - bz;
        if (dx * dx + dz * dz <= pickR2) {
          // Grab: mark it taken and start the pop/flash. The box stays VISIBLE for
          // POP_TIME (swelling + fading) and only then hides + begins respawn — but
          // we report the pickup THIS frame so the manager awards the item now
          // (unchanged contract; only the visual hide is deferred).
          box.active = false;
          box.popT = POP_TIME;
          pickups.push({ racerId: kart.id });
          break; // this box is taken; move to the next box
        }
      }
    }

    // Pulse all the ground rings' brightness in one cheap write (they share the
    // ring material by reference, so a single assignment updates every ring).
    this._ringMaterial.opacity = ringPulse;

    return pickups;
  }

  /**
   * Give a box its OWN shell + core materials for the duration of a pickup pop, so
   * we can fade THIS box out without dimming every other box (which all share the
   * single cached material). We clone the shared materials lazily on the first pop
   * and reuse the clones forever after (still pooled — created at most once per box).
   * @param {object} box  the pool record being popped.
   * @private
   */
  _ensurePopMaterials(box) {
    if (box._popShell) {
      // Already has private materials cached — just make sure they're applied.
      box.mesh.material = box._popShell;
      box.core.material = box._popCore;
      return;
    }
    box._popShell = this._material.clone();
    box._popCore = this._coreMaterial.clone();
    box.mesh.material = box._popShell;
    box.core.material = box._popCore;
  }

  /**
   * Put a box back on the SHARED materials (full opacity) after its pop finished,
   * so it renders identically to every other resting box and we keep the
   * one-material-for-all-boxes efficiency the rest of the time.
   * @param {object} box  the pool record whose pop just ended.
   * @private
   */
  _restoreSharedMaterials(box) {
    box.mesh.material = this._material;
    box.core.material = this._coreMaterial;
  }

  /**
   * Free every geometry/material/texture this manager built (its box/panel/halo/
   * core/ring assets, the sigil CanvasTexture, and any per-box pop-shell clones)
   * and detach its group. A fresh ItemBoxManager is constructed each race, so all
   * of these are owned here and were previously orphaned in GPU memory on every
   * race restart. Walk the group (dedup via a Set) like Track.dispose().
   */
  dispose() {
    const seen = new Set();
    const disposeMat = (m) => {
      if (!m || seen.has(m)) return;
      seen.add(m);
      for (const k of ['map', 'emissiveMap', 'alphaMap', 'normalMap']) {
        const tex = m[k];
        if (tex && typeof tex.dispose === 'function') tex.dispose();
      }
      if (typeof m.dispose === 'function') m.dispose();
    };
    this.group.traverse((o) => {
      if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
      const mat = o.material;
      if (Array.isArray(mat)) mat.forEach(disposeMat);
      else disposeMat(mat);
    });
    if (this._sigilTexture && typeof this._sigilTexture.dispose === 'function') this._sigilTexture.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
