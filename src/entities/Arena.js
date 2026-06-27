// src/entities/Arena.js
//
// The BATTLE ARENA: a flat, bounded square play-field for Balloon Battle mode,
// themed NEON/SPACE — a near-black floor with glowing cyan grid lines, glowing
// neon-magenta perimeter rail walls, and (via applyTheme) a dark starfield sky +
// fog so the emissive accents bloom instead of being washed out by a bright sky.
// Unlike Track.js (a closed race circuit with checkpoints + a racing line), the
// arena has NO laps and NO direction — it's just an open floor you fight on.
//
// It is deliberately built to be a DROP-IN "world" for the two combat systems
// that were written for Track:
//   - KartPhysics.update(state, input, dt, world) reads world.collider (ground),
//     world.roadColliders (to classify surface), and world.wallColliders.
//   - ProjectileSystem(scene, track) reads track.isOnRoad(x,z) for green-shell
//     bounce + out-of-bounds. We satisfy that by exposing isOnRoad as an alias of
//     isInside, so a green shell ricochets off the arena walls just like it would
//     off a road edge.
//
// So the Arena duck-types the small slice of the Track interface those systems
// touch — without pretending to be a circuit. The fields they need:
//   .group          THREE.Group with the floor + walls (add to the scene).
//   .collider       the ground mesh (downward raycast target for kart height).
//   .roadColliders  [ground] so KartPhysics classifies the whole floor as 'road'
//                   (no off-road slow-down inside the arena).
//   .wallColliders  the four perimeter wall meshes (forward wall probe).
//   .isOnRoad(x,z)  alias of isInside — used by ProjectileSystem for bounces.
//
// Battle-specific fields (consumed by src/modes/Battle.js):
//   .bounds         { minX, maxX, minZ, maxZ } the inner playable rectangle.
//   .isInside(x,z)  true if (x,z) is within bounds (minus a small wall margin).
//   .spawnPoints    [{ x, y, z, heading }] kart start poses, spread around.
//   .itemSpawns     [{ x, z }] scattered item-box spawn points.
//
// Conventions (match the rest of the project):
//   - Y is up; the field lies in the XZ plane; world units = meters.
//   - heading is radians; forward = (sin(heading), 0, cos(heading)).

import * as THREE from 'three';

export class Arena {
  /**
   * @param {object} [opts]
   * @param {number} [opts.size=120]   full edge length of the square floor (m).
   * @param {number} [opts.fieldSize=8] number of kart spawn points to generate.
   */
  constructor(opts = {}) {
    // Full edge length of the floor. The playable area is slightly smaller than
    // this so karts spawn comfortably inside the walls.
    this.size = opts.size != null ? opts.size : 120;
    const fieldSize = opts.fieldSize != null ? opts.fieldSize : 8;

    // Root group: external code adds `arena.group` to the scene.
    this.group = new THREE.Group();
    this.group.name = 'Arena';

    // Wall geometry sizing, reused when computing the inner playable bounds.
    this.wallHeight = 3;
    this.wallThickness = 2;

    // The inner playable rectangle. We pull the bounds in by half a wall plus a
    // margin so karts (and the isInside test) never sit on top of a wall.
    const half = this.size / 2;
    const inset = this.wallThickness / 2 + 2; // margin from the wall faces
    this.bounds = {
      minX: -half + inset,
      maxX: half - inset,
      minZ: -half + inset,
      maxZ: half - inset,
    };

    // Build the world pieces.
    this._buildFloor();
    this._buildWalls();

    // Combat-system aliases: these systems were written against Track, so we
    // present the same small surface they read.
    //   - roadColliders = [ground] -> KartPhysics treats the whole floor as road
    //     (state.surface stays 'road', so no grass slow-down in the arena).
    this.roadColliders = [this.collider];

    // Generate kart spawn poses + item-box spawn points.
    this.spawnPoints = this._buildSpawnPoints(fieldSize);
    this.itemSpawns = this._buildItemSpawns();
  }

  /**
   * Build the flat floor: one big plane with a generated checker-ish texture so
   * motion is readable, plus a contrasting look from the green race track (this
   * floor is a cool blue-grey "arena" surface). Exposed as `this.collider`.
   * @private
   */
  _buildFloor() {
    const floorGeo = new THREE.PlaneGeometry(this.size, this.size);
    // NEON/SPACE arena floor: a near-black panel base whose glowing cyan grid
    // lines come from the canvas texture. We feed that same texture into the
    // material's emissive channel (with an emissiveMap) so the grid lines
    // self-illuminate and pick up the renderer's UnrealBloom — the dark base
    // stays matte while only the lines glow.
    const floorTex = this._makeFloorTexture();
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      emissive: 0xffffff,
      emissiveMap: floorTex,
      emissiveIntensity: 0.9,
      roughness: 0.55,
      metalness: 0.2,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    // PlaneGeometry faces +Z by default; rotate -90deg about X to lie flat (face +Y).
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    floor.name = 'arenaFloor';
    this.group.add(floor);

    // The ground mesh doubles as the downward-raycast target for kart height.
    this.collider = floor;
  }

