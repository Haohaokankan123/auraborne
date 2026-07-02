// src/net/CouchInputHub.js
//
// COUCH MODE (TV side): the server relays each phone's raw 'input' packets to
// the screen as 'couchInput' { playerId, input }. This hub buffers the LATEST
// packet per player and exposes an Input-compatible provider per kart, so the
// TV's LOCAL sim can poll a couch player exactly like core/Input.getState().
//
// Stale-hold: if a phone goes quiet (lag spike, backgrounded tab, dropped
// connection) the provider keeps the last steer but zeroes the throttle, so the
// kart coasts to a stop instead of driving its stale input off the track.

// A packet older than this is considered stale (the phone sends one per frame,
// so a healthy connection is never anywhere near it).
const STALE_MS = 1000;

export class CouchInputHub {
  /**
   * @param {import('./SocketClient.js').SocketClient} socketClient  a connected
   *   screen-side client; we subscribe to its relayed 'couchInput' events.
   */
  constructor(socketClient) {
    // playerId -> { input, tMs }: the latest raw packet + its arrival time.
    this._latest = new Map();
    this._off = socketClient.onEvent('couchInput', (payload) => {
      if (!payload || payload.playerId == null) return;
      const input = payload.input || {};
      // LATCH an item TAP. The phone sends useItem:true for a single ~30Hz packet
      // then clears it; if socket.io batches that packet with the following
      // useItem:false one before the TV's 60Hz sim polls getState(), the rising
      // edge is lost and the item never fires. Sticky-OR the tap onto the entry and
      // consume it exactly once in getState() so a press can't be coalesced away.
      const prev = this._latest.get(payload.playerId);
      const pendingItem = (prev && prev.pendingItem) || !!input.useItem;
      this._latest.set(payload.playerId, {
        input,
        tMs: performance.now(),
        pendingItem,
      });
    });
  }

  /**
   * An Input-like provider for one couch player: { getState() } returning the
   * SAME shape as core/Input.getState(), clamped/coerced so a malformed packet
   * can never feed the sim garbage. Safe before any packet arrives (neutral).
   * @param {string} playerId
   * @returns {{getState: () => object}}
   */
  providerFor(playerId) {
    const latest = this._latest;
    return {
      getState() {
        const entry = latest.get(playerId);
        const raw = entry ? entry.input : null;
        const stale = !entry || performance.now() - entry.tMs > STALE_MS;
        // Fire the latched item tap once (never while stale — a quiet phone
        // shouldn't autofire), then clear it so the next poll doesn't re-fire.
        let useItem = false;
        if (entry && !stale && entry.pendingItem) {
          useItem = true;
          entry.pendingItem = false;
        }
        return {
          steer: clamp(num(raw && raw.steer), -1, 1),
          throttle: stale ? 0 : clamp(num(raw && raw.throttle), 0, 1),
          brake: clamp(num(raw && raw.brake), 0, 1),
          drift: !!(raw && raw.drift),
          useItem,
          lookBack: !!(raw && raw.lookBack),
          overdrive: !!(raw && raw.overdrive),
        };
      },
    };
  }

  /** Unsubscribe from the socket and drop the buffered inputs. */
  dispose() {
    if (this._off) {
      this._off();
      this._off = null;
    }
    this._latest.clear();
  }
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export default CouchInputHub;
