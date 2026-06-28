// src/core/Renderer.js
//
// The Renderer owns everything Three.js needs to draw the world:
//   - a WebGLRenderer (the thing that actually paints pixels onto a <canvas>)
//   - a Scene (the container that holds all 3D objects, lights, fog, background)
//   - a PerspectiveCamera (our "eye" into the world)
//   - the lights (a soft ambient hemisphere light + one directional "sun")
//
// It also handles two ongoing jobs:
//   - resizing the canvas + camera when the browser window changes size
//   - following the kart with a smooth "chase camera" each frame
//
// Why this file has NO physics/game logic: the renderer only cares about how
// things LOOK, not how they MOVE. Game logic lives elsewhere and just hands us
// a kart STATE object so we can point the camera at it.

import * as THREE from 'three';

// Post-processing pipeline pieces. An EffectComposer is a chain of "passes":
// each pass takes the previous pass's image, transforms it, and hands it on.
// This is how we layer the neon arcade look (glow + motion blur) on top of the
// plain rendered scene.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
// ShaderPass runs ONE custom fullscreen fragment shader over the previous pass's
// image. We use a single one for the cinematic finishing layer: per-theme color
// grading (tint + contrast + saturation), a vignette, and a speed-reactive radial
// blur / speed-line darkening that ramps with the player's velocity.
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// RoomEnvironment + PMREMGenerator give us a soft, neutral environment map
// (image-based lighting) for free — no .hdr download needed. It feeds nice
// reflections to any PBR (MeshStandardMaterial / MeshPhysicalMaterial) surfaces.
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ANTI-GRAV: the PURE shared surface-frame helper. The chase camera rolls with the
// kart through a wall/ceiling section so the world reads "upside down" correctly.
import { surfaceFrameAt } from '../../shared/trackData.js';

// QUALITY TIER: the single source of truth for every GPU-cost knob (pixel ratio,
// shadows, bloom, grade blur taps...). The renderer reads the active tier's budget
// at construction and can live-apply a new tier via setQualityTier().
import qualitySettings from './QualitySettings.js';

export class Renderer {
  constructor() {
    // Read the active quality budget ONCE up front. Antialias is locked in here
    // (it can't change without rebuilding the WebGL context), so we remember it to
    // tell the pause menu when a tier switch needs a reload.
    const qcfg = qualitySettings.getConfig();
    this.quality = qcfg.tier;     // exposed so other systems can read the tier
    this._antialias = qcfg.antialias;
    // EFFECTIVE PIXEL RATIO = min(devicePixelRatio, cap) * renderScale. The CAP is
    // the tier ceiling (the headline cost lever); the SCALE is the adaptive-res
    // governor's live multiplier (1 = full tier res, only ever scaled DOWN when the
    // frame budget is blown — see setRenderScale + Loop's governor). _effectivePixelRatio
    // folds both, and is the ONE place pixel ratio is computed.
    this._pixelRatioCap = qcfg.pixelRatioCap;
    this._renderScale = 1;
    // -----------------------------------------------------------------
    // 1. The WebGLRenderer: the engine that draws 3D onto a 2D canvas.
    // -----------------------------------------------------------------
    // antialias smooths jagged edges on diagonal lines (slightly more expensive,
    // but the track and karts look much cleaner with it on). Off on the LOW tier.
    // This is the ONE setting that can't change live — it's baked into the context.
    this.renderer = new THREE.WebGLRenderer({ antialias: qcfg.antialias });

    // pixelRatio controls how many real device pixels we draw per CSS pixel — the
    // HEADLINE cost. Retina screens report devicePixelRatio 2-3; min(dpr, 2) drew
    // 4x the pixels of a 1x screen, which is exactly why high-end laptops' fans
    // spin on this game. We now clamp to the QUALITY TIER's cap (1 / 1.5 / 2), so
    // LOW renders at 1x (a quarter of the old pixels) for the Chromebook 60fps.
    this.renderer.setPixelRatio(this._effectivePixelRatio());

    // Make the canvas fill the whole browser window.
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Shadows. PCFShadowMap gives reasonably soft, percentage-closer filtered
    // edges. (We use PCFShadowMap rather than PCFSoftShadowMap because the latter
    // triggers a deprecation console warning in recent three.js builds; PCF still
    // looks clean and avoids the noise.) Whether shadows render at all is a quality
    // lever — LOW turns the entire shadow pass off (a big saving on weak GPUs).
    this.renderer.shadowMap.enabled = qcfg.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // -----------------------------------------------------------------
    // 1b. Tone mapping: map the wide range of light values the scene can
    // produce down to what a screen can actually show. ACESFilmic is the
    // cinematic, film-like curve — it keeps bright glowing emissives (neon
    // rails, sparks) from blowing out to flat white, and gives richer colors.
    // -----------------------------------------------------------------
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure is like a camera's brightness knob. We keep it at 1.0 — ACES already
    // rolls the highlights off gently, so the bright clean MK8 look comes from the
    // LIGHTING balance below, not from cranking exposure (which would just re-blow
    // the road out, the exact washout we're guarding against).
    this.renderer.toneMappingExposure = 1.0;
    // (outputColorSpace defaults to SRGBColorSpace in r184, so colors are
    // already gamma-correct on screen — no need to set it explicitly.)

    // Put the canvas into the page so the player can actually see it.
    document.body.appendChild(this.renderer.domElement);

    // -----------------------------------------------------------------
    // 2. The Scene: the container for everything we draw.
    // -----------------------------------------------------------------
    this.scene = new THREE.Scene();

    // A pleasant light-blue sky as the background color.
    const skyColor = 0x87ceeb; // classic "sky blue"
    this.scene.background = new THREE.Color(skyColor);

    // Subtle fog so distant scenery fades into the sky instead of popping
    // in/out abruptly. The fog color matches the sky so the horizon blends.
    // (near = where fog starts, far = where everything is fully fogged out.)
    this.scene.fog = new THREE.Fog(skyColor, 200, 800);

    // -----------------------------------------------------------------
    // 2b. Environment map (image-based lighting) for PBR reflections.
    // -----------------------------------------------------------------
    // PMREMGenerator pre-processes an environment into the special blurred
    // mipmap format that MeshStandardMaterial needs for realistic reflections.
    // RoomEnvironment is a tiny built-in "soft studio" scene — no asset to load.
    // We assign the result to scene.environment so EVERY standard material in
    // the world picks up subtle reflections/ambient light automatically.
    // We deliberately leave scene.background untouched (per-track skyboxes land
    // in a later task); this only affects lighting/reflections, not the sky.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    // The second arg is the env's blur sigma. A small value (0.02) keeps the
    // reflection a touch SHARPER so glossy kart bodywork picks up a crisp studio
    // highlight (the MK8 "toy plastic" read) instead of a muddy smear. This feeds
    // only reflections/specular, NOT diffuse brightness, so it can't wash the road.
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
    // A gentle global multiplier on how strongly every PBR material samples that
    // environment map. 1.0 is three.js's default; we leave it implicit per-material
    // (karts/road set their own envMapIntensity), and only the SHARPER env above
    // changes here — so this stays surgical and can't over-brighten the scene.
    pmrem.dispose(); // free the temporary GPU resources; the texture survives.

    // -----------------------------------------------------------------
    // 3. The Camera: our viewpoint into the 3D world.
    // -----------------------------------------------------------------
    // PerspectiveCamera(fov, aspect, near, far):
    //   fov  = 60 degrees vertical field of view (a natural-feeling lens)
    //   aspect = width / height of the window (so nothing looks stretched)
    //   near = 0.1m  : closer than this is not drawn
    //   far  = 3400m : farther than this is not drawn. The sky DOME is radius 1600
    //     centered at the origin; the courses are large, so far from center the
    //     OPPOSITE side of the dome sat past the old 2000 far-plane and got clipped —
    //     the near-black background showed through as a "black hole" in the sky. A
    //     kart stays inside the dome (<=1600 from origin), so the farthest dome point
    //     is <=3200 away; 3400 keeps the whole dome (and distant stars) in view from
    //     anywhere on the course. (depth precision impact is negligible at near 0.1.)
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      3400
    );
    // Start the camera a little up and back so the first frame isn't at origin.
    this.camera.position.set(0, 4, -8);

