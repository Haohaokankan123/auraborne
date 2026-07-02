// src/entities/Projectiles.js
//
// The flying/dropped hazards: green shells, red shells, bananas, fake item
// boxes, bob-ombs, and bullet bills. This file owns ONLY the world objects
// (Three.js meshes) and their motion + collision against karts. It does NOT
// decide WHO fires what (the items manager spawns into us) and it does NOT mutate
// kart physics directly beyond the agreed mutator helpers.
//
// On hit we call applySpin(state, secs) UNLESS isInvincible(state) — both pure
// helpers imported from the shared kart model. Keeping the spin logic in the
// shared model (not here) means the server can reproduce a hit deterministically.
//
// POOLING (critical for 13 karts at 60fps):
//   - Every projectile mesh is created ONCE, lazily, and then RECYCLED. When a
//     projectile expires or hits, we set p.active = false and hide the mesh; the
//     next spawn of the same TYPE reuses a dead mesh of that type instead of
//     allocating. We never destroy geometry/material/meshes during play.
//   - Geometry + material per type are SHARED singletons (one sphere geo for all
//     shells, etc.), so the GPU holds one copy regardless of how many are live.
//   - update() walks a flat array and skips inactive entries. No per-frame
//     allocation anywhere in the hot path.
//
// Conventions (match the project):
//   - Y up; track in XZ; world units = meters.
//   - heading/forward = (sin(heading), 0, cos(heading)).
//   - track.isOnRoad(x,z) is our cheap "are we still on the drivable band" test,
//     used for green-shell bounce + general out-of-bounds expiry.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { applySpin, isInvincible } from '../../shared/kartModel.js';
// QUALITY TIER: HIGH+ builds the dominant hazard body surfaces as LIT materials
// (they shade with the scene + cast shadows) while keeping bright unlit neon trims;
// LOW/MED keep the cheap full-bright unlit look. Read once at asset-build time.
import qualitySettings from '../core/QualitySettings.js';
// TERRAIN HEIGHT: the track is no longer flat — after the rollercoaster rebuild it
// climbs from ~58m to ~144m. Projectiles must RIDE that surface, not float at a
// fixed world height, or a thrown shell spawns/lives dozens of metres BELOW the
// road and is invisible. sampleSurface(trackId,x,z,y,sHint) -> { groundY, s } is
// the same pure heightfield the karts ride; we sample it per projectile per frame.
import { sampleSurface } from '../../shared/trackData.js';

// --- Tuning (projectile feel; local because it's not shared kart physics) ----
const SHELL_SPEED = 58;        // m/s  green/red shell travel speed — a MISSILE: well above kart top speed
                               //      (MAX_SPEED 44 * 1.15 ≈ 50.6) so a fired shell outruns its quarry.
                               //      MUST match items.js greenShell/redShell.speed so the server agrees.
const BULLET_SPEED = 60;       // m/s  bullet bill is the fastest thing on track
const SHELL_LIFE = 6.0;        // s    green shell self-destructs after this long
const RED_SHELL_LIFE = 5.0;    // s    red shell gives up homing after this long
const BULLET_LIFE = 4.0;       // s    bullet bill duration
const BOBOMB_TRAVEL = 1.1;     // s    bob-omb flies this long, then explodes
const STATIC_LIFE = 20.0;      // s    bananas / fake boxes linger this long if untouched

const HIT_RADIUS = 1.8;        // m    XZ hit distance = kart half-width ~0.9m (outer rear
                               //      wheel edge: halfTrack 0.74 + tire 0.14*1.12) + shell
                               //      radius 0.91m (0.7 sphere * 1.3 throw scale) ≈ 1.8m.
const HIT_R2 = HIT_RADIUS * HIT_RADIUS;
const VERTICAL_HIT = 2.5;      // m    max |Δy| for a hit — ~1.5m kart body + hill slack,
                               //      still stops a shell on the lower deck of an overpass
                               //      (or a different loop level) from hitting a kart above.
const EXPLOSION_RADIUS = 4.0;  // m    matches the blast VFX: the orange shockwave ring is a
                               //      1x1 plane scaled to endScale 8 (8m wide => 4m radius).
const EXPLOSION_R2 = EXPLOSION_RADIUS * EXPLOSION_RADIUS;

const SPIN_SECS = 1.4;         // s    how long a direct hit spins a kart out
const EXPLOSION_SPIN_SECS = 1.8; // s  bob-omb explosion spins a touch longer

const PROJECTILE_Y = 0.6;      // m    height the hazards float/roll ABOVE the road surface
                               //      (added to the sampled groundY, NOT an absolute Y)
const RED_HOMING_TURN = 6.5;   // rad/s  how sharply a red shell can curve toward its target — hard,
                               //        near-undodgeable lock-on (was 4.0; a missile, not a lazy arc)
const RED_CONE_COS = 0.5;      //        target pickup cone: only lock a kart within ±60° of forward
                               //        (cos 60° = 0.5) so a red shell chases the road ahead, not sideways
const BANANA_DESPAWN_ON_HIT = true; // bananas pop on contact (classic behaviour)

// --- DROPPED-TRAP tuning (task: dropped items settle on the track + stay) ------
const TRAP_REST_Y = 0.35;      // m   resting height for a dropped banana / fake box above the road
                               //     surface — low so it NESTLES on the track instead of floating.

// --- ORBIT-SHIELD HIT tuning (task: orbiting items spin out rivals that touch them) -
// A rival within this distance of an orbit-holder's CENTRE is treated as touching
// the orbiting ring and gets spun out. We test centre-distance (not each spinning
// mesh's exact position) on PURPOSE: it's deterministic and phase-free, so the
// client and the server (Room.js mirrors the SAME numbers) always agree in MP.
const ORBIT_HIT_DIST = 3.6;    // m   = ORBIT_RADIUS (2.4) + ~1.2 m kart/brush margin
const ORBIT_HIT_R2 = ORBIT_HIT_DIST * ORBIT_HIT_DIST;
const ORBIT_SPIN_SECS = 1.5;   // s   spin inflicted by a brushed orbiting item (matches SPIN_DURATION)

// --- VISIBLE-ITEM tuning (orbit / trail / glow / threat) ----------------------
// These power the "you can finally SEE your power-ups" round: held shells ORBIT
// the kart, a thrown shell drags a bright motion TRAIL + glow halo so you can
// track where it went, and a projectile CLOSING on a kart flags itself as a
// threat (so the HUD can warn the player and they can dodge).
const ORBIT_RADIUS = 2.4;      // m   how far a held item rings around the kart
const ORBIT_SPEED = 2.6;       // rad/s  how fast the held ring spins (Mario-Kart twirl)
const ORBIT_BOB = 0.18;        // m   vertical bob amplitude of the orbiting items
const ORBIT_Y = 0.9;           // m   base height the ring floats at (kart-roof-ish)
const ORBIT_SPIN = 6;          // rad/s  each orbiting mesh tumbles on its own axis

// ORBIT-ABLE id -> the projectile-asset type whose geo+color it should mirror.
// Triples reuse the single-item look (3 of them just ring evenly). Stream R sets
// kart.state.heldOrbitId to one of these keys; we map it to a mesh appearance.
const ORBIT_APPEARANCE = {
  greenShell: 'greenShell',
  redShell: 'redShell',
  tripleGreen: 'greenShell',
  tripleRed: 'redShell',
  banana: 'banana',
  tripleBanana: 'banana',
};

const TRAIL_INTERVAL = 0.018;  // s   gap between motion-trail puffs on a flying projectile
const TRAIL_LIFE = 0.34;       // s   how long each trail puff lingers before fading out
const THREAT_RADIUS = 30;      // m   a homing/closing projectile within this of a kart = a threat
const THREAT_R2 = THREAT_RADIUS * THREAT_RADIUS;

/**
 * The projectile pool + simulator.
 *
 * Public surface:
 *   - new ProjectileSystem(scene, track)
 *   - .group                          THREE.Group holding every projectile mesh.
 *   - .spawn(type, originState, context)  launch/drop a hazard. type is one of
 *       'greenShell' | 'redShell' | 'banana' | 'bobOmb' | 'fakeBox' | 'bulletBill'.
 *       originState is the firing kart's state (x,z,heading,speed). context may
 *       carry { karts, ownerId, ownerProgress } for homing/targeting + self-skip.
 *   - .update(dt, karts)              move everything, bounce, collide vs karts.
 *
 * @param {THREE.Scene} scene
 * @param {object} track  Track instance (uses isOnRoad for bounce/out-of-bounds).
 */
