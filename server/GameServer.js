// server/GameServer.js
//
// The connection / lobby / room manager. It owns the Socket.IO `io` instance and
// translates raw socket events into game actions on Rooms. It contains NO physics
// — the authoritative simulation lives entirely in Room.js. GameServer is the
// "front desk": it seats players into rooms, runs the pre-race lobby, and routes
// per-tick input to the right room.
//
// Lifecycle of a connection:
//   connect
//     -> client emits 'join' { name }
//     -> we put the socket in an OPEN room (one that hasn't started), creating a
//        new room if none is open
//     -> we assign the socket a playerId and emit 'joined' { playerId, roomId }
//     -> we broadcast 'lobby' to everyone in that room
//   in the lobby
//     -> client emits 'ready' { ready }  -> we update + rebroadcast 'lobby'
//     -> host emits 'start' {}           -> the room starts the race
//     -> (or) once >=1 player is ready we auto-start after a short countdown
//   racing
//     -> client emits 'input' { seq, ... } every client tick -> routed to the room
//     -> room broadcasts 'snapshot' ~20Hz and finally 'raceEnd'
//   disconnect
//     -> we remove the player from its room; a racing room replaces them with AI
//
// Message contracts (see the project brief) — payloads stay small / plain numbers.

import os from 'node:os';

import { Room } from './Room.js';

// How many human players a single room accepts before it is considered "full"
// for matchmaking purposes. The race field is always FIELD_SIZE (13); any human
// slots beyond this would just replace AI, but we cap joins to keep lobbies
// readable. 8 humans + 5 AI is plenty for this game.
const MAX_HUMANS_PER_ROOM = 8;

// Seconds to wait before auto-starting a room once at least one player is ready
// and the host hasn't manually started. Gives a late joiner a moment to appear.
const AUTOSTART_COUNTDOWN = 5;

export class GameServer {
  /**
   * @param {import('socket.io').Server} io  the Socket.IO server instance.
   */
  constructor(io) {
    this.io = io;

    // roomId -> Room. We keep every live room here; rooms are removed when they
    // end and are empty.
    this.rooms = new Map();

    // socketId -> { roomId, playerId, name } so a disconnect can find the
    // player's room and seat without scanning every room.
    this.players = new Map();

    // COUCH MODE: socketId -> roomId for "screen" sockets. A screen is the TV
    // client that shows the split-screen race but occupies NO kart slot — it
    // joins the Socket.IO room group (so it receives lobby/raceStart/snapshot for
    // ALL karts) without ever calling room.addPlayer. It also acts as the couch
    // host: it is the one allowed to start the race.
    this.screens = new Map();

    // Monotonic counters for stable, collision-free ids.
    this._nextRoomNum = 1;
    this._nextPlayerNum = 1;

    // This machine's LAN (Wi-Fi) IPv4, sent to the couch TV so the join QR points
    // at an address PHONES can actually reach (not localhost).
    this._lanIp = this._detectLanIp();

    // Register the single connection handler. Everything else hangs off the
    // per-socket event handlers we wire up inside.
    this.io.on('connection', (socket) => this._onConnection(socket));
  }

  // ------------------------------------------------------------------------
  // Connection setup: wire up this socket's event handlers.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @private
   */
  _onConnection(socket) {
    // 'join' — the client announces itself and we seat it in a room.
    socket.on('join', (payload) => this._onJoin(socket, payload || {}));

    // 'joinScreen' — COUCH MODE. The TV opens a fresh couch room and joins it as a
    // seat-less screen. Phones then 'join' that room (via the QR's ?room=id) and
    // become the players; the screen split-screens them.
    socket.on('joinScreen', (payload) => this._onJoinScreen(socket, payload || {}));

    // 'ready' — toggle this player's lobby ready flag, then rebroadcast the lobby.
    socket.on('ready', (payload) => this._onReady(socket, payload || {}));

    // 'start' — the host asks to begin the race now. M6: the payload may carry a
    // { trackId } so the host's chosen track reaches the room before it starts.
    socket.on('start', (payload) => this._onStart(socket, payload || {}));

    // 'setTrack' — the host picks the race track in the lobby. M6.
    socket.on('setTrack', (payload) => this._onSetTrack(socket, payload || {}));

    // 'input' — a per-tick input snapshot during the race. Routed to the room,
    // which buffers the latest input per player for its fixed-step sim.
    socket.on('input', (payload) => this._onInput(socket, payload || {}));

    // COUCH MODE relays from the TV (which runs the sim locally): the kart state
    // fans out to the phones as 'snapshot'; the end of race reopens the lobby.
    // 'input' above handles the phone -> TV direction.
    socket.on('couchState', (payload) => this._onCouchState(socket, payload || {}));
    socket.on('couchEnd', (payload) => this._onCouchEnd(socket, payload || {}));

    // 'disconnect' — clean the player out of its room (AI fills the seat if racing).
    socket.on('disconnect', () => this._onDisconnect(socket));
  }

