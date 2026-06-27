# Credits & Licensing

## Originality statement

This game contains **no Nintendo intellectual property**. Aside from an optional
set of **CC0 / public-domain** 3D kart models (attributed below), it bundles **no
third-party game assets**. Specifically:

- **All code is original** and written for this project.
- **Geometry is procedural by default** — karts, tracks, and props are generated
  at runtime in code (Three.js geometry). The one exception is an optional set of
  **CC0 / public-domain** 3D kart models, switchable in settings and attributed
  below; no other `.glb`/`.gltf`, `.fbx`, or `.obj` assets ship.
- **All audio is synthesized live** using the **Web Audio API** (engine drone,
  countdown beeps, item/collision SFX, music). There are no audio files bundled.
- **All text uses system fonts** (the browser/OS default font stack). No font
  files are bundled or loaded.
- **No textures, sprites, or image assets** ship with the game build — visuals
  are vertex colors / materials defined in code.

Apart from the CC0 kart models attributed below, there are no external asset
files: the look, sound, characters, tracks, and the default procedural karts are
all original and procedurally produced.

### Kart model sourcing (graphics overhaul)

During the neon-arcade graphics overhaul we attempted to source a CC0/MIT
low-poly **go-kart** `.glb` to replace the procedural kart. Each candidate was
verified to be a real binary glTF (first 4 bytes == `glTF`), not an HTML/404
error page. Results:

- `raw.githubusercontent.com/mrdoob/three.js/.../examples/models/gltf/` — only
  yielded non-kart models (e.g. `Soldier.glb`, a humanoid), unsuitable as a kart.
- `KhronosGroup/glTF-Sample-Models/.../ToyCar/glTF-Binary/ToyCar.glb` — a VALID
  GLB (CC0 / Apache-2.0) but it is a chunky **toy car** (~5.8 MB), not a racing
  go-kart, and its baked PBR paint fights per-racer color tinting. Rejected as
  off-theme.
- `KenneyNL/Starter-Kit-Racing/models/vehicle-*.glb` — VALID GLBs (Kenney, CC0)
  but the kit ships only a motorcycle and **trucks** (color-baked, e.g.
  `vehicle-truck-red.glb`), no go-kart. The baked body colors fight per-racer
  tinting and the silhouettes are wrong for a Mario-Kart-style racer. Rejected.
- `KenneyNL/car-kit`, `KenneyNL/racing-kit` repo paths — returned `404`
  (those exact repo names do not exist).

No off-the-shelf truck/toy-car fit, so the **default** kart stayed **procedural** —
a substantially upgraded design: a low sleek glossy-PBR chassis with a rounded
hood, scooped cockpit + seat back, side engine pods, a rear wing, rimmed
front/rear wheels, and a seated driver with arms/hands on a steering wheel and a
visored helmet. Emissive neon accents are kept low so the painted body color
reads clearly (no white wash-out). The preloaded-model code path
(`Kart.setSharedModel(scene)` / `new Kart({ model })`) is now wired to an
**optional set of CC0 go-kart models from Kenney's Car Kit** (attributed in
_3D kart models_ below), dropped into `public/assets/models/` and switchable in
the pause-menu settings — procedural remains the default.

### 3D kart models (bundled, CC0)

The optional 3D karts use **Kenney "Car Kit" (v3.1)** — **CC0 / public domain**,
no attribution required, credited here anyway. Source:
<https://kenney.nl/assets/car-kit>.

Bundled in `public/assets/models/` (mirrors that folder's `CREDITS.txt`):

| File              | Kenney source model |
|-------------------|---------------------|
| `kart.glb`        | `kart-oopi`         |
| `kart-alt1.glb`   | `kart-ooli`         |
| `kart-alt2.glb`   | `kart-oozi`         |
| `kart-future.glb` | `race-future`       |
| `kart-race.glb`   | `race`              |

## Runtime dependencies

These third-party libraries are used at runtime and are bundled into the client
and/or run on the server. All are widely used open-source packages.

| Package            | Role                                  | License |
|--------------------|---------------------------------------|---------|
| `three`            | 3D rendering (client)                 | MIT     |
| `socket.io`        | realtime server (server)              | MIT     |
| `socket.io-client` | realtime client (client)              | MIT     |
| `express`          | HTTP server / static file serving     | MIT     |
| `gsap`             | UI / animation tweening               | GreenSock Standard "No Charge" License (free for this use) |
| `howler`           | audio playback helper                 | MIT     |
| `tailwindcss`      | UI styling (build-time, dev dep)      | MIT     |

> **GSAP note:** GSAP ships under the GreenSock Standard "No Charge" license,
> which permits use in projects that are not sold to end users as the product.
> See <https://gsap.com/standard-license> for the current terms.

## Build / dev tooling

Build and development only (not shipped to players): `vite`, `@tailwindcss/vite`,
`concurrently`, `stats.js`. All MIT-licensed.

## This project's code

All first-party source in `src/`, `server/`, and `shared/` is original work for
this project.
