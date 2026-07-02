// src/ui/CouchOverlay.js
//
// COUCH TV OVERLAY — the DOM layer that sits above the split-screen canvas in
// couch mode: per-quadrant mini-HUD panels (name + position + lap, kart-colored),
// 3-slot item cards, the top-right STANDINGS leaderboard, the big 3-2-1-GO!
// countdown, transient toasts, an optional battle clock, and the end-of-race
// results board with RACE AGAIN / EXIT.
//
// Extracted from modes/CouchScreen.js (the snapshot-driven spectator) so the
// LOCAL-sim TV mode can reuse the exact same visuals. This class is sim-agnostic:
// it owns no sockets, no Three.js, no interpolation — the caller feeds it a
// pre-computed view model once per painted frame via update(frame).
//
//   frame = {
//     views: [{ id, name, color, info }],
//       info = { pos, totalRacers, lap, totalLaps, slots, balloons, score, lapTime }
//     leaderboard: [{ id, name, color, place }] | null,   // pre-sorted rows
//     timeLeft: seconds | null,                            // battle clock
//   }
//
// Plain DOM above the canvas, below menus. All writes are change-gated so a
// 60fps update() causes zero DOM churn while nothing visible changes.

import { getItem } from '../items/items.js';

// Tiny local copy of core/Renderer.js's couchLayout so the panels land inside
// each player's viewport region without importing the renderer:
//   1 -> full screen        2 -> stacked halves (MK-style, full width each)
//   3 -> two on top + one full-width strip below   4 -> quadrants
function couchLayout(n, W, H) {
  const hw = W / 2, hh = H / 2;
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (n === 2) return [{ x: 0, y: 0, w: W, h: hh }, { x: 0, y: hh, w: W, h: hh }];
  if (n === 3) return [
    { x: 0, y: 0, w: hw, h: hh }, { x: hw, y: 0, w: hw, h: hh },
    { x: 0, y: hh, w: W, h: hh },
  ];
  return [
    { x: 0, y: 0, w: hw, h: hh }, { x: hw, y: 0, w: hw, h: hh },
    { x: 0, y: hh, w: hw, h: hh }, { x: hw, y: hh, w: hw, h: hh },
  ];
}

// Change-gated writers: only touch the DOM when the value actually changed.
function setText(el, s) {
  if (el._cachedText !== s) { el._cachedText = s; el.textContent = s; }
}
function setStyle(el, prop, val) {
  const c = el._cachedStyle || (el._cachedStyle = {});
  if (c[prop] !== val) { c[prop] = val; el.style[prop] = val; }
}

function colorHex(color) {
  return '#' + ((color == null ? 0xffffff : color) >>> 0).toString(16).padStart(6, '0').slice(-6);
}

// seconds -> "m:ss.t" (lap / finish times)
function fmtLapTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

