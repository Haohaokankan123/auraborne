// src/ui/screens/PlayTargetSelect.js
//
// PLAY TARGET — the first question after picking any mode on the menu:
// play HERE (keyboard, this screen — the classic solo flow) or ON TV (phones
// join by QR and the TV split-screens everyone). Replaces the old standalone
// "PLAY ON TV" menu entry so EVERY mode (Grand Prix, Time Trial, Battle) gets
// a TV variant that plays exactly like its solo counterpart.
//
// Plain HTML/CSS overlay in the same Tailwind style as Menu/DifficultySelect.

const MODE_LABELS = { gp: 'GRAND PRIX', tt: 'TIME TRIAL', battle: 'BATTLE' };

export class PlayTargetSelect {
  /**
   * @param {Object}   opts
   * @param {Function} [opts.onHere]  play on this screen (today's exact flow).
   * @param {Function} [opts.onTV]    play on TV (QR lobby + phone controllers).
   * @param {Function} [opts.onBack]  back to the main menu.
   */
  constructor({ onHere, onTV, onBack } = {}) {
    this._onHere = onHere || (() => {});
    this._onTV = onTV || (() => {});
    this._onBack = onBack || (() => {});

    this.element = document.createElement('div');
    this.element.id = 'play-target-select';
    this.element.className = [
      'fixed', 'inset-0', 'z-30', 'pointer-events-auto', 'select-none', 'text-white',
      'flex', 'flex-col', 'items-center', 'justify-center', 'gap-8', 'p-8',
      'bg-gradient-to-b', 'from-slate-900', 'via-slate-800', 'to-slate-900',
    ].join(' ');

    this._title = document.createElement('h1');
    this._title.textContent = 'WHERE TO PLAY?';
    this._title.className = 'text-4xl md:text-5xl font-black tracking-widest text-center';
    this.element.appendChild(this._title);

    this._modeLine = document.createElement('p');
    this._modeLine.className = 'text-lg text-slate-300 -mt-6 tracking-widest uppercase';
    this.element.appendChild(this._modeLine);

    const row = document.createElement('div');
    row.className = 'flex flex-col md:flex-row gap-6 w-full max-w-3xl items-stretch justify-center';

    row.appendChild(this._card(
      'PLAY HERE',
      'Keyboard on this screen',
      'from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500',
      '⌨️',
      () => this._onHere(),
    ));
    row.appendChild(this._card(
      'PLAY ON TV',
      'Phones join by QR code — split-screen party',
      'from-fuchsia-500 to-cyan-500 hover:from-fuchsia-400 hover:to-cyan-400',
      '📺',
      () => this._onTV(),
    ));
    this.element.appendChild(row);

    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'BACK';
    back.className = [
      'px-8', 'py-3', 'rounded-2xl', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-white/10', 'hover:bg-white/20', 'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    back.addEventListener('click', () => this._onBack());
    this.element.appendChild(back);

    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  /** One big choice card: icon + label + subtitle on a mode-colored gradient. */
  _card(label, sub, gradientClasses, icon, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = [
      'flex-1', 'flex', 'flex-col', 'items-center', 'gap-2', 'px-8', 'py-10',
      'rounded-3xl', 'bg-gradient-to-r', gradientClasses,
      'shadow-lg', 'shadow-black/40', 'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.98]',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    const ic = document.createElement('span');
    ic.textContent = icon;
    ic.className = 'text-5xl';
    btn.appendChild(ic);
    const lb = document.createElement('span');
    lb.textContent = label;
    lb.className = 'text-2xl font-black tracking-wide uppercase';
    btn.appendChild(lb);
    const sb = document.createElement('span');
    sb.textContent = sub;
    sb.className = 'text-sm text-white/80';
    btn.appendChild(sb);
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Show the picker for a mode ('gp' | 'tt' | 'battle') so the header names
   * what's being configured.
   */
  show(modeKey) {
    this._modeLine.textContent = MODE_LABELS[modeKey] || '';
    this.element.style.display = 'flex';
  }

  hide() {
    this.element.style.display = 'none';
  }

  dispose() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}

export default PlayTargetSelect;
