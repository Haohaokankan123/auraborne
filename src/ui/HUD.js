// src/ui/HUD.js
//
// HUD = the on-screen "Heads Up Display": text and panels drawn on top of the
// 3D game (speed readout, FPS counter, etc).
//
// For Milestone 1 (M1) this does two things:
//   1. Shows the stats.js FPS panel in the top-left corner (so we can watch
//      framerate while building the physics/rendering).
//   2. Shows a speed readout in the bottom-left corner that updates every frame.
//
// For Milestone 2 (M2) we add the race information panel:
//   3. Lap counter "LAP {lap}/{totalLaps}" in the top-center.
//   4. Race position "{position}/{totalRacers}" (with ordinal: 1st/2nd/3rd...)
//      in the top-right.
//   5. A lap timer (current lap mm:ss.mmm) and best lap, top-left under stats.
//   6. A mini-turbo charge indicator (blue/orange/purple pill) above the speed,
//      shown only while a charge tier is building.
//
// This module deliberately does NOT import three.js. The HUD is plain HTML/CSS
// drawn over the canvas, so it stays cheap and simple.
//
// Tailwind utility classes do all the styling, so there is no separate CSS file.

import Stats from 'stats.js';
// gsap drives the short "roulette" spin when a fresh item is picked up. We use
// the same default import the rest of the UI screens use (Menu.js / TrackSelect.js).
import gsap from 'gsap';
// ITEMS is the master item catalog. The roulette borrows a handful of random
// item EMOJIS from it to flicker through before settling on the real icon, so
// the spin shows believable item faces rather than arbitrary glyphs.
import { ITEMS } from '../items/items.js';
// OVERDRIVE tuning (signature hook): the meter bar reads OVERDRIVE.DURATION to
// show the surge DRAINING while it's active. Pure shared data — safe to import
// client-side (this never pulls three/DOM into the shared module).
import { OVERDRIVE, EFFECTS, PHYSICS } from '../../shared/constants.js';
// The graphics QUALITY tier singleton. The HUD reads it to keep the LOW tier
// Chromebook-cheap: the minimap drops its glow pass on LOW, and the new glass
// readout pills drop their backdrop-blur (a real GPU cost) for a solid bg.
// Importing pulls the shared instance only — no three / DOM is dragged in.
import qualitySettings from '../core/QualitySettings.js';

