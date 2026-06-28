// src/ui/screens/PauseMenu.js
//
// The PAUSE / SETTINGS overlay. A plain HTML/CSS overlay (NO three.js) styled
// with Tailwind utility classes, exactly like Menu.js — show()/hide() toggle it.
//
// It serves three contexts (chosen by show({ context })):
//   'pause' — single-player Esc/P pause. The sim is frozen by main.js BEHIND this
//             overlay (main.js gates its update() on its own `paused` flag — the
//             PauseMenu itself never touches the loop). Shows RESUME + RESTART +
//             QUIT TO MENU plus the volume/mute controls.
//   'mp'    — multiplayer Esc/P. The server keeps simulating, so main.js does NOT
//             freeze; this is just a non-freezing settings panel that floats over
//             the live race. Shows BACK TO RACE + QUIT TO MENU + volume/mute.
//   'menu'  — opened from the main menu's ⚙ button: just the volume/mute panel +
//             CLOSE (no RESTART / QUIT — there's no race to act on).
//
// All game-flow actions are reported back via callbacks (onResume/onRestart/
// onQuit); the volume + mute controls drive the passed AudioManager directly,
// using its existing persisted API (getVolume/setVolume/isMuted/toggleMute).

import gsap from 'gsap';
// Graphics quality tier (singleton): the slider reads the current tier from here
// and the onQuality callback routes the change to the renderer (which persists it).
import qualitySettings, { TIERS } from '../../core/QualitySettings.js';

export class PauseMenu {
  // localStorage pref key for the kart skin, shared with main.js's applyKartSkin.
  static SKIN_KEY = 'mk_kart_skin';

  /**
   * @param {Object} opts
   * @param {Object}   opts.audio      the shared AudioManager (volume/mute API).
   * @param {Function} [opts.onResume] RESUME / BACK TO RACE / CLOSE was clicked.
   * @param {Function} [opts.onRestart] RESTART was clicked (single-player only).
   * @param {Function} [opts.onQuit]    QUIT TO MENU was clicked.
   */
  constructor({ audio, onResume, onRestart, onQuit, onKartSkin, onQuality, onHowTo } = {}) {
    this._audio = audio || null;
    this._onResume = onResume || (() => {});
    this._onRestart = onRestart || (() => {});
    this._onQuit = onQuit || (() => {});
    // Re-open the How-to-Play overlay (controls + this mode's objective) over the
    // paused screen. No-op if not provided (e.g. the menu-context settings panel).
    this._onHowTo = onHowTo || (() => {});
    // Called after the kart-style toggle writes its pref, so main.js can re-apply
    // (load/clear) the shared model for the next race. No-op if not provided.
    this._onKartSkin = onKartSkin || (() => {});
    // Called with the chosen quality tier ('low'|'medium'|'high'|'ultra'); main.js
    // routes it to renderer.setQualityTier (which live-applies + persists). No-op
    // if not provided.
    this._onQuality = onQuality || (() => {});

    // --- Root overlay -----------------------------------------------------
    // z-50 so it sits ABOVE the HUD, the menu (z-30) and the results board
    // (z-40). A dim, blurred backdrop keeps the frozen scene visible behind it
    // while making the panel readable. pointer-events-auto so it takes clicks.
    this.element = document.createElement('div');
    this.element.id = 'pause-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-50',
      'pointer-events-auto',
      'flex', 'items-center', 'justify-center',
      'select-none', 'text-white',
      'bg-black/60', 'backdrop-blur-sm',
    ].join(' ');

    // --- Card -------------------------------------------------------------
    const card = document.createElement('div');
    card.className = [
      'flex', 'flex-col', 'items-stretch', 'gap-4', 'w-80',
      'p-8', 'rounded-3xl',
      'bg-slate-900/90', 'border', 'border-white/10',
      'shadow-2xl', 'shadow-black/50',
    ].join(' ');
    this._card = card;

    // Title — swapped per context in show().
    this._title = document.createElement('h2');
    this._title.textContent = 'PAUSED';
    this._title.className = 'text-4xl font-black tracking-tight text-center mb-1';
    card.appendChild(this._title);

    // --- Flow buttons -----------------------------------------------------
    this._resumeBtn = this._makeButton(
      'RESUME',
      'from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500'
    );
    this._resumeBtn.addEventListener('click', () => this._onResume());

    // HOW TO PLAY — re-open the controls + mode-objective overlay anytime.
    this._howToBtn = this._makeButton(
      'HOW TO PLAY',
      'from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500'
    );
    this._howToBtn.addEventListener('click', () => this._onHowTo());

    this._restartBtn = this._makeButton(
      'RESTART',
      'from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500'
    );
    this._restartBtn.addEventListener('click', () => this._onRestart());

    this._quitBtn = this._makeButton(
      'QUIT TO MENU',
      'from-rose-500 to-pink-600 hover:from-rose-400 hover:to-pink-500'
    );
    this._quitBtn.addEventListener('click', () => this._onQuit());

    card.appendChild(this._resumeBtn);
    card.appendChild(this._howToBtn);
    card.appendChild(this._restartBtn);
    card.appendChild(this._quitBtn);