    // -----------------------------------------------------------------
    // 3b. Camera-feel state (speed FOV, boost kick, landing/hit shake).
    // -----------------------------------------------------------------
    // applyCameraFeel(state, dt) reads the player's live state each frame and
    // shapes the lens so driving FEELS fast:
    //   - FOV widens with speed (a wider lens makes scenery streak past harder).
    //   - a short FOV/pull-back KICK fires on boost (the world lunges forward).
    //   - a brief SHAKE fires on a hard landing (airborne->grounded) or a hit.
    // We keep the base FOV (idle) and the max FOV (top speed) here, plus smoothed
    // running values so the lens eases between them rather than snapping.
    // 44 m/s only FEELS like 44 if the lens screams at top speed — so the wide
    // end is pushed hard (60 -> 82 deg) and the boost edge slams in a big punch
    // that decays. A wider lens streaks scenery past the frame edges harder, which
    // is the single biggest "this is FAST" cue an arcade racer has.
    this._fovIdle = 60;      // degrees — calm cruising lens
    this._fovMax = 82;       // degrees — top-speed wide lens (was 72 — too tame)
    this._fovBoostKick = 11; // extra degrees slammed in on a boost edge (was 6)
    this._fov = this._fovIdle;      // smoothed current FOV target tracker
    this._fovKick = 0;              // transient boost-kick FOV bonus (decays)
    this._shake = 0;                // current shake magnitude (decays each frame)
    this._wasAirborne = false;      // edge-detect airborne->grounded for landings
    this._fallVy = 0;               // last airborne vy: the kart's downward speed at
                                    // touchdown = landing IMPACT (sim zeroes vy on
                                    // land, so we capture it the frame before)
    this._prevBoost = 0;            // edge-detect a fresh boost for the FOV kick
    this._prevSpin = 0;             // edge-detect a fresh hit for the shake
    this._prevOverdrive = 0;        // edge-detect a fresh overdrive surge (signature hook)
    this._driftTier = 0;            // peak mini-turbo tier banked this charge — a PURPLE (3)
                                    // release rumbles the camera (see applyCameraFeel). Captured
                                    // across frames because the sim zeroes the tier the instant
                                    // the boost arms, so the release frame alone can't see it.
    this._followYaw = undefined;    // damped chase-yaw used during a drift when the sim doesn't
                                    // expose a velocity heading — lags the drift's heading swing
                                    // so the view stays pointed down-track (see updateChaseCamera).
    // PLANTED CAMERA HEIGHT: a low-passed copy of the kart's ground height. We
    // follow THIS (not raw state.y) vertically so a smooth road yields a dead-stable
    // view (no 60Hz bob) while still tracking real hill elevation. undefined => snap
    // to state.y on the first frame so a new race doesn't lurch into place.
    this._camY = undefined;
    // CAMERA DIP/SETTLE: on a fresh boost the camera lunges DOWN a touch and pulls
    // closer to the ground for a beat, then springs back — a weighty "the kart just
    // surged forward" lurch that pairs with the FOV kick. We track a transient dip
    // magnitude that decays, applied as a downward + forward camera nudge.
    this._camDip = 0;
    // The shake is applied as a tiny positional jitter AFTER updateChaseCamera
    // aims the camera; we remember the un-shaken position so each frame's jitter
    // is added fresh (not compounded).
    this._shakeOffset = new THREE.Vector3();

    // -----------------------------------------------------------------
    // 4. Lights.
    // -----------------------------------------------------------------
    // HemisphereLight: soft fill light. Color from the sky tints the tops of
    // objects, color from the ground tints their undersides. Last arg is
    // intensity. This keeps shadowed areas from being pitch black.
    const hemiLight = new THREE.HemisphereLight(
      0xbfd8ff, // sky color (cool blue from above)
      0x554433, // ground color (warm brown bounce from below)
      0.8 // intensity
    );
    this.scene.add(hemiLight);
    // Stored so dark themes (rainbow/space) can dim it for a neon-night look
    // (see setThemeLighting). Default 0.8 suits the bright menu.
    this.hemiLight = hemiLight;
    this._dayHemi = 0.8;
    this._daySun = 1.2;

    // DirectionalLight: acts like the sun. Its rays are parallel and it can
    // cast shadows. We aim it from above and to the side so karts cast nice
    // angled shadows on the track. The color is a WARM near-white (0xfff3e2)
    // rather than pure white — MK8's key light is a warm afternoon sun, so this
    // gives kart bodywork a warm highlight on the lit side that the cool blue
    // hemisphere fill (above) balances on the shadow side, for a clean, vibrant,
    // believable daylight rather than a flat clinical white. Intensity stays 1.2
    // (the existing day level) so we do NOT add brightness / risk a road washout.
    this.sun = new THREE.DirectionalLight(0xfff3e2, 1.2);
    this.sun.position.set(100, 150, 100);
    this.sun.castShadow = qcfg.shadows;

    // Shadow map resolution from the quality tier (512 medium -> 2048 ultra). A
    // bigger map = crisper shadow edges but more GPU + memory.
    this.sun.shadow.mapSize.width = qcfg.shadowMapSize;
    this.sun.shadow.mapSize.height = qcfg.shadowMapSize;
    // Soften the shadow EDGES a touch (PCF blur radius). MK8's kart shadows are
    // soft-edged, not hard stencil cuts; a small radius blurs the penumbra so the
    // shadow under each kart reads as a clean soft contact patch. This only affects
    // shadow softness, never brightness.
    this.sun.shadow.radius = 3;

    // The sun's shadow camera is an ORTHOGRAPHIC box that defines which part of
    // the world can receive shadows. The OLD box was ±300m (600m wide) centered on
    // the world ORIGIN — but the spline courses are thousands of metres long, so a
    // kart far from origin fell OUTSIDE the box (no shadow) and, where the box did
    // cover, a low-res map smeared across 600m gave each ~2m kart only 2-3 fuzzy
    // texels = the faint/missing shadows the owner saw. We instead use a TIGHT ±70m
    // box that FOLLOWS the player every frame (see _followSunShadow): over 140m a
    // 512 map is ~0.27m/texel (MED) and a 1024 map ~0.14m (HIGH) — a crisp, readable
    // contact shadow under each kart in the visible pack.
    const shadowSize = 70; // half-width of the (player-following) shadow box, meters
    this.sun.shadow.camera.left = -shadowSize;
    this.sun.shadow.camera.right = shadowSize;
    this.sun.shadow.camera.top = shadowSize;
    this.sun.shadow.camera.bottom = -shadowSize;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 400;

    // Bias tuning to kill "shadow acne" (self-shadowing stripes) WITHOUT visible
    // peter-panning (a shadow detaching from the kart). normalBias offsets along the
    // surface normal and scales with texel size, so it cleans acne on the karts'
    // curved bodywork far better than depth bias alone; with the tight frustum above
    // its world-space size is small, so contact shadows still hug the wheels.
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.8;

    this.scene.add(this.sun);
    // A DirectionalLight shines toward its .target (default is world origin).
    // Adding the target to the scene makes its transform update correctly.
    this.scene.add(this.sun.target);