export class HUD {
  // The constructor builds (or reuses) all the DOM elements the HUD needs.
  // It runs once when the game starts.
  constructor() {
    // --- The HUD container element ---------------------------------------
    // Everything the HUD shows lives inside a single <div id="hud">.
    // We look for it first in case index.html already created one; if it is
    // missing we create it ourselves so the HUD always works standalone.
    let hudElement = document.getElementById('hud');
    if (!hudElement) {
      hudElement = document.createElement('div');
      hudElement.id = 'hud';
      document.body.appendChild(hudElement);
    }
    this.element = hudElement;

    // The HUD covers the whole screen and sits on top of the game canvas.
    // "pointer-events-none" means mouse clicks pass straight THROUGH the HUD
    // to the game/canvas underneath; without this the HUD would block input.
    this.element.classList.add(
      'fixed',     // pinned to the viewport, not scrolled with the page
      'inset-0',   // stretch to all four edges (top/right/bottom/left = 0)
      'pointer-events-none', // clicks pass through to the game below
      'select-none',         // text can't be accidentally highlighted
      'text-white'           // default HUD text colour
    );

    // --- stats.js FPS panel (dev-only) -----------------------------------
    // stats.js draws a small live graph of the framerate. We keep a reference on
    // this.stats so the game loop can still call .begin()/.end() each frame (they
    // are harmless when the panel DOM isn't mounted). We ONLY mount the panel when
    // debugging — `?debug` in the URL (or window.__debug set) — so normal play
    // keeps the top-left clean and avoids an always-redrawing canvas compositing
    // every frame, which is dead weight on a weak (LOW-tier) Chromebook GPU.
    this.stats = new Stats();
    this.stats.showPanel(0); // panel 0 = FPS (frames per second)
    const debugMode =
      /[?&]debug\b/.test(window.location.search) || !!window.__debug;
    if (debugMode) {
      // stats.js positions its panel absolutely in the top-left already, but we
      // make sure it is in the corner and does not eat mouse input.
      const statsDom = this.stats.dom;
      statsDom.style.position = 'fixed';
      statsDom.style.top = '0';
      statsDom.style.left = '0';
      statsDom.style.pointerEvents = 'none'; // clicks pass through
      // We append the stats panel directly to <body> (not inside #hud) because
      // stats.js manages its own absolute positioning and we don't want the
      // HUD's layout classes to interfere with it.
      document.body.appendChild(statsDom);
    }

    // --- Speed readout ----------------------------------------------------
    // A big number in the bottom-left showing the kart's current speed.
    this.speedElement = document.createElement('div');
    this.speedElement.id = 'hud-speed';
    // Tailwind classes:
    //   absolute bottom-4 left-4 -> pinned near the bottom-left corner
    //   flex items-baseline gap-1 -> the big number and its small unit share a
    //                                baseline so they read as one tidy readout
    //   px-4 py-1.5 rounded-2xl ring-1 ring-cyan-400/40 -> the shared glass-pill
    //                                treatment (matches the lap pill) for guaranteed
    //                                legibility over any track; the bg + blur are
    //                                applied by _applyPillSkin (solid bg on LOW)
    //   drop-shadow               -> soft shadow so it stays readable over any
    //                                track colour behind it
    this.speedElement.className =
      'absolute bottom-4 left-4 flex items-baseline gap-1 ' +
      'px-4 py-1.5 rounded-2xl ring-1 ring-cyan-400/40 drop-shadow';
    // Inner markup: a big tabular-figures NUMBER + a small muted "km/h" unit.
    //   text-4xl font-extrabold tabular-nums -> large, bold, fixed-width digits
    //     so the readout doesn't jitter sideways as the speed ticks up/down
    //   text-sm font-semibold uppercase tracking-wider opacity-70 -> the unit
    //     reads as a quiet label beside the number, not competing with it
    this.speedElement.innerHTML =
      '<span id="hud-speed-value" class="text-4xl font-extrabold tabular-nums leading-none">0</span>' +
      '<span class="text-sm font-semibold uppercase tracking-wider opacity-70">km/h</span>';
    // Cache the number span so update() rewrites only the digits each frame.
    this.speedValueElement = this.speedElement.querySelector('#hud-speed-value');
    this.element.appendChild(this.speedElement);

    // --- M2: Lap counter --------------------------------------------------
    // "LAP {lap}/{totalLaps}" pinned to the top-center so the player always
    // knows which lap they are on. We use left-1/2 + -translate-x-1/2 to
    // horizontally center it regardless of the text width.
    this.lapElement = document.createElement('div');
    this.lapElement.id = 'hud-lap';
    //   absolute top-3 left-1/2 -translate-x-1/2 -> centered along the top edge
    //   px-4 py-1 rounded-full                    -> a tidy glass pill so the lap
    //                                               readout reads as a HUD badge
    //   bg-slate-900/45 backdrop-blur-sm ring-1 ring-cyan-400/40 -> neon glass
    //   text-2xl font-bold tracking-wide          -> large, bold, spaced caps
    //   drop-shadow                               -> readable over any track
    this.lapElement.className =
      'absolute top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full ' +
      'bg-slate-900/45 backdrop-blur-sm ring-1 ring-cyan-400/40 ' +
      'text-2xl font-bold tracking-wide drop-shadow';
    // Inner markup: a big current lap, a muted slash, and the total — so the
    // "2" pops and the "/3" reads as a quiet denominator.
    this.lapElement.innerHTML =
      '<span id="hud-lap-current">1</span>' +
      '<span class="opacity-50 font-semibold"> / </span>' +
      '<span id="hud-lap-total" class="opacity-80">3</span>';
    this.lapCurrentElement = this.lapElement.querySelector('#hud-lap-current');
    this.lapTotalElement = this.lapElement.querySelector('#hud-lap-total');
    this.element.appendChild(this.lapElement);

    // --- M2: Race position ------------------------------------------------
    // "{position}/{totalRacers}" in the top-right, e.g. "1st / 8". The big
    // ordinal (1st/2nd/3rd) is the eye-catching part; the "/ N" is smaller.
    this.positionElement = document.createElement('div');
    this.positionElement.id = 'hud-position';
    //   absolute top-3 right-4 -> pinned to the top-right corner
    //   text-right             -> numbers grow leftward from the corner
    //   px-4 py-1 rounded-full ring-1 ring-cyan-400/40 -> the shared glass pill
    //                            (bg + blur applied by _applyPillSkin); also makes
    //                            this element the containing block for the ▲/▼
    //                            position-change delta arrow (_punchPosition)
    //   drop-shadow            -> readable over any track colour
    this.positionElement.className =
      'absolute top-3 right-4 text-right px-4 py-1 rounded-full ring-1 ring-cyan-400/40 drop-shadow';
    // Inner markup: a large ordinal followed by a smaller "/ total".
    this.positionElement.innerHTML =
      '<span class="text-3xl font-bold">1st</span>' +
      '<span class="text-lg font-semibold opacity-80"> / 1</span>';
    // Cache the two inner spans so update() can refresh them without rebuilding
    // the HTML string every frame (cheaper and avoids layout churn).
    this.positionOrdinalElement = this.positionElement.querySelector('span:nth-child(1)');
    this.positionTotalElement = this.positionElement.querySelector('span:nth-child(2)');
    this.element.appendChild(this.positionElement);

    // --- M2: Lap timer (current + best) -----------------------------------
    // Two stacked lines in the top-left, just below the stats.js FPS panel.
    // top-12 leaves vertical room (~48px) for the stats panel above it.
    this.timerElement = document.createElement('div');
    this.timerElement.id = 'hud-timer';
    //   absolute top-12 left-2 -> top-left, beneath the FPS panel
    //   text-sm font-mono       -> small monospace so digits don't jitter as
    //                              the milliseconds tick (fixed-width figures)
    //   px-3 py-1.5 rounded-xl ring-1 ring-cyan-400/40 -> the shared glass pill
    //                              (bg + blur applied by _applyPillSkin)
    //   drop-shadow             -> readable over any track colour
    this.timerElement.className =
      'absolute top-12 left-2 text-sm font-mono px-3 py-1.5 rounded-xl ring-1 ring-cyan-400/40 drop-shadow';
    // Two lines: the live current-lap time, and the best lap so far.
    this.timerElement.innerHTML =
      '<div id="hud-time-current">TIME --:--.---</div>' +
      '<div id="hud-time-best" class="opacity-80">BEST --:--.---</div>';
    // Cache the two inner lines so update() refreshes text only.
    this.timeCurrentElement = this.timerElement.querySelector('#hud-time-current');
    this.timeBestElement = this.timerElement.querySelector('#hud-time-best');
    this.element.appendChild(this.timerElement);

    // --- M2: Mini-turbo charge indicator ----------------------------------
    // A small glowing pill that appears just above the speed readout while the
    // player is charging a drift. Its colour reflects the charge TIER:
    //   tier 1 = blue, tier 2 = orange, tier 3 = purple.
    // When the tier is 0 (no charge) the pill is hidden entirely.
    this.miniTurboElement = document.createElement('div');
    this.miniTurboElement.id = 'hud-miniturbo';
    //   absolute bottom-16 left-4 -> sits above the bottom-left speed readout
    //   px-3 py-1 rounded-full      -> pill shape
    //   text-xs font-bold uppercase -> small, bold label inside the pill
    //   tracking-wider              -> spaced-out caps so it reads as a badge
    //   hidden                      -> start invisible; update() toggles this
    this.miniTurboElement.className =
      'absolute bottom-16 left-4 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider hidden';
    this.miniTurboElement.textContent = 'TURBO';
    this.element.appendChild(this.miniTurboElement);

    // --- COIN counter (gold glass badge) ----------------------------------
    // A compact gold-ringed glass pill in the bottom-left, sitting above the speed
    // + mini-turbo readouts. Reads the kart's LIVE held-coin count (state.coins,
    // capped at EFFECTS.COIN_MAX — each coin is a flat top-speed bonus) so the
    // player watches their speed purse fill as they grab coins. update() shows it
    // only in item modes (race/battle/MP); TimeTrial omits items, so its clock
    // layout stays uncluttered. Starts hidden; _updateCoins toggles it.
    this.coinElement = document.createElement('div');
    this.coinElement.id = 'hud-coins';
    //   absolute bottom-28 left-4 -> above the speed (bottom-4) + mini-turbo (bottom-16)
    //   flex items-center gap-1 px-3 py-1 rounded-full -> tidy glass pill, matches the lap badge
    //   bg-slate-900/45 backdrop-blur-sm ring-1 ring-amber-300/50 -> gold-edged neon glass
    //   text-lg font-bold tabular-nums drop-shadow -> readable, non-jittering digits
    this.coinElement.className =
      'absolute bottom-28 left-4 flex items-center gap-1 px-3 py-1 rounded-full ' +
      'bg-slate-900/45 backdrop-blur-sm ring-1 ring-amber-300/50 ' +
      'text-lg font-bold tabular-nums drop-shadow hidden';
    this.coinElement.innerHTML =
      '<span class="text-xl leading-none">💰</span>' +
      '<span id="hud-coin-value" class="text-amber-300">0</span>' +
      '<span class="text-xs font-semibold opacity-50">/' + (EFFECTS.COIN_MAX || 10) + '</span>';
    this.coinValueElement = this.coinElement.querySelector('#hud-coin-value');
    this.element.appendChild(this.coinElement);

    // --- AIR-TRICK style indicator (signature hook) ----------------------
    // Appears mid-air while a trick is being worked: an escalating label
    // (NICE!/GREAT!/WILD!) over a rising STYLE number. Sits upper-center, above
    // the kart. A single pooled element (no per-frame DOM churn); the on-land pop
    // reuses showRewardBanner (see popTrickLand). Starts hidden + empty.
    this.trickElement = document.createElement('div');
    this.trickElement.id = 'hud-trick';
    //   absolute top-1/4 left-1/2 -translate-x-1/2 -> upper-center, above the kart
    //   (top-1/4, not top-1/3, so it doesn't stack on the incoming-threat badge)
    //   flex flex-col items-center text-center -> stack label over the number
    //   drop-shadow -> readable over any track; hidden -> update() toggles it
    this.trickElement.className =
      'absolute top-1/4 left-1/2 -translate-x-1/2 flex flex-col items-center text-center ' +
      'drop-shadow hidden';
    this.trickElement.innerHTML =
      '<span id="hud-trick-label" class="text-3xl font-black tracking-wide text-amber-300">NICE!</span>' +
      '<span id="hud-trick-style" class="text-lg font-bold tabular-nums text-white/90">+0</span>';
    this.trickLabelElement = this.trickElement.querySelector('#hud-trick-label');
    this.trickStyleElement = this.trickElement.querySelector('#hud-trick-style');
    this.element.appendChild(this.trickElement);

    // --- OVERDRIVE meter (signature hook) --------------------------------
    // A horizontal bar bottom-center that FILLS 0..1 from tricks + mini-turbos,
    // PULSES when full ("ready — Q"), and visibly DRAINS while a surge is active.
    // Hidden whenever it's empty + idle so a fresh race isn't cluttered.
    this.overdriveElement = document.createElement('div');
    this.overdriveElement.id = 'hud-overdrive';
    //   absolute bottom-4 left-1/2 -translate-x-1/2 -> bottom-center, clear of the
    //     bottom-left speed/turbo readouts and the bottom-right minimap
    //   flex flex-col items-center gap-1 -> label over the track/fill bar
    this.overdriveElement.className =
      'absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 drop-shadow hidden';
    this.overdriveElement.innerHTML =
      '<span id="hud-od-label" class="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-300/80">Overdrive</span>' +
      '<div class="w-44 h-2.5 rounded-full bg-slate-900/60 ring-1 ring-cyan-400/40 overflow-hidden">' +
      '<div id="hud-od-fill" class="h-full w-0 rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500"></div>' +
      '</div>';
    this.overdriveFillElement = this.overdriveElement.querySelector('#hud-od-fill');
    this.overdriveLabelElement = this.overdriveElement.querySelector('#hud-od-label');
    this.element.appendChild(this.overdriveElement);

    // --- M6: Battle layout elements --------------------------------------
    // Battle mode does not have laps or finishing positions; instead each
    // player has a number of BALLOONS (lives) and we show how many players are
    // still ALIVE. These two elements REUSE the same screen corners as the lap
    // counter (top-center) and the position readout (top-right) so the HUD
    // feels consistent across modes. They start hidden; update() shows them
    // only when info.mode === 'battle' (and hides the race-only elements).

    // Balloons: a row of balloon icons in the top-center, e.g. 3 balloons left.
    this.balloonsElement = document.createElement('div');
    this.balloonsElement.id = 'hud-balloons';
    //   absolute top-3 left-1/2 -translate-x-1/2 -> centered along the top edge
    //   flex gap-2 -> lay the balloon icons out in a neat row
    //   text-3xl   -> big enough to read the balloon emoji clearly
    this.balloonsElement.className =
      'absolute top-3 left-1/2 -translate-x-1/2 flex gap-2 text-3xl drop-shadow hidden';
    this.element.appendChild(this.balloonsElement);

    // Alive count: "{alive} ALIVE" pinned top-right, mirroring the position slot.
    this.aliveElement = document.createElement('div');
    this.aliveElement.id = 'hud-alive';
    this.aliveElement.className = 'absolute top-3 right-4 text-right drop-shadow hidden';
    this.aliveElement.innerHTML =
      '<span class="text-3xl font-bold">1</span>' +
      '<span class="text-lg font-semibold opacity-80"> ALIVE</span>';
    // Cache the count span + the label span so update() can refresh the number and
    // swap the standing ("ALIVE" while the player is in -> "SPECTATING" once out).
    this.aliveCountElement = this.aliveElement.querySelector('span:nth-child(1)');
    this.aliveLabelElement = this.aliveElement.querySelector('span:nth-child(2)');
    this.element.appendChild(this.aliveElement);

    // --- BATTLE live standings (score leaderboard) -----------------------
    // A compact top-right panel listing every kart sorted by SCORE (pops landed),
    // with a colour chip, name, ★score and 🎈balloons. The player's row is
    // highlighted so they can read their place at a glance — the competitive
    // readout the score-battle mode needs. Shown only in battle (_updateBattle).
    // We only rewrite its DOM when the data changes (see _standingsSig), so it's
    // cheap to feed every frame. Replaces the old bare "N ALIVE" count.
    this.battleStandingsElement = document.createElement('div');
    this.battleStandingsElement.id = 'hud-battle-standings';
    this.battleStandingsElement.className =
      'absolute top-3 right-4 w-56 flex flex-col gap-1 ' +
      'p-2 rounded-xl bg-slate-900/55 backdrop-blur-sm ring-1 ring-white/15 ' +
      'shadow-lg shadow-black/30 hidden';
    this.element.appendChild(this.battleStandingsElement);
    // Cache of the last-rendered standings signature so unchanged frames skip the
    // innerHTML rebuild (avoids layout thrash at 120-240fps).
    this._standingsSig = null;

    // --- BATTLE match clock ----------------------------------------------
    // A mm:ss countdown of the remaining battle time, top-center under the
    // balloon row. It PULSES red in the final 10 seconds so the urgency reads.
    // Battle-only: shown by _updateBattle, hidden in the race layout. Starts
    // hidden so it never shows in races / pre-start.
    this.battleClockElement = document.createElement('div');
    this.battleClockElement.id = 'hud-battle-clock';
    this.element.appendChild(this.battleClockElement);

    // --- ITEM SLOT: the held power-up, top-center under the lap counter ----
    // A rounded translucent card showing the player's currently-held item:
    //   (a) a big ICON (emoji) for the item,
    //   (b) the item NAME below it,
    //   (c) a small "PRESS SHIFT" key-cap prompt at the bottom.
    // It starts hidden and is shown by update() only when info.heldItem is set;
    // TimeTrial (no items) leaves it hidden, which is correct. We sit it a little
    // below the lap counter (top-20) so the two top-center readouts don't overlap.
    this.itemPanel = document.createElement('div');
    this.itemPanel.id = 'hud-item';
    //   absolute top-20 left-1/2 -translate-x-1/2 -> centered, below the lap text
    //   flex flex-col items-center -> stack icon / name / prompt centered
    //   px-4 py-3 rounded-2xl -> roomy rounded card
    //   bg-slate-900/55 backdrop-blur-sm -> translucent dark glass, matches HUD
    //   ring-2 ring-cyan-400/60 shadow-lg shadow-cyan-500/30 -> neon cyan edge+glow
    //   hidden -> start invisible; update() toggles this
    this.itemPanel.className =
      'absolute top-20 left-1/2 -translate-x-1/2 flex flex-col items-center ' +
      'px-4 py-3 rounded-2xl bg-slate-900/55 backdrop-blur-sm ' +
      'ring-2 ring-cyan-400/60 shadow-lg shadow-cyan-500/30 hidden';

    // THREE-SLOT inventory strip: a row of up to 3 item tiles. A FILLED tile shows
    // the item icon (+ a ×N badge for triples/golden); an EMPTY tile is dimmed so
    // the player reads how many items they're carrying at a glance. We keep the
    // legacy single-icon refs (itemIconElement / itemCountElement) pointing at the
    // FIRST tile so the existing roulette spin + _setIconGlyph work unchanged.
    this.itemSlotsRow = document.createElement('div');
    this.itemSlotsRow.className = 'flex items-center justify-center gap-2';
    this.itemSlotEls = [];
    for (let i = 0; i < 3; i++) {
      // Each tile: a rounded glass square sized for the emoji, with a corner badge.
      const tile = document.createElement('div');
      tile.className =
        'relative flex items-center justify-center w-14 h-14 rounded-xl ' +
        'bg-slate-800/50 ring-1 ring-cyan-400/30 text-4xl leading-none drop-shadow ' +
        'transition-opacity duration-200';
      // Leading TEXT NODE holds the glyph (so _setIconGlyph can update it in place
      // without clobbering the badge child, which must stay the LAST child).
      tile.appendChild(document.createTextNode(''));
      const badge = document.createElement('span');
      badge.className =
        'absolute -top-1 -right-1 px-1.5 py-0.5 rounded-full bg-cyan-400 text-slate-900 ' +
        'text-xs font-extrabold leading-none drop-shadow hidden';
      tile.appendChild(badge);
      this.itemSlotsRow.appendChild(tile);
      this.itemSlotEls.push({ tile, badge });
    }
    this.itemPanel.appendChild(this.itemSlotsRow);
    // Legacy aliases -> tile 0 (the active/representative slot the roulette spins).
    this.itemIconElement = this.itemSlotEls[0].tile;
    this.itemCountElement = this.itemSlotEls[0].badge;

    // The item name, under the icon. Bold spaced caps to match the HUD lap text.
    this.itemNameElement = document.createElement('div');
    this.itemNameElement.className =
      'mt-1 text-sm font-bold uppercase tracking-wide drop-shadow';
    this.itemNameElement.textContent = '';
    this.itemPanel.appendChild(this.itemNameElement);

    // The item-use key prompt. SHIFT and CLICK sit in small key-caps so they read as
    // buttons. Matches the useItem binding (Shift/KeyE/left-click — click avoids the
    // Shift+WASD keyboard ghosting that can otherwise eat the keypress while driving).
    this.itemPromptElement = document.createElement('div');
    this.itemPromptElement.className =
      'mt-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider opacity-90';
    this.itemPromptElement.innerHTML =
      '<span>Press</span>' +
      '<span class="px-1.5 py-0.5 rounded bg-white/15 ring-1 ring-white/40 font-bold">SHIFT</span>' +
      '<span>or</span>' +
      '<span class="px-1.5 py-0.5 rounded bg-white/15 ring-1 ring-white/40 font-bold">CLICK</span>';
    this.itemPanel.appendChild(this.itemPromptElement);

    this.element.appendChild(this.itemPanel);

    // --- ONBOARDING HINT: items + drift (first race only) ------------------
    // A self-dismissing banner that teaches the TWO mechanics players miss: (1)
    // items come from the floating "?" boxes you DRIVE THROUGH (not granted
    // randomly), and (2) holding SPACE to DRIFT through a turn charges a release
    // boost — the heart of the driving loop.
    // It appears automatically the first time the HUD is used in a racing mode and
    // fades out after a few seconds. A localStorage flag (mk_seen_item_hint) gates
    // it so it only ever shows once, not every race. Sits low-center so it doesn't
    // cover the top-center lap/item readouts. Starts hidden + fully transparent;
    // _maybeShowItemHint() reveals + fades it.
    this.itemHintElement = document.createElement('div');
    this.itemHintElement.id = 'hud-item-hint';
    //   absolute bottom-24 left-1/2 -translate-x-1/2 -> low-center, above the speed
    //   flex flex-col items-center gap-1.5 -> two stacked tip rows, centered
    //   px-5 py-3 rounded-2xl -> roomy rounded banner
    //   bg-slate-900/70 backdrop-blur-sm -> translucent dark glass, matches the HUD
    //   ring-2 ring-cyan-400/60 shadow-lg shadow-cyan-500/30 -> neon cyan edge+glow
    //   text-sm font-semibold tracking-wide -> readable label
    //   transition-opacity duration-500 -> smooth CSS fade in/out
    //   opacity-0 hidden -> start invisible AND removed from layout until triggered
    this.itemHintElement.className =
      'absolute bottom-24 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 ' +
      'px-5 py-3 rounded-2xl bg-slate-900/70 backdrop-blur-sm ' +
      'ring-2 ring-cyan-400/60 shadow-lg shadow-cyan-500/30 ' +
      'text-sm font-semibold tracking-wide drop-shadow ' +
      'transition-opacity duration-500 opacity-0 hidden';
    // Markup: two tip rows. Row 1 = items (a glowing "?" badge + a SHIFT key-cap so
    // the "press to use" half mirrors the held-item slot's prompt). Row 2 = drifting
    // (a SPACE key-cap teaching the hold-drift -> release-boost loop).
    this.itemHintElement.innerHTML =
      '<span class="flex items-center gap-2">' +
        '<span class="text-2xl leading-none drop-shadow text-cyan-300">❓</span>' +
        '<span>Drive through the <span class="text-cyan-300 font-bold">?</span> boxes to get an item</span>' +
        '<span class="opacity-60">·</span>' +
        '<span class="flex items-center gap-1">press ' +
        '<span class="px-1.5 py-0.5 rounded bg-white/15 ring-1 ring-white/40 font-bold">SHIFT</span>' +
        ' to use it</span>' +
      '</span>' +
      '<span class="flex items-center gap-2">' +
        '<span class="text-xl leading-none drop-shadow text-amber-300">💨</span>' +
        '<span>Hold ' +
        '<span class="px-1.5 py-0.5 rounded bg-white/15 ring-1 ring-white/40 font-bold">SPACE</span>' +
        ' to <span class="text-amber-300 font-bold">drift</span> through a turn → release for a ' +
        '<span class="text-amber-300 font-bold">boost</span></span>' +
      '</span>';
    this.element.appendChild(this.itemHintElement);

    // Hint bookkeeping. _hintShown guards against re-triggering within this
    // session; the localStorage flag guards across sessions/races. _hintTimers
    // holds the pending setTimeout ids so we never leak them.
    this._hintShown = false;
    this._hintTimers = [];

    // Roulette bookkeeping. _lastItemId tracks the item id the slot is currently
    // SHOWING so update() can detect a FRESH pickup (empty -> something, or a
    // swap to a different id) and only then play the spin — never every frame.
    // _rouletteTimeline holds the live gsap timeline so we can kill a previous
    // spin if a new pickup lands before the old one finished.
    this._lastItemId = null;
    this._rouletteTimeline = null;

    // --- MINIMAP: a corner radar of the course + every kart -----------------
    // A cheap canvas-based top-down map pinned to the bottom-right corner. It
    // draws the course outline (from track.checkpoints) once-fitted to the box,
    // then a moving DOT for every kart (from manager.getKarts()) each frame.
    //
    // Data is supplied by the WORLD agent via setMinimapSource(manager, track),
    // called ONCE at the start of each circuit race. Until that lands (menus,
    // Battle, Time-Trial pre-start) the whole panel stays hidden, so it never
    // shows an empty box. _minimapManager / _minimapTrack hold those refs.
    this._minimapManager = null;
    this._minimapTrack = null;
    // Cached fit transform (bounds + scale + offsets), recomputed only when the
    // track ref changes — the course outline never moves mid-race, so we lay it
    // out once and reuse the mapping for every per-frame dot draw.
    this._minimapFit = null;
    // The STATIC course (backdrop + glow/core outline + start ring) is pre-rendered
    // ONCE per track into this offscreen layer, then blitted each frame so per-frame
    // cost is one drawImage + the moving dots. _minimapFit being null forces a
    // rebuild on the next draw (set by setMinimapSource + the quality subscriber).
    this._minimapLayer = null;
    this._minimapInterval = 1000 / 30; // ~30Hz redraw cap (dots barely move at 60fps)
    this._minimapLastDraw = 0;
    this._buildMinimap();

    // --- POOLED SCREEN FLASH overlay ---------------------------------------
    // A single full-screen overlay reused by BOTH the Time-Trial respawn pulse and
    // the GO! launch burst (see respawnFlash / _launchFlash). Built ONCE here —
    // BEFORE the countdown element below — so it paints BEHIND the centered
    // countdown text (the GO! numeral must stay readable over the launch flash) and
    // behind every HUD readout (which stay legible during a flash). Each caller sets
    // its own tint then GSAP pulses opacity to clear. Pointer-events-none (inherited)
    // so it never blocks the canvas.
    this.flashElement = document.createElement('div');
    this.flashElement.id = 'hud-flash';
    //   absolute inset-0 -> covers the whole screen; opacity-0 -> invisible until pulsed
    this.flashElement.className = 'absolute inset-0 pointer-events-none opacity-0';
    this.element.appendChild(this.flashElement);

    // --- START COUNTDOWN overlay -------------------------------------------
    // A big centered number (3 / 2 / 1) then "GO!", animated + faded by GSAP on
    // each showCountdown(n) call (driven from main.js alongside the beeps). It is
    // an absolute centered element starting empty + transparent; showCountdown
    // writes the glyph, pops it with a scale/opacity tween, and fades it out so
    // each beat reads as a clean punch. Pointer-events-none (inherited) so it
    // never blocks the canvas.
    this.countdownElement = document.createElement('div');
    this.countdownElement.id = 'hud-countdown';
    //   absolute inset-0 flex items-center justify-center -> dead-center overlay
    //   text-[9rem] font-black -> huge bold numeral
    //   tracking-tight drop-shadow -> tight glyph + soft shadow for legibility
    //   text-transparent bg-clip-text bg-gradient-to-b -> a warm gradient fill so
    //     the number reads as a game title card, not flat text
    //   from-amber-300 via-rose-400 to-indigo-500 -> the menu's logo gradient
    //   opacity-0 -> start invisible; showCountdown animates it in/out per beat
    this.countdownElement.className =
      'absolute inset-0 flex items-center justify-center ' +
      'text-[9rem] font-black tracking-tight drop-shadow ' +
      'text-transparent bg-clip-text bg-gradient-to-b ' +
      'from-amber-300 via-rose-400 to-indigo-500 opacity-0';
    this.element.appendChild(this.countdownElement);

    // --- INCOMING-THREAT arrow --------------------------------------------
    // A pulsing red "!" that swings to the side an incoming projectile is closing
    // from (set each frame via setIncomingThreat(dir|null)). It sits just above
    // screen-center so it doesn't collide with the top/bottom HUD readouts. Starts
    // hidden; setIncomingThreat toggles + rotates it.
    this.threatElement = document.createElement('div');
    this.threatElement.id = 'hud-threat';
    //   absolute top-1/3 left-1/2 -translate-x-1/2 -> upper-center, above the kart
    //   flex items-center justify-center -> center the "!" inside
    //   w-16 h-16 rounded-full -> a round warning badge
    //   bg-red-600/80 ring-2 ring-red-300 -> bright danger fill + ring
    //   text-3xl font-black text-white drop-shadow -> a bold "!" glyph
    //   shadow-lg shadow-red-500/50 -> a red glow so it reads as ALARM
    //   hidden -> start invisible; setIncomingThreat reveals it on a real threat
    this.threatElement.className =
      'absolute top-1/3 left-1/2 -translate-x-1/2 flex items-center justify-center ' +
      'w-16 h-16 rounded-full bg-red-600/80 ring-2 ring-red-300 ' +
      'text-3xl font-black text-white drop-shadow shadow-lg shadow-red-500/50 hidden';
    this.threatElement.textContent = '!';
    this.element.appendChild(this.threatElement);

    // Live GSAP timeline for the in-flight countdown beat (so a new beat can kill
    // the previous one). null when no beat is animating.
    this._countdownTween = null;

    // --- Race-readout feedback bookkeeping --------------------------------
    // _lastPosition drives the position-change punch (▲/▼); _finalLapShown gates
    // the one-shot FINAL LAP banner; _lastSpeedKmh + _speedSpikeActive drive the
    // speedometer colour ramp + surge punch. All seeded so the FIRST frame never
    // false-fires (a punch needs a real change from a known previous value).
    this._lastPosition = null;
    this._finalLapShown = false;
    this._lastSpeedKmh = 0;
    this._speedSpikeActive = false;

    // Apply the glass skin to the speed/position/timer pills now, and re-apply
    // whenever the graphics tier changes live (the pause-menu slider). LOW drops
    // the backdrop-blur for a solid bg; the same hook nulls the minimap fit so its
    // static layer rebuilds at the new tier (e.g. re-adds the glow above LOW).
    this._applyPillSkin();
    qualitySettings.subscribe(() => {
      this._applyPillSkin();
      this._minimapFit = null;
    });
  }

