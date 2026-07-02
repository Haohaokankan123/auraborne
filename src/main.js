// src/main.js
//
// Game bootstrap / MODE ROUTER.
//
// index.html loads THIS file as <script type="module" src="/src/main.js">.
//
// M1-M3 shipped a single-player Grand Prix (RaceManager). M4 added online
// multiplayer. M5 adds CHARACTER/KART SELECTION plus two new solo modes
// (TIME TRIAL and BATTLE). M6 adds CONTENT + POLISH on top of the finished game:
//   - TRACK SELECT: GRAND PRIX / TIME TRIAL let the player pick one of several
//     circuits ('circuit'/'oval'/'figure'); BATTLE keeps its own Arena (no pick).
//   - AUDIO: one synthesized Web-Audio AudioManager drives a speed-reactive
//     engine, looping music, and one-shot SFX (countdown, drift, boost, item,
//     hit, coin, finish). Unlocked on the first user gesture.
//   - MOBILE: the touch controls auto-enable on touch devices; we show them
//     during gameplay and hide them in menus.
//   - VFX: a pooled particle helper sprays boost flames, drift smoke, and a
//     finish-line confetti burst.
//
// main.js is the thin ROUTER between these states:
//
//   'menu'   -> the start screen (Menu.js). Four modes to pick from.
//   'select' -> the character/kart customization screen (CharacterSelect.js),
//               shown before GRAND PRIX / TIME TRIAL / BATTLE.
//   'track'  -> the track picker (TrackSelect.js), shown after select for the
//               circuit modes (GRAND PRIX / TIME TRIAL). BATTLE skips it.
//   'gp'     -> single-player Grand Prix: Track + RaceManager (player + 12 AI).
//   'tt'     -> Time Trial: Track + TimeTrial (solo vs a ghost).
//   'battle' -> Balloon Battle: Battle (self-builds its own Arena; no Track).
//   'mp'     -> multiplayer: SocketClient + Lobby, then Track + MultiplayerRace
//               once the server emits 'raceStart'.
//
// ONE GameLoop runs the whole time. Each fixed update(dt) / render(alpha) call
// dispatches to whichever manager is active. This keeps the two-clock model
// (fixed 60Hz sim, render-every-frame) identical across modes — see core/Loop.js.

// Import the stylesheet first. ui.css's first line is `@import "tailwindcss";`,
// so importing it here makes Tailwind utility classes (used by the HUD, Menu,
// Lobby, CharacterSelect, and TrackSelect) work and applies the base layout.
import './ui/ui.css';

// Core engine systems (shared across all modes).
import { Renderer } from './core/Renderer.js';
import { Input } from './core/Input.js';
import { DT, GameLoop } from './core/Loop.js';
// Graphics QUALITY tier singleton. Importing it initialises the one instance (and
// runs the lazy auto-detect default); the Renderer reads the active tier itself at
// construction, and the pause-menu slider routes live changes back through it.
import qualitySettings from './core/QualitySettings.js';
// Async glTF loader (reused as-is) for the optional real 3D kart skin (A/B).
import { AssetLoader } from './core/Loader.js';

// The procedural circuit (group + colliders + checkpoints + start pose). Built
// fresh whenever a circuit race begins. (Battle builds its own Arena instead.)
import { Track } from './entities/Track.js';
// Kart: only used here to register an optional shared 3D model (see kart skin).
import { Kart } from './entities/Kart.js';

// Pure theme helpers: per-theme bloom strength (the dark themes take more glow).
import { getTrackTheme, getThemeBloom } from '../shared/trackData.js';

// On-screen heads-up display (FPS + speed + race/battle panel).
import { HUD } from './ui/HUD.js';

// M6: synthesized audio + pooled particle VFX.
import { AudioManager } from './audio/AudioManager.js';
import { VFX } from './effects/VFX.js';
// Power-up VFX layer: boost trail + speed-lines, star aura, spin stars, pickup
// flash. Self-contained; reads kart state/positions and adds its own meshes.
import { ItemVFX } from './effects/ItemVFX.js';
// Item catalog: used only to look up the held item's tint for the pickup flash.
import { getItem } from './items/items.js';

// Persistent player stats / records (localStorage). We record race + cup wins,
// best laps, and lifetime totals from the existing finish + FX-edge hooks.
import { recordRaceWin, recordCupWin, recordBestLap, addTotals, addCoins } from './data/playerStats.js';

// Mode managers.
import { RaceManager } from './race/RaceManager.js';   // Grand Prix (player + 12 AI).
import { GrandPrixCup } from './race/GrandPrixCup.js';  // Cup championship (3 tracks, points).
import { TimeTrial } from './modes/TimeTrial.js';      // Solo time attack vs ghost.
import { Battle } from './modes/Battle.js';            // Balloon battle (self-builds Arena).
import { MultiplayerRace } from './modes/Multiplayer.js'; // Online race (M4).

// Screens.
import { Menu } from './ui/screens/Menu.js';
import { PauseMenu } from './ui/screens/PauseMenu.js'; // pause / settings overlay.
import { HowToPlay } from './ui/screens/HowToPlay.js'; // pre-race how-to overlay (all modes).
import { CharacterSelect } from './ui/screens/CharacterSelect.js';
import { TrackSelect } from './ui/screens/TrackSelect.js'; // M6 track picker.
import { ResultsScreen } from './ui/ResultsScreen.js'; // R11 end-of-race results board.
import { CoinShop } from './ui/screens/CoinShop.js'; // Coin shop: spend race coins on cosmetics.
import { DifficultySelect } from './ui/screens/DifficultySelect.js'; // R12 difficulty picker.
import { Lobby } from './ui/screens/Lobby.js';
import { CouchLobby } from './ui/screens/CouchLobby.js'; // COUCH/TV: QR-join lobby on the TV.
import { PlayTargetSelect } from './ui/screens/PlayTargetSelect.js'; // HERE / ON TV picker (every mode).
import { CouchOverlay } from './ui/CouchOverlay.js'; // COUCH/TV: split-screen panels + results on the TV.

// Multiplayer networking (M4).
import { SocketClient } from './net/SocketClient.js';
import { CouchInputHub } from './net/CouchInputHub.js'; // COUCH/TV: phone inputs relayed via the server.

// ----------------------------------------------------------------------------
// 1. Build the engine systems shared by every mode.
// ----------------------------------------------------------------------------

// The renderer creates and appends its own <canvas> to <body>, plus the scene,
// camera, and lights. Everything we want to see must be added to renderer.scene.
const renderer = new Renderer();

// Input reads the player's keyboard (and an optional gamepad / touch) once per
// step. One instance is reused by whichever mode is active. On touch devices it
// auto-enables on-screen controls; we additionally show/hide them on mode
// changes so they only appear during gameplay (see showTouch/hideTouch).
const input = new Input();

// HUD: FPS panel + speed readout + race/battle panel. Created once; every mode
// feeds it.
const hud = new HUD();

// M6 AUDIO: one synthesized audio system for the whole game. The AudioContext is
// created lazily on the first user gesture (browsers block audio before that),
// so we only unlock() it from the first menu click (see unlockAudioOnce).
const audio = new AudioManager();

// M6 VFX: one pooled particle helper bound to the render scene. Reused across
// every race (the pool sleeps when idle), so we build it once and never dispose
// it for the life of the page.
const vfx = new VFX(renderer.scene);

// POWER-UP VFX: a second pooled helper for the item/boost flourishes (boost
// exhaust trail + screen speed-lines, star rainbow aura + sparkles, spin stars on
// a hit, pickup flash). Like VFX it lives for the whole page and sleeps when idle.
// It reads kart positions/timers each frame from the active manager's getKarts()
// plus the player state, and adds only its OWN meshes to the scene.
const itemVfx = new ItemVFX(renderer.scene);

// ----------------------------------------------------------------------------
// 1b. KART SKIN (A/B): procedural neon kart vs. a real 3D model.
// ----------------------------------------------------------------------------
// The procedural kart is the SAFE DEFAULT — the game is unchanged until the
// player opts in via the pause/settings toggle. The pref is a localStorage
// string: 'procedural' (default) or a .glb filename in public/assets/models/
// (e.g. 'kart.glb', 'kart-future.glb'). When it names a .glb we preload it once
// and register it as the SHARED model so the whole field (player + AI + ghosts)
// uses it; on ANY failure we warn and fall back to procedural so the game always
// runs. loadModel() caches by url, so re-applying after a toggle is ~free.
const KART_SKIN_KEY = 'mk_kart_skin';
const assetLoader = new AssetLoader();
// KTX2 needs the GPU; harmless for these (un-compressed) models, but wiring it
// keeps any future .ktx2 kart working too.
assetLoader.setRenderer(renderer.renderer);

async function applyKartSkin() {
  const pref = localStorage.getItem(KART_SKIN_KEY) || 'procedural';
  if (pref === 'procedural') {
    Kart.setSharedModel(null);
    return;
  }
  try {
    // BASE_URL-relative so the .glb resolves under the deploy's base path (root on
    // the Node/Render host + local dev; the "/auraborne/" subpath on GitHub Pages).
    const scene = await assetLoader.loadModel(`${import.meta.env.BASE_URL}assets/models/${pref}`);
    Kart.setSharedModel(scene);
  } catch (err) {
    console.warn(`[kart-skin] failed to load "${pref}" — using the procedural kart.`, err);
    Kart.setSharedModel(null);
  }
}
// Apply the saved skin at startup. Fire-and-forget (not awaited) so the menu
// paints instantly; karts are only built once the player drives into a race,
// which is many seconds + clicks away — long after this resolves.
// ponytail: no startup await; a glb pref applies to the first race in practice.
applyKartSkin();