    // --- Settings: master volume + mute -----------------------------------
    card.appendChild(this._buildSettings());

    this.element.appendChild(card);

    // Start hidden until show() is called.
    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  /**
   * Build one styled button (mirrors Menu.js's _makeButton so the two screens
   * read as one family).
   * @private
   */
  _makeButton(label, gradientClasses) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = [
      'w-full', 'py-3', 'rounded-2xl',
      'text-lg', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-gradient-to-r', gradientClasses,
      'shadow-lg', 'shadow-black/40',
      'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    return btn;
  }

  /**
   * Build the volume slider + mute toggle that read/write the AudioManager.
   * @private
   */
  _buildSettings() {
    const wrap = document.createElement('div');
    wrap.className = 'mt-2 pt-4 border-t border-white/10 flex flex-col gap-3';

    // Volume row: a label + a live percentage readout.
    const volLabelRow = document.createElement('div');
    volLabelRow.className = 'flex items-center justify-between text-sm font-semibold tracking-widest uppercase text-slate-300';
    const volLabel = document.createElement('span');
    volLabel.textContent = 'Volume';
    this._volReadout = document.createElement('span');
    this._volReadout.className = 'tabular-nums text-slate-400';
    volLabelRow.appendChild(volLabel);
    volLabelRow.appendChild(this._volReadout);
    wrap.appendChild(volLabelRow);

    // The slider itself (0..100). accent-* tints the native thumb/track.
    this._slider = document.createElement('input');
    this._slider.type = 'range';
    this._slider.min = '0';
    this._slider.max = '100';
    this._slider.step = '1';
    this._slider.className = 'w-full accent-amber-500 cursor-pointer';
    this._slider.addEventListener('input', () => {
      const v = Number(this._slider.value) / 100;
      if (this._audio) {
        this._audio.setVolume(v);
        // Dragging the slider should be audible — if we were muted, unmute so
        // the change is heard (intuitive: touching volume turns sound back on).
        if (v > 0 && this._audio.isMuted()) this._audio.unmute();
      }
      this._syncFromAudio();
    });
    wrap.appendChild(this._slider);

    // Mute toggle button.
    this._muteBtn = document.createElement('button');
    this._muteBtn.type = 'button';
    this._muteBtn.className = [
      'w-full', 'py-2', 'rounded-xl', 'text-sm', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-white/10', 'hover:bg-white/20', 'transition', 'duration-150',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/40',
    ].join(' ');
    this._muteBtn.addEventListener('click', () => {
      if (this._audio) this._audio.toggleMute();
      this._syncFromAudio();
    });
    wrap.appendChild(this._muteBtn);

    // --- Kart style: Neon (procedural) <-> 3D Model (A/B) -----------------
    // Toggles the localStorage pref main.js reads ('procedural' <-> 'kart.glb').
    // Reuses the mute-button styling. The change takes effect on the NEXT race
    // (the current race keeps the karts it already built), noted below the button.
    const skinLabelRow = document.createElement('div');
    skinLabelRow.className = 'flex items-center justify-between text-sm font-semibold tracking-widest uppercase text-slate-300 mt-1';
    const skinLabel = document.createElement('span');
    skinLabel.textContent = 'Kart Style';
    skinLabelRow.appendChild(skinLabel);
    wrap.appendChild(skinLabelRow);

    this._skinBtn = document.createElement('button');
    this._skinBtn.type = 'button';
    this._skinBtn.className = [
      'w-full', 'py-2', 'rounded-xl', 'text-sm', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-white/10', 'hover:bg-white/20', 'transition', 'duration-150',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/40',
    ].join(' ');
    this._skinBtn.addEventListener('click', () => {
      const cur = localStorage.getItem(PauseMenu.SKIN_KEY) || 'procedural';
      const next = cur === 'procedural' ? '3d' : 'procedural';
      // Store the actual filename for the model so main.js loads it directly.
      localStorage.setItem(PauseMenu.SKIN_KEY, next === '3d' ? 'kart.glb' : 'procedural');
      this._onKartSkin();
      this._syncSkinButton();
    });
    wrap.appendChild(this._skinBtn);

    // Tiny caption: the toggle applies on the next race, not the live one.
    this._skinNote = document.createElement('span');
    this._skinNote.className = 'text-[11px] leading-tight text-slate-500 text-center';
    this._skinNote.textContent = 'Applies on your next race';
    wrap.appendChild(this._skinNote);

    // --- Graphics quality: Low / Medium / High / Ultra segmented control --------
    // Drives the QualitySettings tier (persisted) via renderer.setQualityTier. The
    // headline win is the pixel-ratio cap (LOW renders at 1x), which lets weak
    // Chromebooks hold 60fps and stops high-end laptops over-rendering at 4x.
    const qLabelRow = document.createElement('div');
    qLabelRow.className = 'flex items-center justify-between text-sm font-semibold tracking-widest uppercase text-slate-300 mt-1';
    const qLabel = document.createElement('span');
    qLabel.textContent = 'Graphics';
    qLabelRow.appendChild(qLabel);
    wrap.appendChild(qLabelRow);

    // A row of 4 equal segments. The active tier is highlighted; clicking a segment
    // applies + persists it. Reuses the mute/skin button styling family.
    const seg = document.createElement('div');
    seg.className = 'flex gap-1';
    this._qualityBtns = {};
    for (const tier of TIERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.tier = tier;
      // Short uppercase label so all four fit the narrow card.
      btn.textContent = tier === 'medium' ? 'MED' : tier.toUpperCase();
      btn.className = this._qualityBtnClass(false);
      btn.addEventListener('click', () => {
        this._onQuality(tier);     // renderer.setQualityTier persists + live-applies
        this._syncQualityButtons();
      });
      seg.appendChild(btn);
      this._qualityBtns[tier] = btn;
    }
    wrap.appendChild(seg);

    // Tiny caption: pixel-ratio/shadows/bloom apply instantly, but antialiasing is
    // baked into the WebGL context, so a tier change with different AA needs a reload.
    this._qualityNote = document.createElement('span');
    this._qualityNote.className = 'text-[11px] leading-tight text-slate-500 text-center';
    this._qualityNote.textContent = 'Some changes apply on reload';
    wrap.appendChild(this._qualityNote);

    this._syncSkinButton();
    this._syncQualityButtons();

    return wrap;
  }

