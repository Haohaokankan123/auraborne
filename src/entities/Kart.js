// src/entities/Kart.js
//
// Builds a NEON-ARCADE racing kart. Two construction paths share one public API:
//
//   1) PROCEDURAL (default + fallback — THIS IS WHAT SHIPS TODAY): every part
//      (low sleek chassis, rounded hood, scooped cockpit + seat, side pods,
//      a helmeted driver with arms/hands on a steering wheel, rimmed wheels,
//      glowing underglow + neon trim) is made from primitive geometries, so the
//      game runs with zero asset loading. The body color reads as a real
//      colored vehicle — the emissive accents are kept LOW (see
//      _glowBaseIntensity) so the kart never blooms to a white blob.
//   2) PRELOADED MODEL (optional): if a real glTF kart has been preloaded and
//      registered via `Kart.setSharedModel(scene)`, OR passed in as
//      `new Kart({ model })`, the kart CLONES that cached scene, tints it to the
//      body color, and overlays procedural wheels so the existing wheel/steer
//      animation still works. If anything is missing it silently falls back to
//      the procedural kart, so the game never breaks.
//
// The Kart owns a THREE.Group ("group"). All visual parts are children of
// that group, so moving/rotating the group moves the whole kart at once.
//
// Coordinate / convention reminders (must match the rest of the project):
//   - Y is up. The track lies in the XZ plane. World units = meters.
//   - Forward vector = (sin(heading), 0, cos(heading)).
//   - The kart mesh sets mesh.rotation.y = heading (done in syncFromState).
//   - "Local forward" of this kart model is the +Z axis. We build the kart
//     facing +Z so that when group.rotation.y = heading, the front of the
//     kart points along the forward vector above.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  getBodyById,
  getBodyByIndex,
} from '../data/karts.js';
import {
  getCharacterById,
  getCharacterByIndex,
} from '../data/characters.js';
// QUALITY TIER: scales how strongly the kart's PBR materials sample the environment
// reflection (0 LOW = none, 1.0 MED = today, glossier on HIGH/ULTRA) and gates a
// clear-coat body polish on HIGH+. Read once per kart at build time.
import qualitySettings from '../core/QualitySettings.js';
// ANTI-GRAV: the PURE shared surface-frame helper. When a kart is inside a
// wall/ceiling section we build its FULL orientation (not just yaw) from this so it
// visibly rides the wall/ceiling. Render-only; never feeds back into the sim.
import { surfaceFrameAt, sampleSurface } from '../../shared/trackData.js';