// seconds -> "m:ss" (battle clock)
function fmtClock(t) {
  const total = Math.max(0, Math.ceil(t));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

export class CouchOverlay {
  constructor() {
    this._players = [];       // [{id, name, color}] in viewport order
    this._hudPanels = [];     // per-player corner tags
    this._itemCards = [];     // per-player 3-slot item strips
    this._lbSig = null;       // leaderboard signature gate
    this._resultsBack = null; // results board backdrop (non-null while shown)
    this._disposed = false;
    this._buildOverlay();
  }

  // ------------------------------------------------------------------------
  // Root + singleton elements (toast, countdown, leaderboard, battle clock).
  // ------------------------------------------------------------------------
  _buildOverlay() {
    const el = document.createElement('div');
    el.id = 'couch-overlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:20;pointer-events:none;';
    document.body.appendChild(el);
    this._overlay = el;

    this._toastEl = document.createElement('div');
    this._toastEl.style.cssText =
      'position:absolute;left:50%;top:7%;transform:translateX(-50%);' +
      'padding:.5rem 1.1rem;border-radius:999px;font:700 15px/1.2 -apple-system,sans-serif;' +
      'color:#fff;background:rgba(10,8,24,.82);box-shadow:0 0 20px rgba(255,0,170,.4);' +
      'opacity:0;transition:opacity .3s;white-space:nowrap;';
    el.appendChild(this._toastEl);

    // Big centered 3-2-1-GO countdown — the TV's own, since the single-player
    // HUD is hidden in couch mode. Driven by the caller via showCountdown().
    this._cdEl = document.createElement('div');
    this._cdEl.style.cssText =
      'position:absolute;left:50%;top:42%;transform:translate(-50%,-50%) scale(.4);' +
      'font:900 21vh/1 -apple-system,sans-serif;color:#fff;opacity:0;' +
      'text-shadow:0 0 32px rgba(0,225,255,.7),0 0 70px rgba(255,0,170,.5);' +
      'transition:opacity .18s ease-out,transform .18s ease-out;';
    el.appendChild(this._cdEl);

    // Top-right leaderboard: pre-sorted rows from the caller.
    this._leaderboard = document.createElement('div');
    this._leaderboard.style.cssText =
      'position:absolute;top:12px;right:14px;display:flex;flex-direction:column;gap:3px;' +
      'padding:9px 12px 10px;border-radius:12px;background:rgba(10,8,24,.62);' +
      'border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 18px rgba(0,0,0,.4);min-width:150px;' +
      'display:none;';
    el.appendChild(this._leaderboard);

    // Top-center battle clock (mm:ss). Hidden unless frame.timeLeft is non-null.
    this._clockEl = document.createElement('div');
    this._clockEl.style.cssText =
      'position:absolute;left:50%;top:12px;transform:translateX(-50%);' +
      'padding:6px 18px;border-radius:12px;font:900 26px/1.1 -apple-system,sans-serif;' +
      'font-variant-numeric:tabular-nums;color:#fff;background:rgba(10,8,24,.62);' +
      'border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 18px rgba(0,0,0,.4);' +
      'text-shadow:0 1px 2px rgba(0,0,0,.7);display:none;';
    el.appendChild(this._clockEl);
  }

  // ------------------------------------------------------------------------
  // Players: one quadrant panel + item card per player, in viewport order.
  // Panels stay hidden until the first update() positions them.
  // ------------------------------------------------------------------------
  setPlayers(players) {
    if (this._disposed) return;
    this._players = Array.isArray(players) ? players.slice(0, 4) : [];
    // Rebuild from scratch (setPlayers is rare: race start / rematch).
    for (const p of this._hudPanels) p.box.remove();
    for (const c of this._itemCards) c.box.remove();
    this._hudPanels = [];
    this._itemCards = [];
    this._lbSig = null;
    for (let i = 0; i < this._players.length; i++) {
      this._panel(i).box.style.display = 'none';
      this._itemCard(i).box.style.display = 'none';
    }
  }

  // Corner tag per viewport: position ordinal + name + lap, kart-coloured edge.
  _panel(i) {
    let p = this._hudPanels[i];
    if (!p) {
      const box = document.createElement('div');
      box.style.cssText =
        'position:absolute;display:flex;flex-direction:column;gap:1px;' +
        'padding:.3rem .6rem;border-radius:.5rem;font:800 15px/1.15 -apple-system,sans-serif;' +
        'color:#fff;background:rgba(10,8,24,.55);border-left:4px solid #fff;' +
        'text-shadow:0 1px 2px rgba(0,0,0,.7);';
      const top = document.createElement('div');
      const sub = document.createElement('div');
      sub.style.cssText = 'font-weight:600;font-size:11px;opacity:.85;';
      box.appendChild(top);
      box.appendChild(sub);
      this._overlay.appendChild(box);
      p = this._hudPanels[i] = { box, top, sub };
    }
    return p;
  }

  // A 3-SLOT power-up strip, top-CENTER of each split viewport (like Grand Prix's
  // three item slots). Each tile glows gold when filled, dim when empty.
  _itemCard(i) {
    let c = this._itemCards[i];
    if (!c) {
      const box = document.createElement('div');
      box.style.cssText =
        'position:absolute;transform:translateX(-50%);display:flex;gap:5px;' +
        'padding:6px;border-radius:14px;background:rgba(10,8,24,.55);' +
        'border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 16px rgba(0,0,0,.35);';
      const tiles = [];
      for (let t = 0; t < 3; t++) {
        const tile = document.createElement('div');
        tile.style.cssText =
          'width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;' +
          'font-size:22px;background:rgba(255,255,255,.05);border:2px solid rgba(255,255,255,.12);transition:all .15s;';
        box.appendChild(tile);
        tiles.push(tile);
      }
      this._overlay.appendChild(box);
      c = this._itemCards[i] = { box, tiles };
    }
    return c;
  }

  // Held-item id -> icon. Reuses the CANONICAL icon from items.js so the TV panel
  // always matches the solo HUD (they diverged before — e.g. red shell showed 🎯
  // here but 🔴 in single-player). Empty for no item; gift-box fallback for any
  // unknown id.
  _itemIcon(id) {
    if (!id) return '';
    const def = getItem(id);
    return def && def.icon ? def.icon : '🎁';
  }

  // ------------------------------------------------------------------------
  // Per painted frame: position + fill each quadrant panel and item card from
  // the caller's pre-computed view model; refresh leaderboard + battle clock.
  // ------------------------------------------------------------------------
  update(frame) {
    if (this._disposed || this._resultsBack || !this._overlay || !frame) return;
    const views = Array.isArray(frame.views) ? frame.views : [];
    const n = Math.min(4, views.length);
    const rects = couchLayout(n, window.innerWidth, window.innerHeight);
    // Hide any panels/cards beyond the current view count.
    for (let i = n; i < this._hudPanels.length; i++) setStyle(this._hudPanels[i].box, 'display', 'none');
    for (let i = n; i < this._itemCards.length; i++) setStyle(this._itemCards[i].box, 'display', 'none');
    for (let i = 0; i < n; i++) {
      const v = views[i];
      const info = v.info || {};
      const r = rects[i];
      const hex = colorHex(v.color);
      const name = v.name || 'Racer';

      // Corner tag (top-left of the viewport).
      const p = this._panel(i);
      setStyle(p.box, 'display', 'flex');
      setStyle(p.box, 'left', (r.x + 12) + 'px');
      setStyle(p.box, 'top', (r.y + 12) + 'px');
      setStyle(p.box, 'borderLeftColor', hex);
      if (info.balloons != null) {
        // Battle: balloons + score replace position/lap.
        setText(p.top, name);
        setText(p.sub, '🎈×' + info.balloons + '  ★' + (info.score != null ? info.score : 0));
      } else if (info.pos == null && info.lapTime != null) {
        // Time trial: running clock replaces position/lap.
        setText(p.top, name);
        setText(p.sub, fmtLapTime(info.lapTime));
      } else {
        const pos = info.pos != null ? info.pos : i + 1;
        setText(p.top, this._ordinal(pos) + '  ' + name);
        setText(p.sub, 'LAP ' + Math.max(1, info.lap != null ? info.lap : 1) + '/' + (info.totalLaps != null ? info.totalLaps : 3));
      }

      // Item slots (3 tiles, top-center of the viewport). null slots = no card.
      const c = this._itemCard(i);
      if (info.slots == null) {
        setStyle(c.box, 'display', 'none');
      } else {
        setStyle(c.box, 'display', 'flex');
        setStyle(c.box, 'left', (r.x + r.w / 2) + 'px');
        setStyle(c.box, 'top', (r.y + 10) + 'px');
        const slots = Array.isArray(info.slots)
          ? info.slots.map((s) => (s && s.id) ? s.id : (typeof s === 'string' ? s : ''))
          : ['', '', ''];
        for (let t = 0; t < 3; t++) {
          const id = slots[t] || '';
          const tile = c.tiles[t];
          setText(tile, this._itemIcon(id));
          if (id) {
            setStyle(tile, 'background', 'rgba(255,224,138,.16)');
            setStyle(tile, 'borderColor', 'rgba(255,224,138,.5)');
            setStyle(tile, 'boxShadow', '0 0 12px rgba(255,224,138,.35)');
          } else {
            setStyle(tile, 'background', 'rgba(255,255,255,.05)');
            setStyle(tile, 'borderColor', 'rgba(255,255,255,.12)');
            setStyle(tile, 'boxShadow', 'none');
          }
        }
      }
    }

    this._updateLeaderboard(frame.leaderboard);

    // Battle clock (top-center, mm:ss).
    if (frame.timeLeft != null) {
      setStyle(this._clockEl, 'display', 'block');
      setText(this._clockEl, fmtClock(frame.timeLeft));
    } else {
      setStyle(this._clockEl, 'display', 'none');
    }
  }

  // Top-right leaderboard: caller-sorted rows, place + colour chip + name — the
  // couch "who's winning among us" glance. Signature-gated rebuild.
  _updateLeaderboard(rows) {
    if (!this._leaderboard) return;
    if (!rows || !rows.length) {
      setStyle(this._leaderboard, 'display', 'none');
      this._lbSig = null;
      return;
    }
    setStyle(this._leaderboard, 'display', 'flex');
    // Signature-gate: only rebuild when the ordering/positions/names actually change.
    const sig = rows.map((r) => r.place + r.name).join('|');
    if (sig === this._lbSig) return;
    this._lbSig = sig;
    this._leaderboard.innerHTML = '';
    const title = document.createElement('div');
    title.textContent = 'STANDINGS';
    title.style.cssText = 'font:800 10px/1 -apple-system,sans-serif;letter-spacing:.14em;color:#9a94b3;margin-bottom:4px;';
    this._leaderboard.appendChild(title);
    for (const r of rows) {
      const hex = colorHex(r.color);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:7px;font:800 13px/1.3 -apple-system,sans-serif;';
      const place = document.createElement('span');
      place.textContent = (r.place != null && r.place <= 24) ? this._ordinal(r.place) : '—';
      place.style.cssText = 'width:2.2rem;color:#ffe08a;';
      const chip = document.createElement('span');
      chip.style.cssText = 'width:.7rem;height:.7rem;border-radius:3px;box-shadow:0 0 6px ' + hex + ';background:' + hex + ';flex:0 0 auto;';
      const name = document.createElement('span');
      name.textContent = r.name || 'Racer';
      name.style.cssText = 'color:#fff;max-width:8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      row.appendChild(place); row.appendChild(chip); row.appendChild(name);
      this._leaderboard.appendChild(row);
    }
  }

  /**
   * Show one beat of the start countdown on the TV: '3' | '2' | '1' | 'GO!'.
   * Each beat pops in then fades — the caller times the beats. No-op while the
   * results board is up.
   * @param {string} text
   */
  showCountdown(text) {
    if (this._disposed || this._resultsBack || !this._cdEl) return;
    const go = String(text).toUpperCase().startsWith('G');
    this._cdEl.textContent = String(text);
    this._cdEl.style.color = go ? '#7dffb0' : '#fff';
    // Pop in.
    this._cdEl.style.opacity = '1';
    this._cdEl.style.transform = 'translate(-50%,-50%) scale(1)';
    clearTimeout(this._cdTimer);
    // Hold the number briefly, then shrink+fade so the next beat pops cleanly.
    this._cdTimer = setTimeout(() => {
      if (!this._cdEl) return;
      this._cdEl.style.opacity = '0';
      this._cdEl.style.transform = 'translate(-50%,-50%) scale(' + (go ? 1.6 : 0.4) + ')';
    }, go ? 700 : 520);
  }

  // Transient center-bottom-of-the-top toast (e.g. "Ava left — AI took over").
  toast(msg) {
    if (this._disposed || !this._toastEl) return;
    this._toastEl.textContent = msg;
    this._toastEl.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { if (this._toastEl) this._toastEl.style.opacity = '0'; }, 3000);
  }

  // ------------------------------------------------------------------------
  // TV RESULTS BOARD — the finishing order, humans medalled + kart-coloured, with
  // RACE AGAIN (rematch) and EXIT (→ menu). The heart of the arcade loop.
  // rows = [{ place, name, color, isHuman, time?, score?, balloons? }]
  // ------------------------------------------------------------------------
  showResults(rows, { onPlayAgain, onExit } = {}) {
    if (this._disposed || !this._overlay) return;
    this.hideResults();
    const results = Array.isArray(rows) ? rows : [];
    const playAgain = onPlayAgain || (() => {});
    const doExit = onExit || (() => {});
    // Kill any mid-count countdown that was still fading.
    clearTimeout(this._cdTimer);
    if (this._cdEl) this._cdEl.style.opacity = '0';

    // Backdrop over the whole TV (dims the frozen finish frame behind it).
    const back = document.createElement('div');
    back.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'background:radial-gradient(120% 100% at 50% 0%,rgba(26,11,46,.86),rgba(6,6,23,.94));' +
      'pointer-events:auto;opacity:0;transition:opacity .35s;backdrop-filter:blur(3px);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
    this._resultsBack = back;

    const panel = document.createElement('div');
    panel.style.cssText =
      'width:min(90vw,720px);max-height:88vh;display:flex;flex-direction:column;gap:14px;' +
      'padding:26px 30px;border-radius:22px;color:#fff;' +
      'background:linear-gradient(180deg,rgba(20,10,36,.96),rgba(8,10,26,.96));' +
      'box-shadow:0 0 0 1px rgba(255,255,255,.08),0 30px 80px -20px rgba(255,0,170,.5);';
    back.appendChild(panel);

    const winner = results[0];
    const title = document.createElement('div');
    title.style.cssText =
      'text-align:center;font-weight:900;font-size:2.4rem;letter-spacing:.06em;' +
      'text-shadow:0 0 24px rgba(255,0,170,.55),0 0 60px rgba(0,225,255,.3);';
    title.textContent = '🏁 FINISH';
    panel.appendChild(title);

    if (winner) {
      const sub = document.createElement('div');
      sub.style.cssText = 'text-align:center;font-size:1.15rem;color:#ffe08a;margin-top:-6px;font-weight:700;';
      sub.textContent = '🏆 ' + (winner.name || 'Racer') + ' wins!';
      panel.appendChild(sub);
    }

    // Ordered finishing list (leader first). Humans pop; CPUs are muted.
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;overflow-y:auto;padding-right:4px;';
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    for (const r of results) {
      const isHuman = !!r.isHuman;
      const hex = colorHex(r.color != null ? r.color : 0x8e8e93);
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:12px;padding:8px 14px;border-radius:11px;' +
        'font-size:1.05rem;' + (isHuman
          ? 'background:rgba(255,255,255,.09);border-left:5px solid ' + hex + ';font-weight:800;'
          : 'background:rgba(255,255,255,.03);border-left:5px solid rgba(255,255,255,.12);color:#b9b3d0;font-weight:600;');

      const place = document.createElement('span');
      place.style.cssText = 'width:2.4rem;text-align:center;font-size:1.2rem;';
      place.textContent = medals[r.place] || this._ordinal(r.place);
      row.appendChild(place);

      const name = document.createElement('span');
      name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      // A CPU seat with a taken-over human name still reads as a bot; only tag those.
      const label = r.name || (isHuman ? 'Racer' : 'CPU');
      name.textContent = (!isHuman && label !== 'CPU') ? label + '  · CPU' : label;
      row.appendChild(name);

      // Right-hand stat: finish time when present, else star score.
      if (r.time != null || r.score != null) {
        const stat = document.createElement('span');
        stat.style.cssText = 'font-variant-numeric:tabular-nums;font-size:.85rem;color:#8fe;opacity:.9;';
        stat.textContent = r.time != null ? fmtLapTime(r.time) : '★' + r.score;
        row.appendChild(stat);
      }
      list.appendChild(row);
    }
    panel.appendChild(list);

    // Actions: RACE AGAIN (rematch) + EXIT (menu).
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:12px;margin-top:4px;';
    const again = document.createElement('button');
    again.textContent = '🔁 RACE AGAIN';
    again.style.cssText =
      'flex:2;padding:16px;border:none;border-radius:14px;cursor:pointer;color:#fff;' +
      'font-weight:900;font-size:1.15rem;letter-spacing:.03em;' +
      'background:linear-gradient(90deg,#e935c1,#21d4fd);box-shadow:0 10px 30px -8px rgba(233,53,193,.6);';
    again.addEventListener('click', () => {
      again.textContent = 'STARTING…';
      again.disabled = true;
      again.style.opacity = '.7';
      exit.disabled = true;
      playAgain();
    });
    const exit = document.createElement('button');
    exit.textContent = 'EXIT';
    exit.style.cssText =
      'flex:1;padding:16px;border:none;border-radius:14px;cursor:pointer;color:#cfc9e6;' +
      'font-weight:800;font-size:1.05rem;background:rgba(255,255,255,.08);';
    exit.addEventListener('click', () => { exit.disabled = true; doExit(); });
    actions.appendChild(again);
    actions.appendChild(exit);
    panel.appendChild(actions);

    this._overlay.appendChild(back);
    // Fade in on the next frame (so the transition runs).
    requestAnimationFrame(() => { if (this._resultsBack === back) back.style.opacity = '1'; });
  }

  hideResults() {
    if (this._resultsBack) {
      this._resultsBack.remove();
      this._resultsBack = null;
    }
  }

  _ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ------------------------------------------------------------------------
  // Cleanup: remove all DOM this overlay created and clear timers.
  // ------------------------------------------------------------------------
  dispose() {
    this._disposed = true;
    clearTimeout(this._toastTimer);
    clearTimeout(this._cdTimer);
    this._resultsBack = null;
    this._hudPanels = [];
    this._itemCards = [];
    if (this._overlay && this._overlay.parentNode) {
      this._overlay.parentNode.removeChild(this._overlay);
    }
    this._overlay = null;
    this._toastEl = null;
    this._cdEl = null;
    this._leaderboard = null;
    this._clockEl = null;
  }
}

export default CouchOverlay;
