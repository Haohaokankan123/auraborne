// src/net/SocketClient.js
//
// Thin wrapper around a Socket.IO connection for the multiplayer client.
//
// It does three jobs:
//   1. Owns the socket and the lifecycle calls (connect / join / ready / start).
//   2. Stamps every outgoing input with an incrementing `seq` and keeps a short
//      history of (seq -> input) so the Predictor can reconcile against the
//      server's ackSeq (the last input the server actually processed for us).
//   3. Exposes a tiny EventEmitter-style API (onEvent / offEvent) so the rest of
//      the game can subscribe to the server messages it cares about
//      ('joined','lobby','raceStart','snapshot','raceEnd') without touching the
//      raw socket.
//
// Keeping all socket plumbing here means the game/render code never imports
// socket.io-client directly — it just listens to high-level events.

import { io } from 'socket.io-client';

// The server messages we re-broadcast to local listeners. Listed explicitly so
// a typo in onEvent('snapsho') fails loudly instead of silently never firing.
// 'couchInput' is COUCH/TV only: the server relays each phone's raw input to the
// TV/screen socket, which feeds it into the local sim via CouchInputHub.
const SERVER_EVENTS = ['joined', 'lobby', 'raceStart', 'snapshot', 'raceEnd', 'playerLeft', 'couchInput'];

export class SocketClient {
  /**
   * @param {string} [url=''] - server URL. Default '' means SAME-ORIGIN: in dev
   *   the Vite proxy forwards '/socket.io' to the Node server (port 3001), and
   *   in production the page is served by that same Node server — so empty
   *   string is correct in both cases. Pass an explicit URL only to target a
   *   different host.
   */
  constructor(url = '') {
    this.url = url;
    this.socket = null;

    // --- Local pub/sub: eventName -> Set<callback> ----------------------
    // We use our own listener map (instead of exposing socket.on) so callers
    // get a stable API even if the transport changes, and so we can fan a
    // single socket event out to many subscribers.
    this._listeners = new Map();
    for (const name of SERVER_EVENTS) this._listeners.set(name, new Set());

    // --- Latest-state replay buffer -------------------------------------
    // The server fires 'joined' and 'lobby' immediately after we connect — often
    // BEFORE a consumer (Lobby / MultiplayerRace) has had a chance to subscribe.
    // Without buffering, those early events are lost and the lobby never updates.
    // We cache the most recent payload for these "current state" events and
    // REPLAY it to any listener that subscribes later (see onEvent). Only events
    // that represent durable state are replayed; one-shot/stream events
    // ('raceStart','snapshot','raceEnd') are not.
    this._lastPayload = new Map(); // eventName -> last payload seen
    this._replayable = new Set(['joined', 'lobby']);

    // --- Outgoing input sequencing & history ----------------------------
    // Every input we send gets the NEXT seq number. `_inputHistory` keeps the
    // recent inputs keyed by seq so reconciliation can re-apply everything the
    // server has not yet acknowledged. It is pruned in onAck().
    this._seq = 0;
    this._inputHistory = new Map(); // seq -> input object (with seq attached)

    // Set once the server replies to 'join'. Handy for callers and for knowing
    // which kart in a snapshot is "us".
    this.playerId = null;
    this.roomId = null;

    // --- Reconnect notifications ----------------------------------------
    // socket.io transparently reconnects after a network blip with a NEW socket.id.
    // The server forgets the old id, so a couch/TV client must re-announce itself
    // (re-emit 'joinScreen' with its roomId) or the whole relay goes silently dead.
    // We fire these on every reconnect AFTER the first successful connect.
    this._reconnectListeners = new Set();
    this._hasConnected = false;
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  /**
   * Open the socket and wire the server events through to local listeners.
   * Safe to call once; calling again while connected is a no-op.
   * @returns {SocketClient} this (for chaining).
   */
  connect() {
    if (this.socket) return this; // already connected/connecting

    // autoConnect:true (default) starts the handshake immediately. We pass the
    // url straight through; '' keeps it same-origin.
    this.socket = io(this.url, {
      // Prefer websocket but allow the polling fallback so a strict proxy still
      // works. socket.io upgrades to ws automatically when it can.
      transports: ['websocket', 'polling'],
    });

    // Fire reconnect listeners on every RE-connect (not the first connect), so a
    // couch/TV client can re-announce its screen and revive the relay.
    this.socket.on('connect', () => {
      if (this._hasConnected) {
        for (const cb of this._reconnectListeners) {
          try { cb(); } catch (err) { console.error('SocketClient reconnect listener threw:', err); }
        }
      }
      this._hasConnected = true;
    });

    // Cache playerId/roomId off the 'joined' reply so callers can read them
    // synchronously, then still forward the event to subscribers.
    this.socket.on('joined', (payload) => {
      if (payload) {
        this.playerId = payload.playerId ?? null;
        this.roomId = payload.roomId ?? null;
      }
      this._emit('joined', payload);
    });

    // The remaining server events are forwarded verbatim to subscribers.
    for (const name of SERVER_EVENTS) {
      if (name === 'joined') continue; // already wired above
      this.socket.on(name, (payload) => this._emit(name, payload));
    }

    return this;
  }

  /** Disconnect and forget the socket (callers can connect() again). */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    // Reset local pub/sub state so a re-connect()'d session starts clean. Without
    // this, listeners and replay payloads from the previous session linger on the
    // reused instance and fire stale callbacks into the next session.
    for (const set of this._listeners.values()) set.clear();
    this._lastPayload.clear();
    this._reconnectListeners.clear();
    this._hasConnected = false;
    // Drop the reconciliation buffer too: a reconnect on the same instance must not
    // replay dead inputs from the previous session into the Predictor.
    this._inputHistory.clear();
    this._seq = 0;
  }

