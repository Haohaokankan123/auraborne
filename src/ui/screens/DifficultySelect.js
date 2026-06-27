// src/ui/screens/DifficultySelect.js
//
// The ENGINE-CLASS PICKER screen (Round-12). After choosing a track, the player
// lands here to choose their engine class on a CC LADDER: 100cc / 150cc / 200cc.
// 100cc is always open; 150cc unlocks by winning a 100cc cup, 200cc by winning a
// 150cc cup — a locked class renders dimmed with a 'Win <prev>' gate. Like Menu.js,
// the HUD, and TrackSelect.js, it is a plain HTML/CSS overlay (NO three.js) styled
// with Tailwind utility classes, drawn above the game canvas.
//
// The difficulty it reports back is the cross-stream CONTRACT value one of
// 'easy'|'medium'|'hard'. RaceManager reads it to scale AI skill (mistakes,
// braking, aggression) — but NEVER raw top speed above the player's own max (the
// AI can match the player, never out-cruise). 'medium' is the default so a
// player who skips this screen still gets a balanced field.
//
// Clicking a card selects it (highlights it); CONFIRM reports the chosen
// difficulty back to the caller via onSelect(difficulty). A BACK button calls
// onBack().
//
// Tolerance note: both callbacks may be omitted; missing handlers default to a
// no-op so the screen never throws if something isn't wired up yet.
//
// pointer-events note: like TrackSelect.js, this overlay MUST receive clicks, so
// its root sets `pointer-events-auto` and a high z-index so it sits above the
// canvas and HUD.
//
// Polish: show() plays a short GSAP entrance — the heading fades/slides in, then
// the difficulty cards stagger up into place. GSAP is the project's chosen
// animation library and works in this vanilla-JS / Vite setup with no framework.

import gsap from 'gsap';

// The CC ladder (single source of truth) + the player's unlock progress. The
// difficulty CONTRACT id stays 'easy'|'medium'|'hard'; the ladder just surfaces it
// as 100cc / 150cc / 200cc and gates the higher classes behind cup wins.
import { CC_TIERS } from '../../ai/AIRacer.js';
import { getStats, setActiveTier } from '../../data/playerStats.js';

// --- Per-tier CARD THEME --------------------------------------------------
// Each engine class gets its own neon accent + a short blurb so the choice reads
// at a glance. Keyed by the CONTRACT id; merged onto the CC ladder below so the
// numbers (cc/label/tier) have ONE source of truth (AIRacer.CC_TIERS).
const TIER_THEME = {
  easy:   { blurb: 'Relaxed rivals — a gentle, forgiving pace to learn the lines.', accent: '#34d399', accent2: '#22d3ee' },
  medium: { blurb: 'A balanced field — a fair, competitive fight to the line.',     accent: '#facc15', accent2: '#fb923c' },
  hard:   { blurb: 'Ruthless aces — clean lines, matched to your top speed.',       accent: '#fb7185', accent2: '#f472b6' },
};

// The on-screen ladder, lowest -> highest. `tier` is the unlock index (gated vs
// playerStats.unlockedTier); `requiresLabel` is the class you must WIN to open this
// one ('Win 100cc' etc.), null for the always-open 100cc class.
const DIFFICULTIES = CC_TIERS.map((t, i) => {
  const theme = TIER_THEME[t.id] || {};
  return {
    id: t.id,                  // CONTRACT value handed back ('easy'|'medium'|'hard')
    label: t.label,            // '100cc' / '150cc' / '200cc'
    tier: t.tier,              // unlock index (0/1/2)
    requiresLabel: i > 0 ? CC_TIERS[i - 1].label : null, // lock gate text
    blurb: theme.blurb || '',
    accent: theme.accent || '#ffffff',
    accent2: theme.accent2 || '#ffffff',
  };
});

export class DifficultySelect {
  /**
   * @param {Object} opts
   * @param {Function} [opts.onSelect] Called with the chosen difficulty id when
   *   CONFIRM is clicked, e.g. onSelect('hard').
   * @param {Function} [opts.onBack]   Called when BACK is clicked.
   */
  constructor({ onSelect, onBack } = {}) {
    // Keep callbacks; default to no-ops so a missing handler never throws.
    this._onSelect = onSelect || (() => {});
    this._onBack = onBack || (() => {});

    // The currently-selected difficulty id. Seeded to the always-open 100cc class;
    // _refreshLadder() (run below + on every show) promotes it to the highest
    // UNLOCKED engine class so CONFIRM always reports a class the player can play.
    this._selectedId = 'easy';

    // Card elements, keyed by difficulty id, so selection can toggle highlights.
    this._cards = {};

    // --- Root overlay -----------------------------------------------------
    // Full-screen centered flex container, matching TrackSelect.js conventions:
    // `fixed inset-0` pins to viewport, `pointer-events-auto` takes clicks, a
    // dark gradient backdrop keeps the bright cards readable.
    this.element = document.createElement('div');
    this.element.id = 'difficulty-select-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-30',
      'pointer-events-auto',
      'flex', 'flex-col', 'items-center', 'justify-center',
      'select-none', 'text-white',
      'bg-gradient-to-b', 'from-[#0a0820]', 'via-[#0c1030]', 'to-[#04030c]',
      'p-6',
    ].join(' ');

