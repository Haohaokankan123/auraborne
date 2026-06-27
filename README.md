# AURABORNE — Kart Racer

An original Mario Kart-style 3D browser racing game. Built with vanilla JavaScript
(ESM), [Three.js](https://threejs.org/) for rendering, and a Node + Express +
[Socket.IO](https://socket.io/) server for authoritative online multiplayer.

> ### ▶ [Play now in your browser](https://haohaokankan123.github.io/auraborne/)
> Single-player (Grand Prix cups, Time Trial, Battle vs AI) runs entirely in the
> browser — no install. There's a graphics quality slider (Low→Ultra) in the pause
> menu, so it runs on weak laptops/Chromebooks too. **Online multiplayer needs the
> Node server** (static GitHub Pages can't run it) — see [DEPLOY.md](./DEPLOY.md).

> **No Nintendo IP.** Every asset is original: all 3D geometry is generated
> procedurally in code, all audio is synthesized live with the Web Audio API, and
> all text uses system fonts. Nothing is copied from, or derived from, Nintendo
> (or any other) games. See [CREDITS.md](./CREDITS.md).

---

## Features

### Game modes
- **Grand Prix** — a single race against 12 AI opponents.
- **Grand Prix Cup** — a 3-race championship across all three tracks. Points are
  awarded by finish position each race and tallied cumulatively, with a standings
  screen between races and a champion screen crowning the racer with the most
  points after the third.
- **Time Trial** — race the clock solo, then race your own saved **ghost**.
- **Battle** — a 3-balloon free-for-all in an arena. Pop rivals' balloons; a kart
  at zero is out. Last kart standing wins, or the highest balloon count when the
  120-second match clock runs out — settled on a styled results board.
- **Online Multiplayer** — server-authoritative racing with client-side
  prediction and entity interpolation, so play stays smooth under latency.

### Tracks
Three procedurally built tracks, choosable from the track-select screen:
- **Rainbow Ridge** (circuit) — neon synthwave ridge coaster
- **Cosmic Speedway** (oval) — fast space sweeper
- **Cloudtop Circuit** (figure) — twisty sky loop

Each track threads an **MK8-style anti-gravity corkscrew** — a section where the
road rolls a full turn about its driving line, carrying you up the wall and across
the ceiling before setting you back down.

### Customization
- Pick a **character** and a **kart**, each with its own stat profile
  (speed / acceleration / handling / weight) that actually affects driving.

### Progression & records
- **Records panel** (📊 from the main menu) — a persistent localStorage card of
  lifetime wins (races + cups), your best lap per track with medals, and lifetime
  drift / trick / coin totals.
- **Unlockable cosmetics** — extra kart bodies, wheels, and characters unlock as
  you hit race-win and cup-win milestones.
- **Kart-style toggle** — karts render in the procedural neon style by default, or
  switch to real 3D **CC0** kart models from the pause-menu settings (applies on
  the next race). See [CREDITS.md](./CREDITS.md).

### Racing systems
- **Drift + mini-turbo** boost.
- **Air tricks** — get air off a ramp or gap and steer to work a trick; a clean
  landing banks your "style" as a boost.
- **Overdrive** (signature hook) — a meter that fills from clean trick landings and
  mini-turbos; spend a full meter (`Q`) for a short, strong speed surge.
- **Items** (offensive/defensive/speed) with pickup boxes around the track.
- Particle **VFX** (drift sparks, boost, hits) and synthesized engine/SFX audio.

### Performance
- Targets a smooth **60fps** and runs well above it (120-240fps) on typical
  desktop hardware, thanks to procedural geometry, instanced static props, and a
  light render path.

---

## Controls

| Action      | Keyboard            | Gamepad                | Touch                 |
|-------------|---------------------|------------------------|-----------------------|
| Accelerate  | `W` / `↑`           | A / right trigger      | on-screen pedal       |
| Brake / reverse | `S` / `↓`       | B / left trigger       | on-screen pedal       |
| Steer       | `A` `D` / `←` `→`   | left stick / d-pad     | on-screen wheel/stick |
| Drift / hop | `Space`             | shoulder button        | drift button          |
| Air trick   | steer in mid-air    | steer in mid-air       | steer in mid-air      |
| Overdrive   | `Q`                 | X / square             | overdrive button      |
| Use item    | `Shift` / `E`       | face button            | item button           |
| Look back   | `F`                 | —                      | —                     |
| Pause       | `Esc` / `P`         | —                      | —                     |

Input precedence per frame: keyboard is read first, then an active gamepad
overrides it, then on-screen touch controls override while a finger is down.
Plug in a controller or open the page on a phone and the relevant scheme just
works — no menu toggle needed.

Pause (`Esc` / `P`) freezes single-player races and opens the pause/settings
overlay; online races keep simulating on the server, so there is no local pause
there.

---

## Run it locally

Requires **Node.js 18+**.

```bash
npm install      # install dependencies
npm run dev:full # start the Vite dev client AND the multiplayer server together
```

Then open the URL Vite prints (default <http://localhost:5173>). The Vite dev
server proxies `/socket.io` to the Node server on port 3001, so multiplayer works
in development with no extra setup.

### Other scripts
| Script            | What it does                                              |
|-------------------|-----------------------------------------------------------|
| `npm run dev`     | Vite dev client only (no multiplayer server).             |
| `npm run server`  | Node multiplayer server only (`node server/index.js`, port 3001). |
| `npm run build`   | Production build of the client into `dist/`.              |
| `npm run preview` | Serve the built client with Vite's preview server.        |
| `npm start`       | Production server: serves built `dist/` + Socket.IO on one origin. |

For a production-style single-origin run locally:

```bash
npm run build
NODE_ENV=production npm start   # serves client + socket on http://localhost:3001
```

---

## Architecture

The project is split into three top-level areas:

```
src/      Client. Vanilla-JS ESM modules, bundled by Vite.
            core/     engine, input (keyboard/gamepad/touch), loaders
            entities/ karts and world objects
            physics/  kart driving model
            race/     race loop, standings, lap logic
            ai/       AI opponent driving
            items/    item boxes and effects
            effects/  particle VFX
            audio/    Web Audio synthesis (engine, SFX, music)
            modes/    TimeTrial, Battle, Multiplayer mode controllers
            net/      SocketClient + client-side prediction/interpolation
            ui/       menus, HUD, character/kart/track select
            data/     character & kart stat tables
            main.js   entry point / app state machine

server/   Authoritative multiplayer server (run directly by Node, NOT bundled).
            index.js     Express + http + Socket.IO wiring; serves dist/ in prod
            GameServer.js connection/lobby/room handling
            Room.js      one race room: simulation + snapshots

shared/   Code used by BOTH client and server so they agree on the world.
            constants.js  tunables shared by client + server
            kartModel.js  the kart physics model (deterministic)
            trackData.js  track definitions
```

**Why a `shared/` folder:** the multiplayer server re-runs the same kart physics
model the client predicts with. Keeping `kartModel.js`, `constants.js`, and
`trackData.js` shared means the server's authoritative simulation and the
client's prediction stay in lock-step, which is what makes reconciliation smooth.

**Networking model:** the server is authoritative. The client predicts its own
motion immediately for responsiveness, stamps each input with a sequence number,
and reconciles against the server's acknowledged sequence in each snapshot. Other
karts are interpolated between snapshots. The client connects to Socket.IO on the
**same origin** by default, so it works behind the dev proxy and in single-origin
production with zero configuration.

---

## Deploying

See [DEPLOY.md](./DEPLOY.md). The repo ships a `render.yaml` blueprint for a
one-service deploy on [Render](https://render.com/).

## License / credits

All code is original and the project bundles no third-party game assets. Runtime
dependency licenses are listed in [CREDITS.md](./CREDITS.md).
