// src/ui/screens/Lobby.js
//
// The multiplayer lobby: a plain HTML/CSS overlay (NO three.js) shown AFTER the
// player picks MULTIPLAYER from the Menu, and BEFORE the race actually starts.
//
// What it does:
//   1. Lets the player type a NAME and join the room.
//   2. Shows the live list of connected players (name + ready dot), updated from
//      server 'lobby' events.
//   3. Offers a READY toggle (client -> server 'ready' {ready}) and a START
//      button (host only; client -> server 'start' {}).
//   4. When the server emits 'raceStart', it hides itself and calls
//      onRaceStart(payload) so the caller can boot the MultiplayerRace.
//
// ---------------------------------------------------------------------------
// socketClient CONTRACT (provided by the integration agent's netcode module).
// This screen only uses this small, documented surface:
//   socketClient.on(event, handler)   -> subscribe to a server->client event.
//                                        handler receives the event payload.
//   socketClient.emit(event, payload) -> send a client->server event.
//   socketClient.connect?()           -> OPTIONAL: open the connection (called if
//                                        present; safe to omit if auto-connecting).
//   socketClient.id?                  -> OPTIONAL: this client's playerId once
//                                        'joined' has arrived (we also capture it
//                                        from the 'joined' event payload).
//
// Server -> client events consumed here (see NETCODE MESSAGE CONTRACTS):
//   'joined'    { playerId, roomId }
//   'lobby'     { players:[{id,name,ready}], canStart }
//   'raceStart' { fieldSize, totalLaps, startGrid:[...], trackId }
//
// Client -> server events emitted here:
//   'join'  { name }
//   'ready' { ready }
//   'start' {}
// ---------------------------------------------------------------------------
//
// pointer-events: like the Menu, this overlay MUST receive clicks, so its root
// uses `pointer-events-auto` and a high z-index to sit above the canvas + HUD.

// PURE shared track registry (no three/DOM) — resolves a trackId to its display
// name + theme color for the lobby preview.
import { getTrackMeta } from '../../../shared/trackData.js';

export class Lobby {
  /**
   * @param {Object} opts
   * @param {Object}   opts.socketClient  Netcode client (see CONTRACT above).
   * @param {Function} opts.onRaceStart   Called with the 'raceStart' payload when
   *                                       the server starts the race.
   */
  constructor({ socketClient, onRaceStart } = {}) {
    this.socket = socketClient;
    this._onRaceStart = onRaceStart || (() => {});

    // Local lobby UI state.
    this._joined = false;      // have we sent 'join' and received 'joined' yet?
    this._ready = false;       // our own ready toggle state
    this._playerId = null;     // our id, from the 'joined' event
    this._canStart = false;    // server says the room may start (host gate)

    // Build the DOM, then subscribe to the socket events.
    this._buildDom();
    this._wireSocket();
  }