export class ProjectileSystem {
  constructor(scene, track) {
    this.track = track;

    this.group = new THREE.Group();
    this.group.name = 'Projectiles';
    if (scene) scene.add(this.group);

    // Shared geometry/material singletons, built ONCE per type. Every live
    // projectile of a type points at the same geo+mat, so the cost is constant
    // no matter how many are flying.
    this._assets = this._buildAssets();

    // ORBIT layer: a pool of meshes that ring + spin around any kart whose
    // kart.state.heldOrbitId is an orbit-able item (the shells/bananas you hold).
    // Reuses the projectile geometries so a held green shell looks exactly like a
    // thrown one. Leased per kart each frame (see updateOrbits), never allocated
    // mid-race. See _buildOrbitPool for the appearance map.
    this._orbits = this._buildOrbitPool();

    // FX layer (motion trails + glow halos + shield clinks), all pooled. These
    // are visual-only meshes we own here so Projectiles stays self-contained — it
    // doesn't reach into ItemVFX/VFX (it has no handle to them), it just draws its
    // own bright unlit puffs so a thrown shell is trackable and a blocked hit pops.
    this._fx = this._buildFxPool();

    // The flat pool. Each entry is a reusable record:
    //   mesh     Three.js mesh (only .visible/.position/.rotation touched per frame)
    //   type     which hazard this slot currently represents
    //   active   true while live; false = recyclable
    //   vx, vz   velocity in m/s (0 for static drops)
    //   life     seconds remaining before self-expiry
    //   ownerId  racer id that fired it (so it can't instantly hit its owner)
    //   armDelay seconds before it can hit ANYONE (lets it clear the owner first)
    //   homing   true for red shells (chase a target each frame)
    //   exploder true for bob-ombs (on expiry/hit -> area spin instead of single)
    //   targetId red-shell's chosen victim id (re-resolved if it vanishes)
    this._pool = [];

    // FX EVENT QUEUE (Round-13 bespoke VFX): the projectile pool knows exactly WHERE
    // a shell hit or a bob-omb detonated, but it can't reach the ItemVFX pool. So it
    // pushes plain { type, x, y, z, color } descriptors here; RaceManager merges this
    // into consumeFxEvents() and main.js renders the impact spark / explosion.
    this.fxEvents = [];
  }

