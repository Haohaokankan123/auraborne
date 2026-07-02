// public/controller.js
//
// The PHONE CONTROLLER for couch mode. Two control schemes (switchable any time):
//
//   TOUCH (default) — "normal video-game" controls:
//     • GAS PEDAL (bottom-left): hold to accelerate, release to coast/slow (no brake).
//     • STEERING WHEEL (bottom-right): drag left/right to steer; springs back to
//       center on release. Precise + responsive.
//   TILT — rotate the phone like a wheel; auto-accelerate.
//
// Both: tap the item area to fire a power-up. You hold up to 3 items (shown as slots).
//
// It's a headless client speaking the existing netcode: join the couch room (from the
// QR's ?room=id) and emit the same `input` payload the desktop keyboard does, ~30x/s.

const socketIO = window.io;
const params = new URLSearchParams(location.search);
const ROOM = params.get('room') || undefined;

const EMIT_MS = 33;         // ~30 Hz input stream
const MODE_KEY = 'kart_ctrl_mode';

// --- TOUCH steering tuning ---------------------------------------------------
const WHEEL_FULL_PX = 110;  // horizontal drag (px) for full lock — smaller = MORE sensitive
const WHEEL_MAX = 0.92;     // cap on touch steer output (precise, so we allow near-full)
const WHEEL_VISUAL_DEG = 82; // how far the wheel graphic rotates at full lock

// --- TILT steering tuning (secondary mode) -----------------------------------
const DEADZONE_DEG = 8;     // ignore wobble
const FULL_LOCK_DEG = 46;   // tilt past this = full lock
const STEER_CURVE = 1.5;    // soften small tilts near center
const TILT_MAX = 0.82;      // cap on tilt steer output
const TILT_SMOOTH = 0.28;   // low-pass on tilt steer per event
const TILT_WAIT_MS = 1200;  // if no motion event by now, tilt isn't available

// --- DOM refs ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const joinScreen = $('join');
const pad = $('pad');
const nameInput = $('name');
const joinBtn = $('joinBtn');
const whoEl = $('who');
const dotEl = $('dot');
const connEl = $('conn');
const raceEl = $('race');
const modeBtn = $('modeBtn');
const itemZone = $('itemZone');
const slotEls = Array.from(document.querySelectorAll('#slots .slot'));
const useHint = $('useHint');
const gasBtn = $('gas');
const wheelWrap = $('wheelWrap');
const wheelEl = $('wheel');
const tiltUI = $('tiltUI');
const steerFill = $('steerFill');
const recenterBtn = $('recenter');
const hitFlash = $('hitFlash');
const finishEl = $('finish');
const finishPlace = $('finishPlace');
const landscapeHint = $('landscape');

// --- Controller state -------------------------------------------------------
let socket = null;
let myId = null;
let seq = 0;
let connected = false;

let mode = localStorage.getItem(MODE_KEY) || 'touch'; // 'touch' | 'tilt'

// TOUCH steering (wheel) + gas.
let gasHeld = false;
let wheelSteer = 0;         // -1..1 from the wheel
let wheelPointer = null;    // active pointer id dragging the wheel
let wheelStartX = 0;

// TILT steering.
let tiltActive = false;
let tiltSteer = 0;
let neutral = null;
let lastRaw = 0;

let pendingItem = false;    // set on tap; sent as one rising edge then cleared

// --- Race feedback state ----------------------------------------------------
let totalLaps = 3;
let mySlots = ['', '', ''];  // my 3 item slots (ids or '')
let prevSpin = 0;

