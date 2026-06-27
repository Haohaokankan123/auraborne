// src/core/QualitySettings.js
//
// One small SINGLETON that owns the graphics QUALITY TIER for the whole game.
// Everything that costs GPU time (pixel ratio, shadows, bloom, the grade-pass
// radial blur, particle counts, starfield density) reads its budget from ONE
// place here, so a single slider in the pause menu can scale the game from
// "runs at 60fps on a school Chromebook" up to "ultra on a desktop GPU".
//
// THE HEADLINE COST this fixes: the renderer used to draw at min(devicePixelRatio,
// 2) — i.e. 4x the pixels of a 1x screen on any Retina/HiDPI display. That alone
// is why a powerful laptop's fans spin on a simple kart game. pixelRatioCap is the
// single biggest lever in the matrix below.
//
// Persistence + default:
//   - The chosen tier persists to localStorage under 'mk_quality_tier' (same
//     guarded pattern the AudioManager/PauseMenu prefs use).
//   - DEFAULT is 'medium'. We do a LAZY, COARSE auto-detect (small touch screen
//     => 'low', everything else => 'medium'). We deliberately do NOT probe
//     navigator.gpu / await an adapter in a constructor — that's flaky, async,
//     and unsupported on the exact weak hardware we care about. A coarse heuristic
//     the player can override with the slider is the right amount of cleverness.
//
// Usage:
//   import qualitySettings, { TIERS } from './QualitySettings.js';
//   const cfg = qualitySettings.getConfig();   // the active tier's budget
//   qualitySettings.setTier('low');            // persists + notifies subscribers

// localStorage key for the persisted tier (one key, like the volume/skin prefs).
const LS_KEY = 'mk_quality_tier';

// The four tiers, low -> ultra, in slider order.
export const TIERS = ['low', 'medium', 'high', 'ultra'];

// THE MATRIX. Each tier maps to a flat budget object the renderer + effect layers
// read. Keep this the SINGLE source of truth — no magic numbers scattered around.
//   pixelRatioCap      max devicePixelRatio we render at (the headline lever).
//   shadows            whether the sun casts shadows at all.
//   shadowMapSize      sun shadow map resolution (only matters when shadows on).
//   bloomStrengthScale multiplier on every setBloom() call (0 = bloom fully off).
//   antialias          MSAA on the WebGL context (CANNOT change without a reload).
//   gradeBlurTaps      texture taps the grade-pass radial speed blur uses (1 = a
//                      single cheap sample, 6 = the full smooth smear).
//   particleScale      0..1 multiplier on the ItemVFX particle pool budget.
//   starScale          0..1 multiplier on the Track starfield object count.
//   renderScaleFloor   lowest the adaptive-resolution governor (Loop.js) may scale
//                      the effective pixel ratio DOWN to when the 16.6ms frame budget
//                      is blown. It NEVER scales above the tier cap — it only ever
//                      renders FEWER pixels, so it adds NO new GPU load on LOW. LOW
//                      floors at 0.6 (Chromebook safety net); MED+ at 0.7.
//   --- GRAPHICS RICHNESS (gated so LOW stays byte-for-byte as cheap as today) ---
//   litItems           HIGH+: build item/projectile body meshes as LIT MeshStandard
//                      (shade with the scene + cast/receive shadows) keeping an
//                      emissive core so they still pop; LOW/MED keep cheap unlit Basic.
//   envMapIntensity    A SCALE on every PBR material's authored env reflection, where
//                      1.0 == today's look. 0 = no reflections (LOW; no added per-frame
//                      cost — the env sample already ran today, now multiplied by 0).
//                      >1 = glossier chrome / road sheen (HIGH 1.25, ULTRA 1.5). MED
//                      stays 1.0 so its render is byte-identical to today.
//   roadDetail         'flat' = today's road material (LOW/MED, untouched). 'normal' =
//                      + a subtle scrolling normal map for micro-relief (HIGH). 'shader'
//                      = stronger relief + a faster speed-shimmer scroll (ULTRA).
const TIER_CONFIGS = {
  // LOW — the Chromebook floor. 1x pixels, no shadows, no bloom, no AA, a single
  // grade sample, and the fewest particles/stars. These are the big cuts that buy
  // a steady 60fps on weak integrated GPUs.
  low: {
    tier: 'low',
    pixelRatioCap: 1,
    shadows: false,
    shadowMapSize: 512,
    bloomStrengthScale: 0,
    antialias: false,
    gradeBlurTaps: 1,
    particleScale: 0.35,
    starScale: 0.3,
    renderScaleFloor: 0.6,
    // Graphics richness all OFF — exactly today's cheap path. envMapIntensity 0
    // multiplies the (already-present) env sample by 0, so no NEW per-frame cost.
    litItems: false,
    envMapIntensity: 0,
    roadDetail: 'flat',
  },
  // MEDIUM — the sensible default. A 1.5x cap already roughly halves the pixel
  // count vs the old 2x on a Retina screen; small shadows + AA + ~60% bloom keep
  // it looking good without roasting the GPU.
  medium: {
    tier: 'medium',
    pixelRatioCap: 1.5,
    shadows: true,
    shadowMapSize: 512,
    bloomStrengthScale: 0.6,
    antialias: true,
    gradeBlurTaps: 3,
    particleScale: 0.7,
    starScale: 0.7,
    renderScaleFloor: 0.7,
    // MED keeps today's look: unlit items, env scale 1.0 (== current default),
    // flat road material. The richer paths only switch on at HIGH+.
    litItems: false,
    envMapIntensity: 1.0,
    roadDetail: 'flat',
  },
  // HIGH — full look. 2x pixels, 1024 shadows, full bloom + the smooth 6-tap blur,
  // all particles and stars.
  high: {
    tier: 'high',
    pixelRatioCap: 2,
    shadows: true,
    shadowMapSize: 1024,
    bloomStrengthScale: 1.0,
    antialias: true,
    gradeBlurTaps: 6,
    particleScale: 1.0,
    starScale: 1.0,
    renderScaleFloor: 0.7,
    // HIGH turns on the richer look: lit shadow-aware items, glossier env (1.25),
    // and a scrolling normal-map road for real micro-relief.
    litItems: true,
    envMapIntensity: 1.25,
    roadDetail: 'normal',
  },
  // ULTRA — high + a touch extra: crisper 2048 shadows and slightly richer bloom.
  ultra: {
    tier: 'ultra',
    pixelRatioCap: 2,
    shadows: true,
    shadowMapSize: 2048,
    bloomStrengthScale: 1.15,
    antialias: true,
    gradeBlurTaps: 6,
    particleScale: 1.0,
    starScale: 1.0,
    renderScaleFloor: 0.7,
    // ULTRA: max gloss (env 1.5), the speed-shimmer road shader, lit items.
    litItems: true,
    envMapIntensity: 1.5,
    roadDetail: 'shader',
  },
};

