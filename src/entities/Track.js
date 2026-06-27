// src/entities/Track.js
//
// A procedurally-built ELEVATED, FLOATING themed race course. No external model
// or image files — everything is generated at runtime from the shared, pure
// layout data in shared/trackData.js.
//
// PHASE 3 — LONG, WINDING, HILLY SPLINE COURSES (this rewrite)
// ---------------------------------------------------------------------------
// The old tracks were short flat "stadium" ovals built from 5 numbers, walled in
// by glowing rails that doubled as colliders. They are replaced here by long
// (~3000-4000m lap), winding, HILLY courses defined as a closed-loop Catmull-Rom
// SPLINE in shared/trackData.js (each control point carries its own `y`, so the
// course climbs and dips for real).
//
// WHAT CHANGED IN RENDER (vs the old oval Track):
//   - The road is now a SWEPT RIBBON: we sample the centerline densely via
//     trackData.sampleCenter(), build left/right edges = center ± XZ-normal *
//     halfWidth, FOLLOW the per-sample `y` so the ribbon rides the hills, gently
//     BANK the turns, and stitch it all into ONE BufferGeometry triangle strip
//     (with normals + UVs). No more box slabs + ring lids.
//   - NO WALLS / NO FENCES. `this.wallColliders = []`. The neon EDGE LINES are
//     now VISUAL-ONLY emissive strips along each edge — they DO NOT collide.
//   - FEATURE MESHES are placed from trackData.listFeatures(): ramp launch
//     wedges, boost-pad chevron strips, hazard objects (cones / oil-slick
//     decals), and shortcut branch ribbons — each oriented by its returned
//     {tx,tz} driving tangent and sitting on the terrain `y`.
//
// Conventions (must match the rest of the project):
//   - Y is up; the course winds through the XZ plane; world units = meters.
//   - heading is in radians; forward = (sin(heading), 0, cos(heading)).
//
// THEMES (chosen by the track's `theme` field in shared/trackData.js):
//   - 'rainbow' (Rainbow Ridge)   : animated rainbow road + edges, black void
//                                   starfield sky.
//   - 'space'   (Cosmic Speedway) : dark metallic road, cyan/magenta edges,
//                                   black void starfield sky.
//   - 'sky'     (Cloudtop Circuit): bright road, white/gold edges, soft blue sky.
//
// Public surface (PRESERVED — the rest of the code reads these unchanged):
//   - track.group          THREE.Group containing EVERYTHING — road ribbon, edge
//                          lines, feature meshes, checkpoint visuals, AND the
//                          skybox/stars added by applyTheme. Removing track.group
//                          cleans it all up.
//   - track.collider       The road ribbon mesh (a single raycast target kept for
//                          any leftover height raycasts; physics no longer needs
//                          it — karts ride hills via trackData.sampleSurface()).
//   - track.startPosition  { x, y, z, heading } spawn pose (from shared data).
//   - track.checkpoints    Ordered [{ x, y, z, index }] gates (now WITH y),
//                          index 0 = start/finish, in the driving direction.
//   - track.roadColliders  Array holding the road ribbon mesh (surface raycasts).
//   - track.wallColliders  [] — NO walls/fences anymore (fenceless courses).
//   - track.isOnRoad(x, z) Point-in-road test; delegates to trackData.isOnRoad().
//   - track.applyTheme(scene)  Set scene.background + scene.fog for the theme and
//                          attach the skybox/stars to track.group.
//   - track.update(dt)     Per-frame hook: animates the rainbow hue cycle + star
//                          twinkle.

import * as THREE from 'three';
// Shared, renderer-free layout data — the SINGLE SOURCE OF TRUTH for the course
// geometry, checkpoints, spawn pose, elevation, theme AND features. The server
// uses the same module so its simulation lines up exactly with what we render.
import {
  TRACKS,
  buildCheckpoints,
  getTrackTheme,
  getStartPosition,
  sampleCenter,
  listFeatures,
  isOnRoad as trackIsOnRoad,
  bankAngleAt,
  MAX_BANK,
  BANK_GAIN,
  // ANTI-GRAV: the road ribbon + a bright neon rail TWIST through a corkscrew section
  // using the SAME pure surface frame the physics rides, so the visible road follows
  // the kart onto the wall/ceiling. antigravAt gates which samples twist.
  antigravAt,
  surfaceFrameAt,
} from '../../shared/trackData.js';

// QUALITY TIER: scales the starfield object count so weak GPUs draw fewer points.
import qualitySettings from '../core/QualitySettings.js';

// Fallback theme colors used when a track omits `themeColors`. Picks a neutral
// 'sky'-ish look so an un-themed track still renders something sensible.
const DEFAULT_THEME_COLORS = {
  road: 0xeef3ff,
  rail: 0xffffff,
  rail2: 0xffd34d,
};

// How many lengthwise samples to sweep the road ribbon along the loop. The
// spline is long and winding AND HILLY, so we need a dense ribbon to keep both
// corners and the rise/fall of the hills smooth — too few segments and the hills
// read as flat faceted chevrons. (trackData caches its own 1200-sample polyline;
// this is the RENDER tessellation and is independent of that.) Higher = smoother
// ribbon + smoother hill shading at a one-time build cost (these are static
// geometries built ONCE at track load, never per frame, so 1500 is cheap).
const RIBBON_SAMPLES = 1500;

// Resolution of the generated road CANVAS texture. Width (U / across the road) is
// modest because the markings are simple vertical bands; height (V / along the
// road) is tall so the dashed center line, the flowing rainbow spectrum and the
// energy grid all tile crisply along the loop length. One shared texture per
// track is built ONCE — we never repaint the canvas per frame (we scroll it via
// texture.offset, which is a free GPU-side UV shift).
const ROAD_TEX_W = 256;
const ROAD_TEX_H = 1024;

// MAX_BANK / BANK_GAIN and the bank formula now live in shared/trackData.js
// (imported above) so the rendered road and the physics groundY use the IDENTICAL
// numbers and sign convention — a kart sits flush on the visibly-tilted road. We
// tilt the ribbon INTO each turn for the MK8 "banked wall" feel; the kerb/apron
// strips below follow the SAME bank so the whole cross-section rolls together.

export class Track {
  /**
   * @param {string} [trackId='circuit'] which course to build (key in TRACKS).
   *   Unknown / missing ids fall back to the default 'circuit' track.
   */
  constructor(trackId = 'circuit') {
    // Resolve the chosen track's data; fall back to 'circuit' if unknown.
    const data = TRACKS[trackId] || TRACKS.circuit;
    this.trackId = TRACKS[trackId] ? trackId : 'circuit';
    this.data = data;

    // Theme id + per-track color hints + elevation (from the shared module so
    // the sim and render agree on the floating baseline height).
    const themeInfo = getTrackTheme(this.trackId);
    this.themeId = themeInfo.theme;                 // 'rainbow' | 'space' | 'sky'
    this.elevation = themeInfo.elevation;           // m — floating baseline height
    this.colors = { ...DEFAULT_THEME_COLORS, ...themeInfo.colors };

    // QUALITY graphics knobs read ONCE at build (the road geometry/materials are
    // built once per track load, never per frame). envScale multiplies the road's
    // authored env reflection (0 on LOW = none, 1.0 MED = today, 1.25/1.5 HIGH/ULTRA
    // = glossier sheen); roadDetail gates the scrolling normal map (flat on LOW/MED).
    const _q = qualitySettings.getConfig();
    this._envScale = _q.envMapIntensity;
    this._roadDetail = _q.roadDetail;
    // tier name gates the cheap-but-nice continuous polish that LOW must NOT get
    // (round star sprites, the horizon sun) so LOW stays byte-equivalent to today;
    // litItems (HIGH+) gates the wet rail-reflection streaks + the road sheen bump.
    this._tier = _q.tier;
    this._litItems = _q.litItems;

    // Root group: external code adds `track.group` to the scene. Holds the road
    // ribbon, edge lines, feature meshes, checkpoints, AND (after applyTheme) the
    // skybox/stars.
    this.group = new THREE.Group();
    this.group.name = 'Track';

    // Size hint (kept for previews / callers); no longer a ground plane.
    this.groundSize = data.groundSize;

    // Full drivable width (m). The ribbon spans ±roadWidth/2 about the centerline.
    this.roadWidth = data.roadWidth;

    // Animation state for update(dt): scroll phase + material/texture refs.
    this._time = 0;
    this._animatedRoadMats = []; // road materials whose hue cycles (rainbow)
    this._animatedEdgeMats = []; // edge-line materials whose hue cycles (rainbow)
    this._starMaterials = [];    // Points materials we gently twinkle
    this._starLayers = [];       // parallax star layers { obj, drift } we rotate
    this._spinProps = [];        // spinning decor (sky windmills) { obj, speed }
    // Road CANVAS textures we scroll along V (length) every frame for a SENSE OF
    // SPEED. Each entry is { tex, speed } — `speed` is V-units/sec. The rainbow
    // spectrum runs ALONG V, so scrolling it ALSO makes the spectrum flow + hue
    // cycle for free (no per-frame canvas repaint). One shared texture per track.
    this._scrollTextures = [];
    // (Legacy) animated EDGE-RAIL materials. The glowing neon rail — and its lurid
    // magenta left side — was REMOVED in favour of a static neutral kerb + shoulder
    // apron (see _buildEdgeLines). This array now stays EMPTY, so update(dt)'s rail
    // loop is a harmless no-op; the field is kept for back-compat.
    this._railMaterials = [];
    // Lazily-built shared soft-disc texture for the round star glints (MED+ only).
    this._starTex = null;

    // Start pose comes from shared data (single source of truth): on the
    // centerline at the start line, facing the driving direction (with hill y).
    this.startPosition = getStartPosition(this.trackId);

    // Build the pieces in order. No ground plane: the road IS a floating ribbon.
    this._buildRoadRibbon();    // swept hill-following ribbon (the surface)
    this._buildEdgeLines();     // neutral kerb + shoulder apron — VISUAL ONLY (no colliders)
    this._buildRailReflections(); // HIGH+ ONLY: wet additive rail/center glow streaks on the deck
    this._buildAntigravRails(); // bright neon tube rails along any anti-grav corkscrew
    this._buildFeatures();      // ramps / boost pads / hazards / shortcuts
    this._buildCheckpoints();   // centerline gates + start/finish visuals
    this._buildLandmarks();     // themed set-pieces / roadside props / banner / decor

    // FENCELESS: there are no wall colliders anymore. KartPhysics tolerates an
    // empty array (it early-returns when wallColliders.length === 0).
    this.wallColliders = [];
  }

  // =========================================================================
  // ROAD RIBBON
  // =========================================================================