// ----------------------------------------------------------------------------
// 2. Router state.
// ----------------------------------------------------------------------------
// `mode`     : 'menu' | 'select' | 'track' | 'shop' | 'gp' | 'tt' | 'battle' | 'mp'.
// `manager`  : the active mode manager, or null when none is running.
// `track`    : the active Track instance, or null (Battle is null — owns its Arena).
// `raceClock`: monotonic sim-seconds for Grand Prix lap timing (one DT/tick).
// `selection`: the player's most recent CharacterSelect result, or null.
// `trackId`  : the player's most recent TrackSelect choice (default 'circuit').
// `pendingMode`: which mode the select/track screens will start ('gp'|'tt'|'battle').
// `socket`   : the multiplayer SocketClient (created on demand), or null.
// `lobby`    : the multiplayer Lobby overlay (created on demand), or null.
let mode = 'menu';
let manager = null;
let track = null;
let raceClock = 0;
let selection = null;
let trackId = 'circuit';
let pendingMode = null;
// R11: ensures the end-of-race results board shows exactly once per GP race.
let _resultsShown = false;
// Battle: ensures the end-of-battle results board shows exactly once per match.
let _battleResultsShown = false;
// R12: the player's most recent DifficultySelect choice. Defaults to 'medium' so
// a skipped picker still yields a balanced field.
let difficulty = 'medium';
// CUP: the active GrandPrixCup championship (3 tracks, accumulating points), or
// null for a normal single-race Grand Prix. When set, GP races chain through it.
let cup = null;
let socket = null;
let lobby = null;
let couchLobby = null; // COUCH/TV: the TV's QR-join lobby (separate from `lobby`).
let _offCouchStart = null; // COUCH/TV: unsubscribe for the persistent raceStart handler.
let _offCouchLeft = null;  // COUCH/TV: unsubscribe for the playerLeft (AI takeover) handler.
let _offCouchReconnect = null; // COUCH/TV: unsubscribe for the socket-reconnect re-announce.
// COUCH/TV: every mode offers a TV variant now (PlayTargetSelect). While the TV
// path is being configured/run:
//   tvSetup  — true from "PLAY ON TV" until returnToMenu, so the shared select
//              screens (track/difficulty) route into the QR lobby, not a solo boot.
//   tvConfig — the chosen game: { mode:'gp'|'tt'|'battle', trackId, difficulty, cup }.
//   couchHub — CouchInputHub: latest relayed input per phone (providerFor(id)).
//   couchOverlay — the TV's split-screen panels/countdown/results DOM layer.
let tvSetup = false;
let tvConfig = null;
let couchHub = null;
let couchOverlay = null;
let _couchStateAccum = 0; // ~10Hz 'couchState' emitter (phones' item slots / vibration)
// HOW-TO gate: true while the pre-race how-to overlay is up (see gateHowTo).
let _howToPending = false;
// Modes whose how-to has been auto-shown this session — so cup races 2/3, RACE
// AGAIN, and restarts don't re-pop the full modal (the menu button still shows it).
const _howToShownThisSession = new Set();

// M6 audio/VFX bookkeeping: per-frame edge detection state for one-shot SFX +
// effects. Reset each time a race starts (see resetFxState). We watch the
// PLAYER kart's state for rising edges (boost begins, mini-turbo tier climbs, a
// fresh spin-out hit, a new item in hand) and fire the matching sound/effect.
let _fx = null;            // edge-detection snapshot, or null when not racing
let _countdownTimers = []; // setTimeout handles for the start countdown beeps
let _audioUnlocked = false;
// Lifetime-totals accumulator for the CURRENT race ({ drifts, tricks, coins,
// longestCombo }). Incremented off the existing FX edges below and flushed ONCE
// to playerStats on teardown, so localStorage isn't written every frame.
let _sessionStats = null;

// The start menu. Its four buttons route into the select screen (GP/TT/Battle)
// or the multiplayer lobby. Built once; shown/hidden, never disposed.
const menu = new Menu({
  onGrandPrix: () => openSelect('gp'),
  onTimeTrial: () => openSelect('tt'),
  onBattle: () => openSelect('battle'),
  onMultiplayer: () => startMultiplayer(),
  onSettings: () => openOverlay('menu'), // ⚙ opens the volume panel (no race needed)
  onShop: () => openShop(),               // SHOP opens the coin shop (spend race coins)
});

// PLAY TARGET: the first question after picking any mode — HERE (solo, today's
// exact flow) or ON TV (QR lobby + phones as controllers, same rules/sim).
const playTargetSelect = new PlayTargetSelect({
  onHere: () => {
    tvSetup = false;
    playTargetSelect.hide();
    characterSelect.show();
    // mode stays 'select' — same state the old flow used for CharacterSelect.
  },
  onTV: () => {
    tvSetup = true;
    playTargetSelect.hide();
    if (pendingMode === 'battle') {
      // Battle has no track/difficulty to pick — straight to the QR lobby.
      startTvLobby();
    } else {
      // GP: track (+ CUP banner) then difficulty; TT: track only. Same screens
      // as solo — CharacterSelect is skipped (phones pick no character).
      trackSelect.show({ cup: pendingMode === 'gp' });
      mode = 'track';
      syncDebug();
    }
  },
  onBack: () => returnToMenu(),
});

// PAUSE / SETTINGS overlay. Reused for all three contexts (single-player pause,
// multiplayer settings, main-menu settings). The freeze itself lives in main.js
// (see `paused` + update()); the overlay only reports flow actions back here.
//   `paused`      : true while a SINGLE-PLAYER sim is frozen (gates update()).
//                   NEVER set in 'mp' — the server keeps simulating, so MP must
//                   not freeze.
//   `_overlayOpen`: whether the overlay is currently visible (drives Esc toggle).
let paused = false;
let _overlayOpen = false;
const pauseMenu = new PauseMenu({
  audio,
  onResume: () => closeOverlay(),
  onRestart: () => { closeOverlay(); restartCurrentMode(); },
  onQuit: () => { closeOverlay(); returnToMenu(); },
  // Re-open the How-to-Play overlay (controls + this mode's objective) on top of the
  // paused screen. Dismissing it (no-op onStart) just hides it again — the game stays
  // paused with the pause menu still underneath. mode = the live mode key.
  onHowTo: () => howToPlay.show(mode, () => {}),
  // Kart-style toggle wrote the pref; re-apply it so the NEXT race uses it.
  onKartSkin: () => applyKartSkin(),
  // Graphics-quality slider: live-apply the tier on the renderer (it also persists
  // via QualitySettings). pixel ratio / shadows / bloom change instantly; antialias
  // only takes effect on the next load (the menu shows that note).
  onQuality: (tier) => renderer.setQualityTier(tier),
});

// The character/kart customization screen. Built once; shown before a solo mode.
const characterSelect = new CharacterSelect({
  onConfirm: (sel) => onSelectionConfirmed(sel),
  onBack: () => returnToMenu(),
});

// M6: the track picker. Built once; shown after character select for the circuit
// modes (GP / TT). onConfirm boots the pending mode with the chosen track;
// onBack returns to the character-select screen.
const trackSelect = new TrackSelect({
  onConfirm: (id) => onTrackConfirmed(id),
  onCup: () => startCup(),
  onBack: () => {
    trackSelect.hide();
    // TV flow skipped CharacterSelect, so BACK returns to the HERE/TV picker.
    if (tvSetup) playTargetSelect.show(pendingMode);
    else characterSelect.show();
    mode = 'select';
    syncDebug();
  },
});

// R11: the end-of-race results board. Built once (hidden); shown when a GP race
// ends (manager.raceOver). Its buttons reuse the existing GP / track / menu paths.
const resultsScreen = new ResultsScreen();

// HOW-TO-PLAY overlay: shown before EVERY mode's gameplay (controls + this mode's
// objective). Built once (hidden); gateHowTo() shows it and the dismiss callback
// boots the race — see gateHowTo + the start* functions below.
const howToPlay = new HowToPlay();

// COIN SHOP: spend coins earned racing on cosmetics. Built once (hidden); opened
// from the menu's SHOP button. BACK returns to the menu (same path as Esc).
const coinShop = new CoinShop({
  onBack: () => returnToMenu(),
});

// R12: the difficulty picker, shown after track select on the Grand Prix path.
// onSelect boots GP with the chosen difficulty; onBack returns to the track picker.
const difficultySelect = new DifficultySelect({
  onSelect: (d) => onDifficultyConfirmed(d),
  onBack: () => {
    difficultySelect.hide();
    trackSelect.show({ cup: pendingMode === 'gp' });
    mode = 'track';
    syncDebug();
  },
});

menu.show(); // first thing the player sees

// ----------------------------------------------------------------------------
// 2b. AUDIO unlock — must happen inside a real user gesture.
// ----------------------------------------------------------------------------
// Browsers refuse to start an AudioContext until the user interacts with the
// page. We unlock on the FIRST pointer/key event anywhere, then start the
// background music. The engine drone is started per-race (see startRaceAudio).
function unlockAudioOnce() {
  if (_audioUnlocked) return;
  _audioUnlocked = audio.unlock();
  if (_audioUnlocked) {
    audio.startMusic();
  }
}
window.addEventListener('pointerdown', unlockAudioOnce);
window.addEventListener('keydown', unlockAudioOnce);

// Resume the context when the tab becomes visible again (browsers suspend audio
// for hidden tabs). No-op before unlock.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) audio.resume();
});

// ----------------------------------------------------------------------------
// 2c. Touch-control visibility helpers (mobile).
// ----------------------------------------------------------------------------
// Input auto-enables touch on touch devices in its constructor, but we only want
// the on-screen pad visible DURING gameplay, not over the menus. These wrap the
// Input touch API and no-op safely on non-touch devices (where this.touch null).
function showTouch() {
  if (input.touch) input.enableTouch(document.body);
}
function hideTouch() {
  if (input.touch) input.disableTouch();
}

