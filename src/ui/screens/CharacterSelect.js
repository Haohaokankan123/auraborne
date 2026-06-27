// src/ui/screens/CharacterSelect.js
//
// The character / kart customization screen. It sits between the main Menu and
// the start of a race: the player picks a CHARACTER, a KART BODY and a set of
// WHEELS, watches the live stat bars react to those choices, and then confirms.
//
// Like Menu and HUD this is a plain HTML/CSS overlay (NO three.js) styled with
// Tailwind utility classes. Its root sets `pointer-events-auto` so it receives
// clicks, and a high z-index so it sits above the canvas and HUD.
//
// DATA CONTRACT (consumed, owned by the data agent in src/data/*):
//   CHARACTERS  : Array<{ id, name, color, stats }>
//                 - id     : string unique key
//                 - name   : string display name
//                 - color  : CSS color string (kart body tint / swatch)
//                 - stats  : partial stat profile contributed by the character
//   KART_BODIES : Array<{ id, name, stats }>   kart-body parts to pick from
//   WHEELS      : Array<{ id, name, stats }>   wheel sets to pick from
//   combineStats(character, body, wheels) -> full stat profile:
//                 { topSpeed, accel, handling, weight, traction, miniTurbo }
//                 each a number ~0.0..1.0 (0 = min, 1 = max).
//
// PRODUCES (the selection object passed to onConfirm):
//   { character, body, wheels, color, stats }
//     - character : the chosen CHARACTERS entry (full object)
//     - body      : the chosen KART_BODIES entry (full object)
//     - wheels    : the chosen WHEELS entry (full object)
//     - color     : the character's color string (convenience for kart tint)
//     - stats     : the combined full stat profile (the STATS CONTRACT shape)
//
// The race/menu wiring (integration agent) hands this { stats, color, ... }
// straight to createKartState({ stats }) so the kart drives to its profile.

// The data agent shipped a single karts.js (bodies + wheels + combineStats) and
// characters.js. The original spec expected separate kartBodies/wheels/stats
// files; these imports are pointed at the files that actually exist.
import { CHARACTERS } from '../../data/characters.js';
import { KART_BODIES, WHEELS, combineStats } from '../../data/karts.js';
import { getStats, isUnlocked } from '../../data/playerStats.js';

// Singular noun per unlock stat, for the lock hint ("Unlock at 3 wins").
const UNLOCK_NOUN = { racesWon: 'win', cupsWon: 'cup' };

// Human hint for a locked item, e.g. "Unlock at 1 cup" / "Unlock at 3 wins".
// '' for items with no unlock field (never shown).
function unlockHint(item) {
  const u = item && item.unlock;
  if (!u) return '';
  const noun = UNLOCK_NOUN[u.stat] || u.stat;
  return `Unlock at ${u.threshold} ${noun}${u.threshold === 1 ? '' : 's'}`;
}

// Index of the first unlocked entry in a list, or 0 (its first item is always
// available — defaults carry no unlock field). Keeps the default pick legal.
function firstUnlocked(list, stats) {
  const i = list.findIndex((item) => isUnlocked(item, stats));
  return i === -1 ? 0 : i;
}

// Characters store `color` as a hex INT (0xRRGGBB) for the THREE renderer. The
// swatch needs a CSS color string, so convert ints to '#rrggbb' for display.
// Anything already a string is passed through untouched.
function toCssColor(color) {
  if (typeof color === 'number') {
    return '#' + (color & 0xffffff).toString(16).padStart(6, '0');
  }
  return color;
}

// The six stats we render as live bars, in display order. Each entry maps the
// stat profile KEY to a human LABEL. Keep this in sync with the STATS CONTRACT.
const STAT_ROWS = [
  { key: 'topSpeed', label: 'Speed' },
  { key: 'accel', label: 'Accel' },
  { key: 'handling', label: 'Handling' },
  { key: 'weight', label: 'Weight' },
  { key: 'traction', label: 'Traction' },
  { key: 'miniTurbo', label: 'Mini-Turbo' },
];