  // The Tailwind class string for one quality segment, highlighted when active.
  // @private
  _qualityBtnClass(active) {
    const base = [
      'flex-1', 'py-2', 'rounded-xl', 'text-[11px]', 'font-bold', 'tracking-wide', 'uppercase',
      'transition', 'duration-150',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/40',
    ];
    if (active) {
      base.push('bg-gradient-to-r', 'from-amber-500', 'to-orange-600', 'text-white', 'shadow-lg', 'shadow-black/40');
    } else {
      base.push('bg-white/10', 'hover:bg-white/20', 'text-slate-300');
    }
    return base.join(' ');
  }

  // Reflect the active quality tier on the segmented control (highlight the one
  // that matches QualitySettings' current tier).
  // @private
  _syncQualityButtons() {
    if (!this._qualityBtns) return;
    const active = qualitySettings.tier;
    for (const tier of TIERS) {
      const btn = this._qualityBtns[tier];
      if (btn) btn.className = this._qualityBtnClass(tier === active);
    }
  }

  // Reflect the saved kart-style pref on the toggle button label.
  _syncSkinButton() {
    if (!this._skinBtn) return;
    const isModel = (localStorage.getItem(PauseMenu.SKIN_KEY) || 'procedural') !== 'procedural';
    this._skinBtn.textContent = isModel ? '\u{1F3CE} 3D Model' : '\u{1F3CE} Neon Kart';
  }

  // Pull the slider + mute button into agreement with the AudioManager's current
  // (persisted) state. Called on show() and after every control change.
  _syncFromAudio() {
    if (!this._audio) return;
    const muted = this._audio.isMuted();
    const vol = Math.round(this._audio.getVolume() * 100);
    this._slider.value = String(vol);
    // When muted, dim the slider + read "MUTED" so the state is unmistakable.
    this._slider.style.opacity = muted ? '0.4' : '1';
    this._volReadout.textContent = muted ? 'MUTED' : `${vol}%`;
    this._muteBtn.textContent = muted ? '🔇 Sound Off' : '🔊 Sound On';
  }

  /**
   * Show the overlay for a given context. See the file header for the three
   * contexts. Defaults to the single-player 'pause' layout.
   * @param {Object} [opts]
   * @param {('pause'|'mp'|'menu')} [opts.context='pause']
   */
  show({ context = 'pause' } = {}) {
    // Per-context button visibility + labels.
    if (context === 'mp') {
      this._title.textContent = 'SETTINGS';
      this._resumeBtn.textContent = 'BACK TO RACE';
      this._restartBtn.style.display = 'none';
      this._quitBtn.style.display = '';
      this._howToBtn.style.display = '';   // in a live race -> explain it
    } else if (context === 'menu') {
      this._title.textContent = 'SETTINGS';
      this._resumeBtn.textContent = 'CLOSE';
      this._restartBtn.style.display = 'none';
      this._quitBtn.style.display = 'none';
      this._howToBtn.style.display = 'none'; // no active mode to explain from the menu
    } else {
      this._title.textContent = 'PAUSED';
      this._resumeBtn.textContent = 'RESUME';
      this._restartBtn.style.display = '';
      this._quitBtn.style.display = '';
      this._howToBtn.style.display = '';
    }

    this._syncFromAudio();
    this._syncSkinButton();
    this._syncQualityButtons();
    this.element.style.display = 'flex';

    // Short GSAP entrance: the card pops in from slightly small + low.
    gsap.from(this._card, {
      opacity: 0,
      scale: 0.92,
      y: 12,
      duration: 0.25,
      ease: 'back.out(1.6)',
      clearProps: 'opacity,transform',
    });
  }

  /** Hide the overlay. */
  hide() {
    this.element.style.display = 'none';
  }

  /** Remove the overlay from the DOM (optional cleanup). */
  dispose() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
