// src/ui/screens/CoinShop.js
//
// The COIN SHOP: spend the coins you earn racing on cosmetic unlocks. A plain
// HTML/CSS overlay (NO three.js) styled with Tailwind, matching the Menu and
// CharacterSelect look — full-screen, scrollable, gold-accented.
//
// It reuses the existing customization data + unlock plumbing rather than adding
// any new system:
//   - getStats()              -> the persisted wallet (coinBalance) + bought ids.
//   - isUnlocked(item, stats) -> already coin-aware: a `coinsPrice` item is locked
//                                until its id is in stats.bought (see playerStats).
//   - buyItem(id, price)      -> atomic spend-and-mark; persists the purchase.
// Buying flips isUnlocked() true everywhere, so CharacterSelect (which reads the
// same isUnlocked) shows the item unlocked with no shop-specific wiring.
//
// Each cosmetic falls into one of three states on a card:
//   - OWNED        : free defaults, won items, or already-bought coin items -> "✓ Owned".
//   - BUYABLE      : a `coinsPrice` item not yet bought -> a BUY <price> 💰 button
//                    (disabled + dimmed when the wallet can't afford it).
//   - WIN-LOCKED   : a win-gated item not yet earned -> 🔒 + its unlock hint
//                    (not purchasable here; earned by racing).
//
// API mirrors the other screens so main.js wires it the same way:
//   show()  reveal + repopulate from the latest stats.
//   hide()  tuck it away.

import gsap from 'gsap';

import { getStats, isUnlocked, buyItem } from '../../data/playerStats.js';
import { CHARACTERS } from '../../data/characters.js';
import { KART_BODIES, WHEELS } from '../../data/karts.js';

// Singular noun per win-unlock stat, for the locked hint ("Earn 3 wins").
const UNLOCK_NOUN = { racesWon: 'win', cupsWon: 'cup' };

// Human hint for a win-gated item, e.g. "Earn 1 cup" / "Earn 3 wins".
function winHint(item) {
  const u = item && item.unlock;
  if (!u) return '';
  const noun = UNLOCK_NOUN[u.stat] || u.stat;
  return `Earn ${u.threshold} ${noun}${u.threshold === 1 ? '' : 's'}`;
}

// Characters store `color` as a hex INT; the swatch needs a CSS string.
function toCssColor(color) {
  if (typeof color === 'number') {
    return '#' + (color & 0xffffff).toString(16).padStart(6, '0');
  }
  return color || '#888888';
}

export class CoinShop {
  /**
   * @param {Object} opts
   * @param {Function} [opts.onBack]  Called when BACK is clicked (return to menu).
   */
  constructor({ onBack } = {}) {
    this._onBack = onBack || (() => {});
    this._build();

    // Start hidden until show() is called; attach once.
    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  /** Build the overlay shell once (header + body container). @private */
  _build() {
    // --- Root overlay (mirrors CharacterSelect) ---------------------------
    this.element = document.createElement('div');
    this.element.id = 'coin-shop-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-30',
      'pointer-events-auto',
      'flex', 'flex-col', 'items-center',
      'select-none', 'text-white',
      'overflow-y-auto',
      'bg-gradient-to-b', 'from-slate-900', 'via-slate-800', 'to-slate-900',
    ].join(' ');

    // --- Header: title + balance + back ----------------------------------
    const header = document.createElement('div');
    header.className = 'w-full max-w-5xl px-6 pt-8 pb-4 flex items-center justify-between gap-4';

    const heading = document.createElement('h1');
    heading.textContent = 'COIN SHOP';
    heading.className = [
      'text-3xl', 'md:text-5xl', 'font-black', 'tracking-tight',
      'bg-gradient-to-r', 'from-amber-300', 'via-yellow-400', 'to-amber-500',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_4px_24px_rgba(0,0,0,0.5)]',
    ].join(' ');
    header.appendChild(heading);

    // Wallet balance pill (gold), refreshed on every _render().
    this._balanceEl = document.createElement('div');
    this._balanceEl.className = [
      'ml-auto', 'flex', 'items-center', 'gap-2',
      'px-4', 'py-2', 'rounded-full',
      'bg-amber-500/15', 'ring-1', 'ring-amber-300/40',
      'text-amber-200', 'font-bold', 'text-lg', 'tabular-nums',
    ].join(' ');
    header.appendChild(this._balanceEl);

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

    // --- Subtitle ---------------------------------------------------------
    const sub = document.createElement('p');
    sub.textContent = 'Spend the coins you collect racing on new racers, bodies, and wheels.';
    sub.className = 'w-full max-w-5xl px-6 -mt-2 mb-2 text-sm text-slate-400';
    this.element.appendChild(sub);