// ----------------------------------------------------------------------------
// 3. Teardown helper — remove whatever mode is currently running.
// ----------------------------------------------------------------------------
function teardownMode() {
  // Flush this race's accumulated lifetime totals to the persistent player stats
  // ONCE (instead of a localStorage write every frame). Skip empty flushes.
  if (_sessionStats) {
    const t = _sessionStats;
    if (t.drifts || t.tricks || t.coins || t.longestCombo) addTotals(t);
    _sessionStats = null;
  }

  if (manager && typeof manager.dispose === 'function') {
    manager.dispose();
  }
  manager = null;

  // Remove the circuit track group (if any). Battle frees its Arena itself.
  if (track && track.group && track.group.parent) {
    track.group.parent.remove(track.group);
  }
  // Free the track's GPU resources (geometries, materials, the 1024² skybox + road
  // CanvasTextures, rail shaders). scene.remove() does NOT auto-dispose, so without
  // this every race/track-switch leaked them — a real Chromebook memory cliff.
  if (track && typeof track.dispose === 'function') track.dispose();
  track = null;

  raceClock = 0;

  // Stop the engine drone + clear any pending countdown beeps and FX state.
  stopRaceAudio();

  // Sleep all power-up effects and drop any anchor refs to the karts we're tearing
  // down, so a star aura / spin-stars from the old race don't linger into the next.
  itemVfx.reset();

  // Clear race-only HUD widgets that are driven per-frame by RaceManager.render so
  // they can't linger into the next mode: the minimap (would otherwise draw the OLD
  // track's loop over the flat Battle arena from a stale manager/track ref) and the
  // incoming-threat "!" badge (could stick if a race was exited mid-threat).
  if (typeof hud.setMinimapSource === 'function') hud.setMinimapSource(null);
  if (typeof hud.setIncomingThreat === 'function') hud.setIncomingThreat(null);
}

// ----------------------------------------------------------------------------
// 3b. Track-theme application (shared by every circuit mode).
// ----------------------------------------------------------------------------
// After a circuit Track's group is added to the scene, apply its THEME so the
// dark void skybox/fog/starfield take over from the Renderer's default sky, then
// tune the post pipeline for that theme: dark themes (rainbow/space) take more
// bloom, and we turn on a subtle motion blur for the speed feel. Reset on return
// to menu (see returnToMenu -> renderer.resetBackground()).
function applyTrackTheme(t) {
  if (!t || typeof t.applyTheme !== 'function') return;
  // applyTheme sets scene.background + scene.fog (dark void) and attaches the
  // starfield to track.group (so it's cleaned up when the group is removed).
  t.applyTheme(renderer.scene);
  // Per-theme bloom strength so the neon glow pops on the dark sky without
  // washing out the bright 'sky' theme.
  const theme = getTrackTheme(t.trackId).theme;
  renderer.setBloom(getThemeBloom(theme));
  // Match sun/hemisphere brightness to the theme: dark themes (rainbow/space)
  // dim to a neon-night look so the glowing rails carry the scene; 'sky' gets a
  // softened daylight so its pale road doesn't peg white.
  renderer.setThemeLighting(theme);
  // Subtle speed-streak motion blur during gameplay (off in menus).
  // Motion blur OFF: the AfterimagePass smears the bright textured neon road
  // into a hazy white-out. The post-FX sense-of-speed (radial blur driven by
  // uSpeed in the grade pass) gives the speed sensation instead, cleanly.
  renderer.setMotionBlur(false);
}

// ----------------------------------------------------------------------------
// 4. Character/kart selection flow (precedes GP / TT / BATTLE).
// ----------------------------------------------------------------------------
function openSelect(targetMode) {
  pendingMode = targetMode;
  menu.hide();
  // Every mode first asks WHERE to play: HERE (the classic solo flow) or ON TV.
  playTargetSelect.show(targetMode);
  mode = 'select';
  syncDebug();
}

// Open the COIN SHOP from the menu. Like the pre-race screens, Esc / BACK route
// back to the menu (mode !== 'menu' is handled by the keydown + onBack handlers).
function openShop() {
  menu.hide();
  coinShop.show();
  mode = 'shop';
  syncDebug();
}

// The player confirmed a build. Stash it. Circuit modes (GP/TT) go to the TRACK
// picker next; BATTLE skips straight into its Arena.
function onSelectionConfirmed(sel) {
  selection = sel; // { character, body, wheels, color, stats }
  characterSelect.hide();

  if (pendingMode === 'battle') {
    // Battle uses its own Arena — no track to pick.
    startBattle();
  } else {
    // GRAND PRIX / TIME TRIAL: pick a circuit first. Grand Prix also offers the
    // CUP banner (all 3 tracks); Time Trial doesn't.
    trackSelect.show({ cup: pendingMode === 'gp' });
    mode = 'track';
    syncDebug();
  }
}

// The player confirmed a SINGLE track. Boot the pending circuit mode with it.
// Picking a single track means "not a cup", so clear any pending cup choice.
function onTrackConfirmed(id) {
  trackId = id || 'circuit';
  cup = null;
  trackSelect.hide();

  if (pendingMode === 'tt') {
    if (tvSetup) startTvLobby();
    else startTimeTrial();
  } else {
    // GRAND PRIX: pick a difficulty before booting the race.
    difficultySelect.show();
    mode = 'difficulty';
    syncDebug();
  }
}

// The player clicked the GRAND PRIX CUP banner on the track picker. Arm a fresh
// championship, then pick a difficulty (same picker as a single GP) before race 1.
function startCup() {
  // TV cups keep the full points/standings machinery but must never write the
  // Mac owner's playerStats for a phone's finish (coins/trophies/tier unlocks).
  cup = new GrandPrixCup({ persistRewards: !tvSetup });
  cup.start();
  trackSelect.hide();
  difficultySelect.show();
  mode = 'difficulty';
  syncDebug();
}

// R12: the player confirmed a difficulty. Boot Grand Prix with it — or, if a cup
// is armed, start race 1 on the cup's first track (the chain continues in update).
function onDifficultyConfirmed(d) {
  difficulty = (d === 'easy' || d === 'hard') ? d : 'medium';
  difficultySelect.hide();
  if (cup) trackId = cup.currentTrack();
  if (tvSetup) startTvLobby();
  else startGrandPrix();
}

// ----------------------------------------------------------------------------
// 4b. HOW-TO-PLAY gate — show the per-mode overlay before any race boots.
// ----------------------------------------------------------------------------
// Each start* function calls this FIRST. On the first call it shows the overlay
// (freezing any lingering single-player sim behind it — never in MP, which the
// server keeps simulating) and returns true, so the caller bails immediately. The
// overlay's dismiss callback re-invokes that same start function; this time the
// pending flag is set, so we release the freeze and return false to let the race
// build (manager + countdown + showTouch all run AFTER dismiss, never before).
function gateHowTo(modeKey, boot) {
  if (_howToPending) {        // re-entered from the overlay's dismiss callback
    _howToPending = false;
    paused = false;           // release the hold; the fresh race is about to build
    return false;             // proceed
  }
  // Teach each mode only ONCE per session: cup races 2/3, RACE AGAIN, and restarts
  // must not re-interrupt with the full modal (the menu's HOW TO PLAY button still
  // opens it on demand). A fresh page load re-teaches once per mode.
  if (_howToShownThisSession.has(modeKey)) return false; // straight to boot
  _howToShownThisSession.add(modeKey);
  _howToPending = true;
  if (modeKey !== 'mp') paused = true; // hold any current sim still (MP must never freeze)
  howToPlay.show(modeKey, boot);
  return true;                // bail; boot() re-enters once dismissed
}

// ----------------------------------------------------------------------------
// 5. GRAND PRIX — the M1-M3 race, seeded with selection + chosen track.
// ----------------------------------------------------------------------------
function startGrandPrix() {
  if (gateHowTo('gp', startGrandPrix)) return; // how-to first; boots on dismiss
  teardownMode();
  _resultsShown = false; // re-arm the end-of-race results board for this race

  // Fresh track for the chosen circuit + the RaceManager (1 player + 12 AI).
  track = new Track(trackId);
  renderer.scene.add(track.group);
  applyTrackTheme(track); // dark void skybox + per-theme bloom + motion blur

  manager = new RaceManager(renderer.scene, track, input, {
    playerSelection: selection
      ? { stats: selection.stats, color: selection.color }
      : null,
    difficulty, // R12: 'easy'|'medium'|'hard' — scales AI skill; AI top speed always clamped <= player's
  });
  raceClock = 0;
  mode = 'gp';

  // MINIMAP: hand the HUD this circuit's live source (the manager's karts +
  // the track's checkpoint outline). One call per circuit race; the HUD reads
  // positions itself each update. If the HUD ignores it, this is a harmless no-op.
  if (typeof hud.setMinimapSource === 'function') {
    hud.setMinimapSource(manager, track);
  }

  audio.selectTrackMusic(trackId); // pick this track's music bed (theme-mapped)
  startRaceAudio();        // engine drone + countdown beeps
  resetFxState();          // arm edge detection for SFX/VFX
  showTouch();             // reveal the mobile pad during gameplay
  syncDebug();
}

// ----------------------------------------------------------------------------
// 6. TIME TRIAL — solo time attack vs a ghost, on the chosen track.
// ----------------------------------------------------------------------------
function startTimeTrial() {
  if (gateHowTo('tt', startTimeTrial)) return; // how-to first; boots on dismiss
  teardownMode();

  track = new Track(trackId);
  renderer.scene.add(track.group);
  applyTrackTheme(track); // dark void skybox + per-theme bloom + motion blur

  manager = new TimeTrial({
    scene: renderer.scene,
    track,
    renderer,
    input,
    hud,
    audio, // respawn chirp + new-record fanfare
    trackId, // M6: per-track ghost storage
    selection: selection
      ? { stats: selection.stats, color: selection.color }
      : {},
  });
  raceClock = 0;
  mode = 'tt';

  // MINIMAP: hand the HUD this circuit's live source (manager karts + track
  // checkpoint outline). One call per circuit race; the HUD reads it each update.
  if (typeof hud.setMinimapSource === 'function') {
    hud.setMinimapSource(manager, track);
  }

  audio.selectTrackMusic(trackId); // per-track music bed for the time trial
  startRaceAudio();
  resetFxState();
  showTouch();
  syncDebug();
}