export class CharacterSelect {
  /**
   * @param {Object} opts
   * @param {Function} [opts.onConfirm]  Called with the selection object when
   *                                     CONFIRM is clicked:
   *                                     { character, body, wheels, color, stats }.
   * @param {Function} [opts.onBack]     Called when BACK is clicked (return to menu).
   */
  constructor({ onConfirm, onBack } = {}) {
    // Default to no-ops so a missing handler never throws.
    this._onConfirm = onConfirm || (() => {});
    this._onBack = onBack || (() => {});

    // Snapshot the player's stats for the initial build; show() re-syncs via
    // _syncUnlocks() so unlocks earned mid-session appear without a reload (this
    // screen is a reused singleton). _unlockSig tracks the last-seen milestone.
    this._stats = getStats();
    this._unlockSig = (this._stats.racesWon || 0) + '/' + (this._stats.cupsWon || 0) + '/' + (Array.isArray(this._stats.bought) ? this._stats.bought.length : 0);

    // Current selection indices. Default to the first UNLOCKED entry of each so
    // there is always a valid, selectable selection to confirm.
    this._charIndex = firstUnlocked(CHARACTERS, this._stats);
    this._bodyIndex = firstUnlocked(KART_BODIES, this._stats);
    this._wheelIndex = firstUnlocked(WHEELS, this._stats);

    // Will hold the per-stat bar fill + value elements so update() can mutate
    // them in place without rebuilding the DOM. Keyed by stat key.
    this._statBars = {};

    this._build();

    // Start hidden until show() is called, so the caller controls timing.
    this.element.style.display = 'none';
    document.body.appendChild(this.element);

    // Render the initial selection (highlights + stat bars).
    this._refresh();
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  /** Build the full overlay once. @private */
  _build() {
    // --- Root overlay -----------------------------------------------------
    this.element = document.createElement('div');
    this.element.id = 'character-select-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-30',
      'pointer-events-auto',
      'flex', 'flex-col', 'items-center',
      'select-none', 'text-white',
      'overflow-y-auto',
      'bg-gradient-to-b', 'from-slate-900', 'via-slate-800', 'to-slate-900',
    ].join(' ');

    // --- Header -----------------------------------------------------------
    const header = document.createElement('div');
    header.className = 'w-full max-w-5xl px-6 pt-8 pb-4 flex items-center justify-between';

    const heading = document.createElement('h1');
    heading.textContent = 'CHOOSE YOUR RACER';
    heading.className = [
      'text-3xl', 'md:text-5xl', 'font-black', 'tracking-tight',
      'bg-gradient-to-r', 'from-amber-400', 'via-rose-500', 'to-indigo-500',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_4px_24px_rgba(0,0,0,0.5)]',
    ].join(' ');
    header.appendChild(heading);