const ITEM_ICON = {
  banana: '🍌', tripleBanana: '🍌', greenShell: '🐢', tripleGreen: '🐢', redShell: '🎯', tripleRed: '🎯',
  blueShell: '🌀', bobOmb: '💣', fakeBox: '🎁', mushroom: '🍄', tripleMushroom: '🍄', goldMushroom: '🍄',
  goldenMushroom: '🍄', star: '⭐', lightning: '⚡', bulletBill: '🚀', boo: '👻', coin: '🪙',
};
const iconFor = (id) => id ? (ITEM_ICON[id] || '🎁') : '';
const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// ============================================================================
// CONTROL MODE
// ============================================================================
function applyMode() {
  const touch = mode === 'touch';
  if (gasBtn) gasBtn.style.display = touch ? 'block' : 'none';
  if (wheelWrap) wheelWrap.style.display = touch ? 'flex' : 'none';
  if (tiltUI) tiltUI.classList.toggle('show', !touch);
  if (modeBtn) modeBtn.textContent = touch ? '🎮 TOUCH' : '📱 TILT';
  // Reset transient steer so switching doesn't carry a stuck value.
  wheelSteer = 0; tiltSteer = 0; gasHeld = false; if (gasBtn) gasBtn.classList.remove('on');
  if (wheelEl) wheelEl.style.transform = 'rotate(0deg)';
  // Entering tilt: (re)request motion access.
  if (!touch) {
    // Recapture neutral from the next orientation event — a stale neutral from a
    // previous grip is why the kart "keeps turning" after switching to tilt.
    neutral = null;
    requestTiltPermission();
  }
}

function setMode(m) {
  mode = (m === 'tilt') ? 'tilt' : 'touch';
  localStorage.setItem(MODE_KEY, mode);
  applyMode();
}

// Join-screen chooser highlight.
document.querySelectorAll('#modePick .modeOpt').forEach((el) => {
  if (el.dataset.mode === mode) el.classList.add('sel'); else el.classList.remove('sel');
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.querySelectorAll('#modePick .modeOpt').forEach((o) => o.classList.remove('sel'));
    el.classList.add('sel');
    mode = el.dataset.mode; localStorage.setItem(MODE_KEY, mode);
  });
});

// In-race toggle button.
if (modeBtn) modeBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); setMode(mode === 'touch' ? 'tilt' : 'touch'); });

// ============================================================================
// STEERING (resolve the current steer + throttle to send)
// ============================================================================
function currentSteer() {
  if (mode === 'touch') return wheelSteer * WHEEL_MAX;
  if (tiltActive) return tiltSteer * TILT_MAX;
  return 0;
}
function currentThrottle() {
  // TOUCH: only when the gas pedal is held (release to coast — no brake).
  // TILT: auto-accelerate (both hands are busy holding/tilting the phone).
  return mode === 'touch' ? (gasHeld ? 1 : 0) : 1;
}

function paintSteer(v) {
  if (!steerFill) return;
  const pct = Math.abs(v) * 50;
  steerFill.style.width = pct + '%';
  steerFill.style.left = v < 0 ? (50 - pct) + '%' : '50%';
}

// ============================================================================
// GAS PEDAL (touch)
// ============================================================================
if (gasBtn) {
  const press = (e) => { e.preventDefault(); gasHeld = true; gasBtn.classList.add('on'); if (navigator.vibrate) navigator.vibrate(8); };
  const release = (e) => { if (e) e.preventDefault(); gasHeld = false; gasBtn.classList.remove('on'); };
  gasBtn.addEventListener('pointerdown', press);
  gasBtn.addEventListener('pointerup', release);
  gasBtn.addEventListener('pointercancel', release);
  gasBtn.addEventListener('pointerleave', release);
}

// ============================================================================
// STEERING WHEEL (touch) — relative horizontal drag, springs back on release
// ============================================================================
if (wheelWrap) {
  wheelWrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wheelPointer = e.pointerId;
    wheelStartX = e.clientX;
    try { wheelWrap.setPointerCapture(e.pointerId); } catch {}
  });
  wheelWrap.addEventListener('pointermove', (e) => {
    if (wheelPointer !== e.pointerId) return;
    const dx = e.clientX - wheelStartX;
    const t = Math.max(-1, Math.min(1, dx / WHEEL_FULL_PX));
    wheelSteer = Math.sign(t) * Math.pow(Math.abs(t), 1.5);
    if (wheelEl) wheelEl.style.transform = 'rotate(' + (wheelSteer * WHEEL_VISUAL_DEG) + 'deg)';
  });
  const wheelUp = (e) => {
    if (e && wheelPointer !== e.pointerId) return;
    wheelPointer = null; wheelSteer = 0;
    if (wheelEl) wheelEl.style.transform = 'rotate(0deg)';
  };
  wheelWrap.addEventListener('pointerup', wheelUp);
  wheelWrap.addEventListener('pointercancel', wheelUp);
  wheelWrap.addEventListener('pointerleave', wheelUp);
  wheelWrap.addEventListener('lostpointercapture', wheelUp);
}