    // --- Body: repopulated by _render() on every open --------------------
    this._body = document.createElement('div');
    this._body.className = 'w-full max-w-5xl px-6 pb-24 flex flex-col gap-8';
    this.element.appendChild(this._body);
  }

  /** Repopulate the balance + the three category grids from the latest stats. @private */
  _render() {
    const s = getStats();
    this._balanceEl.textContent = '💰 ' + s.coinBalance;
    this._body.innerHTML = '';
    this._body.appendChild(this._section('RACERS', CHARACTERS, s, { isChar: true }));
    this._body.appendChild(this._section('KART BODIES', KART_BODIES, s, { icon: '🏎️' }));
    this._body.appendChild(this._section('WHEELS', WHEELS, s, { icon: '🛞' }));
  }

  /**
   * Build one labelled category section (title + a responsive grid of cards).
   * @private
   */
  _section(title, items, stats, opts) {
    const section = document.createElement('div');

    const label = document.createElement('h2');
    label.textContent = title;
    label.className = 'text-xs font-bold tracking-[0.2em] uppercase text-slate-400 mb-3';
    section.appendChild(label);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';
    for (const item of items) grid.appendChild(this._card(item, stats, opts));
    section.appendChild(grid);

    return section;
  }

  /**
   * Build one cosmetic card: swatch/icon + name, and an owned tag / BUY button /
   * win-locked hint depending on the item's state.
   * @private
   */
  _card(item, stats, { isChar = false, icon = '' } = {}) {
    const owned = isUnlocked(item, stats);

    const card = document.createElement('div');
    card.className = [
      'flex', 'items-center', 'gap-3',
      'rounded-xl', 'p-3',
      'bg-white/5', 'ring-1', 'ring-white/10',
    ].join(' ');

    // Swatch (characters) or generic part icon (bodies/wheels).
    const swatch = document.createElement('span');
    if (isChar) {
      swatch.className = 'w-8 h-8 rounded-full ring-2 ring-white/30 shrink-0';
      swatch.style.backgroundColor = toCssColor(item.color);
      if (!owned) swatch.classList.add('grayscale');
    } else {
      swatch.className = 'w-8 h-8 flex items-center justify-center text-2xl leading-none shrink-0';
      swatch.textContent = icon;
      if (!owned) swatch.classList.add('opacity-40');
    }
    card.appendChild(swatch);

    // Name (+ a sub-line for the price/hint when not owned).
    const text = document.createElement('span');
    text.className = 'flex flex-col min-w-0 flex-1';
    const name = document.createElement('span');
    name.textContent = item.name;
    name.className = 'text-sm font-semibold truncate' + (owned ? '' : ' text-slate-300');
    text.appendChild(name);
    card.appendChild(text);

    if (owned) {
      // Already available (free / won / bought) — show an owned tag.
      const tag = document.createElement('span');
      tag.textContent = '✓ Owned';
      tag.className = 'shrink-0 text-[11px] font-bold uppercase tracking-wide text-emerald-300';
      card.appendChild(tag);
    } else if (item.coinsPrice != null) {
      // Coin-buyable: a BUY button, disabled + dimmed when too poor.
      const price = item.coinsPrice;
      const canAfford = stats.coinBalance >= price;
      const buy = document.createElement('button');
      buy.type = 'button';
      buy.textContent = 'BUY ' + price + ' 💰';
      buy.className = [
        'shrink-0', 'px-3', 'py-2', 'rounded-xl',
        'text-xs', 'font-bold', 'tracking-wide', 'uppercase',
        'bg-gradient-to-r', 'from-amber-400', 'to-yellow-500',
        'hover:from-amber-300', 'hover:to-yellow-400',
        'text-slate-900', 'shadow-lg', 'shadow-black/30',
        'transition', 'duration-150',
        'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
      ].join(' ');
      if (!canAfford) {
        buy.disabled = true;
        buy.classList.add('opacity-40', 'cursor-not-allowed');
        buy.classList.remove('hover:scale-[1.03]');
      } else {
        buy.classList.add('hover:scale-[1.04]', 'active:scale-[0.97]');
        buy.addEventListener('click', () => this._buy(item));
      }
      card.appendChild(buy);
    } else {
      // Win-gated and not yet earned: locked hint (earned by racing, not bought).
      const hint = document.createElement('span');
      hint.textContent = '🔒 ' + winHint(item);
      hint.className = 'shrink-0 text-[11px] font-medium text-amber-300/90 text-right';
      card.appendChild(hint);
    }

    return card;
  }

  /**
   * Attempt to buy `item`. On success, repopulate (so the balance drops, the card
   * flips to "Owned", and any now-affordable cards re-enable) and pulse the wallet.
   * @private
   */
  _buy(item) {
    if (buyItem(item.id, item.coinsPrice)) {
      this._render();
      gsap.fromTo(
        this._balanceEl,
        { scale: 1.25 },
        { scale: 1, duration: 0.35, ease: 'back.out(3)' }
      );
    }
  }

  /** Show the shop (repopulating from the latest stats first), with a short pop-in. */
  show() {
    this._render();
    this.element.style.display = 'flex';
    gsap.from(this.element.firstChild, {
      opacity: 0, y: -20, duration: 0.35, ease: 'power3.out',
    });
  }

  /** Hide the shop overlay. */
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