  /**
   * Generate a tile texture on a canvas (distinct from the track's grass grid):
   * a dark slate base with bright accent grid lines, so the arena reads as an
   * indoor battle floor. Returned as a repeating THREE.CanvasTexture.
   * @returns {THREE.CanvasTexture}
   * @private
   */
  _makeFloorTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Near-black base so only the grid lines glow (this same texture drives the
    // emissive channel; black = no glow, bright = glowing line).
    ctx.fillStyle = '#05060f';
    ctx.fillRect(0, 0, size, size);

    // Bright neon-cyan grid lines along two edges so the repeats tile into a
    // clean glowing grid across the whole arena floor.
    ctx.strokeStyle = '#27e6ff';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, size, size);

    // A fainter inner cross so each tile has internal structure (reads as floor
    // panels) without overpowering the perimeter lines.
    ctx.strokeStyle = 'rgba(39,230,255,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size / 2, 0);
    ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2);
    ctx.lineTo(size, size / 2);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    // One tile per ~5 m so the grid cells read as floor panels.
    const repeats = this.size / 5;
    texture.repeat.set(repeats, repeats);
    texture.anisotropy = 4;
    return texture;
  }

  /**
   * Build the four perimeter walls as box meshes hugging the floor edge. Each is
   * pushed to `this.wallColliders` so KartPhysics' forward wall-probe can raycast
   * against them (the same way it does against the track barriers).
   * @private
   */
  _buildWalls() {
    // Glowing neon-magenta perimeter RAILS: strongly emissive so they bloom and
    // read as the arena's containment edge against the dark space backdrop.
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xff2fae,
      emissive: 0xff2fae,
      emissiveIntensity: 1.4,
      roughness: 0.35,
      metalness: 0.3,
    });

    this.wallColliders = [];

    const half = this.size / 2;
    const t = this.wallThickness;
    const h = this.wallHeight;
    // Walls are centered ON the edge line (x or z = ±half), so half their
    // thickness pokes outside — fine, the inner face is what matters for bounds.

    // Helper to add one axis-aligned wall box.
    const addWall = (sizeX, sizeZ, x, z, name) => {
      const geo = new THREE.BoxGeometry(sizeX, h, sizeZ);
      const wall = new THREE.Mesh(geo, wallMat);
      wall.position.set(x, h / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      wall.name = name;
      this.group.add(wall);
      this.wallColliders.push(wall);
    };

    // Top / bottom walls run the full width along X (a touch over-long so the
    // corners overlap and a kart can't squeeze through the seam).
    const span = this.size + t;
    addWall(span, t, 0, half, 'arenaWallNorth'); // +Z edge
    addWall(span, t, 0, -half, 'arenaWallSouth'); // -Z edge
    // Left / right walls run the full depth along Z.
    addWall(t, span, half, 0, 'arenaWallEast'); // +X edge
    addWall(t, span, -half, 0, 'arenaWallWest'); // -X edge
  }

  /**
   * Generate `count` kart spawn poses spread evenly around a ring inside the
   * arena, each facing roughly toward the center so the action starts in the
   * middle. Deterministic (no randomness) so a given field size always lays out
   * the same way.
   * @param {number} count
   * @returns {Array<{x:number,y:number,z:number,heading:number}>}
   * @private
   */
  _buildSpawnPoints(count) {
    const poses = [];
    // Ring radius: ~70% of the way to the inner bound, so karts start spread out
    // but not jammed against the walls.
    const half = Math.min(
      this.bounds.maxX - 0,
      this.bounds.maxZ - 0,
    );
    const radius = half * 0.7;

    for (let i = 0; i < count; i++) {
      // Even angular spacing around the ring.
      const ang = (i / Math.max(count, 1)) * Math.PI * 2;
      const x = Math.cos(ang) * radius;
      const z = Math.sin(ang) * radius;

      // Face the center: forward = (sin h, cos h), so to point at (0,0) from
      // (x,z) the forward vector is (-x, -z) normalized. heading = atan2(fx, fz).
      const heading = Math.atan2(-x, -z);

      poses.push({ x, y: 0, z, heading });
    }
    return poses;
  }

  /**
   * Scatter item-box spawn points around the arena: the center plus a ring of
   * boxes between the spawn ring and the walls. Deterministic. These positions
   * are where Battle.js asks ItemBoxManager-style boxes to sit.
   * @returns {Array<{x:number,z:number}>}
   * @private
   */
  _buildItemSpawns() {
    const spawns = [];

    // One box dead center — a hot contested pickup.
    spawns.push({ x: 0, z: 0 });

    const half = Math.min(this.bounds.maxX, this.bounds.maxZ);

    // An inner ring of 4 boxes.
    const innerR = half * 0.4;
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + Math.PI / 4; // offset so it's not axis-aligned
      spawns.push({ x: Math.cos(ang) * innerR, z: Math.sin(ang) * innerR });
    }

    // An outer ring of 8 boxes, rotated half a step off the inner ring.
    const outerR = half * 0.82;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      spawns.push({ x: Math.cos(ang) * outerR, z: Math.sin(ang) * outerR });
    }

    return spawns;
  }

  /**
   * Apply the arena's NEON/SPACE theme to the scene: a dark space background +
   * matching fog so the glowing floor grid and neon rails pop (and the
   * renderer's UnrealBloom isn't washed out by a bright sky), plus a starfield
   * attached to `this.group` so it's torn down with the arena.
   *
   * Mirrors Track.applyTheme(scene): the caller (Battle.js) saves the previous
   * scene.background / scene.fog before calling, and restores them on dispose.
   * Safe to call once after the arena is added to the scene.
   * @param {THREE.Scene} scene
   */
  applyTheme(scene) {
    if (!scene) return;
    // Deep-space backdrop + fog (same hue) so the floor fades into the void.
    const space = new THREE.Color(0x05030f);
    scene.background = space;
    scene.fog = new THREE.Fog(space.getHex(), this.size * 0.6, this.size * 1.6);

    // Starfield: a ring/dome of points well outside the play area so it reads as
    // a distant sky. Attached to this.group so dispose() frees it with the rest.
    this.group.add(this._buildStars());
  }

  /**
   * Build a THREE.Points starfield surrounding the arena. Points are scattered
   * on a large dome above + around the field. Deterministic-ish layout is fine
   * here (battles re-theme each start). Material ref is kept for disposal.
   * @returns {THREE.Points}
   * @private
   */
  _buildStars() {
    const count = 600;
    const positions = new Float32Array(count * 3);
    const radius = this.size * 1.4;
    for (let i = 0; i < count; i++) {
      // Random direction on a hemisphere-biased sphere (mostly above horizon).
      const u = Math.random();
      const v = Math.random();
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1) * 0.7; // bias upward
      const r = radius * (0.85 + Math.random() * 0.15);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 10; // keep above floor
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xbfe4ff,
      size: 1.6,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const stars = new THREE.Points(geo, mat);
    stars.name = 'arenaStars';
    return stars;
  }

  /**
   * Is (x, z) inside the playable rectangle (inset from the walls)? Used by
   * Battle.js AI wandering/targeting AND aliased as isOnRoad() for the projectile
   * system's green-shell bounce + out-of-bounds expiry.
   * @param {number} x
   * @param {number} z
   * @returns {boolean}
   */
  isInside(x, z) {
    const b = this.bounds;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  /**
   * Track-interface alias: the projectile system calls track.isOnRoad(x,z) to
   * decide whether a green shell should bounce (it's hit a boundary) and whether
   * a stray shell has left the play area. In the arena, "on road" == "inside the
   * bounds", so a shell ricochets off the perimeter walls.
   * @param {number} x
   * @param {number} z
   * @returns {boolean}
   */
  isOnRoad(x, z) {
    return this.isInside(x, z);
  }

  /**
   * Free the GPU resources this arena created. Battle.dispose() removes the group
   * from the scene; this disposes the geometries/materials/textures so a battle
   * can be started and torn down repeatedly without leaking.
   */
  dispose() {
    this.group.traverse((obj) => {
      // Meshes (floor + walls) AND the starfield Points both carry geometry +
      // material to free.
      if (obj.isMesh || obj.isPoints) {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          // The floor material carries a texture as both `map` and `emissiveMap`
          // (the same object), so disposing once is enough; emissiveMap may be
          // the same ref. Guard against double-free by only disposing map.
          if (obj.material.map) obj.material.map.dispose();
          obj.material.dispose();
        }
      }
    });
  }
}
