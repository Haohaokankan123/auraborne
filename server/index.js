// server/index.js
//
// The HTTP + Socket.IO entry point for the authoritative multiplayer server.
//
// This file is run DIRECTLY by Node (`node server/index.js`) — it is NOT bundled
// by Vite. It is plain ESM (package.json has "type":"module"), so we use import
// syntax and Node core modules as-is.
//
// Responsibilities (kept deliberately small):
//   1. Build an Express app.
//   2. In PRODUCTION, serve the built client from /dist with an SPA fallback so
//      a page refresh on any path still returns index.html.
//   3. Wrap the app in a Node http.Server and attach a Socket.IO server to it.
//   4. Allow the Vite dev origin (http://localhost:5173) through CORS so the
//      browser dev client can open a websocket to us across origins.
//   5. Hand the io instance to GameServer, which owns all the game logic.
//   6. Listen on process.env.PORT || 3001 and log the URL.
//
// All real game behavior lives in GameServer.js / Room.js — this file is just
// wiring.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

import { GameServer } from './GameServer.js';

// __dirname is not defined in ESM, so derive it from import.meta.url. We need it
// to locate the built client (../dist) relative to THIS file regardless of where
// the process was launched from.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The port the game server listens on. Hosting platforms inject PORT; locally we
// default to 3001 (the port vite.config.js already proxies '/socket.io' to).
const PORT = process.env.PORT || 3001;

// "production" if NODE_ENV says so — in that mode we serve the prebuilt client.
// In development the client is served by Vite on :5173 and talks to us via the
// '/socket.io' proxy, so we do NOT serve static files here.
const IS_PROD = process.env.NODE_ENV === 'production';

// The Vite dev origin we allow for cross-origin websocket handshakes in dev.
const DEV_ORIGIN = 'http://localhost:5173';

// --------------------------------------------------------------------------
// 1. Express app.
// --------------------------------------------------------------------------
const app = express();

// A tiny health endpoint — handy for uptime checks and to confirm the server is
// up without opening a socket. Always available (dev and prod).
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

if (IS_PROD) {
  // Serve the compiled client (vite build -> ./dist) as static files.
  const distDir = path.join(__dirname, '..', 'dist');
  app.use(express.static(distDir));

  // SPA fallback: any GET that wasn't a static file or an API/socket route
  // should return index.html so client-side routing / refreshes work.
  //
  // NOTE: Express 5 upgraded path-to-regexp and no longer accepts a bare '*'
  // string route (it throws on parse). We use a catch-all MIDDLEWARE instead,
  // which sidesteps the route-pattern parser entirely. We let non-GET requests
  // and the socket.io path fall through untouched.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// --------------------------------------------------------------------------
// 2. HTTP server + Socket.IO.
// --------------------------------------------------------------------------
// Socket.IO needs the raw http.Server (not the Express app) so it can handle the
// WebSocket upgrade on the same port.
// COUCH MODE / LAN HTTPS: if SSL_KEY + SSL_CERT point at a certificate (e.g. an
// mkcert cert for the Mac's LAN IP), serve over HTTPS so phones get a "secure
// context" — REQUIRED for the tilt controls (DeviceOrientation is HTTPS-only).
// Without those env vars we serve plain HTTP exactly as before (dev unchanged).
// Socket.IO rides the same server, so it auto-upgrades to wss under HTTPS.
let httpServer;
let isHttps = false;
const sslKey = process.env.SSL_KEY;
const sslCert = process.env.SSL_CERT;
if (sslKey && sslCert && fs.existsSync(sslKey) && fs.existsSync(sslCert)) {
  httpServer = https.createServer(
    { key: fs.readFileSync(sslKey), cert: fs.readFileSync(sslCert) },
    app,
  );
  isHttps = true;
} else {
  httpServer = http.createServer(app);
}

const io = new SocketIOServer(httpServer, {
  cors: {
    // Same-origin in prod (page + socket both served here), so CORS never fires —
    // reflect the request origin as belt-and-suspenders for the LAN https origin.
    // In dev the browser is on :5173 (cross-origin), so allow that explicitly.
    origin: IS_PROD ? true : [DEV_ORIGIN],
    methods: ['GET', 'POST'],
  },
});

// --------------------------------------------------------------------------
// 3. Game logic.
// --------------------------------------------------------------------------
// GameServer wires up all connection/lobby/room handling on this io instance.
// Constructing it registers the io 'connection' handler.
const game = new GameServer(io);

// --------------------------------------------------------------------------
// 4. Listen.
// --------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  // One clear line so the operator knows where the server is and what mode it is in.
  const mode = IS_PROD ? 'production (serving ./dist)' : 'development (client via Vite :5173)';
  const proto = isHttps ? 'https' : 'http';
  console.log(`[server] kart server listening on ${proto}://localhost:${PORT}  —  ${mode}${isHttps ? '  —  HTTPS (tilt-ready)' : ''}`);
});

// Export for tests / programmatic embedding (not required by `node server/index.js`).
export { app, httpServer, io, game };