  // ------------------------------------------------------------------------
  // DOM construction
  // ------------------------------------------------------------------------
  _buildDom() {
    // Root overlay: full-screen, centered card, takes clicks, above everything.
    this.element = document.createElement('div');
    this.element.id = 'lobby-screen';
    this.element.className = [
      'fixed', 'inset-0', 'z-30',
      'pointer-events-auto',
      'flex', 'items-center', 'justify-center',
      'select-none', 'text-white',
      'bg-gradient-to-b', 'from-slate-900', 'via-slate-800', 'to-slate-900',
    ].join(' ');

    // The card that holds the lobby contents.
    const card = document.createElement('div');
    card.className = [
      'w-[28rem]', 'max-w-[92vw]',
      'rounded-3xl', 'p-8',
      'bg-slate-800/80', 'backdrop-blur',
      'ring-1', 'ring-white/10', 'shadow-2xl', 'shadow-black/50',
      'flex', 'flex-col', 'gap-5',
    ].join(' ');

    // Heading.
    const heading = document.createElement('h2');
    heading.textContent = 'MULTIPLAYER LOBBY';
    heading.className = 'text-2xl font-black tracking-wide text-center';
    card.appendChild(heading);

    // --- Name row + JOIN button (shown until joined) ---------------------
    const joinRow = document.createElement('div');
    joinRow.className = 'flex gap-2';

    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 16;
    this.nameInput.placeholder = 'Your name';
    this.nameInput.value = this._defaultName();
    this.nameInput.className = [
      'flex-1', 'px-4', 'py-3', 'rounded-xl',
      'bg-slate-900/70', 'ring-1', 'ring-white/10',
      'text-white', 'placeholder-slate-400',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-indigo-400',
    ].join(' ');
    // Pressing Enter in the name field is the same as clicking JOIN.
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._handleJoin();
    });
    joinRow.appendChild(this.nameInput);

    this.joinButton = document.createElement('button');
    this.joinButton.type = 'button';
    this.joinButton.textContent = 'JOIN';
    this.joinButton.className = this._btnClasses(
      'from-emerald-500 to-green-600 hover:from-emerald-400 hover:to-green-500'
    );
    this.joinButton.addEventListener('click', () => this._handleJoin());
    joinRow.appendChild(this.joinButton);

    card.appendChild(joinRow);

    // --- Connection / status line ----------------------------------------
    this.statusLine = document.createElement('p');
    this.statusLine.className = 'text-sm text-slate-300 text-center min-h-[1.25rem]';
    this.statusLine.textContent = 'Enter a name and join the room.';
    card.appendChild(this.statusLine);

    // --- Track preview (host's selected track; updates live from 'lobby') --
    const trackRow = document.createElement('div');
    trackRow.className =
      'flex items-center gap-3 rounded-xl bg-slate-900/50 px-4 py-3 ring-1 ring-white/5';

    const trackLabel = document.createElement('span');
    trackLabel.textContent = 'TRACK';
    trackLabel.className = 'text-xs font-bold tracking-widest text-slate-400';
    trackRow.appendChild(trackLabel);

    this.trackSwatch = document.createElement('span');
    this.trackSwatch.className = 'inline-block w-3.5 h-3.5 rounded-full ring-1 ring-white/30';
    trackRow.appendChild(this.trackSwatch);

    this.trackName = document.createElement('span');
    this.trackName.className = 'text-sm font-semibold text-white';
    this.trackName.textContent = '—';
    trackRow.appendChild(this.trackName);

    card.appendChild(trackRow);

    // --- Players list -----------------------------------------------------
    const listLabel = document.createElement('p');
    listLabel.textContent = 'PLAYERS';
    listLabel.className = 'text-xs font-bold tracking-widest text-slate-400 mt-1';
    card.appendChild(listLabel);

    this.playerList = document.createElement('ul');
    this.playerList.className = [
      'flex', 'flex-col', 'gap-2',
      'min-h-[6rem]', 'max-h-56', 'overflow-y-auto',
      'rounded-xl', 'bg-slate-900/50', 'p-3', 'ring-1', 'ring-white/5',
    ].join(' ');
    card.appendChild(this.playerList);

    // --- Action row: READY toggle + START (host) -------------------------
    const actionRow = document.createElement('div');
    actionRow.className = 'flex gap-3 mt-1';

    this.readyButton = document.createElement('button');
    this.readyButton.type = 'button';
    this.readyButton.textContent = 'READY';
    this.readyButton.disabled = true; // enabled after joining
    this.readyButton.className = this._btnClasses(
      'from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500',
      true // include the flex-1 grow so the two buttons split the row
    );
    this.readyButton.addEventListener('click', () => this._handleReadyToggle());
    actionRow.appendChild(this.readyButton);

    this.startButton = document.createElement('button');
    this.startButton.type = 'button';
    this.startButton.textContent = 'START';
    this.startButton.disabled = true; // enabled only when the server says canStart
    this.startButton.className = this._btnClasses(
      'from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500',
      true
    );
    this.startButton.addEventListener('click', () => this._handleStart());
    actionRow.appendChild(this.startButton);

    card.appendChild(actionRow);

    // Hint about AI fill so a solo host knows they can still race.
    const hint = document.createElement('p');
    hint.textContent = 'Empty slots are filled with AI so you can race solo or with friends.';
    hint.className = 'text-xs text-slate-400 text-center';
    card.appendChild(hint);

    this.element.appendChild(card);

    // Start hidden; the caller decides when to show().
    this.element.style.display = 'none';
    document.body.appendChild(this.element);
  }

  /**
   * Shared button class string. `grow` adds flex-1 so action-row buttons split
   * the width evenly.
   * @private
   */
  _btnClasses(gradientClasses, grow = false) {
    return [
      grow ? 'flex-1' : '',
      'px-5', 'py-3', 'rounded-xl',
      'font-bold', 'tracking-wide', 'uppercase', 'text-sm',
      'bg-gradient-to-r', gradientClasses,
      'shadow-lg', 'shadow-black/30',
      'transition', 'duration-150',
      'hover:scale-[1.03]', 'active:scale-[0.97]',
      'disabled:opacity-40', 'disabled:cursor-not-allowed',
      'disabled:hover:scale-100',
      'focus:outline-none', 'focus:ring-2', 'focus:ring-white/40',
    ].join(' ');
  }

  /** A friendly default name so the field is never empty. @private */
  _defaultName() {
    // Random 2-digit suffix so multiple tabs don't all read "Player".
    const n = Math.floor(Math.random() * 90) + 10;
    return 'Player' + n;
  }

  // ------------------------------------------------------------------------
  // Socket wiring
  // ------------------------------------------------------------------------
  _wireSocket() {
    if (!this.socket || typeof this.socket.onEvent !== 'function') {
      // No socket provided: leave the UI inert but visible (useful for styling
      // the lobby in isolation). Surface the problem in the status line.
      this.statusLine.textContent = 'No connection available.';
      return;
    }

    // IMPORTANT: subscribe via onEvent (NOT raw .on). SocketClient buffers the
    // latest 'joined'/'lobby' and replays them to us here, so even if connect()
    // already fired them before this screen existed, we still get caught up.

    // 'joined' -> we are in the room; capture our id and flip into the joined UI.
    this.socket.onEvent('joined', (payload) => {
      this._joined = true;
      this._playerId = payload && payload.playerId != null ? payload.playerId : this.socket.id;
      const room = payload && payload.roomId != null ? payload.roomId : '?';
      this.statusLine.textContent = 'Joined room ' + room + '. Waiting for players…';
      // Lock the name field, swap the JOIN button to a connected state, and
      // enable the READY toggle.
      this.nameInput.disabled = true;
      this.joinButton.disabled = true;
      this.joinButton.textContent = 'JOINED';
      this.readyButton.disabled = false;
    });

    // 'lobby' -> the authoritative player list + whether the room may start.
    this.socket.onEvent('lobby', (payload) => {
      const players = (payload && payload.players) || [];
      this._canStart = !!(payload && payload.canStart);
      this._renderPlayers(players);
      this._renderTrack(payload && payload.trackId);
      // The START button is enabled only when the server says the room can start.
      // (The server decides host-ness; if a non-host clicks START it simply
      // ignores it, so gating purely on canStart is safe and simple.)
      this.startButton.disabled = !this._canStart;
    });

    // 'raceStart' -> the race is beginning. Hide the lobby and hand the payload
    // up so the caller can build the MultiplayerRace from the start grid.
    this.socket.onEvent('raceStart', (payload) => {
      this.hide();
      this._onRaceStart(payload);
    });

    // If the client exposes an explicit connect(), call it now so opening the
    // lobby also opens the socket. Auto-connecting clients can omit this.
    if (typeof this.socket.connect === 'function') {
      try {
        this.socket.connect();
      } catch (err) {
        this.statusLine.textContent = 'Could not connect to server.';
      }
    }
  }

  /**
   * Render the player list rows from a server 'lobby' players array.
   * Rebuilds the list each update (the list is tiny — at most fieldSize rows).
   * @param {Array<{id,name,ready}>} players
   * @private
   */
  _renderPlayers(players) {
    // Clear existing rows.
    this.playerList.innerHTML = '';

    if (players.length === 0) {
      const empty = document.createElement('li');
      empty.textContent = 'No players yet.';
      empty.className = 'text-slate-400 text-sm';
      this.playerList.appendChild(empty);
      return;
    }

    for (const p of players) {
      const row = document.createElement('li');
      row.className = 'flex items-center gap-3';

      // Ready dot: green when ready, gray when not.
      const dot = document.createElement('span');
      dot.className =
        'inline-block w-2.5 h-2.5 rounded-full ' +
        (p.ready ? 'bg-green-400 shadow shadow-green-400/60' : 'bg-slate-500');
      row.appendChild(dot);

      // Kart color swatch (matches the kart this player drives) so you can tell
      // who's who at a glance. Color comes from the server lobby payload.
      const swatch = document.createElement('span');
      swatch.className = 'inline-block w-3.5 h-3.5 rounded-sm ring-1 ring-white/30';
      swatch.style.backgroundColor = this._hex(typeof p.color === 'number' ? p.color : 0x8e8e93);
      row.appendChild(swatch);

      // Name (mark our own row with "(you)").
      const name = document.createElement('span');
      const isMe = this._playerId != null && p.id === this._playerId;
      name.textContent = (p.name || 'Player') + (isMe ? '  (you)' : '');
      name.className = 'text-sm ' + (isMe ? 'font-bold text-white' : 'text-slate-200');
      row.appendChild(name);

      this.playerList.appendChild(row);
    }
  }

  /**
   * Update the track preview from the server's selected trackId. Resolves an
   * unknown/missing id to the default ('circuit') via getTrackMeta, then shows the
   * track name + a theme-color swatch that glows in the track's color.
   * @param {string} [trackId]
   * @private
   */
  _renderTrack(trackId) {
    const meta = getTrackMeta(trackId || 'circuit');
    this.trackName.textContent = meta.name;
    const hex = this._hex(meta.color);
    this.trackSwatch.style.backgroundColor = hex;
    this.trackSwatch.style.boxShadow = '0 0 10px ' + hex;
  }

  /** Convert a 0xRRGGBB color number to a '#rrggbb' CSS string. @private */
  _hex(n) {
    return '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
  }

  // ------------------------------------------------------------------------
  // Button handlers (client -> server emits)
  // ------------------------------------------------------------------------

  /** JOIN: send our chosen name to the server. @private */
  _handleJoin() {
    if (this._joined) return;
    if (!this.socket || typeof this.socket.emit !== 'function') return;
    const name = (this.nameInput.value || '').trim() || this._defaultName();
    this.statusLine.textContent = 'Joining…';
    this.socket.emit('join', { name });
  }

  /** READY toggle: flip our ready flag and tell the server. @private */
  _handleReadyToggle() {
    if (!this._joined) return;
    if (!this.socket || typeof this.socket.emit !== 'function') return;
    this._ready = !this._ready;
    this.socket.emit('ready', { ready: this._ready });
    // Reflect the toggle locally for instant feedback; the 'lobby' broadcast
    // will confirm it on the next update.
    this.readyButton.textContent = this._ready ? 'NOT READY' : 'READY';
  }

  /** START: ask the server to begin (server enforces host-only). @private */
  _handleStart() {
    if (!this._canStart) return;
    if (!this.socket || typeof this.socket.emit !== 'function') return;
    this.socket.emit('start', {});
    this.statusLine.textContent = 'Starting race…';
  }

  // ------------------------------------------------------------------------
  // Visibility
  // ------------------------------------------------------------------------

  /** Show the lobby overlay. */
  show() {
    this.element.style.display = 'flex';
  }

  /** Hide the lobby overlay. */
  hide() {
    this.element.style.display = 'none';
  }

  /** Remove the lobby from the DOM (optional cleanup). */
  dispose() {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