class QualitySettings {
  constructor() {
    // Subscribers notified on setTier() (e.g. a live HUD readout). The Renderer
    // doesn't subscribe — main.js calls renderer.setQualityTier directly so the
    // apply order is explicit — but the hook is here for anything that wants it.
    this._subs = new Set();
    // GOVERNOR BRIDGE: the adaptive-resolution governor lives in Loop.js, but the
    // thing that actually applies a render scale is the Renderer — two siblings
    // created in main.js with no direct reference to each other. This singleton is
    // imported by BOTH, so it's the bridge: the Renderer registers its setRenderScale
    // here (setRenderScaleSink), and Loop's governor calls applyRenderScale to drive
    // it. Stays null until a Renderer registers, so applyRenderScale is a safe no-op
    // before then (and in headless/test contexts with no renderer).
    this._renderScaleSink = null;
    this.tier = this._load();
  }

  // Read the saved tier, or fall back to the coarse auto-detected default. We do
  // NOT persist the auto-detected default — only an explicit setTier() writes — so
  // a device whose window later grows isn't permanently pinned to 'low'.
  _load() {
    let stored = null;
    try {
      stored = localStorage.getItem(LS_KEY);
    } catch (e) {
      // localStorage can throw in private mode / sandboxed iframes — ignore.
    }
    if (stored && TIER_CONFIGS[stored]) return stored;
    return this._autoDetect();
  }

  // ponytail: coarse heuristic, not a GPU benchmark. A small touch screen is the
  // Chromebook/phone case -> 'low'; everything else gets 'medium' and the player
  // can bump it up. Upgrade path: swap in a real frame-time probe if 'medium'
  // ever proves too heavy for a class of low-end laptops.
  _autoDetect() {
    let coarse = false;
    try {
      coarse =
        (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ||
        'ontouchstart' in window;
    } catch (e) {
      coarse = false;
    }
    const w = (typeof window !== 'undefined' && window.innerWidth) || 0;
    const h = (typeof window !== 'undefined' && window.innerHeight) || 0;
    const small = Math.min(w, h) < 700;
    return coarse && small ? 'low' : 'medium';
  }

  // The budget object for a tier (defaults to the active tier). Always returns a
  // valid config (falls back to 'medium' for an unknown tier).
  getConfig(tier = this.tier) {
    return TIER_CONFIGS[tier] || TIER_CONFIGS.medium;
  }

  // Switch tiers: persist + notify subscribers. Returns the new config so callers
  // (the Renderer) can apply it in one line. Ignores an unknown tier.
  setTier(tier) {
    if (!TIER_CONFIGS[tier]) return this.getConfig();
    this.tier = tier;
    try {
      localStorage.setItem(LS_KEY, tier);
    } catch (e) {
      // Best-effort persistence.
    }
    const cfg = this.getConfig();
    for (const fn of this._subs) {
      try {
        fn(cfg);
      } catch (e) {
        // A bad subscriber must not break tier switching.
      }
    }
    return cfg;
  }

  // Register a listener; returns an unsubscribe function.
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  // GOVERNOR BRIDGE (see constructor): the Renderer registers a (scale) => void
  // callback here; Loop's adaptive-res governor calls applyRenderScale to reach it.
  setRenderScaleSink(fn) {
    this._renderScaleSink = typeof fn === 'function' ? fn : null;
  }

  // Hand the governor's chosen render scale (0..1, a multiplier on the tier pixel
  // ratio cap) to the registered Renderer. No-op if none is registered yet.
  applyRenderScale(scale) {
    if (this._renderScaleSink) this._renderScaleSink(scale);
  }
}

// The ONE shared instance. Importing this module anywhere initialises it once.
const qualitySettings = new QualitySettings();

export { TIER_CONFIGS };
export default qualitySettings;