// ---------------------------------------------------------------------------
// Soft CONTACT SHADOW texture — a radial dark→transparent blob, built ONCE and
// shared by every kart. The real sun shadow map is subtle on the emissive neon
// road (and off entirely on LOW), so a cheap baked-in contact decal under each
// kart is what actually GROUNDS it on screen at every quality tier. One small
// canvas texture, no per-frame cost.
// ---------------------------------------------------------------------------
let _contactShadowTexture = null;
function getContactShadowTexture() {
  if (_contactShadowTexture) return _contactShadowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  // Dense at the core (right under the chassis), feathered to nothing at the rim
  // so the edge never shows a hard circle — reads as a soft ambient-occlusion pool.
  grad.addColorStop(0.0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1.0, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _contactShadowTexture = tex;
  return tex;
}

// ---------------------------------------------------------------------------
// Body-archetype defaults.
//
// Each KART_BODIES entry carries a partial `geometry` recipe (see karts.js).
// We merge it over these defaults so a body that omits a field still builds a
// complete kart, and so a body passed in with NO geometry at all still works.
// All linear fields are MULTIPLIERS on the base dimensions used below — 1.0 is
// the original sleek-racer kart, exactly as it shipped before visual variety.
// ---------------------------------------------------------------------------
const BODY_DEFAULTS = {
  chassisW: 1.0, chassisH: 1.0, chassisL: 1.0, round: 1.0,
  wheelScale: 1.0, trackW: 1.0, hoodScale: 1.0, noseLen: 1.0,
  noseShape: 'wedge', rear: 'ducktail', fins: false, sidePods: true,
  accent: 'stripe', rideHeight: 1.0,
};

// Driver-look defaults (merged over each character's partial `look`). 1.0 is
// the original driver. Keeps the model path / any character without a look
// rendering the unchanged baseline driver.
const LOOK_DEFAULTS = {
  helmet: 'round', helmetScale: 1.0, build: 1.0,
  accent: 0xe6e8ef, visor: 0x35e0ff,
};

// ---------------------------------------------------------------------------
// Shared, color-independent geometry — now keyed PER BODY ARCHETYPE.
//
// Geometry is identical for every kart of the SAME archetype, so we build each
// archetype's geometry set ONCE (lazily) and share it across all karts of that
// archetype. With five archetypes that is at most five cached sets for the whole
// 13-kart field — still cheap on memory + GPU upload, while letting different
// bodies have genuinely different dimensions (not just recolors). Only MATERIALS
// stay per-kart (each kart is painted its own body color).
// ---------------------------------------------------------------------------
const _geoCache = new Map(); // bodyId -> geometry set

/**
 * Build (and cache) the geometry set for one body archetype. The `g` recipe
 * (BODY_DEFAULTS merged with the body's geometry) scales each primitive so the
 * silhouette changes per archetype. Base numbers are the original kart's dims.
 * @param {string} cacheKey  - stable key to cache under (the body id).
 * @param {Object} g         - resolved geometry recipe (defaults already merged).
 * @returns {Object} geometry set
 */
function getArchetypeGeometry(cacheKey, g) {
  const cached = _geoCache.get(cacheKey);
  if (cached) return cached;

  // Base chassis dims (original kart), scaled by the archetype multipliers.
  const cw = 1.18 * g.chassisW;
  const ch = 0.30 * g.chassisH;
  const cl = 2.10 * g.chassisL;
  const bevel = 0.16 * g.round;

  const set = {
    // --- CHASSIS -------------------------------------------------------------
    // The main tub, scaled per archetype (width/height/length + bevel).
    chassis: new RoundedBoxGeometry(cw, ch, cl, 5, Math.max(0.04, bevel)),
    // Rounded "hood" pod over the front axle. Scaled by hoodScale (0 => omitted
    // by the builder, but we still create a tiny geo so the field always exists).
    hood: new RoundedBoxGeometry(
      0.98 * g.chassisW, 0.26 * g.chassisH, 0.78 * Math.max(0.2, g.hoodScale),
      5, Math.max(0.04, 0.13 * g.round)),
    // Scooped cockpit floor the driver sits in (inset, dark). Width follows the
    // chassis so the cockpit fits wide/narrow bodies.
    cockpit: new RoundedBoxGeometry(0.86 * g.chassisW, 0.24, 0.92, 5, 0.11),
    // Raised seat back behind the driver.
    seat: new RoundedBoxGeometry(0.72 * g.chassisW, 0.46, 0.20, 4, 0.09),
    // Lower, wider underglow skirt — tracks chassis width + length.
    skirt: new RoundedBoxGeometry(1.30 * g.chassisW, 0.14, 1.94 * g.chassisL, 4, 0.06),
    // Side neon trim strip — length tracks chassis length.
    trim: new RoundedBoxGeometry(0.05, 0.08, 1.78 * g.chassisL, 3, 0.03),
    // Side engine pods over each rear wheel.
    sidePod: new RoundedBoxGeometry(0.30, 0.22 * g.chassisH, 0.92, 4, 0.09),
    // --- NOSE (three silhouettes) --------------------------------------------
    // 'wedge' = the original sloped slab; 'point' = a long narrow spear (F1);
    // 'snub' = a short blunt block (tank/pod). Length scales by noseLen.
    nose: makeNoseGeometry(g),
    // --- REAR FURNITURE ------------------------------------------------------
    // A wing bar (F1), or a ducktail lip (roadster) — both share the bar geo,
    // sized differently; the builder positions them. Legs hold the wing up.
    spoilerBar: new RoundedBoxGeometry(1.34 * g.chassisW, 0.07, 0.30, 3, 0.03),
    spoilerLeg: new RoundedBoxGeometry(0.08, 0.30, 0.10, 3, 0.03),
    // Roll-bar hoop (tank): a flattened torus arching over the seat.
    rollbar: new THREE.TorusGeometry(0.34 * g.chassisW, 0.05, 8, 18, Math.PI),
    // Tail fin (off-roader): a small upright triangle-ish slab.
    fin: new RoundedBoxGeometry(0.06, 0.34, 0.42, 3, 0.03),
    // --- ACCENT PANEL (three silhouettes) ------------------------------------
    // A painted shape on the hood that catches the eye and differs per body.
    accent: makeAccentGeometry(g),
    // --- STEERING ------------------------------------------------------------
    steerColumn: new THREE.CylinderGeometry(0.035, 0.045, 0.42, 12),
    steerWheel: new THREE.TorusGeometry(0.17, 0.035, 10, 24),
    // --- WHEELS (scaled by the archetype's wheelScale) -----------------------
    // Bigger wheelScale => fatter off-roader tires; smaller => compact-pod tires.
    tire: new THREE.CylinderGeometry(0.35 * g.wheelScale, 0.35 * g.wheelScale, 0.28 * g.wheelScale, 32),
    rim: new THREE.CylinderGeometry(0.22 * g.wheelScale, 0.22 * g.wheelScale, 0.30 * g.wheelScale, 24),
    hub: new THREE.CylinderGeometry(0.07 * g.wheelScale, 0.07 * g.wheelScale, 0.34 * g.wheelScale, 14),
  };
  _geoCache.set(cacheKey, set);
  return set;
}

/**
 * Build the nose geometry for an archetype's silhouette. Pulled out so the
 * three shapes (wedge / point / snub) stay readable. Length scales by noseLen.
 * @param {Object} g  - resolved geometry recipe.
 * @returns {THREE.BufferGeometry}
 * @private
 */
function makeNoseGeometry(g) {
  const len = 0.62 * Math.max(0.4, g.noseLen);
  if (g.noseShape === 'point') {
    // A long narrow tapered cone laid forward (F1 spear). 4 sides reads crisp.
    return new THREE.CylinderGeometry(0.02, 0.34 * g.chassisW, len * 1.4, 4);
  }
  if (g.noseShape === 'snub') {
    // A short, wide, blunt block (tank/pod) — barely protrudes.
    return new RoundedBoxGeometry(0.9 * g.chassisW, 0.30 * g.chassisH, len * 0.8, 4, 0.12);
  }
  // 'wedge' — the original sloped slab, width following the chassis.
  return new RoundedBoxGeometry(0.92 * g.chassisW, 0.22, len, 4, 0.10);
}

/**
 * Build the hood accent-panel geometry per archetype. A flat thin shape laid on
 * the hood; the silhouette (stripe / chevron / dot) is the main visual tell.
 * @param {Object} g  - resolved geometry recipe.
 * @returns {THREE.BufferGeometry}
 * @private
 */
function makeAccentGeometry(g) {
  if (g.accent === 'dot') {
    // A round emblem (pod) — a flat disc.
    return new THREE.CylinderGeometry(0.16, 0.16, 0.04, 18);
  }
  if (g.accent === 'chevron') {
    // A narrow forward-pointing prism (a single arrow), built from a 3-side
    // cylinder so it reads as a triangle laid flat on the hood.
    return new THREE.CylinderGeometry(0.0, 0.2 * g.chassisW, 0.5, 3);
  }
  // 'stripe' — a long thin racing stripe down the hood.
  return new RoundedBoxGeometry(0.16, 0.03, 0.7, 2, 0.015);
}

// ---------------------------------------------------------------------------
// Driver geometry — keyed per DRIVER LOOK (build + helmet shape + helmet size).
//
// Drivers now vary by character (slim light pilots, burly heavies, different
// helmet silhouettes), so the driver body parts are built per distinct LOOK and
// cached. There are only ~3 builds × a few helmet shapes, so the cache stays
// tiny. Linear values are MULTIPLIERS on the original driver (build 1.0 = the
// original capsule torso / sphere helmet).
// ---------------------------------------------------------------------------
const _driverGeoCache = new Map(); // look key -> driver geometry set

/**
 * Build (and cache) the driver geometry for one look. `build` fattens/heightens
 * the torso + limbs; `helmetScale` sizes the head; `helmet` picks the shell
 * silhouette (round dome / aero teardrop / crowned / open visorless cap).
 * @param {Object} look  - resolved driver look (LOOK_DEFAULTS already merged).
 * @returns {Object} driver geometry set
 */
function getDriverGeometry(look) {
  const key = `${look.helmet}|${look.build.toFixed(2)}|${look.helmetScale.toFixed(2)}`;
  const cached = _driverGeoCache.get(key);
  if (cached) return cached;

  const b = look.build;        // torso/limb girth + height
  const hs = look.helmetScale; // helmet radius

  const set = {
    // Torso: capsule, scaled by build (heavier drivers are visibly broader).
    torso: new THREE.CapsuleGeometry(0.27 * b, 0.42 * b, 8, 16),
    neck: new THREE.CylinderGeometry(0.11 * b, 0.13 * b, 0.14, 12),
    upperArm: new THREE.CapsuleGeometry(0.075 * b, 0.24 * b, 6, 10),
    forearm: new THREE.CapsuleGeometry(0.065 * b, 0.26 * b, 6, 10),
    hand: new THREE.SphereGeometry(0.085 * b, 12, 10),
    // Helmet shell — the silhouette is the biggest driver tell.
    helmet: makeHelmetGeometry(look.helmet, hs),
    // A small crest ridge for the 'crown' helmet (a thin arched box). Length scaled
    // down with the smaller 0.16 head so it reads as a fin, not an overhang.
    crest: new RoundedBoxGeometry(0.06 * hs, 0.10 * hs, 0.28 * hs, 2, 0.02),
    // Visor band across the front of the helmet (sits just proud of the 0.16 shell).
    visor: new THREE.SphereGeometry(
      0.167 * hs, 24, 14, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.36, Math.PI * 0.30),
  };
  _driverGeoCache.set(key, set);
  return set;
}

/**
 * Build the helmet shell for a look. 'round' = the original sphere; 'aero' =
 * a teardrop (stretched back) sphere; 'crown' = a sphere (crest added by the
 * builder); 'visorless' = a slightly squashed open cap. Size scales by hs.
 * @param {string} shape  - helmet shape id.
 * @param {number} hs     - helmet scale.
 * @returns {THREE.BufferGeometry}
 * @private
 */
function makeHelmetGeometry(shape, hs) {
  // Head radius ~0.16 (was 0.20, still read big — ~74% of the 0.54 torso width =
  // a bobblehead from the close start-line/low camera angles). 0.16 = ~59% of the
  // torso, a natural racing-driver proportion. The builder applies non-uniform
  // scaling for 'aero'/'visorless' so the geometry can stay a shared sphere
  // (cheap) while the silhouette still differs.
  return new THREE.SphereGeometry(0.16 * hs, 24, 18);
}

// A soft round sprite texture (shared by every kart's spark pool), built once.
let _sparkTexture = null;
function getSparkTexture() {
  if (_sparkTexture) return _sparkTexture;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _sparkTexture = new THREE.CanvasTexture(canvas);
  return _sparkTexture;
}

// Module-level cache for an optional preloaded glTF kart scene. The integrator
// preloads with AssetLoader and calls Kart.setSharedModel(scene) ONCE; every
// Kart built afterward will clone + tint it instead of building procedurally.
let _sharedModelScene = null;

// Monotonic counter handing each procedurally-built kart a distinct sequential
// index when the caller passes neither an explicit body/character id nor a
// racerIndex. RaceManager builds its 13-kart field in one sequential pass, so
// successive karts get indices 0,1,2,… — body = i%5 and driver = (i+2)%10 then
// give an EVEN, collision-free spread of archetypes across the grid (the LCM of
// 5 and 10 is 10, so the first ten karts are all unique body+driver pairs). It
// is never reset: across races it merely rotates which racer gets which look,
// always yielding a varied field, so no teardown hook is needed.
let _autoIndex = 0;

export class Kart {
  /**
   * Register a PRELOADED glTF scene to be cloned by every future Kart.
   * Pass the `.scene` returned by AssetLoader.loadModel(url). Pass null to
   * clear it (karts revert to procedural).
   * @param {THREE.Object3D|null} scene
   */
  static setSharedModel(scene) {
    _sharedModelScene = scene || null;
  }

  /** @returns {THREE.Object3D|null} the currently registered shared model. */
  static getSharedModel() {
    return _sharedModelScene;
  }

  /**
   * @param {Object} opts
   * @param {number|string} [opts.color=0xff3b30]  Body color (any THREE.Color input).
   * @param {THREE.Object3D} [opts.model]          Optional preloaded glTF scene to
   *   clone for THIS kart, overriding the shared model. If neither this nor a
   *   shared model is set, the procedural kart is built.
   * @param {string} [opts.bodyId]      Optional KART_BODIES id selecting the body
   *   ARCHETYPE (silhouette). Used by the player's customization flow.
   * @param {string} [opts.characterId] Optional CHARACTERS id selecting the
   *   driver LOOK (build/helmet/palette).
   * @param {number} [opts.racerIndex]  Optional racer index. When neither bodyId
   *   nor characterId is given, a body + driver look are picked DETERMINISTICALLY
   *   so a whole field gets a spread of archetypes. If racerIndex is also absent
   *   we derive a stable index from the body color, so the existing AI grid (which
   *   passes only { color }, each a distinct hue) still gets a varied field with
   *   NO change to its call site.
   */
  constructor(opts = {}) {
    const bodyColor = opts.color !== undefined ? opts.color : 0xff3b30;
    this._color = new THREE.Color(bodyColor);

    // QUALITY: env-reflection scale + the "rich materials" gate (HIGH+). _envScale
    // is applied to every PBR material after the body is built; _richMat upgrades
    // the painted body panels to a clear-coated finish (see _paint). Read once.
    const _qcfg = qualitySettings.getConfig();
    this._envScale = _qcfg.envMapIntensity;
    this._richMat = _qcfg.litItems; // true on HIGH/ULTRA

    // --- Resolve the body archetype + driver look ----------------------------
    // Priority: explicit id (customization) > racerIndex (field spread) > a hash
    // of the color (so the AI grid's distinct hues map to a deterministic spread
    // without us touching RaceManager). Body and character use DIFFERENT phases
    // of the index so silhouette and driver don't march in lockstep across the
    // grid (e.g. two adjacent karts won't both be "pod + Pip").
    const seed = this._resolveSeed(opts);
    const bodyDef = opts.bodyId
      ? getBodyById(opts.bodyId)
      : getBodyByIndex(seed);
    const charDef = opts.characterId
      ? getCharacterById(opts.characterId)
      : getCharacterByIndex(seed + 2);
    // Merge each partial recipe over its defaults => always a complete recipe.
    this._geo = { ...BODY_DEFAULTS, ...(bodyDef.geometry || {}) };
    this._look = { ...LOOK_DEFAULTS, ...(charDef.look || {}) };
    // The cached geometry set for THIS archetype (built once per body id).
    this._geoSet = getArchetypeGeometry(bodyDef.id, this._geo);

    // The root group. External code reads `kart.group` and adds it to the scene.
    this.group = new THREE.Group();
    this.group.name = 'Kart';
    // YAW then PITCH about the kart's own lateral axis (ramp nose-up; see syncFromState).
    this.group.rotation.order = 'YXZ';

    // Front-wheel references (steerable) and all-wheel references (rolling).
    this.frontWheels = [];
    this.allWheels = [];

    // Max visual steering angle of the front wheels (~28.6 deg). Cosmetic only.
    this.maxSteerAngle = 0.5;
    // Wheel radius, reused to convert distance travelled into roll rotation.
    // Scales with the archetype's wheel size so bigger off-roader tires still
    // roll at the right rate (distance/r). Base 0.35 = original kart.
    this.wheelRadius = 0.35 * this._geo.wheelScale;

    // Inner group holding ONLY the cosmetic body/driver so drift roll (Z) and
    // hop bounce (Y) lean the body WITHOUT moving the wheels or spark pivots.
    this.bodyGroup = new THREE.Group();
    this.bodyGroup.name = 'bodyGroup';
    this.group.add(this.bodyGroup);

    this._bodyRoll = 0;
    this.maxBodyRoll = 0.16;     // ~9 deg max drift lean

    // --- ANTI-GRAV mesh reorientation (render-only) -------------------------
    // While the kart is inside a wall/ceiling section we build a FULL orientation
    // from the surface frame and slerp the group toward it by an eased _agBlend
    // (0 = upright yaw-only, 1 = fully surface-aligned). _trackId is stamped by the
    // mode managers so syncFromState can call the pure surfaceFrameAt. Scratch
    // objects are reused per-frame to avoid allocation.
    this._trackId = null;
    this._agBlend = 0;
    this._rampPitch = 0; // eased render-only nose pitch so the kart lies flush on a ramp wedge
    // RAMP-PITCH SAMPLE CACHE: the groundY gradient is ~constant over a ramp wedge, so
    // we keep the last sampleSurface-derived target and the quantized cell it was taken
    // at, recomputing the two spline searches only when the kart crosses into a new cell.
    // Cuts the redundant searches by the paint:sim ratio on high-refresh displays. Keys
    // init NaN so the first ramp frame always recomputes.
    this._rampSampleTarget = 0;
    this._rampQX = this._rampQZ = this._rampQY = this._rampQH = NaN;
    this._qTarget = new THREE.Quaternion();
    this._qNormal = new THREE.Quaternion();
    this._eAg = new THREE.Euler();
    this._qSpin = new THREE.Quaternion();
    this._agFwd = new THREE.Vector3();
    this._agUp = new THREE.Vector3();
    this._agRight = new THREE.Vector3();
    this._agUp2 = new THREE.Vector3();
    this._agMat = new THREE.Matrix4();
    // MK8 anti-grav blue the wheels glow while in a section (eased in/out).
    this._agWheelColor = new THREE.Color(0x3aa0ff);

    // --- R12 glider + suspension/lean feel (set in syncFromState) ----------
    // _gliderDeploy eases 0..1 (0 = stowed, 1 = fully unfurled) so the parafoil
    // opens/closes smoothly instead of popping. _suspY/_squash track the visual
    // landing compression. References are filled by _buildGlider below.
    this._gliderDeploy = 0;
    this._gliderGroup = null;

    // Mini-turbo spark colors, indexed by state.miniTurboTier (0..3).
    this._tierColors = [
      null,                       // tier 0: no sparks
      new THREE.Color(0x3aa0ff),  // tier 1: blue
      new THREE.Color(0xff9a2e),  // tier 2: orange
      new THREE.Color(0xb35cff),  // tier 3: purple
    ];

    // M3 status-effect state.
    this._spinVisual = 0;
    this.spinVisualRate = Math.PI * 6;     // ~3 full turns/sec while spinning out
    this._effectClock = 0;
    this._tintTargets = [];

    // --- Neon underglow pulse -------------------------------------------------
    // References to the emissive accent materials so we can softly pulse their
    // glow every frame (idle "alive" shimmer) and ramp them up under boost.
    this._glowMaterials = [];
    // Lowered from 1.4 -> 0.55: at 1.4 the emissive trim/underglow swamped the
    // body paint and bloomed the whole kart to a washed-out white blob. 0.55
    // lets the painted body color read clearly while the accents still glow
    // softly under the (gentle, Phase-2) bloom pipeline.
    this._glowBaseIntensity = 0.55;

    // Build either the cloned model path or the procedural path.
    this._usingModel = false;
    const modelScene = opts.model || _sharedModelScene;
    if (modelScene) {
      try {
        this._buildFromModel(modelScene);
        this._usingModel = true;
      } catch (err) {
        // Any failure (unexpected node layout, etc.) -> safe procedural fallback.
        this._usingModel = false;
        // Clear anything a partial build may have added.
        this.bodyGroup.clear();
      }
    }
    if (!this._usingModel) {
      this._buildBody();
      this._buildDriver();
    }

    // Wheels + sparks are ALWAYS procedural overlays (so animation hooks work
    // regardless of whether a real model loaded).
    this._buildWheels();
    this._buildSparks();
    // Glider parafoil — deploys above the kart while state.gliding (R12).
    this._buildGlider();

    // Snapshot body/driver emissive colors for the star tint.
    this._captureTintTargets();

    // Every mesh casts shadows for a grounded look; solid parts also RECEIVE so a
    // kart self-shadows + catches a rival's shadow when packed (the emissive glow/
    // underglow/trim parts skip receive — shading a self-lit neon strip looks wrong).
    // receiveShadow is a no-op when the quality tier disables the shadow map (LOW),
    // so this is free on weak hardware and only enriches MEDIUM+.
    this.group.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      const n = object.name || '';
      if (!/glow|underglow|trim|spark|glider/i.test(n)) object.receiveShadow = true;
    });

    // ENV REFLECTIONS per quality tier. Every PBR material samples scene.environment
    // (set in the Renderer); _envScale dials how strongly. LOW (0) flattens the look
    // for free (no NEW cost — the sample already ran, now ×0); MED (1.0) is exactly
    // today's default; HIGH/ULTRA (1.25/1.5) make the chrome hubs + glossy bodywork
    // read with a richer studio sheen. Build-time only — one traverse, no per-frame cost.
    this.group.traverse((object) => {
      const m = object.material;
      if (m && m.isMeshStandardMaterial) m.envMapIntensity = this._envScale;
    });

    // Soft contact shadow under the kart — added LAST so the cast/receive traverse
    // above never tags it (it neither casts nor receives; it IS the grounding cue).
    this._buildContactShadow();
  }

  /**
   * Soft contact shadow — a dark radial decal laid flat under the kart so it reads
   * as planted on the road at EVERY quality tier. The real sun shadow map barely
   * shows on the emissive neon road and is off entirely on LOW, so this cheap quad
   * (one shared texture, no depth write, no per-frame work) is what actually grounds
   * the kart on screen. Parented to the root group, so it follows yaw + ramp pitch +
   * anti-grav surface alignment, but NOT the cosmetic hop/drift-roll (those live on
   * bodyGroup) — so it stays flat on the surface beneath the wheels.
   * ponytail: travels with the kart while airborne (no ground-projection) — fine for
   * brief hops; add a raycast drop if long jumps ever need a detached shadow.
   * @private
   */
  _buildContactShadow() {
    const g = this._geo;
    // Footprint: a touch wider than the track and longer than the wheelbase, so the
    // soft edge feathers out just past the tires.
    const w = 0.74 * g.trackW * 2 * 1.45;
    const l = 0.74 * g.chassisL * 2 * 1.7;
    const mat = new THREE.MeshBasicMaterial({
      map: getContactShadowTexture(),
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,   // never occludes anything; depthTest still lets wheels mask it
      toneMapped: false,   // a flat dark multiply, not a lit/tone-mapped surface
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
    mesh.name = 'contactShadow';
    mesh.rotation.x = -Math.PI / 2; // lie flat in the XZ plane (local ground = y 0)
    mesh.position.y = 0.02;          // a hair above the road to avoid z-fighting
    mesh.renderOrder = 1;            // draw in the transparent pass after the opaque road
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this._contactShadow = mesh;
    this.group.add(mesh);
  }

  /**
   * Build a painted BODY-PANEL material. On HIGH+ (_richMat) it's a clear-coated
   * MeshPhysicalMaterial — a thin glossy lacquer over the paint that reads as real
   * automotive bodywork (the cheap, high-value realism win) — otherwise the plain
   * MeshStandardMaterial used today (so LOW/MED are byte-for-byte unchanged). The
   * envMapIntensity is set later by the constructor traverse, so it isn't set here.
   * @param {Object} params  MeshStandardMaterial params (color/roughness/emissive…).
   * @returns {THREE.MeshStandardMaterial|THREE.MeshPhysicalMaterial}
   * @private
   */
  _paint(params) {
    if (this._richMat) {
      return new THREE.MeshPhysicalMaterial({
        ...params,
        clearcoat: 0.7,
        clearcoatRoughness: 0.35,
      });
    }
    return new THREE.MeshStandardMaterial(params);
  }

  /**
   * Pick the spread index for the body/character lookup when the caller didn't
   * pass explicit ids. Prefers an explicit racerIndex; otherwise consumes the
   * next value from the module auto-counter so a field built in one pass gets an
   * even, deterministic 0,1,2,… spread (see _autoIndex above). When an explicit
   * body/character id IS supplied (player customization) we still advance the
   * counter via the caller's choice not mattering — only the unspecified fields
   * fall back to the index, so the player's exact pick is always honored.
   * @param {Object} opts  - the constructor opts.
   * @returns {number} a non-negative integer index.
   * @private
   */
  _resolveSeed(opts) {
    if (typeof opts.racerIndex === 'number') return opts.racerIndex | 0;
    return _autoIndex++;
  }

  /**
   * Clone the preloaded glTF scene, tint its main materials toward the body
   * color, and add it under bodyGroup. Wheels stay procedural (added later).
   * Throws if the scene can't be cloned, so the constructor can fall back.
   * @param {THREE.Object3D} scene
   * @private
   */
  _buildFromModel(scene) {
    const clone = scene.clone(true);

    // The model ships its OWN wheels (Kenney names them "wheel-*"). We keep the
    // procedural wheel overlay (it rolls, steers, and glows for anti-grav — see
    // _buildWheels), so the model's static wheels would just double up. Collect
    // them now, hide them AFTER measuring the bounding box (so the kart still
    // sits on its wheels' contact plane, then the overlay fills the gap).
    const modelWheels = [];
    clone.traverse((o) => { if (o.name && /wheel/i.test(o.name)) modelWheels.push(o); });

    // --- NORMALIZE scale + orient + origin -----------------------------------
    // The Kenney kart is ~0.9u long and +Z-forward; the procedural kart is ~2.2u
    // long and also +Z-forward (front of the car points along +Z = the game's
    // heading). So we only need a uniform scale + a recenter, with a defensive
    // 90° yaw in case a future model is authored X-forward. Final origin: the
    // model is centered in X/Z and its bottom rests on y=0 (the wheel contact
    // plane), matching the procedural kart's group origin exactly.
    clone.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(clone);
    let size = box.getSize(new THREE.Vector3());
    // If the model is longer along X than Z, yaw 90° so "length" runs along +Z.
    if (size.x > size.z) {
      clone.rotation.y = Math.PI / 2;
      clone.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(clone);
      size = box.getSize(new THREE.Vector3());
    }
    const TARGET_LEN = 2.2;
    const s = size.z > 1e-4 ? TARGET_LEN / size.z : 1;
    const center = box.getCenter(new THREE.Vector3());
    clone.scale.setScalar(s);
    clone.position.set(-center.x * s, -box.min.y * s, -center.z * s);

    // Hide the built-in wheels now that the box (which included them) is measured.
    for (const w of modelWheels) w.visible = false;

    // Materials are shared across clones; clone them too so per-kart tinting
    // doesn't bleed into other karts.
    clone.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      const mat = object.material.clone();
      // The Kenney body is a near-white palette atlas (white base color), so push
      // HARD toward this kart's color — karts must stay distinguishable on the
      // neon track. A light residual keeps a painted sheen rather than going flat.
      if (mat.color) mat.color.lerp(this._color, 0.85);
      // A faint self-emissive in the kart hue so the body reads + blooms like the
      // procedural chassis, and so _captureTintTargets has a sane star-tint base.
      if ('emissive' in mat && mat.emissive) {
        mat.emissive.copy(this._color).multiplyScalar(0.5);
        mat.emissiveIntensity = 0.18;
      }
      // Give it the glossy neon-arcade finish.
      if ('metalness' in mat) mat.metalness = 0.4;
      if ('roughness' in mat) mat.roughness = 0.35;
      object.material = mat;
    });

    clone.name = 'kartModel';
    this.bodyGroup.add(clone);

    // Add the same emissive neon underglow + trim so the model also pops with
    // bloom and matches the procedural look.
    this._buildGlowAccents();
  }

  /**
   * Build the procedural chassis FROM the chosen body archetype. Every part is
   * positioned/scaled by `this._geo` (the resolved geometry recipe) so different
   * archetypes produce visibly different SILHOUETTES — a long pointed F1, a
   * raised fat-wheeled off-roader, a stubby pod with no nose, a bulky roll-bar
   * tank — not just recolors. Built facing +Z (local forward).
   * @private
   */
  _buildBody() {
    const geo = this._geoSet;     // archetype-specific cached geometry
    const g = this._geo;          // resolved recipe (defaults merged)

    // Whole-body vertical lift from the archetype ride height. Off-roaders sit
    // high on fat wheels; the F1 sits low. `lift` is added to every body part's
    // Y so the chassis stays planted on its (scaled) wheels.
    const lift = (g.rideHeight - 1) * 0.22 + (this.wheelRadius - 0.35);
    // Half the chassis length, used to place nose (front) and rear furniture.
    const halfLen = 1.05 * g.chassisL;

    // Glossy automotive CLEAR-COAT body in the kart color (recipe unchanged from
    // the original — see notes below). Keeps the painted color reading richly
    // under bloom without a white spec blow-out.
    //   color      -> the pure kart color (no lerp toward white anywhere)
    //   roughness  -> 0.42: a soft sheen, NOT a mirror — kills the hot spec spot
    //   metalness  -> 0.18: a hint of metallic depth, low enough to stay painted
    //   emissive   -> the kart color, so its own hue glows faintly through it
    //   emissiveIntensity 0.18 -> just enough to keep the color reading
    const chassisMat = this._paint({
      color: this._color,
      roughness: 0.42,
      metalness: 0.18,
      emissive: this._color.clone().multiplyScalar(0.5),
      emissiveIntensity: 0.18,
    });
    // The hood pod: same paint, darkened ×0.9 for a subtle two-tone front.
    const hoodMat = this._paint({
      color: this._color.clone().multiplyScalar(0.9),
      roughness: 0.4,
      metalness: 0.2,
      emissive: this._color.clone().multiplyScalar(0.5),
      emissiveIntensity: 0.16,
    });
    // Dark matte cockpit + seat so the colored body frames a dark "interior".
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x16161b,
      roughness: 0.55,
      metalness: 0.25,
    });
    // Glossy near-black for nose, rear furniture, side pods (carbon-ish trim).
    const carbonMat = new THREE.MeshStandardMaterial({
      color: 0x101014,
      roughness: 0.25,
      metalness: 0.65,
    });
    // Bright accent paint (kart hue, saturation boosted) for the hood emblem.
    const accentMat = new THREE.MeshStandardMaterial({
      color: this._brightAccentColor(),
      roughness: 0.3,
      metalness: 0.5,
      emissive: this._brightAccentColor().multiplyScalar(0.5),
      emissiveIntensity: 0.3,
    });

    // Main chassis tub.
    const chassis = new THREE.Mesh(geo.chassis, chassisMat);
    chassis.position.y = 0.36 + lift;
    chassis.name = 'chassis';
    this.bodyGroup.add(chassis);

    // Rounded hood pod over the front axle — omitted when hoodScale is 0 (pod).
    if (g.hoodScale > 0) {
      const hood = new THREE.Mesh(geo.hood, hoodMat);
      hood.position.set(0, 0.46 + lift, 0.62 * g.chassisL);
      hood.name = 'hood';
      this.bodyGroup.add(hood);

      // Accent emblem laid on the hood; its silhouette differs per archetype.
      const accent = new THREE.Mesh(geo.accent, accentMat);
      accent.position.set(0, 0.60 + lift, 0.62 * g.chassisL);
      if (g.accent === 'chevron') {
        // Lay the 3-side prism flat, pointing forward (+Z).
        accent.rotation.x = Math.PI / 2;
      }
      // 'dot' disc + 'stripe' box keep their default orientation (lying flat on
      // the hood, facing up), so no rotation is needed for them.
      accent.name = 'accent';
      this.bodyGroup.add(accent);
    }

    // Scooped cockpit floor the driver sits in (inset, dark).
    const cockpit = new THREE.Mesh(geo.cockpit, darkMat);
    cockpit.position.set(0, 0.44 + lift, -0.18);
    cockpit.name = 'cockpit';
    this.bodyGroup.add(cockpit);

    // Raised seat back behind the driver.
    const seat = new THREE.Mesh(geo.seat, darkMat);
    seat.position.set(0, 0.66 + lift, -0.66 * g.chassisL);
    seat.rotation.x = -0.12;
    seat.name = 'seat';
    this.bodyGroup.add(seat);

    // Nose at the very front (+Z), shape per archetype — omitted when noseLen 0.
    if (g.noseLen > 0) {
      const nose = new THREE.Mesh(geo.nose, carbonMat);
      const noseZ = halfLen + 0.02;
      if (g.noseShape === 'point') {
        // The tapered cone's axis is +Y by default; lay it forward (point +Z).
        nose.rotation.x = Math.PI / 2;
        nose.position.set(0, 0.32 + lift, noseZ + 0.18);
      } else {
        nose.position.set(0, 0.34 + lift, noseZ);
        nose.rotation.x = -0.22; // sloped down (wedge/snub)
      }
      nose.name = 'nose';
      this.bodyGroup.add(nose);
    }

    // Side engine pods bulging over each rear wheel (optional per archetype).
    if (g.sidePods) {
      for (const sx of [-0.66 * g.chassisW, 0.66 * g.chassisW]) {
        const pod = new THREE.Mesh(geo.sidePod, carbonMat);
        pod.position.set(sx, 0.40 + lift, -0.45 * g.chassisL);
        this.bodyGroup.add(pod);
      }
    }

    // Rear furniture — one of four archetypes.
    this._buildRear(geo, carbonMat, lift, halfLen, g);

    // Upright tail fins beside the rear (off-roader flavor).
    if (g.fins) {
      for (const sx of [-0.5 * g.chassisW, 0.5 * g.chassisW]) {
        const fin = new THREE.Mesh(geo.fin, carbonMat);
        fin.position.set(sx, 0.62 + lift, -halfLen * 0.7);
        this.bodyGroup.add(fin);
      }
    }

    // Neon underglow + side trim accents.
    this._buildGlowAccents();
  }

  /**
   * Build the rear furniture for the chosen archetype: a high F1 wing on legs,
   * a low ducktail lip, a roll-bar hoop, or nothing. Kept separate so _buildBody
   * stays readable.
   * @param {Object} geo   - archetype geometry set.
   * @param {THREE.Material} carbonMat - shared dark trim material.
   * @param {number} lift  - whole-body vertical lift.
   * @param {number} halfLen - half the chassis length.
   * @param {Object} g     - resolved geometry recipe.
   * @private
   */
  _buildRear(geo, carbonMat, lift, halfLen, g) {
    const rearZ = -halfLen - 0.0;
    if (g.rear === 'wing') {
      // Tall F1 wing: a wide bar held high on two legs, angled for attack.
      const bar = new THREE.Mesh(geo.spoilerBar, carbonMat);
      bar.position.set(0, 0.92 + lift, rearZ);
      bar.rotation.x = 0.16;
      bar.name = 'spoiler';
      this.bodyGroup.add(bar);
      for (const sx of [-0.52 * g.chassisW, 0.52 * g.chassisW]) {
        const leg = new THREE.Mesh(geo.spoilerLeg, carbonMat);
        leg.position.set(sx, 0.74 + lift, rearZ + 0.02);
        this.bodyGroup.add(leg);
      }
    } else if (g.rear === 'ducktail') {
      // Low ducktail lip: the same bar, sat low and short on stubby legs.
      const bar = new THREE.Mesh(geo.spoilerBar, carbonMat);
      bar.position.set(0, 0.62 + lift, rearZ);
      bar.rotation.x = 0.22;
      bar.scale.set(0.82, 1, 0.7);
      bar.name = 'spoiler';
      this.bodyGroup.add(bar);
      for (const sx of [-0.44 * g.chassisW, 0.44 * g.chassisW]) {
        const leg = new THREE.Mesh(geo.spoilerLeg, carbonMat);
        leg.position.set(sx, 0.52 + lift, rearZ + 0.02);
        leg.scale.set(1, 0.5, 1);
        this.bodyGroup.add(leg);
      }
    } else if (g.rear === 'rollbar') {
      // Roll-bar hoop arching up over the seat (tank). The half-torus (arc = π)
      // already spans left-to-right across X and arches up in Y, opening
      // downward — exactly a roll bar across the kart width, no rotation needed.
      const bar = new THREE.Mesh(geo.rollbar, carbonMat);
      bar.position.set(0, 0.70 + lift, rearZ + 0.30);
      bar.name = 'rollbar';
      this.bodyGroup.add(bar);
    }
    // g.rear === 'none' -> deliberately bare tail (pod).
  }

  /**
   * The kart's hue pushed to high saturation + bright lightness, used for the
   * painted hood accent emblem so it pops against the body. Returns a NEW Color.
   * @returns {THREE.Color}
   * @private
   */
  _brightAccentColor() {
    const c = this._color.clone();
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1 + 0.15), 0.62);
    return c;
  }

  /**
   * Build the emissive neon accents (underglow skirt + flank trim strips).
   * These use a bright emissive so they bloom hard, and are collected into
   * `this._glowMaterials` so syncFromState can pulse them. Shared by both the
   * procedural and model paths.
   * @private
   */
  _buildGlowAccents() {
    const geo = this._geoSet;
    const g = this._geo;
    // Lift the underglow with the archetype ride height so a raised off-roader's
    // glow doesn't float and a low F1's doesn't clip the ground.
    const skirtLift = (g.rideHeight - 1) * 0.18;
    // The accent emissive color = the kart's OWN hue, kept SATURATED. We no
    // longer lerp toward white at all — the previous 0.12 white lerp still
    // desaturated the brightest accents toward grey-white under bloom. Instead
    // we push the hue's saturation/value UP via HSL so the trim glows as a crisp
    // line in the kart color (a vivid cyan/red/green accent), not a pale wash.
    const glowColor = this._color.clone();
    {
      // Read the base hue, then force high saturation + a controlled lightness
      // so dark body colors still throw a clear colored accent line.
      const hsl = { h: 0, s: 0, l: 0 };
      glowColor.getHSL(hsl);
      glowColor.setHSL(hsl.h, Math.min(1, hsl.s * 1.15 + 0.1), 0.55);
    }

    // Underglow skirt: a flat slab tucked under the chassis with strong emissive.
    const skirtMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c,
      roughness: 0.5,
      metalness: 0.2,
      emissive: glowColor,
      emissiveIntensity: this._glowBaseIntensity,
    });
    const skirt = new THREE.Mesh(geo.skirt, skirtMat);
    skirt.position.y = 0.18 + skirtLift;
    skirt.name = 'underglow';
    // The skirt itself shouldn't cast harsh shadows (it's a glow element).
    skirt.castShadow = false;
    this.bodyGroup.add(skirt);
    this._glowMaterials.push(skirtMat);

    // Two side trim strips just below the chassis shoulder line.
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c,
      roughness: 0.4,
      metalness: 0.3,
      emissive: glowColor,
      emissiveIntensity: this._glowBaseIntensity,
    });
    for (const sx of [-0.60 * g.chassisW, 0.60 * g.chassisW]) {
      const trim = new THREE.Mesh(geo.trim, trimMat);
      trim.position.set(sx, 0.36 + skirtLift, 0.0);
      trim.castShadow = false;
      this.bodyGroup.add(trim);
    }
    this._glowMaterials.push(trimMat);
  }

  /**
   * Build a helmeted driver: glossy capsule torso, sphere helmet, glowing visor.
   * @private
   */
  _buildDriver() {
    const dgeo = getDriverGeometry(this._look); // per-look driver parts
    const sgeo = this._geoSet;                   // archetype steering parts
    const look = this._look;

    // The driver is built into its own sub-group so its whole pose sits cleanly
    // in the cockpit and leans with the body during drifts (bodyGroup carries it).
    const driver = new THREE.Group();
    driver.name = 'driver';
    // Seat the whole driver slightly lower so the torso sinks into the cockpit
    // tub, PLUS the same ride-height lift the body got so a raised off-roader's
    // pilot rises with the chassis instead of sinking through the floor.
    const driverLift = (this._geo.rideHeight - 1) * 0.22 + (this.wheelRadius - 0.35);
    driver.position.y = -0.08 + driverLift;

    // Racing-suit material: a contrasting glossy suit (darker shade of the kart
    // color) so the driver visually belongs to this kart but isn't washed out.
    const suitColor = this._color.clone().multiplyScalar(0.5);
    const suitMat = new THREE.MeshStandardMaterial({
      color: suitColor,
      roughness: 0.5,
      metalness: 0.15,
    });
    // Skin/glove material for the hands (neutral mid-grey gloves).
    const gloveMat = new THREE.MeshStandardMaterial({
      color: 0x2a2a30,
      roughness: 0.6,
      metalness: 0.1,
    });

    // Torso: leaning back slightly into the seat (racing posture).
    const torso = new THREE.Mesh(dgeo.torso, suitMat);
    torso.position.set(0, 0.98, -0.30);
    torso.rotation.x = 0.22; // recline into the seat
    torso.name = 'driverTorso';
    driver.add(torso);

    // Short neck bridging torso and helmet.
    const neck = new THREE.Mesh(dgeo.neck, suitMat);
    neck.position.set(0, 1.30, -0.22);
    driver.add(neck);

    // --- Arms reaching forward to the steering wheel --------------------------
    // Each arm: an upper arm angled down-forward from the shoulder, a forearm
    // continuing to the wheel rim, and a hand (glove) at the rim. Mirrored L/R.
    // Shoulder X widens a touch with build so burly drivers' arms clear the torso.
    const shoulderX = 0.24 * Math.max(1, look.build);
    for (const side of [-1, 1]) {
      const upper = new THREE.Mesh(dgeo.upperArm, suitMat);
      upper.position.set(side * shoulderX, 1.06, -0.16);
      upper.rotation.set(0.9, 0, side * 0.25); // angle down-forward
      driver.add(upper);

      const fore = new THREE.Mesh(dgeo.forearm, suitMat);
      fore.position.set(side * 0.20, 0.92, 0.18);
      fore.rotation.set(1.15, 0, side * 0.12);
      driver.add(fore);

      const hand = new THREE.Mesh(dgeo.hand, gloveMat);
      hand.position.set(side * 0.16, 0.86, 0.40);
      driver.add(hand);
    }

    // --- Steering column + wheel ---------------------------------------------
    const steerMat = new THREE.MeshStandardMaterial({
      color: 0x0c0c10,
      roughness: 0.35,
      metalness: 0.55,
    });
    const column = new THREE.Mesh(sgeo.steerColumn, steerMat);
    column.position.set(0, 0.76, 0.36);
    column.rotation.x = Math.PI / 2.6; // rake the column toward the driver
    driver.add(column);

    const wheel = new THREE.Mesh(sgeo.steerWheel, steerMat);
    wheel.position.set(0, 0.88, 0.42);
    wheel.rotation.x = 0.5; // tilt the wheel face toward the driver
    wheel.name = 'steeringWheel';
    driver.add(wheel);

    // --- Helmet ---------------------------------------------------------------
    // A racing helmet painted in the kart's own color so the driver clearly
    // belongs to this kart, with a clear-coat finish (soft roughness + faint
    // self-hue emissive) so the color reads without a blown-out white spec.
    // The helmet TOP-of-head Y rises with the helmet scale so a bigger dome
    // doesn't clip through the visor band.
    const headY = 1.40 + 0.06 * look.helmetScale;
    const helmetMat = new THREE.MeshStandardMaterial({
      color: this._color.clone().lerp(new THREE.Color(look.accent), 0.3),
      roughness: 0.4,
      metalness: 0.15,
      emissive: this._color.clone().multiplyScalar(0.4),
      emissiveIntensity: 0.12,
    });
    const helmet = new THREE.Mesh(dgeo.helmet, helmetMat);
    helmet.position.set(0, headY, -0.20);
    // Per-shape silhouette via cheap non-uniform scaling of the shared sphere:
    //   aero      -> stretched back + flattened top (teardrop speed helmet)
    //   visorless -> squashed open cap (shorter dome)
    //   round/crown -> left as the plain dome.
    if (look.helmet === 'aero') {
      helmet.scale.set(1.0, 0.92, 1.18);
    } else if (look.helmet === 'visorless') {
      helmet.scale.set(1.05, 0.82, 1.0);
    }
    helmet.name = 'driverHelmet';
    driver.add(helmet);

    // Crowned helmets get a small raised crest ridge running front-to-back, in
    // the helmet accent color, so the silhouette reads distinctly "crested".
    if (look.helmet === 'crown') {
      const crestMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(look.accent),
        roughness: 0.4,
        metalness: 0.2,
      });
      const crest = new THREE.Mesh(dgeo.crest, crestMat);
      crest.position.set(0, headY + 0.16 * look.helmetScale, -0.22);
      crest.name = 'driverCrest';
      driver.add(crest);
    }

    // Visor: a glowing band across the front of the helmet, in the look's visor
    // color (per character). Skipped for the 'visorless' open helmet — that look
    // instead gets a thin painted brow band so the head still has a feature.
    if (look.helmet !== 'visorless') {
      const visorMat = new THREE.MeshStandardMaterial({
        color: 0x0a1418,
        roughness: 0.1,
        metalness: 0.6,
        emissive: new THREE.Color(look.visor),
        emissiveIntensity: 0.7,
      });
      const visor = new THREE.Mesh(dgeo.visor, visorMat);
      visor.position.set(0, headY, -0.20);
      visor.scale.copy(helmet.scale); // match any helmet stretch
      // Rotate the sphere band so its open window faces +Z (forward).
      visor.rotation.y = Math.PI;
      visor.name = 'driverVisor';
      driver.add(visor);
      this._glowMaterials.push(visorMat);
    }

    this.bodyGroup.add(driver);
  }

  /**
   * Build 4 smooth wheels with bright hub caps.
   *
   * WHEEL AXIS MATH (unchanged from the original):
   *   A CylinderGeometry's axis runs along LOCAL Y by default. We want the wheel
   *   to roll about the kart's LOCAL X axis, so each wheel mesh is rotated +90deg
   *   about Z (tipping the cylinder onto X). Each wheel is wrapped in a pivot
   *   Group so the per-frame rolling rotation (pivot.rotation.x) and the front
   *   steering rotation (pivot.rotation.y) stay separate from that one-time tip.
   *
   *     wheelPivot (rolls about X; front pivots also steer about Y)
   *       └─ tire mesh (tipped onto X)
   *       └─ hub mesh  (tipped onto X; bright accent)
   * @private
   */
  _buildWheels() {
    const r = this.wheelRadius;
    const geo = this._geoSet;
    const g = this._geo;

    // Matte rubber tire (low metalness, higher roughness so it doesn't shine
    // like plastic). A hair of dark emissive keeps it from going pure-black in
    // the dark themes.
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x18181c,
      roughness: 0.85,
      metalness: 0.05,
    });
    // Painted alloy RIM in a brushed mid-grey — the main "spoke" disc.
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x9a9aa6,
      roughness: 0.3,
      metalness: 0.8,
    });
    // Bright metallic hub cap, tinted faintly toward the kart color so the
    // wheels feel coordinated with the body. Slight emissive sparkle.
    const hubMat = new THREE.MeshStandardMaterial({
      color: this._color.clone().lerp(new THREE.Color(0xe8e8ee), 0.6),
      roughness: 0.18,
      metalness: 0.9,
      emissive: this._color.clone().multiplyScalar(0.15),
      emissiveIntensity: 0.5,
    });
    // ANTI-GRAV: remember the hub material (+ its base emissive) so syncFromState can
    // ease the wheels toward MK8 anti-grav blue while the kart rides a wall/ceiling,
    // then restore exactly on exit. One shared hubMat across the 4 wheels.
    this._wheelGlowMats = [{
      material: hubMat,
      baseEmissive: hubMat.emissive.clone(),
      baseIntensity: hubMat.emissiveIntensity,
      _tinted: false,
    }];

    // Track width + wheelbase scale with the archetype so a wide off-roader's
    // wheels sit out under its wide body and a long F1's axles sit at its ends.
    const halfTrack = 0.74 * g.trackW;
    const frontZ = 0.74 * g.chassisL;
    const rearZ = -0.74 * g.chassisL;

    // Rears are a touch bigger/wider than fronts (classic kart stance). Encoded
    // as a uniform scale on the wheel pivot (radius + width together).
    // [x, z, isFront, scale]
    const placements = [
      [-halfTrack, frontZ, true, 0.92],
      [halfTrack, frontZ, true, 0.92],
      [-halfTrack, rearZ, false, 1.12],
      [halfTrack, rearZ, false, 1.12],
    ];

    for (const [x, z, isFront, s] of placements) {
      const pivot = new THREE.Group();
      // Axle height scales with the wheel so bigger rears still sit on the road.
      pivot.position.set(x, r * s, z);
      pivot.scale.setScalar(s);

      const tire = new THREE.Mesh(geo.tire, tireMat);
      tire.rotation.z = Math.PI / 2;   // tip cylinder onto X so it rolls about X
      tire.name = isFront ? 'frontWheel' : 'rearWheel';
      pivot.add(tire);

      // Alloy rim disc, slightly narrower than the tire so the rubber frames it.
      const rim = new THREE.Mesh(geo.rim, rimMat);
      rim.rotation.z = Math.PI / 2;
      pivot.add(rim);

      // Hub cap, proud on the OUTER face so it catches light.
      const hub = new THREE.Mesh(geo.hub, hubMat);
      hub.rotation.z = Math.PI / 2;
      pivot.add(hub);

      this.group.add(pivot);
      this.allWheels.push(pivot);
      if (isFront) this.frontWheels.push(pivot);
    }
  }

  /**
   * Build a CHEAP, pooled drift-spark emitter near the two rear wheels.
   * (Behavior unchanged from the original — only the texture is now shared.)
   * @private
   */
  _buildSparks() {
    this._sparkMaterial = new THREE.SpriteMaterial({
      map: getSparkTexture(),
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    // Emit from behind each rear wheel; scaled with the archetype so sparks
    // trail the rear axle on wide/long bodies just as on the standard kart.
    const g = this._geo;
    const sx = 0.74 * g.trackW;
    const sz = -0.74 * g.chassisL - 0.24;
    const sy = 0.15 + (this.wheelRadius - 0.35);
    this._sparkOrigins = [
      new THREE.Vector3(-sx, sy, sz),  // rear-left (behind rear wheel)
      new THREE.Vector3(sx, sy, sz),   // rear-right
    ];

    this._sparkPoolSize = 20;
    this._sparks = [];
    for (let i = 0; i < this._sparkPoolSize; i++) {
      const sprite = new THREE.Sprite(this._sparkMaterial);
      sprite.scale.setScalar(0.001);
      sprite.visible = false;
      sprite.userData = { life: 0, maxLife: 0.25, vx: 0, vy: 0, vz: 0 };
      this.group.add(sprite);
      this._sparks.push(sprite);
    }
    this._sparkCursor = 0;
    this._sparkSpawnAccum = 0;
  }

  /**
   * Build a procedural GLIDER parafoil that deploys above the kart while
   * state.gliding (R12). Original CC0 geometry — no IP:
   *   - a wide canopy made of two angled panels meeting in a shallow center V
   *     (a soft delta wing), painted in the kart's own hue so it reads as "this
   *     kart's glider";
   *   - four thin rigging lines running from the canopy corners down to the
   *     chassis shoulders.
   * The whole rig lives in `_gliderGroup` under bodyGroup (so it banks with the
   * body lean), starts STOWED (scale ~0, hidden), and is unfurled in
   * syncFromState by easing `_gliderDeploy` 0..1.
   * @private
   */
  _buildGlider() {
    const group = new THREE.Group();
    group.name = 'glider';

    // Canopy panels: a flat-ish rounded slab per side, tilted into a shallow V
    // so the parafoil has an arched, wing-like silhouette. Width tracks the
    // chassis so a wide body gets a proportionally wide glider.
    const cw = 1.5 * this._geo.chassisW; // half-span of each panel
    const panelGeo = new RoundedBoxGeometry(cw, 0.05, 1.1, 3, 0.05);
    // Canopy paint: the kart hue, brightened, with a soft self-glow so it pops
    // against the sky during the glide (kept modest so it doesn't bloom white).
    const canopyColor = this._brightAccentColor();
    const canopyMat = new THREE.MeshStandardMaterial({
      color: canopyColor,
      roughness: 0.45,
      metalness: 0.1,
      emissive: canopyColor.clone().multiplyScalar(0.4),
      emissiveIntensity: 0.25,
      side: THREE.DoubleSide,
    });
    // Thin dark rigging line (a long skinny cylinder).
    const lineGeo = new THREE.CylinderGeometry(0.012, 0.012, 1.0, 6);
    const lineMat = new THREE.MeshStandardMaterial({
      color: 0x14141a,
      roughness: 0.6,
      metalness: 0.2,
    });

    // Canopy sits high above the seat; the two panels meet at the centerline and
    // angle up-and-out to make the arched delta.
    const canopyY = 2.05;
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(panelGeo, canopyMat);
      // Shift each panel out so their inner edges meet at the center.
      panel.position.set(side * cw * 0.5, canopyY, -0.1);
      panel.rotation.z = side * 0.32; // tilt up-and-out -> shallow V (dihedral)
      panel.rotation.x = -0.08;       // a touch of nose-up rake
      group.add(panel);
    }

    // Four rigging lines from the canopy corners down to the chassis shoulders.
    // Each line is positioned at its midpoint and rotated to span the gap; we
    // keep the math simple (a fixed lean) since it's purely decorative.
    const shoulderX = 0.55 * this._geo.chassisW;
    const tipX = cw * 0.85;
    for (const side of [-1, 1]) {
      for (const fz of [0.5, -0.7]) {
        const line = new THREE.Mesh(lineGeo, lineMat);
        // Midpoint between a chassis shoulder (~y0.7) and a canopy corner.
        line.position.set(side * (shoulderX + tipX) * 0.5, (0.7 + canopyY) * 0.5, fz * 0.5);
        // Tip the line outward + up so it reads as a taut riser.
        line.rotation.z = side * 0.5;
        line.scale.y = 1.4; // span the full gap
        group.add(line);
      }
    }

    // Start fully stowed: invisible + collapsed. syncFromState unfurls it.
    group.visible = false;
    group.scale.set(0.001, 0.001, 0.001);
    this._gliderGroup = group;
    this.bodyGroup.add(group);
  }

  /**
   * Spawn a single spark from the pool at one of the rear-wheel origins.
   * @param {THREE.Vector3} origin
   * @private
   */
  _spawnSpark(origin) {
    const sprite = this._sparks[this._sparkCursor];
    this._sparkCursor = (this._sparkCursor + 1) % this._sparkPoolSize;

    sprite.position.set(
      origin.x + (Math.random() - 0.5) * 0.18,
      origin.y + Math.random() * 0.05,
      origin.z + (Math.random() - 0.5) * 0.18
    );

    const ud = sprite.userData;
    ud.vx = (Math.random() - 0.5) * 1.2;
    ud.vy = 1.2 + Math.random() * 1.6;
    ud.vz = -1.0 - Math.random() * 1.5;
    ud.maxLife = 0.18 + Math.random() * 0.12;
    ud.life = ud.maxLife;

    sprite.visible = true;
  }

  /**
   * Advance and render the drift-spark pool for this frame. (Unchanged logic.)
   * @param {Object} state
   * @param {number} dt
   * @private
   */
  _updateSparks(state, dt) {
    const tier = state.miniTurboTier | 0;
    const tierColor = this._tierColors[tier] || null;
    const emitting = !!state.drifting && tierColor !== null;

    if (emitting) {
      this._sparkMaterial.color.copy(tierColor);
      const rate = 40 + tier * 10;
      this._sparkSpawnAccum += rate * dt;
      while (this._sparkSpawnAccum >= 1) {
        this._sparkSpawnAccum -= 1;
        const origin = this._sparkOrigins[this._sparkCursor & 1];
        this._spawnSpark(origin);
      }
    } else {
      this._sparkSpawnAccum = 0;
    }

    for (const sprite of this._sparks) {
      const ud = sprite.userData;
      if (ud.life <= 0) {
        if (sprite.visible) sprite.visible = false;
        continue;
      }
      ud.life -= dt;
      if (ud.life <= 0) {
        sprite.visible = false;
        continue;
      }
      sprite.position.x += ud.vx * dt;
      sprite.position.y += ud.vy * dt;
      sprite.position.z += ud.vz * dt;
      ud.vy -= 6 * dt;
      const t = ud.life / ud.maxLife;
      sprite.scale.setScalar(0.05 + 0.45 * t);
    }
  }

  /**
   * Collect the body/driver mesh materials we recolor during a star, storing
   * each one's ORIGINAL emissive color so the tint can be restored exactly.
   * Works for both procedural and model paths (it traverses bodyGroup).
   * @private
   */
  _captureTintTargets() {
    this.bodyGroup.traverse((object) => {
      if (object.isMesh && object.material && object.material.emissive) {
        this._tintTargets.push({
          material: object.material,
          baseEmissive: object.material.emissive.clone(),
          baseIntensity: object.material.emissiveIntensity ?? 1,
        });
      }
    });
    this._tintScratch = new THREE.Color();
    this._tinted = false;
  }

  /**
   * Sync the kart's visuals to a physics STATE object once per frame.
   *
   * @param {Object} state  Kart state: { x, y, z, heading, speed, surface }.
   *                         M2 drift fields (optional): drifting, driftDir,
   *                         miniTurboTier, hopTimer.
   *                         M3 status fields (optional): spinTimer, starTimer,
   *                         shrinkTimer.
   * @param {number} dt      Delta time for this frame, in seconds.
   * @param {number} [steer=0]  Steering input -1..1 (-1=left, +1=right).
   */
  syncFromState(state, dt, steer = 0) {
    // 1) Position.
    this.group.position.set(state.x, state.y, state.z);

    // Contact shadow grounds the kart only while ON a surface. It's parented to the
    // group, so while AIRBORNE it would rise into the sky with the kart and read as a
    // dark quad floating in the air — hide it until the kart lands.
    if (this._contactShadow) this._contactShadow.visible = !state.airborne;

    // Advance the free-running effect clock.
    this._effectClock += dt;

    // 2) Heading (+ spin-out visual).
    if (state.spinTimer && state.spinTimer > 0) {
      this._spinVisual += this.spinVisualRate * dt;
    } else {
      this._spinVisual = 0;
    }
    // ORIENTATION. Normally yaw-only (up = world Y). Inside an anti-grav section we
    // build the FULL orientation from the pure surface frame and SLERP the group
    // toward it by an eased _agBlend (0 = upright, 1 = fully surface-aligned), so the
    // kart visibly rides the wall/ceiling and rights itself on exit. bodyGroup's drift
    // roll / lean / trick-roll / pitch still compose on top as LOCAL offsets (they're
    // children of this now-reoriented group). The common case (agSection<0) takes the
    // untouched yaw-only path below.
    const inAG = state.agSection >= 0 && this._trackId;
    if (inAG) {
      const fr = surfaceFrameAt(this._trackId, state.agS || 0, state.agLateral || 0);
      const ch = Math.cos(state.agHeading || 0), sh = Math.sin(state.agHeading || 0);
      this._agFwd.set(
        fr.tangent.x * ch + fr.right.x * sh,
        fr.tangent.y * ch + fr.right.y * sh,
        fr.tangent.z * ch + fr.right.z * sh,
      ).normalize();
      this._agUp.set(fr.up.x, fr.up.y, fr.up.z).normalize();
      // local +Z is kart-forward, +Y up, +X right (right = up × forward); build + clean.
      this._agRight.crossVectors(this._agUp, this._agFwd).normalize();
      this._agUp2.crossVectors(this._agFwd, this._agRight).normalize();
      this._agMat.makeBasis(this._agRight, this._agUp2, this._agFwd);
      this._qTarget.setFromRotationMatrix(this._agMat);
    }
    // Ease the blend UP toward the (live) surface target while in-section; SNAP to 0
    // on exit. _qTarget is frozen at the last corkscrew orientation, so easing DOWN
    // would slerp toward that stale target and the kart would drive forward while
    // facing SIDEWAYS until the blend decayed. Snapping rights it instantly.
    if (inAG) {
      const agAlpha = 1 - Math.exp(-8 * dt);
      this._agBlend += (1 - this._agBlend) * agAlpha;
    } else {
      this._agBlend = 0;
    }

    // RAMP NOSE-PITCH (render-only). A ramp wedge tilts the rideable surface ±10-35°,
    // but the kart is otherwise yaw-only, so its flat body phases its nose/tail INTO
    // the wedge. Sample the groundY gradient just ahead/behind along the heading and
    // pitch the whole group (wheels included) to lie flush. Eased + gated to ramps so
    // ordinary road/hills stay visually untouched. Mutually exclusive with anti-grav.
    let rampPitchTarget = 0;
    if (!inAG && state.surface === 'ramp' && this._trackId) {
      // Reuse the cached gradient while the kart sits in the same quantized cell
      // (½m in x/z/y, ~0.06rad in heading); the slope is ~flat across a wedge so a
      // stale-by-one-cell target is invisible after the ease below. Recompute only on
      // a cell change — y is keyed so an overpass deck-flip still forces a fresh sample.
      const qx = Math.round(state.x * 2);
      const qz = Math.round(state.z * 2);
      const qy = Math.round(state.y * 2);
      const qh = Math.round(state.heading * 16);
      if (qx !== this._rampQX || qz !== this._rampQZ || qy !== this._rampQY || qh !== this._rampQH) {
        const hx = Math.sin(state.heading), hz = Math.cos(state.heading);
        const e = 1.2; // ~kart half-length, so the pitch matches the body it carries
        // Pass state.y so the ahead/behind picks the deck at the kart's OWN height —
        // otherwise an overpass (figure-8) flips decks and spikes a bogus gradient.
        const gA = sampleSurface(this._trackId, state.x + hx * e, state.z + hz * e, state.y).groundY;
        const gB = sampleSurface(this._trackId, state.x - hx * e, state.z - hz * e, state.y).groundY;
        this._rampSampleTarget = Math.atan((gA - gB) / (2 * e));
        this._rampQX = qx; this._rampQZ = qz; this._rampQY = qy; this._rampQH = qh;
      }
      rampPitchTarget = this._rampSampleTarget;
    } else {
      // Off a ramp: invalidate the cell so the next ramp entry recomputes immediately.
      this._rampQX = NaN;
    }
    // Fast follow (was 10/s): at 10/s the pitch lagged the rising ramp on entry, so
    // the flat nose clipped INTO the wedge (worse the steeper the ramp). 28/s snaps
    // the pitch onto the slope within ~2 frames so the body lies flush, no phase-through.
    const rpLerp = 1 - Math.exp(-28 * dt);
    this._rampPitch += (rampPitchTarget - this._rampPitch) * rpLerp;
    if (rampPitchTarget === 0 && Math.abs(this._rampPitch) < 1e-4) this._rampPitch = 0;

    if (this._agBlend > 0) {
      this._eAg.set(0, state.heading, 0);
      this._qNormal.setFromEuler(this._eAg);
      this.group.quaternion.copy(this._qNormal).slerp(this._qTarget, this._agBlend);
      // Spin-out whirl applied about the (possibly surface-aligned) LOCAL up axis, so a
      // kart spun on a wall still visibly spins. (qTarget can't carry it, so post-multiply.)
      if (this._spinVisual !== 0) {
        this._eAg.set(0, this._spinVisual, 0);
        this._qSpin.setFromEuler(this._eAg);
        this.group.quaternion.multiply(this._qSpin);
      }
    } else {
      // Full reset (x AND z), not just yaw: a kart leaving anti-grav has a tilted
      // Euler left over from the slerp quaternion, so setting only .y would keep that
      // stale pitch/roll. -_rampPitch noses the kart UP a climbing ramp.
      this.group.rotation.set(-this._rampPitch, state.heading + this._spinVisual, 0);
    }

    // 3) Wheel rolling. distance = speed*dt; angle = distance/r; negative X
    //    rolls the tipped cylinder forward, so subtract.
    const distance = state.speed * dt;
    const rollDelta = -distance / this.wheelRadius;
    for (const wheelPivot of this.allWheels) {
      wheelPivot.rotation.x += rollDelta;
    }

    // 4) Front-wheel steering.
    const steerAngle = steer * this.maxSteerAngle;
    for (const frontPivot of this.frontWheels) {
      frontPivot.rotation.y = steerAngle;
    }

    // 5) Drift body roll (lean), eased via frame-rate-aware lerp. R12 ADDS the
    //    model's state.lean (banking into NORMAL turns) on top, but ONLY when not
    //    drifting — during a drift the existing _bodyRoll already commits the kart
    //    into the slide, so we keep that exact prior behaviour and don't
    //    double-bank. The result: drifts lean as before, and ordinary cornering
    //    now also banks the body (a new arcade feel) via state.lean.
    const rollTarget = state.drifting ? -(state.driftDir || 0) * this.maxBodyRoll : 0;
    const rollLerp = 1 - Math.exp(-12 * dt);
    this._bodyRoll += (rollTarget - this._bodyRoll) * rollLerp;
    const turnLean = state.drifting ? 0 : (state.lean || 0);
    // AIR-TRICK barrel roll (signature hook): state.trickRot spins the body around
    // the forward/driving axis (local Z) mid-air, layered on top of the drift/turn
    // lean. The model eases it back to 0 on the ground, so the kart rights itself on
    // landing. Defaults to 0, so a kart that never tricks stays visually identical.
    this.bodyGroup.rotation.z = this._bodyRoll + turnLean + (state.trickRot || 0);

    // 6) Hop bounce (sine arc during the initial drift hop).
    let hopY = 0;
    if (state.hopTimer && state.hopTimer > 0) {
      const HOP_REF = 0.18;
      const phase = Math.min(state.hopTimer / HOP_REF, 1);
      hopY = Math.sin(phase * Math.PI) * 0.22;
    }
    // (bodyGroup.position.y is written in 6b below, combining hopY + squash sink.)

    // 6b) Suspension squash + accel/brake pitch (R12, visual only). state.pitch
    //     noses the body up under throttle / down under brake; state.suspension
    //     (0..1, peaks on landing) squashes the body down + a touch wider so a
    //     touchdown reads with a satisfying compress-and-rebound. Both default to
    //     0, so a kart/server that never sets them stays perfectly upright.
    this.bodyGroup.rotation.x = state.pitch || 0;
    const squash = state.suspension || 0;          // 0..1 compression
    this.bodyGroup.scale.y = 1 - 0.18 * squash;    // sink the body on impact
    this.bodyGroup.scale.x = 1 + 0.10 * squash;    // bulge slightly wider (squash-and-stretch)
    this.bodyGroup.scale.z = 1 + 0.10 * squash;
    // Drop the body a hair as it compresses so the squash settles toward the
    // wheels rather than floating in place (added to any hop bounce above).
    this.bodyGroup.position.y = hopY - 0.10 * squash;

    // 6c) Glider deploy/retract (R12). Ease _gliderDeploy toward 1 while gliding,
    //     0 otherwise, so the parafoil unfurls + furls smoothly. Hide it entirely
    //     once fully stowed to save a draw call on the (common) non-gliding kart.
    if (this._gliderGroup) {
      const deployTarget = state.gliding ? 1 : 0;
      const deployLerp = 1 - Math.exp(-10 * dt);
      this._gliderDeploy += (deployTarget - this._gliderDeploy) * deployLerp;
      if (this._gliderDeploy < 0.002) this._gliderDeploy = 0;
      const visible = this._gliderDeploy > 0;
      if (this._gliderGroup.visible !== visible) this._gliderGroup.visible = visible;
      if (visible) {
        // Scale from a collapsed sliver up to full span as it unfurls.
        const s = 0.05 + 0.95 * this._gliderDeploy;
        this._gliderGroup.scale.set(s, s, s);
      }
    }

    // 7) Drift sparks (pooled, colored by mini-turbo tier).
    this._updateSparks(state, dt);

    // 8) Neon underglow pulse.
    //    When NOT in a star, gently shimmer the glow accents so the kart feels
    //    alive, and boost the glow while drifting (charging a mini-turbo) for an
    //    energized look. Skipped while a star is active (the star drives these
    //    same materials in step 9). The pulse is cheap: one sine per frame.
    const starActive = !!(state.starTimer && state.starTimer > 0);
    if (!starActive && this._glowMaterials.length) {
      const shimmer = 0.85 + 0.15 * Math.sin(this._effectClock * 4);
      // Drift boost lowered 0.6 -> 0.22 to match the lower base glow: the
      // accents still brighten while charging a mini-turbo, but no longer blow
      // out to white.
      const driftBoost = state.drifting ? 0.22 : 0;
      // ANTI-GRAV: brighten the underglow/trim while riding a wall/ceiling, ramped by
      // _agBlend so the zone reads as "energized" and the entry/exit shimmers in/out.
      const agGlow = this._agBlend * 0.35;
      const intensity = this._glowBaseIntensity * shimmer + driftBoost + agGlow;
      for (const mat of this._glowMaterials) {
        mat.emissiveIntensity = intensity;
      }
    }

    // 8b) ANTI-GRAV blue wheels: ease the wheel hubs toward MK8 anti-grav blue while
    //     in a section (by _agBlend), restoring the captured base on exit. Cheap; the
    //     hub material isn't in _tintTargets (wheels live on group, not bodyGroup), so
    //     this never collides with the star tint.
    if (this._wheelGlowMats) {
      const k = this._agBlend;
      for (const w of this._wheelGlowMats) {
        if (k <= 0) {
          if (w._tinted) {
            w.material.emissive.copy(w.baseEmissive);
            w.material.emissiveIntensity = w.baseIntensity;
            w._tinted = false;
          }
        } else {
          w.material.emissive.copy(w.baseEmissive).lerp(this._agWheelColor, k);
          w.material.emissiveIntensity = w.baseIntensity + (1.4 - w.baseIntensity) * k;
          w._tinted = true;
        }
      }
    }

    // 9) Star flash (rainbow emissive) — overrides ALL emissive materials,
    //    including the neon accents, so the whole kart whirls through the hue
    //    wheel and pulses. Restored exactly once when the star ends.
    if (starActive) {
      const hue = (this._effectClock * 2.0) % 1;
      const pulse = 0.5 + 0.5 * Math.sin(this._effectClock * 30);
      this._tintScratch.setHSL(hue, 1.0, 0.5);
      for (const t of this._tintTargets) {
        t.material.emissive.copy(this._tintScratch);
        t.material.emissiveIntensity = 0.6 + 0.8 * pulse;
      }
      this._tinted = true;
    } else if (this._tinted) {
      for (const t of this._tintTargets) {
        t.material.emissive.copy(t.baseEmissive);
        t.material.emissiveIntensity = t.baseIntensity;
      }
      this._tinted = false;
    }

    // 10) Shrink scale.
    const SHRINK_SCALE = 0.6;
    const targetScale = state.shrinkTimer && state.shrinkTimer > 0 ? SHRINK_SCALE : 1;
    if (this.group.scale.x !== targetScale) {
      this.group.scale.setScalar(targetScale);
    }
  }
}
