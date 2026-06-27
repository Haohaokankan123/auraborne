// src/ui/screens/TrackSelect.js
//
// The TRACK PICKER screen (M6). After choosing a mode and a character, the
// player lands here to choose which circuit to race on. Like Menu.js and the
// HUD, it is a plain HTML/CSS overlay (NO three.js) styled with Tailwind
// utility classes, drawn above the game canvas.
//
// It lists every track from the shared TRACKS registry as a selectable card.
// Each card shows:
//   - the track's name,
//   - a color swatch (the track's accent color), and
//   - a small TOP-DOWN PREVIEW drawn on a <canvas> from that track's
//     centerline checkpoints (so the shape of the loop is visible at a glance).
//
// Clicking a card selects it (highlights it); CONFIRM reports the chosen track
// id back to the caller via onConfirm(trackId). A BACK button calls onBack().
//
// Tolerance note: both callbacks may be omitted; missing handlers default to a
// no-op so the screen never throws if something isn't wired up yet.
//
// pointer-events note: like Menu.js, this overlay MUST receive clicks, so its
// root sets `pointer-events-auto` and a high z-index so it sits above the
// canvas and HUD.
//
// Polish: show() plays a short GSAP entrance — the heading fades/slides in, then
// the track cards stagger up into place. GSAP is the project's chosen animation
// library and works in this vanilla-JS / Vite setup with no framework.

import gsap from 'gsap';
// Renderer-free track data — the SAME registry the client/server build from, so
// the preview shapes match the real circuits exactly. We read the track list,
// each track's display metadata (name + accent color), and its centerline
// checkpoints to draw the top-down preview.
import { getTrackIds, getTrackMeta, buildCheckpoints } from '../../../shared/trackData.js';

// --- Per-track VISUAL THEMES -------------------------------------------------
// The three race circuits are now ELEVATED FLOATING tracks, each with its own
// dark-skybox theme so the neon glow pops. This map mirrors that art direction
// in the picker so the card you click looks like the world you'll race in.
//
// Keyed by trackId (the registry key: 'circuit' | 'oval' | 'figure'). Each entry:
//   - accent  : neon line color for the top-down preview + glow (CSS string).
//   - accent2 : a second neon hue used for the rainbow/space gradient sweep.
//   - sky     : dark backdrop drawn behind the preview loop (the "skybox").
//   - sky2    : second backdrop stop for a subtle vertical gradient.
//   - rainbow : when true, the preview loop is stroked as a multi-hue rainbow
//               (Rainbow Road) instead of a single accent color.
//   - label   : the themed display name shown on the card. Falls back to the
//               registry name if a track id isn't listed here.
// If a trackId is missing from this map we degrade gracefully to the registry
// meta (name + color), so adding a 4th track never breaks the screen.
const TRACK_THEMES = {
  // Rainbow Road — a prismatic ribbon over a deep starfield.
  circuit: {
    label: 'Rainbow Road',
    accent: '#ff4fd8',
    accent2: '#4fc3ff',
    sky: '#150a2e',
    sky2: '#05030f',
    rainbow: true,
  },
  // Cosmic Speedway — deep-space purple/blue with a cyan racing line.
  oval: {
    label: 'Cosmic Speedway',
    accent: '#37e6ff',
    accent2: '#7a5cff',
    sky: '#0a1340',
    sky2: '#03040f',
    rainbow: false,
  },
  // Cloudtop Circuit — bright sky blue against a dusk-gradient backdrop.
  figure: {
    label: 'Cloudtop Circuit',
    accent: '#7fdcff',
    accent2: '#c8b4ff',
    sky: '#102742',
    sky2: '#041018',
    rainbow: false,
  },
};

