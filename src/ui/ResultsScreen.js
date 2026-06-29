// src/ui/ResultsScreen.js
//
// The end-of-race RESULTS BOARD: a full-screen overlay shown once the player
// finishes a Grand Prix. It lists every racer 1st..13th with their name + kart
// colour, medals on the podium, the player's row highlighted, the player's
// finish time + placement, and three buttons (Restart / Next Track / Menu).
//
// Like Menu.js / TrackSelect.js this is a plain HTML/CSS overlay (NO three.js),
// styled with Tailwind utility classes for visual consistency with the rest of
// the UI, and animated in with GSAP (the project's chosen animation library).
//
// API (mirrors the other screens so main.js wires it the same way):
//   show(results, { onRestart, onNextTrack, onMenu })  reveal the board.
//   hide()                                             tuck it away.
//
// `results` is RaceManager.getResults() output:
//   [{ place, id, name, color, isPlayer, time, coinsEarned }]  leader-first, time
//   in seconds (or null for an AI still on track); coinsEarned = coins grabbed.
//
// pointer-events note: the HUD uses pointer-events-none so clicks fall through;
// this board is the opposite — it MUST take clicks — so its root is
// pointer-events-auto with a high z-index, sitting above the canvas + HUD.

import gsap from 'gsap';

// Player stats: the cup trophy + active tier feed the champion summary line.
import { getStats, getActiveTier } from '../data/playerStats.js';

// Podium medals for the top three places (4th+ show their numeral instead).
const MEDALS = ['🥇', '🥈', '🥉'];

export class ResultsScreen {
  constructor() {
    // --- Root overlay -----------------------------------------------------
    // Full-screen flex container centering the results card, with the same dark
    // gradient backdrop as the Menu so the two screens read as one family.
    this.element = document.createElement('div');
    this.element.id = 'results-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-40',           // above canvas + HUD + menu
      'pointer-events-auto',                 // this overlay DOES take clicks
      'flex', 'flex-col', 'items-center', 'justify-center',
      'select-none', 'text-white',
      'bg-gradient-to-b', 'from-slate-900/95', 'via-slate-800/95', 'to-slate-900/95',
      'backdrop-blur-sm',
    ].join(' ');