    // BACK button (top-right) returns to the menu.
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.textContent = '← BACK';
    backBtn.className = [
      'px-4', 'py-2', 'rounded-xl',
      'text-sm', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-white/10', 'hover:bg-white/20',
      'transition', 'duration-150',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    backBtn.addEventListener('click', () => this._onBack());
    header.appendChild(backBtn);

    this.element.appendChild(header);

    // --- Body: two columns (pickers on the left, stats on the right) ------
    const body = document.createElement('div');
    body.className = [
      'w-full', 'max-w-5xl', 'px-6', 'pb-28',
      'grid', 'grid-cols-1', 'lg:grid-cols-3', 'gap-6',
    ].join(' ');

    // Left + middle: the three pickers (span 2 columns on large screens).
    const pickers = document.createElement('div');
    pickers.className = 'lg:col-span-2 flex flex-col gap-6';

    // Character grid.
    // Keep refs to each picker body so _syncUnlocks() can rebuild them in place
    // when the player earns an unlock mid-session (this screen is a reused
    // singleton, so stats can advance between shows).
    this._charGridEl = this._buildCharacterGrid();
    this._bodyPickerEl = this._buildBodyPicker();
    this._wheelPickerEl = this._buildWheelPicker();
    pickers.appendChild(this._makeSection('CHARACTER', this._charGridEl));
    pickers.appendChild(this._makeSection('KART BODY', this._bodyPickerEl));
    pickers.appendChild(this._makeSection('WHEELS', this._wheelPickerEl));

    body.appendChild(pickers);

    // Right: live stat bars panel.
    body.appendChild(this._buildStatsPanel());

    this.element.appendChild(body);

    // --- Sticky footer: CONFIRM ------------------------------------------
    const footer = document.createElement('div');
    footer.className = [
      'fixed', 'bottom-0', 'inset-x-0', 'z-40',
      'flex', 'justify-center',
      'px-6', 'py-4',
      'bg-gradient-to-t', 'from-slate-950/95', 'to-transparent',
    ].join(' ');

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'CONFIRM';
    confirmBtn.className = [
      'w-72', 'py-4', 'rounded-2xl',
      'text-xl', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-gradient-to-r', 'from-amber-500', 'to-orange-600',
      'hover:from-amber-400', 'hover:to-orange-500',
      'shadow-lg', 'shadow-black/40',
      'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    confirmBtn.addEventListener('click', () => this._onConfirm(this.getSelection()));
    footer.appendChild(confirmBtn);

    this.element.appendChild(footer);
  }

  /**
   * Wrap a labelled section (title + content card).
   * @param {string} title
   * @param {HTMLElement} content
   * @returns {HTMLElement}
   * @private
   */
  _makeSection(title, content) {
    const section = document.createElement('div');

    const label = document.createElement('h2');
    label.textContent = title;
    label.className = 'text-xs font-bold tracking-[0.2em] uppercase text-slate-400 mb-3';
    section.appendChild(label);

    const card = document.createElement('div');
    card.className = 'rounded-2xl bg-white/5 ring-1 ring-white/10 p-4';
    card.appendChild(content);
    section.appendChild(card);

    return section;
  }

  /**
   * Build the character grid: each cell shows a color swatch + name and is
   * clickable to select that character.
   * @returns {HTMLElement}
   * @private
   */
  _buildCharacterGrid() {
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 sm:grid-cols-3 gap-3';

    // Remember the cell elements so _refresh() can toggle the selected ring.
    this._charCells = [];

    CHARACTERS.forEach((char, i) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = [
        'flex', 'items-center', 'gap-3',
        'rounded-xl', 'p-3',
        'bg-white/5', 'hover:bg-white/10',
        'ring-1', 'ring-transparent',
        'transition', 'duration-150',
        'focus:outline-none',
      ].join(' ');

      // Color swatch — a round chip filled with the character's color.
      const swatch = document.createElement('span');
      swatch.className = 'w-7 h-7 rounded-full ring-2 ring-white/30 shrink-0';
      swatch.style.backgroundColor = toCssColor(char.color);
      cell.appendChild(swatch);

      // Name (+ unlock hint when locked) stacked in a column.
      const text = document.createElement('span');
      text.className = 'flex flex-col min-w-0';
      const name = document.createElement('span');
      name.textContent = char.name;
      name.className = 'text-sm font-semibold truncate';
      text.appendChild(name);
      cell.appendChild(text);

      const unlocked = isUnlocked(char, this._stats);
      if (unlocked) {
        cell.addEventListener('click', () => {
          this._charIndex = i;
          this._refresh();
        });
      } else {
        // Locked: dim, disable clicks, show 🔒 + a hint line under the name.
        cell.disabled = true;
        cell.classList.add('opacity-40', 'cursor-not-allowed');
        swatch.classList.add('grayscale');
        const hint = document.createElement('span');
        hint.textContent = unlockHint(char);
        hint.className = 'text-[10px] font-medium text-amber-300/90 truncate';
        text.appendChild(hint);
        const lock = document.createElement('span');
        lock.textContent = '🔒';
        lock.className = 'ml-auto text-sm shrink-0';
        cell.appendChild(lock);
      }

      this._charCells.push(cell);
      grid.appendChild(cell);
    });

    return grid;
  }

  /**
   * Build the kart-body picker — a row of selectable chips.
   * @returns {HTMLElement}
   * @private
   */
  _buildBodyPicker() {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-2';

    this._bodyChips = [];
    KART_BODIES.forEach((bodyPart, i) => {
      const chip = this._makeChip(bodyPart.name, () => {
        this._bodyIndex = i;
        this._refresh();
      }, bodyPart);
      this._bodyChips.push(chip);
      row.appendChild(chip);
    });

    return row;
  }

