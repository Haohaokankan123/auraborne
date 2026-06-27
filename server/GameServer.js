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

    // Monotonic counters for stable, collision-free ids.
    this._nextRoomNum = 1;
    this._nextPlayerNum = 1;

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

    // Find (or create) a room that is still open for joining.
    const room = this._findOpenRoom();

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
    this._maybeArmAutostart(room);

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
    // When the race ends, drop the room if it has emptied out.
    room.start(() => this._onRoomEnd(room));
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
    // The room buffers the LATEST input per player; the sim reads it each tick.
    room.setInput(seat.playerId, payload);
  }

  // ------------------------------------------------------------------------
  // DISCONNECT: remove the player; a racing room replaces them with AI.
  // ------------------------------------------------------------------------
  /**
   * @param {import('socket.io').Socket} socket
   * @private
   */
  _onDisconnect(socket) {
    const seat = this.players.get(socket.id);
    if (!seat) return;
    this.players.delete(socket.id);

    const room = this.rooms.get(seat.roomId);
    if (!room) return;

    // Remove from the room. If racing, Room converts the seat to an AI so the
    // field size stays constant and the sim keeps running smoothly.
    room.removePlayer(seat.playerId);

    if (room.started) {
      // Mid-race: the room handles AI takeover internally; nothing else to do
      // except let it clean itself up when it ends.
      // If everyone left, end the room now (no humans to watch it).
      if (room.humanCount() === 0) {
        room.stop();
        this._onRoomEnd(room);
      }
    } else {
      // Still in the lobby: just rebroadcast the updated lobby, or drop the room
      // if it is now empty.
      if (room.humanCount() === 0) {
        this._onRoomEnd(room);
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