// ----------------------------------------------------------------------------
// 7. BATTLE — balloon free-for-all. Battle self-builds its Arena (no Track).
// ----------------------------------------------------------------------------
function startBattle() {
  if (gateHowTo('battle', startBattle)) return; // how-to first; boots on dismiss
  teardownMode();
  _battleResultsShown = false; // re-arm the end-of-battle results board

  track = null;

  manager = new Battle({
    scene: renderer.scene,
    renderer,
    input,
    hud,
    audio, // balloon-pop SFX + final-10s countdown beeps
    vfx,   // win-confetti burst on a player victory
    selection: selection
      ? { stats: selection.stats, color: selection.color, name: selection.character && selection.character.name }
      : {},
    fieldSize: 8,
  });
  raceClock = 0;
  mode = 'battle';

  startRaceAudio();
  resetFxState();
  showTouch();
  syncDebug();
}

// ----------------------------------------------------------------------------
// 8. MULTIPLAYER — connect, show the lobby, then run the online race.
// ----------------------------------------------------------------------------
function startMultiplayer() {
  menu.hide();
  teardownMode();
  mode = 'mp';

  if (!socket) {
    socket = new SocketClient('');
  }
  socket.connect();

  // M6: tell the server which track we'd like (the host's choice is honoured;
  // non-hosts are ignored server-side). We send it once we've joined so the seat
  // exists. Safe to emit even for non-hosts — the server validates host-ness.
  if (typeof socket.onEvent === 'function') {
    const offJoined = socket.onEvent('joined', () => {
      offJoined(); // one-shot
      if (typeof socket.emit === 'function') {
        socket.emit('setTrack', { trackId });
      }
    });
  }

  if (lobby) {
    lobby.dispose();
    lobby = null;
  }
  lobby = new Lobby({
    socketClient: socket,
    onRaceStart: (payload) => beginMultiplayerRace(payload),
  });
  lobby.show();

  syncDebug();
}

// Build the Track + MultiplayerRace once the server says the race is starting.
function beginMultiplayerRace(payload) {
  // How-to first; the dismiss callback re-enters with the same payload. MP never
  // freezes (the server keeps simulating), so gateHowTo holds nothing for 'mp'.
  if (gateHowTo('mp', () => beginMultiplayerRace(payload))) return;
  if (lobby) {
    lobby.dispose();
    lobby = null;
  }

  teardownMode();

  // M6: the server tells us which track to build via payload.trackId. Track
  // resolves an unknown/missing id to 'circuit', so this is always safe.
  const mpTrackId = (payload && payload.trackId) || 'circuit';
  track = new Track(mpTrackId);
  renderer.scene.add(track.group);
  applyTrackTheme(track); // dark void skybox + per-theme bloom + motion blur

  manager = new MultiplayerRace({
    scene: renderer.scene,
    track,
    renderer,
    input,
    hud,
    socketClient: socket,
  });
  manager.start(payload);

  // MINIMAP: hand the HUD this circuit's live source (manager karts + track
  // checkpoint outline). One call per circuit race; the HUD reads it each update.
  if (typeof hud.setMinimapSource === 'function') {
    hud.setMinimapSource(manager, track);
  }

  if (socket && typeof socket.onEvent === 'function') {
    const off = socket.onEvent('raceEnd', () => {
      off(); // one-shot
      audio.sfxFinish(); // celebratory fanfare on the online race ending
      setTimeout(() => returnToMenu(), 6000);
    });
  }

  raceClock = 0;
  mode = 'mp';

  audio.selectTrackMusic(mpTrackId); // per-track bed for the online race
  startRaceAudio();
  resetFxState();
  showTouch();
  syncDebug();
}

// ----------------------------------------------------------------------------
// 8b. COUCH/TV — "PLAY ON TV" from any mode. The Mac (plugged into a TV) joins
// as a seat-less SCREEN for the QR lobby, then runs the SAME local sim the solo
// mode uses (RaceManager / Battle) with each phone's relayed input driving its
// own kart — identical rules/physics/AI by construction. The server only relays:
// phones' 'input' → 'couchInput' here; our 'couchState' → phones' 'snapshot'.
// ----------------------------------------------------------------------------
function startTvLobby() {
  teardownMode();
  mode = 'couch';
  tvConfig = {
    mode: pendingMode || 'gp',
    trackId: pendingMode === 'battle' ? null : trackId,
    difficulty,
    cup: !!cup,
  };

  if (!socket) socket = new SocketClient('');
  socket.connect();
  // Announce ourselves as the TV/screen (takes no kart slot). The server replies
  // 'joined' with the room id, which the lobby turns into a join QR.
  if (typeof socket.emit === 'function') socket.emit('joinScreen', {});

  // Phone-input hub: keeps the latest relayed input per phone; the sims read it
  // through providerFor(playerId) exactly like Input.getState().
  if (!couchHub) couchHub = new CouchInputHub(socket);

  // ONE persistent raceStart handler for the whole TV session: the first race,
  // cup races 2/3, and RACE AGAIN rematches all arrive through it.
  if (!_offCouchStart && typeof socket.onEvent === 'function') {
    _offCouchStart = socket.onEvent('raceStart', (payload) => beginTvRace(payload));
  }
  // If the TV socket drops and auto-reconnects (new socket.id), re-announce this
  // screen with its roomId so the server re-seats us on the SAME couch room —
  // without this the phone→TV relay goes permanently dead after any TV Wi-Fi blip.
  if (!_offCouchReconnect && typeof socket.onReconnect === 'function') {
    _offCouchReconnect = socket.onReconnect(() => {
      if (typeof socket.emit === 'function') socket.emit('joinScreen', { roomId: socket.roomId });
    });
  }
  // A phone dropped mid-race: its kart gets a local AI brain and the TV toasts it.
  if (!_offCouchLeft && typeof socket.onEvent === 'function') {
    _offCouchLeft = socket.onEvent('playerLeft', (payload) => {
      if (!payload || payload.playerId == null) return;
      if (manager && typeof manager.replaceWithAI === 'function') {
        manager.replaceWithAI(payload.playerId);
      }
      if (couchOverlay) {
        couchOverlay.toast((payload.name || 'A player') + ' left — AI took over');
      }
    });
  }

  if (couchLobby) { couchLobby.dispose(); couchLobby = null; }
  couchLobby = new CouchLobby({ socketClient: socket, config: tvConfig });
  couchLobby.show();

  syncDebug();
}

// Boot the local sim once the server broadcasts 'raceStart' (host pressed START).
// payload: { mode, trackId, difficulty, cup, players:[{id,name,color}] }.
function beginTvRace(payload) {
  if (couchLobby) { couchLobby.dispose(); couchLobby = null; }
  teardownMode();
  _resultsShown = false;
  _battleResultsShown = false;

  const cfg = tvConfig || {};
  const tvGame = (payload && payload.mode) || cfg.mode || 'gp';
  const players = (payload && payload.players) || [];
  const humans = players.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    inputProvider: couchHub.providerFor(p.id),
  }));
  // "+ KEYBOARD PLAYER": the person at the TV races too, on the real Input.
  // Remember the choice on tvConfig so RACE AGAIN keeps the keyboard kart.
  if (payload && payload.kb) cfg.kb = true;
  if (cfg.kb) {
    humans.push({
      id: 'kb',
      name: 'KEYBOARD',
      color: 0xff3b30, // the classic player red
      inputProvider: { getState: () => input.getState() },
    });
  }
  if (!humans.length) return; // nothing to race (shouldn't happen — server gates)

  // Split-screen draws the scene 2-4x, so drop the per-frame cost: shadows off
  // (also no-ops the "sun follows one kart" thrash across quadrants).
  if (typeof renderer.setCouchMode === 'function') renderer.setCouchMode(true);
  // Hide the single-player HUD — each quadrant gets its own CouchOverlay panel.
  if (hud && hud.element) hud.element.style.display = 'none';

  if (tvGame === 'battle') {
    // SAME Battle class as solo (identical rules); phones are just harder to
    // aim with, so the TV passes the reduced AI intensity (20-40 pops target).
    // No renderer/hud/input: the split-screen rig + CouchOverlay own the TV's
    // cameras and panels, and every kart is phone- or bot-driven.
    track = null;
    manager = new Battle({
      scene: renderer.scene,
      audio,
      vfx,
      humans,
      // Couch/TV is gentler AND shorter than solo battle: phones are harder to
      // aim, so bots ease off (AI_INTENSITY 0.5) and the match is 4 min not 6,
      // landing each AI's pops in the 20-40 band (measured in tune-battle.mjs).
      tuning: { AI_INTENSITY: 0.5, TIME_LIMIT: 240 },
      fieldSize: 8,
    });
  } else {
    const tvTrackId = (payload && payload.trackId) || cfg.trackId || 'circuit';
    track = new Track(tvTrackId);
    renderer.scene.add(track.group);
    applyTrackTheme(track); // dark void skybox + per-theme bloom
    manager = new RaceManager(renderer.scene, track, input, {
      humans,
      difficulty: (payload && payload.difficulty) || cfg.difficulty || difficulty,
      // TT on TV = the same race sim with no AI/items/contact: N humans racing
      // the clock on identical physics + laps (solo TimeTrial semantics).
      ...(tvGame === 'tt' ? { aiCount: 0, noItems: true, noContact: true } : {}),
    });
    audio.selectTrackMusic(tvTrackId);
  }

  if (couchOverlay) { couchOverlay.dispose(); couchOverlay = null; }
  couchOverlay = new CouchOverlay();
  couchOverlay.setPlayers(players.map((p) => ({ id: p.id, name: p.name, color: p.color })));

  raceClock = 0;
  _couchStateAccum = 0;
  mode = 'couch';

  startRaceAudio(); // countdown beeps + release() at GO — same as a solo race
  resetFxState();
  syncDebug();
}

// TV RACE AGAIN / next cup race: the phones stay connected, so emitting 'start'
// makes the server rebroadcast 'raceStart' and the persistent handler rebuilds a
// fresh local sim for the same crew.
function couchPlayAgain() {
  if (socket && typeof socket.emit === 'function' && tvConfig) {
    socket.emit('start', {
      mode: tvConfig.mode,
      trackId: tvConfig.trackId,
      difficulty: tvConfig.difficulty,
      cup: !!cup,
      kb: !!tvConfig.kb,
    });
  }
}