  /**
   * Subscribe to socket reconnects (fired after a transport drop + auto-reconnect,
   * NOT on the first connect). The callback should re-announce this client to the
   * server. Returns an unsubscribe function.
   * @param {() => void} callback
   * @returns {() => void}
   */
  onReconnect(callback) {
    this._reconnectListeners.add(callback);
    return () => this._reconnectListeners.delete(callback);
  }

  /** @returns {boolean} true while the underlying socket is connected. */
  get connected() {
    return !!this.socket && this.socket.connected;
  }

  /**
   * Our server-assigned player id (from the 'joined' reply), or null before it
   * arrives. Consumers (Lobby / MultiplayerRace) read this to mark "us" in the
   * field. This is the GAME player id ('p1', ...) — NOT the raw socket.io id —
   * because that's what the server keys karts and ackSeq by.
   * @returns {string|null}
   */
  get id() {
    return this.playerId;
  }

  /**
   * Low-level passthrough so consumers can send a client->server event without
   * reaching for the raw socket. The typed helpers (join/setReady/start/sendInput)
   * are preferred, but the Lobby emits 'join'/'ready'/'start' generically.
   * @param {string} event
   * @param {*} payload
   */
  emit(event, payload) {
    this._ensureSocket();
    this.socket.emit(event, payload);
  }

  // -----------------------------------------------------------------------
  // Outgoing lifecycle messages (client -> server)
  // -----------------------------------------------------------------------

  /**
   * Ask to join the room. Server replies with 'joined' { playerId, roomId }.
   * @param {string} name - the display name to race under.
   */
  join(name) {
    this._ensureSocket();
    this.socket.emit('join', { name });
  }

  /**
   * Toggle our lobby ready flag. Server re-broadcasts 'lobby'.
   * @param {boolean} ready
   */
  setReady(ready) {
    this._ensureSocket();
    this.socket.emit('ready', { ready: !!ready });
  }

  /** Host-only: ask the server to start the race. */
  start() {
    this._ensureSocket();
    this.socket.emit('start', {});
  }