  /**
   * Build the per-theme ROAD SURFACE TEXTURES from a single generated CANVAS
   * (no external image files). Returns BOTH a `map` (the lit albedo, so the road
   * reads as a real painted surface in shadow) and an `emissiveMap` (the parts
   * that GLOW through the gentle bloom: the center/lane/edge lines and — for
   * rainbow — the full-spectrum band). The same canvas pixels drive both maps;
   * we just dial how hot the emissive copy is via emissiveIntensity in
   * _makeRoadMaterial() so the markings light up but the road body stays calm.
   *
   * Layout (canvas X = U = ACROSS the road 0..1; canvas Y = V = ALONG the loop):
   *   - A bright DASHED CENTER LINE down the middle.
   *   - Two solid LANE LINES at ~1/4 and ~3/4 width.
   *   - EDGE STRIPES hugging both rims.
   *   - A theme body between the lines (rainbow spectrum / energy grid / clean).
   * The texture wraps on V (RepeatWrapping) and repeats `vRepeat` times along the
   * loop so the dashes/grid stay a sensible real-world size, and update(dt)
   * scrolls texture.offset.y for a strong sense of speed.
   *
   * @returns {{ map: THREE.CanvasTexture, emissiveMap: THREE.CanvasTexture,
   *            vRepeat: number }}
   * @private
   */
  _makeRoadTexture() {
    const w = ROAD_TEX_W;
    const h = ROAD_TEX_H;
    // The albedo canvas (lit by the sun — reads as paint on asphalt) and the
    // emissive canvas (only the glowing bits are non-black, so bloom only grabs
    // the lines/spectrum, NOT the whole road — that was the old washout cause).
    const albedo = document.createElement('canvas');
    albedo.width = w; albedo.height = h;
    const a = albedo.getContext('2d');
    const glow = document.createElement('canvas');
    glow.width = w; glow.height = h;
    const g = glow.getContext('2d');
    g.fillStyle = '#000000'; // emissive starts fully black (no glow)
    g.fillRect(0, 0, w, h);

    // Helper: paint a vertical band (a marking running ALONG the road) onto BOTH
    // canvases at the same U so the line lights up AND reads as paint.
    const band = (uCenter, uHalf, color, glowColor) => {
      const x = (uCenter - uHalf) * w;
      const bw = uHalf * 2 * w;
      a.fillStyle = color;
      a.fillRect(x, 0, bw, h);
      if (glowColor) {
        g.fillStyle = glowColor;
        g.fillRect(x, 0, bw, h);
      }
    };
    // Helper: paint a DASHED vertical band (dash on, gap off) along the road.
    const dashedBand = (uCenter, uHalf, color, glowColor, dashLen, gapLen) => {
      const x = (uCenter - uHalf) * w;
      const bw = uHalf * 2 * w;
      for (let y = 0; y < h; y += dashLen + gapLen) {
        a.fillStyle = color;
        a.fillRect(x, y, bw, dashLen);
        if (glowColor) {
          g.fillStyle = glowColor;
          g.fillRect(x, y, bw, dashLen);
        }
      }
    };

    if (this.themeId === 'rainbow') {
      // ---- SHOWPIECE: a flowing FULL-SPECTRUM rainbow running ALONG the road.
      // Painting the spectrum down V means scrolling V (update) BOTH flows it
      // forward AND cycles the hue for free — no per-frame canvas repaint. We
      // walk a FULL 360 deg of hue over the canvas height so it tiles seamlessly
      // when RepeatWrapping wraps top->bottom.
      // DARK road body FIRST. Like real Rainbow Road, the slab is a deep,
      // near-black surface so it can NEVER wash out no matter which hue is
      // currently scrolled into view. (The old code filled the WHOLE road with
      // the bright spectrum, which turned the entire slab lime-green at the
      // green phase — the washout the player kept seeing.)
      a.fillStyle = '#0b0a16';        // deep near-black violet asphalt
      a.fillRect(0, 0, w, h);
      // Rainbow SHEEN over the dark body: the full spectrum down V, but at LOW
      // alpha so it only TINTS the dark asphalt instead of replacing it.
      // Scrolling V still flows + cycles the hue; the body stays dark so the
      // road never blooms or washes — the bright bits are the lines + rails.
      // Alpha pulled down (0.20 -> 0.12) to CALM the magenta saturation so the
      // candied slab reads as a subtle tinted surface, not a lurid colour wash.
      a.globalAlpha = 0.12;
      for (let y = 0; y < h; y++) {
        const col = new THREE.Color().setHSL(y / h, 1.0, 0.5);
        a.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
        a.fillRect(0, y, w, 1);
      }
      a.globalAlpha = 1;
      // Emissive: only a WHISPER of the spectrum (well below the bloom
      // threshold) so the road has a faint colored life — the real glow comes
      // from the white lane lines + the neon edge rails, not the slab. Trimmed
      // (0.13 -> 0.07) so the body's self-glow is even fainter and the surface
      // fades cleanly into the void fog instead of holding a magenta sheen far off.
      g.globalAlpha = 0.07;
      for (let y = 0; y < h; y++) {
        const col = new THREE.Color().setHSL(y / h, 1.0, 0.5);
        g.fillStyle = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;
        g.fillRect(0, y, w, 1);
      }
      g.globalAlpha = 1;
      // Subtle sparkle: scattered bright pixels that twinkle through the bloom.
      for (let i = 0; i < 240; i++) {
        const sx = (Math.random() * w) | 0;
        const sy = (Math.random() * h) | 0;
        const s = 1 + (Math.random() * 2 | 0);
        a.fillStyle = 'rgba(255,255,255,0.6)';
        a.fillRect(sx, sy, s, s);
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.fillRect(sx, sy, s, s);
      }
      // Crisp WHITE lines so the lane structure reads against the spectrum.
      band(0.25, 0.012, '#ffffff', '#cfcfe0');               // left lane line
      band(0.75, 0.012, '#ffffff', '#cfcfe0');               // right lane line
      band(0.04, 0.03, '#ffffff', '#ffffff');                // left edge stripe
      band(0.96, 0.03, '#ffffff', '#ffffff');                // right edge stripe
      dashedBand(0.5, 0.02, '#ffffff', '#ffffff', 60, 60);   // dashed center line
      const map = new THREE.CanvasTexture(albedo);
      const emissiveMap = new THREE.CanvasTexture(glow);
      this._configRoadTex(map);
      this._configRoadTex(emissiveMap);
      return { map, emissiveMap, vRepeat: 24 };
    }

    if (this.themeId === 'space') {
      // ---- COSMIC: dark glassy road with a glowing cyan/magenta ENERGY GRID.
      a.fillStyle = '#06070d';        // near-black glass body
      a.fillRect(0, 0, w, h);
      const cyan = '#00e5ff';
      const magenta = '#ff2fe0';
      // Longitudinal glowing grid lines (cyan), running along the road.
      for (let u = 0.12; u < 1; u += 0.155) {
        band(u, 0.006, 'rgba(0,229,255,0.55)', 'rgba(0,150,170,1)');
      }
      // Lateral grid rungs (magenta), spaced down the length, that scroll to read
      // as forward motion. Painted on both canvases.
      const rung = 96;
      for (let y = 0; y < h; y += rung) {
        a.fillStyle = 'rgba(255,47,224,0.4)';
        a.fillRect(0, y, w, 3);
        g.fillStyle = 'rgba(150,20,150,1)';
        g.fillRect(0, y, w, 3);
      }
      // Lane lines + edge stripes + a bright cyan dashed center line.
      band(0.25, 0.008, 'rgba(180,240,255,0.5)', 'rgba(0,120,150,1)');
      band(0.75, 0.008, 'rgba(180,240,255,0.5)', 'rgba(0,120,150,1)');
      band(0.05, 0.025, cyan, '#0090a8');           // left edge stripe (cyan)
      band(0.95, 0.025, magenta, '#a000a0');        // right edge stripe (magenta)
      dashedBand(0.5, 0.014, cyan, '#00b4c8', 50, 70); // glowing cyan center line
      const map = new THREE.CanvasTexture(albedo);
      const emissiveMap = new THREE.CanvasTexture(glow);
      this._configRoadTex(map);
      this._configRoadTex(emissiveMap);
      return { map, emissiveMap, vRepeat: 20 };
    }

    // ---- SKY (and fallback): clean light-grey asphalt with crisp white lane
    // lines. The old body was a near-white #e9f1ff that pegged toward washout under
    // the bright sky sun; a soft cool ASPHALT grey (#c7d2e2) reads as a real paved
    // road, gives the white lane lines + gold rims something to POP against, and
    // can't bloom. This is the MK8 "clean tarmac" look — vibrant markings on a
    // legible mid-grey surface, not a glowing white slab.
    a.fillStyle = '#828ea6';          // MID blue-grey tarmac (was near-white #c7d2e2,
                                      // which pegged the road white under the sky sun)
    a.fillRect(0, 0, w, h);
    // Faint soft lane shading at the rims so the surface has gentle depth across
    // its width instead of a dead flat fill (darker toward the edges).
    const grad = a.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0.0, 'rgba(48,62,92,0.40)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.03)');
    grad.addColorStop(1.0, 'rgba(48,62,92,0.40)');
    a.fillStyle = grad;
    a.fillRect(0, 0, w, h);
    // Fine asphalt SPECKLE: scattered faint light/dark flecks so the tarmac reads
    // as a textured paved surface up close rather than a flat painted plane. Kept
    // very low-contrast so it never shimmers or reads as noise from the camera.
    for (let i = 0; i < 1400; i++) {
      const sx = (Math.random() * w) | 0;
      const sy = (Math.random() * h) | 0;
      const lite = Math.random() < 0.5;
      a.fillStyle = lite ? 'rgba(255,255,255,0.05)' : 'rgba(40,55,80,0.06)';
      a.fillRect(sx, sy, 1, 1);
    }
    band(0.25, 0.009, '#ffffff', '#dfe7f5');            // left lane line
    band(0.75, 0.009, '#ffffff', '#dfe7f5');            // right lane line
    band(0.045, 0.028, '#ffd34d', '#ffd34d');           // left edge stripe (gold)
    band(0.955, 0.028, '#ffd34d', '#ffd34d');           // right edge stripe (gold)
    dashedBand(0.5, 0.016, '#ffffff', '#ffffff', 70, 60); // dashed white center
    const map = new THREE.CanvasTexture(albedo);
    const emissiveMap = new THREE.CanvasTexture(glow);
    this._configRoadTex(map);
    this._configRoadTex(emissiveMap);
    return { map, emissiveMap, vRepeat: 16 };
  }

  /**
   * Apply the common wrap/filter settings every generated road texture needs:
   * RepeatWrapping on BOTH axes (so we can tile down the length and scroll the
   * offset seamlessly), with anisotropy bumped so the road stays crisp at the
   * glancing camera angles a kart sees.
   * @param {THREE.CanvasTexture} tex
   * @private
   */
  _configRoadTex(tex) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
  }

  /**
   * Make the themed road material, now driven by the generated CANVAS texture so
   * the road reads as a REAL track (dashed center line, lane lines, edge stripes,
   * and a theme body). The emissiveMap makes ONLY the markings/spectrum glow
   * through the gentle bloom — emissiveIntensity is kept MODERATE so the road
   * body never white-washes (the lines + neon rails carry the bright punch).
   *
   * The map's V repeat is set to tile the markings at a sensible scale, and the
   * texture is registered in this._scrollTextures so update(dt) scrolls it along
   * V for a strong sense of speed (and, for rainbow, cycles the spectrum hue).
   * @returns {THREE.MeshStandardMaterial}
   * @private
   */
  _makeRoadMaterial() {
    const { map, emissiveMap, vRepeat } = this._makeRoadTexture();
    // Tile down the length; U stays 1 (one marking layout across the width).
    map.repeat.set(1, vRepeat);
    emissiveMap.repeat.set(1, vRepeat);

    if (this.themeId === 'rainbow') {
      const mat = new THREE.MeshStandardMaterial({
        map,
        emissiveMap,
        // White emissive multiplier so the emissiveMap's own colors come through;
        // LOW intensity (0.28 -> 0.16) so the GLOW is confined to the white lane/edge
        // lines (full-bright in the emissiveMap) while the road BODY barely self-lights
        // — the surface now SHADES with the (dim) sun + form lights and FADES into the
        // void fog at distance instead of floating as a flat self-glowing magenta wedge.
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.16,
        // A semi-gloss dark surface (0.55 roughness + faint metalness/env) gives
        // Rainbow Road its signature wet-glass sheen — a soft moving highlight
        // slides over the deep near-black body as the camera sweeps. The body
        // stays dark (#0b0a16) so this sheen can NEVER wash out; only the white
        // lane lines + neon rails carry the bright punch, exactly as before.
        // metalness/env pulled DOWN (0.25->0.12, 0.4->0.15): the DoubleSide deck
        // shows its UNDERSIDE on elevated crossings, and at the old levels the
        // dielectric env-specular reflected the WARM studio environment so the
        // dark underside read BROWN/tan against the void. Lower env reflection =>
        // the underside (and body) stay COOL-dark while the direct-light highlight
        // + neon emissive lines still carry the signature top sheen.
        roughness: 0.55,
        metalness: 0.12,
        envMapIntensity: 0.15 * this._envScale,
        side: THREE.DoubleSide, // ribbon underside visible when looking up a hill
      });
      // The spectrum runs along V: scrolling it flows the rainbow AND cycles hue.
      this._scrollTextures.push({ tex: map, speed: 0.16 });
      this._scrollTextures.push({ tex: emissiveMap, speed: 0.16 });
      this._applyRoadDetail(mat, 0.16); // HIGH+: scrolling normal-map micro-relief
      return mat;
    }

    if (this.themeId === 'space') {
      const mat = new THREE.MeshStandardMaterial({
        map,
        emissiveMap,
        emissive: new THREE.Color(0xffffff),
        // Grid + center line glow; dark glass body stays near-black. Pulled down
        // (0.5 -> 0.3) so the glow is confined to the grid/center lines and the road
        // BODY shades + fades into the void fog at distance rather than self-glowing
        // as a flat bright wedge — same readability fix as the rainbow road.
        emissiveIntensity: 0.3,
        // Semi-gloss black glass — sleek sci-fi sheen without a mirror wash.
        // metalness/env pulled DOWN (0.3->0.12, 0.3->0.15) for the same reason as
        // rainbow: the DoubleSide deck's UNDERSIDE on elevated crossings was
        // reflecting the WARM studio env and reading brown against the void; a
        // cooler/dimmer reflection keeps the underside on-theme cool-dark while
        // the cyan grid + center line still carry the glow.
        roughness: 0.5,
        metalness: 0.12,
        envMapIntensity: 0.15 * this._envScale,
        side: THREE.DoubleSide,
      });
      // Scroll the grid down the road for a fast forward-motion feel.
      this._scrollTextures.push({ tex: map, speed: 0.22 });
      this._scrollTextures.push({ tex: emissiveMap, speed: 0.22 });
      this._applyRoadDetail(mat, 0.22); // HIGH+: scrolling normal-map micro-relief
      return mat;
    }

    // 'sky' (and fallback): clean grey asphalt with soft glowing markings and a
    // gentle clear-coat sheen.
    const mat = new THREE.MeshStandardMaterial({
      map,
      emissiveMap,
      emissive: new THREE.Color(0xffffff),
      // Sky is a bright scene — a 0.35 WHITE emissive across the whole road body was
      // self-lighting the tarmac toward white (a big part of the pale "washed out"
      // look). Drop it to 0.12 so only the bright markings in the emissiveMap lift;
      // the grey road body now reads as a real, legible surface instead of glowing.
      emissiveIntensity: 0.12,
      // Slightly glossier (0.68 vs 0.8) so the tarmac catches a soft, broad
      // clear-coat highlight from the warm sun + sky environment — the clean MK8
      // "freshly paved" sheen. Still rough enough to stay matte-legible (no mirror
      // wash); the grey body keeps the road dark/legible regardless.
      roughness: 0.68,
      metalness: 0.0,
      // A faint environment reflection gives the sheen something to reflect (the
      // soft studio env), so the highlight reads as a real glossy road rather than
      // a flat lightened band. Kept low so it can't brighten the body.
      envMapIntensity: 0.35 * this._envScale,
      side: THREE.DoubleSide,
    });
    this._scrollTextures.push({ tex: map, speed: 0.14 });
    this._scrollTextures.push({ tex: emissiveMap, speed: 0.14 });
    this._applyRoadDetail(mat, 0.14); // HIGH+: scrolling normal-map micro-relief
    return mat;
  }

  /**
   * HIGH+ ROAD ENRICHMENT (gated by the quality tier's roadDetail).
   *
   * 'flat' (LOW/MED) -> no-op: the road material is byte-for-byte today's. This is
   * the guarantee that the cheap path stays cheap — no normal map, no extra sample.
   *
   * 'normal' (HIGH) / 'shader' (ULTRA) -> attach a SUBTLE generated NORMAL MAP that
   * scrolls WITH the road (registered in this._scrollTextures, so update(dt) already
   * advances it for free). It gives the tarmac believable micro-relief so the sun +
   * env sheen ripples as the surface streams past — a richer, more real road that
   * also reinforces the sense of speed, while the neon emissive lanes are untouched
   * (the emissiveMap is separate). 'shader' pushes the relief harder and scrolls the
   * grain faster for a tasteful per-theme speed shimmer. Conservative on purpose:
   * the road is the most-visible surface and must keep its clean neon-synthwave read.
   * @param {THREE.MeshStandardMaterial} mat  the road material to enrich.
   * @param {number} scrollSpeed  the road's V-scroll speed, so the grain flows with it.
   * @private
   */
  _applyRoadDetail(mat, scrollSpeed) {
    if (this._roadDetail === 'flat') return; // LOW/MED: untouched, stays cheap
    const shader = this._roadDetail === 'shader';
    const nrm = this._makeRoadNormalTexture();
    // Tile finer than the markings so the grain reads as small surface texture, not
    // big wavy bumps. U a couple times across, V many times down the loop.
    nrm.repeat.set(2, 48);
    mat.normalMap = nrm;
    const s = shader ? 0.55 : 0.32; // ULTRA relief a touch deeper than HIGH
    mat.normalScale = new THREE.Vector2(s, s);
    mat.needsUpdate = true;
    // Scroll the grain with the road; ULTRA scrolls faster for a speed shimmer.
    this._scrollTextures.push({ tex: nrm, speed: scrollSpeed * (shader ? 1.5 : 1.0) });
  }

  /**
   * Generate a SUBTLE tangent-space NORMAL MAP for the road grain (no image files).
   * Mostly flat (Z up) with a gentle scatter on X/Y so the surface gets fine relief.
   * Built once per track load (only on HIGH+), never per frame.
   * @returns {THREE.CanvasTexture}
   * @private
   */
  _makeRoadNormalTexture() {
    const w = 128, h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      // Neutral normal is (128,128,255); nudge X/Y a little for micro-relief.
      d[j + 0] = 128 + (Math.random() - 0.5) * 38; // X
      d[j + 1] = 128 + (Math.random() - 0.5) * 38; // Y
      d[j + 2] = 255;                              // Z (mostly up)
      d[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // A normal map is linear DATA, not color — keep it out of the sRGB pipeline.
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Build the SWEPT ROAD RIBBON along the spline.
   *
   * For each lengthwise sample s in [0,1) we ask trackData.sampleCenter() for the
   * centerline position (x,y,z — `y` follows the hills) and the unit XZ driving
   * tangent (tx,tz). The road's lateral direction is the XZ-normal (tz,-tx). The
   * two edge vertices are center ± normal * halfWidth. We BANK the ribbon by
   * tilting the edges in Y a little (using the local turn curvature) so corners
   * lean into the turn for an arcade feel.
   *
   * We stitch consecutive sample pairs into a triangle strip stored in ONE
   * BufferGeometry with positions, normals (computed) and UVs (V runs along the
   * loop length, U across the width) so textures / lighting behave.
   *
   * The resulting mesh is `this.collider` and the sole entry in
   * `this.roadColliders` — kept only for any leftover height raycasts; the kart
   * physics now rides hills via trackData.sampleSurface() instead.
   * @private
   */
  _buildRoadRibbon() {
    const roadMat = this._makeRoadMaterial();
    const halfW = this.roadWidth / 2;
    const N = RIBBON_SAMPLES;

    // First pass: gather centerline samples + tangents around the closed loop.
    // We store one extra wrapped sample at the end so the strip closes seamlessly.
    const centers = new Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const s = (i % N) / N;            // wrap the last sample back onto the first
      centers[i] = sampleCenter(this.trackId, s);
    }

    // Second pass: estimate signed turn curvature at each sample (how sharply the
    // tangent rotates) so we can BANK the ribbon into the turn. Positive = turning
    // right; we roll the road accordingly.
    const positions = new Float32Array((N + 1) * 2 * 3); // 2 edge verts/sample
    const uvs = new Float32Array((N + 1) * 2 * 2);

    let vAccum = 0; // running V coordinate (meters along the loop)
    for (let i = 0; i <= N; i++) {
      const c = centers[i];
      const u = (i % N) / N;

      let lx, ly, lz, rx, ry, rz;
      // ANTI-GRAV: inside a corkscrew section the cross-section ROLLS about the
      // tangent, so the two edge vertices come from the SAME pure surfaceFrameAt the
      // kart rides (center ± right*halfW, full 3D) — the visible road twists onto the
      // wall/ceiling exactly where the kart drives. DoubleSide (set in the material)
      // shows the underside when you're on the ceiling. Outside any section the edges
      // use the UNCHANGED flat-bank formula below, so every other track/section is
      // byte-identical in render. (At a boundary corkscrew==0 so the two formulas
      // meet flush over the gentle back sweep.)
      if (antigravAt(this.trackId, u)) {
        // L/R must match the non-section branch's convention (Left = center + fr.right,
        // since that branch's normal n=(tz,-tx) = -fr.right) so the ribbon edges line up
        // flush across the section boundary instead of swapping sides (twist seam).
        const fr = surfaceFrameAt(this.trackId, u, 0);
        lx = fr.worldPos.x + fr.right.x * halfW;
        ly = fr.worldPos.y + fr.right.y * halfW;
        lz = fr.worldPos.z + fr.right.z * halfW;
        rx = fr.worldPos.x - fr.right.x * halfW;
        ry = fr.worldPos.y - fr.right.y * halfW;
        rz = fr.worldPos.z - fr.right.z * halfW;
      } else {
        // XZ right-hand normal (perpendicular to the driving tangent): (tz, -tx).
        const nx = c.tz;
        const nz = -c.tx;
        // Bank (roll) from the SHARED source of truth so render == physics exactly.
        // bankAngleAt() reproduces the same signed-curvature formula (BANK_GAIN, clamp
        // to ±MAX_BANK, same sign convention) at this sample's spline param u, and the
        // physics sampleSurface reads the identical numbers — so groundY hugs the
        // visibly-tilted road. u for sample i is the same (i % N)/N used to build it.
        const bank = bankAngleAt(this.trackId, u);
        // Tilting about the driving axis raises one edge and lowers the other.
        const dY = Math.sin(bank) * halfW;
        // Left edge = center - normal*halfW ; right edge = center + normal*halfW.
        // (We bank by nudging each edge's y in opposite directions.)
        lx = c.x - nx * halfW;
        lz = c.z - nz * halfW;
        ly = c.y - dY;
        rx = c.x + nx * halfW;
        rz = c.z + nz * halfW;
        ry = c.y + dY;
      }

      const vi = i * 2 * 3;
      // Left edge vertex.
      positions[vi + 0] = lx;
      positions[vi + 1] = ly;
      positions[vi + 2] = lz;
      // Right edge vertex.
      positions[vi + 3] = rx;
      positions[vi + 4] = ry;
      positions[vi + 5] = rz;

      // UVs: U across the width (0 left, 1 right), V = RAW cumulative meters along
      // the loop for now. We NORMALIZE V to 0..1 over the whole loop in a second
      // pass below so the road material's texture.repeat.y cleanly controls how
      // many times the marking pattern tiles around the lap (otherwise a ~3500m V
      // range would tile the dashes thousands of times).
      if (i > 0) {
        const prev = centers[i - 1];
        vAccum += Math.hypot(c.x - prev.x, c.z - prev.z);
      }
      const ui = i * 2 * 2;
      uvs[ui + 0] = 0; uvs[ui + 1] = vAccum;
      uvs[ui + 2] = 1; uvs[ui + 3] = vAccum;
    }

    // Normalize V to 0..1 over the full loop length. `vAccum` now holds the total
    // arc length (the last sample wrapped back to the start). Dividing every V by
    // it maps the loop to one [0,1] span so texture.repeat.y == tiles-per-lap.
    const totalLen = vAccum || 1;
    for (let i = 0; i <= N; i++) {
      const ui = i * 2 * 2;
      uvs[ui + 1] /= totalLen;
      uvs[ui + 3] /= totalLen;
    }

    // REAL FALL-IN GAPS: read the carved chasm ranges from the track's `gap`
    // features. Each is a normalized spline-param range [startU,endU] (wrap-aware)
    // where the road STOPS — we must NOT stitch ribbon triangles there so the void
    // is visible (and the kart that missed the launch ramp falls in). The centerline
    // samples/vertices stay built (the spline is continuous); we only OMIT the
    // quads inside the range. This mirrors the shared isOnRoad() gap suppression so
    // the visible hole and the drivable hole line up exactly.
    const gapRanges = (this.data.features || [])
      .filter((f) => f.type === 'gap')
      .map((f) => {
        const p = f.params || {};
        const a = p.startU != null ? p.startU : (f.at - 0.005);
        const b = p.endU != null ? p.endU : (f.at + 0.005);
        return { a: ((a % 1) + 1) % 1, b: ((b % 1) + 1) % 1 };
      });
    const inGapRender = (u) => {
      for (let k = 0; k < gapRanges.length; k++) {
        const { a, b } = gapRanges[k];
        const hit = a <= b ? (u >= a && u <= b) : (u >= a || u <= b);
        if (hit) return true;
      }
      return false;
    };

    // Index buffer: two triangles per quad between consecutive samples. We SKIP a
    // quad whose segment midpoint param lies inside a carved gap, leaving a real
    // hole in the ribbon (a visible void over the chasm).
    const indices = [];
    for (let i = 0; i < N; i++) {
      // Param at this segment's midpoint (the quad spans sample i .. i+1).
      const segU = ((i + 0.5) % N) / N;
      if (inGapRender(segU)) continue; // carve the gap — no ribbon here
      const a = i * 2;       // left[i]
      const b = i * 2 + 1;   // right[i]
      const cc = (i + 1) * 2;     // left[i+1]
      const d = (i + 1) * 2 + 1;  // right[i+1]
      // Wind so the top face points up (normals will be recomputed).
      indices.push(a, cc, b);
      indices.push(b, cc, d);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    // Smooth-shade the ribbon: computeVertexNormals averages the triangle normals
    // meeting at each vertex, so the dense (1500-seg) hills render as smooth
    // curves rather than flat faceted chevrons.
    geo.computeVertexNormals();
    // WELD THE START/FINISH SEAM: vertex row 0 and row N sit at the SAME world
    // position (we wrapped the last sample onto the first) but are SEPARATE
    // vertices, so each got only HALF the surrounding faces' normals — leaving a
    // visible faceted crease across the start line. Average the two rows' normals
    // and write the shared result to both so the loop closes perfectly smoothly.
    const nrm = geo.attributes.normal;
    for (let k = 0; k < 2; k++) {            // k=0 left edge vertex, k=1 right
      const i0 = (0 * 2 + k);                // first row vertex index
      const iN = (N * 2 + k);                // last row vertex index (same spot)
      const ax = nrm.getX(i0) + nrm.getX(iN);
      const ay = nrm.getY(i0) + nrm.getY(iN);
      const az = nrm.getZ(i0) + nrm.getZ(iN);
      const len = Math.hypot(ax, ay, az) || 1;
      const ux = ax / len, uy = ay / len, uz = az / len;
      nrm.setXYZ(i0, ux, uy, uz);
      nrm.setXYZ(iN, ux, uy, uz);
    }
    nrm.needsUpdate = true;

    const ribbon = new THREE.Mesh(geo, roadMat);
    ribbon.name = 'roadRibbon';
    ribbon.receiveShadow = true;
    this.group.add(ribbon);

    // Keep the public ground-target surface the rest of the code references.
    this.collider = ribbon;
    this.roadColliders = [ribbon];

    // Stash for the edge-line builder (it reuses the same centerline samples AND
    // the same gap ranges so the kerb/apron are carved out over the chasm too).
    this._centers = centers;
    this._halfW = halfW;
    this._gapRanges = gapRanges;
    this._inGapRender = inGapRender;
  }

  // =========================================================================
  // EDGE LINES (VISUAL ONLY — NOT COLLIDERS)
  // =========================================================================

  /**
   * Build the road EDGE TREATMENT that hugs BOTH rims of the ribbon. PURELY
   * VISUAL — there are NO walls and NO colliders (`this.wallColliders` stays []).
   *
   * PINK RAIL REMOVED: the old build laid a bright glowing NEON RAIL (a shader
   * strip that pulsed down each rim) whose left side used the lurid MAGENTA
   * `themeColors.rail` (0xff2fd0 on Rainbow Ridge) — the harsh "pink row" the
   * course no longer wants. That whole neon-rail shader is gone. In its place we
   * build a clean, tasteful pair of strips per rim that FIT the surface:
   *
   *   1. A thin NEUTRAL KERB hugging each road edge — a low, matte, very faintly
   *      emissive strip in a calm theme accent (not a glowing tube). It just
   *      crisps the rim so the eye reads where the drivable road ends, the MK8
   *      painted-kerb look, instead of a candy-bright rail.
   *   2. A wider SHOULDER APRON just OUTSIDE the drivable edge — a darker band a
   *      few metres wide, dropped slightly and angled away, that follows the same
   *      hill `y` + bank. It softens the hard rim so when the player hugs the edge
   *      they see a dim shoulder falling away rather than the raw void (this is the
   *      "edge glitch" softener the brief asks for). Visual only; it sits OUTSIDE
   *      the road band so it never widens the drivable surface or affects physics.
   *
   * Both strips ride the SAME banked, hill-following cross-section as the ribbon
   * (so they lie flush), are built for the LEFT and RIGHT rim symmetrically, and
   * are STATIC (no per-frame animation — the speed read now comes from the road
   * texture scroll, not a pulsing rail). `this._railMaterials` is intentionally
   * left empty so update(dt)'s rail loop is a harmless no-op.
   * @private
   */
  _buildEdgeLines() {
    const centers = this._centers;
    const halfW = this._halfW;
    const N = centers.length - 1; // we stored N+1 (wrapped) samples

    // KERB: a thin strip inboard of the rim. APRON: a wider band outboard of it.
    const kerbW = Math.max(0.6, this.roadWidth * 0.035); // slim painted kerb
    const apronW = Math.max(3.5, this.roadWidth * 0.32); // shoulder a few m wide
    const apronDrop = 0.9;   // how far the outer apron edge sinks below the rim
    const lift = 0.06;       // tiny raise so the kerb never z-fights the road

    // Per-theme edge colors. KERB takes a CALM accent (the cooler `rail2` for the
    // dark themes; soft white-gold for sky) so the rim reads cleanly without the
    // old magenta. APRON is a dark, low-saturation shoulder tone per theme so it
    // recedes into the surround instead of drawing the eye.
    let kerbColor, kerbEmissive, apronColor;
    if (this.themeId === 'rainbow') {
      kerbColor = this.colors.rail2;   // calm cyan rim (was magenta `rail`)
      kerbEmissive = 0x101822;
      apronColor = 0x0b0a16;           // matches the deep near-black road body
    } else if (this.themeId === 'space') {
      kerbColor = this.colors.rail;    // cyan rim (space `rail` is already cyan)
      kerbEmissive = 0x06121a;
      apronColor = 0x05060c;           // near-black glass shoulder
    } else {
      kerbColor = 0xeef3ff;            // clean soft-white kerb for the bright sky
      kerbEmissive = 0x0a0e16;
      apronColor = 0x9fb6da;           // soft daylight blue shoulder that blends into the sky
    }

    // Shared per-sample geometry helper: for sample i, return the rim normal, the
    // banked edge height, and a small struct so both strips reuse the exact same
    // banked, hill-following cross-section the ribbon used.
    const edgeAt = (i, side) => {
      const c = centers[i];
      const cNext = centers[Math.min(i + 1, N)];
      const nx = c.tz;       // right-hand XZ normal (perpendicular to tangent)
      const nz = -c.tx;      // = (tz, -tx)
      // Recompute the SAME bank the ribbon used (BANK_GAIN) so the strips lie flush.
      const cross = c.tx * cNext.tz - c.tz * cNext.tx;
      const bank = Math.max(-MAX_BANK, Math.min(MAX_BANK, cross * BANK_GAIN));
      const dY = Math.sin(bank) * halfW;
      return { c, nx, nz, edgeY: c.y + side * dY };
    };

    // Build ONE quad-strip ribbon along a rim from an inner offset to an outer
    // offset (both signed by `side`), with a y delta applied to the OUTER edge
    // (used to drop the apron away from the road). Static MeshStandardMaterial so
    // the kerb/apron shade with the scene lighting and fade into the fog like the
    // road, never blooming. `side` = -1 left, +1 right.
    const buildBand = (side, innerOff, outerOff, outerDY, mat, name) => {
      const positions = new Float32Array((N + 1) * 2 * 3);
      for (let i = 0; i <= N; i++) {
        const { c, nx, nz, edgeY } = edgeAt(i, side);
        const ix = c.x + nx * innerOff;
        const iz = c.z + nz * innerOff;
        const ox = c.x + nx * outerOff;
        const oz = c.z + nz * outerOff;
        const vi = i * 2 * 3;
        positions[vi + 0] = ix;
        positions[vi + 1] = edgeY + lift;          // inner edge sits at the rim
        positions[vi + 2] = iz;
        positions[vi + 3] = ox;
        positions[vi + 4] = edgeY + lift + outerDY; // outer edge (apron drops away)
        positions[vi + 5] = oz;
      }

      const indices = [];
      for (let i = 0; i < N; i++) {
        // Carve the kerb/apron over a gap too, so the chasm void is clean (no strip
        // floating across the hole). Same segment-midpoint test the ribbon uses.
        // ALSO carve it over an anti-grav section — the flat kerb/dropped apron would
        // detach from the twisting road; a bright neon rail replaces them there.
        const segU = ((i + 0.5) % N) / N;
        if (this._inGapRender && this._inGapRender(segU)) continue;
        if (antigravAt(this.trackId, segU)) continue;
        const a = i * 2;
        const b = i * 2 + 1;
        const cc = (i + 1) * 2;
        const d = (i + 1) * 2 + 1;
        indices.push(a, cc, b);
        indices.push(b, cc, d);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals(); // proper shading on the angled apron

      const strip = new THREE.Mesh(geo, mat);
      strip.name = name;
      strip.frustumCulled = false; // long thin loop — keep both rims always drawn
      strip.receiveShadow = true;
      // VISUAL ONLY: not added to any collider list.
      this.group.add(strip);
    };

    // Matte kerb material: a calm rim accent with only a whisper of emissive so it
    // reads as a clean painted kerb (NOT a glowing tube). Double-sided so it's
    // visible from a banked angle.
    const kerbMat = new THREE.MeshStandardMaterial({
      color: kerbColor,
      emissive: new THREE.Color(kerbEmissive),
      emissiveIntensity: 0.5,
      roughness: 0.7,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    // Dark shoulder material: matte, no emissive, so the apron recedes as a quiet
    // band that hides the void at the rim rather than competing with the road.
    const apronMat = new THREE.MeshStandardMaterial({
      color: apronColor,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    for (const side of [-1, 1]) {
      const tag = side < 0 ? 'Left' : 'Right';
      // KERB: from the rim inboard by kerbW (flush, no drop).
      buildBand(side, side * (halfW - kerbW), side * halfW, 0, kerbMat, `roadKerb${tag}`);
      // APRON: from the rim outboard by apronW, sinking apronDrop as it goes.
      buildBand(side, side * halfW, side * (halfW + apronW), -apronDrop, apronMat, `roadShoulder${tag}`);
    }
  }

  // =========================================================================
  // ANTI-GRAV NEON RAILS (VISUAL ONLY — the corkscrew "anti-grav" read)
  // =========================================================================

  /**
   * Build a BRIGHT emissive neon TUBE along BOTH rims of every anti-grav section.
   * The kerb/apron are carved out over these sections (they'd detach from the
   * twisting road), so this replaces them with a glowing rail that TWISTS through
   * the corkscrew via the SAME pure surfaceFrameAt the kart + ribbon ride — making
   * the wall/ceiling zone read unmistakably as "anti-grav rails". DoubleSide so the
   * rail renders from the inside of the corkscrew too. No-op on tracks without an
   * `antigrav` array (every track but Rainbow Ridge today), so nothing else changes.
   * @private
   */
  _buildAntigravRails() {
    const sections = this.data.antigrav;
    if (!sections || !sections.length) return;
    const halfW = this.roadWidth / 2;
    const railW = Math.max(0.7, this.roadWidth * 0.06); // a thicker bright rim strip
    const lift = 0.14; // raise just proud of the deck so it never z-fights the ribbon
    const railColor = this.colors.rail2 != null ? this.colors.rail2 : 0x2fd0ff;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(railColor),
      emissive: new THREE.Color(railColor),
      emissiveIntensity: 1.4, // hot enough to bloom into a clear neon rail
      roughness: 0.4,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });
    const SEG = 160; // samples across a section — dense enough for a smooth twist
    for (const sec of sections) {
      for (const side of [-1, 1]) {
        const positions = new Float32Array((SEG + 1) * 2 * 3);
        for (let i = 0; i <= SEG; i++) {
          const u = sec.startU + (sec.endU - sec.startU) * (i / SEG);
          const fr = surfaceFrameAt(this.trackId, u, 0);
          const innerOff = side * (halfW - railW);
          const outerOff = side * halfW;
          const vi = i * 2 * 3;
          positions[vi + 0] = fr.worldPos.x + fr.right.x * innerOff + fr.up.x * lift;
          positions[vi + 1] = fr.worldPos.y + fr.right.y * innerOff + fr.up.y * lift;
          positions[vi + 2] = fr.worldPos.z + fr.right.z * innerOff + fr.up.z * lift;
          positions[vi + 3] = fr.worldPos.x + fr.right.x * outerOff + fr.up.x * lift;
          positions[vi + 4] = fr.worldPos.y + fr.right.y * outerOff + fr.up.y * lift;
          positions[vi + 5] = fr.worldPos.z + fr.right.z * outerOff + fr.up.z * lift;
        }
        const indices = [];
        for (let i = 0; i < SEG; i++) {
          const a = i * 2, b = i * 2 + 1, cc = (i + 1) * 2, d = (i + 1) * 2 + 1;
          indices.push(a, cc, b);
          indices.push(b, cc, d);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        const strip = new THREE.Mesh(geo, mat);
        strip.name = 'antigravRail';
        strip.frustumCulled = false;
        this.group.add(strip);
      }
    }
  }

  // =========================================================================
  // RAIL REFLECTIONS (VISUAL ONLY — HIGH+ wet/Tron deck glow)
  // =========================================================================

  /**
   * HIGH+ ONLY (gated on the quality tier's litItems). Lay thin ADDITIVE emissive
   * streaks FLUSH on the road deck — one inboard of each rim (mirroring the kerb/rail
   * accent) and one under the center line — so the bright rim + center lines read as
   * if they're REFLECTED in a wet, polished surface (the synthwave/Tron look). Each
   * streak is brightest at its source line and fades to NOTHING toward the road center
   * (the inner edge is painted black, which under additive blending contributes zero).
   * A small env-reflection sheen bump on the road material completes the wet read.
   *
   * LOW/MED never reach here (early-return), so the cheap tiers add ZERO geometry and
   * ZERO extra draw cost — strict LOW byte-equivalence is preserved. The streaks ride
   * the SAME banked, hill-following cross-section the ribbon uses (so they lie flush)
   * and are carved out over gaps + anti-grav sections exactly like the kerb, so they
   * never float across a chasm or detach from a twisting corkscrew deck.
   * @private
   */
  _buildRailReflections() {
    if (!this._litItems) return;          // HIGH+ only; LOW/MED add no geometry
    const centers = this._centers;
    if (!centers) return;
    const halfW = this._halfW;
    const N = centers.length - 1;         // we stored N+1 (wrapped) samples

    // Mirror the per-theme rim + center-line colors onto the deck. Rails take the same
    // calm accent the kerb uses; the center streak mirrors the bright center line.
    let railCol, centerCol;
    if (this.themeId === 'rainbow') {
      railCol = new THREE.Color(this.colors.rail2);
      centerCol = new THREE.Color(0xffffff);
    } else if (this.themeId === 'space') {
      railCol = new THREE.Color(this.colors.rail);
      centerCol = new THREE.Color(0x00e5ff);
    } else {
      railCol = new THREE.Color(0xffd34d); // sky gold rim
      centerCol = new THREE.Color(0xffffff);
    }
    const black = new THREE.Color(0x000000); // additive fade-to-nothing inner edge

    const lift = 0.05;                                        // just proud of the deck
    const railBandW = Math.max(2.0, this.roadWidth * 0.16);   // streak width inboard of a rim
    const centerBandW = Math.max(1.2, this.roadWidth * 0.10); // streak half-width under center

    // Lateral cross-section helper: world position + banked y at a signed lateral
    // offset `off` (m from the centerline). Uses the SAME bankAngleAt the ribbon used
    // (linear roll across the width) so the streak sits flush on the tilted deck.
    const posAt = (i, off) => {
      const c = centers[i];
      const u = (i % N) / N;
      const nx = c.tz, nz = -c.tx;                        // right-hand XZ normal
      const dY = Math.sin(bankAngleAt(this.trackId, u)) * halfW; // edge rise at ±halfW
      return {
        x: c.x + nx * off,
        y: c.y + (off / halfW) * dY + lift,
        z: c.z + nz * off,
      };
    };

    // ONE shared additive vertex-colored material for all four streaks. fog stays ON
    // so distant streaks recede with the road instead of floating bright in the haze;
    // depthWrite:false lays them over the deck without z-fighting.
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Build one quad-strip band between two signed offsets: vertex A tinted `colA`
    // (the bright source edge), vertex B tinted `colB` (black -> fades out). Carved
    // over gaps + anti-grav sections like the kerb so it never floats over a chasm or
    // a twisting deck.
    const buildGlow = (offA, colA, offB, colB, name) => {
      const positions = new Float32Array((N + 1) * 2 * 3);
      const colors = new Float32Array((N + 1) * 2 * 3);
      for (let i = 0; i <= N; i++) {
        const pA = posAt(i, offA);
        const pB = posAt(i, offB);
        const vi = i * 2 * 3;
        positions[vi + 0] = pA.x; positions[vi + 1] = pA.y; positions[vi + 2] = pA.z;
        positions[vi + 3] = pB.x; positions[vi + 4] = pB.y; positions[vi + 5] = pB.z;
        colors[vi + 0] = colA.r; colors[vi + 1] = colA.g; colors[vi + 2] = colA.b;
        colors[vi + 3] = colB.r; colors[vi + 4] = colB.g; colors[vi + 5] = colB.b;
      }
      const indices = [];
      for (let i = 0; i < N; i++) {
        const segU = ((i + 0.5) % N) / N;
        if (this._inGapRender && this._inGapRender(segU)) continue;
        if (antigravAt(this.trackId, segU)) continue;
        const a = i * 2, b = i * 2 + 1, cc = (i + 1) * 2, d = (i + 1) * 2 + 1;
        indices.push(a, cc, b);
        indices.push(b, cc, d);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setIndex(indices);
      const strip = new THREE.Mesh(geo, mat);
      strip.name = name;
      strip.frustumCulled = false; // long thin loop — keep it always drawn
      this.group.add(strip);
    };

    // Rail reflections: bright at each rim, fading inboard to nothing.
    buildGlow(-halfW, railCol, -halfW + railBandW, black, 'railGlowLeft');
    buildGlow(halfW, railCol, halfW - railBandW, black, 'railGlowRight');
    // Center-line reflection: bright on the centerline, fading to BOTH sides.
    buildGlow(0, centerCol, -centerBandW, black, 'centerGlowLeft');
    buildGlow(0, centerCol, centerBandW, black, 'centerGlowRight');

    // Small env-reflection sheen bump so the deck reads a touch wetter under the
    // streaks. HIGH+ only (we early-returned otherwise), so LOW/MED are untouched.
    if (this.collider && this.collider.material) {
      this.collider.material.envMapIntensity *= 1.18;
      this.collider.material.needsUpdate = true;
    }
  }

  // =========================================================================
  // FEATURES (ramps / boost pads / hazards / shortcuts)
  // =========================================================================

  /**
   * Build the FEATURE meshes from trackData.listFeatures(): each resolved feature
   * arrives as { type, x, y, z, tx, tz, params } in absolute world space (the
   * shared module already did the spline math), so we just place + orient meshes.
   *
   *   - 'ramp'    : a raised launch wedge (lip rises toward the driving dir).
   *   - 'boost'   : bright emissive chevron arrows painted on the road.
   *   - 'hazard'  : a dodgeable obstacle (cone) or a flat oil-slick decal.
   *   - 'shortcut': a branch ribbon offset to one side, rejoining downstream.
   *
   * All feature meshes are added to this.group (cleaned up with the track) and
   * are VISUAL ONLY — contact detection lives in RaceManager via the same
   * listFeatures()/sampleSurface() data (this agent does not wire that).
   * @private
   */
  _buildFeatures() {
    // listFeatures() returns resolved world positions in the SAME order as the
    // track's raw `features` array. We pair each resolved feature with its raw
    // definition so the shortcut builder can read the un-resolved `at`/`rejoinAt`
    // spline params (listFeatures only keeps params, not `at`).
    const features = listFeatures(this.trackId);
    const raw = this.data.features || [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const rawF = raw[i] || {};
      switch (f.type) {
        case 'ramp':     this._buildRamp(f, rawF); break;
        case 'boost':    this._buildBoostPad(f, rawF); break;
        case 'hazard':   this._buildHazard(f, rawF); break;
        case 'shortcut': this._buildShortcut(f, rawF); break;
        case 'gap':      this._buildGapMarkers(f, rawF); break;
        default: break; // unknown feature types are silently ignored
      }
    }
  }

  /**
   * Heading (radians) from a feature's driving tangent so meshes face down-track.
   * forward = (sin h, 0, cos h) => h = atan2(tx, tz).
   * @param {{tx:number,tz:number}} f
   * @returns {number}
   * @private
   */
  _headingFromTangent(f) {
    return Math.atan2(f.tx, f.tz);
  }

  /**
   * Orient + place a FLAT decal plane so it lies FLUSH on the (now hilly) road
   * surface at spline param `at`, instead of dead-horizontal. A long pad laid flat
   * on a 16-degree slope clipped ~2m into the road at one end and floated ~2m at the
   * other — a real "thing on the track glitching when the car goes to it". We build a
   * surface basis from the REAL 3D centerline tangent (which carries the hill pitch
   * via its y component): local +X -> road-lateral, +Y -> driving direction, +Z ->
   * surface normal. Assumes the decal geometry is built in local XY (PlaneGeometry /
   * CircleGeometry: normal +Z; for a chevron pad the LENGTH runs along +Y, for a gap
   * bar the across-road span runs along +X). Lifts it slightly along the normal so it
   * never z-fights. Bank (the gentle MAX_BANK roll) is intentionally left to the lift.
   * @param {THREE.Mesh} mesh
   * @param {number} at            normalized spline param of the feature.
   * @param {number} [lift=0.12]   metres to raise the decal along the surface normal.
   * @private
   */
  _layFlatOnRoad(mesh, at, lift = 0.12) {
    const wrap = (u) => ((u % 1) + 1) % 1;
    // Surface basis (fwd/nrm/right) from the REAL 3D centerline tangent — shared
    // with the ramp/gate builders via _surfaceBasisAt so there's ONE definition.
    const { fwd, nrm, right } = this._surfaceBasisAt(at);
    mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, fwd, nrm),
    );
    const c = sampleCenter(this.trackId, wrap(at));
    mesh.position.set(c.x + nrm.x * lift, c.y + nrm.y * lift, c.z + nrm.z * lift);
  }

  /**
   * Surface basis at spline param `at`, from the REAL 3D centerline tangent (its y
   * component carries the hill pitch) — same math as _layFlatOnRoad, returned as
   * vectors so the ramp wedge AND its launch-gate decal can lie FLUSH on a sloped
   * road: fwd (driving dir), nrm (up off the road), right (road-lateral).
   * @param {number} at  normalized spline param.
   * @returns {{fwd:THREE.Vector3, nrm:THREE.Vector3, right:THREE.Vector3}}
   * @private
   */
  _surfaceBasisAt(at) {
    const wrap = (u) => ((u % 1) + 1) % 1;
    const d = 0.0009; // small spline-param delta to estimate the local tangent
    const a = sampleCenter(this.trackId, wrap(at - d));
    const b = sampleCenter(this.trackId, wrap(at + d));
    let fx = b.x - a.x, fy = b.y - a.y, fz = b.z - a.z;
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let rx = -fz, rz = fx; // road-lateral = forward × worldUp (horizontal "right")
    const rl = Math.hypot(rx, 0, rz) || 1; rx /= rl; rz /= rl;
    let nx = -rz * fy, ny = rz * fx - rx * fz, nz = rx * fy; // normal = right × forward
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    return {
      fwd: new THREE.Vector3(fx, fy, fz),
      nrm: new THREE.Vector3(nx, ny, nz),
      right: new THREE.Vector3(rx, 0, rz),
    };
  }

  /**
   * Build a RAMP: a raised launch wedge across the road. The wedge rises from the
   * road surface to `rise` over `length` meters and ends in a short flat lip
   * (`kick`) so karts get airtime when they cross it at speed.
   *
   * GLIDE RAMPS (params.glide === true) are the big launch features Stream R reads
   * to start a glide. For those we also paint clear READABLE MARKERS so the player
   * sees the section coming: a glowing LAUNCH GATE chevron sweep up the ramp face,
   * and a LANDING-ZONE pad of arrows further down-track where the open low road is.
   * Both are visual only (the launch/landing logic lives in the shared data + the
   * physics streams); they just make the rollercoaster glide legible.
   * @param {{x,y,z,tx,tz,params}} f     resolved feature (world pos + tangent).
   * @param {{at:number,params:Object}} [rawF]  raw def (carries the spline `at` so
   *   we can place the landing-zone marker down-track from the ramp).
   * @private
   */
  _buildRamp(f, rawF) {
    const p = f.params || {};
    const len = p.length || 16;
    const rise = p.rise || 4;
    const width = this.roadWidth * 0.92; // nearly full road width

    // Build a wedge with a triangular side profile (low at entry, high at exit),
    // capped flat. We extrude a 2D side profile across the road width.
    // Profile points (in the driving-forward Z' / up Y' plane), CCW:
    //   entry-bottom -> exit-bottom -> exit-top -> entry-top? -> use a ramp wedge.
    const shape = new THREE.Shape();
    shape.moveTo(-len / 2, 0);      // entry at road level
    shape.lineTo(len / 2, 0);       // exit base
    shape.lineTo(len / 2, rise);    // exit top (the lip)
    shape.lineTo(len / 2 - len * 0.25, rise); // short flat kick lip
    shape.lineTo(-len / 2, 0.01);   // climb back to entry (closes the wedge)
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: width,
      bevelEnabled: false,
    });
    // Extrude runs along +Z of the shape's local space; recenter across width.
    geo.translate(0, 0, -width / 2);

    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.colors.rail2),
      emissive: new THREE.Color(this.colors.rail2),
      emissiveIntensity: 0.6,
      roughness: 0.6,
      metalness: 0.2,
    });
    const ramp = new THREE.Mesh(geo, mat);
    // Lay the wedge FLUSH on the (possibly sloped) road. Local +X is the ramp
    // LENGTH (entry -len/2 .. exit +len/2), +Y the rise, +Z the extrude/width. Map
    // them onto a surface basis from the REAL 3D centerline tangent (its y carries
    // the hill pitch, same as _layFlatOnRoad): +X -> driving forward, +Y -> surface
    // normal, +Z -> road-lateral. The rising lip (at +len/2) stays at the down-track
    // EXIT. A plain yaw-only rotation.y left the base horizontal, so the wedge
    // floated at one end on a climb.
    const sb = this._surfaceBasisAt(rawF && rawF.at != null ? rawF.at : 0);
    ramp.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(sb.fwd, sb.nrm, sb.right),
    );
    ramp.position.set(f.x, f.y, f.z);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    ramp.name = 'featureRamp';
    this.group.add(ramp);

    // GLIDE MARKERS: only for launch ramps (params.glide). Make the section read.
    if (p.glide) this._buildGlideMarkers(f, rawF, len, rise, sb);
  }

  /**
   * Paint the READABLE MARKERS for a GLIDE launch ramp: a glowing LAUNCH GATE
   * chevron strip climbing the ramp face (so the player aims at it and reads
   * "launch here"), and a LANDING-ZONE marker — a soft glowing pad of forward
   * arrows down-track where the open low road is — so the airtime has a clear
   * place to come down. Both are flat emissive canvas decals, visual only.
   * @param {{x,y,z,tx,tz,params}} f   resolved ramp feature (world pos + tangent).
   * @param {{at:number}} [rawF]       raw def (carries spline `at`).
   * @param {number} len               the ramp length (m).
   * @param {number} rise              the ramp rise (m).
   * @param {{fwd:THREE.Vector3,nrm:THREE.Vector3,right:THREE.Vector3}} basis  the
   *   ramp's surface basis (from _surfaceBasisAt) so the gate lies on the ramp face.
   * @private
   */
  _buildGlideMarkers(f, rawF, len, rise, basis) {
    // --- LAUNCH GATE: an upward chevron sweep painted onto the ramp face so the
    // launch lip glows and reads as a "take off here" gate. Bright accent arrows
    // on a translucent base, laid up the slope of the wedge (tilted by the ramp
    // pitch) and lifted just off the face so it never z-fights the wedge.
    const cw = 64, ch = 256;
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    const accent = new THREE.Color(this.colors.rail2);
    const accentCss = `rgb(${(accent.r * 255) | 0},${(accent.g * 255) | 0},${(accent.b * 255) | 0})`;
    ctx.strokeStyle = accentCss;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    for (let r = 0; r < 5; r++) {
      const y = ch - (r + 0.5) * (ch / 5);
      ctx.beginPath();
      ctx.moveTo(8, y + 24);
      ctx.lineTo(cw / 2, y - 24);
      ctx.lineTo(cw - 8, y + 24);
      ctx.stroke();
    }
    const gateTex = new THREE.CanvasTexture(canvas);
    const gateGeo = new THREE.PlaneGeometry(this.roadWidth * 0.8, len * 0.95);
    const gateMat = new THREE.MeshBasicMaterial({
      map: gateTex,
      transparent: true,
      toneMapped: false, // keep the launch chevrons bright through tone mapping
      depthWrite: false,
    });
    const gate = new THREE.Mesh(gateGeo, gateMat);
    // Lie FLUSH on the (now slope-correct) ramp FACE: chevrons climb the wedge
    // slope (+Y), span the road (+X), face up off the wedge (+Z). Tilt the road
    // surface basis by the ramp pitch a = atan(rise/len): up-slope = fwd*cos a +
    // nrm*sin a; face normal = nrm*cos a - fwd*sin a. (The old yaw+pitch Euler
    // inherited the flat frame and floated the decal off a hilly ramp.)
    const a = Math.atan2(rise, len);
    const upSlope = basis.fwd.clone().multiplyScalar(Math.cos(a))
      .addScaledVector(basis.nrm, Math.sin(a));
    const faceNrm = basis.nrm.clone().multiplyScalar(Math.cos(a))
      .addScaledVector(basis.fwd, -Math.sin(a));
    gate.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(basis.right, upSlope, faceNrm),
    );
    // Sit it on the ramp face: half the rise up the normal, nudged just proud.
    const gLift = rise * 0.5 + 0.15;
    gate.position.set(
      f.x + basis.nrm.x * gLift,
      f.y + basis.nrm.y * gLift,
      f.z + basis.nrm.z * gLift,
    );
    gate.name = 'glideLaunchGate';
    this.group.add(gate);

    // --- LANDING ZONE: a soft glowing arrow pad on the OPEN LOW ROAD down-track
    // from the ramp. We sample the centerline a little way past the ramp's spline
    // `at` (the landing run begins there) and drop a flat decal there so the player
    // reads where to come down. If we have no raw `at`, skip it (no guesswork).
    if (!rawF || rawF.at == null) return;
    const landU = (rawF.at + 0.035) % 1; // ~a few % of the lap downstream

    const lw = 96, lh = 96;
    const lcv = document.createElement('canvas');
    lcv.width = lw; lcv.height = lh;
    const lctx = lcv.getContext('2d');
    lctx.clearRect(0, 0, lw, lh);
    // Soft glowing ring + a down-track arrow so it reads as "land here".
    lctx.strokeStyle = accentCss;
    lctx.lineWidth = 6;
    lctx.beginPath();
    lctx.arc(lw / 2, lh / 2, lw * 0.34, 0, Math.PI * 2);
    lctx.stroke();
    lctx.beginPath();
    lctx.moveTo(lw * 0.30, lh * 0.40);
    lctx.lineTo(lw / 2, lh * 0.66);
    lctx.lineTo(lw * 0.70, lh * 0.40);
    lctx.stroke();
    const landTex = new THREE.CanvasTexture(lcv);
    const landGeo = new THREE.PlaneGeometry(this.roadWidth * 0.7, this.roadWidth * 0.7);
    const landMat = new THREE.MeshBasicMaterial({
      map: landTex,
      transparent: true,
      toneMapped: false,
      depthWrite: false,
      opacity: 0.9,
    });
    const land = new THREE.Mesh(landGeo, landMat);
    // Lay FLUSH on the (possibly sloped) landing run via the shared surface basis —
    // the boost pad uses the same path — so it follows the hill, not dead-horizontal.
    this._layFlatOnRoad(land, landU, 0.08);
    land.name = 'glideLandingZone';
    this.group.add(land);
  }

  /**
   * Build a BOOST PAD: a bright emissive strip on the road painted with forward
   * chevron arrows so the driver reads "speed this way". Flat, flush with the
   * road, oriented by the driving tangent.
   * @param {{x,y,z,tx,tz,params}} f
   * @private
   */
  _buildBoostPad(f, rawF) {
    const p = f.params || {};
    const len = p.length || 14;
    const width = this.roadWidth * 0.5;

    // Draw chevrons onto a canvas texture: bright arrows on a dark translucent
    // base, pointing along +V (the driving direction once we lay the plane).
    const cw = 64;
    const ch = 256;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(8,8,20,0.85)';
    ctx.fillRect(0, 0, cw, ch);
    // Chevrons in the rail2 accent color.
    const accent = new THREE.Color(this.colors.rail2);
    ctx.strokeStyle = `rgb(${(accent.r * 255) | 0},${(accent.g * 255) | 0},${(accent.b * 255) | 0})`;
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    const rows = 4;
    for (let r = 0; r < rows; r++) {
      const y = ch - (r + 0.5) * (ch / rows);
      ctx.beginPath();
      ctx.moveTo(8, y + 22);
      ctx.lineTo(cw / 2, y - 22);
      ctx.lineTo(cw - 8, y + 22);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);

    const geo = new THREE.PlaneGeometry(width, len);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      toneMapped: false, // keep chevrons neon-bright through tone mapping -> bloom
      depthWrite: false,
    });
    const pad = new THREE.Mesh(geo, mat);
    pad.renderOrder = 1;
    // Lie FLUSH on the road surface (handles the hill pitch), with the chevron length
    // (local +Y) pointing in the driving direction. Replaces the old dead-horizontal
    // lay (rotation.x=-PI/2) which clipped/floated the pad on the now-hilly road.
    const at = rawF && rawF.at != null ? rawF.at : null;
    if (at != null) {
      this._layFlatOnRoad(pad, at, 0.08);
    } else {
      pad.rotation.x = -Math.PI / 2;
      pad.rotation.z = this._headingFromTangent(f) + Math.PI;
      pad.position.set(f.x, f.y + 0.08, f.z);
    }
    pad.name = 'featureBoost';
    this.group.add(pad);
  }

  /**
   * Build a HAZARD: either a 3D dodgeable obstacle (a traffic cone) or a flat oil
   * slick decal, chosen by params.kind.
   * @param {{x,y,z,tx,tz,params}} f
   * @private
   */
  _buildHazard(f, rawF) {
    const p = f.params || {};
    const kind = p.kind || 'cone';

    if (kind === 'oil') {
      // Flat dark glossy oil-slick decal on the road surface.
      const radius = p.radius || 5;
      const geo = new THREE.CircleGeometry(radius, 24);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x05050a,
        roughness: 0.15,
        metalness: 0.85,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,           // decal: don't fight the road in the depth buffer
        polygonOffset: true,         // and push it slightly toward the camera so it
        polygonOffsetFactor: -1,     // never z-fights the road surface at grazing angles
        polygonOffsetUnits: -1,
      });
      const slick = new THREE.Mesh(geo, mat);
      slick.renderOrder = 1;
      // Lie flush on the (hilly) road instead of dead-horizontal.
      const oilAt = rawF && rawF.at != null ? rawF.at : null;
      if (oilAt != null) {
        this._layFlatOnRoad(slick, oilAt, 0.12);
      } else {
        slick.rotation.x = -Math.PI / 2;
        slick.position.set(f.x, f.y + 0.12, f.z);
      }
      slick.name = 'featureHazardOil';
      this.group.add(slick);
      return;
    }

    // Default 'cone': a bright orange cone with a couple of warning stripes — a
    // clear, dodgeable obstacle sitting on the road.
    const radius = Math.max(0.7, (p.radius || 3) * 0.5);
    const height = radius * 2.6;
    const coneGeo = new THREE.ConeGeometry(radius, height, 16);
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0xff6a1a,
      emissive: 0x6a2400,
      emissiveIntensity: 0.5,
      roughness: 0.7,
      metalness: 0.0,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(f.x, f.y + height / 2, f.z);
    cone.castShadow = true;
    cone.name = 'featureHazardCone';
    // A white warning band partway up the cone.
    const bandGeo = new THREE.CylinderGeometry(radius * 0.72, radius * 0.82, height * 0.16, 16);
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    const band = new THREE.Mesh(bandGeo, bandMat);
    band.position.y = -height * 0.12; // sit it a bit below the cone's midpoint
    cone.add(band);
    this.group.add(cone);
  }

  /**
   * Build a SHORTCUT branch: a secondary road ribbon offset to one side of the
   * main course between the feature's spline param and its `rejoinAt`, riding the
   * terrain `y`. It reads as an alternate (often jump-gated) line.
   * @param {{x,y,z,tx,tz,params}} f      resolved feature (world pos + tangent).
   * @param {{at:number,params:Object}} rawF  raw feature def (carries `at`).
   * @private
   */
  _buildShortcut(f, rawF) {
    const p = f.params || {};
    const branchSide = p.branchSide || 1;
    const branchWidth = p.width || 10;
    const halfMain = this.roadWidth / 2;
    // The branch runs from `at` to `rejoinAt` in spline param (with wrap). Both
    // come straight from the raw feature definition (listFeatures drops `at`).
    const fromU = rawF.at != null ? rawF.at : 0;
    const toU = p.rejoinAt != null ? p.rejoinAt : (fromU + 0.1);

    // Number of lengthwise samples for the branch (proportional to its u-span).
    let span = toU - fromU;
    if (span <= 0) span += 1; // wrapped range
    const segs = Math.max(8, Math.round(span * RIBBON_SAMPLES));
    const halfB = branchWidth / 2;

    const positions = new Float32Array((segs + 1) * 2 * 3);
    for (let i = 0; i <= segs; i++) {
      const u = (fromU + span * (i / segs)) % 1;
      const c = sampleCenter(this.trackId, u);
      const nx = c.tz;
      const nz = -c.tx;
      // Branch centerline = main centerline + normal * (branchSide * halfMain)
      // (so it sits to one side); edges span ±halfB about THAT.
      const off = branchSide * halfMain;
      const bx = c.x + nx * off;
      const bz = c.z + nz * off;
      const by = c.y;

      const lx = bx - nx * halfB;
      const lz = bz - nz * halfB;
      const rx = bx + nx * halfB;
      const rz = bz + nz * halfB;

      const vi = i * 2 * 3;
      positions[vi + 0] = lx; positions[vi + 1] = by + 0.04; positions[vi + 2] = lz;
      positions[vi + 3] = rx; positions[vi + 4] = by + 0.04; positions[vi + 5] = rz;
    }

    const indices = [];
    for (let i = 0; i < segs; i++) {
      const v0 = i * 2;
      const v1 = i * 2 + 1;
      const v2 = (i + 1) * 2;
      const v3 = (i + 1) * 2 + 1;
      indices.push(v0, v2, v1);
      indices.push(v1, v2, v3);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: this.themeId === 'sky' ? 0xcdd9f0 : 0x161626,
      emissive: new THREE.Color(this.colors.rail),
      emissiveIntensity: 0.25,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
    });
    const branch = new THREE.Mesh(geo, mat);
    branch.name = 'featureShortcut';
    branch.receiveShadow = true;
    this.group.add(branch);
  }

  /**
   * Build the visual markers for a REAL FALL-IN GAP. The actual void is already
   * carved into the ribbon (the _buildRoadRibbon index loop skips the gap quads),
   * so here we just add READABLE DANGER LIPS: a bright warning bar across the road
   * at the take-off edge and at the landing edge, so the player clearly reads "the
   * road ends — launch here / land there". Visual only; the drivable hole is the
   * shared isOnRoad() gap suppression, not these meshes.
   * @param {{x,y,z,tx,tz,params}} f      resolved gap feature (world pos + tangent).
   * @param {{at:number,params:Object}} rawF  raw def (carries startU/endU).
   * @private
   */
  _buildGapMarkers(f, rawF) {
    const p = (rawF && rawF.params) || f.params || {};
    const startU = p.startU != null ? p.startU : ((rawF && rawF.at != null ? rawF.at : 0) - 0.005);
    const endU = p.endU != null ? p.endU : ((rawF && rawF.at != null ? rawF.at : 0) + 0.005);

    // A bright chevroned warning bar laid across the road at a given spline param,
    // flush on the surface, oriented across the driving direction. Reused for both
    // the take-off lip (just before the void) and the landing lip (just after).
    const makeLip = (u, name) => {
      const c = sampleCenter(this.trackId, u);
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Hazard-stripe bar: alternating warning yellow/black diagonal blocks.
      const cells = 8;
      const cs = size / cells;
      for (let cx = 0; cx < cells; cx++) {
        ctx.fillStyle = cx % 2 === 0 ? '#ffd21a' : '#15151c';
        ctx.fillRect(cx * cs, 0, cs, size);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.set(this.roadWidth / 3, 1);
      const geo = new THREE.PlaneGeometry(this.roadWidth, 3.4);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        toneMapped: false, // keep the warning bar bright through tone mapping
        depthWrite: false,
        opacity: 0.95,
      });
      const bar = new THREE.Mesh(geo, mat);
      bar.renderOrder = 1;
      // Lie flush on the road surface (the long roadWidth axis = local +X spans ACROSS
      // the road, the 3.4m = local +Y runs along driving dir), pitched to the hill.
      this._layFlatOnRoad(bar, u, 0.10);
      bar.name = name;
      this.group.add(bar);
    };

    // Take-off lip a hair BEFORE the void; landing lip a hair AFTER it.
    makeLip(((startU - 0.004) % 1 + 1) % 1, 'gapTakeoffLip');
    makeLip(((endU + 0.004) % 1 + 1) % 1, 'gapLandingLip');
  }

  // =========================================================================
  // CHECKPOINTS
  // =========================================================================

  /**
   * Build the ordered centerline checkpoints (gates) and the start/finish line
   * plus faint checkpoint markers.
   *
   * Gates come from the shared, renderer-free builder so the rendered road, lap
   * detection, racing line and server simulation all use ONE definition. The
   * returned shape is ordered [{x,y,z,index}] (now WITH y so markers ride the
   * hills), index 0 = start/finish, in the driving direction.
   * @private
   */
  _buildCheckpoints() {
    const ordered = buildCheckpoints(this.trackId);

    // M2 public field — consumed by LapSystem / RacingLine / AI / RaceManager.
    this.checkpoints = ordered;

    // --- Visuals: checkered start/finish line + faint checkpoint markers. ---
    this._buildStartFinishLine(ordered[0]);
    this._buildCheckpointMarkers(ordered);
  }

  /**
   * Draw a checkered start/finish line across the road at checkpoint 0, oriented
   * by the local driving tangent and sitting at the gate's hill `y`.
   * @param {{x:number,y:number,z:number}} gate0
   * @private
   */
  _buildStartFinishLine(gate0) {
    // Build a small checkered canvas texture.
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cells = 8;
    const cs = size / cells;
    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#ffffff' : '#111111';
        ctx.fillRect(c * cs, r * cs, cs, cs);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // Repeat across the road width so squares stay roughly square.
    tex.repeat.set(this.roadWidth / 2, 1);

    const lineGeo = new THREE.PlaneGeometry(this.roadWidth, 3);
    const lineMat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 1.0,
      metalness: 0.0,
    });
    const line = new THREE.Mesh(lineGeo, lineMat);
    // Lay flat on the road, lifted just above the surface, yawed to the heading
    // so the line (its long axis = local +X = roadWidth) spans ACROSS the road,
    // perpendicular to the driving direction. After rotation.x = -PI/2, local +X
    // maps under Euler 'XYZ' to (cos z, 0, sin z); for that to be perpendicular to
    // forward (sin h, 0, cos h) at EVERY heading we need z = h (dot = 0). The OLD
    // -h only stayed perpendicular at h = multiples of PI/2; on the curved start it
    // skewed the line toward the driving direction. +heading fixes every heading.
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = (this.startPosition.heading || 0);
    line.position.set(gate0.x, (gate0.y != null ? gate0.y : this.elevation) + 0.08, gate0.z);
    line.name = 'startFinishLine';
    this.group.add(line);
  }

  /**
   * Draw faint flat ring markers at each checkpoint so the racing line is visible
   * while debugging. Kept subtle and non-colliding (visual only). Markers ride
   * each gate's hill `y`.
   * @param {Array<{x:number,y:number,z:number,index:number}>} gates
   * @private
   */
  _buildCheckpointMarkers(gates) {
    const markerMat = new THREE.MeshStandardMaterial({
      color: 0xffff66,
      transparent: true,
      opacity: 0.16,
      roughness: 1.0,
      metalness: 0.0,
    });
    const markerGeo = new THREE.RingGeometry(0.8, 1.2, 16);
    for (const g of gates) {
      if (g.index === 0) continue; // start/finish already drawn
      const m = new THREE.Mesh(markerGeo, markerMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(g.x, (g.y != null ? g.y : this.elevation) + 0.06, g.z);
      m.name = `checkpointMarker_${g.index}`;
      this.group.add(m);
    }
  }

  // =========================================================================
  // THEMED LANDMARKS (signature set-pieces / roadside props / banner / decor)
  // =========================================================================

  /**
   * Build the track's THEMED LANDMARKS so each course reads as a memorable PLACE,
   * not an abstract ribbon: signature distant set-pieces, repeating roadside props
   * lining the route, a start/finish BANNER ARCH over the start line, and light
   * decor. Everything is ORIGINAL procedural geometry (no external/IP assets).
   *
   * Placement helper: props sit OUTSIDE the road edge. For a centerline sample at
   * spline param s we offset by the XZ road-normal (tz,-tx) by ±(halfWidth + gap),
   * so a prop hugs the rim without ever sitting on the drivable surface.
   * @private
   */
  _buildLandmarks() {
    // A start/finish BANNER ARCH spans the road at the start line for every theme.
    this._buildStartBanner();

    if (this.themeId === 'rainbow') {
      this._buildRainbowLandmarks();
    } else if (this.themeId === 'space') {
      this._buildSpaceLandmarks();
    } else {
      this._buildSkyLandmarks();
    }
  }

  /**
   * Resolve a roadside anchor: the world point `gap` meters OUTSIDE the road edge
   * at spline param `s`, on `side` (-1 left / +1 right), riding the terrain `y`.
   * Returns { x, y, z, heading } where heading faces down-track.
   * @param {number} s     spline param 0..1
   * @param {number} side  -1 left / +1 right of the driving direction
   * @param {number} gap   meters beyond the road edge to push the prop
   * @returns {{x:number,y:number,z:number,heading:number}}
   * @private
   */
  _roadside(s, side, gap) {
    const c = sampleCenter(this.trackId, s);
    const nx = c.tz;   // right-hand XZ normal (perpendicular to driving tangent)
    const nz = -c.tx;
    const off = side * (this.roadWidth / 2 + gap);
    return {
      x: c.x + nx * off,
      y: c.y,
      z: c.z + nz * off,
      heading: Math.atan2(c.tx, c.tz),
    };
  }

  /**
   * Build the START/FINISH BANNER ARCH: two posts flanking the road joined by a
   * horizontal beam carrying a checkered banner, spanning the road at the start
   * line and oriented across the driving direction. Original procedural geometry.
   * @private
   */
  _buildStartBanner() {
    const gate0 = this.checkpoints && this.checkpoints[0];
    if (!gate0) return;
    const c = sampleCenter(this.trackId, 0);
    const nx = c.tz;          // across-road axis
    const nz = -c.tx;
    const heading = Math.atan2(c.tx, c.tz);
    const span = this.roadWidth + 6;   // posts sit just outside both rims
    const postH = 9;                   // arch clearance above the road
    const baseY = (gate0.y != null ? gate0.y : this.elevation);

    const arch = new THREE.Group();
    arch.name = 'startBanner';

    // Two upright posts in the theme's rail color (emissive so they read at night).
    const postGeo = new THREE.CylinderGeometry(0.5, 0.6, postH, 12);
    const postMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.colors.rail),
      emissive: new THREE.Color(this.colors.rail),
      emissiveIntensity: 0.75,
      roughness: 0.5,
      metalness: 0.4,
    });
    for (const sideSign of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(
        c.x + nx * sideSign * (span / 2),
        baseY + postH / 2,
        c.z + nz * sideSign * (span / 2),
      );
      post.castShadow = true;
      arch.add(post);
    }

    // Cross-beam joining the posts at the top.
    const beamGeo = new THREE.BoxGeometry(span, 0.7, 0.7);
    const beam = new THREE.Mesh(beamGeo, postMat);
    beam.position.set(c.x, baseY + postH, c.z);
    beam.rotation.y = heading; // align the beam ACROSS the road
    arch.add(beam);

    // A checkered banner hanging below the beam (a flat plane with a checker
    // canvas texture). Reuses the same checker pattern idea as the start line.
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cells = 8;
    const cs = size / cells;
    for (let r = 0; r < cells; r++) {
      for (let col = 0; col < cells; col++) {
        ctx.fillStyle = (r + col) % 2 === 0 ? '#ffffff' : '#15151c';
        ctx.fillRect(col * cs, r * cs, cs, cs);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(span / 2.5, 1);
    const bannerGeo = new THREE.PlaneGeometry(span - 1.4, 2.4);
    const bannerMat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide,
    });
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.set(c.x, baseY + postH - 1.6, c.z);
    banner.rotation.y = heading;
    arch.add(banner);

    this.group.add(arch);
  }

  /**
   * RAINBOW RIDGE landmarks: a row of glowing crystal PRISM SPIRES rising out of
   * the void along the route, plus floating glow ORBS as decor — a candied
   * crystalline place. Original procedural geometry.
   * @private
   */
  _buildRainbowLandmarks() {
    // Crystal spires: tall octahedral prisms in saturated hues, alternating sides,
    // standing below the floating road so they read as a skyline as you race past.
    const spireGeo = new THREE.OctahedronGeometry(7, 0);
    const spireCount = 14;
    for (let i = 0; i < spireCount; i++) {
      const s = i / spireCount;
      const side = i % 2 === 0 ? -1 : 1;
      const anchor = this._roadside(s, side, 22 + (i % 3) * 8);
      const hue = (i / spireCount + 0.05) % 1;
      const col = new THREE.Color().setHSL(hue, 0.9, 0.55);
      const mat = new THREE.MeshStandardMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: 0.6,
        roughness: 0.2,
        metalness: 0.3,
        transparent: true,
        opacity: 0.92,
      });
      const drop = 26 + (i % 4) * 10; // hang below the road, varying depth
      const spire = new THREE.Mesh(spireGeo, mat);
      spire.scale.set(1, 2.2 + (i % 3) * 0.5, 1); // stretch into a tall prism
      spire.position.set(anchor.x, anchor.y - drop, anchor.z);
      spire.name = 'rainbowSpire';
      this.group.add(spire);
    }

    // Floating glow ORBS: small additive emissive spheres bobbing near the rims as
    // bright decorative accents (cheap, unlit basic spheres).
    const orbGeo = new THREE.SphereGeometry(1.6, 12, 10);
    const orbCount = 18;
    for (let i = 0; i < orbCount; i++) {
      const s = (i + 0.5) / orbCount;
      const side = i % 2 === 0 ? 1 : -1;
      const anchor = this._roadside(s, side, 8 + (i % 2) * 4);
      const hue = (i * 0.13) % 1;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(hue, 1.0, 0.6),
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false, // stay bright through tone mapping -> bloom
      });
      const orb = new THREE.Mesh(orbGeo, mat);
      orb.position.set(anchor.x, anchor.y + 3 + (i % 3), anchor.z);
      orb.name = 'rainbowOrb';
      this.group.add(orb);
    }
  }

  /**
   * COSMIC SPEEDWAY landmarks: a giant RINGED PLANET set-piece looming over the
   * course. Original procedural geometry — no IP.
   * @private
   */
  _buildSpaceLandmarks() {
    // Signature RINGED PLANET: a big sphere with a flat ring torus, parked far out
    // beyond the course so it dominates one side of the sky. Unlit-ish (low rough,
    // gentle emissive) so it glows softly in the void.
    const planet = new THREE.Group();
    planet.name = 'spacePlanet';
    const bodyGeo = new THREE.SphereGeometry(140, 32, 24);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x3a6cff,
      emissive: 0x10204a,
      emissiveIntensity: 0.6,
      roughness: 0.7,
      metalness: 0.1,
    });
    planet.add(new THREE.Mesh(bodyGeo, bodyMat));
    const ringGeo = new THREE.RingGeometry(180, 270, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x9fd0ff,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2.4; // tilt the ring for a 3/4 read
    ring.rotation.z = 0.3;
    planet.add(ring);
    // Park it far out to one side and up, centered around the course elevation.
    planet.position.set(-650, this.elevation + 220, 500);
    this.group.add(planet);
  }

  /**
   * CLOUDTOP CIRCUIT landmarks: roadside WINDMILL pinwheels — a bright, breezy
   * sky place. Original procedural geometry.
   * @private
   */
  _buildSkyLandmarks() {
    // WINDMILL PINWHEELS: a post with a 4-blade pinwheel that spins (registered in
    // _animatedEdgeMats? no — we spin the object in update via _starLayers? keep it
    // static-but-charming to avoid touching update). A bright, friendly roadside prop.
    const postGeo = new THREE.CylinderGeometry(0.4, 0.5, 10, 8);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xeef2ff, roughness: 0.7 });
    const bladeGeo = new THREE.BoxGeometry(0.4, 6, 1.4);
    const millCount = 12;
    for (let i = 0; i < millCount; i++) {
      const s = (i + 0.5) / millCount;
      const side = i % 2 === 0 ? -1 : 1;
      const anchor = this._roadside(s, side, 12 + (i % 2) * 5);
      const mill = new THREE.Group();
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.y = 5;
      post.castShadow = true;
      mill.add(post);
      // hub faces ACROSS the track (Y yaw); the inner spinner holds the blades in
      // its local XY plane and rotates about its local Z so the pinwheel turns
      // edge-on to the road (a free transform bumped in update(dt)).
      const hub = new THREE.Group();
      hub.position.y = 9;
      hub.rotation.y = anchor.heading; // face the pinwheel across the track
      const spinner = new THREE.Group();
      const bladeMat = new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? 0xff7a8a : 0x4ac8ff, roughness: 0.6,
      });
      for (let b = 0; b < 4; b++) {
        const blade = new THREE.Mesh(bladeGeo, bladeMat);
        blade.position.y = 3; // offset so the blade radiates from the hub center
        const bg = new THREE.Group();
        bg.add(blade);
        bg.rotation.z = (b / 4) * Math.PI * 2;
        spinner.add(bg);
      }
      hub.add(spinner);
      mill.add(hub);
      mill.position.set(anchor.x, anchor.y, anchor.z);
      mill.name = 'skyWindmill';
      // Track the spinner so update(dt) rotates it about local Z for life.
      this._spinProps.push({ obj: spinner, speed: 0.8 + (i % 3) * 0.3 });
      this.group.add(mill);
    }
  }

  // =========================================================================
  // SURFACE QUERY + THEME + ANIMATION
  // =========================================================================

  /**
   * Point-in-road test. Delegates to the shared, pure trackData.isOnRoad() so the
   * render-side answer matches the server's exactly (including shortcut bands).
   * @param {number} x world X (m)
   * @param {number} z world Z (m)
   * @returns {boolean} true if (x,z) lies on the drivable road band.
   */
  isOnRoad(x, z) {
    return trackIsOnRoad(this.trackId, x, z);
  }

  /**
   * Apply this track's THEME to the scene: set scene.background + scene.fog so the
   * dark themes let the neon bloom POP (the bright default sky washes it out), and
   * attach any skybox / starfield to `this.group` so removing the group cleans
   * them up.
   *
   *   - 'rainbow' / 'space' : near-black void + a Points starfield.
   *   - 'sky'               : soft blue gradient + a faint high starfield.
   *
   * @param {THREE.Scene} scene the live scene to theme.
   */
  applyTheme(scene) {
    if (!scene) return;

    if (this.themeId === 'sky') {
      // --- CLOUDTOP: a soft dawn/blue gradient dome with sparse high stars. ---
      // A SKYBOX (big inverted gradient sphere) replaces the flat background color
      // so the horizon glows warm low and deepens to blue overhead. scene.background
      // stays a matching solid as a cheap fallback (e.g. behind the dome at the
      // poles / before the dome draws). Light fog keeps the large course readable.
      scene.background = new THREE.Color(0x5f9fd8);
      // DEEPER, richer sky-blue fog (was pale 0xbfe0ff) so the horizon reads as real
      // sky instead of a white wash, and slightly denser so the far void has body —
      // but still thin enough that the course stays crisp.
      scene.fog = new THREE.FogExp2(0x7fb4e6, 0.00028);
      // Vertical gradient with more SATURATION top-to-bottom so the dome isn't a flat
      // pale field: deep blue overhead -> saturated mid-blue -> warm dawn band.
      this._buildSkybox({
        top: '#2b5da6',      // deeper saturated blue overhead
        mid: '#6fb0ee',      // mid sky
        horizon: '#ffd9a8',  // warm dawn glow at the horizon band
        clouds: true,
        cloudColor: 'rgba(255,255,255,',
        nebula: false,
        // Warm dawn sun low on the horizon (MED+; LOW omits it for byte-equivalence).
        sun: this._tier !== 'low'
          ? { core: '#fff3cf', mid: '#ffb37a', edge: '#ff5d8f', halo: 'rgba(255,150,120,' }
          : undefined,
        radius: 1400,
      });
      // A faint, sparse high starfield for a sense of altitude (one layer is
      // plenty for the bright sky — too many stars fight the daylight).
      this._buildStars(700, 0xffffff, 0.55, 1150, 0.6);
      return;
    }

    // --- RAINBOW + SPACE: a deep-space NEBULA dome over a dense parallax star
    //     field, plus a couple of distant glowing accents. The dark dome lets the
    //     emissive road/rails + bloom dominate while the nebula gives the void
    //     real depth instead of flat black. Per theme we shift the nebula palette:
    //     rainbow leans magenta/purple/blue (candied), space leans blue/violet
    //     (colder/inky). scene.background stays a near-black fallback.
    scene.background = new THREE.Color(0x02030a);
    // Thinner void fog (0.0009 -> 0.0006) so the neon road/rails stay sharp and
    // saturated deep into the distance rather than greying out into haze — the
    // dense fog was muting the glow that should be reading bright and clear.
    scene.fog = new THREE.FogExp2(0x02030a, 0.0006);

    const rainbow = this.themeId === 'rainbow';
    this._buildSkybox({
      top: rainbow ? '#0a0420' : '#04060f',         // inky top
      mid: rainbow ? '#160a36' : '#070b1c',         // deep purple/blue body
      horizon: rainbow ? '#2a0f3a' : '#0a1430',     // faint glow toward the base
      clouds: false,
      nebula: true,
      // Nebula cloud blobs — a few colored puffs the gradient can't give. Rainbow
      // gets magenta/violet/cyan; space gets blue/violet/teal (colder).
      nebulaColors: rainbow
        ? ['rgba(255,60,200,', 'rgba(150,70,255,', 'rgba(60,160,255,']
        : ['rgba(70,120,255,', 'rgba(140,70,255,', 'rgba(40,200,220,'],
      // Cyan/magenta synthwave sun ONLY on Rainbow Ridge (MED+). Space keeps its
      // ringed-planet/gas-giant accents (via _buildDistantAccents) instead, so no sun.
      sun: rainbow && this._tier !== 'low'
        ? { core: '#c9f7ff', mid: '#5fc8ff', edge: '#ff4dd2', halo: 'rgba(120,210,255,' }
        : undefined,
      radius: 1600,
    });

    // PARALLAX STARFIELD: 3 layers at different radii. The near layer is brighter
    // + larger and drifts a touch faster; the far layers are small + faint and
    // barely move — the differential drift (in update) reads as real depth as the
    // camera sweeps the course. (Drift is a slow group rotation per layer.)
    this._buildStars(900, 0xfff4ff, 1.5, 700, 1.0, 0.012);   // near — big bright
    this._buildStars(1400, 0xbfd0ff, 1.0, 1050, 0.85, 0.006); // mid
    this._buildStars(2200, 0x8fa8ff, 0.7, 1450, 0.7, 0.0025); // far — faint distant

    // A couple of DISTANT GLOWING ACCENTS: soft additive sprites (a far sun / a
    // colored gas giant) that give the eye something to anchor on in the void and
    // sell the "deep space" scale. Cheap (2 camera-facing quads, no lighting).
    this._buildDistantAccents(rainbow);
  }

  /**
   * Build the SKYBOX: one large INVERTED sphere (we render its inside faces) with
   * a generated CANVAS texture so the void has a real vertical gradient + soft
   * nebula clouds, instead of a single flat background color. The sphere is HUGE
   * (radius ~1400-1600m) and centered on the course elevation so the camera never
   * reaches its shell. It is unlit (MeshBasicMaterial) and ignores fog/depth so it
   * always reads as the far backdrop. Added to this.group so it's freed with the
   * track.
   *
   * The canvas is painted ONCE here (never per frame): a top->bottom gradient,
   * optional wispy clouds (sky theme) or colored nebula blobs (space/rainbow),
   * and a dusting of faint background stars baked into the texture so the dome
   * isn't empty between the Points layers.
   *
   * @param {{top:string, mid:string, horizon:string, clouds?:boolean,
   *          cloudColor?:string, nebula?:boolean, nebulaColors?:string[],
   *          radius:number}} opts
   * @private
   */
  _buildSkybox(opts) {
    // The dome texture: wide enough to wrap smoothly, tall enough for a clean
    // vertical gradient. 1024x1024 is plenty for a soft backdrop (it's blurred by
    // the huge sphere anyway) and costs one canvas at load time.
    const W = 1024;
    const H = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Vertical gradient: top of canvas = sky overhead, bottom = horizon band.
    // (On a sphere mapped with the default UVs, V=0 is the bottom pole and V=1 the
    // top; we paint top-of-canvas as the overhead color and let it wrap.)
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0.0, opts.top);
    grad.addColorStop(0.5, opts.mid);
    grad.addColorStop(0.82, opts.mid);
    grad.addColorStop(1.0, opts.horizon);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // SYNTHWAVE HORIZON SUN: painted ONCE into the dome canvas (zero per-frame cost),
    // right after the base gradient so its slit bands can restore the exact sky behind
    // them, and BEFORE the nebula/clouds so those drift softly over it. Passed only on
    // MED+ (LOW omits `sun`) so the cheap path's dome stays byte-equivalent to today.
    if (opts.sun) this._paintHorizonSun(ctx, W, H, grad, opts.sun);

    if (opts.nebula) {
      // Soft NEBULA blobs: several large, very-soft radial gradients in the theme
      // colors, blended additively so they glow against the inky gradient. Random
      // positions/sizes give each track load a slightly different sky.
      ctx.globalCompositeOperation = 'lighter'; // additive glow
      const colors = opts.nebulaColors || ['rgba(150,70,255,'];
      const blobs = 16;
      for (let i = 0; i < blobs; i++) {
        const cx = Math.random() * W;
        const cy = Math.random() * H * 0.85; // keep blobs out of the very base
        const r = (0.12 + Math.random() * 0.22) * W;
        const base = colors[(Math.random() * colors.length) | 0];
        const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const peak = 0.18 + Math.random() * 0.22;
        g2.addColorStop(0.0, base + peak + ')');
        g2.addColorStop(0.4, base + (peak * 0.5) + ')');
        g2.addColorStop(1.0, base + '0)');
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, W, H);
      }
      // Faint baked background stars so the dome between the Points layers isn't
      // empty. Tiny white dots at low alpha.
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < 600; i++) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        const a = 0.15 + Math.random() * 0.45;
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        const s = Math.random() < 0.85 ? 1 : 2;
        ctx.fillRect(x, y, s, s);
      }
    }

    if (opts.clouds) {
      // Wispy SOFT CLOUDS for the sky theme: a few low, flat, blurred light
      // ellipses near the horizon band so the dawn sky isn't bare.
      ctx.globalCompositeOperation = 'source-over';
      const cloudC = opts.cloudColor || 'rgba(255,255,255,';
      const puffs = 10;
      for (let i = 0; i < puffs; i++) {
        const cx = Math.random() * W;
        const cy = H * (0.62 + Math.random() * 0.28); // lower band = near horizon
        const rx = (0.10 + Math.random() * 0.16) * W;
        const ry = rx * (0.28 + Math.random() * 0.12); // flat, wide clouds
        const g2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        const peak = 0.20 + Math.random() * 0.22;
        g2.addColorStop(0.0, cloudC + peak + ')');
        g2.addColorStop(1.0, cloudC + '0)');
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, ry / rx); // squash the round gradient into a flat cloud
        ctx.translate(-cx, -cy);
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    // Inverted sphere: BackSide renders the INSIDE faces so we see the texture
    // from within. fog:false + depthWrite:false keep it a pure far backdrop that
    // the scene fog never tints and nothing depth-fights.
    const geo = new THREE.SphereGeometry(opts.radius, 32, 24);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.name = 'skybox';
    dome.position.y = this.elevation; // center on the course so it's always far
    dome.frustumCulled = false;       // it wraps the camera; never cull it
    this.group.add(dome);
  }

  /**
   * Paint the SYNTHWAVE HORIZON SUN onto the dome canvas: a large low disc with a
   * hot-to-saturated vertical two-tone gradient, horizontal SLIT BANDS cutting its
   * lower half (the gaps widen + the solid bands thin toward the bottom — the
   * signature "venetian" sun), and a soft ADDITIVE halo so it blooms into the sky.
   * Painted ONCE (zero per-frame cost). Sits low: with the dome's flipped UVs, canvas
   * y ~0.56H maps just below the viewed horizon, so the disc's top half rises over it.
   *
   * The slit gaps are filled with the SAME base sky gradient (`baseGrad`) passed in,
   * which restores the exact sky behind them (this runs before nebula/clouds).
   *
   * @param {CanvasRenderingContext2D} ctx   the dome canvas context.
   * @param {number} W                       canvas width.
   * @param {number} H                       canvas height.
   * @param {CanvasGradient} baseGrad        the dome's base vertical gradient (for slit fill).
   * @param {{core:string, mid:string, edge:string, halo:string}} sun  per-theme colors
   *        (`halo` is an 'rgba(r,g,b,' PREFIX — alpha + ')' appended here, like nebula).
   * @private
   */
  _paintHorizonSun(ctx, W, H, baseGrad, sun) {
    const cx = W * 0.5;
    const cy = H * 0.56;     // low — top half pokes above the viewed horizon
    const R = W * 0.155;     // large disc

    // Soft additive HALO behind the disc so it glows into the sky.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.4);
    halo.addColorStop(0.0, sun.halo + '0.45)');
    halo.addColorStop(0.45, sun.halo + '0.14)');
    halo.addColorStop(1.0, sun.halo + '0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // The DISC + its slit bands, clipped to a circle so it stays round.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    // Vertical two-tone gradient: hot core up top -> saturated lower.
    const disc = ctx.createLinearGradient(cx, cy - R, cx, cy + R);
    disc.addColorStop(0.0, sun.core);
    disc.addColorStop(0.5, sun.mid);
    disc.addColorStop(1.0, sun.edge);
    ctx.fillStyle = disc;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // SLIT BANDS: restore the base sky in horizontal strips across the lower disc,
    // the gaps widening + the solid bands thinning toward the bottom.
    ctx.fillStyle = baseGrad;
    let y = cy - R * 0.05;   // start the banding a touch above center
    let gapH = R * 0.035;
    let solidH = R * 0.34;
    while (y < cy + R) {
      y += solidH;          // leave a solid band of the disc
      ctx.fillRect(cx - R, y, R * 2, gapH); // cut a gap (restores the sky behind it)
      y += gapH;
      gapH *= 1.5;          // gaps widen toward the bottom
      solidH *= 0.6;        // solids thin toward the bottom
    }
    ctx.restore();
  }

  /**
   * Build a couple of DISTANT GLOWING ACCENTS for the deep-space themes: large,
   * soft, additive camera-facing sprites (a far star/sun and a colored gas giant)
   * placed way out on the dome so the void has anchor points and a sense of scale.
   * Cheap: 2 sprites with a generated soft-disc texture, no lighting, no shadows.
   * @param {boolean} rainbow  pick the candied palette (vs the colder space one).
   * @private
   */
  _buildDistantAccents(rainbow) {
    // One soft radial-disc texture shared by both sprites (white core -> clear).
    const S = 128;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    rg.addColorStop(0.0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.25, 'rgba(255,255,255,0.7)');
    rg.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    const discTex = new THREE.CanvasTexture(c);
    discTex.colorSpace = THREE.SRGBColorSpace;

    // Two accents: a bright far "sun" and a dimmer colored "gas giant". Colors
    // differ per theme so each sky feels distinct.
    const accents = rainbow
      ? [{ color: 0xff6ad5, size: 240, pos: [-900, 380, -1000] },   // magenta sun
         { color: 0x6ad0ff, size: 150, pos: [820, 150, 950] }]      // cyan giant
      : [{ color: 0x9fd0ff, size: 210, pos: [-950, 300, -1050] },   // pale-blue sun
         { color: 0x9b6cff, size: 160, pos: [880, 220, 900] }];     // violet giant

    for (const a of accents) {
      const mat = new THREE.SpriteMaterial({
        map: discTex,
        color: a.color,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending, // glow that adds onto the dome
        fog: false,
        toneMapped: false,                // stay bright through tone mapping -> bloom
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(a.size, a.size, 1);
      sprite.position.set(a.pos[0], a.pos[1] + this.elevation, a.pos[2]);
      sprite.name = 'distantAccent';
      sprite.frustumCulled = false;
      this.group.add(sprite);
    }
  }

  /**
   * Build (once, then cache) the soft radial-disc sprite shared by every MED+ star
   * layer's PointsMaterial.map, so points render as round glints instead of GL
   * squares. White core -> transparent edge (the PointsMaterial `color` tints it),
   * exactly the disc trick used by _buildDistantAccents. One tiny canvas at load time.
   * @returns {THREE.CanvasTexture}
   * @private
   */
  _getStarSpriteTexture() {
    if (this._starTex) return this._starTex;
    const S = 32;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    rg.addColorStop(0.0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    rg.addColorStop(1.0, 'rgba(255,255,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this._starTex = tex;
    return tex;
  }

  /**
   * Build ONE Points starfield LAYER as a big sphere shell of random points and
   * add it to `this.group` (so it is removed with the track). For the deep-space
   * themes we call this 2-3 times at different radii to build a PARALLAX field:
   * each layer drifts at its own slow rate (see `drift`), so as the camera sweeps
   * the course the near layer slides faster than the far layers and the void reads
   * as having real depth. Material + object refs are stored so update(dt) can
   * twinkle the materials AND rotate each layer at its own drift speed.
   *
   * @param {number} count   number of stars in this layer.
   * @param {number} color   star color (hex).
   * @param {number} size    point size (m).
   * @param {number} radius  sphere radius the stars sit on (m).
   * @param {number} [baseOpacity=0.9] this layer's resting opacity (far layers
   *                          are fainter so the parallax depth reads).
   * @param {number} [drift=0] radians/sec this layer slowly rotates about Y for
   *                          the parallax drift (0 = static, e.g. the sky theme).
   * @private
   */
  _buildStars(count, color, size, radius, baseOpacity = 0.9, drift = 0) {
    // QUALITY TIER: scale the star COUNT only (size/opacity/parallax unchanged) so
    // a weak GPU renders a sparser field. A floor of 30 keeps the sky from going
    // empty on LOW. This is the ONLY graphics knob this file owns — the road
    // material is owned by the graphics workflow and is untouched here.
    count = Math.max(30, Math.round(count * qualitySettings.getConfig().starScale));
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Uniform-ish points on a sphere shell around the course.
      const u = Math.random() * 2 - 1;           // cos(phi) in [-1,1]
      const theta = Math.random() * Math.PI * 2;
      const rr = radius * (0.85 + Math.random() * 0.15);
      const s = Math.sqrt(1 - u * u);
      positions[i * 3 + 0] = rr * s * Math.cos(theta);
      positions[i * 3 + 1] = rr * u + this.elevation; // centered on the course
      positions[i * 3 + 2] = rr * s * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size,
      sizeAttenuation: true,
      transparent: true,
      opacity: baseOpacity,
      depthWrite: false,
      fog: false, // stars are the far backdrop — don't let course fog eat them
    });
    // ROUND GLINTS (MED+): map a soft shared radial-disc sprite onto each point with a
    // tiny alphaTest so stars read as round glints instead of hard GL squares. The map
    // is the SAME trick as the distant-accent disc — one shared texture, zero per-star
    // cost. LOW skips the map entirely so its sparse field stays today's square points.
    if (this._tier !== 'low') {
      mat.map = this._getStarSpriteTexture();
      mat.alphaTest = 0.05; // discard the faint outer ring -> crisp round edge
    }
    const stars = new THREE.Points(geo, mat);
    stars.name = 'themeStars';
    // Stars render behind everything; don't let them get frustum-culled out.
    stars.frustumCulled = false;
    this.group.add(stars);
    // Remember this layer's RESTING opacity so the twinkle wobbles around it
    // (each layer twinkles around its own base, not a shared one).
    mat.userData.baseOpacity = baseOpacity;
    this._starMaterials.push(mat);
    // Track the drifting layers for the parallax rotation in update(dt).
    if (drift) this._starLayers.push({ obj: stars, drift });
  }

  /**
   * Per-frame hook the race manager calls. Drives the ANIMATED look:
   *   - SCROLL the road CANVAS texture along V for a strong sense of speed (and,
   *     for rainbow, this also flows + hue-cycles the spectrum since it runs
   *     along V — no per-frame canvas repaint, just a free GPU UV offset).
   *   - ADVANCE the neon edge-rail shader time so the bright pulse band travels
   *     along BOTH rails toward the horizon.
   *   - all themes: gently twinkle the starfield opacity.
   * Safe to call every frame; a no-op for non-animated bits. NOTHING here
   * rebuilds geometry or repaints a canvas — only cheap uniform/offset bumps.
   *
   * @param {number} dt seconds since the last frame.
   */
  update(dt) {
    this._time += dt || 0;
    const t = this._time;

    // SPEED: scroll each road texture along V. We subtract so the markings flow
    // TOWARD the camera (the world rushing at us). The wrap is seamless because
    // the texture uses RepeatWrapping and the spectrum/grid tiles over [0,1].
    if (this._scrollTextures.length) {
      for (const s of this._scrollTextures) {
        // offset.y is in TEXTURE units; wrap with mod 1 to avoid float blow-up
        // over a long session (a huge offset loses precision and shimmers).
        s.tex.offset.y = (s.tex.offset.y - s.speed * (dt || 0)) % 1;
      }
    }

    // NEON RAILS: advance shader time so the pulse band sweeps along each rail
    // toward the horizon (and, for rainbow, hue-cycles the rail color in-shader).
    if (this._railMaterials.length) {
      for (const m of this._railMaterials) {
        m.uniforms.uTime.value = t;
      }
    }

    // BACK-COMPAT: legacy hue-cycle hooks (now empty — rainbow flows via the
    // texture scroll + rail shader above). Kept so any external code that pushed
    // into these arrays still animates without error.
    if (this._animatedRoadMats.length) {
      const hue = (t * 0.12) % 1;
      for (const m of this._animatedRoadMats) m.emissive.setHSL(hue, 0.85, 0.45);
    }
    if (this._animatedEdgeMats.length) {
      for (let i = 0; i < this._animatedEdgeMats.length; i++) {
        const hue = (t * 0.18 + i * 0.5) % 1;
        this._animatedEdgeMats[i].color.setHSL(hue, 1.0, 0.6);
      }
    }

    // Twinkle: subtle opacity wobble on each starfield layer, around its OWN
    // resting opacity so the faint far layers stay faint (a shared absolute value
    // would wash them all to the same brightness and kill the parallax depth).
    if (this._starMaterials.length) {
      const tw = 0.88 + 0.12 * Math.sin(t * 1.7);
      for (const m of this._starMaterials) {
        const base = m.userData.baseOpacity != null ? m.userData.baseOpacity : 0.9;
        m.opacity = base * tw;
      }
    }

    // PARALLAX DRIFT: slowly rotate each star layer about Y at its own rate so the
    // near layer slides faster than the far layers — a cheap, convincing sense of
    // deep-space depth as the course sweeps by. (A free transform; no geometry
    // touched.) Static layers (sky theme) aren't in this list, so they don't move.
    if (this._starLayers.length) {
      for (const layer of this._starLayers) {
        layer.obj.rotation.y += layer.drift * (dt || 0);
      }
    }

    // SPINNING DECOR: turn the sky-theme windmill pinwheels about their local Z so
    // the roadside props feel alive. A free transform per prop (no geometry touched);
    // empty for the dark themes, so this is a no-op there.
    if (this._spinProps.length) {
      for (const prop of this._spinProps) {
        prop.obj.rotation.z += prop.speed * (dt || 0);
      }
    }
  }
}
