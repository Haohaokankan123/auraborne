// src/physics/KartPhysics.js
//
// Client-side physics wrapper. This is the ONLY physics file that touches
// three — it owns a Raycaster and glues the pure shared kart model to the 3D
// world (ground height + a minimal wall response).
//
// The actual motion math lives in shared/kartModel.js so the server can reuse
// it. Here we just:
//   1. step the deterministic model,
//   2. sample the ground below the kart to set its Y,
//   3. do a cheap forward probe so the kart doesn't drive through walls.
//
// "collider" is any THREE.Object3D (Mesh or Group) representing the track's
// solid geometry. We raycast against it. If it is null/undefined we fall back
// to flat ground at GROUND_DEFAULT_Y and skip wall checks.
//
// M2: update() also accepts the Track itself (which carries .collider plus
// .roadColliders) so it can classify the ground under the kart as 'road' or
// 'offroad' from the SAME downward ray, and feed state.surface to the shared
// model's surface-speed cap. Passing a bare collider (M1 style) still works.

import * as THREE from 'three';
import { stepKart } from '../../shared/kartModel.js';
import { PHYSICS } from '../../shared/constants.js';

export class KartPhysics {
  constructor() {
    // One reusable raycaster — we re-point it each call instead of allocating.
    this.raycaster = new THREE.Raycaster();

    // Scratch vectors, reused every frame to avoid per-frame garbage.
    this._origin = new THREE.Vector3(); // ray start point
    this._down = new THREE.Vector3(0, -1, 0); // straight-down direction (ground probe)
    this._forward = new THREE.Vector3(); // kart forward direction (wall probe)
    this._probeDir = new THREE.Vector3(); // reused per wall ray (fwd / fwd±side mix)

    // Cached combined ground-target array (collider + roadColliders). The set is
    // constant for a whole race, so we build the array once and reuse it instead
    // of spreading a new array every tick. Keyed on the collider/roadColliders
    // refs so it auto-rebuilds if the world changes (e.g. track switch).
    this._groundTargets = null;
    this._groundTargetsCollider = null;
    this._groundTargetsRoad = null;
  }

  /**
   * Advance one kart by a fixed timestep, then resolve it against the world.
   *
   * @param {object} state   - kart state from shared/kartModel.js (mutated in place).
   * @param {object} input   - input snapshot from core/Input.js getState().
   * @param {number} dt      - timestep in seconds (normally PHYSICS.DT).
   * @param {object|THREE.Object3D|null} world - one of:
   *        - a Track-like object with { collider, roadColliders } (M2: enables
   *          'road'/'offroad' surface classification), OR
   *        - a bare THREE.Object3D collider (M1 style: ground height + walls
   *          only, surface left as-is), OR
   *        - null/undefined for flat M1 ground (no raycasts).
   * @returns {object} the same `state`, advanced and ground/wall/surface-corrected.
   */
  update(state, input, dt, world) {
    // Normalize the world argument into a ground collider + optional road/wall
    // collider sets. Accept both the M2 Track and a bare M1 collider.
    const { collider, roadColliders, wallColliders } = this._resolveWorld(world);

    // TERRAIN (Phase 3): on a hilly spline track the CALLER (RaceManager/
    // TimeTrial) has ALREADY set state.groundY / state.slope / state.surface from
    // the shared trackData.sampleSurface() BEFORE this call, so stepKart can ride
    // the hills + apply the slope effect identically on client and server. In that
    // mode stepKart OWNS state.y (eases it toward groundY / integrates a jump arc),
    // so we must NOT overwrite y with a downward raycast afterwards — we only keep
    // the wall response. We detect it via the flag the caller sets on the kart
    // state. Flat/legacy worlds (Arena battle, bare colliders) leave it unset and
    // get the original step-then-raycast path unchanged.
    if (state._hillTerrain) {
      // 1. Deterministic motion model. It consumes the caller-set groundY/slope/
      //    surface and resolves y/vy/airborne itself (shared with the server).
      stepKart(state, input, dt);
      // 2. Walls only (rails). Ground height is owned by stepKart in hill mode.
      this._resolveWall(state, wallColliders);
      return state;
    }

    // 1. Run the deterministic motion model (speed, heading, x/z advance).
    //    NOTE: surface is set AFTER this from the down-ray below, so the surface
    //    cap applies on the NEXT tick — one step of latency, which is invisible
    //    at 60Hz and keeps the model purely a function of its inputs.
    stepKart(state, input, dt);

    // 2. Ground height + surface: a single downward ray sets state.y and,
    //    when roadColliders are known, classifies state.surface.
    this._resolveGround(state, collider, roadColliders);

    // 3. Wall response: cast short rays forward (and slightly to the sides)
    //    against the barrier meshes; bleed speed + push back out of any wall hit.
    this._resolveWall(state, wallColliders);

    return state;
  }

