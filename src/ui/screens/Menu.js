// src/ui/screens/Menu.js
//
// The start menu: the very first screen the player sees. It is a plain
// HTML/CSS overlay (NO three.js) drawn on top of (or before) the game canvas,
// styled entirely with Tailwind utility classes — same approach as the HUD.
//
// Its job is to offer the four game modes and report the chosen one back to
// whoever wired it up via four callbacks:
//   - GRAND PRIX  -> onGrandPrix()
//   - TIME TRIAL  -> onTimeTrial()
//   - BATTLE      -> onBattle()
//   - MULTIPLAYER -> onMultiplayer()
//
// main.js (owned by the integration agent) constructs this, passes the
// callbacks, calls show(), and on a click hides it and boots the chosen mode.
//
// Tolerance note: any handler may be omitted; missing handlers default to a
// no-op so the menu never throws if a mode isn't wired up yet.
//
// IMPORTANT pointer-events note: the HUD overlay uses `pointer-events-none` so
// clicks pass through to the canvas. This menu is the opposite — it MUST receive
// clicks — so its root sets `pointer-events-auto`. We also give it a high z-index
// so it sits above the canvas and the HUD.
//
// Polish (M6): show() plays a short GSAP entrance — the title and subtitle fade
// and slide down, then the four buttons stagger in from below. GSAP is the
// project's chosen animation library (see package.json) and works in this
// vanilla-JS / Vite setup without any framework.

import gsap from 'gsap';

// Persistent records + the pure per-track medal thresholds, for the Records panel.
import { getStats, medalFor, isUnlocked, TIER_IDS } from '../../data/playerStats.js';
import { CHARACTERS } from '../../data/characters.js';
import { KART_BODIES, WHEELS } from '../../data/karts.js';
import { TARGET_LAP_TIMES, getTrackIds, getTrackMeta } from '../../../shared/trackData.js';

// Singular noun per unlock stat, for the "Next unlock" hint.
const UNLOCK_NOUN = { racesWon: 'win', cupsWon: 'cup' };

// Medal -> emoji, shared by the Records panel's best-lap rows + the trophy wall.
const MEDAL_EMOJI = { gold: '🥇', silver: '🥈', bronze: '🥉' };

// Engine-class labels per difficulty/tier id (the CC ladder), for the trophy wall.
const CC_LABELS = { easy: '100cc', medium: '150cc', hard: '200cc' };

export class Menu {
  /**
   * @param {Object} opts
   * @param {Function} [opts.onGrandPrix]   Called when GRAND PRIX is clicked.
   * @param {Function} [opts.onTimeTrial]   Called when TIME TRIAL is clicked.
   * @param {Function} [opts.onBattle]      Called when BATTLE is clicked.
   * @param {Function} [opts.onMultiplayer] Called when MULTIPLAYER is clicked.
   */
  constructor({ onGrandPrix, onTimeTrial, onBattle, onMultiplayer, onSettings, onShop } = {}) {
    // Keep the callbacks; default to no-ops so a missing handler never throws.
    this._onGrandPrix = onGrandPrix || (() => {});
    this._onTimeTrial = onTimeTrial || (() => {});
    this._onBattle = onBattle || (() => {});
    this._onMultiplayer = onMultiplayer || (() => {});
    this._onSettings = onSettings || (() => {});
    this._onShop = onShop || (() => {});

    // --- Root overlay -----------------------------------------------------
    // A full-screen flex container that centers the menu card. `fixed inset-0`
    // pins it to the viewport; `pointer-events-auto` lets it receive clicks.
    // A dark gradient backdrop keeps the bright title readable over anything.
    this.element = document.createElement('div');
    this.element.id = 'menu-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-30',           // cover the screen, above canvas + HUD
      'pointer-events-auto',                 // this overlay DOES take clicks
      'flex', 'flex-col', 'items-center', 'justify-center',
      'select-none', 'text-white',
      'bg-gradient-to-b', 'from-slate-900', 'via-slate-800', 'to-slate-900',
    ].join(' ');

