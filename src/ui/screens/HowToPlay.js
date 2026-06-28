// src/ui/screens/HowToPlay.js
//
// The HOW-TO-PLAY overlay — shown ONCE before every mode's gameplay (Grand Prix,
// Time Trial, Battle, Multiplayer), right before the 3-2-1-GO countdown. A plain
// HTML/CSS overlay (NO three.js) styled with Tailwind utility classes, exactly
// like Menu.js / PauseMenu.js / DifficultySelect.js, so it reads as one family.
//
// It renders TWO panels:
//   (1) CONTROLS — the REAL, verified bindings (steer/accelerate/brake/drift/
//       item/look-back/overdrive/pause) as a keycap list, plus a one-line gamepad
//       row and a one-line mobile row. In Time Trial the "Use Item" row is dropped
//       (TT has no items); the gamepad row drops its item token too.
//   (2) THIS RACE — the chosen mode's objective + rules, in that mode's accent.
//
// API: show(mode, onStart) where mode is 'gp'|'tt'|'battle'|'mp'. The overlay is
// MODAL and freezing is owned by main.js (it shows this BEFORE building the race),
// so there is nothing to simulate behind it. ANY of: the START button, a click on
// the dim backdrop, Space, Enter, or Esc dismisses it and calls onStart() exactly
// once — that callback boots the race (manager + countdown). The Esc keypress is
// caught in the CAPTURE phase + stopImmediatePropagation'd so it dismisses THIS
// overlay instead of falling through to main.js's Esc->return-to-menu handler.
//
// A per-mode localStorage "seen" flag (mk_howto_seen_<mode>) is written on show so
// a future tweak could auto-skip; for now the overlay always shows (one keypress
// to start), as specced.

import gsap from 'gsap';

// --- Per-mode info: title, neon accent (matched to the Menu mode buttons), the
//     descriptive rules copy, and the one-line objective. -----------------------
const MODE_INFO = {
  gp: {
    title: 'GRAND PRIX',
    accent: '#fbbf24', accent2: '#f97316', // amber -> orange (Menu GP button)
    desc: 'Finish 3 laps per track across the cup. Place high to score points + earn coins. Drift through corners to charge a mini-turbo boost. Grab item boxes.',
    objective: 'Race 3 laps vs 12 rivals — finish first.',
  },
  tt: {
    title: 'TIME TRIAL',
    accent: '#34d399', accent2: '#14b8a6', // emerald -> teal (Menu TT button)
    desc: 'Beat the STAFF ghost, then chase your own best lap. Solo, no items — pure racing line + drifting.',
    objective: 'Solo 3-lap time attack — beat the ghost, set a new record.',
  },
  battle: {
    title: 'BALLOON BATTLE',
    accent: '#fb7185', accent2: '#ec4899', // rose -> pink (Menu Battle button)
    desc: "You have 3 balloons. Grab items and HIT rivals to pop their balloons (a shell, bomb, or solid hit pops one). Lose all 3 and you're OUT. Last kart with balloons — or the most when the timer ends — wins.",
    objective: '3 balloons each. Every hit pops one. Last kart with balloons wins — or most balloons at 0:00 (120s).',
  },
  mp: {
    title: 'MULTIPLAYER',
    accent: '#818cf8', accent2: '#8b5cf6', // indigo -> violet (Menu MP button)
    desc: 'Race real players online. First across the line after 3 laps wins.',
    objective: 'Online race vs other players (needs a live server).',
  },
};

// --- The verified control bindings (src/core/Input.js). `cluster` renders the
//     caps adjacent (WASD as one group); otherwise caps are joined by "/" to read
//     as alternatives. `item: true` marks the row dropped in Time Trial. ---------
const CONTROLS = [
  { label: 'Drive & Steer', caps: ['W', 'A', 'S', 'D'], cluster: true, alt: 'or Arrow Keys' },
  { label: 'Drift / Hop', caps: ['Space'] },
  { label: 'Use Item', caps: ['Shift', 'E'], item: true },
  { label: 'Look Back', caps: ['F'] },
  { label: 'Overdrive', caps: ['Q'] },
  { label: 'Pause & Settings', caps: ['Esc', 'P'] },
];