  /**
   * Accept either an M2 Track ({ collider, roadColliders, wallColliders }) or a
   * bare M1 collider (THREE.Object3D), and return a uniform
   * { collider, roadColliders, wallColliders }. roadColliders/wallColliders are
   * null when unknown so surface classification / wall response are skipped.
   * @private
   */
  _resolveWorld(world) {
    if (!world) {
      return { collider: null, roadColliders: null, wallColliders: null };
    }
    // A Track-like object exposes its own ground mesh on .collider.
    if (world.collider) {
      return {
        collider: world.collider,
        roadColliders: world.roadColliders || null,
        wallColliders: world.wallColliders || null,
      };
    }
    // Otherwise treat it as a bare collider (M1 behavior, no surface/wall info).
    return { collider: world, roadColliders: null, wallColliders: null };
  }

  /**
   * Set state.y to the ground height directly under the kart, and (when
   * roadColliders are supplied) set state.surface to 'road' or 'offroad' based
   * on whether the ray's first hit belongs to a road mesh.
   *
   * Falls back to PHYSICS.GROUND_DEFAULT_Y when there is no collider or no hit.
   * When roadColliders are unknown, state.surface is left untouched (M1 behavior).
   *
   * @param {object} state - kart state (mutated).
   * @param {THREE.Object3D|null} collider - ground geometry to raycast.
   * @param {THREE.Object3D[]|null} roadColliders - meshes that count as 'road'.
   */
  _resolveGround(state, collider, roadColliders) {
    if (!collider) {
      state.y = PHYSICS.GROUND_DEFAULT_Y;
      return;
    }

    // Start the ray above the kart so it can see ground that is slightly
    // higher than the kart's current Y (small ramps/curbs in later milestones).
    this._origin.set(state.x, state.y + PHYSICS.RAY_START_HEIGHT, state.z);
    this.raycaster.set(this._origin, this._down);
    this.raycaster.far = PHYSICS.RAY_GROUND_LENGTH;

    // Raycast against the ground AND any road meshes together so the SAME ray
    // that sets height also tells us which surface we are on. Road meshes sit a
    // hair above the ground, so when the kart is over the road the road mesh is
    // the first (highest) hit; off the road, the ground is the first hit.
    const targets = this._getGroundTargets(collider, roadColliders);
    const hits = Array.isArray(targets)
      ? this.raycaster.intersectObjects(targets, true)
      : this.raycaster.intersectObject(targets, true);

    if (hits.length > 0) {
      state.y = hits[0].point.y; // snap to the first (highest) surface the ray meets

      // Classify the surface only when we actually know the road set.
      if (roadColliders) {
        state.surface = this._isRoadHit(hits[0].object, roadColliders) ? 'road' : 'offroad';
      }
    } else {
      // Nothing below the ray. On a FLAT (legacy) track the slab sits at y~0, so
      // GROUND_DEFAULT_Y is the right fallback. On an ELEVATED floating track,
      // slamming to 0 would teleport the kart 60m into the void; instead we HOLD
      // the kart's current y (it just clipped past a road edge for a frame) and
      // mark it offroad. A genuine fall is caught by the mode's respawn safety
      // net (respawnIfFallen), which puts it back on the last checkpoint.
      // We treat "elevated" as the kart already being well above ground level.
      if (state.y <= PHYSICS.GROUND_DEFAULT_Y + 1) {
        state.y = PHYSICS.GROUND_DEFAULT_Y; // flat-track behavior unchanged
      }
      // else: leave state.y as-is (don't drop the kart into the void).
      if (roadColliders) {
        state.surface = 'offroad'; // no ground under us -> treat as off the road
      }
    }
  }