    // --- Heading ----------------------------------------------------------
    const heading = document.createElement('h1');
    heading.textContent = 'ENGINE CLASS';
    heading.className = [
      'text-4xl', 'md:text-6xl', 'font-black', 'tracking-tight', 'mb-2',
      'bg-gradient-to-r', 'from-fuchsia-400', 'via-cyan-300', 'to-violet-400',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_0_28px_rgba(120,180,255,0.45)]',
    ].join(' ');
    this.element.appendChild(heading);
    this._heading = heading;

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Higher class = faster, fiercer rivals';
    subtitle.className = 'text-base md:text-lg text-slate-300 mb-8 tracking-widest uppercase';
    this.element.appendChild(subtitle);

    // --- Difficulty cards -------------------------------------------------
    // A responsive row of cards, one per difficulty.
    const grid = document.createElement('div');
    grid.className = 'flex flex-wrap justify-center gap-5 mb-8';

    for (const diff of DIFFICULTIES) {
      const card = this._makeCard(diff);
      grid.appendChild(card);
      this._cards[diff.id] = card;
    }
    this.element.appendChild(grid);
    // Keep cards (in order) so show() can stagger them in.
    this._cardList = DIFFICULTIES.map((d) => this._cards[d.id]);

    // Apply lock state + highlight the highest unlocked class (reads playerStats).
    this._refreshLadder();

    // --- Action buttons (BACK / CONFIRM) ----------------------------------
    const actions = document.createElement('div');
    actions.className = 'flex gap-4 w-full max-w-md';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.textContent = 'BACK';
    backBtn.className = [
      'flex-1', 'py-3', 'rounded-2xl',
      'text-lg', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-slate-700', 'hover:bg-slate-600',
      'shadow-lg', 'shadow-black/40',
      'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    backBtn.addEventListener('click', () => this._onBack());

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'START';
    confirmBtn.className = [
      'flex-[2]', 'py-3', 'rounded-2xl',
      'text-lg', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-gradient-to-r', 'from-emerald-500', 'to-teal-600',
      'hover:from-emerald-400', 'hover:to-teal-500',
      'shadow-lg', 'shadow-black/40',
      'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    confirmBtn.addEventListener('click', () => {
      // Record the chosen engine class for the session so the cup payout / trophy
      // logic knows which tier was raced (the cup object isn't threaded difficulty).
      setActiveTier(this._selectedId);
      this._onSelect(this._selectedId);
    });

    actions.appendChild(backBtn);
    actions.appendChild(confirmBtn);
    this.element.appendChild(actions);
    this._actions = actions;

    // Start hidden until show() is called, so the caller controls timing.
    this.element.style.display = 'none';

    // Attach to the page once. show()/hide() only toggle visibility after this.
    document.body.appendChild(this.element);
  }

  /**
   * Build one clickable difficulty card: big label + short blurb, themed neon.
   * @param {{id:string, label:string, blurb:string, accent:string, accent2:string}} diff
   * @returns {HTMLDivElement}
   * @private
   */
  _makeCard(diff) {
    const accent = diff.accent;
    const accent2 = diff.accent2 || accent;

    const card = document.createElement('div');
    card.dataset.difficultyId = diff.id;
    // Base card styling; selection adds a colored neon ring (see _select()). A
    // dark glassy card lets the themed accent glow read; the per-difficulty
    // accent glow is applied via inline boxShadow.
    card.className = [
      'w-56', 'min-h-[180px]', 'rounded-2xl', 'p-5', 'cursor-pointer',
      'bg-slate-900/70', 'backdrop-blur',
      'border-2', 'border-white/10',
      'transition', 'duration-200',
      'hover:scale-[1.04]',
      'flex', 'flex-col', 'items-center', 'justify-center', 'gap-3', 'text-center',
    ].join(' ');
    // Soft neon under-glow in the difficulty's accent — stronger on hover via JS.
    card.style.boxShadow = `0 8px 28px -6px ${accent}55, 0 0 0 1px ${accent}22`;
    card.addEventListener('mouseenter', () => {
      if (card._locked) return; // a gated class doesn't react to hover
      card.style.boxShadow = `0 12px 38px -4px ${accent}88, 0 0 0 1px ${accent}55`;
    });
    card.addEventListener('mouseleave', () => {
      // Restore base/selected glow (the selected card keeps a brighter ring).
      const sel = diff.id === this._selectedId;
      card.style.boxShadow = sel
        ? `0 12px 40px -2px ${accent}aa, 0 0 0 2px ${accent}`
        : `0 8px 28px -6px ${accent}55, 0 0 0 1px ${accent}22`;
    });

    // Big difficulty label with an accent gradient + glow.
    const label = document.createElement('div');
    label.textContent = diff.label;
    label.className = 'text-3xl font-black tracking-wide';
    label.style.backgroundImage = `linear-gradient(135deg, ${accent}, ${accent2})`;
    label.style.webkitBackgroundClip = 'text';
    label.style.backgroundClip = 'text';
    label.style.color = 'transparent';
    label.style.filter = `drop-shadow(0 0 14px ${accent}66)`;
    card.appendChild(label);

    // Short blurb describing how this class plays.
    const blurb = document.createElement('p');
    blurb.textContent = diff.blurb;
    blurb.className = 'text-sm text-slate-300 leading-snug';
    card.appendChild(blurb);

    // LOCK gate badge: hidden until _applyLock() reveals it for a class the player
    // hasn't earned yet — a padlock + the class they must win to open this one.
    const lock = document.createElement('div');
    lock.className = 'mt-1 flex items-center gap-1.5 text-xs font-extrabold tracking-wide text-slate-200';
    lock.style.display = 'none';
    lock.innerHTML =
      '<span class="text-base leading-none">🔒</span>' +
      '<span>' + (diff.requiresLabel ? 'Win ' + diff.requiresLabel : 'Locked') + '</span>';
    card.appendChild(lock);

    // Stash the resolved accent + ladder bookkeeping so _select()/_applyLock() can
    // paint the neon ring and gate this class.
    card._accent = accent;
    card._tier = diff.tier;
    card._lockBadge = lock;
    card._locked = false;

    // Clicking the card selects this difficulty.
    card.addEventListener('click', () => this._select(diff.id));

    return card;
  }

  /**
   * Select a difficulty: store the id and update card highlight styles.
   * @param {string} difficultyId
   * @private
   */
  _select(difficultyId) {
    // A locked engine class can't be picked — ignore the click (the card has
    // pointer-events:none too, this is just belt-and-braces).
    const target = this._cards[difficultyId];
    if (target && target._locked) return;
    this._selectedId = difficultyId;
    for (const diff of DIFFICULTIES) {
      const card = this._cards[diff.id];
      if (!card) continue;
      const selected = diff.id === difficultyId;
      const accent = card._accent || '#ffffff';
      // Lift the selected card and paint a bright neon ring + glow in its own
      // accent color, so the highlight matches the difficulty you've picked.
      card.classList.toggle('scale-[1.04]', selected);
      card.style.borderColor = selected ? accent : 'rgba(255,255,255,0.10)';
      card.style.boxShadow = selected
        ? `0 12px 40px -2px ${accent}aa, 0 0 0 2px ${accent}`
        : `0 8px 28px -6px ${accent}55, 0 0 0 1px ${accent}22`;
    }
  }

  /**
   * Re-read the unlock ladder from playerStats and apply it: dim + lock every class
   * above the player's unlocked tier, then default the selection to the HIGHEST
   * unlocked class (their current ceiling). Called from the constructor and on every
   * show() so a class unlocked since last time appears immediately.
   * @private
   */
  _refreshLadder() {
    const unlocked = getStats().unlockedTier || 0;
    for (const diff of DIFFICULTIES) {
      const card = this._cards[diff.id];
      if (!card) continue;
      this._applyLock(card, diff.tier > unlocked);
    }
    // Default to the highest unlocked engine class (the player can step down to any
    // unlocked card; a locked one can't be picked).
    const top = DIFFICULTIES[Math.min(unlocked, DIFFICULTIES.length - 1)];
    this._selectedId = top.id;
    this._select(this._selectedId);
  }

  /**
   * Toggle a card's LOCKED look: dim it, kill its pointer events (so it neither
   * hovers nor clicks), and show/hide its 'Win <prev>' gate badge.
   * @param {HTMLDivElement} card
   * @param {boolean} locked
   * @private
   */
  _applyLock(card, locked) {
    card._locked = locked;
    card.style.opacity = locked ? '0.45' : '1';
    card.style.filter = locked ? 'grayscale(0.6)' : '';
    card.style.pointerEvents = locked ? 'none' : 'auto';
    if (card._lockBadge) card._lockBadge.style.display = locked ? 'flex' : 'none';
  }

  /**
   * Show the screen (and make it interactive), then play a short GSAP entrance:
   * the heading fades/slides in, then the difficulty cards stagger up into place.
   * The screen is fully usable the instant it appears; this is cosmetic only.
   */
  show() {
    this.element.style.display = 'flex';

    // Re-apply the unlock ladder each time (the player may have just won a cup and
    // opened the next class) and reset the default selection to their top class.
    this._refreshLadder();

    if (this._heading) {
      gsap.from(this._heading, {
        opacity: 0,
        y: -30,
        duration: 0.5,
        ease: 'power3.out',
      });
    }

    const cardTargets = (this._cardList || []).filter(Boolean);
    if (cardTargets.length) {
      gsap.from(cardTargets, {
        opacity: 0,
        y: 30,
        duration: 0.5,
        ease: 'back.out(1.6)',
        stagger: 0.08,
        delay: 0.15,
        clearProps: 'opacity,transform',
      });
    }
  }

  /** Hide the screen (clicks then fall through to whatever is beneath). */
  hide() {
    this.element.style.display = 'none';
  }

  /** Remove the screen from the DOM entirely (optional cleanup). */
  dispose() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}

export default DifficultySelect;