export class HowToPlay {
  constructor() {
    // Per-show callback + a one-shot guard so onStart can only fire once.
    this._onStart = null;
    this._active = false;
    this._mode = 'gp';

    // --- Root overlay: z-50 so it sits above the HUD (and the menu z-30 / results
    //     z-40); a dim, blurred backdrop keeps the panel readable. pointer-events
    //     so it takes clicks; clicking the backdrop (not the card) dismisses. -----
    this.element = document.createElement('div');
    this.element.id = 'howto-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-50', 'pointer-events-auto',
      'flex', 'items-center', 'justify-center',
      'select-none', 'text-white',
      'bg-black/70', 'backdrop-blur-sm', 'p-4',
    ].join(' ');
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this._dismiss(); // backdrop click = skip
    });

    // --- Card -------------------------------------------------------------
    const card = document.createElement('div');
    card.className = [
      'w-full', 'max-w-3xl', 'max-h-[90vh]', 'overflow-y-auto',
      'rounded-3xl', 'p-6', 'md:p-8',
      'bg-slate-900/90', 'backdrop-blur', 'ring-1', 'ring-white/15',
      'shadow-2xl', 'shadow-black/50',
      'flex', 'flex-col', 'gap-5',
    ].join(' ');
    this._card = card;

    // Title.
    const title = document.createElement('h2');
    title.textContent = 'HOW TO PLAY';
    title.className = [
      'text-3xl', 'md:text-4xl', 'font-black', 'tracking-tight', 'text-center',
      'bg-gradient-to-r', 'from-cyan-300', 'via-fuchsia-400', 'to-violet-400',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_0_24px_rgba(160,120,255,0.45)]',
    ].join(' ');
    card.appendChild(title);

    // --- Two-panel grid: CONTROLS | THIS RACE -----------------------------
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-5';

    grid.appendChild(this._buildControlsPanel());
    grid.appendChild(this._buildModePanel());
    card.appendChild(grid);

    // --- START button + hint ----------------------------------------------
    this._startBtn = document.createElement('button');
    this._startBtn.type = 'button';
    this._startBtn.textContent = 'START';
    this._startBtn.className = [
      'w-full', 'py-4', 'rounded-2xl',
      'text-xl', 'font-black', 'tracking-[0.15em]', 'uppercase', 'text-white',
      'shadow-lg', 'shadow-black/40',
      'transition', 'duration-150',
      'hover:scale-[1.02]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/60',
    ].join(' ');
    this._startBtn.addEventListener('click', () => this._dismiss());
    card.appendChild(this._startBtn);

    const hint = document.createElement('p');
    hint.textContent = 'Press Space / Enter — or click anywhere — to start  ·  Esc to skip';
    hint.className = 'text-center text-xs text-slate-400 tracking-wide';
    card.appendChild(hint);

    this.element.appendChild(card);

    // --- Keyboard shortcut: Space / Enter / Esc all start. CAPTURE phase so we
    //     run BEFORE main.js's window Esc handler, and stopImmediatePropagation on
    //     Esc so it dismisses THIS overlay instead of firing return-to-menu. Added
    //     once; the _active guard makes it inert while the overlay is hidden. ------
    this._onKeyDown = (e) => {
      if (!this._active) return;
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault(); // Space would scroll / re-trigger a focused button
        this._dismiss();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation(); // beat main.js's Esc -> returnToMenu
        this._dismiss();
      }
    };
    window.addEventListener('keydown', this._onKeyDown, true);

    // Start hidden; show()/hide() toggle visibility after this.
    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  /**
   * Build the CONTROLS panel shell. The per-mode row list + gamepad line are
   * (re)populated in show() via _renderControls (the item row depends on mode).
   * @private
   */
  _buildControlsPanel() {
    const panel = document.createElement('div');
    panel.className = 'rounded-2xl p-4 md:p-5 bg-slate-800/40 ring-1 ring-white/10 flex flex-col gap-3';
    this._controlsPanel = panel;

    const eyebrow = document.createElement('div');
    eyebrow.textContent = 'CONTROLS';
    eyebrow.className = 'text-xs font-bold uppercase tracking-[0.2em] text-slate-400';
    panel.appendChild(eyebrow);

    // The binding rows live here, rebuilt per show().
    this._controlsRows = document.createElement('div');
    this._controlsRows.className = 'flex flex-col gap-2';
    panel.appendChild(this._controlsRows);

    // One-line gamepad row (text set per mode) + one-line mobile row (static).
    this._gamepadLine = document.createElement('p');
    this._gamepadLine.className = 'text-[11px] leading-snug text-slate-400 pt-1';
    panel.appendChild(this._gamepadLine);

    const mobileLine = document.createElement('p');
    mobileLine.textContent = 'Mobile — on-screen stick + buttons (no look-back, no pause button).';
    mobileLine.className = 'text-[11px] leading-snug text-slate-400';
    panel.appendChild(mobileLine);

    return panel;
  }

  /**
   * Build the THIS RACE panel shell. Title / desc / objective text + accent are
   * set per mode in show() via _renderMode.
   * @private
   */
  _buildModePanel() {
    const panel = document.createElement('div');
    panel.className = 'rounded-2xl p-4 md:p-5 bg-slate-800/40 ring-1 ring-white/10 flex flex-col gap-3';
    this._modePanel = panel;

    const eyebrow = document.createElement('div');
    eyebrow.textContent = 'THIS RACE';
    eyebrow.className = 'text-xs font-bold uppercase tracking-[0.2em] text-slate-400';
    panel.appendChild(eyebrow);

    this._modeTitle = document.createElement('h3');
    this._modeTitle.className = 'text-2xl font-black tracking-tight';
    panel.appendChild(this._modeTitle);

    this._modeDesc = document.createElement('p');
    this._modeDesc.className = 'text-sm leading-relaxed text-slate-300';
    panel.appendChild(this._modeDesc);

    this._modeObjective = document.createElement('div');
    this._modeObjective.className = 'mt-auto rounded-xl px-3 py-2 text-sm font-semibold leading-snug';
    panel.appendChild(this._modeObjective);

    return panel;
  }

  /**
   * One keyboard-key cap, styled like a physical key.
   * @param {string} text
   * @returns {HTMLElement}
   * @private
   */
  _keycap(text) {
    const k = document.createElement('kbd');
    k.textContent = text;
    k.className = [
      'inline-flex', 'items-center', 'justify-center',
      'min-w-[1.9rem]', 'px-2', 'py-1',
      'rounded-md', 'text-xs', 'font-bold', 'font-mono', 'leading-none',
      'bg-white/10', 'text-slate-100', 'ring-1', 'ring-white/20',
      'shadow-[0_2px_0_rgba(0,0,0,0.45)]',
    ].join(' ');
    return k;
  }

  /**
   * Build one control row: label on the left, keycaps (+ optional alt note) right.
   * @param {{label:string, caps:string[], cluster?:boolean, alt?:string}} ctrl
   * @private
   */
  _controlRow(ctrl) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between gap-3 rounded-xl bg-slate-900/50 ring-1 ring-white/10 px-3 py-2';

    const lbl = document.createElement('span');
    lbl.textContent = ctrl.label;
    lbl.className = 'text-sm font-semibold text-slate-200';
    row.appendChild(lbl);

    const keys = document.createElement('div');
    keys.className = 'flex items-center gap-1.5 flex-wrap justify-end';
    ctrl.caps.forEach((c, i) => {
      keys.appendChild(this._keycap(c));
      // "/" separator between alternative keys (not for the WASD cluster).
      if (!ctrl.cluster && i < ctrl.caps.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '/';
        sep.className = 'text-slate-500 text-xs';
        keys.appendChild(sep);
      }
    });
    if (ctrl.alt) {
      const alt = document.createElement('span');
      alt.textContent = ctrl.alt;
      alt.className = 'text-[11px] text-slate-400 ml-1';
      keys.appendChild(alt);
    }
    row.appendChild(keys);
    return row;
  }

  /**
   * (Re)populate the controls rows + gamepad line for the given mode. Time Trial
   * has no items, so its "Use Item" row and gamepad item token are dropped.
   * @param {string} mode
   * @private
   */
  _renderControls(mode) {
    const isTT = mode === 'tt';
    this._controlsRows.innerHTML = '';
    for (const ctrl of CONTROLS) {
      if (ctrl.item && isTT) continue; // no items in Time Trial
      this._controlsRows.appendChild(this._controlRow(ctrl));
    }
    this._gamepadLine.textContent = isTT
      ? 'Gamepad — L-Stick steer · RT throttle · LT brake · RB drift · Y look-back · X overdrive.'
      : 'Gamepad — L-Stick steer · RT throttle · LT brake · RB drift · LB item · Y look-back · X overdrive.';
  }

  /**
   * Apply the mode's title / desc / objective + accent to the THIS RACE panel and
   * the START button gradient.
   * @param {string} mode
   * @private
   */
  _renderMode(mode) {
    const info = MODE_INFO[mode] || MODE_INFO.gp;

    this._modeTitle.textContent = info.title;
    this._modeTitle.style.backgroundImage = `linear-gradient(135deg, ${info.accent}, ${info.accent2})`;
    this._modeTitle.style.webkitBackgroundClip = 'text';
    this._modeTitle.style.backgroundClip = 'text';
    this._modeTitle.style.color = 'transparent';
    this._modeTitle.style.filter = `drop-shadow(0 0 14px ${info.accent}66)`;

    this._modeDesc.textContent = info.desc;

    this._modeObjective.textContent = '🎯 ' + info.objective;
    this._modeObjective.style.background = `${info.accent}1a`;
    this._modeObjective.style.color = info.accent;
    this._modeObjective.style.boxShadow = `inset 0 0 0 1px ${info.accent}55`;

    // START button glows in the mode accent.
    this._startBtn.style.backgroundImage = `linear-gradient(to right, ${info.accent}, ${info.accent2})`;
  }

  /**
   * Show the overlay for a mode, then run `onStart` when it's dismissed.
   * @param {('gp'|'tt'|'battle'|'mp')} mode
   * @param {Function} onStart  Boots the race; called exactly once on dismiss.
   */
  show(mode, onStart) {
    this._mode = MODE_INFO[mode] ? mode : 'gp';
    this._onStart = typeof onStart === 'function' ? onStart : null;
    this._active = true;

    this._renderControls(this._mode);
    this._renderMode(this._mode);

    // Record that this mode's how-to has been seen (future auto-skip lever).
    try { localStorage.setItem('mk_howto_seen_' + this._mode, '1'); } catch (e) { /* ignore */ }

    this.element.style.display = 'flex';

    // Short GSAP entrance: the card pops in, then the two panels rise + fade.
    gsap.from(this._card, {
      opacity: 0, scale: 0.94, y: 18, duration: 0.3, ease: 'back.out(1.5)',
      clearProps: 'opacity,transform',
    });
    gsap.from([this._controlsPanel, this._modePanel], {
      opacity: 0, y: 20, duration: 0.4, ease: 'power3.out',
      stagger: 0.1, delay: 0.08, clearProps: 'opacity,transform',
    });
  }

  /**
   * Dismiss the overlay and fire onStart once. Safe to call repeatedly (the
   * _active guard makes extra calls no-ops, so backdrop + key + button can't
   * double-boot the race).
   * @private
   */
  _dismiss() {
    if (!this._active) return;
    this._active = false;
    this.hide();
    const cb = this._onStart;
    this._onStart = null;
    if (typeof cb === 'function') cb();
  }

  /** Hide the overlay (without firing onStart). */
  hide() {
    this.element.style.display = 'none';
  }

  /** Remove the overlay from the DOM entirely (optional cleanup). */
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown, true);
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}

export default HowToPlay;