    // --- Title ------------------------------------------------------------
    // "FINISH" headline with the menu's gradient treatment so it reads as a
    // banner, not plain text.
    this._title = document.createElement('h1');
    this._title.textContent = 'FINISH';
    this._title.className = [
      'text-5xl', 'md:text-7xl', 'font-black', 'tracking-tight', 'mb-1',
      'bg-gradient-to-r', 'from-amber-400', 'via-rose-500', 'to-indigo-500',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_4px_24px_rgba(0,0,0,0.5)]',
    ].join(' ');
    this.element.appendChild(this._title);

    // Remember the default headline treatment + a gold VICTORY variant, so show()
    // can swap to a triumphant gold 'VICTORY!' on a win and reset for other views.
    this._titleClassBase = this._title.className;
    this._titleClassVictory = [
      'text-5xl', 'md:text-7xl', 'font-black', 'tracking-tight', 'mb-1',
      'bg-gradient-to-r', 'from-amber-200', 'via-yellow-300', 'to-amber-400',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_0_34px_rgba(250,204,21,0.6)]',
    ].join(' ');

    // The player's placement + time summary, just under the title.
    this._summary = document.createElement('p');
    this._summary.className =
      'text-lg md:text-xl text-slate-200 mb-6 tracking-wide font-semibold';
    this.element.appendChild(this._summary);

    // RIVAL head-to-head sub-line (e.g. "You lead VEX 2-1"). Hidden unless a rival
    // line is set; tucked just under the summary. Shown on race + cup views.
    this._rivalLine = document.createElement('p');
    this._rivalLine.className =
      'text-sm md:text-base font-bold tracking-wide text-rose-300 mb-5 -mt-3';
    this._rivalLine.style.display = 'none';
    this.element.appendChild(this._rivalLine);

    // --- Standings list ---------------------------------------------------
    // A scrollable column of rows (1 per racer). Capped height so 13 rows fit on
    // any screen; the player's row is highlighted by _buildRow.
    this._list = document.createElement('div');
    this._list.className =
      'flex flex-col gap-1.5 w-[22rem] max-h-[52vh] overflow-y-auto pr-1 mb-6';
    this.element.appendChild(this._list);

    // --- Buttons ----------------------------------------------------------
    // Restart / Next Track / Menu, laid out in a row, each its own gradient so
    // the choices read distinct (mirrors the Menu's per-mode colours).
    const buttonRow = document.createElement('div');
    buttonRow.className = 'flex gap-3';

    this._restartBtn = this._makeButton(
      'RESTART',
      'from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500'
    );
    this._nextTrackBtn = this._makeButton(
      'NEXT TRACK',
      'from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500'
    );
    this._menuBtn = this._makeButton(
      'MENU',
      'from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500'
    );

    buttonRow.appendChild(this._restartBtn);
    buttonRow.appendChild(this._nextTrackBtn);
    buttonRow.appendChild(this._menuBtn);
    this.element.appendChild(buttonRow);
    this._buttonRow = buttonRow; // single-race button row (toggled vs the cup row)

    // CUP button row — a separate pair shown only in the cup standings/champion
    // views, so the single-race row above stays untouched. The primary button is
    // relabelled per view ("NEXT RACE" between races, "RESTART CUP" at the end).
    const cupButtonRow = document.createElement('div');
    cupButtonRow.className = 'flex gap-3';
    this._cupPrimaryBtn = this._makeButton(
      'NEXT RACE',
      'from-amber-500 to-yellow-600 hover:from-amber-400 hover:to-yellow-500'
    );
    this._cupMenuBtn = this._makeButton(
      'MENU',
      'from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500'
    );
    cupButtonRow.appendChild(this._cupPrimaryBtn);
    cupButtonRow.appendChild(this._cupMenuBtn);
    cupButtonRow.style.display = 'none';
    this.element.appendChild(cupButtonRow);
    this._cupButtonRow = cupButtonRow;

    // Callbacks are (re)bound on each show(); default to no-ops so a click before
    // wiring never throws. We attach the listeners ONCE here and call through the
    // current handler refs, so show() just swaps the refs.
    this._onRestart = () => {};
    this._onNextTrack = () => {};
    this._onMenu = () => {};
    this._onCupPrimary = () => {};
    this._restartBtn.addEventListener('click', () => this._onRestart());
    this._nextTrackBtn.addEventListener('click', () => this._onNextTrack());
    this._menuBtn.addEventListener('click', () => this._onMenu());
    this._cupPrimaryBtn.addEventListener('click', () => this._onCupPrimary());
    this._cupMenuBtn.addEventListener('click', () => this._onMenu());

    // Start hidden until show() is called.
    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  /**
   * Build one styled action button (matches Menu._makeButton's look).
   * @param {string} label
   * @param {string} gradientClasses  Tailwind gradient from/to + hover classes.
   * @returns {HTMLButtonElement}
   * @private
   */
  _makeButton(label, gradientClasses) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = [
      'px-5', 'py-3', 'rounded-2xl',
      'text-base', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-gradient-to-r', gradientClasses,
      'shadow-lg', 'shadow-black/40',
      'transition', 'duration-150',
      'hover:scale-[1.04]', 'active:scale-[0.97]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    return btn;
  }

  /**
   * Build one standings row for a result entry. The player's row is highlighted
   * (brighter card + ring); the top three get a medal, everyone else their place
   * numeral. A colour chip echoes the kart's body tint, and finished racers show
   * their total time (AI still on track show a dash).
   * @param {{place:number, name:string, color:number, isPlayer:boolean, time:number|null, coinsEarned:number}} r
   * @returns {HTMLDivElement}
   * @private
   */
  _buildRow(r) {
    const row = document.createElement('div');
    // Highlight the PLAYER's row so they spot themselves instantly. Others get a
    // calmer translucent card.
    const base =
      'flex items-center gap-3 px-3 py-2 rounded-xl ring-1 transition';
    row.className = r.isPlayer
      ? base + ' bg-cyan-500/20 ring-cyan-300/70 shadow-lg shadow-cyan-500/20'
      : base + ' bg-slate-800/60 ring-white/10';

    // Place / medal badge (fixed width so names line up).
    const place = document.createElement('span');
    place.className = 'w-9 text-center text-lg font-black tabular-nums';
    place.textContent = r.place <= 3 ? MEDALS[r.place - 1] : String(r.place);
    row.appendChild(place);

    // Kart colour chip — a round swatch in the racer's body tint.
    const chip = document.createElement('span');
    chip.className = 'w-4 h-4 rounded-full ring-2 ring-white/40 shrink-0';
    // color may be a number (0xRRGGBB) or a CSS string; normalize to a CSS hex.
    chip.style.backgroundColor = this._colorToCss(r.color);
    row.appendChild(chip);

    // Racer name (the player's reads bold + cyan to match the highlight).
    const name = document.createElement('span');
    name.className = r.isPlayer
      ? 'flex-1 font-bold tracking-wide text-cyan-200'
      : 'flex-1 font-semibold tracking-wide text-slate-100';
    name.textContent = r.name;
    row.appendChild(name);

    // RIVAL tag: mark the designated nemesis so the player can spot the foe they're
    // dueling all cup. Sits between the name and the coins column.
    if (r.rival) {
      const tag = document.createElement('span');
      tag.className =
        'px-1.5 py-0.5 rounded-md text-[10px] font-black tracking-widest uppercase ' +
        'bg-rose-500/25 text-rose-200 ring-1 ring-rose-400/50 shrink-0';
      tag.textContent = 'Rival';
      row.appendChild(tag);
    }

    // Coins this race (gold) = grabbed on track + placement payout. Fixed width +
    // only shown when non-zero so the time column lines up and zero rows stay clean.
    const coinTotal = (r.coinsEarned || 0) + (r.placeCoins || 0);
    const coins = document.createElement('span');
    coins.className = 'w-12 text-right text-sm font-semibold tabular-nums text-amber-300/90';
    coins.textContent = coinTotal > 0 ? '💰 ' + coinTotal : '';
    row.appendChild(coins);

    // Finish time (mm:ss.mmm) or a dash for racers still out on track.
    const time = document.createElement('span');
    time.className = 'text-sm font-mono tabular-nums opacity-80';
    time.textContent = r.time != null ? this._formatTime(r.time) : '—';
    row.appendChild(time);

    return row;
  }

  /**
   * Show the results board for a finished race.
   *
   * @param {Array} results  RaceManager.getResults() — leader-first ranking.
   * @param {object} handlers
   * @param {Function} [handlers.onRestart]    re-run the same race.
   * @param {Function} [handlers.onNextTrack]  open the track picker.
   * @param {Function} [handlers.onMenu]       return to the main menu.
   */
  show(results, { onRestart, onNextTrack, onMenu } = {}) {
    // (Re)bind the button handlers (no-ops if omitted).
    this._onRestart = onRestart || (() => {});
    this._onNextTrack = onNextTrack || (() => {});
    this._onMenu = onMenu || (() => {});

    // Restore the single-race look in case this instance last showed a cup or
    // battle view. (showBattle hides NEXT TRACK; restore it here so a race after a
    // battle gets the full 3-button row back.)
    this._buttonRow.style.display = 'flex';
    this._cupButtonRow.style.display = 'none';
    this._nextTrackBtn.style.display = '';

    const list = Array.isArray(results) ? results : [];
    const me = list.find((r) => r.isPlayer);

    // HEADLINE by result: a win earns a gold 'VICTORY!', the podium a 'PODIUM!',
    // anything else the plain 'FINISH'. The gold treatment only shows on a win.
    const place = me ? me.place : null;
    const isWin = place === 1;
    const isPodium = place === 2 || place === 3;
    this._title.textContent = isWin ? 'VICTORY!' : isPodium ? 'PODIUM!' : 'FINISH';
    this._title.className = isWin ? this._titleClassVictory : this._titleClassBase;

    // Player summary line: their placement (ordinal) + finish time + coins.
    if (me) {
      const timeStr = me.time != null ? this._formatTime(me.time) : '—';
      let line = 'You finished ' + this._ordinal(me.place) + ' · ' + timeStr;
      // Coins banked this race = grabbed on track + the placement payout; both feed
      // the coin-shop wallet, so surface the combined figure here.
      const coins = (me.coinsEarned || 0) + (me.placeCoins || 0);
      if (coins > 0) line += ' · +' + coins + ' coins';
      this._summary.textContent = line;
    } else {
      this._summary.textContent = 'Race complete';
    }

    // RIVAL head-to-head for THIS race (the single-race board has no cup tally).
    this._setRivalLine(this._thisRaceRivalLine(list, me));

    // Rebuild the standings rows from scratch (a race is short; this is cheap and
    // avoids stale rows from a previous race lingering). Track the player's row so
    // we can give it a shine / pulse flourish once the entrance settles.
    this._list.innerHTML = '';
    const rows = [];
    let playerRow = null;
    for (let i = 0; i < list.length; i++) {
      const row = this._buildRow(list[i]);
      this._list.appendChild(row);
      rows.push(row);
      if (list[i].isPlayer) playerRow = row;
    }

    // Reveal + animate in: the title/summary drop in, then the rows stagger up,
    // then the buttons. Purely cosmetic — the board is usable immediately.
    this.element.style.display = 'flex';
    gsap.from([this._title, this._summary, this._rivalLine].filter((el) => el && el.style.display !== 'none'), {
      opacity: 0,
      y: -30,
      duration: 0.5,
      ease: 'power3.out',
      stagger: 0.08,
    });
    if (rows.length) {
      gsap.from(rows, {
        opacity: 0,
        y: 18,
        duration: 0.4,
        ease: 'power2.out',
        stagger: 0.04,
        delay: 0.2,
        clearProps: 'opacity,transform',
      });
    }
    gsap.from([this._restartBtn, this._nextTrackBtn, this._menuBtn], {
      opacity: 0,
      y: 24,
      duration: 0.4,
      ease: 'back.out(1.6)',
      stagger: 0.06,
      delay: 0.35,
      clearProps: 'opacity,transform',
    });

    // Player-row flourish once the rows have settled: a gold shine sweep on a WIN
    // (the hero row), or a gentle pulse when you came in dead last — so the result
    // lands at a glance.
    if (playerRow) {
      if (isWin) this._shineRow(playerRow);
      else if (place != null && place === list.length) this._pulseRow(playerRow);
    }
  }

  /**
   * Show or hide the rival head-to-head sub-line under the summary.
   * @param {string} text  the line to show; falsy/empty hides it.
   * @private
   */
  _setRivalLine(text) {
    if (!this._rivalLine) return;
    if (text) {
      this._rivalLine.textContent = text;
      this._rivalLine.style.display = '';
    } else {
      this._rivalLine.style.display = 'none';
    }
  }

  /**
   * THIS-RACE head-to-head line vs the rival (for the single-race board, which has
   * no running cup tally). Empty string when there's no rival in the field.
   * @param {Array} list  the results rows.
   * @param {object|null} me  the player's row.
   * @returns {string}
   * @private
   */
  _thisRaceRivalLine(list, me) {
    if (!me) return '';
    const rival = list.find((r) => r.rival);
    if (!rival) return '';
    const name = rival.name || 'RIVAL';
    if (me.place < rival.place) return 'You beat ' + name + ' to the line';
    if (me.place > rival.place) return name + ' beat you this race';
    return 'Neck and neck with ' + name;
  }

  /**
   * CUP head-to-head line ("You lead VEX 2-1") from the cup's running tally. Empty
   * until at least one race has scored against the rival.
   * @param {GrandPrixCup} cup
   * @returns {string}
   * @private
   */
  _cupRivalLine(cup) {
    if (!cup || typeof cup.getRivalTally !== 'function') return '';
    const t = cup.getRivalTally();
    if (!t || !t.name || (t.playerWins === 0 && t.rivalWins === 0)) return '';
    if (t.playerWins > t.rivalWins) return 'You lead ' + t.name + ' ' + t.playerWins + '-' + t.rivalWins;
    if (t.playerWins < t.rivalWins) return t.name + ' leads ' + t.rivalWins + '-' + t.playerWins;
    return 'Tied with ' + t.name + ' ' + t.playerWins + '-' + t.rivalWins;
  }

  /**
   * Gold SHINE SWEEP across a row (the winner's hero row): a translucent highlight
   * bar wipes across twice. Cosmetic; safe if the row is later rebuilt.
   * @param {HTMLDivElement} row
   * @private
   */
  _shineRow(row) {
    row.style.position = 'relative';
    row.style.overflow = 'hidden';
    const shine = document.createElement('div');
    shine.style.position = 'absolute';
    shine.style.top = '0';
    shine.style.bottom = '0';
    shine.style.width = '45%';
    shine.style.pointerEvents = 'none';
    shine.style.background =
      'linear-gradient(100deg, transparent, rgba(255,240,180,0.6), transparent)';
    row.appendChild(shine);
    gsap.fromTo(
      shine,
      { xPercent: -160 },
      { xPercent: 360, duration: 1.2, ease: 'power2.inOut', repeat: 1, delay: 0.5 }
    );
  }

  /**
   * Gentle PULSE on a row (used when the player finishes last) so the eye lands on
   * their result. Delayed past the row entrance so the two tweens don't fight.
   * @param {HTMLDivElement} row
   * @private
   */
  _pulseRow(row) {
    gsap.fromTo(
      row,
      { scale: 1 },
      { scale: 1.045, duration: 0.5, ease: 'sine.inOut', repeat: 3, yoyo: true, delay: 0.9, transformOrigin: 'center' }
    );
  }

  /**
   * Build one BATTLE standings row: rank/medal + colour chip + name + the kart's
   * SCORE (★ pops landed — the win metric). Mirrors _buildRow's look so the board
   * reads consistently; the player's row is highlighted.
   * @param {{place:number, name:string, color:number|string, isPlayer:boolean,
   *          score:number, balloons:number}} r
   * @returns {HTMLDivElement}
   * @private
   */
  _buildBattleRow(r) {
    const row = document.createElement('div');
    const base = 'flex items-center gap-3 px-3 py-2 rounded-xl ring-1 transition';
    row.className = r.isPlayer
      ? base + ' bg-cyan-500/20 ring-cyan-300/70 shadow-lg shadow-cyan-500/20'
      : base + ' bg-slate-800/60 ring-white/10';

    const place = document.createElement('span');
    place.className = 'w-9 text-center text-lg font-black tabular-nums';
    place.textContent = r.place <= 3 ? MEDALS[r.place - 1] : String(r.place);
    row.appendChild(place);

    const chip = document.createElement('span');
    chip.className = 'w-4 h-4 rounded-full ring-2 ring-white/40 shrink-0';
    chip.style.backgroundColor = this._colorToCss(r.color);
    row.appendChild(chip);

    const name = document.createElement('span');
    name.className = r.isPlayer
      ? 'flex-1 font-bold tracking-wide text-cyan-200'
      : 'flex-1 font-semibold tracking-wide text-slate-100';
    name.textContent = r.name;
    row.appendChild(name);

    // ★ pops landed (the score-race headline) + balloons held at the buzzer. In the
    // respawn score race nobody is permanently eliminated, so there's no "OUT" badge —
    // a kart caught mid-respawn simply shows 🎈×0 (it would re-inflate a beat later).
    const kills = document.createElement('span');
    kills.className = 'text-sm font-bold tabular-nums text-amber-300';
    kills.textContent = '★' + (r.score || 0);
    row.appendChild(kills);

    const tally = document.createElement('span');
    tally.className = 'w-14 text-right text-base font-bold tabular-nums';
    tally.textContent = '🎈×' + Math.max(0, r.balloons || 0);
    row.appendChild(tally);

    return row;
  }

  /**
   * Show the BATTLE results board (balloon free-for-all). Ranks karts by SCORE
   * (pops landed), medals the podium, highlights the player, and shows RESTART +
   * MENU (NEXT TRACK is hidden — battles have no track picker). Reuses the
   * single-race button row + entrance so it matches the rest.
   *
   * @param {Array} results  leader-first [{place,name,color,isPlayer,score,balloons}].
   * @param {{onRestart?:Function, onMenu?:Function}} handlers
   */
  showBattle(results, { onRestart, onMenu } = {}) {
    this._onRestart = onRestart || (() => {});
    this._onNextTrack = () => {};
    this._onMenu = onMenu || (() => {});

    // Single-race button row, but hide NEXT TRACK (no track to advance to). The
    // headline (BATTLE OVER vs the gold VICTORY!) is set below once we know the place.
    this._setRivalLine(''); // battles have no rival duel
    this._buttonRow.style.display = 'flex';
    this._cupButtonRow.style.display = 'none';
    this._nextTrackBtn.style.display = 'none';

    const list = Array.isArray(results) ? results : [];
    const me = list.find((r) => r.isPlayer);
    if (me) {
      const kos = me.score || 0;
      // Score race: placing is by pops, not survival — everyone respawns.
      this._summary.textContent =
        'You placed ' + this._ordinal(me.place) +
        ' · ' + kos + ' pop' + (kos === 1 ? '' : 's');
    } else {
      this._summary.textContent = 'Battle complete';
    }

    // Headline: a gold VICTORY! when the player tops the board (most pops), else BATTLE OVER.
    const won = !!(me && me.place === 1);
    this._title.textContent = won ? 'VICTORY!' : 'BATTLE OVER';
    this._title.className = won ? this._titleClassVictory : this._titleClassBase;

    this._list.innerHTML = '';
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const row = this._buildBattleRow(list[i]);
      this._list.appendChild(row);
      rows.push(row);
    }

    this.element.style.display = 'flex';
    gsap.from([this._title, this._summary].filter(Boolean), {
      opacity: 0, y: -30, duration: 0.5, ease: 'power3.out', stagger: 0.08,
    });
    if (rows.length) {
      gsap.from(rows, {
        opacity: 0, y: 18, duration: 0.4, ease: 'power2.out',
        stagger: 0.04, delay: 0.2, clearProps: 'opacity,transform',
      });
    }
    gsap.from([this._restartBtn, this._menuBtn], {
      opacity: 0, y: 24, duration: 0.4, ease: 'back.out(1.6)',
      stagger: 0.06, delay: 0.35, clearProps: 'opacity,transform',
    });
  }

  /**
   * Build one CUP standings row: rank badge + colour chip + name + this-race
   * points earned + running cumulative total. The player's row is highlighted like
   * the single-race rows so they spot themselves instantly.
   * @param {number} rank  1-based standings position (1 = cup leader).
   * @param {{name:string, color:number|string, isPlayer:boolean,
   *          cumulativePoints:number, thisRacePoints:number}} s
   * @returns {HTMLDivElement}
   * @private
   */
  _buildCupRow(rank, s) {
    const row = document.createElement('div');
    const base = 'flex items-center gap-3 px-3 py-2 rounded-xl ring-1 transition';
    row.className = s.isPlayer
      ? base + ' bg-cyan-500/20 ring-cyan-300/70 shadow-lg shadow-cyan-500/20'
      : base + ' bg-slate-800/60 ring-white/10';

    // Standings rank (medal for the top three, numeral otherwise).
    const place = document.createElement('span');
    place.className = 'w-9 text-center text-lg font-black tabular-nums';
    place.textContent = rank <= 3 ? MEDALS[rank - 1] : String(rank);
    row.appendChild(place);

    // Kart colour chip.
    const chip = document.createElement('span');
    chip.className = 'w-4 h-4 rounded-full ring-2 ring-white/40 shrink-0';
    chip.style.backgroundColor = this._colorToCss(s.color);
    row.appendChild(chip);

    // Racer name.
    const name = document.createElement('span');
    name.className = s.isPlayer
      ? 'flex-1 font-bold tracking-wide text-cyan-200'
      : 'flex-1 font-semibold tracking-wide text-slate-100';
    name.textContent = s.name;
    row.appendChild(name);

    // Points earned THIS race (small, dimmed) — e.g. "+12".
    const gained = document.createElement('span');
    gained.className = 'text-sm font-mono tabular-nums text-amber-300/90 w-10 text-right';
    gained.textContent = '+' + s.thisRacePoints;
    row.appendChild(gained);

    // Cumulative cup total (bold, the headline number).
    const total = document.createElement('span');
    total.className = 'text-base font-black tabular-nums w-10 text-right';
    total.textContent = String(s.cumulativePoints);
    row.appendChild(total);

    return row;
  }

  /**
   * Render a CUP view (shared by the between-races standings and the final
   * champion screen). Repaints the title/summary, the standings list, and the cup
   * button row, then plays the same staggered entrance as the single-race board.
   * @param {GrandPrixCup} cup
   * @param {object} opts
   * @param {string}  opts.title        headline text.
   * @param {string}  opts.summary      sub-line text.
   * @param {string}  opts.primaryLabel cup primary button label.
   * @param {Function} opts.onPrimary   cup primary button handler.
   * @param {Function} opts.onMenu      menu button handler.
   * @private
   */
  _renderCup(cup, { title, summary, primaryLabel, onPrimary, onMenu, gold = false }) {
    this._onCupPrimary = onPrimary || (() => {});
    this._onMenu = onMenu || (() => {});

    this._title.textContent = title;
    // Gold VICTORY treatment when the player is the champion; plain otherwise.
    this._title.className = gold ? this._titleClassVictory : this._titleClassBase;
    this._summary.textContent = summary;
    this._cupPrimaryBtn.textContent = primaryLabel;

    // RIVAL head-to-head across the cup ("You lead VEX 2-1").
    this._setRivalLine(this._cupRivalLine(cup));

    // Swap to the cup button row (hide the single-race one).
    this._buttonRow.style.display = 'none';
    this._cupButtonRow.style.display = 'flex';

    // Rebuild standings rows from the cup tallies (leader-first).
    const standings = cup.getStandings();
    this._list.innerHTML = '';
    const rows = [];
    for (let i = 0; i < standings.length; i++) {
      const row = this._buildCupRow(i + 1, standings[i]);
      this._list.appendChild(row);
      rows.push(row);
    }

    this.element.style.display = 'flex';
    gsap.from([this._title, this._summary, this._rivalLine].filter((el) => el && el.style.display !== 'none'), {
      opacity: 0, y: -30, duration: 0.5, ease: 'power3.out', stagger: 0.08,
    });
    if (rows.length) {
      gsap.from(rows, {
        opacity: 0, y: 18, duration: 0.4, ease: 'power2.out',
        stagger: 0.04, delay: 0.2, clearProps: 'opacity,transform',
      });
    }
    gsap.from([this._cupPrimaryBtn, this._cupMenuBtn], {
      opacity: 0, y: 24, duration: 0.4, ease: 'back.out(1.6)',
      stagger: 0.06, delay: 0.35, clearProps: 'opacity,transform',
    });
  }

  /**
   * CUP STANDINGS — shown between races. Lists every racer by cumulative points
   * with the points they just earned, and a NEXT RACE button.
   * @param {GrandPrixCup} cup
   * @param {{onNext?:Function, onMenu?:Function}} handlers
   */
  showCupStandings(cup, { onNext, onMenu } = {}) {
    this._renderCup(cup, {
      title: 'GRAND PRIX CUP',
      summary: 'RACE ' + cup.raceNumber() + '/' + cup.totalRaces() + ' COMPLETE',
      primaryLabel: 'NEXT RACE',
      onPrimary: onNext,
      onMenu,
    });
  }

  /**
   * CUP CHAMPION — shown after the final race. Crowns the points leader and lists
   * the full final standings, with RESTART CUP + MENU buttons.
   * @param {GrandPrixCup} cup
   * @param {{onRestartCup?:Function, onMenu?:Function}} handlers
   */
  showCupChampion(cup, { onRestartCup, onMenu } = {}) {
    const champ = cup.getChampion();
    const who = champ ? (champ.isPlayer ? 'YOU win' : champ.name + ' wins') : '';
    let summary = champ ? who + ' the cup · ' + champ.cumulativePoints + ' pts' : 'Cup complete';

    // Trophy earned + championship coin bonus banked (GrandPrixCup awarded these in
    // recordRaceResults, which main.js calls BEFORE this — so they read live here).
    const TROPHY = { gold: '🥇', silver: '🥈', bronze: '🥉' };
    const medal = (getStats().cupTrophies || {})[getActiveTier()];
    const bonus = typeof cup.getCupBonus === 'function' ? cup.getCupBonus() : 0;
    if (medal) summary += ' · ' + TROPHY[medal] + ' ' + medal.toUpperCase();
    if (bonus > 0) summary += ' · +' + bonus + ' coins';

    this._renderCup(cup, {
      title: '🏆 CHAMPION',
      summary,
      primaryLabel: 'RESTART CUP',
      onPrimary: onRestartCup,
      onMenu,
      gold: !!(champ && champ.isPlayer),
    });
  }

  /** Hide the results overlay (clicks then fall through to the game). */
  hide() {
    this.element.style.display = 'none';
  }

  /** Remove the overlay from the DOM entirely (optional cleanup). */
  dispose() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }

  /**
   * Normalize a kart colour to a CSS hex string. Accepts a number (0xRRGGBB) or
   * an already-CSS string ('#abc' / 'rgb(...)'); returns it usable as a CSS color.
   * @param {number|string} color
   * @returns {string}
   * @private
   */
  _colorToCss(color) {
    if (typeof color === 'number') {
      return '#' + (color & 0xffffff).toString(16).padStart(6, '0');
    }
    return color || '#888888';
  }

  /**
   * English ordinal for a place (1 -> "1st", 2 -> "2nd", 11 -> "11th"). Mirrors
   * the HUD's _ordinal so the two screens read consistently.
   * @param {number} n
   * @returns {string}
   * @private
   */
  _ordinal(n) {
    const num = Math.max(1, Math.round(n));
    const tens = num % 100;
    const ones = num % 10;
    let suffix = 'th';
    if (tens < 11 || tens > 13) {
      if (ones === 1) suffix = 'st';
      else if (ones === 2) suffix = 'nd';
      else if (ones === 3) suffix = 'rd';
    }
    return num + suffix;
  }

  /**
   * Format a duration in seconds as "mm:ss.mmm" (matches the HUD's lap timer).
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
    const mm = String(minutes).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    const mmm = String(millis).padStart(3, '0');
    return mm + ':' + ss + '.' + mmm;
  }
}