// ============================================================================
// TILT (secondary)
// ============================================================================
function readRawTilt(e) {
  const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
    ? screen.orientation.angle : (window.orientation || 0);
  if (angle === 90) return e.beta;
  if (angle === 270 || angle === -90) return -e.beta;
  if (angle === 180) return -e.gamma;
  return e.gamma;
}
// Normalize a degrees difference into (-180, 180]. `beta` (used in landscape, the
// recommended play orientation) ranges -180..180 and WRAPS — turning the wheel hard
// enough pushes it past the boundary (e.g. 179 -> -179), and a plain subtraction
// (raw - neutral) then jumps by ~360° in one reading. That jump snapped the steer to
// full lock and never recovered, even once you turned back — THE root cause of "turn
// and it goes insane / doesn't reset." Wrapping the diff removes the discontinuity.
function wrapDeg(d) {
  return ((d + 180) % 360 + 360) % 360 - 180;
}
function onOrientation(e) {
  if (e.gamma == null && e.beta == null) return;
  const raw = readRawTilt(e);
  lastRaw = raw;
  if (neutral === null) neutral = raw;
  tiltActive = true;
  const off = wrapDeg(raw - neutral);
  const sign = off < 0 ? -1 : 1;
  let mag = Math.max(0, Math.abs(off) - DEADZONE_DEG) / (FULL_LOCK_DEG - DEADZONE_DEG);
  mag = Math.pow(Math.min(1, mag), STEER_CURVE);
  tiltSteer += (sign * mag - tiltSteer) * TILT_SMOOTH;
  if (mag === 0 && Math.abs(tiltSteer) < 0.05) tiltSteer = 0;
}
let _tiltRequested = false;
async function requestTiltPermission() {
  if (_tiltRequested) return;
  _tiltRequested = true;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') { _tiltRequested = false; return; }
    }
    window.addEventListener('deviceorientation', onOrientation, true);
    setTimeout(() => { if (!tiltActive && mode === 'tilt' && useHint) useHint.textContent = 'TILT UNAVAILABLE — USE TOUCH'; }, TILT_WAIT_MS);
  } catch { _tiltRequested = false; }
}
if (recenterBtn) recenterBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault(); neutral = lastRaw;
  recenterBtn.textContent = 'CENTERED'; setTimeout(() => { recenterBtn.textContent = 'RE-CENTER'; }, 700);
});

// ============================================================================
// ITEM USE — tap the item area (anywhere not on the pedal/wheel)
// ============================================================================
if (itemZone) itemZone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!hasAnyItem()) return; // nothing to fire
  pendingItem = true;
  itemZone.classList.add('flash');
  if (navigator.vibrate) navigator.vibrate(30);
  setTimeout(() => itemZone.classList.remove('flash'), 140);
});

function hasAnyItem() { return mySlots.some((s) => s); }

function renderSlots() {
  for (let i = 0; i < slotEls.length; i++) {
    const id = mySlots[i] || '';
    slotEls[i].textContent = iconFor(id);
    slotEls[i].classList.toggle('filled', !!id);
  }
  if (useHint) useHint.classList.toggle('armed', hasAnyItem());
}