  // _applyPillSkin(): give the speed/position/timer readouts the lap pill's glass
  // language. On MED+ that's a translucent bg + backdrop-blur; on LOW we drop the
  // blur (a real GPU cost on weak hardware — see HARD CONSTRAINT) for a MORE opaque
  // solid bg so legibility holds without the fill-rate hit. The shape/ring/padding
  // live in each element's ctor className; this only swaps the bg + blur.
  _applyPillSkin() {
    const low = qualitySettings && qualitySettings.tier === 'low';
    const pills = [this.speedElement, this.positionElement, this.timerElement];
    for (const el of pills) {
      if (!el) continue;
      el.classList.remove('bg-slate-900/45', 'bg-slate-900/70', 'backdrop-blur-sm');
      if (low) {
        el.classList.add('bg-slate-900/70'); // solid translucent, no blur
      } else {
        el.classList.add('bg-slate-900/45', 'backdrop-blur-sm'); // glass
      }
    }
  }

  /**
   * Show one beat of the 3-2-1-GO start countdown as a big centered overlay.
   * Called from main.js alongside each countdown beep: n = 3/2/1 shows that
   * number, n = 0 shows "GO!". Each call writes the glyph and runs a fresh GSAP
   * pop (scale up from small + fade in) then fades/scales it back out, so the
   * beats punch in cleanly one after another.
   *
   * @param {number} n  3 / 2 / 1 for the count, 0 for the final "GO!".
   */
  showCountdown(n) {
    const el = this.countdownElement;
    if (!el) return;
    // The final beat is the green-lit "GO!"; the counts are the plain numeral.
    const isGo = n <= 0;
    el.textContent = isGo ? 'GO!' : String(n);
    // "GO!" swaps to a celebratory green gradient so it reads as the launch cue;
    // the numbers keep the warm amber->indigo title gradient set in the ctor.
    if (isGo) {
      el.classList.remove('from-amber-300', 'via-rose-400', 'to-indigo-500');
      el.classList.add('from-emerald-300', 'via-green-400', 'to-teal-500');
    } else {
      el.classList.remove('from-emerald-300', 'via-green-400', 'to-teal-500');
      el.classList.add('from-amber-300', 'via-rose-400', 'to-indigo-500');
    }

    // Kill any in-flight tween from the previous beat so two quick calls don't
    // fight over the transform/opacity.
    if (this._countdownTween) {
      this._countdownTween.kill();
      this._countdownTween = null;
    }

    // Pop in (small + invisible -> full + opaque with a back ease), hold, then
    // fade + shrink out. A slightly longer hold + bigger pop on "GO!" so the
    // launch reads as the climax. clearProps leaves no stale inline style behind.
    this._countdownTween = gsap.timeline({
      onComplete: () => {
        el.style.opacity = '0';
        this._countdownTween = null;
      },
    });
    this._countdownTween
      .fromTo(
        el,
        { scale: isGo ? 0.4 : 0.6, opacity: 0 },
        { scale: isGo ? 1.4 : 1.1, opacity: 1, duration: 0.22, ease: 'back.out(2.2)' }
      )
      .to(el, { opacity: 0, scale: isGo ? 1.7 : 1.3, duration: 0.45, ease: 'power2.in' }, isGo ? 0.45 : 0.3);

    // GO! also fires a green launch burst behind the numeral (radial vignette +
    // speed-line spokes) so the start reads as a punch, not a silent unfreeze.
    if (isGo) this._launchFlash();
  }