    // -----------------------------------------------------------------
    // 4b. Cinematic form lights — a subtle KEY + a theme-tinted FILL/RIM.
    // -----------------------------------------------------------------
    // The dark-theme dimming (setThemeLighting) drops the sun + hemisphere so the
    // neon void reads right, but that left karts + road looking FLAT — every
    // surface caught the same dim light from the same angle, so they had no sense
    // of volume. We layer two cheap directional lights ON TOP that give form:
    //
    //   keyLight  — a soft cool-white directional from the upper-FRONT-left. It
    //               does NOT cast shadows (the sun already does), it just rakes
    //               across the karts/road so edges and curved bodywork catch a
    //               highlight and read as 3D rather than as flat silhouettes.
    //   fillLight — a colored RIM from below/behind, tinted per theme. It lifts
    //               the shadow side off pure black with the theme's signature hue
    //               (magenta for rainbow, cyan for space, warm peach for sky), so
    //               the karts pick up a colored edge that ties them to the world.
    //
    // Both are gentle (intensity tuned in setThemeLighting); together they add
    // depth without re-brightening the scene or touching the existing sun/hemi
    // balance. No shadow maps = essentially free.
    // Warm-neutral key (0xfff1df, a soft cream) rather than the old cool blue:
    // a warm modeling rake reads as sunlight catching the karts' glossy shoulders,
    // which — paired with the cool hemisphere fill on the shadow side — gives the
    // clean warm/cool contrast that makes MK8 bodywork look like glossy toy plastic.
    this.keyLight = new THREE.DirectionalLight(0xfff1df, 0.0);
    this.keyLight.position.set(-60, 80, 40); // upper front-left rake
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.0);
    this.fillLight.position.set(50, -10, -70); // low + behind = a back/under rim
    this.scene.add(this.fillLight);
    this.scene.add(this.fillLight.target);

    // Default (menu) form-light levels. setThemeLighting layers theme-specific
    // intensities + the fill tint on top of these each time a track loads.
    this._dayKey = 0.35;
    this._dayFill = 0.18;
    this.keyLight.intensity = this._dayKey;
    this.fillLight.intensity = this._dayFill;
    this.fillLight.color.set(0xbfd0ff); // neutral cool fill for the bright menu

    // -----------------------------------------------------------------
    // 5. Post-processing pipeline (the neon arcade look).
    // -----------------------------------------------------------------
    // The EffectComposer renders the scene into an off-screen buffer, then
    // runs a chain of passes over it before painting the final result to the
    // canvas. Order matters — each pass reads the previous pass's output.
    const width = window.innerWidth;
    const height = window.innerHeight;

    this.composer = new EffectComposer(this.renderer);
    // Match the renderer's (quality-capped) pixel ratio so the composed image is
    // exactly as crisp as the raw render — no more, no less. This carries the
    // headline pixelRatio saving through the whole post-processing chain.
    this.composer.setPixelRatio(this._effectivePixelRatio());
    this.composer.setSize(width, height);

    // Pass 1 — RenderPass: actually draw the 3D scene from the camera. This is
    // the base image every later pass builds on.
    this._renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this._renderPass);

    // Pass 2 — UnrealBloomPass: the glow. It finds the brightest pixels (above
    // `threshold`), blurs them outward (`radius`), and adds them back on top
    // (`strength`). This is what makes emissive rails, sparks, and stars look
    // like they're radiating light.
    //   strength  ~0.7  : how intense the glow is (too high = everything washes
    //                      out to white).
    //   radius    ~0.5  : how far the glow spreads from a bright pixel.
    //   threshold ~0.85 : only pixels brighter than this bloom, so the sky and
    //                      mid-tones stay clean and only the hot neon glows.
    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.22, // strength (per-theme override via setBloom)
      0.4, // radius — tighter glow, less screen-wide haze
      0.93 // threshold — only the brightest lines/rails bloom (road body stays clean)
    );
    this.composer.addPass(this._bloomPass);
    // BLOOM QUALITY SCALE: every setBloom() call multiplies the requested strength
    // by this tier scale, so LOW (scale 0) kills bloom entirely while ULTRA pushes
    // a touch extra — without any caller needing to know the tier. We remember the
    // last requested BASE strength so a live tier switch can re-apply it.
    this._bloomBase = 0.22;
    this._bloomScale = qcfg.bloomStrengthScale;
    this._bloomPass.strength = this._bloomBase * this._bloomScale;
    this._bloomPass.enabled = this._bloomPass.strength > 0; // LOW (scale 0) skips the blur chain from frame 1

    // Pass 3 — AfterimagePass: cheap motion blur. It blends a fraction of the
    // PREVIOUS frame into the current one, leaving a short light trail behind
    // fast movement — exactly the "speed streak" feel for an arcade racer.
    //   damp ~0.55 is modest: enough to feel speed, not so much that the whole
    //   screen smears. We start it DISABLED so the look is opt-in via settings
    //   (a permanent trail can feel nauseating to some players); enable it with
    //   setMotionBlur(true).
    this._afterimagePass = new AfterimagePass(0.55);
    this._afterimagePass.enabled = false;
    this.composer.addPass(this._afterimagePass);

    // Pass 3b — GRADE PASS: the cinematic finishing layer (one ShaderPass).
    // -----------------------------------------------------------------------
    // This single fragment shader does three jobs in one cheap fullscreen draw,
    // so the picture goes from "flat render" to "graded shot":
    //
    //   1. COLOR GRADE — pull a per-theme TINT into the midtones, push a little
    //      CONTRAST around mid-grey, and lift SATURATION. This is what makes the
    //      rainbow track feel candied, the space track cold/inky, the sky track
    //      soft and warm — rather than every theme reading the same.
    //   2. VIGNETTE — gently darken the frame corners. Pulls the eye to the
    //      center of the action and gives the whole image a lens-y, cinematic
    //      edge falloff.
    //   3. SENSE OF SPEED — a radial smear toward the screen edges plus a
    //      darkening "speed-line" ring, both of which RAMP with uSpeed (0 idle ->
    //      ~1 at top speed, fed by applyCameraFeel). At rest it is invisible; at
    //      speed the edges blur and tunnel inward so the world feels like it's
    //      rushing past. Sampling the radial smear a few taps keeps it cheap.
    //
    // It sits AFTER bloom + motion blur (so it grades the FINISHED neon image)
    // and BEFORE OutputPass (so tone mapping is still applied last, in OutputPass).
    // We author/sample in the composer's working space and let OutputPass do the
    // final ACES tone map + sRGB convert, exactly as before.
    this._gradeUniforms = {
      tDiffuse: { value: null },          // previous pass's image (auto-filled)
      uTint: { value: new THREE.Color(0xffffff) }, // per-theme grade tint
      uTintAmount: { value: 0.0 },        // how strongly the tint pulls in
      uContrast: { value: 1.0 },          // >1 = punchier midtone contrast
      uSaturation: { value: 1.0 },        // >1 = richer colors
      uVignette: { value: 0.0 },          // 0 = off, ~0.4 = noticeable corners
      uSpeed: { value: 0.0 },             // 0..~1 sense-of-speed amount (live)
      uAspect: { value: window.innerWidth / Math.max(1, window.innerHeight) },
      uBlurTaps: { value: qcfg.gradeBlurTaps }, // 1 = single sample (LOW), 3 = medium, 6 = full smear
      // --- MED+ ONLY (all gated behind uBlurTaps>=2 so LOW stays byte-identical) ---
      uTime: { value: 0.0 },              // seconds, ticked live — animates the film grain
      uCA: { value: 0.0 },                // per-theme chromatic-aberration amount (0 = off)
      uSplitTone: { value: 0.0 },         // per-theme split-tone strength (0 = off)
      uShadowTint: { value: new THREE.Color(0xffffff) },    // split-tone: cool hue pulled into shadows
      uHighlightTint: { value: new THREE.Color(0xffffff) }, // split-tone: warm/neon hue pulled into highlights
    };
    this._gradePass = new ShaderPass({
      uniforms: this._gradeUniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec3  uTint;
        uniform float uTintAmount;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uVignette;
        uniform float uSpeed;
        uniform float uAspect;
        uniform float uBlurTaps;
        uniform float uTime;
        uniform float uCA;
        uniform float uSplitTone;
        uniform vec3  uShadowTint;
        uniform vec3  uHighlightTint;
        varying vec2 vUv;

        // Rec. 709 luma weights — used so saturation/contrast pivot around
        // perceived brightness rather than raw channel averages.
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

        // Cheap per-pixel hash (0..1). Drives both the banding dither (stable per
        // screen pixel via gl_FragCoord) and the animated grain (offset by uTime).
        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          // --- SENSE OF SPEED: radial blur toward the frame edges. ----------
          // Vector from screen center to this pixel; corrected for aspect so the
          // smear is circular, not stretched. Pixels near center barely move;
          // pixels near the edge smear hardest (that's the "rushing past" read).
          vec2 center = vec2(0.5);
          vec2 toCenter = vUv - center;
          // edge weight 0 at center -> 1 at the corners. We bias it with pow so the
          // CENTER of the frame stays sharp (you read the road ahead) while the
          // outer ring smears hard — that contrast is what sells the rush.
          float edge = clamp(length(toCenter * vec2(uAspect, 1.0)) / 0.75, 0.0, 1.0);
          edge = pow(edge, 1.4);
          // Bigger max smear (0.020 -> 0.038) so the streak is unmistakable near top
          // speed; still invisible at rest because uSpeed is 0 there.
          float blurAmt = uSpeed * edge * 0.038; // max smear in UV units

          // Tap count scales with the QUALITY TIER (uBlurTaps): 6 taps = the full
          // smooth smear (high/ultra), 3 = a lighter smear (medium), and <2 means
          // a single sample (LOW) — the radial blur is the priciest part of this
          // pass, so skipping the extra taps is a real saving on weak GPUs. The
          // branches are unrolled (constant tap counts) so this stays GLSL1-safe.
          vec3 col;
          if (blurAmt > 0.0001 && uBlurTaps >= 2.0) {
            vec3 acc = texture2D(tDiffuse, vUv).rgb;
            if (uBlurTaps >= 6.0) {
              acc += texture2D(tDiffuse, vUv - toCenter * blurAmt * 0.6).rgb;
              acc += texture2D(tDiffuse, vUv - toCenter * blurAmt * 1.2).rgb;
              acc += texture2D(tDiffuse, vUv - toCenter * blurAmt * 1.8).rgb;
              acc += texture2D(tDiffuse, vUv - toCenter * blurAmt * 2.4).rgb;
              acc += texture2D(tDiffuse, vUv - toCenter * blurAmt * 3.0).rgb;
              col = acc * (1.0 / 6.0);
            } else {
              acc += texture2D(tDiffuse, vUv - toCenter * blurAmt * 1.2).rgb;
              acc += texture2D(tDiffuse, vUv - toCenter * blurAmt * 2.4).rgb;
              col = acc * (1.0 / 3.0);
            }
            // CHROMATIC ABERRATION (MED+): split the channels along the SAME
            // toCenter vector the smear already uses, so the frame edges fringe
            // into colour as speed climbs (R pushed out, B pulled in a touch, G
            // from the blurred average). ~2 extra fetches, reusing edge/toCenter.
            // Per-theme uCA scales it (0 on the menu => skipped entirely).
            float caAmt = uCA * (edge * 0.0016 + uSpeed * edge * 0.006);
            if (caAmt > 0.00001) {
              col.r = texture2D(tDiffuse, vUv + toCenter * caAmt).r;       // R: larger offset, outward
              col.b = texture2D(tDiffuse, vUv - toCenter * caAmt * 0.5).b; // B: smaller offset, inward
            }
          } else {
            col = texture2D(tDiffuse, vUv).rgb;
          }

          // --- COLOR GRADE ---------------------------------------------------
          // Tint: blend toward (color * tint) so the theme hue washes the image
          // without crushing it (we keep most of the original, add a touch).
          col = mix(col, col * uTint, uTintAmount);
          // Saturation: lerp between greyscale luma and full color.
          float l = dot(col, LUMA);
          col = mix(vec3(l), col, uSaturation);
          // Contrast: expand around mid-grey (0.5) for punchier shots.
          col = (col - 0.5) * uContrast + 0.5;

          // --- SPLIT-TONE (MED+): cool shadows / warm highlights -------------
          // Luma-weighted hue push: darks lean toward the theme's cool hue, brights
          // toward a warm/neon hue. Blending toward (col * tint) shifts the hue with
          // almost no brightness change (same trick as uTint), so it deepens the
          // cinematic look without crushing the image. Per-theme uSplitTone gates it
          // (0 on the menu => no shift). Gated behind uBlurTaps>=2 so LOW is untouched.
          if (uBlurTaps >= 2.0 && uSplitTone > 0.0) {
            float ls = dot(col, LUMA);
            float shadowW = (1.0 - smoothstep(0.0, 0.55, ls)) * uSplitTone; // strongest in darks
            float highW   = smoothstep(0.45, 1.0, ls) * uSplitTone;         // strongest in brights
            col = mix(col, col * uShadowTint, shadowW);
            col = mix(col, col * uHighlightTint, highW);
          }

          // --- VIGNETTE + speed tunnel --------------------------------------
          // Base lens vignette: corners fall off softly.
          float vig = smoothstep(0.95, 0.30, edge);
          float vignette = mix(1.0, vig, uVignette);
          // At speed, deepen the edge darkening into a tunnel for extra rush (0.55
          // -> 0.8 so top speed visibly tunnels the frame inward).
          float speedTunnel = mix(1.0, vig, uSpeed * 0.8);
          col *= vignette * speedTunnel;

          // --- DITHER + ANIMATED GRAIN (MED+) -------------------------------
          // The dark themed dome is a smooth near-black gradient, where 8-bit output
          // shows visible banding rings. A sub-LSB ordered dither (±0.5/255, keyed to
          // the screen pixel) breaks those bands into noise the eye reads as smooth.
          // On top, a faint shadow-weighted film grain (strongest in the darks, fading
          // out of the highlights) adds a filmic texture and hides the last of the
          // banding. Both are pennies of ALU and gated behind uBlurTaps>=2 (LOW stays
          // byte-identical to today).
          if (uBlurTaps >= 2.0) {
            float dith = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
            float lg = dot(col, LUMA);
            float grain = (hash21(gl_FragCoord.xy + vec2(uTime * 60.0)) - 0.5) * 0.025 * (1.0 - lg);
            col += dith + grain;
          }

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `,
    });
    this.composer.addPass(this._gradePass);
    // IMPORTANT: ShaderPass CLONES the uniforms object we passed in, so the live
    // uniforms the shader actually reads live on this._gradePass.uniforms — NOT
    // the original literal above. Repoint _gradeUniforms at the clone so every
    // per-theme grade write (_applyThemeForm) and the resize/uSpeed updates
    // actually reach the shader (otherwise the grade + vignette do nothing).
    this._gradeUniforms = this._gradePass.uniforms;

    // Pass 4 — OutputPass: applies tone mapping + sRGB color conversion to the
    // composited result. It MUST be last so glow/blur happen in linear light
    // and the final image is correctly tone-mapped for the screen. (With a
    // composer, the renderer's own tone mapping is bypassed for the chain, so
    // this pass is what actually applies ACESFilmic to the final picture.)
    this._outputPass = new OutputPass();
    this.composer.addPass(this._outputPass);

    // -----------------------------------------------------------------
    // 6. Keep things sized to the window.
    // -----------------------------------------------------------------
    // Bind so 'this' still refers to the Renderer inside the handler.
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    // Decide the initial render path (composer vs. direct fast path) now that all
    // passes exist and the grade defaults are flat — on LOW this engages the direct
    // path for the opening menu (one less full-screen pass on the weakest GPUs).
    this._refreshRenderPath();

    // Register with the adaptive-resolution governor bridge: Loop.js measures frame
    // time and calls qualitySettings.applyRenderScale, which routes here so the
    // governor can drop our render resolution when a weak GPU misses the 60fps budget.
    qualitySettings.setRenderScaleSink((s) => this.setRenderScale(s));
  }

  // Called whenever the browser window size changes. Without this, the image
  // would look stretched or letterboxed after a resize.
  _onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    // Update the camera's aspect ratio and recompute its projection.
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // Re-apply the effective pixel ratio FIRST — this is the single place it lands
    // on both the renderer and the composer, so a governor render-scale change (which
    // routes through here) takes effect when the targets are rebuilt by setSize below.
    const pr = this._effectivePixelRatio();
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);

    // Resize the canvas/render target to match.
    this.renderer.setSize(width, height);

    // The composer and its passes own their own off-screen buffers, so they
    // must be resized too or the post-processed image would be stretched.
    this.composer.setSize(width, height);
    this._bloomPass.setSize(width, height);
    // Keep the grade shader's aspect in sync so the speed radial blur + vignette
    // stay circular (not stretched) after a resize.
    if (this._gradeUniforms) {
      this._gradeUniforms.uAspect.value = width / Math.max(1, height);
    }
  }

  // ------------------------------------------------------------------
  // setBloom(strength) / setMotionBlur(enabled)
  // ------------------------------------------------------------------
  // Small hooks so a settings menu (added later) can tune the look at runtime.
  //
  // setBloom(strength): change how intense the neon glow is. Pass 0 to turn the
  // glow off entirely, ~0.7 for the default, higher for a dreamier look. The
  // requested strength is the BASE; the active quality tier scales it (LOW's scale
  // is 0, so bloom is forced off there no matter what theme asks for). We remember
  // the base so setQualityTier can re-scale the same look when the tier changes.
  setBloom(strength) {
    this._bloomBase = strength;
    const eff = strength * this._bloomScale;
    this._bloomPass.strength = eff;
    // Effective strength 0 (LOW tier, or a theme that wants no bloom) -> DISABLE the
    // whole pass so its 5-mip Gaussian blur chain stops running every frame. The
    // composer skips disabled passes (AfterimagePass already ships disabled), so this
    // is the real per-frame fill-rate cut a weak GPU needs — not just a 0 multiply.
    this._bloomPass.enabled = eff > 0;
    // Bloom on/off flips whether the composer is pure overhead — re-check the fast path.
    this._refreshRenderPath();
  }

  // setMotionBlur(enabled): turn the afterimage "speed trail" on or off. When
  // toggling OFF we also clear the pass so a stale frozen frame isn't left
  // smeared on screen for a moment.
  setMotionBlur(enabled) {
    this._afterimagePass.enabled = !!enabled;
    // The afterimage trail forces the composer; toggling it re-checks the fast path.
    this._refreshRenderPath();
  }

  // ------------------------------------------------------------------
  // setQualityTier(tier)
  // ------------------------------------------------------------------
  // LIVE-apply a new graphics quality tier (called from the pause-menu slider via
  // main.js). Persists the choice through QualitySettings, then re-applies every
  // knob that CAN change without rebuilding the WebGL context:
  //   - pixel ratio (the headline cost) on the renderer + composer
  //   - shadows on/off + shadow-map resolution
  //   - bloom strength (re-scaled from the last requested base)
  //   - the grade-pass radial-blur tap count
  // ANTIALIAS is the one exception: it's baked into the WebGL context at creation,
  // so it only takes effect on the NEXT page load. We return whether AA changed so
  // the caller can tell the player a reload is needed.
  // @param {('low'|'medium'|'high'|'ultra')} tier
  // @returns {{ reloadForAA: boolean }}
  setQualityTier(tier) {
    const cfg = qualitySettings.setTier(tier); // persists + notifies subscribers
    this.quality = qualitySettings.tier;

    // Pixel ratio (live) — update the tier CAP and reset the governor's adaptive
    // scale (a fresh tier starts at full res and re-adapts), then rebuild the render
    // targets at the new effective ratio by reusing the resize path.
    this._pixelRatioCap = cfg.pixelRatioCap;
    this._renderScale = 1;
    this._onResize();

    // Shadows (live) — toggling shadowMap.enabled needs materials to recompile.
    this._applyShadowConfig(cfg);

    // Bloom (live) — re-scale the last requested base strength by the new tier.
    this._bloomScale = cfg.bloomStrengthScale;
    this.setBloom(this._bloomBase);

    // Grade-pass radial-blur taps (live).
    if (this._gradeUniforms) this._gradeUniforms.uBlurTaps.value = cfg.gradeBlurTaps;
    // Tap count gates the MED+ grade effects, so the composer-vs-direct fast path
    // may have changed (e.g. low->medium turns the grade effects on) — re-check it.
    this._refreshRenderPath();

    // NOTE: the per-tier MATERIAL upgrades — env-reflection intensity (kart/road/item),
    // lit items, the clear-coat body, and the road normal map — are baked into those
    // materials when they're BUILT (Track/Kart/ItemBox/Projectiles read the tier in
    // their constructors). A live re-bake would mean rebuilding every material mid-race,
    // which isn't worth it; those changes take effect on the NEXT race/track load. The
    // shadow-camera follow + tight frustum below ARE live (they live on the sun here).

    const reloadForAA = cfg.antialias !== this._antialias;
    return { reloadForAA };
  }

  // Apply the shadow part of a quality config live. Toggling renderer.shadowMap.
  // enabled at runtime requires every material to recompile (shadows are baked into
  // the shader program), and changing the map resolution requires the old shadow
  // map to be disposed so it rebuilds at the new size. This only runs on a settings
  // change, never per frame, so the scene traverse is cheap enough.
  // @private
  _applyShadowConfig(cfg) {
    this.renderer.shadowMap.enabled = cfg.shadows;
    this.sun.castShadow = cfg.shadows;
    if (cfg.shadows) {
      this.sun.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
      // Drop the existing shadow map so it's recreated at the new resolution.
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.renderer.shadowMap.needsUpdate = true;
    // Force material programs to rebuild so the shadow on/off change takes effect.
    this.scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) m.forEach((mm) => { mm.needsUpdate = true; });
      else m.needsUpdate = true;
    });
  }

  // ------------------------------------------------------------------
  // _effectivePixelRatio() / setRenderScale(scale)
  // ------------------------------------------------------------------
  // The number of real device pixels we draw per CSS pixel = the tier CAP clamped
  // to the device's devicePixelRatio, times the governor's adaptive SCALE. This is
  // the ONE place the two combine, used by the constructor, _onResize, and
  // setQualityTier so the headline pixel-ratio cost is always computed identically.
  // @private
  _effectivePixelRatio() {
    return Math.min(window.devicePixelRatio, this._pixelRatioCap) * this._renderScale;
  }

  // setRenderScale(scale): the adaptive-resolution governor's single live knob (driven
  // by Loop.js via the QualitySettings bridge). scale multiplies the tier pixel-ratio
  // cap, so it only ever scales the render resolution DOWN from the cap — never up,
  // never adding cost. Clamped to the active tier's renderScaleFloor. Idempotent: a
  // no-op when the scale is unchanged, so the governor can call it every frame for free
  // and only pays the render-target rebuild on an actual step.
  // @param {number} scale - 0..1 multiplier on the tier pixel-ratio cap.
  setRenderScale(scale) {
    const floor = qualitySettings.getConfig().renderScaleFloor || 0.6;
    const s = Math.max(floor, Math.min(1, scale));
    if (Math.abs(s - this._renderScale) < 0.001) return; // unchanged — skip the rebuild
    this._renderScale = s;
    // Rebuild the renderer + composer targets at the new effective pixel ratio.
    this._onResize();
  }

  // _isGradeFlat(): true when the grade pass is a pure pass-through — no tint, no
  // contrast/saturation push, no vignette, AND no MED+ effects (those run whenever
  // uBlurTaps>=2, so they only count as flat on LOW where uBlurTaps is 1). When this
  // holds and bloom + motion-blur are off, the whole composer chain is identity, so
  // rendering direct (renderer.render) is byte-IDENTICAL and skips an offscreen RT +
  // two fullscreen passes. The grade-flat condition is what keeps the LOW tier
  // byte-equivalent to today: a THEMED LOW race (which sets tint/vignette) keeps the
  // composer so its grade is preserved exactly; only flat contexts (menu) go direct.
  // @private
  _isGradeFlat() {
    const u = this._gradeUniforms;
    if (!u) return true;
    return u.uBlurTaps.value < 2.0 &&
      u.uTintAmount.value === 0 &&
      u.uContrast.value === 1 &&
      u.uSaturation.value === 1 &&
      u.uVignette.value === 0;
  }

  // _refreshRenderPath(): recompute whether render() can take the direct fast path
  // (skip the composer) this frame. True only when bloom is off, the afterimage trail
  // is off, and the grade is a no-op — i.e. the composer would produce a byte-identical
  // image at extra cost. Recomputed whenever any of those inputs change (setBloom,
  // setMotionBlur, _applyThemeForm, setQualityTier) — never per frame.
  // @private
  _refreshRenderPath() {
    this._directRender =
      !this._bloomPass.enabled &&
      !this._afterimagePass.enabled &&
      this._isGradeFlat();
  }

  // setThemeLighting(theme): match the sun/hemisphere brightness to the track
  // theme. Dark themes (Rainbow Road, Cosmic Speedway) live in a near-black void,
  // so bright daytime lights over-expose everything and the road catches a hot
  // specular streak that blooms to white — dim them so the scene reads as neon-
  // lit-by-its-own-glow. 'sky' is a daytime track but its pale road still pegs
  // white under the full menu sun, so it gets a slightly softened daylight.
  // Anything else (menu / 'oval' legacy) restores the full daytime levels.
  setThemeLighting(theme) {
    if (theme === 'rainbow' || theme === 'space') {
      // Drop the daylight HARDER (0.45 -> 0.32 sun, 0.35 -> 0.22 hemi) so the void
      // reads truly dark and the emissive neon owns the frame — the old levels
      // lifted the whole scene into a grey haze that washed out the glow. The neon
      // road/rails carry the brightness; the ambient just stops shadows going pure
      // black. Bloom pulled WAY down (0.42 -> 0.20): the old strong bloom blew the
      // rails + lines into a lurid neon haze that smeared over everything — a tighter
      // 0.20 lets the lines read as crisp light, MK8-clean, not a glow blowout.
      this.sun.intensity = 0.32;
      this.hemiLight.intensity = 0.22;
      // Cool the ground-bounce: a void has no warm earth below, so the default warm
      // brown (0x554433) was the last lever tinting downward-facing road UNDERSIDES
      // brown on elevated crossings. A cool-dark floor keeps undersides on-theme.
      this.hemiLight.groundColor.set(0x10131f);
      this.setBloom(0.2);
    } else if (theme === 'sky') {
      // Daytime, but the scene was pegging near-white. Trim the sun + hemi HARDER
      // and pull tone-mapping exposure down so the bright sky/road stop clipping to
      // white and regain real tonal separation (kart + road clearly readable).
      this.sun.intensity = 0.72;
      this.hemiLight.intensity = 0.42;
      this.hemiLight.groundColor.set(0x554433); // sky has real warm ground below
      this.setBloom(0.14);
      this.renderer.toneMappingExposure = 0.88; // pull the whole frame down from white
    } else {
      this.sun.intensity = this._daySun;
      this.hemiLight.intensity = this._dayHemi;
      this.hemiLight.groundColor.set(0x554433); // bright menu — warm daytime ground
      this.setBloom(0.22);
    }
    // Per-theme exposure: only the bright 'sky' theme needs the pull-down above;
    // every other theme renders at the neutral 1.0 (reset here so leaving sky for a
    // dark theme or the menu restores full exposure).
    if (theme !== 'sky') this.renderer.toneMappingExposure = 1.0;
    // Layer the cinematic form lights + per-theme color grade on top of the
    // dimming above. The key gives every theme a little extra modeling on the
    // karts; the fill's COLOR is the theme's signature hue so shadow sides pick
    // up a tinted rim that ties the karts to their world. The grade uniforms set
    // the per-theme tint/contrast/saturation/vignette the final ShaderPass uses.
    this._applyThemeForm(theme);
  }

  // _applyThemeForm(theme): set the key/fill form-light intensities + colors and
  // the color-grade uniforms for a theme. Pulled out of setThemeLighting so the
  // grade defaults live in ONE place. Safe before the grade pass exists (guards).
  // @private
  _applyThemeForm(theme) {
    if (theme === 'rainbow') {
      // Candied deep-space neon: a brighter modeling key, a magenta under-rim,
      // a magenta-leaning grade with punchy contrast + rich saturation.
      // Gentle rim only — these are FORM lights, not a second sun. The dark
      // themes already dim the sun to 0.45; a bright key/fill here over-lights
      // the (already bright, textured) neon road and blows the scene to white.
      this.keyLight.intensity = 0.22;
      this.fillLight.intensity = 0.18;
      this.fillLight.color.set(0xff4fd0); // magenta rim
      if (this._gradeUniforms) {
        this._gradeUniforms.uTint.value.set(0xffd8ff);
        this._gradeUniforms.uTintAmount.value = 0.12;
        // Pull contrast + saturation back toward natural (1.16/1.22 -> 1.08/1.10):
        // the high grade was over-juicing the already-neon scene into a lurid,
        // candy-blown look. A gentle lift keeps the candied colour readable and
        // vibrant without the saturation screaming.
        this._gradeUniforms.uContrast.value = 1.08;
        this._gradeUniforms.uSaturation.value = 1.1;
        this._gradeUniforms.uVignette.value = 0.42;
        // Candied edge fringe + cool-violet shadows / warm highlights split-tone.
        this._gradeUniforms.uCA.value = 1.0;
        this._gradeUniforms.uSplitTone.value = 0.22;
        this._gradeUniforms.uShadowTint.value.set(0xbcccff);
        this._gradeUniforms.uHighlightTint.value.set(0xffe2c8);
      }
    } else if (theme === 'space') {
      // Cold inky sci-fi: a cool key, a cyan rim, a blue-leaning grade with
      // crisp contrast and a slightly heavier vignette for the void.
      this.keyLight.intensity = 0.22;
      this.fillLight.intensity = 0.18;
      this.fillLight.color.set(0x33d6ff); // cyan rim
      if (this._gradeUniforms) {
        this._gradeUniforms.uTint.value.set(0xcfe6ff);
        this._gradeUniforms.uTintAmount.value = 0.16;
        // Pull contrast + saturation back toward natural (1.2/1.26 -> 1.1/1.12):
        // the inky void still keeps the blacks down via the vignette, but the old
        // high saturation made the cyan/magenta grid lurid. A gentler grade reads
        // cold and electric without the neon blowout.
        this._gradeUniforms.uContrast.value = 1.1;
        this._gradeUniforms.uSaturation.value = 1.12;
        this._gradeUniforms.uVignette.value = 0.48;
        // Strongest fringe (cold sci-fi optics) + cyan shadows / faintly warm highlights.
        this._gradeUniforms.uCA.value = 1.2;
        this._gradeUniforms.uSplitTone.value = 0.26;
        this._gradeUniforms.uShadowTint.value.set(0xaad4ff);
        this._gradeUniforms.uHighlightTint.value.set(0xfff0d2);
      }
    } else if (theme === 'sky') {
      // Soft warm dawn: a gentle key, a peach rim, a light warm grade with a
      // barely-there vignette so the bright scene stays open and airy.
      this.keyLight.intensity = 0.3;
      this.fillLight.intensity = 0.2;
      this.fillLight.color.set(0xffd9b0); // warm peach rim
      if (this._gradeUniforms) {
        this._gradeUniforms.uTint.value.set(0xfff0dc);
        this._gradeUniforms.uTintAmount.value = 0.08;
        // The flat daylight read PALE/washed — push contrast + saturation hard (now
        // near the dark-theme levels) and add a real vignette so sky/road/kart get
        // crisp separation and saturated colour instead of a white haze.
        this._gradeUniforms.uContrast.value = 1.22;
        this._gradeUniforms.uSaturation.value = 1.3;
        this._gradeUniforms.uVignette.value = 0.42;
        // Gentle fringe + cool shadows / warm-dawn highlights for the airy daytime look.
        this._gradeUniforms.uCA.value = 0.5;
        this._gradeUniforms.uSplitTone.value = 0.16;
        this._gradeUniforms.uShadowTint.value.set(0xcdddff);
        this._gradeUniforms.uHighlightTint.value.set(0xfff2da);
      }
    } else {
      // Menu / legacy: neutral form lights + an essentially flat grade so the
      // bright menu screens look clean and untinted.
      this.keyLight.intensity = this._dayKey;
      this.fillLight.intensity = this._dayFill;
      this.fillLight.color.set(0xbfd0ff);
      if (this._gradeUniforms) {
        this._gradeUniforms.uTint.value.set(0xffffff);
        this._gradeUniforms.uTintAmount.value = 0.0;
        this._gradeUniforms.uContrast.value = 1.0;
        this._gradeUniforms.uSaturation.value = 1.0;
        this._gradeUniforms.uVignette.value = 0.0;
        // Flat: no fringe, no split-tone (keeps the bright menu clean + lets the
        // LOW-tier direct-render fast path engage, since the grade is now a no-op).
        this._gradeUniforms.uCA.value = 0.0;
        this._gradeUniforms.uSplitTone.value = 0.0;
        this._gradeUniforms.uShadowTint.value.set(0xffffff);
        this._gradeUniforms.uHighlightTint.value.set(0xffffff);
      }
    }
    // The grade just changed from/to flat, which flips whether the composer is pure
    // overhead — re-check the composer-vs-direct fast path (see _refreshRenderPath).
    this._refreshRenderPath();
  }

  // ------------------------------------------------------------------
  // resetBackground()
  // ------------------------------------------------------------------
  // Restore the neutral menu sky + fog and the default look (bloom strength,
  // motion blur off). A track's applyTheme() overrides scene.background/fog with
  // its dark void so the neon bloom pops; when we leave a race (return to menu)
  // we call this so the menu isn't stuck on the previous track's void. Keeps the
  // menu/select/track screens on the original light-blue sky.
  resetBackground() {
    const skyColor = 0x87ceeb; // classic "sky blue" — matches the constructor
    this.scene.background = new THREE.Color(skyColor);
    this.scene.fog = new THREE.Fog(skyColor, 200, 800);
    // Return the post pipeline to its calm default so the bright menu sky isn't
    // over-bloomed and no speed trail lingers on the static menu.
    this.setBloom(0.22);
    this.setMotionBlur(false);
    // Restore full daytime lighting (a dark theme may have dimmed it) — this also
    // resets the form lights + the color-grade uniforms to their flat menu look.
    this.setThemeLighting('menu');
    // Kill any lingering sense-of-speed smear and reset the camera-feel state so
    // the menu lens is the calm idle FOV with no kick/shake carried over.
    if (this._gradeUniforms) this._gradeUniforms.uSpeed.value = 0;
    this._fov = this._fovIdle;
    this._fovKick = 0;
    this._camDip = 0;
    this._shake = 0;
    this._wasAirborne = false;
    this._fallVy = 0;
    this._prevBoost = 0;
    this._prevSpin = 0;
    this._prevOverdrive = 0;
    this._driftTier = 0;
    this._followYaw = undefined;
    // Forget the planted camera height so the next race snaps it to the start
    // height on its first frame instead of easing down from a stale value.
    this._camY = undefined;
    // Drop any anti-grav camera roll so the menu / next race starts world-up.
    this._agUp = null;
    this.camera.up.set(0, 1, 0);
    if (this.camera.fov !== this._fovIdle) {
      this.camera.fov = this._fovIdle;
      this.camera.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------------
  // _followSunShadow(state)
  // ------------------------------------------------------------------
  // Move the sun's SHADOW CAMERA so it stays centered on the player. We shift the
  // sun's POSITION and its TARGET by the SAME kart delta, so the light DIRECTION is
  // unchanged — all shading/specular looks identical, only the orthographic shadow
  // frustum (±70m, set in the constructor) re-frames around the kart. This is what
  // makes the tight, crisp shadow box actually cover the action on a long course.
  // Costs one transform write per frame and is gated on shadowMap.enabled, so it is
  // skipped entirely on LOW (where shadows — and this cost — are off).
  // @private
  _followSunShadow(state) {
    if (!state || !this.renderer.shadowMap.enabled) return;
    this.sun.target.position.set(state.x, state.y, state.z);
    this.sun.target.updateMatrixWorld();
    // Keep the original (100,150,100) sun OFFSET so the light direction — and thus
    // the whole scene's lighting balance — is exactly as it was tuned.
    this.sun.position.set(state.x + 100, state.y + 150, state.z + 100);
  }

  // ------------------------------------------------------------------
  // updateChaseCamera(state, dt)
  // ------------------------------------------------------------------
  // Smoothly follows the kart from behind, like a real Mario-Kart-style
  // third-person camera.
  //
  // Inputs:
  //   state = the kart STATE object: { x, y, z, heading, ... } (heading in radians)
  //   dt    = seconds since the last frame (used for frame-rate-independent smoothing)
  //
  // How it works each frame:
  //   1. Work out the kart's forward direction from its heading.
  //   2. Compute the IDEAL camera spot: behind the kart and a bit above it.
  //   3. Smoothly slide the camera toward that ideal spot (damping) instead of
  //      snapping, so the view feels weighty rather than glued rigidly.
  //   4. Aim the camera at a point slightly above the kart.
  updateChaseCamera(state, dt, trackId) {
    // Re-center the sun's tight shadow frustum over the player so the cast shadows
    // stay crisp and present wherever the kart is on the long course. Gated on the
    // shadow map being enabled, so this is ZERO cost on LOW (shadows off there).
    this._followSunShadow(state);

    // SPEED-SCALED RIG: as the kart approaches top speed the camera eases BACK and
    // UP a little — a longer, higher lens makes the scenery streak past harder and
    // gives a clearer read of the track rushing toward you (the arcade "this is
    // FAST" framing). speedN is normalized to ~0..1 against the same REF_SPEED the
    // lens FOV uses (kept local so the renderer stays decoupled from the physics).
    const speedN = Math.min(1, Math.max(0, state.speed || 0) / 38);
    // How far behind and how high above the kart the camera sits.
    const distance = 8 + 3 * speedN; // meters behind (8 idle -> 11 flat-out)
    const height = 4 + 0.7 * speedN; // meters up   (4 idle -> 4.7 flat-out)

    // ANTI-GRAV: inside a wall/ceiling section the camera ROLLS with the kart so the
    // world tilts/inverts with the corkscrew (the whole point of the effect). We sit
    // behind along the SURFACE forward and above along the SURFACE up, easing camera.up
    // toward that up so the roll is smooth, not a snap. Render-only; no parity impact.
    if (state && state.agSection >= 0 && trackId) {
      const fr = surfaceFrameAt(trackId, state.agS || 0, state.agLateral || 0);
      const ch = Math.cos(state.agHeading || 0), sh = Math.sin(state.agHeading || 0);
      let fx = fr.tangent.x * ch + fr.right.x * sh;
      let fy = fr.tangent.y * ch + fr.right.y * sh;
      let fz = fr.tangent.z * ch + fr.right.z * sh;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      // Ease a smoothed camera-up toward the surface up (low-pass like the planted _camY).
      if (!this._agUp) this._agUp = new THREE.Vector3(0, 1, 0);
      const aUp = 1 - Math.exp(-6 * dt);
      this._agUp.x += (fr.up.x - this._agUp.x) * aUp;
      this._agUp.y += (fr.up.y - this._agUp.y) * aUp;
      this._agUp.z += (fr.up.z - this._agUp.z) * aUp;
      this._agUp.normalize();
      this.camera.up.copy(this._agUp);
      const desiredX = state.x - fx * distance + this._agUp.x * height;
      const desiredY = state.y - fy * distance + this._agUp.y * height;
      const desiredZ = state.z - fz * distance + this._agUp.z * height;
      const alpha = 1 - Math.exp(-5 * dt);
      this.camera.position.x += (desiredX - this.camera.position.x) * alpha;
      this.camera.position.y += (desiredY - this.camera.position.y) * alpha;
      this.camera.position.z += (desiredZ - this.camera.position.z) * alpha;
      this.camera.lookAt(
        state.x + this._agUp.x * 1.5,
        state.y + this._agUp.y * 1.5,
        state.z + this._agUp.z * 1.5,
      );
      this._camY = state.y; // keep the planted height synced so leaving the section doesn't lurch
      this._followYaw = state.heading; // keep the damped follow-yaw warm so leaving AG doesn't snap
      return;
    }
    // Leaving an anti-grav section: ease camera.up back to world-Y so the world rolls
    // upright smoothly (roll is ~0 at the boundary, so this is a brief settle).
    if (this._agUp) {
      const aUp = 1 - Math.exp(-6 * dt);
      this._agUp.x += (0 - this._agUp.x) * aUp;
      this._agUp.y += (1 - this._agUp.y) * aUp;
      this._agUp.z += (0 - this._agUp.z) * aUp;
      this._agUp.normalize();
      if (Math.abs(this._agUp.x) < 0.002 && Math.abs(this._agUp.z) < 0.002) {
        this._agUp = null;
        this.camera.up.set(0, 1, 0);
      } else {
        this.camera.up.copy(this._agUp);
      }
    }

    // FOLLOW HEADING: which way the camera sits BEHIND the kart.
    // FORWARD VECTOR CONVENTION (kept in ONE obvious place — see project rules):
    // forward = (sin(heading), 0, cos(heading)). The kart drives along +forward.
    // Normally the follow direction IS the kart's heading. But in a DRIFT the kart
    // points hard into the slide while it actually travels more down-track — following
    // the raw heading would swing the whole view sideways with the slide. So while
    // drifting we bias the follow direction toward the kart's true TRAVEL direction so
    // the view stays pointed down-track and steady. We prefer state.velHeading (the
    // velocity heading, IF the sim exposes it); when it's absent we DEGRADE to a damped
    // yaw — a low-passed copy of the heading that lags the drift's fast heading swing.
    // Keep that damped yaw tracking the heading EVERY frame (shortest-angle low-pass)
    // so it's already warm the instant a drift begins.
    if (this._followYaw === undefined) this._followYaw = state.heading;
    let yawDelta = state.heading - this._followYaw;
    yawDelta -= Math.round(yawDelta / (2 * Math.PI)) * (2 * Math.PI); // wrap to [-PI, PI]
    this._followYaw += yawDelta * (1 - Math.exp(-7 * dt));

    let followHeading = state.heading;
    if (state.drifting) {
      const velH = state.velHeading;
      if (typeof velH === 'number' && Number.isFinite(velH)) {
        // Blend the locked heading halfway toward the real travel direction.
        let toVel = velH - state.heading;
        toVel -= Math.round(toVel / (2 * Math.PI)) * (2 * Math.PI); // shortest way round
        followHeading = state.heading + toVel * 0.5;
      } else {
        // No velocity heading exposed: the damped yaw lags the slide's heading swing.
        followHeading = this._followYaw;
      }
    }
    const forwardX = Math.sin(followHeading);
    const forwardZ = Math.cos(followHeading);

    // PLANTED CAMERA HEIGHT: low-pass the kart's ground height before we use it for
    // anything vertical. Raw state.y carries the kart's 60Hz suspension/terrain
    // micro-bob, and reading it every frame for the camera made the view jitter on
    // a flat road (a real car doesn't shake driving on a smooth road). Easing _camY
    // toward state.y at rate ~10 still tracks genuine hill elevation but filters out
    // that residual per-frame jitter, so a smooth road yields a dead-stable view.
    // First frame (or after a reset): _camY is undefined/NaN — snap it to avoid a
    // startup lurch from a stale height.
    const firstFrame = (this._camY === undefined || Number.isNaN(this._camY));
    if (firstFrame) {
      this._camY = state.y;
    } else {
      this._camY += (state.y - this._camY) * (1 - Math.exp(-10 * dt));
    }

    // Desired camera position = kart position
    //   minus forward * distance  (so we sit BEHIND the kart)
    //   plus up * height          (so we look down on it slightly)
    // Vertical uses the PLANTED height (_camY), not raw state.y, to kill the bob.
    const desiredX = state.x - forwardX * distance;
    const desiredY = this._camY + height;
    const desiredZ = state.z - forwardZ * distance;

    // Smoothing (damping): instead of jumping straight to the desired spot,
    // we move a FRACTION of the remaining distance each frame. We make that
    // fraction frame-rate-independent so the feel is identical at 30fps or
    // 144fps. A higher `responsiveness` = snappier camera.
    // Ease the follow OFF slightly at top speed (5 idle -> 4 flat-out): a looser
    // camera trails the kart a touch more when fast, which reads as weight + speed
    // rather than the view being rigidly glued to the kart.
    const responsiveness = 5 - speedN; // higher = follows more tightly
    // alpha is "how far to move toward the target this frame", 0..1.
    // The exponential form keeps it stable even if dt is large (e.g. lag spike).
    // FIRST FRAME of a race: SNAP to the ideal chase pose (and reset up) instead of
    // easing in from the stale menu-camera transform — that ease was the start-of-race
    // swoop/shake. Every later frame eases as before.
    if (firstFrame) {
      this.camera.position.set(desiredX, desiredY, desiredZ);
      this.camera.up.set(0, 1, 0);
    } else {
      const alpha = 1 - Math.exp(-responsiveness * dt);
      // Lerp (linear interpolate) each axis from current -> desired by alpha.
      this.camera.position.x += (desiredX - this.camera.position.x) * alpha;
      this.camera.position.y += (desiredY - this.camera.position.y) * alpha;
      this.camera.position.z += (desiredZ - this.camera.position.z) * alpha;
    }

    // Look at a point slightly ABOVE the kart so the kart sits a little low in
    // frame and we can see the track ahead — feels better than aiming at its base.
    // Aim uses the PLANTED height too, so the look target doesn't bob on a smooth
    // road (matching the planted camera position keeps the framing rock-steady).
    this.camera.lookAt(state.x, this._camY + 1.5, state.z);
  }

  // ------------------------------------------------------------------
  // applyCameraFeel(state, dt)
  // ------------------------------------------------------------------
  // Shape the LENS each frame off the player's live state so driving FEELS fast.
  // Call this ONCE per render frame, AFTER updateChaseCamera has positioned and
  // aimed the camera (so our shake jitter perturbs the final transform and our
  // FOV change is the last word on the projection). The main.js render loop wires
  // it in for every mode that has a player.
  //
  // What it does:
  //   1. SPEED FOV   — eases the field of view from idle (~60deg) toward the max
  //                    (~72deg) as the kart approaches top speed. A wider lens
  //                    streaks the scenery harder past the edges = more speed.
  //   2. BOOST KICK  — on the rising edge of boostTimer, punch in a few extra
  //                    degrees of FOV that then decay away, so a boost makes the
  //                    world lunge forward for a beat.
  //   3. LANDING SHAKE — on an airborne->grounded transition (landing after a
  //                    ramp), add a short camera shake scaled by the landing IMPACT
  //                    (downward speed at touchdown), so a big drop THUMPS and a
  //                    gentle touchdown barely shakes; a hard landing also lunges
  //                    the camera down for a beat.
  //   4. HIT SHAKE   — on the rising edge of spinTimer (a fresh hit/spin-out),
  //                    add a sharp shake so getting bonked is felt, not just seen.
  //   5. SENSE-OF-SPEED uniform — feed the normalized speed into the grade
  //                    shader's uSpeed so the radial blur + speed tunnel ramp up.
  //
  // Inputs:
  //   state = the player kart STATE: { speed, boostTimer, spinTimer, airborne } —
  //           any field may be missing; we default each to 0/false defensively.
  //   dt    = seconds since the last frame (frame-rate-independent easing/decay).
  //
  // @param {Object} state
  // @param {number} dt
  applyCameraFeel(state, dt) {
    if (!state) return;
    const d = dt || 0;

    // Reference speed used to NORMALIZE the kart's speed to ~0..1. We set it a bit
    // BELOW the base MAX_SPEED (44 m/s) so the effects peg near — not only AT — the
    // cap: cruising at ~38 already reads as flat-out, and a boost surge keeps it
    // pinned. Kept local so the renderer stays decoupled from the physics module.
    const REF_SPEED = 38;
    const speed = Math.max(0, state.speed || 0);
    // 0 at standstill -> 1 near (and beyond) top speed; clamp so a boost surge
    // doesn't overshoot the effects.
    const speedN = Math.min(1, speed / REF_SPEED);

    // Track the PEAK mini-turbo tier banked during the current charge. The sim zeroes
    // miniTurboTier the instant a boost arms, so the release frame alone can't see what
    // tier fired — we capture the peak across frames here and read it on the edge below.
    this._driftTier = Math.max(this._driftTier, state.miniTurboTier || 0);

    // --- 1. SPEED FOV target + 2. BOOST KICK ---------------------------------
    // Rising edge of boostTimer -> add the kick. We compare against last frame's
    // boost so HOLDING a boost doesn't keep re-adding (only the start punches in).
    const boost = state.boostTimer || 0;
    if (boost > this._prevBoost + 1e-3 && this._prevBoost <= 1e-3) {
      this._fovKick = this._fovBoostKick;
      this._camDip = 0.55; // lunge the camera down/forward for a beat on the surge
      // PURPLE MINI-TURBO LAUNCH (the biggest drift payoff): rumble the camera and
      // punch the FOV a little harder so the strongest boost is FELT, not just seen.
      // Blue/orange tiers get the standard kick above but no shake — only the biggest
      // surge rumbles, so the rumble stays a reward, not constant noise.
      if (this._driftTier >= 3) {
        this._shake = Math.max(this._shake, 0.22);
        this._fovKick = this._fovBoostKick * 1.25;
      }
      this._driftTier = 0; // charge cashed — reset the tracker for the next drift
    }
    this._prevBoost = boost;
    // OVERDRIVE activation (signature hook): spending a full meter is the game's
    // biggest moment — punch in the same FOV kick + camera dip as a boost on the
    // rising edge of overdriveTimer (independent of boostTimer, which it doesn't
    // set). Neutral: overdriveTimer stays 0 if never used, so no kick fires.
    const overdrive = state.overdriveTimer || 0;
    if (overdrive > this._prevOverdrive + 1e-3 && this._prevOverdrive <= 1e-3) {
      // Overdrive is the game's single biggest surge — give it the hardest punch +
      // rumble of all the speed events so spending a full meter lands with weight.
      this._fovKick = Math.max(this._fovKick, this._fovBoostKick * 1.25);
      this._camDip = Math.max(this._camDip, 0.6);
      this._shake = Math.max(this._shake, 0.28);
    }
    this._prevOverdrive = overdrive;
    // Decay the transient kick exponentially back to 0.
    this._fovKick += (0 - this._fovKick) * (1 - Math.exp(-6 * d));

    // Base FOV eases toward the speed-driven target; add the live boost kick. Ease
    // rate bumped 4 -> 6 so the lens opens up more promptly as you accelerate (the old
    // rate lagged enough that short bursts barely widened the lens before they ended).
    const fovTarget = this._fovIdle + (this._fovMax - this._fovIdle) * speedN;
    this._fov += (fovTarget - this._fov) * (1 - Math.exp(-6 * d));
    const finalFov = this._fov + this._fovKick;
    // Only touch the projection matrix when the FOV actually moved enough to
    // matter (avoids a per-frame matrix rebuild when sitting still).
    if (Math.abs(this.camera.fov - finalFov) > 0.01) {
      this.camera.fov = finalFov;
      this.camera.updateProjectionMatrix();
    }

    // --- 2b. BOOST DIP/SETTLE ------------------------------------------------
    // Apply the transient dip: drop the camera a touch and shove it FORWARD toward
    // the kart so the world rushes in on a boost, then let it spring back as the
    // dip decays. Cheap: a downward + along-heading nudge to the already-positioned
    // chase camera (we add it fresh each frame off the decaying magnitude so it
    // can't drift). forward = (sin h, 0, cos h) per the project convention.
    if (this._camDip > 0.001) {
      const fwdX = Math.sin(state.heading || 0);
      const fwdZ = Math.cos(state.heading || 0);
      const dip = this._camDip;
      this.camera.position.y -= dip * 0.9;     // sink toward the ground
      this.camera.position.x += fwdX * dip * 1.6; // close the gap to the kart
      this.camera.position.z += fwdZ * dip * 1.6;
      this._camDip *= Math.exp(-7 * d);        // spring back quickly
    } else {
      this._camDip = 0;
    }

    // --- 3. LANDING SHAKE + 4. HIT SHAKE -------------------------------------
    // Landing: airborne last frame, grounded now -> thump scaled by the IMPACT.
    // Impact = the kart's downward speed at touchdown: a big drop off a ramp/gap
    // falls fast and THUMPS, a gentle hop barely moves. The sim zeroes vy the
    // instant it lands, so we use _fallVy (the vy captured on the last airborne
    // frame). Normalize against ~18 m/s (a stout ramp/gap fall) so a big drop pegs
    // it and a soft touchdown stays near 0.
    const airborne = !!state.airborne;
    if (this._wasAirborne && !airborne) {
      const impact = Math.min(1, Math.abs(this._fallVy) / 18);
      this._shake = Math.max(this._shake, 0.10 + 0.32 * impact);
      // HARD landings only: jolt the camera down/forward for a beat (reusing the
      // boost dip lurch), gated above ~9 m/s of fall so gentle hops/glides never
      // trigger it and a smooth road stays dead-still. Decays fast via _camDip.
      if (impact > 0.5) this._camDip = Math.max(this._camDip, 0.35 * impact);
    }
    // Capture the airborne fall velocity so the landing frame can read the impact.
    if (airborne) this._fallVy = state.vy || 0;
    this._wasAirborne = airborne;
    // Hit: rising edge of spinTimer -> a sharp jolt. HIT JUICE: this is a REAL
    // spin-out (shell/banana/bomb), not a gentle wall bump (those never set
    // spinTimer), so we punch it HARDER than a landing thump (0.32 -> 0.55) to
    // make getting bonked land with weight. Smooth driving never sets spinTimer,
    // so this stays a dead-still camera on a clean road.
    const spin = state.spinTimer || 0;
    if (spin > 0.05 && this._prevSpin <= 0.05) {
      this._shake = Math.max(this._shake, 0.55);
    }
    this._prevSpin = spin;

    // --- 5. KART-KART CRASH thump --------------------------------------------
    // RaceManager flags _bumpImpact (0..1, render-only) on a kart-kart contact. A real
    // side-swipe/rear-end shakes the camera, and a hard hit also dips it; a graze barely
    // registers. One-shot: consume it so each impact fires exactly once.
    const bump = state._bumpImpact || 0;
    if (bump > 0) {
      this._shake = Math.max(this._shake, 0.08 + 0.30 * bump);
      if (bump > 0.5) this._camDip = Math.max(this._camDip, 0.30 * bump);
      state._bumpImpact = 0;
    }

    // Apply + decay the shake. We jitter the camera POSITION by a small random
    // offset each frame (magnitude = current shake), then bleed the magnitude
    // down fast so the shake is a brief punch, not a wobble. Because we add a
    // FRESH random offset every frame (not accumulate), there's no drift.
    if (this._shake > 0.0005) {
      const m = this._shake;
      // FRAME-RATE-CONSISTENT JITTER: a fresh random offset is added every frame, so
      // a higher frame rate would otherwise inject more total jitter energy per second
      // and read as a stronger/buzzier shake at 144fps than at 60fps. Normalize by
      // dt*60 (capped at 1) so the shake reads the same regardless of frame rate.
      // This does NOT change the shake TRIGGERS or magnitudes — only how the per-frame
      // random offset is scaled. The impact shake on real bumps stays exactly as tuned.
      const fpsNorm = Math.min(1, d * 60);
      this.camera.position.x += (Math.random() * 2 - 1) * m * fpsNorm;
      this.camera.position.y += (Math.random() * 2 - 1) * m * 0.7 * fpsNorm;
      this.camera.position.z += (Math.random() * 2 - 1) * m * fpsNorm;
      // Exponential decay (~halves every ~80ms) so the jolt settles quickly.
      this._shake *= Math.exp(-9 * d);
    } else {
      this._shake = 0;
    }

    // --- 5. SENSE-OF-SPEED grade uniform -------------------------------------
    // Ramp the radial-blur/speed-tunnel amount with speed, but keep it subtle at
    // cruising and only strong near top speed (square the curve so low speeds
    // barely smear). Smoothed so it doesn't pop on/off.
    if (this._gradeUniforms) {
      // Gentle ease-in (pow 1.5 rather than a hard square) so mid-speed cruising
      // ALREADY shows clear streaking, and top speed pegs the effect. A pure square
      // kept the smear near-invisible until almost top speed, which read as slow.
      const target = Math.pow(speedN, 1.5);
      const cur = this._gradeUniforms.uSpeed.value;
      this._gradeUniforms.uSpeed.value = cur + (target - cur) * (1 - Math.exp(-5 * d));
      // Advance the grade-pass clock so the MED+ film grain animates (the shader
      // ignores it on LOW). Cheap single float write; one wrap keeps it bounded.
      this._gradeUniforms.uTime.value = (this._gradeUniforms.uTime.value + d) % 1000;
    }
  }

  // Draw one frame. Normally we render THROUGH the composer so the scene gets the
  // full neon pipeline: RenderPass -> bloom -> (optional) motion blur -> grade ->
  // tone-mapped output. Callers just call render() once per frame exactly as before.
  //
  // FAST PATH: when the composer chain would be a pure pass-through (no bloom, no
  // afterimage trail, and a flat grade — see _refreshRenderPath), we render the scene
  // straight to the canvas instead. The renderer already has ACESFilmic tone mapping
  // + sRGB output set, so the direct image is byte-identical to RenderPass->OutputPass,
  // while skipping the offscreen render target + two fullscreen passes. In practice
  // this is the LOW tier's flat-grade contexts (e.g. the menu) — exactly where the
  // weakest GPUs most want one less full-screen pass.
  render() {
    if (this._directRender) {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.composer.render();
    }
  }
}