// ============================================================================
// JOIN + NETWORK
// ============================================================================
function doJoin() {
  const name = (nameInput.value || '').trim().slice(0, 12) || 'Racer';
  neutral = null; // recapture neutral at join — the phone's grip has likely changed
  applyMode(); // sets up the chosen scheme (and requests tilt if in tilt mode)

  socket = socketIO('', { transports: ['websocket', 'polling'] });
  socket.on('connect', () => { connected = true; connEl.style.color = '#7ee0a0'; socket.emit('join', { name, roomId: ROOM }); });
  socket.on('disconnect', () => { connected = false; connEl.style.color = '#e06666'; });
  socket.on('joined', (p) => {
    myId = p && p.playerId != null ? p.playerId : null;
    socket.emit('ready', { ready: true });
    joinScreen.style.display = 'none';
    pad.style.display = 'block';
    whoEl.textContent = name;
    updateOrientationHint();
  });
  socket.on('lobby', (payload) => {
    const players = (payload && payload.players) || [];
    const me = players.find((x) => x.id === myId) || players[players.length - 1];
    if (me && typeof me.color === 'number') {
      dotEl.style.color = '#' + (me.color >>> 0).toString(16).padStart(6, '0').slice(-6);
      dotEl.style.background = dotEl.style.color;
    }
  });

  socket.on('raceStart', (p) => {
    totalLaps = (p && p.totalLaps) || 3;
    mySlots = ['', '', '']; prevSpin = 0;
    neutral = null; // recapture neutral at the start line — grip drifts between races
    hideFinish(); renderSlots();
  });

  socket.on('snapshot', (snap) => {
    if (!snap || !Array.isArray(snap.karts) || myId == null) return;
    const me = snap.karts.find((k) => k.id === myId);
    if (!me) return;
    if (me.balloons != null) {
      // BATTLE: no laps — show standing + pops scored + balloons held instead.
      raceEl.textContent = (me.pos ? ordinal(me.pos) : '—') + '  ·  ★' + (me.score || 0) + '  ·  🎈×' + me.balloons;
    } else {
      const lap = Math.min(totalLaps, Math.max(1, me.lap || 1));
      raceEl.textContent = (me.pos ? ordinal(me.pos) : '—') + '  ·  LAP ' + lap + '/' + totalLaps;
    }
    // 3-slot inventory (falls back to the single `item` field for safety).
    const slots = Array.isArray(me.slots)
      ? me.slots.map((s) => (s && s.id) ? s.id : '')
      : [me.item || '', '', ''];
    if (slots.join('|') !== mySlots.join('|')) { mySlots = slots; renderSlots(); }
    const spin = me.spinTimer || 0;
    if (spin > 0.05 && prevSpin <= 0.05) onHit();
    prevSpin = spin;
  });

  socket.on('raceEnd', (p) => {
    const results = (p && p.results) || [];
    const me = results.find((r) => r.id === myId);
    showFinish(me ? me.pos : null);
  });

  setInterval(sendInput, EMIT_MS);
}

function sendInput() {
  if (!connected || !socket) return;
  const steer = currentSteer();
  paintSteer(steer);
  socket.emit('input', {
    seq: ++seq,
    steer,
    throttle: currentThrottle(),
    brake: 0,
    drift: false,
    useItem: pendingItem,
    lookBack: false,
    overdrive: false,
  });
  pendingItem = false;
}

// --- Feedback ---------------------------------------------------------------
function onHit() {
  if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
  if (!hitFlash) return;
  hitFlash.style.opacity = '1';
  clearTimeout(onHit._t);
  onHit._t = setTimeout(() => { hitFlash.style.opacity = '0'; }, 220);
}
function showFinish(pos) {
  if (!finishEl) return;
  finishPlace.textContent = pos ? ordinal(pos) : '🏁';
  finishEl.style.display = 'flex';
  if (navigator.vibrate) navigator.vibrate(pos === 1 ? [90, 60, 90, 60, 140] : 90);
}
function hideFinish() { if (finishEl) finishEl.style.display = 'none'; }

// --- Wiring -----------------------------------------------------------------
joinBtn.addEventListener('click', doJoin);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function updateOrientationHint() {
  const portrait = window.innerHeight > window.innerWidth;
  landscapeHint.style.display = (pad.style.display === 'block' && portrait) ? 'flex' : 'none';
}
window.addEventListener('resize', updateOrientationHint);
window.addEventListener('orientationchange', () => setTimeout(updateOrientationHint, 200));
document.addEventListener('contextmenu', (e) => e.preventDefault());