export class TrackSelect {
  /**
   * @param {Object} opts
   * @param {Function} [opts.onConfirm] Called with the chosen trackId when CONFIRM
   *   is clicked, e.g. onConfirm('oval').
   * @param {Function} [opts.onBack]    Called when BACK is clicked.
   * @param {Function} [opts.onCup]     Called when the GRAND PRIX CUP banner is
   *   clicked (Grand Prix only — see show({ cup })).
   */
  constructor({ onConfirm, onBack, onCup } = {}) {
    // Keep callbacks; default to no-ops so a missing handler never throws.
    this._onConfirm = onConfirm || (() => {});
    this._onBack = onBack || (() => {});
    this._onCup = onCup || (() => {});

    // The currently-selected track id. Defaults to the first registered track
    // so CONFIRM always has a valid selection even with no interaction.
    this._trackIds = getTrackIds();
    this._selectedId = this._trackIds[0] || 'circuit';

    // Card elements, keyed by trackId, so selection can toggle highlight styles.
    this._cards = {};

    // --- Root overlay -----------------------------------------------------
    // Full-screen centered flex container, matching Menu.js conventions:
    // `fixed inset-0` pins to viewport, `pointer-events-auto` takes clicks, a
    // dark gradient backdrop keeps the bright cards readable.
    this.element = document.createElement('div');
    this.element.id = 'track-select-screen';
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
    heading.textContent = 'SELECT TRACK';
    heading.className = [
      'text-4xl', 'md:text-6xl', 'font-black', 'tracking-tight', 'mb-2',
      'bg-gradient-to-r', 'from-fuchsia-400', 'via-cyan-300', 'to-violet-400',
      'bg-clip-text', 'text-transparent',
      'drop-shadow-[0_0_28px_rgba(120,180,255,0.45)]',
    ].join(' ');
    this.element.appendChild(heading);
    this._heading = heading;

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Choose your circuit';
    subtitle.className = 'text-base md:text-lg text-slate-300 mb-8 tracking-widest uppercase';
    this.element.appendChild(subtitle);

    // --- GRAND PRIX CUP banner -------------------------------------------
    // A gold full-width call-to-action ABOVE the track cards. Clicking it skips
    // the single-track choice and launches the 3-track championship. Shown only on
    // the Grand Prix path (see show({ cup })); hidden by default for Time Trial.
    const cupBtn = document.createElement('button');
    cupBtn.type = 'button';
    cupBtn.textContent = '🏆 GRAND PRIX CUP — all 3 tracks';
    cupBtn.className = [
      'w-full', 'max-w-xl', 'mb-6', 'py-4', 'rounded-2xl',
      'text-lg', 'md:text-xl', 'font-black', 'tracking-wide', 'uppercase',
      'bg-gradient-to-r', 'from-amber-400', 'via-yellow-500', 'to-amber-500',
      'text-amber-950',
      'shadow-lg', 'shadow-amber-500/30',
      'transition', 'duration-150',
      'hover:scale-[1.02]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-amber-200',
    ].join(' ');
    cupBtn.addEventListener('click', () => this._onCup());
    cupBtn.style.display = 'none'; // revealed by show({ cup: true })
    this.element.appendChild(cupBtn);
    this._cupBtn = cupBtn;

    // --- Track cards ------------------------------------------------------
    // A responsive row/grid of cards, one per track.
    const grid = document.createElement('div');
    grid.className = 'flex flex-wrap justify-center gap-5 mb-8';

    for (const id of this._trackIds) {
      const card = this._makeCard(id);
      grid.appendChild(card);
      this._cards[id] = card;
    }
    this.element.appendChild(grid);
    // Keep cards (in order) so show() can stagger them in.
    this._cardList = this._trackIds.map((id) => this._cards[id]);

    // Apply the initial selection highlight.
    this._select(this._selectedId);

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
    confirmBtn.textContent = 'CONFIRM';
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
    confirmBtn.addEventListener('click', () => this._onConfirm(this._selectedId));

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
   * Build one clickable track card: name + color swatch + top-down preview.
   * @param {string} trackId
   * @returns {HTMLDivElement}
   * @private
   */
  _makeCard(trackId) {
    const meta = getTrackMeta(trackId); // { id, name, color }
    // Themed visuals for this track (neon accents + dark sky). Fall back to the
    // registry meta so an unlisted track still renders correctly.
    const theme = TRACK_THEMES[trackId] || null;
    const registryHex = '#' + (meta.color >>> 0).toString(16).padStart(6, '0').slice(-6);
    const accent = (theme && theme.accent) || registryHex;
    const accent2 = (theme && theme.accent2) || accent;
    const displayName = (theme && theme.label) || meta.name;

    const card = document.createElement('div');
    card.dataset.trackId = trackId;
    // Base card styling; selection adds a colored neon ring (see _select()).
    // A dark glassy card lets the themed preview + glow read as a "portal" into
    // that world. The per-track accent glow is applied via inline boxShadow.
    card.className = [
      'w-56', 'rounded-2xl', 'p-4', 'cursor-pointer',
      'bg-slate-900/70', 'backdrop-blur',
      'border-2', 'border-white/10',
      'transition', 'duration-200',
      'hover:scale-[1.04]',
      'flex', 'flex-col', 'items-center', 'gap-3',
    ].join(' ');
    // Soft neon under-glow in the track's accent — stronger on hover via JS.
    card.style.boxShadow = `0 8px 28px -6px ${accent}55, 0 0 0 1px ${accent}22`;
    card.addEventListener('mouseenter', () => {
      card.style.boxShadow = `0 12px 38px -4px ${accent}88, 0 0 0 1px ${accent}55`;
    });
    card.addEventListener('mouseleave', () => {
      // Restore base/selected glow (the selected card keeps a brighter ring).
      const sel = trackId === this._selectedId;
      card.style.boxShadow = sel
        ? `0 12px 40px -2px ${accent}aa, 0 0 0 2px ${accent}`
        : `0 8px 28px -6px ${accent}55, 0 0 0 1px ${accent}22`;
    });

    // Top-down preview canvas drawn from this track's checkpoints, on a dark
    // themed "skybox" backdrop so the neon racing line glows.
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 160;
    canvas.className = 'rounded-lg w-full';
    this._drawPreview(canvas, trackId, accent, theme);
    card.appendChild(canvas);

    // Name + swatch row.
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 w-full';

    // Swatch: a small neon gradient pill (accent -> accent2) with a matching
    // glow, so the badge previews the track's color story at a glance.
    const swatch = document.createElement('span');
    swatch.className = 'inline-block w-4 h-4 rounded-full shrink-0 ring-1 ring-white/30';
    swatch.style.background = `linear-gradient(135deg, ${accent}, ${accent2})`;
    swatch.style.boxShadow = `0 0 8px ${accent}cc`;
    row.appendChild(swatch);

    const name = document.createElement('span');
    name.textContent = displayName;
    name.className = 'text-lg font-bold tracking-wide truncate';
    // Tint the name with a faint accent glow to tie it to the theme.
    name.style.textShadow = `0 0 12px ${accent}66`;
    row.appendChild(name);

    card.appendChild(row);

    // Stash the resolved accent so _select() can paint a themed neon ring.
    card._accent = accent;

    // Clicking the card selects this track.
    card.addEventListener('click', () => this._select(trackId));

    return card;
  }

  /**
   * Draw a top-down preview of a track's loop onto a canvas, using its
   * centerline checkpoints. The loop is auto-fitted (scaled + centered) into the
   * canvas with padding, then stroked in the track's accent color.
   * @param {HTMLCanvasElement} canvas
   * @param {string} trackId
   * @param {string} accent   CSS color string for the road line / glow.
   * @param {object|null} theme  Per-track theme (sky/sky2/accent2/rainbow), or
   *                             null to fall back to a generic dark backdrop.
   * @private
   */
  _drawPreview(canvas, trackId, accent, theme) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const pad = 18; // px padding around the loop inside the canvas

    ctx.clearRect(0, 0, W, H);

    // Dark themed "skybox" backdrop so the neon racing line glows against it
    // (mirrors the elevated floating tracks' dark skyboxes). Vertical gradient
    // from the theme's sky -> sky2; generic deep-space fallback otherwise.
    const skyTop = (theme && theme.sky) || '#0b0f1f';
    const skyBot = (theme && theme.sky2) || '#04060d';
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, skyTop);
    bg.addColorStop(1, skyBot);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Sprinkle a few faint stars so the backdrop reads as a sky (deterministic
    // positions via a tiny hash on the trackId so previews are stable).
    let seed = 0;
    for (let i = 0; i < trackId.length; i++) seed = (seed * 31 + trackId.charCodeAt(i)) >>> 0;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 26; i++) {
      const sx = rng() * W;
      const sy = rng() * H;
      const r = rng() * 1.1 + 0.2;
      ctx.globalAlpha = 0.25 + rng() * 0.55;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const gates = buildCheckpoints(trackId); // [{ x, z, index }] ordered loop
    if (!gates || gates.length === 0) return;

    // Find the loop's XZ bounds to fit it into the canvas.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const g of gates) {
      if (g.x < minX) minX = g.x;
      if (g.x > maxX) maxX = g.x;
      if (g.z < minZ) minZ = g.z;
      if (g.z > maxZ) maxZ = g.z;
    }
    const spanX = Math.max(1e-3, maxX - minX);
    const spanZ = Math.max(1e-3, maxZ - minZ);
    // Uniform scale that fits both axes inside the padded canvas.
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanZ);
    // Center the fitted loop within the canvas.
    const offX = (W - spanX * scale) / 2;
    const offZ = (H - spanZ * scale) / 2;

    // Map a world (x, z) to canvas pixels. We flip Z so +Z reads as "up".
    const toPx = (x, z) => ({
      px: offX + (x - minX) * scale,
      py: H - (offZ + (z - minZ) * scale),
    });

    // Trace the loop path once; reused for the glow, shoulder, and core strokes.
    const tracePath = () => {
      ctx.beginPath();
      gates.forEach((g, i) => {
        const { px, py } = toPx(g.x, g.z);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
    };

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // 1) Wide soft GLOW pass — a blurred fat stroke in the accent color so the
    //    line reads as emissive neon against the dark sky.
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 11;
    ctx.strokeStyle = accent;
    tracePath();
    ctx.stroke();
    ctx.restore();

    // 2) Faint outer "shoulder" so the road has a touch of body.
    ctx.lineWidth = 9;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    tracePath();
    ctx.stroke();

    // 3) Bright core line. RAINBOW ROAD gets a per-segment hue cycle (a true
    //    prismatic ribbon); other tracks get a 2-stop neon gradient that sweeps
    //    accent -> accent2 across the canvas.
    ctx.lineWidth = 5;
    if (theme && theme.rainbow) {
      // Stroke each segment in the next hue around the color wheel.
      for (let i = 0; i < gates.length; i++) {
        const a = toPx(gates[i].x, gates[i].z);
        const b = toPx(gates[(i + 1) % gates.length].x, gates[(i + 1) % gates.length].z);
        ctx.strokeStyle = `hsl(${Math.round((i / gates.length) * 360)}, 100%, 65%)`;
        ctx.beginPath();
        ctx.moveTo(a.px, a.py);
        ctx.lineTo(b.px, b.py);
        ctx.stroke();
      }
    } else {
      const grad = ctx.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, accent);
      grad.addColorStop(1, (theme && theme.accent2) || accent);
      ctx.strokeStyle = grad;
      tracePath();
      ctx.stroke();
    }

    // Mark the start/finish gate (index 0) with a glowing white dot.
    const start = toPx(gates[0].x, gates[0].z);
    ctx.save();
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(start.px, start.py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Select a track: store the id and update card highlight styles.
   * @param {string} trackId
   * @private
   */
  _select(trackId) {
    this._selectedId = trackId;
    for (const id of this._trackIds) {
      const card = this._cards[id];
      if (!card) continue;
      const selected = id === trackId;
      const accent = card._accent || '#ffffff';
      // Lift the selected card and paint a bright neon ring + glow in its own
      // accent color (instead of a fixed amber), so the highlight matches the
      // theme of the track you've picked.
      card.classList.toggle('scale-[1.04]', selected);
      card.style.borderColor = selected ? accent : 'rgba(255,255,255,0.10)';
      card.style.boxShadow = selected
        ? `0 12px 40px -2px ${accent}aa, 0 0 0 2px ${accent}`
        : `0 8px 28px -6px ${accent}55, 0 0 0 1px ${accent}22`;
    }
  }

  /**
   * Show the screen (and make it interactive), then play a short GSAP entrance:
   * the heading fades/slides in, then the track cards stagger up into place.
   * The screen is fully usable the instant it appears; this is cosmetic only.
   */
  show({ cup = false } = {}) {
    this.element.style.display = 'flex';

    // Reveal the GRAND PRIX CUP banner only on the Grand Prix path.
    this._cupBtn.style.display = cup ? 'block' : 'none';

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