    // --- Big title: the AURABORNE wordmark --------------------------------
    // The game's neon-synthwave logo. A clipped gradient is shown through the
    // glyphs, sized wider than the text so a slow looping GSAP sweep shimmers the
    // colour band across the letters, and a soft violet drop-shadow gives it the
    // neon glow. Tracking + uppercase make it read as a wordmark, not body text.
    const title = document.createElement('h1');
    title.textContent = 'AURABORNE';
    title.className = [
      'text-6xl', 'md:text-8xl', 'font-black', 'tracking-[0.14em]', 'uppercase',
      'mb-2',
      // Gradient text: a clipped neon gradient shown through the glyphs.
      'bg-gradient-to-r', 'from-cyan-300', 'via-fuchsia-400', 'to-violet-400',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_0_30px_rgba(192,132,252,0.55)]',
    ].join(' ');
    // Oversize the gradient so the sweep below has room to travel across the text.
    title.style.backgroundSize = '220% auto';
    this.element.appendChild(title);
    // Keep a reference so show() can animate the title in.
    this._title = title;

    // Neon SWEEP: glide the gradient band back and forth across the wordmark for a
    // slow synthwave shimmer. Started once (yoyo so it never pops), looping forever;
    // animates only background-position, so it's cheap and never fights show()'s
    // opacity/transform entrance.
    this._wordmarkTween = gsap.fromTo(
      title,
      { backgroundPositionX: '0%' },
      { backgroundPositionX: '220%', duration: 5, ease: 'sine.inOut', repeat: -1, yoyo: true }
    );

    // A small subtitle / tagline under the logo.
    const subtitle = document.createElement('p');
    subtitle.textContent = 'Drift. Boost. Win.';
    subtitle.className = 'text-lg md:text-xl text-slate-300 mb-12 tracking-widest uppercase';
    this.element.appendChild(subtitle);
    // Keep a reference so show() can animate the subtitle in.
    this._subtitle = subtitle;

    // --- Buttons ----------------------------------------------------------
    // A vertical stack of four mode buttons. Each is built by a small helper so
    // the styling stays consistent; each mode gets its own gradient so the
    // choices read as distinct at a glance.
    const buttonColumn = document.createElement('div');
    buttonColumn.className = 'flex flex-col gap-4 w-72';

    const grandPrixBtn = this._makeButton(
      'GRAND PRIX',
      // Warm amber — the headline single-player mode.
      'from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500'
    );
    grandPrixBtn.addEventListener('click', () => this._onGrandPrix());

    const timeTrialBtn = this._makeButton(
      'TIME TRIAL',
      // Cool teal — solo against the clock.
      'from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500'
    );
    timeTrialBtn.addEventListener('click', () => this._onTimeTrial());

    const battleBtn = this._makeButton(
      'BATTLE',
      // Hot rose — chaotic item combat.
      'from-rose-500 to-pink-600 hover:from-rose-400 hover:to-pink-500'
    );
    battleBtn.addEventListener('click', () => this._onBattle());

    const multiBtn = this._makeButton(
      'MULTIPLAYER',
      // Cool indigo — networked play.
      'from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500'
    );
    multiBtn.addEventListener('click', () => this._onMultiplayer());

    const shopBtn = this._makeButton(
      'SHOP',
      // Gold — spend coins earned racing on cosmetics.
      'from-amber-400 to-yellow-500 hover:from-amber-300 hover:to-yellow-400'
    );
    shopBtn.addEventListener('click', () => this._onShop());

    buttonColumn.appendChild(grandPrixBtn);
    buttonColumn.appendChild(timeTrialBtn);
    buttonColumn.appendChild(battleBtn);
    buttonColumn.appendChild(multiBtn);
    buttonColumn.appendChild(shopBtn);
    this.element.appendChild(buttonColumn);
    // Keep the button list (in DOM order) so show() can stagger them in.
    this._buttons = [grandPrixBtn, timeTrialBtn, battleBtn, multiBtn, shopBtn];

    // --- Footer note ------------------------------------------------------
    const footer = document.createElement('p');
    footer.textContent = 'WASD / Arrows to drive · Space to drift · Shift to use item · Esc to pause';
    footer.className = 'absolute bottom-6 text-xs text-slate-400 tracking-wide';
    this.element.appendChild(footer);

    // --- Settings (⚙) button ---------------------------------------------
    // A small gear pinned top-right that opens the same volume/mute panel the
    // pause overlay uses, so audio is tweakable without starting a race.
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.textContent = '⚙';
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.className = [
      'absolute', 'top-6', 'right-6',
      'w-12', 'h-12', 'rounded-full', 'text-2xl', 'leading-none',
      'bg-white/10', 'hover:bg-white/20',
      'transition', 'duration-150', 'hover:scale-110', 'active:scale-95',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    settingsBtn.addEventListener('click', () => this._onSettings());
    this.element.appendChild(settingsBtn);

    // --- Records (📊) button ---------------------------------------------
    // A small icon pinned top-left (mirroring the ⚙ gear) that opens the
    // persistent records/stats panel — best laps + medals + lifetime totals.
    const recordsBtn = document.createElement('button');
    recordsBtn.type = 'button';
    recordsBtn.textContent = '📊';
    recordsBtn.setAttribute('aria-label', 'Records');
    recordsBtn.className = [
      'absolute', 'top-6', 'left-6',
      'w-12', 'h-12', 'rounded-full', 'text-2xl', 'leading-none',
      'bg-white/10', 'hover:bg-white/20',
      'transition', 'duration-150', 'hover:scale-110', 'active:scale-95',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    recordsBtn.addEventListener('click', () => this._openRecords());
    this.element.appendChild(recordsBtn);

    // Build the (hidden) records panel overlay now; _openRecords repopulates it.
    this._buildRecordsPanel();

    // Start hidden until show() is called, so the caller controls timing.
    this.element.style.display = 'none';

    // Attach to the page once. show()/hide() only toggle visibility after this.
    document.body.appendChild(this.element);
  }

  /**
   * Build one styled menu button.
   * @param {string} label          Text shown on the button.
   * @param {string} gradientClasses Tailwind gradient color classes (from/to + hover).
   * @returns {HTMLButtonElement}
   * @private
   */
  _makeButton(label, gradientClasses) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = [
      'w-full', 'py-4', 'rounded-2xl',
      'text-xl', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-gradient-to-r', gradientClasses,
      'shadow-lg', 'shadow-black/40',
      'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    return btn;
  }

  /**
   * Build the (hidden) RECORDS panel: a centered glass card over a dimmed
   * backdrop, reusing the menu's look. The body is repopulated from playerStats
   * each time it opens (so it's always current); clicking the backdrop or CLOSE
   * dismisses it. Built once and reused, like the rest of the menu.
   * @private
   */
  _buildRecordsPanel() {
    const panel = document.createElement('div');
    panel.id = 'records-panel';
    panel.className = [
      'fixed', 'inset-0', 'z-40', 'pointer-events-auto',
      'flex', 'items-center', 'justify-center',
      'bg-black/60', 'backdrop-blur-sm',
    ].join(' ');
    panel.style.display = 'none';
    // Click on the dim backdrop (not the card) closes the panel.
    panel.addEventListener('click', (e) => {
      if (e.target === panel) this._closeRecords();
    });

    const card = document.createElement('div');
    card.className = [
      'w-[26rem]', 'max-w-[92vw]', 'max-h-[82vh]', 'overflow-y-auto',
      'rounded-3xl', 'p-6',
      'bg-slate-900/90', 'ring-1', 'ring-white/15', 'shadow-2xl', 'shadow-black/50',
      'flex', 'flex-col', 'gap-4',
    ].join(' ');
    panel.appendChild(card);

    const title = document.createElement('h2');
    title.textContent = 'RECORDS';
    title.className = [
      'text-3xl', 'font-black', 'tracking-tight', 'text-center',
      'bg-gradient-to-r', 'from-amber-400', 'via-rose-500', 'to-indigo-500',
      'bg-clip-text', 'text-transparent',
    ].join(' ');
    card.appendChild(title);

    // Repopulated by _renderRecords() on every open.
    this._recordsBody = document.createElement('div');
    this._recordsBody.className = 'flex flex-col gap-4';
    card.appendChild(this._recordsBody);

    const closeBtn = this._makeButton(
      'CLOSE',
      'from-slate-600 to-slate-700 hover:from-slate-500 hover:to-slate-600'
    );
    closeBtn.addEventListener('click', () => this._closeRecords());
    card.appendChild(closeBtn);

    this._recordsPanel = panel;
    document.body.appendChild(panel);
  }

  /**
   * Repopulate the records panel body from the persisted player stats: a grid of
   * headline stat chips, then a best-lap row per track with its earned medal.
   * @private
   */
  _renderRecords() {
    const body = this._recordsBody;
    if (!body) return;
    const s = getStats();
    body.innerHTML = '';

    // Headline stat chips (2-up grid).
    const chips = document.createElement('div');
    chips.className = 'grid grid-cols-2 gap-2';
    const chip = (label, value) => {
      const el = document.createElement('div');
      el.className = 'rounded-xl bg-slate-800/70 ring-1 ring-white/10 px-3 py-2 flex flex-col';
      el.innerHTML =
        '<span class="text-[10px] font-bold uppercase tracking-widest text-slate-400">' + label + '</span>' +
        '<span class="text-xl font-black tabular-nums">' + value + '</span>';
      return el;
    };
    chips.appendChild(chip('Races Won', s.racesWon));
    chips.appendChild(chip('Cups Won', s.cupsWon));
    chips.appendChild(chip('Best Trick', s.longestCombo > 0 ? '+' + s.longestCombo : '—'));
    chips.appendChild(chip('Coins', s.totals.coins));
    chips.appendChild(chip('Drifts', s.totals.drifts));
    chips.appendChild(chip('Tricks', s.totals.tricks));
    body.appendChild(chips);

    // --- COMPLETION WALL: gold laps, cup-trophy wall, nearest gold gap. -------
    // The "why come back" panel: how close you are to 100%-ing the game.
    const completion = document.createElement('div');
    completion.className = 'flex flex-col gap-2';

    const trackIds = getTrackIds();
    // Count gold lap medals + find the most achievable next gold (smallest gap).
    let golds = 0;
    let nearest = null; // { name, gap } — closest non-gold lap to its gold target
    for (const id of trackIds) {
      const targets = TARGET_LAP_TIMES[id];
      const best = s.bestLaps[id];
      const medal = best != null ? medalFor(best, targets) : null;
      if (medal === 'gold') { golds += 1; continue; }
      if (best != null && targets && Number.isFinite(targets.gold)) {
        const gap = best - targets.gold; // seconds over the gold target
        if (gap > 0 && (!nearest || gap < nearest.gap)) {
          nearest = { name: getTrackMeta(id).name, gap };
        }
      }
    }

    // Gold-laps tally.
    const goldLine = document.createElement('div');
    goldLine.className =
      'rounded-xl bg-yellow-500/10 ring-1 ring-yellow-400/30 px-3 py-2 flex items-center justify-between';
    goldLine.innerHTML =
      '<span class="text-[10px] font-bold uppercase tracking-widest text-yellow-200">Gold Laps</span>' +
      '<span class="text-base font-black tabular-nums text-yellow-100">🥇 ' + golds + ' / ' + trackIds.length + '</span>';
    completion.appendChild(goldLine);

    // Cup-trophy wall: one cell per engine class — its trophy, an open dash, or a
    // padlock if the class isn't unlocked yet (from unlockedTier + cupTrophies).
    const wall = document.createElement('div');
    wall.className = 'rounded-xl bg-slate-800/70 ring-1 ring-white/10 px-3 py-2 flex flex-col gap-1';
    const wallLabel = document.createElement('div');
    wallLabel.className = 'text-[10px] font-bold uppercase tracking-widest text-slate-400';
    wallLabel.textContent = 'Cup Trophies';
    wall.appendChild(wallLabel);
    const wallRow = document.createElement('div');
    wallRow.className = 'flex items-stretch justify-between gap-2';
    for (let i = 0; i < TIER_IDS.length; i++) {
      const id = TIER_IDS[i];
      const medal = s.cupTrophies[id];
      const locked = i > (s.unlockedTier || 0);
      const mark = medal ? MEDAL_EMOJI[medal] : (locked ? '🔒' : '—');
      const cell = document.createElement('div');
      cell.className = 'flex-1 flex flex-col items-center gap-0.5' + (locked ? ' opacity-50' : '');
      cell.innerHTML =
        '<span class="text-xl leading-none">' + mark + '</span>' +
        '<span class="text-[10px] font-bold tracking-wide text-slate-300">' + CC_LABELS[id] + '</span>';
      wallRow.appendChild(cell);
    }
    wall.appendChild(wallRow);
    completion.appendChild(wall);

    // Nearest gold-medal gap — the most achievable next gold, to chase.
    if (nearest) {
      const gapLine = document.createElement('div');
      gapLine.className = 'rounded-xl bg-cyan-500/10 ring-1 ring-cyan-400/30 px-3 py-2 text-xs font-semibold text-cyan-200';
      gapLine.textContent = '🎯 ' + nearest.gap.toFixed(2) + 's from gold on ' + nearest.name;
      completion.appendChild(gapLine);
    } else if (golds === trackIds.length && trackIds.length > 0) {
      const gapLine = document.createElement('div');
      gapLine.className = 'rounded-xl bg-emerald-500/10 ring-1 ring-emerald-400/30 px-3 py-2 text-xs font-semibold text-emerald-200';
      gapLine.textContent = '✨ Every track golded — flawless!';
      completion.appendChild(gapLine);
    }

    body.appendChild(completion);

    // Nearest cosmetic unlock (smallest remaining count) across all parts.
    let next = null;
    for (const item of [...CHARACTERS, ...KART_BODIES, ...WHEELS]) {
      if (isUnlocked(item, s)) continue;
      // Coin-shop items are bought, not won — they have no `unlock` threshold, so
      // skip them here (the SHOP button is where you get them).
      if (!item.unlock) continue;
      const remaining = item.unlock.threshold - (s[item.unlock.stat] ?? 0);
      if (!next || remaining < next.remaining) next = { name: item.name, remaining, stat: item.unlock.stat };
    }
    if (next) {
      const noun = UNLOCK_NOUN[next.stat] || next.stat;
      const line = document.createElement('div');
      line.className = 'rounded-xl bg-amber-500/10 ring-1 ring-amber-400/30 px-3 py-2 text-xs font-semibold text-amber-200';
      line.textContent = `🔒 Next unlock: ${next.name} — ${next.remaining} more ${noun}${next.remaining === 1 ? '' : 's'}`;
      body.appendChild(line);
    }

    // Best-lap rows per track (name + medal + time).
    const lapsLabel = document.createElement('div');
    lapsLabel.className = 'text-xs font-bold uppercase tracking-widest text-slate-400 mt-1';
    lapsLabel.textContent = 'Best Laps';
    body.appendChild(lapsLabel);

    const list = document.createElement('div');
    list.className = 'flex flex-col gap-1.5';
    for (const id of getTrackIds()) {
      const meta = getTrackMeta(id);
      const best = s.bestLaps[id];
      const medal = best != null ? medalFor(best, TARGET_LAP_TIMES[id]) : null;
      const chipColor = '#' + (meta.color & 0xffffff).toString(16).padStart(6, '0');
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 rounded-xl bg-slate-800/60 ring-1 ring-white/10 px-3 py-2';
      row.innerHTML =
        '<span class="w-4 h-4 rounded-full ring-2 ring-white/30 shrink-0" style="background-color:' + chipColor + '"></span>' +
        '<span class="flex-1 font-semibold tracking-wide">' + meta.name + '</span>' +
        '<span class="text-lg leading-none">' + (medal ? MEDAL_EMOJI[medal] : '') + '</span>' +
        '<span class="text-sm font-mono tabular-nums opacity-85 w-24 text-right">' +
          (best != null ? this._formatTime(best) : '--:--.---') + '</span>';
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  /** Open the records panel (repopulating it first), with a small pop-in. */
  _openRecords() {
    this._renderRecords();
    this._recordsPanel.style.display = 'flex';
    gsap.from(this._recordsPanel.firstChild, {
      opacity: 0, scale: 0.92, y: 16, duration: 0.32, ease: 'back.out(1.5)',
    });
  }

  /** Close the records panel. */
  _closeRecords() {
    this._recordsPanel.style.display = 'none';
  }

  /**
   * Format a lap time as mm:ss.mmm (matches the HUD / results board). Dashed
   * placeholder for a missing time.
   * @param {number} seconds
   * @returns {string}
   * @private
   */
  _formatTime(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '--:--.---';
    const totalMs = Math.max(0, Math.floor(seconds * 1000));
    const minutes = Math.floor(totalMs / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return String(minutes).padStart(2, '0') + ':' +
      String(secs).padStart(2, '0') + '.' +
      String(millis).padStart(3, '0');
  }

  /**
   * Show the menu overlay (and make it interactive), then play a short GSAP
   * entrance animation: the title and subtitle fade + slide down from above,
   * then the four buttons stagger in from below. This is purely cosmetic — the
   * menu is fully usable the instant it appears, and the API is unchanged.
   */
  show() {
    this.element.style.display = 'flex';

    // Build the list of targets to animate. We guard each one in case the menu
    // was constructed differently, so a missing element never breaks show().
    const headerTargets = [this._title, this._subtitle].filter(Boolean);
    const buttonTargets = (this._buttons || []).filter(Boolean);

    // gsap.from() animates FROM the given start values TO each element's current
    // (final) CSS values — so after the tween everything sits exactly where the
    // layout already placed it, with no lingering inline transforms to undo.

    // Title + subtitle: fade in while dropping down a little.
    if (headerTargets.length) {
      gsap.from(headerTargets, {
        opacity: 0,
        y: -40,
        duration: 0.6,
        ease: 'power3.out',
        stagger: 0.1,
      });
    }

    // Buttons: rise up and fade in, staggered one after another, starting a beat
    // after the title so the sequence reads top-to-bottom.
    if (buttonTargets.length) {
      gsap.from(buttonTargets, {
        opacity: 0,
        y: 30,
        duration: 0.5,
        ease: 'back.out(1.6)',
        stagger: 0.08,
        delay: 0.25,
        // clearProps removes the inline transform/opacity GSAP added once the
        // tween finishes, so the buttons' own hover/active scale transforms work
        // normally afterward (no leftover inline style fighting Tailwind).
        clearProps: 'opacity,transform',
      });
    }
  }

  /** Hide the menu overlay (clicks then fall through to the game). */
  hide() {
    this.element.style.display = 'none';
  }

  /** Remove the menu from the DOM entirely (optional cleanup). */
  dispose() {
    if (this._wordmarkTween) { this._wordmarkTween.kill(); this._wordmarkTween = null; }
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    if (this._recordsPanel && this._recordsPanel.parentNode) {
      this._recordsPanel.parentNode.removeChild(this._recordsPanel);
    }
  }
}