// The TV race/battle just ended: notify the phones (finish screen + lobby
// reopens server-side), then show the right board — cup standings/champion via
// the shared ResultsScreen, single races/battles via the overlay's board.
function endTvRace(results) {
  const rows = Array.isArray(results) ? results : [];
  if (socket && typeof socket.emit === 'function') {
    // `pos` (not `place`): the phones' existing raceEnd handler reads me.pos.
    socket.emit('couchEnd', {
      results: rows.map((r, i) => ({
        id: r.id,
        pos: r.place != null ? r.place : i + 1,
        name: r.name,
      })),
    });
  }
  audio.sfxFinish();

  if (cup && tvConfig && tvConfig.mode === 'gp') {
    cup.recordRaceResults(rows);
    if (!cup.isComplete()) {
      resultsScreen.showCupStandings(cup, {
        onNext: () => {
          resultsScreen.hide();
          cup.nextRace();
          trackId = cup.currentTrack();
          tvConfig.trackId = trackId;
          couchPlayAgain(); // 'start' → 'raceStart' → beginTvRace on the next track
        },
        onMenu: () => { resultsScreen.hide(); returnToMenu(); },
      });
    } else {
      resultsScreen.showCupChampion(cup, {
        onRestartCup: () => {
          resultsScreen.hide();
          cup.start();
          trackId = cup.currentTrack();
          tvConfig.trackId = trackId;
          couchPlayAgain();
        },
        onMenu: () => { resultsScreen.hide(); returnToMenu(); },
      });
    }
    return;
  }

  if (couchOverlay) {
    couchOverlay.showResults(
      rows.map((r, i) => ({
        place: r.place != null ? r.place : i + 1,
        name: r.name,
        color: r.color,
        isHuman: r.isPlayer != null ? !!r.isPlayer : !!r.isHuman,
        time: r.time,
        score: r.score,
        balloons: r.balloons,
      })),
      {
        onPlayAgain: () => { couchOverlay.hideResults(); couchPlayAgain(); },
        onExit: () => returnToMenu(),
      }
    );
  }
}

// ~10Hz 'couchState' → the server re-emits it verbatim as 'snapshot' to the
// phones, whose controller UI (item slots, position, hit vibration) is unchanged
// from the server-sim era.
function emitCouchState(dt) {
  _couchStateAccum += dt;
  if (_couchStateAccum < 0.1) return;
  _couchStateAccum = 0;
  if (!socket || typeof socket.emit !== 'function' || !manager) return;

  const karts = [];
  if (manager.lapSystem && typeof manager.getHumanViews === 'function') {
    // Racing (GP/TT): position + lap + item slots + spin per HUMAN kart.
    const standings = manager.lapSystem.getStandings();
    const rank = {};
    for (let i = 0; i < standings.length; i++) rank[standings[i].id] = i + 1;
    for (const v of manager.getHumanViews(0)) {
      const racer = manager.getRacer(v.id);
      if (!racer) continue;
      const prog = manager.lapSystem.getProgress(v.id);
      karts.push({
        id: v.id,
        pos: rank[v.id] || null,
        lap: prog ? Math.min((prog.lap || 0) + 1, manager.totalLaps) : 1,
        slots: manager.itemSystem && manager.itemSystem.hasItem(v.id)
          ? manager.itemSystem.getSlots(v.id) : [],
        spinTimer: racer.state.spinTimer || 0,
      });
    }
  } else if (typeof manager.getCouchInfo === 'function') {
    // Battle: balloons + score per human (Battle exposes getCouchInfo).
    for (const row of manager.getCouchInfo()) karts.push(row);
  }
  if (karts.length) socket.emit('couchState', { karts });
}

// Per-paint view model for the TV overlay panels + leaderboard + battle clock.
function buildOverlayFrame(alpha) {
  const views = [];
  let leaderboard = null;
  let timeLeft = null;
  const isTT = tvConfig && tvConfig.mode === 'tt';

  if (manager.lapSystem && typeof manager.getHumanViews === 'function') {
    const standings = manager.lapSystem.getStandings();
    const rank = {};
    for (let i = 0; i < standings.length; i++) rank[standings[i].id] = i + 1;
    for (const v of manager.getHumanViews(alpha)) {
      const prog = manager.lapSystem.getProgress(v.id);
      views.push({
        id: v.id,
        name: v.name,
        color: v.color,
        info: {
          pos: isTT ? null : (rank[v.id] || null),
          totalRacers: manager.fieldSize,
          lap: prog ? Math.min((prog.lap || 0) + 1, manager.totalLaps) : 1,
          totalLaps: manager.totalLaps,
          slots: manager.itemSystem && manager.itemSystem.hasItem(v.id)
            ? manager.itemSystem.getSlots(v.id) : null,
          balloons: null,
          score: null,
          lapTime: prog ? raceClock - prog.lapStart : 0,
        },
      });
    }
    if (!isTT) {
      leaderboard = standings.map((s, i) => {
        const r = manager.getRacer(s.id);
        return { id: s.id, name: r ? r.name : s.id, color: r ? r.color : 0xffffff, place: i + 1 };
      });
    }
  } else if (typeof manager.getCouchFrame === 'function') {
    // Battle: the manager builds its own frame (balloons/score/clock).
    return manager.getCouchFrame(alpha);
  }
  return { views, leaderboard, timeLeft };
}

// ----------------------------------------------------------------------------
// 9. Return-to-menu path (Esc during a mode, BACK on select, or after MP ends).
// ----------------------------------------------------------------------------
function returnToMenu() {
  teardownMode();

  // Restore the neutral menu sky + calm post pipeline. A circuit track's
  // applyTheme() overrode scene.background/fog with its dark void and bumped the
  // bloom + turned on motion blur; reset so the menu isn't stuck on that look.
  // (Battle already restores the background it saved in its own dispose(), but
  // calling this is harmless and also resets bloom/motion-blur after a battle.)
  if (typeof renderer.resetBackground === 'function') {
    renderer.resetBackground();
  }

  // Drop any select / track / difficulty / shop / lobby overlays so they can't intercept input.
  characterSelect.hide();
  trackSelect.hide();
  difficultySelect.hide();
  coinShop.hide();
  // Also drop the results/cup/champion board: Esc over a finished race routes here
  // (mode is still 'gp', raceOver is true), and the board is z-40 above the z-30
  // menu — without this it stays stuck on top, and its stale onRestartCup handler
  // would call cup.start() on the now-null cup. Safe no-op when already hidden.
  resultsScreen.hide();
  if (lobby) {
    lobby.dispose();
    lobby = null;
  }
  // COUCH/TV: drop the QR lobby, the HERE/TV picker, the overlay, the input hub,
  // and the persistent handlers; restore normal (non-split-screen) rendering.
  playTargetSelect.hide();
  if (couchLobby) {
    couchLobby.dispose();
    couchLobby = null;
  }
  if (couchOverlay) { couchOverlay.dispose(); couchOverlay = null; }
  if (couchHub) { couchHub.dispose(); couchHub = null; }
  if (_offCouchStart) { _offCouchStart(); _offCouchStart = null; }
  if (_offCouchLeft) { _offCouchLeft(); _offCouchLeft = null; }
  if (_offCouchReconnect) { _offCouchReconnect(); _offCouchReconnect = null; }
  tvSetup = false;
  tvConfig = null;
  if (typeof renderer.setCouchMode === 'function') renderer.setCouchMode(false);
  // Restore the single-player HUD hidden while in couch mode.
  if (hud && hud.element) hud.element.style.display = '';
  if (socket && typeof socket.disconnect === 'function') {
    socket.disconnect();
  }

  hideTouch(); // tuck the mobile pad away over the menus

  // Make sure no pause/settings overlay (and no leftover freeze) survives the
  // return to the menu, whatever path got us here (Quit, MP raceEnd, results).
  _overlayOpen = false;
  paused = false;
  pauseMenu.hide();

  // Clear any cup championship so its standings/points can't leak into the next
  // session (a fresh cup is armed only by the track-picker's CUP banner).
  cup = null;

  pendingMode = null;
  mode = 'menu';
  menu.show();
  syncDebug();
}

// ----------------------------------------------------------------------------
// 9b. PAUSE / SETTINGS overlay control (Esc or P).
// ----------------------------------------------------------------------------
// Open the overlay for a context. 'pause' FREEZES the single-player sim (sets
// `paused`, which update() honours); 'mp' and 'menu' do NOT freeze (the MP server
// keeps simulating; the menu has nothing to freeze).
function openOverlay(context) {
  if (_overlayOpen) return;
  _overlayOpen = true;
  if (context === 'pause') paused = true; // freeze the local sim — SINGLE-PLAYER only
  pauseMenu.show({ context });
}

// Close the overlay and ALWAYS clear the freeze, so Esc can never leave the sim
// stuck paused. Safe to call when nothing is open.
function closeOverlay() {
  if (!_overlayOpen && !paused) return;
  _overlayOpen = false;
  paused = false;
  pauseMenu.hide();
}

// Re-boot whichever single-player race is active (RESTART button).
function restartCurrentMode() {
  if (mode === 'gp') startGrandPrix();
  else if (mode === 'tt') startTimeTrial();
  else if (mode === 'battle') startBattle();
  else if (mode === 'couch') couchPlayAgain(); // fresh 'start' → server rebroadcasts raceStart
}