  /**
   * Return the raycast target(s) for the ground probe: the bare collider when
   * there are no road meshes, or a combined [collider, ...roadColliders] array.
   * The array is built once and cached on the instance — the collider/road set
   * is constant for a whole race, so rebuilding it every tick (13 karts x 60Hz)
   * was pure garbage. The cache is keyed on the collider/roadColliders refs so
   * it rebuilds automatically if the world changes (e.g. a track switch).
   * @private
   */
  _getGroundTargets(collider, roadColliders) {
    if (!(roadColliders && roadColliders.length)) {
      return collider;
    }
    if (
      this._groundTargets === null ||
      this._groundTargetsCollider !== collider ||
      this._groundTargetsRoad !== roadColliders
    ) {
      this._groundTargets = [collider, ...roadColliders];
      this._groundTargetsCollider = collider;
      this._groundTargetsRoad = roadColliders;
    }
    return this._groundTargets;
  }

  /**
   * True when `hitObject` (or one of its ancestors) is in the roadColliders set.
   * Raycasts can return a child mesh, so we walk up the parent chain to match a
   * road mesh or a road Group.
   * @private
   */
  _isRoadHit(hitObject, roadColliders) {
    let node = hitObject;
    while (node) {
      if (roadColliders.includes(node)) {
        return true;
      }
      node = node.parent;
    }
    return false;
  }

  /**
   * Wall response: probe a short distance ahead along the kart's travel
   * direction — plus two rays splayed slightly left/right so a wall met at an
   * angle (or by a corner of the kart) is still caught. If any ray hits a
   * barrier within WALL_PROBE_DIST, bleed most of the speed and push the kart
   * back along its travel direction so it cannot tunnel through.
   *
   * Cheap by design (runs for 13 karts every tick): ONE shared raycaster, short
   * rays, at most three intersect calls, and only against the wall meshes (not
   * the whole track). Skipped when stopped or when no wall set is known.
   *
   * @param {object} state - kart state (mutated on a hit).
   * @param {THREE.Object3D[]|null} wallColliders - barrier meshes to raycast.
   * @private
   */
  _resolveWall(state, wallColliders) {
    if (!wallColliders || wallColliders.length === 0 || state.speed === 0) {
      return;
    }

    // Travel direction. Forward MUST match shared/kartModel.js:
    // forward = (sin(heading), 0, cos(heading)). See the heading-sign note there.
    this._forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    // When reversing, the "leading" edge is behind the kart, so probe backward.
    if (state.speed < 0) {
      this._forward.negate();
    }

    // Probe from roughly kart-body height so we hit walls, not the floor.
    this._origin.set(state.x, state.y + 0.5, state.z);
    this.raycaster.far = PHYSICS.WALL_PROBE_DIST;

    // Three probe directions: dead ahead, and ~20deg to each side. The side rays
    // catch glancing/corner contacts the centre ray would slip past. We reuse a
    // single scratch vector (_probeDir) and the one shared raycaster.
    const SIDE = 0.35; // rad (~20deg) splay for the side rays.
    let hit = false;
    for (let s = -1; s <= 1 && !hit; s++) {
      const ang = s * SIDE; // -SIDE, 0, +SIDE
      if (ang === 0) {
        this._probeDir.copy(this._forward);
      } else {
        // Rotate the forward vector about Y by `ang` (XZ-plane rotation).
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        this._probeDir.set(
          this._forward.x * c + this._forward.z * sn,
          0,
          -this._forward.x * sn + this._forward.z * c,
        );
      }
      this.raycaster.set(this._origin, this._probeDir);
      if (this.raycaster.intersectObjects(wallColliders, true).length > 0) {
        hit = true;
      }
    }

    if (hit) {
      // Bleed off most of the speed (keep a small fraction so it feels like a
      // bump, not a dead stop), preserving the forward/reverse sign.
      state.speed *= PHYSICS.WALL_SPEED_KEEP;

      // Push the kart back AWAY from the wall along its travel direction so the
      // next frame doesn't immediately re-hit and stick. We clamp along forward
      // (not the angled probe) so the pushback is always straight back out.
      state.x -= this._forward.x * PHYSICS.WALL_PUSHBACK;
      state.z -= this._forward.z * PHYSICS.WALL_PUSHBACK;
    }
  }
}