  /**
   * Flash a brief, prominent COMEBACK reward banner (R5-B). Called once by the
   * RaceManager render the frame the player gets a fall-off catch-up item. It is a
   * centered, non-blocking (pointer-events-none) card that GSAP pops in, holds,
   * and pops out, self-dismissing after ~1.4s. The element is built ONCE (lazily)
   * and reused so repeated calls never leak DOM nodes; any in-flight tween is
   * killed before re-animating so back-to-back rewards don't fight.
   *
   * @param {string} message  the text to flash, e.g. "COMEBACK! Star".
   * @param {string} [tone]   'alert' for an urgent amber->rose card (e.g. FINAL
   *                          LAP); anything else (default) is the reward green.
   * @param {number} [holdSecs] how long the banner holds at full before fading
   *                          (default 0.6s). A longer hold lets weightier beats —
   *                          the battle match-start objective + a "you're out" —
   *                          linger so they actually read.
   */
  showRewardBanner(message, tone, holdSecs) {
    // Lazily build the banner once and cache it. Centered upper-third so it clears
    // the held-item slot up top and the player's kart at screen center.
    //   absolute top-1/4 left-1/2 -translate-x-1/2 -> upper-center, above the kart
    //   px-6 py-3 rounded-2xl -> roomy glass pill
    //   bg-emerald-500/85 ring-2 ring-emerald-200/80 -> bright "good news" green
    //   shadow-lg shadow-emerald-500/50 -> a green glow so it reads as a reward
    //   text-2xl font-black tracking-wide text-white drop-shadow -> bold legible
    //   pointer-events-none -> never blocks the canvas (matches the rest of the HUD)
    //   opacity-0 -> start invisible; GSAP drives the pop in/out
    if (!this.rewardBannerElement) {
      this.rewardBannerElement = document.createElement('div');
      this.rewardBannerElement.id = 'hud-reward-banner';
      // NOTE: NO `-translate-x-1/2` class — GSAP's `xPercent:-50` (below) is the SOLE
      // source of horizontal centering. Stacking the Tailwind transform AND GSAP's
      // xPercent double-applies the -50% and shifts the banner off-center left.
      // Colour utilities (bg / ring / shadow) are applied per-call below so the
      // tone can vary; the base here is just shape + ring-width + text + shadow-lg.
      this.rewardBannerElement.className =
        'absolute top-1/4 left-1/2 px-6 py-3 rounded-2xl ring-2 shadow-lg ' +
        'text-2xl font-black tracking-wide text-white drop-shadow ' +
        'pointer-events-none opacity-0';
      this.element.appendChild(this.rewardBannerElement);
    }
    const el = this.rewardBannerElement;
    el.textContent = message;

    // Tone the card: default reward green vs an urgent amber->rose 'alert'. Swap the
    // colour utilities each call so two back-to-back banners of different tones never
    // leave a stale colour (mirrors _updateMiniTurbo's class-swap pattern).
    el.classList.remove(
      'bg-emerald-500/85', 'ring-emerald-200/80', 'shadow-emerald-500/50',
      'bg-gradient-to-r', 'from-amber-500/90', 'to-rose-600/90',
      'ring-amber-200/80', 'shadow-rose-500/50'
    );
    if (tone === 'alert') {
      el.classList.add(
        'bg-gradient-to-r', 'from-amber-500/90', 'to-rose-600/90',
        'ring-amber-200/80', 'shadow-rose-500/50'
      );
    } else {
      el.classList.add('bg-emerald-500/85', 'ring-emerald-200/80', 'shadow-emerald-500/50');
    }

    // Kill any in-flight tween from a previous reward so two quick calls don't
    // fight over the transform/opacity.
    if (this._rewardBannerTween) {
      this._rewardBannerTween.kill();
      this._rewardBannerTween = null;
    }

    // Pop in (small + invisible -> full + opaque with a back ease), hold, then
    // fade + lift out. Total ~1.4s. clearProps leaves no stale inline style behind.
    this._rewardBannerTween = gsap.timeline({
      onComplete: () => {
        el.style.opacity = '0';
        this._rewardBannerTween = null;
      },
    });
    // NOTE: xPercent:-50 keeps the horizontal centering. GSAP writes an inline
    // `transform`, which would otherwise clobber the Tailwind `-translate-x-1/2`
    // class and render the banner shifted right by half its width. Setting it on
    // the fromTo carries it through the later `.to` steps (they don't touch x).
    const hold = typeof holdSecs === 'number' && holdSecs >= 0 ? holdSecs : 0.6;
    this._rewardBannerTween
      .fromTo(
        el,
        { xPercent: -50, scale: 0.6, opacity: 0, y: 10 },
        { xPercent: -50, scale: 1.1, opacity: 1, y: 0, duration: 0.25, ease: 'back.out(2.2)' }
      )
      .to(el, { scale: 1, duration: 0.15, ease: 'power2.out' })
      .to(el, { opacity: 0, scale: 1.15, y: -14, duration: 0.4, ease: 'power2.in' }, '+=' + hold);
  }

  /**
   * Quick full-screen flash for the Time Trial safety-net RESPAWN, so the teleport
   * reads as a deliberate reset rather than a silent snap. A pooled cyan overlay
   * GSAP-pulses from a faint wash to clear in ~0.4s. Pointer-events-none so it
   * never blocks the canvas; built once and reused.
   */
  respawnFlash() {
    // A faint cyan-200 wash that clears in ~0.4s (see _pulseFlash).
    this._pulseFlash('rgb(165, 243, 252)', 0.45, 0.4);
  }

  /**
   * GO! launch burst (signature hook). Fired on the GO! countdown beat (see
   * showCountdown) so the start reads as a punch, not a silent unfreeze: a green
   * radial vignette plus faint "speed-line" spokes radiating from center, reusing
   * the pooled flash overlay. Pointer-events-none so it never blocks the canvas.
   */
  _launchFlash() {
    // Thin green spokes radiating from center read as motion lines; the vignette
    // (clear center -> green edges) frames the burst without hiding the kart.
    const spokes =
      'repeating-conic-gradient(from 0deg at 50% 50%, ' +
      'rgba(52, 211, 153, 0) 0deg, rgba(52, 211, 153, 0.22) 1.1deg, rgba(52, 211, 153, 0) 2.8deg)';
    const vignette =
      'radial-gradient(circle at 50% 50%, ' +
      'rgba(16, 185, 129, 0) 42%, rgba(16, 185, 129, 0.42) 100%)';
    this._pulseFlash(spokes + ', ' + vignette, 0.8, 0.6);
  }

  /**
   * Shared engine for the pooled screen flash (respawn + launch). Sets the pooled
   * overlay's background then GSAP-pulses it from `fromOpacity` to clear over `dur`
   * seconds. Built once in the constructor, so this is alloc-free per call; any
   * in-flight pulse is killed first so back-to-back flashes don't fight.
   * @param {string} bg          a CSS background value (colour or gradient stack).
   * @param {number} fromOpacity the peak opacity the pulse starts at.
   * @param {number} dur         fade-to-clear duration in seconds.
   */
  _pulseFlash(bg, fromOpacity, dur) {
    const el = this.flashElement;
    if (!el) return;
    el.style.background = bg;
    if (this._flashTween) this._flashTween.kill();
    this._flashTween = gsap.fromTo(
      el,
      { opacity: fromOpacity },
      { opacity: 0, duration: dur, ease: 'power2.out' }
    );
  }

  /**
   * AIR-TRICK + OVERDRIVE HUD (signature hook). Called every frame from main.js
   * with the PLAYER kart state. Shows the building STYLE while a trick is worked
   * mid-air and fills/drains the overdrive meter. Every field defaults to 0/false,
   * so a kart that never tricks or charges leaves both readouts hidden. The on-land
   * pop is fired separately by main.js via popTrickLand (it owns the land signal).
   *
   * @param {object} s player kart state ({trickActive, trickStyle, overdrive, overdriveTimer}).
   */
  updateTricks(s) {
    if (!s) return;
    // --- Mid-air STYLE indicator -----------------------------------------
    if (s.trickActive) {
      const style = s.trickStyle || 0;
      this.trickLabelElement.textContent = this._trickLabel(style) + '!';
      // Show style as a punchy score-y number (style*100) — reads as points.
      this.trickStyleElement.textContent = '+' + Math.round(style * 100);
      this.trickElement.classList.remove('hidden');
    } else {
      this.trickElement.classList.add('hidden');
    }
    // --- Overdrive meter --------------------------------------------------
    this._updateOverdrive(s.overdrive || 0, (s.overdriveTimer || 0) > 0, s.overdriveTimer || 0);
  }

  /**
   * Pop the final trick label on a CLEAN landing (signature hook). Reuses the
   * existing showRewardBanner pop so there's no second tween/element to maintain.
   * @param {number} style the banked style cashed on landing.
   */
  popTrickLand(style) {
    this.showRewardBanner(this._trickLabel(style) + '!  +' + Math.round(style * 100));
  }

  // Escalating trick label by banked style. Tuned to the kartModel rates: ~1s of
  // worked air ≈ 1.0-1.6 style; a big gap jump (~1.5s) ≈ 1.5-2.4.
  _trickLabel(style) {
    if (style >= 2.5) return 'WILD';
    if (style >= 1.2) return 'GREAT';
    return 'NICE';
  }

