// src/ui/screens/CouchLobby.js
//
// COUCH MODE — the lobby shown ON THE TV. The Mac joined the room as a seat-less
// SCREEN (server role 'screen'); this overlay shows a big QR code the family
// scans to turn each phone into a controller, a live roster of who's joined, and
// a host START button (the TV is the host).
//
// TV-friendly: large type, high contrast, readable from across the room.
//
// Server -> client events consumed here:
//   'joined'    { playerId:null, roomId }   -> build the join URL + QR
//   'lobby'     { players:[{id,name,ready,color}], canStart, ... }
//   'raceStart' { fieldSize, totalLaps, startGrid, trackId }
// Client -> server events emitted here:
//   'start' { trackId }
//
// The QR itself is rendered in _renderQR() using the `qrcode` dependency (wired
// in Phase 5). Until then it shows the join URL as large text so phones can type
// it. The URL is: `${location.origin}/controller.html?room=<roomId>`.

import { getTrackMeta } from '../../../shared/trackData.js';

export class CouchLobby {
  /**
   * @param {Object}   opts
   * @param {Object}   opts.socketClient  SocketClient the TV joined with.
   * @param {Object}   [opts.config]      The TV game config chosen on the TV's
   *   setup screens, sent verbatim with 'start' so the server can broadcast it:
   *   { mode: 'gp'|'tt'|'battle', trackId?, difficulty?, cup? }.
   *
   * NB: 'raceStart' is handled by main.js's persistent couch subscription (which
   * builds the race view for both the first race and RACE AGAIN rematches), so the
   * lobby doesn't subscribe to it — it only shows the QR/roster and emits 'start'.
   */
  constructor({ socketClient, config } = {}) {
    this.socket = socketClient;
    this.config = config || { mode: 'gp', trackId: 'circuit' };
    this.trackId = this.config.trackId || 'circuit';

    this._roomId = null;
    this._joinUrl = null;
    this._canStart = false;
    this._kb = false; // "+ KEYBOARD PLAYER": the person at the TV races too

    this._buildDom();
    this._wireSocket();
  }