// Toggle the pause-or-settings overlay for a LIVE race. Shared by the keyboard
// (Esc/P) and the on-screen touch ⏸ button so both behave identically. Returns
// true if it handled the input (opened/closed an overlay), false otherwise.
function toggleRacePause() {
  if (howToPlay && howToPlay._active) return true; // How-To owns input; swallow.
  // An open overlay closes first (works in every context, including the menu ⚙).
  if (_overlayOpen) { closeOverlay(); return true; }
  // A LIVE single-player race -> freezing pause. raceOver/finished guard so a tap
  // over the results board doesn't pop a pause menu. COUCH/TV runs the same LOCAL
  // sim, so it pauses the same way (phones just stall until resume).
  const inSoloRace = (mode === 'gp' || mode === 'tt' || mode === 'battle' || mode === 'couch')
    && manager && !manager.raceOver && !manager.finished;
  // A LIVE multiplayer race (manager exists = past the lobby) -> non-freezing panel.
  const inMpRace = mode === 'mp' && manager;
  if (inSoloRace || inMpRace) {
    openOverlay(mode === 'mp' ? 'mp' : 'pause');
    return true;
  }
  return false;
}

// Esc / P: toggle the pause-or-settings overlay during a race; otherwise Esc
// backs out of pre-race screens to the menu (the original behaviour).
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' && e.key !== 'p' && e.key !== 'P') return;
  if (howToPlay && howToPlay._active) return; // How-To-Play owns input; don't mutate pause/_overlayOpen behind it
  if (e.repeat) return; // ignore auto-repeat while held, else it double-toggles the pause overlay

  if (toggleRacePause()) return;
  // TV lobby (QR screen up, no race yet): Esc backs out to the menu below.

  // Pre-race screens (select/track/difficulty/lobby): Esc returns to the menu.
  if (e.key === 'Escape' && mode !== 'menu') {
    returnToMenu();
  }
});

// On-screen touch ⏸ (phones have no keyboard): same pause path as Esc/P.
window.addEventListener('touchpause', () => { toggleRacePause(); });

// ----------------------------------------------------------------------------
// 10. AUDIO + VFX glue (central hooks; the smallest number of spots).
// ----------------------------------------------------------------------------

// Begin per-race audio: start the engine drone (if unlocked) and play the
// 3-2-1-GO countdown beeps. Safe to call when audio is locked (all no-ops).
function startRaceAudio() {
  audio.setFinalLap(false); // clear any leftover final-lap tension from a prior race
  if (_audioUnlocked) {
    audio.startEngine();
  }
  // Schedule the countdown beeps even if locked — the calls no-op until unlock,
  // and in practice the menu click already unlocked audio before we get here.
  clearCountdown();
  // R11: drive the visual 3-2-1-GO overlay in lockstep with the beeps, and RELEASE
  // the start lock at GO so the frozen grid launches together (no start pile-up).
  // typeof guards keep this a safe no-op for TT/Battle/MP (only RaceManager defines release()).
  _countdownTimers.push(setTimeout(() => { audio.sfxCountdown(3); showRaceCountdown(3); }, 0));
  _countdownTimers.push(setTimeout(() => { audio.sfxCountdown(2); showRaceCountdown(2); }, 700));
  _countdownTimers.push(setTimeout(() => { audio.sfxCountdown(1); showRaceCountdown(1); }, 1400));
  _countdownTimers.push(setTimeout(() => {
    audio.sfxCountdown(0);
    showRaceCountdown(0);
    if (manager && typeof manager.release === 'function') manager.release();
  }, 2100));
}

// Drive the visual 3-2-1-GO countdown for the active mode. The single-player HUD
// owns it normally; COUCH mode hides the HUD, so the TV's split-screen gets its own
// big centered countdown from the CouchOverlay instead.
function showRaceCountdown(n) {
  if (mode === 'couch') {
    if (couchOverlay) couchOverlay.showCountdown(n === 0 ? 'GO!' : String(n));
  } else if (typeof hud.showCountdown === 'function') {
    hud.showCountdown(n);
  }
}

// Stop the engine drone and cancel any pending countdown beeps. Music keeps
// playing across modes (it's ambient), so we leave it running.
function stopRaceAudio() {
  audio.stopEngine();
  clearCountdown();
  _fx = null;
}

function clearCountdown() {
  for (const t of _countdownTimers) clearTimeout(t);
  _countdownTimers = [];
}

// Arm a fresh edge-detection snapshot from the current player state so the first
// race frame doesn't spuriously fire SFX. Fields read: boostTimer, miniTurboTier,
// spinTimer, and the held item id.
function resetFxState() {
  const ps = getPlayerState();
  _fx = {
    prevBoost: ps ? (ps.boostTimer || 0) : 0,
    prevTier: ps ? (ps.miniTurboTier || 0) : 0,
    prevSpin: ps ? (ps.spinTimer || 0) : 0,
    prevItem: getPlayerItem(),
    prevFinished: false,
    prevFinalLap: false, // armed for the final-lap music-tension edge
    prevThreat: false, // armed for the incoming-projectile danger cue edge
    smokeAccum: 0, // throttles drift-smoke puffs so we don't spam the pool
    prevOverdrive: ps ? (ps.overdriveTimer || 0) : 0, // armed for the overdrive-activation roar
    prevTrickActive: false, // armed for the air-trick whoosh edge
    prevCoins: ps ? (ps.coins || 0) : 0, // armed for the coins-collected stat edge
    prevBump: 0, // armed for the kart-kart crash thud edge (RaceManager sets state._bumpImpact)
    prevDrifting: false, // armed for the drift-screech start/stop edges
    prevLap: 0, // armed for the per-lap chime (rising edge of completed laps)
  };
  // Fresh per-race totals accumulator (flushed to playerStats on teardown).
  _sessionStats = { drifts: 0, tricks: 0, coins: 0, longestCombo: 0 };
}

// The active player's kart state, surfaced uniformly across modes (mirrors
// syncDebug's logic). Returns null in menu/select/track or before a manager has
// a player.
function getPlayerState() {
  if (!manager) return null;
  if (mode === 'mp') {
    return manager.predictor ? manager.predictor.state : null;
  }
  if (typeof manager.getPlayer === 'function') {
    const p = manager.getPlayer();
    return p ? p.state : null;
  }
  return null;
}

// The player's currently-held item id ('' if none / not applicable). Only the
// single-player RaceManager exposes getPlayerItem(); other modes return ''.
function getPlayerItem() {
  if (manager && typeof manager.getPlayerItem === 'function') {
    return manager.getPlayerItem() || '';
  }
  return '';
}

// The live kart records for the active mode (manager.getKarts()), or null. The
// ItemVFX layer reads positions/timers off these to paint boost trails, star
// auras, and spin-stars for EVERY kart on screen (not just the player). Modes
// that don't expose getKarts() (e.g. some non-race states) yield null, and
// ItemVFX simply skips the per-kart pass that frame.
function getKartsList() {
  if (manager && typeof manager.getKarts === 'function') {
    return manager.getKarts();
  }
  return null;
}

// Spatial cue helper for a world-space event (an item blast / impact). Returns
// { pan, near }: `pan` (-1..1) places the sound in the stereo field by projecting
// the event's offset-from-player onto the CAMERA'S right axis (so a blast to the
// player's right pans right, regardless of which way they face); `near` (0..1) is
// a distance falloff so far-off events are quiet, not as loud as ones underfoot.
// Returns a centered/full cue if there's no player or camera (always safe).
function _spatialFor(ex, ez) {
  const ps = getPlayerState();
  const cam = renderer.camera;
  if (!ps || !cam || typeof ex !== 'number' || typeof ez !== 'number') {
    return { pan: 0, near: 1 };
  }
  const dx = ex - ps.x;
  const dz = ez - ps.z;
  const dist = Math.hypot(dx, dz);
  // Camera's world +X axis (first column of its world matrix), flattened to the
  // ground plane — the "screen right" direction we pan along.
  const e = cam.matrixWorld.elements;
  const rx = e[0];
  const rz = e[2];
  const rlen = Math.hypot(rx, rz) || 1;
  const pan = Math.max(-1, Math.min(1, (dx * rx + dz * rz) / (rlen * Math.max(dist, 1))));
  const near = Math.max(0, 1 - dist / 60); // silent past ~60 units
  return { pan, near };
}

