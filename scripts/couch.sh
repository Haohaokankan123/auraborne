#!/usr/bin/env bash
#
# COUCH MODE launcher — "Play on TV" family multiplayer.
#
# One command to: make a locally-trusted HTTPS cert for this Mac's Wi-Fi address
# (so phones can use TILT controls, which browsers only allow over HTTPS), build
# the client, and start the server. Then plug this Mac into the TV, open the
# game, pick "PLAY ON TV", and everyone scans the QR with their phone.
#
#   npm run couch
#
set -euo pipefail
cd "$(dirname "$0")/.."

CERT_DIR="server/certs"
KEY="$CERT_DIR/lan-key.pem"
CERT="$CERT_DIR/lan.pem"
PORT="${PORT:-3001}"

# Detect this Mac's LAN (Wi-Fi) IP so phones on the same network can reach it.
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "${LAN_IP}" ]; then
  echo "!! Could not detect your Wi-Fi IP. Connect this Mac to Wi-Fi and re-run." >&2
  exit 1
fi

# mkcert makes a certificate your devices actually trust (no scary warnings).
if ! command -v mkcert >/dev/null 2>&1; then
  echo "!! mkcert is not installed. Install it once with:" >&2
  echo "     brew install mkcert nss" >&2
  echo "   then re-run 'npm run couch'." >&2
  exit 1
fi

mkdir -p "$CERT_DIR"
# Install mkcert's local root CA into this Mac's trust store (idempotent).
mkcert -install >/dev/null 2>&1 || true

# (Re)generate the cert if missing or if it doesn't cover the current LAN IP.
if [ ! -f "$CERT" ] || ! openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -q "$LAN_IP"; then
  echo "Generating a trusted certificate for $LAN_IP ..."
  mkcert -key-file "$KEY" -cert-file "$CERT" "$LAN_IP" localhost 127.0.0.1 ::1
fi

echo "Building the game ..."
npm run build

CAROOT="$(mkcert -CAROOT 2>/dev/null || echo '?')"
cat <<INFO

════════════════════════════════════════════════════════════════
  🏁  COUCH MODE READY
  ----------------------------------------------------------------
  On the TV (this Mac):   https://localhost:$PORT   → pick "PLAY ON TV"
  Phones join at:         https://$LAN_IP:$PORT
                          (or just scan the QR shown on the TV)

  First time on each phone: it must trust the mkcert root CA once.
  The CA file is here:    $CAROOT/rootCA.pem
  (AirDrop it to the phone → install the profile → for iPhone also turn it on
   in Settings ▸ General ▸ About ▸ Certificate Trust Settings.)
  Skip that and phones can still play with the on-screen touch steering.
════════════════════════════════════════════════════════════════

INFO

SSL_KEY="$KEY" SSL_CERT="$CERT" NODE_ENV=production PORT="$PORT" node server/index.js