  /**
   * Send one input snapshot to the server, stamped with the next seq.
   *
   * The seq lets the server tell us (via snapshot.ackSeq) exactly which of our
   * inputs it has applied, so the Predictor can re-simulate only the inputs the
   * server has NOT seen yet. We keep the stamped input in history for that.
   *
   * @param {object} inputObj - { steer,throttle,brake,drift,useItem,lookBack }
   *   from core/Input.js getState(). Extra fields are ignored by the server.
   * @returns {number} the seq assigned to this input (hand it to the live
   *   Predictor.applyInput in src/modes/Multiplayer.js).
   */
  sendInput(inputObj) {
    this._ensureSocket();
    const seq = ++this._seq; // pre-increment: first input is seq 1

    // Build a minimal, plain-number payload. We copy only the fields the netcode
    // contract defines so we never accidentally serialize render-only junk.
    const msg = {
      seq,
      steer: inputObj.steer ?? 0,
      throttle: inputObj.throttle ?? 0,
      brake: inputObj.brake ?? 0,
      drift: !!inputObj.drift,
      useItem: !!inputObj.useItem,
      lookBack: !!inputObj.lookBack,
      overdrive: !!inputObj.overdrive, // AURABORNE: part of the netcode input contract (predict + replay + server)
    };

    // Remember it for reconciliation, then ship it.
    this._inputHistory.set(seq, msg);
    this.socket.emit('input', msg);
    return seq;
  }

  // -----------------------------------------------------------------------
  // Input history (for the Predictor's reconciliation)
  // -----------------------------------------------------------------------

  /**
   * Drop every buffered input the server has acknowledged. Call this when a
   * snapshot arrives, passing snapshot.ackSeq[ourPlayerId]. After this, the
   * history holds only inputs with seq > ackSeq — exactly the ones the Predictor
   * must re-apply on top of the authoritative state.
   * @param {number} ackSeq - the highest seq the server has processed for us.
   */
  onAck(ackSeq) {
    if (ackSeq == null) return;
    for (const seq of this._inputHistory.keys()) {
      if (seq <= ackSeq) this._inputHistory.delete(seq);
    }
  }

  /**
   * @returns {Array<object>} the still-unacknowledged inputs, ASCENDING by seq.
   *   This is the exact ordered list the Predictor re-applies during reconcile.
   */
  getPendingInputs() {
    return Array.from(this._inputHistory.values()).sort((a, b) => a.seq - b.seq);
  }

  /** The last seq we assigned (0 if none sent yet). */
  get lastSeq() {
    return this._seq;
  }

  // -----------------------------------------------------------------------
  // Local pub/sub (EventEmitter-style)
  // -----------------------------------------------------------------------

  /**
   * Subscribe to a forwarded server event.
   * @param {'joined'|'lobby'|'raceStart'|'snapshot'|'raceEnd'} event
   * @param {(payload:any)=>void} callback
   * @returns {()=>void} an unsubscribe function (call it to remove the listener).
   */
  onEvent(event, callback) {
    const set = this._listeners.get(event);
    if (!set) {
      throw new Error(`SocketClient.onEvent: unknown event "${event}"`);
    }
    set.add(callback);

    // Replay the latest cached state for "current state" events so a listener
    // that subscribes AFTER connect() still sees the 'joined'/'lobby' that
    // already fired. This is what closes the connect-before-subscribe race.
    if (this._replayable.has(event) && this._lastPayload.has(event)) {
      try {
        callback(this._lastPayload.get(event));
      } catch (err) {
        console.error(`SocketClient replay for "${event}" threw:`, err);
      }
    }

    return () => this.offEvent(event, callback);
  }

  /**
   * Remove a previously-registered listener.
   * @param {string} event
   * @param {Function} callback
   */
  offEvent(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /** Fan an event out to every local subscriber. @private */
  _emit(event, payload) {
    // Cache the latest payload for replayable "current state" events so a
    // late subscriber can be caught up (see onEvent).
    if (this._replayable.has(event)) this._lastPayload.set(event, payload);

    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      // Isolate listeners: one throwing must not stop the others or the socket.
      try {
        cb(payload);
      } catch (err) {
        console.error(`SocketClient listener for "${event}" threw:`, err);
      }
    }
  }

  /** Throw a clear error if a send is attempted before connect(). @private */
  _ensureSocket() {
    if (!this.socket) {
      throw new Error('SocketClient: call connect() before sending messages.');
    }
  }
}

export default SocketClient;