  /**
   * Build the wheels picker — a row of selectable chips.
   * @returns {HTMLElement}
   * @private
   */
  _buildWheelPicker() {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-2';

    this._wheelChips = [];
    WHEELS.forEach((wheel, i) => {
      const chip = this._makeChip(wheel.name, () => {
        this._wheelIndex = i;
        this._refresh();
      }, wheel);
      this._wheelChips.push(chip);
      row.appendChild(chip);
    });

    return row;
  }

  /**
   * A reusable selectable chip button (used for bodies + wheels). A locked item
   * is dimmed, shows 🔒 + an unlock hint, and ignores clicks.
   * @param {string} label
   * @param {Function} onClick
   * @param {{unlock?:Object}} [item]  the part, to gate on isUnlocked().
   * @returns {HTMLButtonElement}
   * @private
   */
  _makeChip(label, onClick, item) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = [
      'px-4', 'py-2', 'rounded-xl',
      'text-sm', 'font-semibold',
      'bg-white/5', 'hover:bg-white/10',
      'ring-1', 'ring-transparent',
      'transition', 'duration-150',
      'focus:outline-none',
    ].join(' ');

    if (isUnlocked(item, this._stats)) {
      chip.textContent = label;
      chip.addEventListener('click', onClick);
    } else {
      chip.disabled = true;
      chip.classList.add('opacity-40', 'cursor-not-allowed', 'flex', 'flex-col', 'items-start', 'gap-0.5');
      const top = document.createElement('span');
      top.textContent = label + ' 🔒';
      chip.appendChild(top);
      const hint = document.createElement('span');
      hint.textContent = unlockHint(item);
      hint.className = 'text-[10px] font-medium text-amber-300/90';
      chip.appendChild(hint);
    }
    return chip;
  }

  /**
   * Build the live stats panel — six labelled bars that fill 0..100% from the
   * combined stat profile. update() / _refresh() mutate the fill widths.
   * @returns {HTMLElement}
   * @private
   */
  _buildStatsPanel() {
    const panel = document.createElement('div');
    panel.className = 'rounded-2xl bg-white/5 ring-1 ring-white/10 p-5 h-fit lg:sticky lg:top-8';

    const title = document.createElement('h2');
    title.textContent = 'STATS';
    title.className = 'text-xs font-bold tracking-[0.2em] uppercase text-slate-400 mb-4';
    panel.appendChild(title);

    STAT_ROWS.forEach(({ key, label }) => {
      const row = document.createElement('div');
      row.className = 'mb-4 last:mb-0';

      // Label + numeric readout line.
      const top = document.createElement('div');
      top.className = 'flex items-center justify-between mb-1';

      const name = document.createElement('span');
      name.textContent = label;
      name.className = 'text-xs font-semibold text-slate-300';
      top.appendChild(name);

      const value = document.createElement('span');
      value.className = 'text-xs font-mono text-slate-400 tabular-nums';
      value.textContent = '0';
      top.appendChild(value);

      row.appendChild(top);

      // Track + animated fill.
      const track = document.createElement('div');
      track.className = 'h-2.5 rounded-full bg-white/10 overflow-hidden';

      const fill = document.createElement('div');
      fill.className = [
        'h-full', 'rounded-full',
        'bg-gradient-to-r', 'from-emerald-400', 'via-amber-400', 'to-rose-500',
        'transition-[width]', 'duration-300', 'ease-out',
      ].join(' ');
      fill.style.width = '0%';
      track.appendChild(fill);

      row.appendChild(track);
      panel.appendChild(row);

      // Stash the fill + value so update() can mutate them by stat key.
      this._statBars[key] = { fill, value };
    });

    return panel;
  }

  // ---------------------------------------------------------------------------
  // Selection state + rendering
  // ---------------------------------------------------------------------------

  /**
   * Compute and return the current selection object (the PRODUCES shape).
   * @returns {{ character: Object, body: Object, wheels: Object, color: string, stats: Object }}
   */
  getSelection() {
    const character = CHARACTERS[this._charIndex];
    const body = KART_BODIES[this._bodyIndex];
    const wheels = WHEELS[this._wheelIndex];
    const stats = combineStats(character, body, wheels);
    return { character, body, wheels, color: character.color, stats };
  }

  /**
   * Re-render highlights for the current selection and push the new combined
   * stats into the bars. Called after every pick.
   * @private
   */
  _refresh() {
    // Toggle the selected ring on each character cell.
    if (this._charCells) {
      this._charCells.forEach((cell, i) => {
        const on = i === this._charIndex;
        cell.classList.toggle('ring-amber-400', on);
        cell.classList.toggle('ring-transparent', !on);
        cell.classList.toggle('bg-white/15', on);
      });
    }
    // Toggle the selected ring on body chips.
    this._highlightChips(this._bodyChips, this._bodyIndex);
    // Toggle the selected ring on wheel chips.
    this._highlightChips(this._wheelChips, this._wheelIndex);

    // Recompute stats from the current picks and update the bars.
    this.update(this.getSelection().stats);
  }

  /**
   * Apply the selected styling to one chip in a chip group.
   * @param {HTMLButtonElement[]} chips
   * @param {number} selectedIndex
   * @private
   */
  _highlightChips(chips, selectedIndex) {
    if (!chips) return;
    chips.forEach((chip, i) => {
      const on = i === selectedIndex;
      chip.classList.toggle('ring-amber-400', on);
      chip.classList.toggle('ring-transparent', !on);
      chip.classList.toggle('bg-white/15', on);
      chip.classList.toggle('text-white', on);
    });
  }

  /**
   * Push a stat profile into the live bars. Public so callers can preview an
   * external profile too; normally driven internally by _refresh().
   * @param {{topSpeed:number,accel:number,handling:number,weight:number,traction:number,miniTurbo:number}} stats
   */
  update(stats) {
    if (!stats) return;
    STAT_ROWS.forEach(({ key }) => {
      const bar = this._statBars[key];
      if (!bar) return;
      // Clamp the 0..1 stat into a safe percentage.
      const raw = typeof stats[key] === 'number' ? stats[key] : 0;
      const pct = Math.max(0, Math.min(1, raw)) * 100;
      bar.fill.style.width = pct.toFixed(0) + '%';
      // Show a 0..10 readout — friendlier than a raw 0..1 float.
      bar.value.textContent = (pct / 10).toFixed(1);
    });
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  /** Show the overlay (and make it interactive). */
  /**
   * Re-read stats and, if an unlock milestone advanced since the last show,
   * rebuild the three picker bodies in place so newly-earned items light up
   * immediately (no page reload). Cheap: a tiny static DOM, and a no-op when
   * the unlock-relevant stats (race/cup wins) haven't changed.
   * @private
   */
  _syncUnlocks() {
    const s = getStats();
    const sig = (s.racesWon || 0) + '/' + (s.cupsWon || 0) + '/' + (Array.isArray(s.bought) ? s.bought.length : 0);
    if (sig === this._unlockSig) return;
    this._unlockSig = sig;
    this._stats = s;
    const swap = (oldEl, fresh) => {
      if (oldEl && oldEl.parentNode) oldEl.parentNode.replaceChild(fresh, oldEl);
      return fresh;
    };
    this._charGridEl = swap(this._charGridEl, this._buildCharacterGrid());
    this._bodyPickerEl = swap(this._bodyPickerEl, this._buildBodyPicker());
    this._wheelPickerEl = swap(this._wheelPickerEl, this._buildWheelPicker());
    // Keep the current pick legal if it somehow points at a now-locked item.
    if (!isUnlocked(CHARACTERS[this._charIndex], s)) this._charIndex = firstUnlocked(CHARACTERS, s);
    if (!isUnlocked(KART_BODIES[this._bodyIndex], s)) this._bodyIndex = firstUnlocked(KART_BODIES, s);
    if (!isUnlocked(WHEELS[this._wheelIndex], s)) this._wheelIndex = firstUnlocked(WHEELS, s);
    this._refresh();
  }

  show() {
    this._syncUnlocks();
    this.element.style.display = 'flex';
  }

  /** Hide the overlay. */
  hide() {
    this.element.style.display = 'none';
  }

  /** Remove the overlay from the DOM entirely (optional cleanup). */
  dispose() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