// Per-frame audio + VFX update for the active race. Drives the engine pitch from
// speed, advances the particle pool, and fires one-shot SFX/effects on edges.
function updateAudioVfx() {
  // Advance the particle pool every frame regardless of mode (cheap when idle),
  // billboarding toward the camera so flat planes always read as particles.
  vfx.update(DT, renderer.camera);

  // POWER-UP VFX: drive the item/boost flourishes from the live kart records +
  // the player state. Runs every frame regardless of mode (cheap when idle) so a
  // STARRED or SPUN-OUT *AI* kart also shows its aura / spin-stars, not only the
  // player. The player-only bits (speed-lines + pickup flash) read the player
  // state/item; the held item's catalog colour tints the pickup flash. Done
  // BEFORE the `ps` early-return below so it still paints when there is no player
  // (e.g. spectating) — itemVfx skips whatever data is absent.
  {
    const pItem = getPlayerItem();
    const pDef = pItem ? getItem(pItem) : null;
    itemVfx.update(DT, {
      camera: renderer.camera,
      karts: getKartsList(),
      playerState: getPlayerState(),
      playerItemId: pItem,
      playerItemColor: pDef ? pDef.color : undefined,
    });
  }

  // BESPOKE POWER-UP VFX: drain the sim's FX event queue (item USES, shell impacts,
  // bob-omb blasts, blue-shell strikes) and play each item's custom flourish. Runs
  // AFTER itemVfx.update() so the screen-flash + billboards have a cached camera. The
  // queue lives on the RaceManager (GP/Battle); other modes have no consumeFxEvents
  // and simply skip. State-driven auras (boost/star/shrink) need no event — they
  // fire straight off the kart timers inside itemVfx.update() above.
  if (manager && typeof manager.consumeFxEvents === 'function') {
    const evs = manager.consumeFxEvents();
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      switch (e.type) {
        case 'use':
          if (e.itemId === 'coin') itemVfx.coinSparkle(e);
          else if (e.itemId === 'banana' || e.itemId === 'tripleBanana') itemVfx.bananaDrop(e);
          else itemVfx.itemUseBurst(e.itemId, e);
          break;
        case 'explosion': {
          itemVfx.explosion(e);
          // Spatial blast thud: panned toward the blast + quieter with distance.
          const sp = _spatialFor(e.x, e.z);
          if (sp.near > 0.05) audio.sfxBump(0.9 * sp.near, sp.pan);
          break;
        }
        case 'impact': {
          itemVfx.impactSpark(e, e.color);
          // Spatial knock when a shell/etc. strikes someone near the player.
          const sp = _spatialFor(e.x, e.z);
          if (sp.near > 0.05) audio.sfxBump(0.55 * sp.near, sp.pan);
          break;
        }
        case 'blueImpact': itemVfx.blueShellImpact(e); break;
        default: break;
      }
    }
  }

  const ps = getPlayerState();
  if (!ps) return; // nothing racing

  // Engine RPM: pitch/volume track speed, and the engine REVS while boosting.
  audio.setEngineState(ps.speed, 44, (ps.boostTimer || 0) > 0);

  // OFF-ROAD rumble: a low gritty loop that swells with speed while the kart is
  // off the racing surface (state.surface === 'offroad' — grass/dirt), silent on
  // the road/boost/ramp. Level-driven each frame; the loop self-builds on the
  // first time off the track and rides back to silence the moment we're back on.
  audio.setOffroad(ps.surface === 'offroad', ps.speed);

  if (!_fx) return; // edge detection not armed yet

  // --- AIR TRICKS + OVERDRIVE (signature hook) ------------------------------
  // Drive the HUD style indicator + overdrive meter off the live player state,
  // and fire the matching one-shots on edges: a whoosh when a trick starts, a
  // chime + label pop on a clean trick landing, and a deep roar when an overdrive
  // surge activates. trickLandStyle is a TRANSIENT the model sets on landing; we
  // consume it for the HUD/SFX here and CLEAR it (it never feeds the sim, so the
  // client clearing it is parity-safe). Done before the boost block so the trick
  // landing's reused boostTimer surge still flows through the boost cues below.
  hud.updateTricks(ps);
  if (ps.trickActive && !_fx.prevTrickActive) audio.sfxTrickWhoosh();
  _fx.prevTrickActive = !!ps.trickActive;
  if ((ps.trickLandStyle || 0) > 0) {
    hud.popTrickLand(ps.trickLandStyle);
    audio.sfxTrickLand();
    // STAT: a clean trick landed. Count it + track the biggest single trick as
    // the "longest combo" (style points = style*100, matching the HUD's "+N").
    if (_sessionStats) {
      _sessionStats.tricks++;
      const pts = Math.round(ps.trickLandStyle * 100);
      if (pts > _sessionStats.longestCombo) _sessionStats.longestCombo = pts;
    }
    ps.trickLandStyle = 0; // consume the transient land signal
  }
  const odTimer = ps.overdriveTimer || 0;
  if (odTimer > 0 && _fx.prevOverdrive <= 0) audio.sfxOverdrive();
  _fx.prevOverdrive = odTimer;

  // --- BOOST begins: rising edge of boostTimer -> whoosh + flame burst. ------
  const boost = ps.boostTimer || 0;
  if (boost > _fx.prevBoost + 1e-3 && _fx.prevBoost <= 1e-3) {
    audio.sfxBoost();
  }
  // While boosting, spray flames out the back each frame.
  if (boost > 0) {
    vfx.boostFlames(
      { x: ps.x, y: ps.y, z: ps.z },
      { x: Math.sin(ps.heading), z: Math.cos(ps.heading) }
    );
  }
  _fx.prevBoost = boost;

  // --- MINI-TURBO tier climbs: drift-spark sound at the new tier. ------------
  const tier = ps.miniTurboTier || 0;
  if (tier > _fx.prevTier) {
    audio.sfxDrift(tier);
  }
  // STAT: count one drift per charge SESSION (the 0 -> >=1 rising edge), not per
  // tier-up, so a single long drift through blue/orange/purple counts once.
  if (tier >= 1 && _fx.prevTier === 0 && _sessionStats) _sessionStats.drifts++;
  _fx.prevTier = tier;

  // STAT + SFX: coins collected this frame (the held count rising). Fire the
  // bright "ting" on the pickup edge (previously this cue was never wired), and
  // bank the gain. Lost coins (on a spin-out) don't subtract from the lifetime
  // total or chime — only pickups count.
  const coinsNow = ps.coins || 0;
  if (coinsNow > _fx.prevCoins) {
    audio.sfxCoin();
    if (_sessionStats) _sessionStats.coins += coinsNow - _fx.prevCoins;
  }
  _fx.prevCoins = coinsNow;

  // --- DRIFT smoke: soft puffs while drifting (throttled so we don't drain the
  //     pool). Drift is signalled by state.drifting on the kart state. ---------
  if (ps.drifting) {
    _fx.smokeAccum += DT;
    if (_fx.smokeAccum >= 0.06) {
      _fx.smokeAccum = 0;
      vfx.smoke({ x: ps.x, y: ps.y, z: ps.z });
    }
  }

  // --- DRIFT screech: a continuous tyre-skid loop started/stopped on the drift
  //     edges, its pitch/energy ridden with speed + mini-turbo tier so the
  //     screech audibly climbs as the charge builds toward the boost release. --
  if (ps.drifting && !_fx.prevDrifting) audio.startSkid();
  else if (!ps.drifting && _fx.prevDrifting) audio.stopSkid();
  if (ps.drifting) audio.updateSkid(ps.speed, ps.miniTurboTier || 0);
  _fx.prevDrifting = !!ps.drifting;

  // --- HIT: rising edge of spinTimer (~0 -> >0) -> thud + HIT JUICE. ---------
  // This edge fires ONLY on a real spin-out (shell/banana/bomb set spinTimer);
  // smooth driving and gentle bumps never set it, so the juice can't trigger on a
  // clean road. The camera shake is owned by renderer.applyCameraFeel (amped on
  // this same edge); here we add the RED screen flash + an extra sharp impact
  // spark at the kart so getting bonked really THUMPS. (itemVfx.update already
  // fires the per-kart shockwave/spin-stars; this stacks a punchier player-only
  // pop on top.)
  const spin = ps.spinTimer || 0;
  if (spin > 0.05 && _fx.prevSpin <= 0.05) {
    audio.sfxHit();
    itemVfx.hitFlash();
    itemVfx.impactSpark({ x: ps.x, y: ps.y, z: ps.z }, 0xff5a2a);
  }
  _fx.prevSpin = spin;

  // --- KART-KART CRASH thud: rising edge of the player's _bumpImpact (set by
  //     RaceManager, 0..1). Runs BEFORE renderer.applyCameraFeel consumes/clears the
  //     flag this frame, so the SFX reads it first. The edge holds while two karts
  //     grind (no buzzy repeat) and re-fires on a fresh impact. Distinct from sfxHit
  //     (a shell spin-out) so a side-swipe sounds like a crash, not a bonk.
  const bump = ps._bumpImpact || 0;
  if (bump > 0.15 && _fx.prevBump <= 0.15) audio.sfxBump(bump);
  _fx.prevBump = bump;

  // --- INCOMING-ITEM danger cue: a soft blip the first frame a projectile starts
  //     homing/closing on the player (the HUD also shows a directional "!"). ------
  if (manager && typeof manager._incomingThreatDir === 'function') {
    const threatNow = manager._incomingThreatDir() != null;
    if (threatNow && !_fx.prevThreat) audio.sfxThreat(); // urgent "beep-beep" alert (distinct from the impact)
    _fx.prevThreat = threatNow;
  }

  // --- ITEM in hand: the held item id changed from '' to something -> pickup;
  //     from something to '' -> it was used (fired). -------------------------
  const item = getPlayerItem();
  if (item && item !== _fx.prevItem) {
    audio.sfxItemPickup();
  } else if (!item && _fx.prevItem) {
    audio.sfxItemUse(_fx.prevItem); // per-item flavour (shell/banana/lightning/star/mushroom)
  }
  _fx.prevItem = item;

  // --- FINAL LAP tension: raise music tempo/pitch on the player's last lap. --
  if (manager && manager.lapSystem && typeof manager.lapSystem.getProgress === 'function') {
    const prog = manager.lapSystem.getProgress('player');
    const total = manager.lapSystem.totalLaps || 3;
    // LAP CHIME: a quick ding each time a lap is COMPLETED (rising edge of the
    // completed-lap count) — but NOT the final crossing, which flips `finished`
    // and is owned by the finish fanfare below. prog.lap = completed laps.
    if (prog) {
      const lapNow = prog.lap || 0;
      if (lapNow > _fx.prevLap && !prog.finished) audio.sfxLap();
      _fx.prevLap = lapNow;
    }
    // prog.lap = COMPLETED laps; on the final lap completed === total-1.
    const onFinalLap = !!(prog && prog.lap >= total - 1 && !prog.finished);
    if (onFinalLap !== _fx.prevFinalLap) {
      audio.setFinalLap(onFinalLap);
      _fx.prevFinalLap = onFinalLap;
    }
  }

  // --- FINISH: the player crossed the final line. We read the lap system's
  //     progress.finished when available (RaceManager / TimeTrial expose
  //     lapSystem). Fire the fanfare + a confetti burst once. ----------------
  const finished = isPlayerFinished();
  if (finished && !_fx.prevFinished) {
    audio.sfxFinish();
    vfx.confettiBurst({ x: ps.x, y: ps.y + 1, z: ps.z });
  }
  _fx.prevFinished = finished;
}

// Whether the player has finished their race this frame. Uses the lap system if
// the manager exposes one (GP); Battle signals completion via manager.finished.
function isPlayerFinished() {
  // BATTLE owns its own win celebration (player-win-only confetti + fanfare, fired
  // in Battle._beginEnding WITH the win banner), so the generic finish fanfare must
  // NOT also fire here — otherwise every battle end (including a LOSS) would play
  // the victory cue. Returning false in battle leaves the celebration to Battle.
  if (mode === 'battle') return false;
  if (manager && manager.finished) return true; // MP end flag
  if (manager && manager.lapSystem && typeof manager.lapSystem.getProgress === 'function') {
    const prog = manager.lapSystem.getProgress('player');
    return !!(prog && prog.finished);
  }
  return false;
}