  // ------------------------------------------------------------------------
  // JOIN: seat the socket in an open room.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @param {{name?:string}} payload
   * @private
   */
  _onJoin(socket, payload) {
    // Ignore a duplicate join from a socket that is already seated.
    if (this.players.has(socket.id)) return;

    // Sanitise the display name: a trimmed string, fall back to a generated one,
    // and cap the length so one client can't broadcast a huge string to everyone.
    let name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) name = 'Player' + this._nextPlayerNum;
    if (name.length > 20) name = name.slice(0, 20);

    // Resolve the room to seat this player in. A phone from the couch QR carries an
    // explicit roomId — honour it when valid; otherwise auto-matchmake.
    const room = this._resolveJoinRoom(payload.roomId);

    // Assign a stable player id (used as the kart id in the sim and snapshots).
    const playerId = 'p' + this._nextPlayerNum++;

    // Join the Socket.IO ROOM (a broadcast group) named after our room id, so we
    // can emit to just this room's members with io.to(roomId).emit(...).
    socket.join(room.id);

    // Seat the player in the room model.
    room.addPlayer({ socketId: socket.id, playerId, name });

    // Remember the reverse mapping for routing/disconnect.
    this.players.set(socket.id, { roomId: room.id, playerId, name });

    // Tell THIS client who it is and which room it landed in.
    socket.emit('joined', { playerId, roomId: room.id });

