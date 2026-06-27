# Deploying

This game runs as a **single Node web service**: the Express + Socket.IO server
serves the built Vite client (`dist/`) as static files AND handles the multiplayer
websocket on the **same origin and port**. There is no separate frontend host and
no separate API host to coordinate.

> **Single-origin note:** the client connects to Socket.IO at the same origin it
> was served from (the connection URL is left empty in `src/net/SocketClient.js`).
> That means in production you do **not** set any client-side server URL or CORS
> config — once the page loads from your deployed host, multiplayer connects to
> that same host automatically.

---

## Deploy on Render (recommended — uses `render.yaml`)

1. **Push to GitHub.** Commit the whole repo (including `render.yaml`) and push it
   to a GitHub repository.
2. In the [Render dashboard](https://dashboard.render.com/), click
   **New > Blueprint**.
3. Connect the GitHub repo. Render detects `render.yaml` and proposes one web
   service named **kart-racer**. Click **Apply** / **Create**.
4. Render runs the build and start commands from the blueprint and gives you a
   public `https://kart-racer-XXXX.onrender.com` URL. Open it and play.

The blueprint provisions:

| Setting        | Value                              |
|----------------|------------------------------------|
| Type           | web service                        |
| Runtime        | node                               |
| Plan           | free                               |
| Build command  | `npm install && npm run build`     |
| Start command  | `npm start`                        |
| Env var        | `NODE_ENV=production`              |

### Manual setup (if you prefer not to use the blueprint)
On Render, **New > Web Service**, connect the repo, then set:

- **Runtime:** Node
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Environment variable:** `NODE_ENV` = `production`

---

## Environment variables

| Variable    | Required | Notes                                                             |
|-------------|----------|-------------------------------------------------------------------|
| `PORT`      | provided | **Render injects this automatically** — the server reads `process.env.PORT`. Do not hardcode it. Locally it defaults to `3001`. |
| `NODE_ENV`  | yes      | Set to `production` so the server serves `dist/` statically with an SPA fallback. Without it the server assumes dev mode and does not serve the client. |

---

## How the production server behaves

- `npm start` runs `node server/index.js`.
- With `NODE_ENV=production`, the server serves `./dist` as static files and falls
  back to `index.html` for any non-`/socket.io` GET (so refreshes work).
- Socket.IO attaches to the same HTTP server, so the websocket upgrade happens on
  the same port Render exposes. No second service, no cross-origin config.

## Deploying elsewhere

Any host that can run a long-lived Node process works (Railway, Fly.io, a VPS,
etc.). The only requirements are:

1. Run `npm install && npm run build` once at deploy time.
2. Start with `npm start` (i.e. `node server/index.js`).
3. Set `NODE_ENV=production`.
4. Let the platform set `PORT`, or set it yourself.

Static-only / serverless-only hosts that cannot keep a websocket server running
(e.g. plain static-site hosting) are **not** suitable, because multiplayer needs
the persistent Socket.IO server.