  // Fill/drain + label the overdrive meter. While active it shows the DRAINING
  // timer fraction (timer/DURATION); otherwise the charge meter (0..1). Pulses
  // when active or full-and-ready. Hidden when empty + idle.
  _updateOverdrive(meter, active, timer) {
    const el = this.overdriveElement;
    const frac = active
      ? Math.max(0, Math.min(1, timer / OVERDRIVE.DURATION))
      : Math.max(0, Math.min(1, meter));
    if (frac <= 0 && !active) {
      el.classList.remove('animate-pulse'); // don't hide it mid-pulse
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    this.overdriveFillElement.style.width = (frac * 100).toFixed(1) + '%';
    if (active) {
      this.overdriveLabelElement.textContent = 'Overdrive!';
      el.classList.add('animate-pulse');
    } else if (meter >= 1) {
      this.overdriveLabelElement.textContent = 'Overdrive Ready — Q';
      el.classList.add('animate-pulse');
    } else {
      this.overdriveLabelElement.textContent = 'Overdrive';
      el.classList.remove('animate-pulse');
    }
  }

  // Show/refresh the bottom-left COIN badge. `show` gates visibility (item modes
  // only); when shown, writes the kart's live held-coin count. Cheap to call every
  // frame — it only toggles a class + sets text. state may be any kart state.
  _updateCoins(state, show) {
    const el = this.coinElement;
    if (!el) return;
    if (!show || !state) {
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    this.coinValueElement.textContent = String(Math.max(0, Math.round(state.coins || 0)));
  }

  // _updateSpeedFeedback(kmh): give the speed digits live feel. (1) Colour-ramp
  // them by speed fraction cyan -> amber -> fuchsia (keyed to PHYSICS.MAX_SPEED so
  // normal top speed reads fuchsia). (2) On a SURGE — breaking past normal top
  // speed (a boost/overdrive lifts the cap above MAX_SPEED) or a big single-frame
  // jump (a speed pad / ramp-landing snap) — punch + glow the digits. Cheap: one
  // inline colour write per frame; the punch/gradient only run during a surge.
  _updateSpeedFeedback(kmh) {
    const el = this.speedValueElement;
    if (!el) return;
    const maxKmh = PHYSICS.MAX_SPEED * 3.6; // ~158 km/h normal top speed
    const frac = Math.max(0, Math.min(1, kmh / maxKmh));

    // While a surge gradient fill is active it OWNS the colour (text-transparent +
    // bg-clip-text), so don't fight it with the per-frame ramp.
    if (!this._speedSpikeActive) el.style.color = this._speedColor(frac);

    const prev = this._lastSpeedKmh || 0;
    this._lastSpeedKmh = kmh;
    // Normal throttle accel tops out AT maxKmh in small per-frame steps, so neither
    // condition fires under ordinary driving — only a real boost/pad surge does.
    const brokePastTop = prev <= maxKmh && kmh > maxKmh;
    if (brokePastTop || kmh - prev >= 10) this._punchSpeed();
  }

  // _speedColor(f): lerp cyan-400 -> amber-400 -> fuchsia-500 across f in [0,1].
  _speedColor(f) {
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);
    let r, g, b;
    if (f < 0.5) {
      const t = f / 0.5; // cyan-400 (34,211,238) -> amber-400 (251,191,36)
      r = lerp(34, 251, t); g = lerp(211, 191, t); b = lerp(238, 36, t);
    } else {
      const t = (f - 0.5) / 0.5; // amber-400 (251,191,36) -> fuchsia-500 (217,70,239)
      r = lerp(251, 217, t); g = lerp(191, 70, t); b = lerp(36, 239, t);
    }
    return 'rgb(' + r + ', ' + g + ', ' + b + ')';
  }

  // _punchSpeed(): a short scale-punch + fuchsia glow on the speed digits, swapping
  // in the overdrive cyan->fuchsia gradient as a text-clip fill for the surge, then
  // settling back so the per-frame ramp resumes. The value span is a flex item, so
  // the transform applies. Any in-flight punch is killed first.
  _punchSpeed() {
    const el = this.speedValueElement;
    if (this._speedSpikeTween) this._speedSpikeTween.kill();
    this._speedSpikeActive = true;
    el.style.color = ''; // clear the inline ramp colour so bg-clip-text shows through
    el.classList.add(
      'bg-clip-text', 'text-transparent', 'bg-gradient-to-r', 'from-cyan-400', 'to-fuchsia-500'
    );
    el.style.textShadow = '0 0 12px rgba(217, 70, 239, 0.7)'; // fuchsia glow
    this._speedSpikeTween = gsap.fromTo(
      el,
      { scale: 1.35 },
      {
        scale: 1,
        duration: 0.5,
        ease: 'back.out(2)',
        onComplete: () => {
          el.classList.remove(
            'bg-clip-text', 'text-transparent', 'bg-gradient-to-r', 'from-cyan-400', 'to-fuchsia-500'
          );
          el.style.textShadow = '';
          this._speedSpikeActive = false;
        },
      }
    );
  }

  /**
   * Show/hide the directional INCOMING-THREAT arrow. Called every frame by the
   * RaceManager render with a signed turn direction in [-1,1] (negative = threat
   * from the left, positive = from the right) or null when nothing is incoming.
   * We rotate the "!" badge toward that side and reveal it; null hides it. Cheap
   * to call every frame — it only toggles a class + sets a transform.
   *
   * @param {number|null} dir  signed left/right direction, or null for "clear".
   */
  setIncomingThreat(dir) {
    const el = this.threatElement;
    if (!el) return;
    if (dir == null) {
      // No threat: hide the badge (idempotent — cheap when already hidden).
      if (!el.classList.contains('hidden')) el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    // Lean the badge toward the side the threat is on (±28deg) so the "!" visibly
    // points where the danger is coming from. -translate-x-1/2 keeps it centered,
    // so we append our own rotate on top of that base transform.
    const deg = Math.max(-1, Math.min(1, dir)) * 28;
    el.style.transform = 'translateX(-50%) rotate(' + deg.toFixed(1) + 'deg)';
  }

  /**
   * Build the bottom-right MINIMAP panel: a rounded neon-glass frame wrapping a
   * <canvas> we draw the course + kart dots into. Built hidden; it only reveals
   * once setMinimapSource() supplies a manager + track (see _drawMinimap).
   *
   * The panel is a backdrop-blurred dark card with a cyan ring + glow so it
   * matches the held-item slot and onboarding hint. The canvas is sized once at
   * the device pixel ratio so the lines stay crisp on retina screens without
   * re-measuring every frame.
   * @private
   */
  _buildMinimap() {
    // CSS box size (logical px). The backing canvas is scaled up by the device
    // pixel ratio below so strokes are sharp; all our draw math uses these.
    this._minimapSize = 168;

    // Outer frame: neon glass card pinned bottom-right, mirroring the item slot.
    //   absolute bottom-4 right-4 -> tucked into the bottom-right corner
    //   p-2 rounded-2xl            -> small inset + rounded glass card
    //   bg-slate-900/55 backdrop-blur-sm -> translucent dark glass like the HUD
    //   ring-2 ring-cyan-400/50 shadow-lg shadow-cyan-500/25 -> cyan edge + glow
    //   hidden -> start invisible; _drawMinimap reveals it once a source is set
    this.minimapPanel = document.createElement('div');
    this.minimapPanel.id = 'hud-minimap';
    this.minimapPanel.className =
      'absolute bottom-4 right-4 p-2 rounded-2xl bg-slate-900/55 backdrop-blur-sm ' +
      'ring-2 ring-cyan-400/50 shadow-lg shadow-cyan-500/25 hidden';

    // A tiny "MAP" label across the top so the panel reads as a radar, not a
    // stray box. Subtle spaced caps in muted cyan to match the neon theme.
    const label = document.createElement('div');
    label.className =
      'text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-300/70 ' +
      'text-center leading-none mb-1';
    label.textContent = 'Map';
    this.minimapPanel.appendChild(label);

    // The drawing surface. We set BOTH the CSS size (logical) and the backing
    // store size (logical × dpr) so the canvas renders crisp on retina. The 2D
    // context is then scaled by dpr ONCE so all our draw calls use logical px.
    this.minimapCanvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap at 2× (cost)
    this._minimapDpr = dpr;
    this.minimapCanvas.width = this._minimapSize * dpr;
    this.minimapCanvas.height = this._minimapSize * dpr;
    this.minimapCanvas.style.width = this._minimapSize + 'px';
    this.minimapCanvas.style.height = this._minimapSize + 'px';
    this.minimapCanvas.style.display = 'block';
    // Round the canvas corners so it sits inside the rounded glass frame.
    this.minimapCanvas.style.borderRadius = '12px';
    this.minimapPanel.appendChild(this.minimapCanvas);

    this._minimapCtx = this.minimapCanvas.getContext('2d');
    // Scale the context so 1 unit = 1 logical px (draw math stays simple).
    this._minimapCtx.scale(dpr, dpr);

    this.element.appendChild(this.minimapPanel);
  }

  /**
   * Wire the MINIMAP to its live data sources. Called ONCE by main.js (the WORLD
   * agent) right after the RaceManager + Track are built for a circuit race
   * (Grand Prix / Time Trial / Multiplayer). Storing the refs is all that is
   * needed — every HUD update() then reads kart positions + the course outline
   * straight off them. Passing null/undefined clears the source and re-hides the
   * panel (used when returning to a menu or entering Battle, which has no loop).
   *
   * @param {object|null} manager  a RaceManager-like object exposing getKarts()
   *                               -> records with { id, ai, state:{ x, z } }.
   * @param {object|null} track    a Track-like object exposing `checkpoints`
   *                               -> ordered [{ x, y, z, index }] loop.
   */
  setMinimapSource(manager, track) {
    this._minimapManager = manager || null;
    this._minimapTrack = track || null;
    // Force the fit transform to recompute against the new track on next draw.
    this._minimapFit = null;
    // No source -> hide immediately so a stale map never lingers between modes.
    if (!this._minimapManager || !this._minimapTrack) {
      this.minimapPanel.classList.add('hidden');
    }
  }

  // update(state, info) is called once per frame from the game loop.
  // It reads the kart STATE object and the race INFO object and refreshes the
  // on-screen text.
  //
  // state.speed is in "metres per second"-ish world units. We convert to
  // km/h for display: 1 m/s = 3.6 km/h.
  // Math.abs() so reversing still shows a positive number; Math.round() so we
  // show a whole number instead of a long decimal.
  //
  // info = { lap, totalLaps, position, totalRacers, lapTime, bestLap,
  //          miniTurboTier }. It is OPTIONAL: M1 callers (and any code that
  //          only has a kart state) can still call update(state) with no second
  //          argument — we just update the speed and skip the race panel.
  update(state, info) {
    if (!state) return; // guard: nothing to show if no state was passed in

    // --- Speed (always shown, M1 + M2) -----------------------------------
    // Split the number from its unit so the digits read big + bold and the
    // "km/h" sits small + muted beside them (cleaner than one flat string).
    const speedKmh = Math.round(Math.abs(state.speed) * 3.6);
    this.speedValueElement.textContent = String(speedKmh);
    // Live speedometer feel: colour-ramp the digits by speed fraction and punch +
    // glow them on a surge (boost/overdrive). Runs in every mode (before the info
    // split) since speed is always shown.
    this._updateSpeedFeedback(speedKmh);

    // --- Minimap (drawn every frame when a source is set) ----------------
    // Cheap radar in the bottom-right. Self-hides when no source is wired
    // (menus / Battle), so it is safe to call unconditionally each update.
    this._drawMinimap();

    // --- Race info (M2 only) ---------------------------------------------
    // Backward-tolerant: if no info object was passed, leave the race panel
    // showing whatever it last showed (or its placeholders) and stop here.
    if (!info) return;

    // First-race onboarding hint. We only show it in modes that HAVE items
    // (race / battle / multiplayer all pass a `heldItem` field; TimeTrial omits
    // it entirely, so 'heldItem' in info cleanly excludes the no-item mode). The
    // method is one-shot and localStorage-gated, so calling it every frame is safe
    // and it self-dismisses without any caller involvement.
    if ('heldItem' in info) this._maybeShowItemHint();

    // COIN purse: show the live held-coin count as a gold badge in item modes
    // (they pass `heldItem`). Placed before the battle/race split so it shows in
    // both; TimeTrial omits `heldItem`, so its empty coin purse stays hidden.
    this._updateCoins(state, 'heldItem' in info);

    // --- M6: Battle layout branch ----------------------------------------
    // Battle mode shows BALLOONS + ALIVE count instead of LAP + position. We
    // trigger this layout when info.mode === 'battle' OR when balloons data is
    // present (so callers can opt in either way). When in battle layout we hide
    // the lap counter and position readout and show the balloon/alive elements.
    const isBattle = info.mode === 'battle' || info.balloons != null;
    if (isBattle) {
      this._updateBattle(info);
      // The mini-turbo pill is still meaningful in battle (you can still drift),
      // so keep updating it. Everything else (laps/position/timer) is hidden.
      this._updateMiniTurbo(info.miniTurboTier);
      // The held-item slot works in EVERY mode that has items (battle included).
      this.setHeldItem(info.heldItem);
      return;
    }

    // Not battle: make sure the battle-only elements are hidden and the
    // race-only elements are visible (in case we switched modes mid-session).
    this.balloonsElement.classList.add('hidden');
    this.aliveElement.classList.add('hidden');
    this.battleStandingsElement.classList.add('hidden');
    this.battleClockElement.classList.add('hidden');
    this.lapElement.classList.remove('hidden');
    this.positionElement.classList.remove('hidden');
    this.timerElement.classList.remove('hidden'); // race lap timer (hidden in battle)

    // Lap counter, e.g. "LAP 2/3". Make the lap display 1-BASED and CLAMPED so
    // we never show "LAP 0/3" (some callers count completed laps starting at 0).
    // We clamp the lap into the range [1, totalLaps].
    const totalLaps = info.totalLaps != null ? info.totalLaps : 3;
    const rawLap = info.lap != null ? info.lap : 1;
    const lap = Math.min(Math.max(1, Math.round(rawLap)), Math.max(1, totalLaps));
    // Write the two figures into their own spans (big current / muted total)
    // rather than one flat string, so the polished pill layout stays intact.
    this.lapCurrentElement.textContent = String(lap);
    this.lapTotalElement.textContent = String(totalLaps);
    // One-shot FINAL LAP alert + red lap-pill pulse the frame the player enters
    // the last lap of a multi-lap race.
    this._maybeFinalLap(lap, totalLaps);

    // Race position with an ordinal suffix, e.g. "1st", "2nd", "3rd".
    const position = info.position != null ? info.position : 1;
    const totalRacers = info.totalRacers != null ? info.totalRacers : 1;
    this.positionOrdinalElement.textContent = this._ordinal(position);
    this.positionTotalElement.textContent = ' / ' + totalRacers;
    // Punch + ▲/▼ tint the readout whenever the place actually changes.
    this._punchPosition(position);

    // Lap timer: current lap time, and the best lap so far. Times come in as
    // seconds; _formatTime() turns them into mm:ss.mmm strings.
    this.timeCurrentElement.textContent = 'TIME ' + this._formatTime(info.lapTime);
    // bestLap may be null/undefined until the first lap is completed; in that
    // case _formatTime() renders the "--:--.---" placeholder.
    this.timeBestElement.textContent = 'BEST ' + this._formatTime(info.bestLap);

    // Mini-turbo charge pill: colour by tier, hidden when there is no charge.
    this._updateMiniTurbo(info.miniTurboTier);

    // Held-item slot: show the player's current power-up (or hide it if empty).
    this.setHeldItem(info.heldItem);
  }

  // setHeldItem(heldInfo) shows/hides the top-center THREE-SLOT item strip.
  //   heldInfo == null/undefined / no items -> hide the panel (holding nothing).
  //   heldInfo present -> render up to 3 slot tiles.
  // Accepts EITHER shape (so it works with current and future producers):
  //   - multi-slot: { slots: [ {id,count}|null, ... ] }  (e.g. ItemSystem.getSlots)
  //   - legacy single: { id, name, icon, color, count }  -> fills the first tile.
  // The "active" item (first filled slot) drives the name + the one-shot GSAP
  // roulette, which fires on a FRESH pickup (active id changes, e.g. empty ->
  // something). Empty tiles dim. Safe to call every frame.
  setHeldItem(heldInfo) {
    const slots = this._slotsFrom(heldInfo);
    // First filled slot = the active/representative item.
    let active = null;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]) { active = slots[i]; break; }
    }