    // Tell EVERYONE in the room about the new lobby state.
    this._broadcastLobby(room);
  }

  /**
   * Find a room that is open for new players (exists, not yet started, not full),
   * or create a fresh one.
   * @returns {Room}
   * @private
   */
  _findOpenRoom() {
    for (const room of this.rooms.values()) {
      if (!room.started && room.humanCount() < MAX_HUMANS_PER_ROOM) {
        return room;
      }
    }
    // No open room — make a new one.
    const id = 'room' + this._nextRoomNum++;
    const room = new Room(id, this.io);
    this.rooms.set(id, room);
    return room;
  }

  /**
   * Resolve which room a 'join' should land in. If an explicit roomId is given
   * (a phone scanning the couch QR) and that room is open, use it; otherwise fall
   * back to auto-matchmaking.
   * @param {string} [roomId]
   * @returns {Room}
   * @private
   */
  _resolveJoinRoom(roomId) {
    if (typeof roomId === 'string' && roomId) {
      const r = this.rooms.get(roomId);
      if (r && !r.started && r.humanCount() < MAX_HUMANS_PER_ROOM) return r;
    }
    return this._findOpenRoom();
  }

  // ------------------------------------------------------------------------
  // JOIN SCREEN (couch): create a fresh couch room and join it seat-less.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @private
   */
  _onJoinScreen(socket) {
    // A socket is either a screen or a player, never both.
    if (this.players.has(socket.id) || this.screens.has(socket.id)) return;

    // Always create a FRESH room so the couch session has its own private lobby;
    // phones join it explicitly via the QR's ?room=id.
    const id = 'room' + this._nextRoomNum++;
    const room = new Room(id, this.io);
    room.couch = true; // couch rooms are host-started from the TV (no 5s auto-start)
    this.rooms.set(id, room);

    // Join the broadcast group WITHOUT taking a kart slot, and record the mapping.
    socket.join(room.id);
    this.screens.set(socket.id, room.id);

    // Tell the TV its room id + this machine's LAN IP, so the join QR points at an
    // address phones can reach. We reuse the 'joined' contract (null playerId).
    socket.emit('joined', { playerId: null, roomId: room.id, lanIp: this._lanIp });

    // Broadcast the (empty) lobby so the TV shows its waiting/QR state immediately.
    this._broadcastLobby(room);
  }

  /**
   * Best-effort detect this machine's LAN IPv4 (for the couch join QR). Prefers
   * the typical Mac Wi-Fi/Ethernet interfaces, then any non-internal IPv4.
   * @returns {string|null}
   * @private
   */
  _detectLanIp() {
    const ifaces = os.networkInterfaces();
    const order = ['en0', 'en1', ...Object.keys(ifaces)];
    for (const name of order) {
      for (const net of ifaces[name] || []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
    return null;
  }

  /** @returns {boolean} true if any screen socket is watching this room. @private */
  _roomHasScreen(roomId) {
    for (const rid of this.screens.values()) {
      if (rid === roomId) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------
  // READY: toggle the lobby ready flag.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @param {{ready?:boolean}} payload
   * @private
   */
  _onReady(socket, payload) {
    const seat = this.players.get(socket.id);
    if (!seat) return;
    const room = this.rooms.get(seat.roomId);
    if (!room || room.started) return;

    room.setReady(seat.playerId, !!payload.ready);

    // If at least one player is ready, arm an auto-start countdown (only once).
    // The host can still 'start' early; either way the room starts cleanly.
    // COUCH rooms are host-started from the TV — never auto-start them.
    if (!room.couch) this._maybeArmAutostart(room);

    this._broadcastLobby(room);
  }

  /**
   * Arm a one-shot auto-start countdown for a room if it has any ready player and
   * isn't already counting down or started. The host pressing 'start' bypasses
   * this entirely.
   * @param {Room} room
   * @private
   */
  _maybeArmAutostart(room) {
    if (room.started || room._autostartTimer) return;
    if (!room.anyReady()) return;

    room._autostartTimer = setTimeout(() => {
      room._autostartTimer = null;
      // The room might have started or emptied while we waited — re-check.
      if (!room.started && room.humanCount() > 0) {
        this._startRoom(room);
      }
    }, AUTOSTART_COUNTDOWN * 1000);
  }

  // ------------------------------------------------------------------------
  // START: host begins the race.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @private
   */
  _onStart(socket, payload) {
    // COUCH: the TV/screen is the host — it may start its room regardless of who
    // the first player was. It just needs at least one phone in the field.
    // The TV simulates the race LOCALLY; the server never starts the Room sim for
    // couch rooms. 'start' just flips the join gate and tells everyone to race.
    const screenRoomId = this.screens.get(socket.id);
    if (screenRoomId) {
      const room = this.rooms.get(screenRoomId);
      if (!room) return;
      if (room.started) return; // race already live — ignore a duplicate start
      // Need at least one human in the field: a phone, OR the TV's own local
      // keyboard player (payload.kb — the TV adds that kart itself, so the
      // server just has to let an otherwise-empty room start).
      if (room.humanCount() < 1 && !(payload && payload.kb)) return;
      if (payload && payload.trackId != null && typeof room.setTrack === 'function') {
        room.setTrack(payload.trackId);
      }
      room.started = true; // blocks late joins (same gate the lobby join path checks)
      // Everything the TV needs to boot its local sim + the phones need to switch
      // to their racing UI. `players` is the same roster the 'lobby' event carries.
      this.io.to(room.id).emit('raceStart', {
        mode: payload.mode,
        trackId: room.trackId, // resolved/validated by setTrack above
        difficulty: payload.difficulty,
        cup: payload.cup,
        kb: !!(payload && payload.kb), // TV keyboard player joins the field locally
        players: room.lobbyList().map((p) => ({ id: p.id, name: p.name, color: p.color })),
      });
      return;
    }

    const seat = this.players.get(socket.id);
    if (!seat) return;
    const room = this.rooms.get(seat.roomId);
    if (!room || room.started) return;
    // Only the host (first player to join the room) may start manually.
    if (room.hostPlayerId !== seat.playerId) return;

    // M6: honour a trackId sent alongside 'start' (the client may set it here
    // instead of via a separate 'setTrack'). Room.setTrack resolves/validates it.
    if (payload && payload.trackId != null && typeof room.setTrack === 'function') {
      room.setTrack(payload.trackId);
    }

    this._startRoom(room);
  }

  /**
   * M6: the host chooses the race track in the lobby. Host-only; ignored once the
   * race has started. The Room validates the id and falls back to 'circuit'.
   * @param {import('socket.io').Socket} socket
   * @param {{trackId?:string}} payload
   * @private
   */
  _onSetTrack(socket, payload) {
    const seat = this.players.get(socket.id);
    if (!seat) return;
    const room = this.rooms.get(seat.roomId);
    if (!room || room.started) return;
    if (room.hostPlayerId !== seat.playerId) return;
    if (typeof room.setTrack === 'function') {
      room.setTrack(payload.trackId);
    }
    // Push the change to everyone so the lobby track preview updates live.
    this._broadcastLobby(room);
  }

  /**
   * Start a room's race: cancel any pending autostart, then kick off the room's
   * authoritative sim. The Room emits 'raceStart' to its members itself.
   * @param {Room} room
   * @private
   */
  _startRoom(room) {
    if (room.started) return;
    if (room._autostartTimer) {
      clearTimeout(room._autostartTimer);
      room._autostartTimer = null;
    }
    // When the race ends, decide the room's fate (couch rooms survive for a rematch).
    room.start(() => this._onRaceEnded(room));
  }

  /**
   * A race finished. A normal room is torn down; a COUCH room whose TV is still
   * connected is kept ALIVE (loop stopped) so the crew can press RACE AGAIN and
   * rematch with the same phones — no new room, no QR re-scan. It's finally
   * cleaned up when the screen disconnects (see _onDisconnect).
   * @param {Room} room
   * @private
   */
  _onRaceEnded(room) {
    room.stop(); // idempotent
    if (room.couch && this._roomHasScreen(room.id)) return; // keep for a rematch
    this._onRoomEnd(room);
  }

  // ------------------------------------------------------------------------
  // INPUT: route a per-tick input to the player's room.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @param {object} payload  { seq, steer, throttle, brake, drift, useItem, lookBack }
   * @private
   */
  _onInput(socket, payload) {
    const seat = this.players.get(socket.id);
    if (!seat) return;
    const room = this.rooms.get(seat.roomId);
    if (!room) return;
    // COUCH: the TV runs the sim locally — relay the raw input to the room's
    // screen socket(s) instead of the (never-started) Room sim.
    if (room.couch) {
      for (const [sid, rid] of this.screens) {
        if (rid === room.id) {
          this.io.to(sid).emit('couchInput', { playerId: seat.playerId, input: payload });
        }
      }
      return;
    }
    // The room buffers the LATEST input per player; the sim reads it each tick.
    room.setInput(seat.playerId, payload);
  }

  // ------------------------------------------------------------------------
  // COUCH RELAYS: the TV's local sim streams through the server to the phones.
  // ------------------------------------------------------------------------
  /**
   * COUCH: the TV streams its locally-simulated kart state — re-emit it VERBATIM
   * as 'snapshot' to the room so the phones' HUDs update (the screen ignores its
   * own echo).
   * @param {import('socket.io').Socket} socket
   * @param {{karts?:Array}} payload
   * @private
   */
  _onCouchState(socket, payload) {
    const room = this._couchRoomForScreen(socket);
    if (!room) return;
    this.io.to(room.id).emit('snapshot', payload);
  }

  /**
   * COUCH: the TV's local race finished. Relay the results as 'raceEnd' and
   * reopen the lobby so the same crew can press RACE AGAIN without re-scanning.
   * @param {import('socket.io').Socket} socket
   * @param {{results?:Array}} payload
   * @private
   */
  _onCouchEnd(socket, payload) {
    const room = this._couchRoomForScreen(socket);
    if (!room) return;
    this.io.to(room.id).emit('raceEnd', { results: payload.results });
    room.started = false; // reopen the join gate for the rematch lobby
    this._broadcastLobby(room);
  }

  /** Resolve the couch room a registered screen socket controls (or null). @private */
  _couchRoomForScreen(socket) {
    const roomId = this.screens.get(socket.id);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    return room && room.couch ? room : null;
  }

  // ------------------------------------------------------------------------
  // DISCONNECT: remove the player; a racing room replaces them with AI.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @private
   */
  _onDisconnect(socket) {
    // COUCH: a screen (TV) disconnected — drop it, and end its room only if
    // nothing else is watching or playing.
    const screenRoomId = this.screens.get(socket.id);
    if (screenRoomId) {
      this.screens.delete(socket.id);
      const room = this.rooms.get(screenRoomId);
      // No screen and no phones = a dead couch room, whether or not it "started"
      // (the sim runs on the TV that just left, so nothing can revive it).
      if (room && room.humanCount() === 0 && !this._roomHasScreen(room.id)) {
        this._onRoomEnd(room);
      }
      return;
    }

    const seat = this.players.get(socket.id);
    if (!seat) return;
    this.players.delete(socket.id);

    const room = this.rooms.get(seat.roomId);
    if (!room) return;

    // Remove from the room. If racing, Room converts the seat to an AI so the
    // field size stays constant and the sim keeps running smoothly.
    room.removePlayer(seat.playerId);

    if (room.started) {
      if (room.couch) {
        // COUCH: the TV runs the sim — tell it (and the phones) a racer dropped so
        // it can hand the kart to a local AI. The Room sim never ran, so there is
        // no server-side takeover. The room survives while the screen is watching.
        this.io.to(room.id).emit('playerLeft', { playerId: seat.playerId, name: seat.name });
        if (room.humanCount() === 0 && !this._roomHasScreen(room.id)) {
          this._onRoomEnd(room);
        }
      } else if (room.humanCount() === 0) {
        // Mid-race: the room handles AI takeover internally; nothing else to do
        // except let it clean itself up when it ends.
        // If everyone left, end the room now (no humans to watch it).
        room.stop();
        this._onRoomEnd(room);
      }
    } else {
      // Still in the lobby: just rebroadcast the updated lobby, or drop the room
      // if it is now empty.
      if (room.humanCount() === 0) {
        // COUCH: keep the room alive if its TV screen is still watching (waiting
        // for phones to (re)join) — otherwise the QR room would vanish.
        if (room.couch && this._roomHasScreen(room.id)) {
          this._broadcastLobby(room);
        } else {
          this._onRoomEnd(room);
        }
      } else {
        this._broadcastLobby(room);
      }
    }
  }

  /**
   * Tear down a finished/empty room: clear any timers and forget it.
   * @param {Room} room
   * @private
   */
  _onRoomEnd(room) {
    if (room._autostartTimer) {
      clearTimeout(room._autostartTimer);
      room._autostartTimer = null;
    }
    room.stop(); // idempotent — safe even if already stopped
    this.rooms.delete(room.id);
    // COUCH: forget any screen mappings for this room.
    for (const [sid, rid] of this.screens) {
      if (rid === room.id) this.screens.delete(sid);
    }
  }

  // ------------------------------------------------------------------------
  // Lobby broadcast.
  // ------------------------------------------------------------------------
  /**
   * Emit the current lobby state to every member of a room.
   *   'lobby' { players:[{id,name,ready}], canStart, hostId, roomId }
   * canStart is true once at least one human is present (a single human can race
   * with AI fill), so the host's Start button can light up immediately.
   * @param {Room} room
   * @private
   */
  _broadcastLobby(room) {
    this.io.to(room.id).emit('lobby', {
      roomId: room.id,
      hostId: room.hostPlayerId,
      players: room.lobbyList(), // [{ id, name, ready, color }]
      canStart: room.humanCount() >= 1,
      trackId: room.trackId, // so the lobby can preview the host's selected track
    });
  }
}