  _buildDom() {
    this.element = document.createElement('div');
    this.element.id = 'couch-lobby';
    this.element.className = [
      'fixed', 'inset-0', 'z-30', 'pointer-events-auto', 'select-none', 'text-white',
      'flex', 'flex-col', 'items-center', 'justify-center', 'gap-8', 'p-8',
      'bg-gradient-to-b', 'from-[#12071f]', 'via-[#1a0b2e]', 'to-[#06121f]',
    ].join(' ');

    // Title.
    const title = document.createElement('h1');
    title.textContent = 'PLAY ON TV';
    title.className = 'text-5xl md:text-6xl font-black tracking-widest text-center';
    title.style.textShadow = '0 0 24px rgba(255,0,170,.55), 0 0 60px rgba(0,225,255,.30)';
    this.element.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.textContent = 'Scan the code with your phone to grab a kart';
    subtitle.className = 'text-lg md:text-xl text-slate-300 -mt-4 text-center';
    this.element.appendChild(subtitle);

    // Main row: QR (left) + roster (right).
    const row = document.createElement('div');
    row.className = 'flex flex-col md:flex-row items-center md:items-stretch gap-8 w-full max-w-4xl';

    // --- QR / join panel -------------------------------------------------
    const qrPanel = document.createElement('div');
    qrPanel.className = [
      'flex', 'flex-col', 'items-center', 'gap-3',
      'rounded-3xl', 'bg-white', 'p-6', 'shadow-2xl',
    ].join(' ');
    this.qrBox = document.createElement('div');
    this.qrBox.className = 'w-56 h-56 md:w-64 md:h-64 flex items-center justify-center';
    // Placeholder until _renderQR fills it (Phase 5).
    this.qrBox.innerHTML = '<span class="text-slate-400 text-sm">generating…</span>';
    qrPanel.appendChild(this.qrBox);
    this.urlText = document.createElement('div');
    this.urlText.className = 'text-slate-800 text-sm font-mono break-all text-center max-w-[16rem]';
    this.urlText.textContent = 'connecting…';
    qrPanel.appendChild(this.urlText);
    row.appendChild(qrPanel);

    // --- Roster + start panel -------------------------------------------
    const right = document.createElement('div');
    right.className = 'flex-1 flex flex-col gap-4 min-w-0';

    const rosterLabel = document.createElement('p');
    rosterLabel.textContent = 'PLAYERS';
    rosterLabel.className = 'text-sm font-bold tracking-widest text-slate-400';
    right.appendChild(rosterLabel);

    this.playerList = document.createElement('ul');
    this.playerList.className = [
      'flex-1', 'flex', 'flex-col', 'gap-2', 'min-h-[8rem]',
      'rounded-2xl', 'bg-black/30', 'ring-1', 'ring-white/10', 'p-4', 'overflow-y-auto',
    ].join(' ');
    right.appendChild(this.playerList);

    // Track preview.
    this.trackLine = document.createElement('p');
    this.trackLine.className = 'text-sm text-slate-300';
    right.appendChild(this.trackLine);

    // "+ KEYBOARD PLAYER" toggle: the person at the TV joins the field with the
    // keyboard (WASD/arrows). Enables START even before any phone has scanned in.
    this.kbButton = document.createElement('button');
    this.kbButton.type = 'button';
    this.kbButton.className = [
      'px-4', 'py-2', 'rounded-xl', 'text-sm', 'font-bold', 'tracking-wide', 'uppercase',
      'bg-white/10', 'hover:bg-white/20', 'ring-1', 'ring-white/15', 'transition',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    this.kbButton.addEventListener('click', () => {
      this._kb = !this._kb;
      this._renderKb();
      this.startButton.disabled = !(this._canStart || this._kb);
    });
    right.appendChild(this.kbButton);
    this._renderKb();

    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.textContent = this.config.mode === 'battle' ? 'START BATTLE' : 'START RACE';
    this.startButton.disabled = true;
    this.startButton.className = [
      'px-6', 'py-4', 'rounded-2xl', 'font-black', 'tracking-wide', 'uppercase', 'text-lg',
      'bg-gradient-to-r', 'from-fuchsia-500', 'to-cyan-500',
      'hover:from-fuchsia-400', 'hover:to-cyan-400',
      'shadow-lg', 'shadow-fuchsia-500/30', 'transition',
      'hover:scale-[1.02]', 'active:scale-[0.98]',
      'disabled:opacity-40', 'disabled:cursor-not-allowed', 'disabled:hover:scale-100',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/50',
    ].join(' ');
    this.startButton.addEventListener('click', () => this._handleStart());
    right.appendChild(this.startButton);

    row.appendChild(right);
    this.element.appendChild(row);

    this._renderTrack(this.trackId);
    this._renderPlayers([]);

    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  _wireSocket() {
    if (!this.socket || typeof this.socket.onEvent !== 'function') return;

    this._offJoined = this.socket.onEvent('joined', (payload) => {
      const room = payload && payload.roomId != null ? payload.roomId : null;
      if (room) {
        this._roomId = room;
        // Build the join URL phones will open. If the TV opened this page at
        // localhost, phones can't reach that — swap in the server-reported LAN IP.
        // But if the TV was opened at a real address (the LAN IP directly, or a
        // public https tunnel), use THAT origin verbatim so the QR matches — this
        // is what lets a trusted-https tunnel enable tilt with zero phone setup.
        const isLocal = ['localhost', '127.0.0.1', '::1', ''].includes(location.hostname);
        let base;
        if (isLocal && payload && payload.lanIp) {
          const port = location.port ? ':' + location.port : '';
          base = `${location.protocol}//${payload.lanIp}${port}`;
        } else {
          base = location.origin;
        }
        this._joinUrl = `${base}/controller.html?room=${encodeURIComponent(room)}`;
        this.urlText.textContent = this._joinUrl;
        this._renderQR(this._joinUrl);
      }
    });

    this._offLobby = this.socket.onEvent('lobby', (payload) => {
      const players = (payload && payload.players) || [];
      this._canStart = !!(payload && payload.canStart);
      this._renderPlayers(players);
      // The TV's own config owns the track/mode line — the room's server-side
      // trackId default must not overwrite the choice made on the TV's screens.
      // The keyboard player alone is enough to start (no phone required).
      this.startButton.disabled = !(this._canStart || this._kb);
    });
  }

  /**
   * Render the join QR into this.qrBox. Uses the `qrcode` dependency; if it isn't
   * available yet (Phase 2, before the dep is installed) we degrade to the large
   * URL text already shown below the box. Filled in Phase 5.
   * @param {string} url
   * @private
   */
  _renderQR(url) {
    // Lazy dynamic import so the lobby still builds/works before `qrcode` is added.
    import('qrcode')
      .then((mod) => {
        const QR = mod.default || mod;
        const canvas = document.createElement('canvas');
        QR.toCanvas(canvas, url, { width: 256, margin: 1 }, (err) => {
          if (err) return;
          this.qrBox.innerHTML = '';
          canvas.className = 'w-full h-full';
          this.qrBox.appendChild(canvas);
        });
      })
      .catch(() => {
        // No qrcode dep yet — the URL text remains the fallback join path.
        this.qrBox.innerHTML =
          '<span class="text-slate-500 text-sm text-center px-2">Type the link below on your phone</span>';
      });
  }

  _renderPlayers(players) {
    this.playerList.innerHTML = '';
    if (players.length === 0) {
      const empty = document.createElement('li');
      empty.textContent = 'Waiting for phones to join…';
      empty.className = 'text-slate-400';
      this.playerList.appendChild(empty);
      return;
    }
    for (const p of players) {
      const row = document.createElement('li');
      row.className = 'flex items-center gap-3 text-lg';
      const swatch = document.createElement('span');
      swatch.className = 'inline-block w-4 h-4 rounded-sm ring-1 ring-white/30';
      swatch.style.backgroundColor = this._hex(typeof p.color === 'number' ? p.color : 0x8e8e93);
      row.appendChild(swatch);
      const name = document.createElement('span');
      name.textContent = p.name || 'Player';
      name.className = 'font-semibold text-white';
      row.appendChild(name);
      this.playerList.appendChild(row);
    }
  }

  _renderTrack(trackId) {
    const cfg = this.config || {};
    if (cfg.mode === 'battle') {
      this.trackLine.innerHTML = 'Mode: <b class="text-white">BALLOON BATTLE</b> — arena free-for-all';
      return;
    }
    const meta = getTrackMeta(trackId || 'circuit');
    const modeName = cfg.mode === 'tt' ? 'TIME TRIAL' : 'GRAND PRIX';
    const cupNote = cfg.cup ? ' · <b class="text-white">CUP</b> (3 races)' : '';
    this.trackLine.innerHTML =
      'Mode: <b class="text-white">' + modeName + '</b> · Track: <b class="text-white">' + meta.name + '</b>' + cupNote;
  }

  _hex(n) {
    return '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
  }

  /** Refresh the keyboard-player toggle's label to its on/off state. */
  _renderKb() {
    this.kbButton.textContent = this._kb
      ? '⌨️ KEYBOARD PLAYER: IN'
      : '+ KEYBOARD PLAYER';
    this.kbButton.classList.toggle('bg-emerald-500/30', this._kb);
  }

  /** @returns {boolean} whether the TV keyboard player is toggled in. */
  hasKeyboardPlayer() {
    return this._kb;
  }

  _handleStart() {
    if (!this._canStart && !this._kb) return;
    if (!this.socket || typeof this.socket.emit !== 'function') return;
    const cfg = this.config || {};
    this.socket.emit('start', {
      mode: cfg.mode || 'gp',
      trackId: this.trackId,
      difficulty: cfg.difficulty,
      cup: !!cfg.cup,
      kb: this._kb,
    });
    this.startButton.textContent = 'STARTING…';
    this.startButton.disabled = true;
  }

  show() {
    this.element.style.display = 'flex';
  }

  hide() {
    this.element.style.display = 'none';
  }

  dispose() {
    if (this._offJoined) this._offJoined();
    if (this._offLobby) this._offLobby();
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}

export default CouchLobby;