    // Nothing held: hide the panel + reset the roulette tracker so the NEXT pickup
    // counts as fresh (empty -> something) and plays the spin.
    if (!active) {
      if (this._lastItemId !== null) {
        this.itemPanel.classList.add('hidden');
        this._lastItemId = null;
      }
      return;
    }

    // Make the panel visible (no-op if it already was) + render each tile.
    this.itemPanel.classList.remove('hidden');
    for (let i = 0; i < this.itemSlotEls.length; i++) {
      this._renderSlotTile(i, slots[i]);
    }

    // Name reads the active item.
    this.itemNameElement.textContent = active.name || '';

    // FRESH pickup? Only spin when the active id changed. Spending a charge of the
    // same triple keeps the id, so it won't re-roulette. The roulette animates tile
    // 0, so only play it when the active item actually sits there (slots[0]) — a
    // fresh pickup from empty always lands in slot 0, so genuine pickups still spin.
    if (active.id !== this._lastItemId) {
      this._lastItemId = active.id;
      if (slots[0]) this._playRoulette(active.icon || '❓');
    }
  }

  // _slotsFrom(heldInfo) -> a 3-long array of { id, icon, name, count } | null.
  // Normalizes both the multi-slot ({slots:[...]}) and legacy-single descriptors.
  _slotsFrom(heldInfo) {
    const out = [null, null, null];
    if (!heldInfo) return out;
    if (Array.isArray(heldInfo.slots)) {
      for (let i = 0; i < out.length && i < heldInfo.slots.length; i++) {
        out[i] = this._slotInfo(heldInfo.slots[i]);
      }
      return out;
    }
    if (heldInfo.id) out[0] = this._slotInfo(heldInfo);
    return out;
  }

  // _slotInfo(entry) -> { id, icon, name, count } resolved against the ITEMS table
  // (so a bare { id, count } entry from ItemSystem.getSlots still gets an icon).
  _slotInfo(entry) {
    if (!entry || !entry.id) return null;
    const def = ITEMS[entry.id];
    return {
      id: entry.id,
      icon: entry.icon || (def ? def.icon : '❓'),
      name: entry.name || (def ? def.name : ''),
      count: entry.count != null ? entry.count : 1,
    };
  }

  // _renderSlotTile(i, slot) paints one tile: filled tiles show the glyph + ×N
  // badge; empty tiles dim and clear. Tile 0's glyph is left to the roulette while
  // a spin is in flight so the per-frame refresh doesn't snap away the flicker.
  _renderSlotTile(i, slot) {
    const el = this.itemSlotEls[i];
    if (!el) return;
    if (!slot) {
      el.tile.classList.add('opacity-30');
      this._setTileGlyph(el.tile, '');
      el.badge.classList.add('hidden');
      return;
    }
    el.tile.classList.remove('opacity-30');
    if (!(i === 0 && this._rouletteTimeline)) {
      this._setTileGlyph(el.tile, slot.icon || '❓');
    }
    if (slot.count > 1) {
      el.badge.textContent = '×' + slot.count;
      el.badge.classList.remove('hidden');
    } else {
      el.badge.classList.add('hidden');
    }
  }

  // _drawMinimap() refreshes the corner radar each HUD update. It reads the course
  // outline from track.checkpoints (an ordered [{x,y,z,index}] loop) and a live dot
  // for every kart from manager.getKarts(). The whole panel stays HIDDEN until
  // setMinimapSource() supplies both refs, so calling this every frame in any mode
  // (including Battle / menus, which set no source) is safe.
  //
  // PERF: the STATIC course (backdrop + glow/core outline + start ring) is
  // pre-rendered ONCE per track into an offscreen layer (see _buildMinimapLayer),
  // so each frame is just clear -> one drawImage -> the moving kart dots. The redraw
  // is throttled to ~30Hz (dots barely move between 60fps frames) and the dot math
  // uses scalar locals (no per-dot object alloc). This is the LOW tier's biggest HUD
  // win — it kills ~100-200 allocs/frame plus the old per-frame backdrop fill, glow
  // shadowBlur, and double path stroke.
  _drawMinimap() {
    const manager = this._minimapManager;
    const track = this._minimapTrack;

    // No source wired (menus / Battle / pre-start) -> keep the panel hidden and
    // do no work. This is the common idle case, so bail first and cheap.
    if (!manager || !track) {
      return;
    }
    const checkpoints = track.checkpoints;
    if (!checkpoints || checkpoints.length < 2) {
      // A track with no usable loop (shouldn't happen for circuits) -> hide
      // rather than draw a degenerate line.
      this.minimapPanel.classList.add('hidden');
      return;
    }

    // We have a real source now: make sure the panel is visible. This cheap class
    // toggle still runs every frame even when the redraw below is throttled out.
    this.minimapPanel.classList.remove('hidden');

    // THROTTLE the redraw to ~30Hz. Karts barely move between 60fps frames, so
    // repainting the canvas every frame is wasted fill-rate; only the draw is
    // rate-limited (the visibility toggle above always runs).
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._minimapLastDraw < this._minimapInterval) return;
    this._minimapLastDraw = now;

    // (Re)build the STATIC course layer once per track (also computes the cached
    // world->canvas fit transform on this._minimapFit). _minimapFit is nulled by
    // setMinimapSource (track change) and the quality subscriber (tier change),
    // which is what forces a rebuild here.
    if (!this._minimapFit) this._buildMinimapLayer(checkpoints);
    const fit = this._minimapFit;

    const ctx = this._minimapCtx;
    const S = this._minimapSize; // logical canvas size (square)

    // Blit the pre-rendered static course layer (backdrop + outline + start ring)
    // in a single drawImage, then draw only the moving kart dots on top.
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this._minimapLayer, 0, 0, S, S);

    // --- Kart dots --------------------------------------------------------
    // One dot per kart from getKarts(). The PLAYER (id 'player' / .ai falsy) is a
    // larger bright-amber dot with a white ring so it stands out; AI are smaller
    // rose dots. Draw AI first so the player dot sits on top. Scalar locals (no
    // per-dot object alloc) and NO per-frame shadowBlur (a big fill-rate cost).
    const karts = manager.getKarts ? manager.getKarts() : null;
    if (karts && karts.length) {
      const minX = fit.minX, minZ = fit.minZ, scale = fit.scale, offX = fit.offX, offZ = fit.offZ;
      // Pass 1: AI dots (drawn underneath). Fill style set once for the whole pass.
      ctx.fillStyle = 'rgba(251, 113, 133, 0.9)'; // rose-400
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const isPlayer = !k.ai || k.id === 'player';
        if (isPlayer) continue;
        const st = k.state;
        if (!st) continue;
        const px = offX + (st.x - minX) * scale;
        const py = S - (offZ + (st.z - minZ) * scale);
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // Pass 2: the player dot (drawn on top, bigger + white-ringed). The size +
      // ring read clearly without the old amber glow's per-frame shadowBlur.
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const isPlayer = !k.ai || k.id === 'player';
        if (!isPlayer) continue;
        const st = k.state;
        if (!st) continue;
        const px = offX + (st.x - minX) * scale;
        const py = S - (offZ + (st.z - minZ) * scale);
        ctx.fillStyle = 'rgba(250, 204, 21, 1)'; // amber-400
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'; // crisp white ring
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // _buildMinimapLayer(checkpoints): pre-render the STATIC minimap course (dark
  // backdrop + glow/core outline + start ring) into an offscreen canvas ONCE per
  // track, and compute + cache the world->canvas fit transform on this._minimapFit.
  // The course never moves mid-race, so _drawMinimap just blits this layer each
  // frame. The wide GLOW pass (shadowBlur) is SKIPPED on the LOW tier so LOW stays
  // byte-for-byte as cheap as before (no added fill-rate cost — see HARD CONSTRAINT).
  _buildMinimapLayer(checkpoints) {
    const S = this._minimapSize;  // logical canvas size (square)
    const dpr = this._minimapDpr; // backing-store scale (matches the live canvas)
    const pad = 16;               // px breathing room around the loop

    // Fit transform: the loop's XZ bounds scaled uniformly into the padded box
    // (keeps the loop's real proportions instead of stretching to a square),
    // centered, with Z flipped so +Z reads as "up" (TrackSelect's convention).
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const cp of checkpoints) {
      if (cp.x < minX) minX = cp.x;
      if (cp.x > maxX) maxX = cp.x;
      if (cp.z < minZ) minZ = cp.z;
      if (cp.z > maxZ) maxZ = cp.z;
    }
    const spanX = Math.max(1e-3, maxX - minX);
    const spanZ = Math.max(1e-3, maxZ - minZ);
    const scale = Math.min((S - 2 * pad) / spanX, (S - 2 * pad) / spanZ);
    const offX = (S - spanX * scale) / 2;
    const offZ = (S - spanZ * scale) / 2;
    this._minimapFit = { minX, minZ, scale, offX, offZ };

    // Offscreen layer canvas at the SAME device resolution as the live canvas, its
    // context scaled by dpr so we draw in logical px (crisp on retina). Reused
    // across tracks — created only once.
    if (!this._minimapLayer) {
      this._minimapLayer = document.createElement('canvas');
      this._minimapLayer.width = S * dpr;
      this._minimapLayer.height = S * dpr;
    }
    const lctx = this._minimapLayer.getContext('2d');
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0); // logical px coords (reset any prior)
    lctx.clearRect(0, 0, S, S);

    // Dark radar backdrop.
    lctx.fillStyle = 'rgba(6, 10, 22, 0.55)'; // deep navy, slightly translucent
    lctx.fillRect(0, 0, S, S);

    lctx.lineJoin = 'round';
    lctx.lineCap = 'round';

    // Trace the checkpoint loop once; reused for the glow + core strokes.
    const trace = () => {
      lctx.beginPath();
      for (let i = 0; i < checkpoints.length; i++) {
        const px = offX + (checkpoints[i].x - minX) * scale;
        const py = S - (offZ + (checkpoints[i].z - minZ) * scale);
        if (i === 0) lctx.moveTo(px, py); else lctx.lineTo(px, py);
      }
      lctx.closePath();
    };

    // Soft wide GLOW pass so the line reads as emissive neon — SKIPPED on LOW
    // (shadowBlur is a real fill-rate cost; LOW keeps just the crisp core line).
    if (qualitySettings.tier !== 'low') {
      lctx.save();
      lctx.shadowColor = 'rgba(34, 211, 238, 0.9)'; // cyan-400
      lctx.shadowBlur = 8;
      lctx.strokeStyle = 'rgba(34, 211, 238, 0.35)';
      lctx.lineWidth = 6;
      trace();
      lctx.stroke();
      lctx.restore();
    }

    // Crisp bright CORE line on top of the glow.
    lctx.strokeStyle = 'rgba(165, 243, 252, 0.95)'; // cyan-200
    lctx.lineWidth = 2;
    trace();
    lctx.stroke();

    // Start/finish marker: a small ring on checkpoint 0 so the lap line reads.
    {
      const px = offX + (checkpoints[0].x - minX) * scale;
      const py = S - (offZ + (checkpoints[0].z - minZ) * scale);
      lctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      lctx.lineWidth = 1.5;
      lctx.beginPath();
      lctx.arc(px, py, 3.5, 0, Math.PI * 2);
      lctx.stroke();
    }
  }

  // _maybeShowItemHint() shows the first-race onboarding banner ONCE: it teaches
  // that items come from the floating "?" boxes you drive through, and that SHIFT
  // uses a held item. It is gated three ways so it never nags:
  //   1. _hintShown      -> never twice in one session.
  //   2. localStorage flag mk_seen_item_hint -> never again on later races.
  //   3. self-dismiss     -> fades in, holds a few seconds, fades out, then hides.
  // It is safe to call every frame; after the first call it early-returns.
  _maybeShowItemHint() {
    // Already shown this session — nothing to do.
    if (this._hintShown) return;
    this._hintShown = true; // mark immediately so re-entry this frame is a no-op

    // Persisted gate: if the player has seen the hint in a PRIOR race, skip it.
    // Wrapped in try/catch because localStorage can throw (private mode / disabled
    // storage); if it throws we just treat the hint as "not seen" and show it.
    let seen = false;
    try {
      seen = window.localStorage.getItem('mk_seen_item_hint') === '1';
    } catch (e) {
      seen = false;
    }
    if (seen) return;

    // Remember that we've now shown it so future races stay clean.
    try {
      window.localStorage.setItem('mk_seen_item_hint', '1');
    } catch (e) {
      // Storage unavailable — the session-level _hintShown guard still prevents
      // repeats within this run, which is the important case.
    }

    // Reveal: drop the layout-removing `hidden`, then on the NEXT frame bump
    // opacity to 1 so the CSS opacity transition actually animates (you can't
    // transition from display:none in the same frame). requestAnimationFrame
    // defers the opacity change until after the element is laid out.
    this.itemHintElement.classList.remove('hidden');
    requestAnimationFrame(() => {
      this.itemHintElement.classList.remove('opacity-0');
    });

    // Auto-fade after ~5s, then fully hide after the 500ms fade completes so it
    // stops taking layout space. Track the timer ids so nothing leaks.
    const fadeTimer = window.setTimeout(() => {
      this.itemHintElement.classList.add('opacity-0');
      const hideTimer = window.setTimeout(() => {
        this.itemHintElement.classList.add('hidden');
      }, 550); // a hair longer than the 500ms CSS fade
      this._hintTimers.push(hideTimer);
    }, 5000);
    this._hintTimers.push(fadeTimer);
  }

  // _playRoulette(finalIcon) runs a short (~0.6s) item-box spin: it rapidly
  // flickers the icon through a handful of random item emojis while popping the
  // card with GSAP, then snaps to the real `finalIcon` and settles. Called once
  // per fresh pickup (see setHeldItem), never per frame.
  _playRoulette(finalIcon) {
    // Kill any spin still running from a previous pickup so two pickups in quick
    // succession don't fight over the icon / transform.
    if (this._rouletteTimeline) {
      this._rouletteTimeline.kill();
      this._rouletteTimeline = null;
    }

    // A pool of item emojis to flicker through. We pull every icon from the
    // ITEMS catalog so the spin shows real item faces; fall back to a few if the
    // catalog were ever empty.
    const pool = Object.values(ITEMS)
      .map((def) => def.icon)
      .filter(Boolean);
    const faces = pool.length ? pool : ['🐢', '🍌', '🍄', '⭐', '⚡'];

    const icon = this.itemIconElement;
    const tl = gsap.timeline({
      onComplete: () => {
        this._rouletteTimeline = null;
      },
    });
    this._rouletteTimeline = tl;

    // 1) Flicker: ~10 quick icon swaps over ~0.5s. Each step writes a random
    //    face; firstChild guards the ×N badge (a child <span>) from being wiped
    //    — we set only the leading text node, not the whole element.
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      tl.call(
        () => {
          const face = faces[Math.floor(Math.random() * faces.length)];
          this._setIconGlyph(face);
        },
        null,
        i * 0.05
      );
    }

    // 2) Settle: at the end of the flicker, snap to the REAL icon so the slot
    //    always finishes on the item the player actually holds.
    tl.call(() => this._setIconGlyph(finalIcon), null, steps * 0.05);

    // 3) Pop the whole card: scale up then ease back to rest, with the icon
    //    spinning once, so the pickup reads as a celebratory "got it!" beat.
    tl.fromTo(
      this.itemPanel,
      { scale: 0.7 },
      { scale: 1.12, duration: 0.18, ease: 'back.out(2)' },
      0
    );
    tl.to(this.itemPanel, { scale: 1, duration: 0.2, ease: 'power2.out' }, steps * 0.05);
    tl.fromTo(
      icon,
      { rotation: -180 },
      { rotation: 0, duration: steps * 0.05 + 0.2, ease: 'power2.out' },
      0
    );
  }

  // _setIconGlyph(glyph) updates the ACTIVE tile's glyph (tile 0) — used by the
  // roulette. Delegates to _setTileGlyph so the badge child is preserved.
  _setIconGlyph(glyph) {
    this._setTileGlyph(this.itemIconElement, glyph);
  }

  // _setTileGlyph(el, glyph) replaces ONLY a tile's leading text (the emoji)
  // without disturbing the ×N badge child. The badge is an appended <span>, so we
  // write the glyph into the first node and keep the span intact.
  _setTileGlyph(el, glyph) {
    if (!el) return;
    const first = el.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      first.nodeValue = glyph;
    } else {
      el.insertBefore(document.createTextNode(glyph), el.firstChild);
    }
  }

  // _updateBattle(info) shows the BATTLE-mode HUD: a row of balloon icons for
  // the player's remaining balloons, and how many players are still ALIVE.
  //   info.balloons      -> balloons the player has left (default 3)
  //   info.maxBalloons   -> total balloon slots to show (default 3)
  //   info.alive         -> number of players still in the match (default 1)
  // We render filled balloon icons for remaining balloons and faded ones for
  // lost balloons so the count reads at a glance.
  _updateBattle(info) {
    // Hide the race-only elements (lap counter + position readout + lap timer).
    this.lapElement.classList.add('hidden');
    this.positionElement.classList.add('hidden');
    this.timerElement.classList.add('hidden');
    // The mid-air TRICK label can NEVER fire in the flat arena (no ramps = no
    // air), so keep it hidden in battle. (The overdrive meter + mini-turbo pill
    // are KEPT: both charge from DRIFTING on the flat floor, so they're earned
    // feedback, and each self-hides when idle — no clutter when unused.)
    this.trickElement.classList.add('hidden');

    // Show the battle elements (balloon row + standings panel). The old bare "N ALIVE"
    // count is replaced by the richer standings leaderboard, so keep it hidden.
    this.balloonsElement.classList.remove('hidden');
    this.aliveElement.classList.add('hidden');

    // Match clock: mm:ss remaining, pulsing red in the final 10 seconds.
    this._updateBattleClock(info.timeLeft);

    const max = info.maxBalloons != null ? Math.max(1, Math.round(info.maxBalloons)) : 3;
    const balloons = info.balloons != null
      ? Math.min(Math.max(0, Math.round(info.balloons)), max)
      : max;

    // Top-center row. While ALIVE: a balloon per remaining one (dimmed for lost ones)
    // + the player's KILL count (★). Once ELIMINATED: a clear SPECTATING badge instead,
    // since the player has no balloons and is now flying the free spectator cam.
    let html = '';
    if (info.spectating) {
      html = '<span class="text-lg font-black tracking-widest text-rose-300">👁 SPECTATING</span>';
    } else {
      for (let i = 0; i < max; i++) {
        const lost = i >= balloons;
        html += '<span class="' + (lost ? 'opacity-30 scale-90' : '') + '">🎈</span>';
      }
      if (info.score != null) {
        html += '<span class="ml-3 text-amber-300 font-black tabular-nums">★' +
          Math.max(0, Math.round(info.score)) + '</span>';
      }
    }
    this.balloonsElement.innerHTML = html;

    // Live standings leaderboard (top-right): survivors first, eliminated dimmed.
    this._updateBattleStandings(info.standings);
  }

  // _updateBattleStandings(standings): render/refresh the top-right battle leaderboard.
  // `standings` is the field sorted best-first: [{id,name,color,isPlayer,score,balloons,down}].
  // We only rewrite the DOM when the data changes (signature gate) so feeding it every
  // frame is cheap. The player's row is highlighted; a downed kart dims + shows "···".
  _updateBattleStandings(standings) {
    const el = this.battleStandingsElement;
    if (!Array.isArray(standings) || standings.length === 0) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');

    // Signature: skip the rebuild when nothing visible changed.
    let sig = '';
    for (let i = 0; i < standings.length; i++) {
      const s = standings[i];
      sig += s.id + ':' + s.score + ':' + s.balloons + ':' + (s.down ? 1 : 0) + '|';
    }
    if (sig === this._standingsSig) return;
    this._standingsSig = sig;

    // With a big battle field (up to 12 karts) the full list would overflow the screen, so
    // we show the TOP rows plus — if they've slipped below the cut — the player's own row
    // (tagged with its true rank) so you can always see where you stand.
    const CAP = 8;
    const rows = [];
    for (let i = 0; i < standings.length && rows.length < CAP; i++) rows.push({ s: standings[i], rank: i + 1 });
    if (!rows.some((r) => r.s.isPlayer)) {
      const pIdx = standings.findIndex((s) => s.isPlayer);
      if (pIdx >= 0) rows.push({ s: standings[pIdx], rank: pIdx + 1 });
    }

    let html =
      '<div class="text-[10px] font-bold tracking-[0.2em] text-white/55 px-1">STANDINGS</div>';
    for (let r = 0; r < rows.length; r++) {
      const s = rows[r].s;
      const rank = rows[r].rank;
      const rowCls = s.isPlayer
        ? 'bg-cyan-500/25 ring-1 ring-cyan-300/70 text-cyan-100'
        : 'bg-slate-800/40 ring-1 ring-white/10 text-slate-100';
      // `down` now means MID-RESPAWN (everyone respawns in the score race) — a brief dim +
      // "···" cue, not a permanent "OUT".
      const dim = s.down ? ' opacity-50' : '';
      const chip =
        '<span class="inline-block w-2.5 h-2.5 rounded-full ring-1 ring-white/40 shrink-0" ' +
        'style="background:' + this._battleColorCss(s.color) + '"></span>';
      const tally = s.down
        ? '<span class="text-[10px] font-black text-rose-300/80 tracking-wide">···</span>'
        : '<span class="text-[10px] opacity-70 tabular-nums">🎈' + s.balloons + '</span>';
      html +=
        '<div class="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md text-xs ' + rowCls + dim + '">' +
        '<span class="w-3 text-center font-black tabular-nums opacity-60">' + rank + '</span>' +
        chip +
        '<span class="flex-1 truncate font-semibold">' + this._escapeName(s.name) + '</span>' +
        '<span class="font-black tabular-nums text-amber-300">★' + s.score + '</span>' +
        tally +
        '</div>';
    }
    el.innerHTML = html;
  }

  // _battleColorCss(c): a kart's body colour as a CSS string. Numbers are treated as
  // 0xRRGGBB hex ints (the battle palette); anything else passes through as-is.
  _battleColorCss(c) {
    if (typeof c === 'number') return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    return c || '#ffffff';
  }

  // _escapeName(n): minimal HTML-escape for a kart name dropped into innerHTML, so a
  // stray character in a future custom name can never break the markup.
  _escapeName(n) {
    return String(n == null ? '' : n)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // _updateBattleClock(timeLeft) shows the remaining match time (seconds) as a
  // top-center mm:ss pill. In the FINAL 10 seconds it turns red + pulses so the
  // urgency reads at a glance. Hidden entirely when timeLeft is not supplied.
  _updateBattleClock(timeLeft) {
    const el = this.battleClockElement;
    if (timeLeft == null) {
      el.classList.add('hidden');
      return;
    }
    const secs = Math.max(0, Math.ceil(timeLeft));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    el.textContent = m + ':' + String(s).padStart(2, '0');

    // Base pill (top-center, under the balloon row). The final-10s state swaps to
    // a red, pulsing alarm; we rebuild the class string so stale colours never
    // linger (mirrors _updateMiniTurbo's approach).
    const base =
      'absolute top-12 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full ' +
      'backdrop-blur-sm text-xl font-black tabular-nums tracking-wider drop-shadow ';
    if (secs <= 10) {
      el.className = base +
        'bg-red-900/50 ring-2 ring-red-400/80 text-red-200 shadow-lg shadow-red-500/40 animate-pulse';
    } else {
      el.className = base + 'bg-slate-900/55 ring-1 ring-white/15 text-white';
    }
  }

  // _punchPosition(position): on a CHANGE in race place, scale-punch the position
  // pill and flash a ▲ (green, gained) or ▼ (red, lost) delta beside it, then settle
  // the ordinal tint back to white. The FIRST frame just seeds _lastPosition so no
  // punch false-fires before there's a real previous place to compare against.
  _punchPosition(position) {
    const prev = this._lastPosition;
    this._lastPosition = position;
    if (prev == null || position === prev) return;
    const gained = position < prev; // a LOWER place number is a BETTER position

    // Scale punch on the whole pill.
    gsap.fromTo(
      this.positionElement,
      { scale: 1.3 },
      { scale: 1, duration: 0.45, ease: 'back.out(2)' }
    );

    // Tint the ordinal toward the move; swapped like _updateMiniTurbo so a stale
    // colour never lingers, and settled back to white on the arrow's onComplete.
    const ord = this.positionOrdinalElement;
    ord.classList.remove('text-emerald-300', 'text-rose-400');
    ord.classList.add(gained ? 'text-emerald-300' : 'text-rose-400');

    // A small ▲/▼ delta arrow that pops beside the readout and fades. Built once;
    // positioned relative to the (absolute) position pill, just off its left edge.
    if (!this._posDeltaElement) {
      this._posDeltaElement = document.createElement('span');
      this._posDeltaElement.className =
        'absolute -left-5 top-1 text-xl font-black drop-shadow opacity-0';
      this.positionElement.appendChild(this._posDeltaElement);
    }
    const arrow = this._posDeltaElement;
    arrow.textContent = gained ? '▲' : '▼';
    arrow.classList.remove('text-emerald-300', 'text-rose-400');
    arrow.classList.add(gained ? 'text-emerald-300' : 'text-rose-400');
    if (this._posDeltaTween) this._posDeltaTween.kill();
    this._posDeltaTween = gsap.fromTo(
      arrow,
      { opacity: 1, y: gained ? 8 : -8 },
      {
        opacity: 0,
        y: gained ? -6 : 6,
        duration: 0.9,
        ease: 'power2.out',
        onComplete: () => ord.classList.remove('text-emerald-300', 'text-rose-400'),
      }
    );
  }

  // _maybeFinalLap(lap, totalLaps): fire a one-shot "FINAL LAP" alert banner the
  // first frame the player enters the last lap of a MULTI-lap race, and pulse the
  // lap pill ring red so the urgency reads. Resets when the lap drops back below the
  // total (the HUD is reused across GP races), so the next race can fire it again.
  _maybeFinalLap(lap, totalLaps) {
    const isFinal = totalLaps > 1 && lap >= totalLaps;
    if (isFinal && !this._finalLapShown) {
      this._finalLapShown = true;
      this.showRewardBanner('FINAL LAP', 'alert');
      // Pulse the lap pill red to underscore the last lap.
      this.lapElement.classList.remove('ring-cyan-400/40');
      this.lapElement.classList.add('ring-rose-400/80', 'animate-pulse');
    } else if (!isFinal && this._finalLapShown) {
      // Fresh race (lap counter reset): clear the alert state + restore the pill.
      this._finalLapShown = false;
      this.lapElement.classList.remove('ring-rose-400/80', 'animate-pulse');
      this.lapElement.classList.add('ring-cyan-400/40');
    }
  }

  // _ordinal(n) -> the English ordinal string for a positive integer, e.g.
  //   1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th",
  //   21 -> "21st", 22 -> "22nd", 23 -> "23rd".
  // Rule: 11/12/13 always take "th" (the "teens" exception); otherwise the
  // suffix is chosen by the last digit (1->st, 2->nd, 3->rd, else th).
  _ordinal(n) {
    const num = Math.max(1, Math.round(n)); // guard against 0/negatives/decimals
    const tens = num % 100;                 // last two digits, for the teens check
    const ones = num % 10;                  // last digit, for the normal suffix
    let suffix = 'th';
    if (tens < 11 || tens > 13) {
      if (ones === 1) suffix = 'st';
      else if (ones === 2) suffix = 'nd';
      else if (ones === 3) suffix = 'rd';
    }
    return num + suffix;
  }

  // _formatTime(seconds) -> a "mm:ss.mmm" string (minutes:seconds.milliseconds).
  // If seconds is null/undefined/NaN (e.g. no best lap yet) we return a dashed
  // placeholder so the layout stays stable.
  _formatTime(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '--:--.---';

    const totalMs = Math.max(0, Math.floor(seconds * 1000)); // whole milliseconds
    const minutes = Math.floor(totalMs / 60000);             // 60000 ms per minute
    const secs = Math.floor((totalMs % 60000) / 1000);       // remaining whole seconds
    const millis = totalMs % 1000;                           // remaining milliseconds

    // padStart() left-pads with '0' so the columns line up: 2 digits for
    // minutes/seconds, 3 digits for milliseconds.
    const mm = String(minutes).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    const mmm = String(millis).padStart(3, '0');
    return mm + ':' + ss + '.' + mmm;
  }

  // _updateMiniTurbo(tier) toggles and colours the charge pill.
  //   tier 0 -> hidden (no charge building)
  //   tier 1 -> blue, tier 2 -> orange, tier 3 -> purple
  // We rebuild the class list each call so switching tiers cleanly swaps the
  // colour utilities (background + glow ring) without leaving stale ones on.
  _updateMiniTurbo(tier) {
    const t = tier != null ? tier : 0;
    const el = this.miniTurboElement;

    // No charge -> hide the pill entirely and stop.
    if (t <= 0) {
      el.classList.add('hidden');
      return;
    }

    // Base classes shared by every tier (position, shape, text styling). These
    // mirror the className set in the constructor, minus the colour/glow which
    // we add per-tier below.
    const base =
      'absolute bottom-16 left-4 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider';

    // Per-tier colour: a solid background plus a matching ring "glow" so the
    // pill looks like it is charging up. Label text changes too for clarity.
    let colour;
    let label;
    if (t >= 3) {
      colour = 'bg-purple-500 text-white ring-2 ring-purple-300 shadow-lg shadow-purple-500/50';
      label = 'ULTRA';
    } else if (t === 2) {
      colour = 'bg-orange-500 text-white ring-2 ring-orange-300 shadow-lg shadow-orange-500/50';
      label = 'SUPER';
    } else {
      colour = 'bg-blue-500 text-white ring-2 ring-blue-300 shadow-lg shadow-blue-500/50';
      label = 'TURBO';
    }

    el.className = base + ' ' + colour; // visible (no "hidden" in this string)
    el.textContent = label;
  }
}