  /**
   * Build one geometry + material per projectile TYPE. Done once; never freed.
   * @returns {object} map of type -> { geo, mat }
   * @private
   */
  _buildAssets() {
    // NEON-SYNTHWAVE PROCEDURAL HAZARDS. Every type used to be a single sphere/box;
    // now each is a small Group of richer parts (a real shell silhouette, a curved
    // banana, a compound bob-omb, a finned bullet, etc.). The geometry + material
    // singletons below are created ONCE here and CAPTURED by per-type build()
    // closures, so the GPU still holds exactly one copy of each buffer no matter how
    // many projectiles (or held-orbit clones) are live — build() only news up
    // lightweight Mesh/Group wrappers that reference the shared assets. Materials
    // stay MeshBasic (UNLIT) so hazards read full-bright on the darkest themes, with
    // pale neon trims + additive sparks/halos for the glowing-edge synthwave look.
    const UP = new THREE.Vector3(0, 1, 0);

    // QUALITY: on HIGH+ (litItems) the DOMINANT body surface of each hazard becomes
    // a LIT MeshStandardMaterial — it shades with the scene's sun/form lights and
    // casts/receives shadows (see _applyItemShadows) so a thrown shell reads as a
    // real object on the road, not a flat sticker — while still carrying a strong
    // self-emissive so it pops on the dark themes. On LOW/MED it stays the original
    // full-bright unlit MeshBasic (cheapest + brightest). The bright neon TRIMS
    // (rims, ridges, fins, sparks, halos) deliberately stay unlit below, so the
    // glowing-edge synthwave read is preserved on every tier.
    const _q = qualitySettings.getConfig();
    const litItems = _q.litItems;
    this._litItems = litItems;
    const _envScale = _q.envMapIntensity;
    const solid = (hex) => litItems
      ? new THREE.MeshStandardMaterial({
          color: hex, emissive: hex, emissiveIntensity: 0.6,
          roughness: 0.45, metalness: 0.25, envMapIntensity: _envScale,
        })
      : new THREE.MeshBasicMaterial({ color: hex });

    // ===== SHELL (green + red share one domed-carapace silhouette) ============
    // A LatheGeometry dome (revolved profile) + a flat rim torus (the glowing edge)
    // + two growth-ridge rings + a belly disc so it's solid from below (orbit view).
    const shellProfile = [
      new THREE.Vector2(0.00, 0.68), new THREE.Vector2(0.13, 0.66),
      new THREE.Vector2(0.27, 0.60), new THREE.Vector2(0.40, 0.50),
      new THREE.Vector2(0.52, 0.36), new THREE.Vector2(0.62, 0.18),
      new THREE.Vector2(0.68, 0.00), new THREE.Vector2(0.66, -0.11),
      new THREE.Vector2(0.60, -0.18),
    ];
    const shellDomeGeo = new THREE.LatheGeometry(shellProfile, 28);
    const shellRimGeo = new THREE.TorusGeometry(0.65, 0.07, 10, 30);
    const shellRidge1Geo = new THREE.TorusGeometry(0.55, 0.025, 8, 28);
    const shellRidge2Geo = new THREE.TorusGeometry(0.40, 0.022, 8, 24);
    const shellBellyGeo = new THREE.CircleGeometry(0.6, 28);
    const greenDomeMat = solid(0x2fff5a); // dominant carapace -> lit on HIGH+
    const greenRimMat = new THREE.MeshBasicMaterial({ color: 0xbcffce });
    const greenRidgeMat = new THREE.MeshBasicMaterial({ color: 0x0f9e38 });
    const greenBellyMat = new THREE.MeshBasicMaterial({ color: 0xdfffe6, side: THREE.DoubleSide });
    const redDomeMat = solid(0xff2a2a); // dominant carapace -> lit on HIGH+
    const redRimMat = new THREE.MeshBasicMaterial({ color: 0xffb6b6 });
    const redRidgeMat = new THREE.MeshBasicMaterial({ color: 0xb31515 });
    const redBellyMat = new THREE.MeshBasicMaterial({ color: 0xffdada, side: THREE.DoubleSide });
    const buildShell = (domeMat, rimMat, ridgeMat, bellyMat) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(shellDomeGeo, domeMat));
      const rim = new THREE.Mesh(shellRimGeo, rimMat); rim.rotation.x = Math.PI / 2;
      const r1 = new THREE.Mesh(shellRidge1Geo, ridgeMat); r1.rotation.x = Math.PI / 2; r1.position.y = 0.30;
      const r2 = new THREE.Mesh(shellRidge2Geo, ridgeMat); r2.rotation.x = Math.PI / 2; r2.position.y = 0.48;
      const belly = new THREE.Mesh(shellBellyGeo, bellyMat); belly.rotation.x = Math.PI / 2; belly.position.y = -0.17;
      g.add(rim, r1, r2, belly);
      return g;
    };

    // ===== BANANA (TubeGeometry along a Catmull-Rom crescent + tip + stem) =====
    const bananaCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.62, 0.16, 0), new THREE.Vector3(-0.34, -0.08, 0),
      new THREE.Vector3(0.00, -0.18, 0), new THREE.Vector3(0.34, -0.08, 0),
      new THREE.Vector3(0.62, 0.16, 0),
    ]);
    const bananaTubeGeo = new THREE.TubeGeometry(bananaCurve, 40, 0.13, 12, false);
    const bananaTipGeo = new THREE.ConeGeometry(0.13, 0.18, 12);
    const bananaStemGeo = new THREE.CylinderGeometry(0.045, 0.065, 0.14, 8);
    const bananaBodyMat = solid(0xffe11a); // dominant crescent -> lit on HIGH+
    const bananaStemMat = new THREE.MeshBasicMaterial({ color: 0x6b4a1c });
    const bP0 = bananaCurve.getPointAt(0), bT0 = bananaCurve.getTangentAt(0);
    const bP1 = bananaCurve.getPointAt(1), bT1 = bananaCurve.getTangentAt(1);
    const buildBanana = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bananaTubeGeo, bananaBodyMat));
      // Pointed tip at one end (cone aligned to the curve tangent) -> tapered look.
      const outA = bT0.clone().negate();
      const tip = new THREE.Mesh(bananaTipGeo, bananaBodyMat);
      tip.position.copy(bP0).addScaledVector(outA, 0.09);
      tip.quaternion.setFromUnitVectors(UP, outA);
      // Little brown stalk at the other end -> reads unmistakably as a banana.
      const stem = new THREE.Mesh(bananaStemGeo, bananaStemMat);
      stem.position.copy(bP1).addScaledVector(bT1, 0.07);
      stem.quaternion.setFromUnitVectors(UP, bT1);
      g.add(tip, stem);
      return g;
    };

    // ===== BOB-OMB (dark body + steel collar + lit fuse spark + key + feet) ====
    const bombBodyGeo = new THREE.SphereGeometry(0.6, 22, 18);
    const bombSeamGeo = new THREE.TorusGeometry(0.6, 0.02, 8, 30);
    const bombCapGeo = new THREE.CylinderGeometry(0.2, 0.24, 0.12, 16);
    const bombFuseGeo = new THREE.CylinderGeometry(0.035, 0.05, 0.34, 8);
    const bombSparkGeo = new THREE.SphereGeometry(0.1, 12, 10);
    const bombKeyRingGeo = new THREE.TorusGeometry(0.13, 0.035, 8, 18);
    const bombKeyStemGeo = new THREE.BoxGeometry(0.07, 0.07, 0.2);
    const bombFootGeo = new THREE.SphereGeometry(0.13, 10, 8);
    const bombEyeGeo = new THREE.SphereGeometry(0.07, 10, 8);
    const bombBodyMat = solid(0x2a2a40); // dominant sphere body -> lit on HIGH+
    const bombSeamMat = new THREE.MeshBasicMaterial({ color: 0xff5a3a });
    const bombMetalMat = new THREE.MeshBasicMaterial({ color: 0x9aa6c4 });
    const bombFuseMat = new THREE.MeshBasicMaterial({ color: 0x5a4a2c });
    const bombSparkMat = new THREE.MeshBasicMaterial({
      color: 0xfff0a0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const bombFootMat = new THREE.MeshBasicMaterial({ color: 0xffb000 });
    const bombEyeMat = new THREE.MeshBasicMaterial({ color: 0xf4f8ff });
    const buildBobomb = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(bombBodyGeo, bombBodyMat));
      const seam = new THREE.Mesh(bombSeamGeo, bombSeamMat); seam.rotation.x = Math.PI / 2;
      const cap = new THREE.Mesh(bombCapGeo, bombMetalMat); cap.position.y = 0.56;
      const fuse = new THREE.Mesh(bombFuseGeo, bombFuseMat); fuse.position.set(0.06, 0.78, 0); fuse.rotation.z = -0.32;
      const spark = new THREE.Mesh(bombSparkGeo, bombSparkMat); spark.position.set(0.18, 0.95, 0);
      const keyStem = new THREE.Mesh(bombKeyStemGeo, bombMetalMat); keyStem.position.set(0, 0.05, -0.62);
      const keyRing = new THREE.Mesh(bombKeyRingGeo, bombMetalMat); keyRing.position.set(0, 0.05, -0.78);
      const footL = new THREE.Mesh(bombFootGeo, bombFootMat); footL.scale.set(1, 0.55, 1.35); footL.position.set(-0.22, -0.55, 0.16);
      const footR = footL.clone(); footR.position.x = 0.22;
      const eyeL = new THREE.Mesh(bombEyeGeo, bombEyeMat); eyeL.position.set(-0.16, 0.16, 0.54);
      const eyeR = new THREE.Mesh(bombEyeGeo, bombEyeMat); eyeR.position.set(0.16, 0.16, 0.54);
      g.add(seam, cap, fuse, spark, keyStem, keyRing, footL, footR, eyeL, eyeR);
      return g;
    };

    // ===== "?" PANEL TEXTURE (shared by the fake box + the real ITEM box look) =
    const makeQTex = () => {
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0a2f55';
      ctx.fillRect(0, 0, size, size);
      ctx.font = `bold ${Math.floor(size * 0.7)}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#9fefff';
      ctx.shadowBlur = size * 0.16;
      ctx.fillStyle = '#ffffff';
      ctx.fillText('?', size / 2, size * 0.56);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };

    // ===== FAKE ITEM BOX (beveled rounded cube + "?" panel per face + halo) ====
    // Mimics the real drive-through box (same "?" tiles) so it tricks players — the
    // only tell is the warm red body tint + a reddish halo instead of cyan.
    const qPanelGeo = new THREE.PlaneGeometry(0.92, 0.92);
    const qPanelMat = new THREE.MeshBasicMaterial({ map: makeQTex() });
    const fakeBoxGeo = new RoundedBoxGeometry(1.2, 1.2, 1.2, 4, 0.14);
    const fakeBodyMat = new THREE.MeshBasicMaterial({ color: 0xff4d6a, transparent: true, opacity: 0.82 });
    const fakeHaloGeo = new THREE.SphereGeometry(1.1, 16, 12);
    const fakeHaloMat = new THREE.MeshBasicMaterial({
      color: 0xff4d6a, transparent: true, opacity: 0.2, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const BOX_FACES = [
      { p: [0.62, 0, 0], r: [0, Math.PI / 2, 0] },
      { p: [-0.62, 0, 0], r: [0, -Math.PI / 2, 0] },
      { p: [0, 0.62, 0], r: [-Math.PI / 2, 0, 0] },
      { p: [0, -0.62, 0], r: [Math.PI / 2, 0, 0] },
      { p: [0, 0, 0.62], r: [0, 0, 0] },
      { p: [0, 0, -0.62], r: [0, Math.PI, 0] },
    ];
    const buildFakeBox = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(fakeBoxGeo, fakeBodyMat));
      for (const f of BOX_FACES) {
        const panel = new THREE.Mesh(qPanelGeo, qPanelMat);
        panel.position.set(f.p[0], f.p[1], f.p[2]);
        panel.rotation.set(f.r[0], f.r[1], f.r[2]);
        g.add(panel);
      }
      g.add(new THREE.Mesh(fakeHaloGeo, fakeHaloMat));
      return g;
    };

    // ===== BULLET BILL (gunmetal capsule + cone nose + neon band + fins + glow) =
    const bulletBodyGeo = new THREE.CapsuleGeometry(0.42, 0.85, 8, 18);
    const bulletNoseGeo = new THREE.ConeGeometry(0.42, 0.5, 18);
    const bulletBandGeo = new THREE.TorusGeometry(0.42, 0.05, 8, 22);
    const bulletFinGeo = new RoundedBoxGeometry(0.46, 0.07, 0.32, 3, 0.03);
    const bulletGlowGeo = new THREE.SphereGeometry(0.22, 12, 10);
    const bulletBodyMat = solid(0x2b3550); // dominant gunmetal capsule -> lit on HIGH+
    const bulletRimMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff });
    const bulletGlowMat = new THREE.MeshBasicMaterial({
      color: 0xeafdff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const buildBullet = () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bulletBodyGeo, bulletBodyMat); body.rotation.x = Math.PI / 2; // long axis -> Z (travel)
      const nose = new THREE.Mesh(bulletNoseGeo, bulletRimMat); nose.rotation.x = Math.PI / 2; nose.position.z = 1.0; // cone -> +Z
      const band = new THREE.Mesh(bulletBandGeo, bulletRimMat); band.position.z = 0.1; // neon ring around the body
      const glow = new THREE.Mesh(bulletGlowGeo, bulletGlowMat); glow.position.z = 1.28; // glowing nose tip
      const finL = new THREE.Mesh(bulletFinGeo, bulletRimMat); finL.position.set(-0.42, 0, -0.32); finL.rotation.z = Math.PI / 2;
      const finR = new THREE.Mesh(bulletFinGeo, bulletRimMat); finR.position.set(0.42, 0, -0.32); finR.rotation.z = Math.PI / 2;
      const finT = new THREE.Mesh(bulletFinGeo, bulletRimMat); finT.position.set(0, 0.42, -0.32);
      g.add(body, nose, band, glow, finL, finR, finT);
      return g;
    };

    // ===== MUSHROOM (domed cap + stem + spots) ================================
    const mushCapGeo = new THREE.SphereGeometry(0.52, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62);
    const mushStemGeo = new THREE.CylinderGeometry(0.24, 0.3, 0.4, 16);
    const mushSpotGeo = new THREE.CircleGeometry(0.1, 14);
    const mushCapMat = solid(0xff4d5e); // dominant cap -> lit on HIGH+
    const mushStemMat = new THREE.MeshBasicMaterial({ color: 0xfff1dd });
    const mushSpotMat = new THREE.MeshBasicMaterial({ color: 0xfff1dd, side: THREE.DoubleSide });
    const buildMushroom = () => {
      const g = new THREE.Group();
      const cap = new THREE.Mesh(mushCapGeo, mushCapMat); cap.position.y = 0.05;
      const stem = new THREE.Mesh(mushStemGeo, mushStemMat); stem.position.y = -0.22;
      g.add(cap, stem);
      const spots = [[0, 0.5, 0], [0.3, 0.28, 0.18], [-0.28, 0.3, -0.16], [0.05, 0.34, -0.32]];
      for (const s of spots) {
        const dot = new THREE.Mesh(mushSpotGeo, mushSpotMat);
        const n = new THREE.Vector3(s[0], s[1], s[2]).normalize();
        dot.position.copy(n).multiplyScalar(0.515); dot.position.y += 0.05; // sit on the cap surface
        dot.lookAt(dot.position.clone().add(n)); // face along the cap normal
        g.add(dot);
      }
      return g;
    };

    // ===== STAR (extruded 5-point star + additive sparkle bloom) ==============
    const starShape = new THREE.Shape();
    const SPIKES = 5, RO = 0.6, RI = 0.26;
    for (let i = 0; i <= SPIKES * 2; i++) {
      const r = (i % 2 === 0) ? RO : RI;
      const a = (i / (SPIKES * 2)) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) starShape.moveTo(x, y); else starShape.lineTo(x, y);
    }
    starShape.closePath();
    const starGeo = new THREE.ExtrudeGeometry(starShape, {
      depth: 0.2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.06, bevelSegments: 2,
    });
    starGeo.center();
    const starMat = solid(0xffe23a); // dominant star body -> lit on HIGH+
    const starGlowMat = new THREE.MeshBasicMaterial({
      color: 0xfff7c0, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const buildStar = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(starGeo, starMat));
      const glow = new THREE.Mesh(starGeo, starGlowMat); glow.scale.setScalar(1.3);
      g.add(glow);
      return g;
    };

    // Per-type FACTORY (build() returns a fresh Group/Mesh over the SHARED assets).
    return {
      greenShell: { build: () => buildShell(greenDomeMat, greenRimMat, greenRidgeMat, greenBellyMat) },
      redShell: { build: () => buildShell(redDomeMat, redRimMat, redRidgeMat, redBellyMat) },
      banana: { build: buildBanana },
      bobOmb: { build: buildBobomb },
      fakeBox: { build: buildFakeBox },
      bulletBill: { build: buildBullet },
      // ponytail: mushroom + star are 'self' items (HUD emoji today) with no
      // projectile/orbit spawn path yet — these factories are render-ready for when
      // the item logic (NOT owned here) wires them in; dormant + harmless until then.
      mushroom: { build: buildMushroom },
      star: { build: buildStar },
    };
  }

  /**
   * The per-type bright color (0xRRGGBB) used for trails/glow that should match a
   * projectile's body. Falls back to white for unknown types.
   * @param {string} type
   * @returns {number}
   * @private
   */
  _colorFor(type) {
    switch (type) {
      case 'greenShell': return 0x2fff5a;
      case 'redShell': return 0xff2a2a;
      case 'banana': return 0xffe11a;
      case 'bobOmb': return 0xff5a3a;
      case 'fakeBox': return 0xff4d6a;
      case 'bulletBill': return 0x9fe8ff;
      default: return 0xffffff;
    }
  }

  /**
   * Sample the track surface height under a world point so a projectile rides the
   * hills/drops instead of floating at a fixed Y (which buried it underground on
   * the new terrain). Returns { groundY, s }. `yHint` + `sHint` carry the overpass
   * arc-length continuity so a shell on the LOWER road of an overpass stays on the
   * lower road rather than snapping to the deck above it.
   * @param {number} x
   * @param {number} z
   * @param {number} yHint  the projectile's current Y (height disambiguation)
   * @param {number|undefined} sHint  last arc-length param (continuity)
   * @returns {{ groundY:number, s:number }}
   * @private
   */
  _surfaceAt(x, z, yHint, sHint) {
    // BATTLE ARENA: the "track" is an Arena (flat floor, no trackId / surface
    // profile). sampleSurface(undefined,...) resolves to the DEFAULT circuit and
    // returns ITS hilly terrain height at the arena's coords — which spawned every
    // shell/banana dozens of metres above or below the flat arena floor, making
    // them INVISIBLE. A flat collider has no trackId, so detect that and ride the
    // floor (y = floorY, default 0) instead. This is the single height choke point,
    // so it fixes spawn AND per-frame flight for every projectile + trap at once.
    if (this.track && this.track.trackId == null) {
      const groundY = typeof this.track.floorY === 'number' ? this.track.floorY : 0;
      return { groundY, s: sHint || 0 };
    }
    const surf = sampleSurface(this.track.trackId, x, z, yHint, sHint);
    return { groundY: surf.groundY, s: surf.s };
  }

  /**
   * Build the ORBIT mesh pool: a small fixed set of meshes per appearance (green
   * shell / red shell / banana) that we lease to held-item rings each frame. We
   * pre-build a handful of each so a field of karts all holding a triple can be
   * shown without allocating mid-race. Each orbit slot points at a SHARED geo+mat
   * (the same singletons the projectiles use), so this is cheap on the GPU.
   * @returns {object} { pool: Array<{mesh,appearance,inUse}>, budget: number }
   * @private
   */
  _buildOrbitPool() {
    // 13 karts * up to 3 orbiting items would be 39 at the absolute max; pre-build
    // enough that a busy field never has to allocate. We make them lazily per
    // appearance on demand in _acquireOrbit, capped by this budget.
    const pool = []; // flat list of { mesh, appearance, inUse }
    return { pool, budget: 48 };
  }

  /**
   * Lease an orbit mesh of the given appearance (reusing a freed one first), or
   * build one (bounded by the budget) on first need. The mesh shares the matching
   * projectile geometry + material so a held green shell looks like a thrown one.
   * @param {string} appearance  'greenShell' | 'redShell' | 'banana'
   * @returns {THREE.Mesh|null}
   * @private
   */
  _acquireOrbit(appearance) {
    const store = this._orbits;
    // Reuse a freed orbit mesh of the SAME appearance first (true pooling).
    for (let i = 0; i < store.pool.length; i++) {
      const o = store.pool[i];
      if (!o.inUse && o.appearance === appearance) {
        o.inUse = true;
        return o.mesh;
      }
    }
    if (store.pool.length >= store.budget) return null; // budget hit: skip extras
    const asset = this._assets[appearance];
    const mesh = asset.build(); // a fresh Group over the SHARED geo/mat singletons
    mesh.visible = false;
    mesh.scale.setScalar(0.85); // held items ring a touch smaller than thrown ones
    this._applyItemShadows(mesh); // HIGH+: lit parts cast/receive shadows
    this.group.add(mesh);
    store.pool.push({ mesh, appearance, inUse: true });
    return mesh;
  }

  /**
   * Build the FX pool used for motion-trail puffs + a shared glow geometry.
   * Trail puffs are bright unlit additive planes (a fading ribbon of dots behind a
   * flying projectile). The glow geometry is shared by every projectile's halo.
   * @returns {object}
   * @private
   */
  _buildFxPool() {
    const glowGeo = new THREE.PlaneGeometry(2.6, 2.6); // soft halo around a hazard
    const trailGeo = new THREE.PlaneGeometry(1, 1);
    const trail = [];
    const TRAIL_POOL = 160; // plenty for several simultaneous flying projectiles
    for (let i = 0; i < TRAIL_POOL; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(trailGeo, material);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      trail.push({
        mesh, material, active: false,
        life: 0, maxLife: 1,
        startScale: 1, endScale: 1, startOpacity: 1,
      });
    }
    return { glowGeo, trailGeo, trail };
  }

  /**
   * Make a fresh glow-halo material (one per projectile slot, since each tints to
   * its own color). Additive + transparent so it blooms over the scene.
   * @returns {THREE.MeshBasicMaterial}
   * @private
   */
  _makeGlowMat() {
    return new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  /**
   * HIGH+ only: let a hazard's LIT body parts (the MeshStandard surfaces built by
   * `solid()` in _buildAssets) cast + receive shadows, so a thrown shell drops a
   * real little shadow on the road and catches the scene's light. The bright unlit
   * trims/halos (MeshBasic) are skipped — shadowing a self-lit glow looks wrong, and
   * on LOW/MED there are no lit parts at all so this whole method early-returns (no
   * cost). Done once per pooled mesh at build, never per frame.
   * @param {THREE.Object3D} mesh
   * @private
   */
  _applyItemShadows(mesh) {
    if (!this._litItems) return; // LOW/MED: unlit hazards, nothing to shadow
    mesh.traverse((o) => {
      if (o.isMesh && o.material && o.material.isMeshStandardMaterial) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /**
   * Find a recyclable pool slot for `type`, or create one if none is free.
   * A slot is reusable only if it's inactive AND already the right type (so its
   * mesh has the right geometry/material — we never swap a mesh's geo at runtime).
   * @param {string} type
   * @returns {object} a pool record ready to be (re)initialised.
   * @private
   */
  _acquire(type) {
    // Reuse a dead projectile of the SAME type first (true pooling).
    for (let i = 0; i < this._pool.length; i++) {
      const p = this._pool[i];
      if (!p.active && p.type === type) {
        return p;
      }
    }

    // None free: build a new mesh for this type ONCE and add it to the pool.
    const asset = this._assets[type];
    const mesh = asset.build(); // a fresh Group over the SHARED geo/mat singletons
    mesh.visible = false;
    this._applyItemShadows(mesh); // HIGH+: lit parts cast/receive shadows
    // THROW VISIBILITY: scale the whole hazard up a touch (uniformly — the parts are
    // pre-shaped at the right proportions now, so no per-axis stretch is needed) so a
    // thrown hazard reads as a chunky, trackable object.
    mesh.scale.setScalar(1.3);
    this.group.add(mesh);

    // GLOW HALO: a soft additive sprite that rides ON the projectile so it has a
    // bright bloom around it (you can pick it out against any background and track
    // incoming ones). One per pool slot, recycled with the slot. Tinted to match
    // the projectile color in spawn().
    const glow = new THREE.Mesh(this._fx.glowGeo, this._makeGlowMat());
    glow.visible = false;
    glow.renderOrder = 2;
    // Lay the halo flat in the ground plane so it reads as a bright light-pool
    // under the hazard from the chase camera (no per-frame billboarding needed,
    // and update() never receives the camera here — RaceManager calls update(dt,
    // karts)). It still blooms clearly around the floating mesh.
    glow.rotation.x = -Math.PI / 2;
    this.group.add(glow);

    const p = {
      mesh, glow, type, active: false,
      vx: 0, vz: 0, life: 0,
      ownerId: null, armDelay: 0,
      homing: false, exploder: false, targetId: null,
      cosmetic: false,
      // VISIBLE-ITEM fields (per the CONTRACT + the trackable-throw work):
      //   threat   true while this projectile is homing on / closing on a kart
      //            (Stream R's HUD reads .threat + .targetId to draw the warning).
      //   trailAccum  seconds since the last motion-trail puff (throttle).
      threat: false,
      trailAccum: 0,
      // Resting height ABOVE the sampled road surface. Flying hazards float at
      // PROJECTILE_Y; dropped static traps sit lower (TRAP_REST_Y) so they read as
      // settled on the track, not floating. Set per-spawn.
      restY: PROJECTILE_Y,
      // Overpass continuity hint for the surface sampler (which deck am I on).
      sHint: undefined,
    };
    this._pool.push(p);
    return p;
  }

  /**
   * Launch or drop a hazard.
   *
   * @param {string} type  'greenShell'|'redShell'|'banana'|'bobOmb'|'fakeBox'|'bulletBill'
   * @param {object} originState  firing kart state (reads x, z, heading, speed).
   * @param {object} [context]    { karts, ownerId, ownerProgress }.
   *        - karts: live karts (needed so a red shell / bullet can pick a target).
   *        - ownerId: the firing racer's id (so the projectile won't hit its owner
   *                   while it's still right on top of them).
   *        - ownerProgress: the owner's LapSystem progressScore, used to home a
   *                   red shell onto the nearest kart AHEAD of the owner.
   * @returns {object|null} the pool record used, or null for an unknown type.
   */
  spawn(type, originState, context = {}) {
    if (!this._assets[type]) return null; // unknown type: ignore safely

    const p = this._acquire(type);
    p.type = type;
    p.active = true;
    p.ownerId = context.ownerId ?? null;
    p.mesh.visible = true;
    p.homing = false;
    p.exploder = false;
    p.targetId = null;
    p.threat = false;     // re-resolved each frame by the threat scan in update()
    p.trailAccum = 0;     // start emitting a trail immediately
    p.restY = PROJECTILE_Y; // flying hazards float here; static traps lower it below
    // A cosmetic projectile flies and renders but never damages anyone on
    // contact (used for the blue-shell visual flourish, where the real hit is
    // applied deterministically elsewhere).
    p.cosmetic = context.cosmetic === true;

    // Forward + backward unit vectors from the firing kart's heading.
    const fx = Math.sin(originState.heading);
    const fz = Math.cos(originState.heading);

    // Default spawn just in front of the kart so it doesn't clip the firer.
    let spawnAhead = 2.0;
    // Brief window where the projectile can't hit anyone — lets it clear the
    // owner (and any pack right next to them) before arming.
    p.armDelay = 0.12;
    p.targetId = null;

    switch (type) {
      case 'greenShell': {
        // Flies straight along the kart's forward vector; bounces off bounds.
        p.vx = fx * SHELL_SPEED;
        p.vz = fz * SHELL_SPEED;
        p.life = SHELL_LIFE;
        break;
      }
      case 'redShell': {
        // Homes toward the nearest kart AHEAD of the owner. Initial velocity is
        // straight forward; update() steers it each frame.
        p.vx = fx * SHELL_SPEED;
        p.vz = fz * SHELL_SPEED;
        p.life = RED_SHELL_LIFE;
        p.homing = true;
        p.targetId = this._pickTargetAhead(context, originState);
        break;
      }
      case 'bulletBill': {
        // A fast straight rocket. Picks a target ahead too, but we keep it simple
        // and straight-fast (homing flag off) so it just blasts forward; it still
        // collides with anyone in its path. Faster + bigger hit feel.
        p.vx = fx * BULLET_SPEED;
        p.vz = fz * BULLET_SPEED;
        p.life = BULLET_LIFE;
        break;
      }
      case 'bobOmb': {
        // Travels forward briefly, then explodes (area spin). Slower than a shell.
        p.vx = fx * SHELL_SPEED * 0.7;
        p.vz = fz * SHELL_SPEED * 0.7;
        p.life = BOBOMB_TRAVEL;
        p.exploder = true;
        break;
      }
      case 'banana':
      case 'fakeBox': {
        // Dropped BEHIND the kart and left static as a trap. No velocity, so it
        // settles at the drop spot and rides the road surface for its whole life.
        p.vx = 0;
        p.vz = 0;
        p.life = STATIC_LIFE;
        p.restY = TRAP_REST_Y; // sit low on the track — dropped here, not floating
        spawnAhead = -2.5; // place it behind the firer
        p.armDelay = 0.0;  // a dropped trap is dangerous immediately to others
        break;
      }
      default:
        // Unreachable (guarded above) but keep the switch total.
        p.active = false;
        p.mesh.visible = false;
        return null;
    }

    // Position the mesh at the spawn point — RIDING the track surface. We sample
    // the heightfield under the spawn point (seeded with the firer's own arc-length
    // hint so an overpass deck is disambiguated) and float the hazard PROJECTILE_Y
    // above it. Without this the shell spawned at a fixed Y=0.6 and, on the new
    // 58–144m terrain, was born dozens of metres under the road = invisible.
    const sx = originState.x + fx * spawnAhead;
    const sz = originState.z + fz * spawnAhead;
    const surf = this._surfaceAt(sx, sz, originState.y, originState.lastS);
    p.sHint = surf.s;
    p.mesh.position.set(sx, surf.groundY + p.restY, sz);

    // DROP/SETTLE VFX: a quick ground puff where a static trap is dropped, so it
    // reads as "placed here" rather than blinking into existence mid-air.
    if (p.vx === 0 && p.vz === 0) {
      this._emitSettle(sx, surf.groundY, sz, this._colorFor(type));
    }

    // GLOW HALO: tint to the projectile color, park it on the mesh, switch it on.
    // Bananas/fake boxes are static traps — a faint glow is plenty; flying hazards
    // get a brighter bloom so they're easy to track. The halo sits just above the
    // sampled surface (not a fixed world Y) so it pools on the road under the hazard.
    p.glow.material.color.setHex(this._colorFor(type));
    p.glow.material.opacity = (p.vx !== 0 || p.vz !== 0) ? 0.6 : 0.32;
    p.glow.position.set(sx, surf.groundY + 0.06, sz);
    p.glow.visible = true;

    return p;
  }

  /**
   * Choose the nearest kart that is AHEAD of the owner for a red shell.
   * "Ahead" is decided by LapSystem progressScore when available; if context has
   * no progress info we fall back to the nearest kart that isn't the owner.
   * @param {object} context  { karts, ownerId, ownerProgress }
   * @param {object} originState  firing kart state (for distance tie-breaks)
   * @returns {*} the chosen racer id, or null if there is no valid target.
   * @private
   */
  _pickTargetAhead(context, originState) {
    const karts = context.karts;
    if (!karts || karts.length === 0) return null;

    const ownerId = context.ownerId ?? null;
    const ownerProgress = context.ownerProgress; // may be undefined

    // Forward vector of the firing kart — the cone the shell launches into.
    const fx = Math.sin(originState.heading);
    const fz = Math.cos(originState.heading);

    let bestId = null;
    let bestD2 = Infinity;

    for (let i = 0; i < karts.length; i++) {
      const kart = karts[i];
      const s = kart && kart.state;
      if (!s) continue;
      if (kart.id === ownerId) continue; // never target yourself

      // If we know progress scores, only consider karts strictly ahead.
      if (ownerProgress != null && kart.progressScore != null) {
        if (kart.progressScore <= ownerProgress) continue;
      }

      // FORWARD CONE: only lock onto a kart that lies within ±60° of where we're
      // pointing, so the missile chases the road ahead rather than whipping around
      // to a kart beside/behind us. dot(forward, toKart_unit) >= RED_CONE_COS.
      const dx = s.x - originState.x;
      const dz = s.z - originState.z;
      const d2 = dx * dx + dz * dz;
      const dist = Math.sqrt(d2) || 1;
      if ((dx * fx + dz * fz) / dist < RED_CONE_COS) continue;

      // Among the eligible, chase the closest one.
      if (d2 < bestD2) {
        bestD2 = d2;
        bestId = kart.id;
      }
    }

    // If progress filtering left nobody (owner is in the lead), fall back to the
    // nearest kart at all so a red shell still does something.
    if (bestId == null) {
      for (let i = 0; i < karts.length; i++) {
        const kart = karts[i];
        const s = kart && kart.state;
        if (!s || kart.id === ownerId) continue;
        const dx = s.x - originState.x;
        const dz = s.z - originState.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestId = kart.id; }
      }
    }

    return bestId;
  }

  /**
   * Per-frame simulation: move every active projectile, steer homing shells,
   * bounce green shells off the track bounds, and test collisions vs each kart.
   *
   * @param {number} dt  timestep in seconds.
   * @param {Array} karts  the live karts; each must expose .id and .state
   *        (with x, z, plus the fields the mutators read: starTimer/spinTimer).
   */
  update(dt, karts) {
    for (let i = 0; i < this._pool.length; i++) {
      const p = this._pool[i];
      if (!p.active) continue; // dead slot: skip (this is the recycling in action)

      // Tick lifetime + arming window.
      p.life -= dt;
      if (p.armDelay > 0) p.armDelay -= dt;

      // Red-shell homing: curve the velocity toward the current target's
      // position. We rotate the velocity vector toward the target by at most
      // RED_HOMING_TURN*dt radians so the turn is smooth, not instant.
      if (p.homing) {
        this._steerHoming(p, dt, karts);
      }

      // Integrate position for anything with velocity (static drops have v=0).
      if (p.vx !== 0 || p.vz !== 0) {
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.z += p.vz * dt;

        // Spin the mesh as it travels so it reads as a rolling/tumbling shell.
        // Cheap cosmetic; a combined pitch + yaw makes the motion obvious.
        p.mesh.rotation.x += 8 * dt;
        p.mesh.rotation.y += 5 * dt;

        // TRACKABLE THROW: drop a bright fading trail puff on a throttle so the
        // player can SEE where the shell went (and read incoming ones). A threat
        // projectile pulses its trail bigger/brighter so it screams "dodge".
        p.trailAccum += dt;
        if (p.trailAccum >= TRAIL_INTERVAL) {
          p.trailAccum = 0;
          this._emitTrail(p);
        }

        // Green shells bounce off the track bounds. We use isOnRoad as a cheap
        // boundary: if the new spot is off the road, reflect the velocity. We
        // figure out which axis to flip by probing each axis independently.
        if (p.type === 'greenShell' && !this.track.isOnRoad(p.mesh.position.x, p.mesh.position.z)) {
          this._bounceOffBounds(p, dt);
        }

        // Bullet bill and red shell simply expire if they wander off the road
        // (no bounce — they're not meant to ping-pong like a green shell).
        else if (
          (p.type === 'bulletBill' || p.type === 'redShell') &&
          !this.track.isOnRoad(p.mesh.position.x, p.mesh.position.z)
        ) {
          // Don't kill instantly on a single off-road sample (curves clip the
          // band briefly); only expire if life is also nearly done. Otherwise
          // nudge it back toward the centerline isn't worth the cost — just let
          // lifetime handle it. Keep it simple: continue.
        }
      } else {
        // Static drops (banana / fake box) get a slow spin so they catch the eye.
        p.mesh.rotation.y += 1.5 * dt;
      }

      // SURFACE FOLLOW: ride the hill/drop under the hazard. Sample the heightfield
      // at the hazard's CURRENT (post-move/post-bounce) x,z — seeded with its own Y
      // + arc-length hint for overpass continuity — and float it PROJECTILE_Y above
      // the road. This is what makes a thrown shell visible on the new terrain (it
      // used to sit at a fixed Y, i.e. buried under or floating above the road).
      const gsurf = this._surfaceAt(p.mesh.position.x, p.mesh.position.z, p.mesh.position.y, p.sHint);
      p.sHint = gsurf.s;
      p.mesh.position.y = gsurf.groundY + p.restY;

      // Keep the glow halo parked under the (now-moved) hazard so its light-pool
      // tracks the object. Sits flat just above the sampled surface (not a fixed Y).
      p.glow.position.set(p.mesh.position.x, gsurf.groundY + 0.06, p.mesh.position.z);

      // Expiry: lifetime ran out. Bob-ombs explode (area spin) on expiry.
      if (p.life <= 0) {
        if (p.exploder) this._explode(p, karts);
        this._recycle(p);
        continue;
      }

      // Collision vs karts (skip during the arm delay so it can't hit its owner
      // point-blank on spawn). Cosmetic projectiles never collide — they are
      // visual-only and their effect is applied deterministically elsewhere.
      if (p.armDelay <= 0 && !p.cosmetic) {
        this._collide(p, karts);
      }
    }

    // DODGE TELEGRAPH: flag projectiles that are closing on a kart as threats so
    // the HUD can warn the player (Stream R reads .threat + .targetId). Runs after
    // movement so it sees this frame's positions.
    this._scanThreats(karts);

    // HELD-ITEM ORBITS: ring + spin the items any kart is holding (the shield
    // visual). Reads kart.state.heldOrbitId / heldOrbitCount per the CONTRACT.
    this._updateOrbits(dt, karts);

    // Advance the pooled motion-trail puffs (fade + shrink + sleep).
    this._stepFx(dt);
  }

  /**
   * Steer a homing projectile's velocity toward its target this frame.
   * Re-resolves the target if the stored one disappeared.
   * @private
   */
  _steerHoming(p, dt, karts) {
    // Resolve the target kart by id.
    let target = null;
    for (let i = 0; i < karts.length; i++) {
      if (karts[i] && karts[i].id === p.targetId) { target = karts[i]; break; }
    }
    // Lost target (id gone): keep flying straight, and DROP the threat flag so a
    // stale warning doesn't linger (collision still applies). _scanThreats skips
    // homers, so we own the homer's flag here.
    if (!target || !target.state) { p.threat = false; return; }

    // A homing shell with a live target IS a threat to that kart — flag it so the
    // HUD warning can read .threat + .targetId (the broader _scanThreats pass also
    // catches straight projectiles closing in; this guarantees the homer is armed).
    p.threat = true;

    const tx = target.state.x;
    const tz = target.state.z;
    const px = p.mesh.position.x;
    const pz = p.mesh.position.z;

    // Desired heading toward the target.
    const desired = Math.atan2(tx - px, tz - pz); // (sin,cos) convention: atan2(dx,dz)
    // Current velocity heading.
    const current = Math.atan2(p.vx, p.vz);

    // Smallest signed angle from current -> desired, wrapped to [-PI, PI].
    let delta = desired - current;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    // Clamp the turn this frame so it curves rather than snaps.
    const maxTurn = RED_HOMING_TURN * dt;
    if (delta > maxTurn) delta = maxTurn;
    else if (delta < -maxTurn) delta = -maxTurn;

    const newHeading = current + delta;
    p.vx = Math.sin(newHeading) * SHELL_SPEED;
    p.vz = Math.cos(newHeading) * SHELL_SPEED;
  }

  /**
   * Reflect a green shell's velocity when it leaves the road band. We undo the
   * step, probe each axis to learn which direction crossed the boundary, and
   * flip that axis's velocity component.
   * @private
   */
  _bounceOffBounds(p, dt) {
    // Step back to the last on-road position before reflecting.
    p.mesh.position.x -= p.vx * dt;
    p.mesh.position.z -= p.vz * dt;

    // Probe: would moving only in X have stayed on road? Only in Z?
    const tryX = p.mesh.position.x + p.vx * dt;
    const tryZ = p.mesh.position.z + p.vz * dt;
    const xOk = this.track.isOnRoad(tryX, p.mesh.position.z);
    const zOk = this.track.isOnRoad(p.mesh.position.x, tryZ);

    // Flip the axis (or axes) that would take us off-road. If both fail (a
    // corner), flip both — the shell ricochets back the way it came.
    if (!xOk) p.vx = -p.vx;
    if (!zOk) p.vz = -p.vz;
    if (xOk && zOk) { p.vx = -p.vx; p.vz = -p.vz; } // ambiguous: full reverse

    // Re-apply one step with the corrected velocity so it doesn't sit stuck.
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.z += p.vz * dt;
  }

  /**
   * Direct-contact collision: if any kart is within HIT_RADIUS, spin it out
   * (unless invincible) and consume the projectile. Bananas pop on contact.
   * @private
   */
  _collide(p, karts) {
    const px = p.mesh.position.x;
    const pz = p.mesh.position.z;

    for (let k = 0; k < karts.length; k++) {
      const kart = karts[k];
      const s = kart && kart.state;
      if (!s) continue;
      // A projectile never hits its own owner.
      if (kart.id === p.ownerId) continue;

      const dx = s.x - px;
      const dz = s.z - pz;
      // Vertical gate: ignore karts on a different deck/level (overpass, loop) even
      // if they line up in XZ, so a lower-road shell can't reach an upper-road kart.
      if (Math.abs((s.y || 0) - p.mesh.position.y) > VERTICAL_HIT) continue;
      if (dx * dx + dz * dz <= HIT_R2) {
        // SHIELD: a kart holding an orbit-able item (kart.state.shield, set by
        // Stream R) is protected. The incoming projectile is DESTROYED, we raise
        // shieldHitPending (Stream R clears the held item / orbit next tick), pop
        // a "clink" flash, and SKIP the spin entirely. The shield does NOT block a
        // bob-omb's area blast (only the direct contact) — that still happens via
        // the explosion path elsewhere; here we just spare this one direct hit.
        if (s.shield === true) {
          s.shieldHitPending = true;
          this._emitClink(s);
          this._recycle(p);
          return; // blocked: the projectile is spent, no spin
        }

        // Apply the spin UNLESS the target is invincible (star, etc.). The
        // invincibility check + the spin both live in the shared kart model so
        // the server reproduces the outcome identically.
        if (!isInvincible(s)) {
          applySpin(s, SPIN_SECS);
        }

        // VFX: a sharp spark burst at the hit point, tinted to the hazard's colour
        // (a bob-omb instead pushes its bigger explosion via _explode below).
        if (!p.exploder) {
          this.fxEvents.push({ type: 'impact', x: px, y: p.mesh.position.y, z: pz, color: this._colorFor(p.type) });
        }

        // Bob-omb that touches a kart explodes (area effect) instead of a single
        // spin; the direct target is caught by the explosion too.
        if (p.exploder) {
          this._explode(p, karts);
        }

        // Consume the projectile. Bananas/fake boxes pop on contact; shells and
        // bullets are also spent on a hit (one-shot). Everything recycles.
        this._recycle(p);
        return; // this projectile is done
      }
    }
  }

  /**
   * Bob-omb area explosion: spin every (non-invincible) kart within
   * EXPLOSION_RADIUS. The owner is NOT spared by an explosion (classic bob-omb
   * can catch the thrower if they're too close).
   * @private
   */
  _explode(p, karts) {
    const px = p.mesh.position.x;
    const pz = p.mesh.position.z;
    // VFX: a bob-omb fireball + shockwave at the blast point (rendered by main.js).
    this.fxEvents.push({ type: 'explosion', x: px, y: p.mesh.position.y, z: pz });
    for (let k = 0; k < karts.length; k++) {
      const kart = karts[k];
      const s = kart && kart.state;
      if (!s) continue;
      const dx = s.x - px;
      const dz = s.z - pz;
      if (Math.abs((s.y || 0) - p.mesh.position.y) > VERTICAL_HIT) continue;
      if (dx * dx + dz * dz <= EXPLOSION_R2) {
        if (!isInvincible(s)) {
          applySpin(s, EXPLOSION_SPIN_SECS);
        }
      }
    }
    // (A real explosion VFX/flash would be triggered here by the FX layer; we
    // only own the projectile object, so we just recycle in the caller.)
  }

  /**
   * Return a projectile to the pool: deactivate + hide. We DON'T remove the mesh
   * from the group or free anything — that's the whole point of pooling. The next
   * spawn() of this type will find this dead slot and reuse it.
   * @private
   */
  _recycle(p) {
    p.active = false;
    p.homing = false;
    p.exploder = false;
    p.targetId = null;
    p.threat = false;
    p.vx = 0;
    p.vz = 0;
    p.mesh.visible = false;
    p.glow.visible = false;
  }

  // ===========================================================================
  // VISIBLE-ITEM SYSTEMS (orbits, threat scan, trail/clink FX)
  // ===========================================================================

  /**
   * Render the held-item ORBITS: for every kart whose kart.state.heldOrbitId is an
   * orbit-able id, ring kart.state.heldOrbitCount matching meshes around it, spin
   * them, and bob them. Reuses pooled meshes (leased per kart) so a kart keeps the
   * SAME meshes frame to frame and we never allocate mid-race. Hidden when a kart's
   * heldOrbitId is null. Reads only kart.state (x/y/z/heading + the orbit fields)
   * per the CONTRACT — it never mutates kart state.
   * @param {number} dt  timestep (advances the shared orbit angle).
   * @param {Array} karts
   * @private
   */
  _updateOrbits(dt, karts) {
    // Free every leased orbit mesh up front; karts that still hold an item re-lease
    // below. Cheap (the pool is tiny) and keeps the logic obviously correct: any
    // mesh not re-claimed this frame ends up hidden.
    const pool = this._orbits.pool;
    for (let i = 0; i < pool.length; i++) {
      pool[i].inUse = false;
      pool[i].mesh.visible = false;
    }

    if (!karts || karts.length === 0) return;

    // One shared, ever-advancing angle so all rings spin in sync (and we don't have
    // to store per-kart phase). Bob uses the same clock.
    this._orbitClock = (this._orbitClock || 0) + dt;
    const baseA = this._orbitClock * ORBIT_SPEED;
    const spin = this._orbitClock * ORBIT_SPIN;

    for (let k = 0; k < karts.length; k++) {
      const kart = karts[k];
      const s = kart && kart.state;
      if (!s) continue;

      const id = s.heldOrbitId;
      if (!id) continue; // no orbit-able item held -> nothing to ring
      const appearance = ORBIT_APPEARANCE[id];
      if (!appearance) continue; // not an orbit-able id (defensive)

      let count = s.heldOrbitCount || 1;
      if (count < 1) count = 1;
      if (count > 3) count = 3; // triples cap at 3

      for (let n = 0; n < count; n++) {
        const mesh = this._acquireOrbit(appearance);
        if (!mesh) break; // budget exhausted: skip extras gracefully

        // Evenly space the items around the ring, offset by the shared angle.
        const a = baseA + (n / count) * Math.PI * 2;
        const ox = Math.cos(a) * ORBIT_RADIUS;
        const oz = Math.sin(a) * ORBIT_RADIUS;
        const bob = Math.sin(this._orbitClock * 3 + n) * ORBIT_BOB;
        mesh.position.set(s.x + ox, (s.y || 0) + ORBIT_Y + bob, s.z + oz);
        mesh.rotation.x = spin;
        mesh.rotation.y = spin * 0.7;
        mesh.visible = true;
      }

      // ORBIT-SHIELD CONTACT: any OTHER kart that brushes the orbiting ring gets
      // spun out, and this holder's orbit item is consumed. We test the holder's
      // CENTRE distance (phase-free + deterministic) so Room.js mirrors it exactly
      // for MP. Consumption rides the existing shield handshake: setting
      // shieldHitPending makes the item manager clear the held item next tick
      // (which empties heldOrbitId, so the ring disappears).
      this._orbitHit(kart, karts);
    }
  }

  /**
   * Deterministic orbit-shield hit: spin the first rival within ORBIT_HIT_DIST of
   * `holder` (unless invincible) and consume the holder's orbit item. Mirrored on
   * the server (Room._updateOrbitShields) with identical numbers so MP agrees.
   * @param {object} holder  the orbit-holding kart record.
   * @param {Array} karts
   * @private
   */
  _orbitHit(holder, karts) {
    const hs = holder.state;
    for (let j = 0; j < karts.length; j++) {
      const other = karts[j];
      const os = other && other.state;
      if (!os) continue;
      if (other.id === holder.id) continue; // your own orbit never hits you
      // Same-deck gate: don't reach a kart on a different overpass/loop level.
      if (Math.abs((os.y || 0) - (hs.y || 0)) > VERTICAL_HIT) continue;
      const dx = os.x - hs.x;
      const dz = os.z - hs.z;
      if (dx * dx + dz * dz > ORBIT_HIT_R2) continue;

      if (!isInvincible(os)) applySpin(os, ORBIT_SPIN_SECS);
      // Consume the holder's orbiting item (the shield handshake clears it next tick).
      hs.shieldHitPending = true;
      this.fxEvents.push({
        type: 'impact', x: os.x, y: (os.y || 0) + 0.6, z: os.z,
        color: this._colorFor(ORBIT_APPEARANCE[hs.heldOrbitId] || 'banana'),
      });
      return; // one rival per holder per frame
    }
  }

  /**
   * DODGE TELEGRAPH scan: any active, damaging projectile within THREAT_RADIUS of a
   * kart AND closing on it (moving toward it) is a threat to that kart. We set
   * p.threat = true + p.targetId = <kartId> so Stream R's HUD can draw a directional
   * incoming-warning (and the trail pulses). Static traps + cosmetic/owner-only
   * projectiles don't telegraph. Homing shells are already flagged in _steerHoming;
   * this catches fast straight shots (green shell / bullet) bearing down too.
   * @param {Array} karts
   * @private
   */
  _scanThreats(karts) {
    if (!karts || karts.length === 0) return;
    for (let i = 0; i < this._pool.length; i++) {
      const p = this._pool[i];
      if (!p.active || p.cosmetic) continue;
      // Homers keep the flag they set while steering; only (re)scan non-homers and
      // confirm homers still have a target. Static drops (no velocity) never close.
      if (p.homing) continue; // already handled in _steerHoming
      if (p.vx === 0 && p.vz === 0) { p.threat = false; continue; }

      const px = p.mesh.position.x;
      const pz = p.mesh.position.z;
      let found = false;
      for (let k = 0; k < karts.length; k++) {
        const kart = karts[k];
        const s = kart && kart.state;
        if (!s || kart.id === p.ownerId) continue;
        const dx = s.x - px;
        const dz = s.z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 > THREAT_R2) continue;
        // Closing test: is the projectile's velocity pointing toward this kart?
        // dot(velocity, toKart) > 0 means it's heading in, not already past.
        if (p.vx * dx + p.vz * dz <= 0) continue;
        p.threat = true;
        p.targetId = kart.id;
        found = true;
        break;
      }
      if (!found) { p.threat = false; p.targetId = null; }
    }
  }

  /**
   * Emit one motion-trail puff at a projectile's CURRENT position, tinted to its
   * color (threats pulse bigger + whiter so they read as "incoming!"). Pooled.
   * @param {object} p  the projectile pool record.
   * @private
   */
  _emitTrail(p) {
    const fx = this._acquireTrail();
    if (!fx) return;
    const threat = p.threat === true;
    fx.active = true;
    fx.mesh.visible = true;
    // Threat puffs flash toward white (danger) and run bigger; normal trails take
    // the projectile's own color so you can tell whose/what shell it is.
    fx.material.color.setHex(threat ? 0xffffff : this._colorFor(p.type));
    fx.material.opacity = threat ? 0.95 : 0.8;
    fx.startOpacity = fx.material.opacity;
    fx.maxLife = TRAIL_LIFE;
    fx.life = TRAIL_LIFE;
    fx.startScale = threat ? 1.9 : 1.3;
    fx.endScale = 0.05; // shrink to a dot as it fades = a tapering ribbon
    fx.mesh.scale.setScalar(fx.startScale);
    fx.mesh.position.copy(p.mesh.position);
    // Lay flat in the ground plane (same reason as the glow: no camera here).
    fx.mesh.rotation.x = -Math.PI / 2;
  }

  /**
   * Emit a quick "clink" flash where a shield blocked a hit: a bright expanding
   * white/cyan ring at the protected kart so the block reads clearly. Pooled.
   * @param {object} state  the shielded kart's state ({x,y,z}).
   * @private
   */
  _emitClink(state) {
    const fx = this._acquireTrail();
    if (!fx) return;
    fx.active = true;
    fx.mesh.visible = true;
    fx.material.color.setHex(0xbfefff); // icy clink flash
    fx.material.opacity = 1;
    fx.startOpacity = 1;
    fx.maxLife = 0.3;
    fx.life = 0.3;
    fx.startScale = 1.2;
    fx.endScale = 4.5; // snap outward like a deflection shockwave
    fx.mesh.scale.setScalar(fx.startScale);
    fx.mesh.position.set(state.x, (state.y || 0) + 0.9, state.z);
    fx.mesh.rotation.x = -Math.PI / 2;
  }

  /**
   * Emit a quick "settle" puff where a trap was just dropped: a flat ground ring,
   * tinted to the trap colour, that expands + fades over ~0.3s so the drop reads as
   * "placed here". Reuses the pooled trail meshes (same discipline as _emitClink).
   * @param {number} x @param {number} groundY @param {number} z @param {number} color
   * @private
   */
  _emitSettle(x, groundY, z, color) {
    const fx = this._acquireTrail();
    if (!fx) return;
    fx.active = true;
    fx.mesh.visible = true;
    fx.material.color.setHex(color);
    fx.material.opacity = 0.85;
    fx.startOpacity = 0.85;
    fx.maxLife = 0.3;
    fx.life = 0.3;
    fx.startScale = 0.4;
    fx.endScale = 2.6; // spread outward on the ground like kicked-up dust
    fx.mesh.scale.setScalar(fx.startScale);
    fx.mesh.position.set(x, groundY + 0.08, z);
    fx.mesh.rotation.x = -Math.PI / 2; // lay flat on the road
  }

  /**
   * Find a free trail-FX slot, or null if the pool is busy (we then drop the puff
   * rather than allocate). Same pooling discipline as the projectiles.
   * @returns {object|null}
   * @private
   */
  _acquireTrail() {
    const trail = this._fx.trail;
    for (let i = 0; i < trail.length; i++) {
      if (!trail[i].active) return trail[i];
    }
    return null;
  }

  /**
   * Advance every awake trail/clink puff: shrink, fade, sleep when expired. No
   * allocation. Called once per frame from update().
   * @param {number} dt
   * @private
   */
  _stepFx(dt) {
    const trail = this._fx.trail;
    for (let i = 0; i < trail.length; i++) {
      const fx = trail[i];
      if (!fx.active) continue;
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.active = false;
        fx.mesh.visible = false;
        continue;
      }
      const lifeFraction = fx.life / fx.maxLife; // 1 -> 0
      const age = 1 - lifeFraction;
      const scale = fx.startScale + (fx.endScale - fx.startScale) * age;
      fx.mesh.scale.setScalar(scale);
      fx.material.opacity = lifeFraction * fx.startOpacity;
    }
  }

  /**
   * Free every geometry/material/texture this system built and detach its group. A
   * fresh ProjectileSystem is constructed each race, so its ~40 asset singletons,
   * 160-plane trail pool, per-projectile glow materials and orbit-pool meshes are
   * all owned here and were previously orphaned in GPU memory on every race/battle
   * restart (RaceManager.dispose already guards `typeof projectiles.dispose ===
   * 'function'` — this makes that call do real work).
   *
   * Everything the pool ever instantiated stays parented to `this.group` (projectiles
   * and their glows are pooled, never removed), so one traverse frees the bulk. We
   * then dispose the two shared FX geometries directly and build each asset factory
   * once so the eager, closure-captured singletons of any type that never SPAWNED
   * this race also become reachable and get freed. A Set dedups all overlap.
   */
  dispose() {
    const seenG = new Set();
    const seenM = new Set();
    const disposeMat = (m) => {
      if (!m || seenM.has(m)) return;
      seenM.add(m);
      for (const k of ['map', 'emissiveMap', 'alphaMap']) {
        const tex = m[k];
        if (tex && typeof tex.dispose === 'function') tex.dispose();
      }
      if (typeof m.dispose === 'function') m.dispose();
    };
    const disposeGeo = (g) => {
      if (g && !seenG.has(g) && typeof g.dispose === 'function') { seenG.add(g); g.dispose(); }
    };
    const walk = (root) => {
      if (!root || typeof root.traverse !== 'function') return;
      root.traverse((o) => {
        disposeGeo(o.geometry);
        const mat = o.material;
        if (Array.isArray(mat)) mat.forEach(disposeMat);
        else disposeMat(mat);
      });
    };
    // Active + pooled projectiles, their glows, the 160 trail planes, orbit meshes.
    walk(this.group);
    // The two shared FX geometries (trailGeo is reached above via the trail meshes;
    // glowGeo only if a projectile ever spawned — dispose both directly to be sure).
    if (this._fx) { disposeGeo(this._fx.glowGeo); disposeGeo(this._fx.trailGeo); }
    // Eager singletons of types that never spawned: build each factory once so its
    // captured geo/mat become reachable, then free them (already-seen ones are skipped).
    if (this._assets) {
      for (const key of Object.keys(this._assets)) {
        try { walk(this._assets[key].build()); } catch (_) { /* dormant/edge factory */ }
      }
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