// ----------------------------------------------------------------------------
// 11. The fixed-timestep physics step (runs at exactly 60Hz; dt === DT).
// ----------------------------------------------------------------------------
function update(dt) {
  // PAUSE FREEZE (single-player only): skip the whole fixed step so the sim holds
  // still while the pause overlay is up. render() keeps running, so the frozen
  // scene still draws. `paused` is NEVER set in mode 'mp' (the server keeps
  // simulating there), so multiplayer can't desync from a local pause.
  if (paused) return;

  // Animate the active circuit theme (rainbow road/rail hue cycle + star
  // twinkle). Safe no-op for non-animated themes; Battle uses an Arena (no
  // track). Driven from the fixed step so the cycle is rate-consistent.
  if (track && typeof track.update === 'function') {
    track.update(dt);
  }

  if (mode === 'gp' && manager) {
    // Don't tick the race clock during the 3-2-1 countdown (field frozen, locked).
    // Mirrors TimeTrial.js:333 so lap-1 + total times exclude the ~2.1s grid hold.
    if (typeof manager.isLocked === 'function' ? !manager.isLocked() : true) raceClock += dt;
    manager.update(dt, raceClock);
    // R11: when the player finishes, the RaceManager flips raceOver — show the
    // results board ONCE and wire its buttons to the existing GP/track/menu paths.
    if (manager.raceOver && !_resultsShown) {
      _resultsShown = true;
      // RECORDS: persist this race's outcome — a win (player finished 1st) and the
      // best lap for this track. Done once, here, for both cup + single races.
      {
        const results = typeof manager.getResults === 'function' ? manager.getResults() : null;
        const me = Array.isArray(results) ? results.find((r) => r.isPlayer) : null;
        if (me && me.place === 1) recordRaceWin();
        // COINS: bank the coins the player collected this race into the spendable
        // wallet (drives the coin shop). Runs for both cup + single GP races.
        if (me && me.coinsEarned > 0) addCoins(me.coinsEarned);
        const prog = manager.lapSystem && typeof manager.lapSystem.getProgress === 'function'
          ? manager.lapSystem.getProgress('player') : null;
        if (prog && prog.bestLap != null) recordBestLap(trackId, prog.bestLap);
      }
      if (cup) {
        // CUP race finished: tally this race's points by finish position, then
        // either show running standings + chain to the next track, or — after the
        // final race — crown the champion. The stable field (same ids/colours/
        // personalities every race) keeps the cumulative standings coherent.
        cup.recordRaceResults(manager.getResults());
        if (!cup.isComplete()) {
          resultsScreen.showCupStandings(cup, {
            onNext: () => {
              resultsScreen.hide();
              cup.nextRace();
              trackId = cup.currentTrack();
              startGrandPrix(); // re-arms _resultsShown for the next race
            },
            onMenu: () => { resultsScreen.hide(); returnToMenu(); },
          });
        } else {
          // RECORDS: the cup is complete — if the player is champion, bank a cup win.
          const champ = typeof cup.getChampion === 'function' ? cup.getChampion() : null;
          if (champ && champ.isPlayer) recordCupWin();
          resultsScreen.showCupChampion(cup, {
            onRestartCup: () => {
              resultsScreen.hide();
              cup.start();
              trackId = cup.currentTrack();
              startGrandPrix();
            },
            onMenu: () => { resultsScreen.hide(); returnToMenu(); },
          });
        }
      } else {
        resultsScreen.show(manager.getResults(), {
          onRestart: () => { resultsScreen.hide(); startGrandPrix(); },
          onNextTrack: () => {
            resultsScreen.hide();
            teardownMode();
            pendingMode = 'gp';
            trackSelect.show({ cup: true });
            mode = 'track';
            syncDebug();
          },
          onMenu: () => { resultsScreen.hide(); returnToMenu(); },
        });
      }
    }
  } else if (mode === 'tt' && manager) {
    manager.update(dt);
  } else if (mode === 'battle' && manager) {
    manager.update(dt);
    // When the match ends, show the POLISHED battle results board ONCE (ranked
    // score-first: pops desc → balloons → earliest to the score). Reuses the GP
    // results screen + its button wiring; RESTART re-runs a battle, MENU returns home.
    if (manager.finished && !_battleResultsShown) {
      _battleResultsShown = true;
      resultsScreen.showBattle(manager.getBattleResults(), {
        onRestart: () => { resultsScreen.hide(); startBattle(); },
        onMenu: () => { resultsScreen.hide(); returnToMenu(); },
      });
    }
  } else if (mode === 'mp' && manager) {
    manager.update(dt);
  } else if (mode === 'couch' && manager) {
    // COUCH/TV: the LOCAL sim (RaceManager or Battle) — same fixed step as solo.
    if (typeof manager.isLocked === 'function' ? !manager.isLocked() : true) raceClock += dt;
    manager.update(dt, raceClock);
    emitCouchState(dt);
    // End-of-race edge: battles flip `finished`, races flip `raceOver`.
    if (tvConfig && tvConfig.mode === 'battle') {
      if (manager.finished && !_battleResultsShown) {
        _battleResultsShown = true;
        endTvRace(manager.getBattleResults());
      }
    } else if (manager.raceOver && !_resultsShown) {
      _resultsShown = true;
      endTvRace(manager.getResults());
    }
  }
  // 'menu' / 'select' / 'track' modes: nothing to simulate.
}

// ----------------------------------------------------------------------------
// 12. The render step (runs once per animation frame).
// ----------------------------------------------------------------------------
function render(alpha) {
  hud.stats.begin();

  // `alpha` (0..1) is how far real time sits between the last two physics ticks
  // (see core/Loop.js). ALL modes now interpolate their karts' render transforms
  // by alpha to smooth the 60Hz sim up to the paint rate and kill turn judder;
  // each reads DT internally for the wheel-roll / spark / lerp animations.
  //
  // MULTIPLAYER blends its local PREDICTED kart prev->current by alpha; its remote
  // karts stay on their own snapshot Interpolator (independent of the loop alpha,
  // since remotes arrive over the network and are already smoothed there).
  if (mode === 'gp' && manager) {
    manager.render(alpha, hud, renderer, raceClock);
  } else if (mode === 'tt' && manager) {
    manager.render(alpha);
  } else if (mode === 'battle' && manager) {
    manager.render(alpha);
  } else if (mode === 'mp' && manager) {
    manager.render(alpha);
  } else if (mode === 'couch' && manager) {
    // Sync every kart mesh from the local sim (hud/renderer null → no single
    // chase camera or solo HUD), then feed the TV overlay its per-frame frame.
    manager.render(alpha, null, null, raceClock);
    if (couchOverlay) couchOverlay.update(buildOverlayFrame(alpha));
  }

  // M6: drive the engine sound + particle FX off the active player's state. Runs
  // after the manager render so it reads this frame's freshest state. While PAUSED
  // (single-player) the sim is frozen, so skip the FX advance (no boost-flames off a
  // stationary kart) and idle the engine instead of holding a frozen rev note.
  if (paused) {
    audio.setEngineState(0, 44, false);
    // Silence the continuous loops while frozen (they'd otherwise drone on),
    // and re-arm the drift edge so a still-held drift restarts the screech on
    // resume. Off-road is level-driven, so it self-corrects once updates resume.
    audio.stopSkid();
    audio.setOffroad(false, 0);
    if (_fx) _fx.prevDrifting = false;
  } else {
    updateAudioVfx();
  }

  // CINEMATIC CAMERA FEEL: shape the lens off the player's live state so driving
  // feels fast — FOV widens with speed, a quick FOV kick on boost, and a short
  // shake on hard landings (airborne->grounded) and hits. Also ramps the post
  // sense-of-speed effect. Runs AFTER the manager's render (which positioned/aimed
  // the chase camera this frame) so our FOV change + shake are the last word on
  // the camera transform. No-op in menu/select/track (getPlayerState() is null).
  const camState = getPlayerState();
  if (!paused && camState && typeof renderer.applyCameraFeel === 'function') {
    // The render loop runs per animation frame; DT is the fixed sim step, which is
    // a stable, good-enough dt for the eased FOV / shake decay here.
    renderer.applyCameraFeel(camState, DT);
  }

  // Draw the scene from the camera's point of view. COUCH MODE draws N split-
  // screen viewports (one chase camera per human player) instead of the single
  // full-screen camera; each phone sees its own kart on the TV.
  if (mode === 'couch' && manager && typeof manager.getHumanViews === 'function') {
    const states = manager.getHumanViews(alpha).map((v) => v.state);
    renderer.renderSplitScreen(states, DT, (track && track.trackId) || 'circuit');
  } else {
    renderer.render();
  }

  hud.stats.end();
}

// ----------------------------------------------------------------------------
// 13. Start the one loop.
// ----------------------------------------------------------------------------
const loop = new GameLoop(update, render);
loop.start();

// ----------------------------------------------------------------------------
// Debug hook (handy for automated browser checks; harmless in production).
// ----------------------------------------------------------------------------
function syncDebug() {
  let kartState = null;
  let lapSystem = null;
  if (manager) {
    if (mode === 'mp') {
      kartState = manager.predictor ? manager.predictor.state : null;
    } else if (typeof manager.getPlayer === 'function') {
      const player = manager.getPlayer();
      kartState = player ? player.state : null;
      lapSystem = manager.lapSystem || null;
    }
  }

  window.__debug = {
    mode,        // 'menu' | 'select' | 'track' | 'shop' | 'gp' | 'tt' | 'battle' | 'mp' | 'couch'
    tvConfig,    // COUCH/TV: the configured game, or null
    couchOverlay, // COUCH/TV: the split-screen overlay, or null
    manager,
    race: manager,
    selection,
    trackId,
    kartState,
    lapSystem,
    socket,
    lobby,
    input,
    track,
    renderer,
    audio,
    vfx,
    loop,
    quality: qualitySettings, // graphics tier singleton (inspect/set in console + tests)
  };
}

// Seed the debug surface for the initial menu state.
syncDebug();
