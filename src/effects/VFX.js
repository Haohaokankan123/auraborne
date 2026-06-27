// src/effects/VFX.js
//
// VFX = a tiny, POOLED particle helper for short-lived visual flourishes:
//   - boostFlames(position, dir) : a brief flame burst behind a boosting kart
//   - confettiBurst(position)    : a colourful finish-line celebration
//   - smoke(position)            : soft grey puffs (drift smoke / impacts)
//
// Why a pool? A race can have 13+ karts all boosting at once. Allocating new
// geometry/material per particle every frame would thrash the garbage collector
// and stutter the framerate. Instead we pre-create a fixed POOL of reusable
// particle meshes up front; emitting a burst just "wakes up" sleeping particles
// from the pool, and when a particle's life runs out it goes back to sleep
// (hidden, available for reuse). No per-frame allocation, cheap for many karts.
//
// All particles share ONE small geometry (a tiny plane). Each particle has its
// OWN material so it can have its own colour/opacity, but materials are created
// once at startup and reused — never per emit.
//
// update(dt) advances every awake particle: it moves by its velocity, applies a
// little gravity, fades out over its lifetime, and sleeps when expired.

import * as THREE from 'three';

export class VFX {
  /**
   * @param {THREE.Scene} scene  The scene to add particle meshes to.
   * @param {Object} [opts]
   * @param {number} [opts.poolSize=240]  How many particles to pre-allocate.
   */
  constructor(scene, opts = {}) {
    this.scene = scene;

    // How many particles exist in total. 240 comfortably covers many karts
    // bursting at once; tune up/down for your particle budget.
    const poolSize = opts.poolSize != null ? opts.poolSize : 240;

    // ONE shared geometry for every particle: a 1x1 plane, centered on origin.
    // We scale each particle via its mesh.scale, so this single geometry serves
    // flames, confetti, and smoke at any size.
    this._geometry = new THREE.PlaneGeometry(1, 1);

    // The pool of particle records. Each record bundles the reusable THREE.Mesh
    // with the simulation state we mutate each frame.
    this._particles = [];

    for (let i = 0; i < poolSize; i++) {
      // Each particle owns its material so colour/opacity are independent.
      // transparent:true lets us fade via opacity; depthWrite:false stops
      // particles from punching holes in each other when they overlap.
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        side: THREE.DoubleSide, // a flat plane should show from both faces
      });

      const mesh = new THREE.Mesh(this._geometry, material);
      mesh.visible = false; // asleep by default
      // Particles are decorative; they should not cast/receive shadows (cheaper).
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.scene.add(mesh);

      this._particles.push({
        mesh,
        material,
        active: false,    // is this particle currently awake/animating?
        life: 0,          // seconds remaining before it sleeps
        maxLife: 1,       // total lifetime (used to compute fade fraction)
        // velocity components (world units per second)
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 0,       // downward acceleration applied to vy each second
        startScale: 1,    // size at birth
        endScale: 1,      // size at death (we lerp between the two)
        spin: 0,          // z-rotation speed (radians/sec) for confetti flutter
        roll: 0,          // accumulated z-rotation (radians) from spin
        fade: true,       // whether opacity should fall to 0 over the lifetime
        startOpacity: 1,  // opacity at birth (fade scales down from this)
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: find the next sleeping particle, or null if the pool is exhausted.
  // We just scan linearly; the pool is small so this is plenty fast, and it
  // means a busy frame simply drops extra particles instead of allocating more.
  // ---------------------------------------------------------------------------
  _acquire() {
    for (let i = 0; i < this._particles.length; i++) {
      if (!this._particles[i].active) return this._particles[i];
    }
    return null; // pool full — silently skip (graceful degradation)
  }

  // _toVec3(p) accepts either a THREE.Vector3 or a plain {x,y,z} and returns the
  // three components. Lets callers pass kart.position (Vector3) OR a state-like
  // {x,y,z} object interchangeably.
  _coords(p) {
    if (!p) return { x: 0, y: 0, z: 0 };
    return { x: p.x || 0, y: p.y || 0, z: p.z || 0 };
  }

  // ---------------------------------------------------------------------------
  // boostFlames(position, dir)
  // A brief flame burst shooting BACKWARD from a boosting kart.
  //   position : where the kart is, {x,y,z} or THREE.Vector3
  //   dir      : the kart's FORWARD direction, {x,z} or THREE.Vector3. Flames
  //              are emitted opposite to this (out the back). Optional; defaults
  //              to shooting along -Z.
  // ---------------------------------------------------------------------------
  boostFlames(position, dir) {
    const pos = this._coords(position);

    // Work out the BACKWARD direction (opposite the kart's forward). Normalise so
    // emission speed is consistent regardless of how the caller scaled dir.
    let fx = dir && dir.x != null ? dir.x : 0;
    let fz = dir && dir.z != null ? dir.z : 1;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len;
    fz /= len;
    const backX = -fx; // out the back of the kart
    const backZ = -fz;

    // Emit a cluster of flame particles. Bumped to 18 so the player's boost
    // trail (main.js sprays this every frame while boosting) reads as a dense,
    // energetic jet rather than a thin dribble — more "this is FAST".
    const count = 18;
    for (let i = 0; i < count; i++) {
      const p = this._acquire();
      if (!p) break;

      // Flame colours run from bright yellow core to orange/red edges.
      const t = Math.random();
      const color = t < 0.5 ? 0xffe066 : t < 0.8 ? 0xff9933 : 0xff4422;

      // Spread: small sideways/vertical jitter so the burst looks like a flame,
      // not a single line. perp is the sideways axis (rotate back-vector 90°).
      const perpX = -backZ;
      const perpZ = backX;
      const side = (Math.random() - 0.5) * 1.2;
      const speed = 6 + Math.random() * 6;

      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;

      p.mesh.position.set(
        pos.x + backX * 0.6 + perpX * side * 0.3,
        pos.y + 0.4 + Math.random() * 0.2,
        pos.z + backZ * 0.6 + perpZ * side * 0.3
      );

      // Velocity: mostly backward, plus a little sideways + slight upward lift.
      p.vx = backX * speed + perpX * side;
      p.vy = 1 + Math.random() * 1.5;
      p.vz = backZ * speed + perpZ * side;
      p.gravity = 0;          // flames rise/coast, not fall
      p.spin = 0;

      p.maxLife = 0.3 + Math.random() * 0.15;
      p.life = p.maxLife;
      p.startScale = 1.1 + Math.random() * 0.7; // fatter flames = punchier jet
      p.endScale = 0.1;       // shrink as it burns out
      p.fade = true;
      p.mesh.scale.setScalar(p.startScale);
      p.roll = Math.random() * Math.PI;
      p.mesh.rotation.z = p.roll;
    }
  }

  // ---------------------------------------------------------------------------
  // confettiBurst(position)
  // A celebratory fountain of multi-coloured confetti that sprays up and out,
  // then flutters down under gravity — for crossing the finish line.
  // ---------------------------------------------------------------------------
  confettiBurst(position) {
    const pos = this._coords(position);

    // A bright, varied palette so the burst feels festive.
    const palette = [
      0xff3b6b, 0xffd23f, 0x3fd2ff, 0x6bff3b, 0xb03bff, 0xff8c3b, 0xffffff,
    ];

    const count = 60;
    for (let i = 0; i < count; i++) {
      const p = this._acquire();
      if (!p) break;

      const color = palette[(Math.random() * palette.length) | 0];

      // Emit in a cone pointing up: random horizontal angle, strong upward lift.
      const angle = Math.random() * Math.PI * 2;
      const horizSpeed = 2 + Math.random() * 5;
      const upSpeed = 6 + Math.random() * 6;

      p.active = true;
      p.mesh.visible = true;
      p.material.color.setHex(color);
      p.material.opacity = 1;
      p.startOpacity = 1;

      p.mesh.position.set(
        pos.x + (Math.random() - 0.5) * 0.5,
        pos.y + 1.0,
        pos.z + (Math.random() - 0.5) * 0.5
      );

      p.vx = Math.cos(angle) * horizSpeed;
      p.vy = upSpeed;
      p.vz = Math.sin(angle) * horizSpeed;
      p.gravity = 14;         // pulls the confetti back down for the flutter
      p.spin = (Math.random() - 0.5) * 12; // tumble as it falls

      p.maxLife = 1.6 + Math.random() * 1.0;
      p.life = p.maxLife;
      // Small rectangles: confetti flakes. Keep them roughly square-ish small.
      p.startScale = 0.25 + Math.random() * 0.2;
      p.endScale = p.startScale; // don't shrink; fade handles the disappearance
      p.fade = true;
      p.mesh.scale.setScalar(p.startScale);
      p.roll = Math.random() * Math.PI;
      p.mesh.rotation.z = p.roll;
    }
  }

  // ---------------------------------------------------------------------------
  // smoke(position)
  // Soft grey puffs that drift up and expand — drift smoke, dust, light impacts.
  // ---------------------------------------------------------------------------
  smoke(position) {
    const pos = this._coords(position);

    const count = 6;
    for (let i = 0; i < count; i++) {
      const p = this._acquire();
      if (!p) break;

      // Greyscale puffs with slight variation so they don't look flat.
      const g = 0.55 + Math.random() * 0.25;
      p.active = true;
      p.mesh.visible = true;
      p.material.color.setRGB(g, g, g);
      p.material.opacity = 0.6;
      p.startOpacity = 0.6;

      p.mesh.position.set(
        pos.x + (Math.random() - 0.5) * 0.6,
        pos.y + 0.2,
        pos.z + (Math.random() - 0.5) * 0.6
      );

      // Gentle drift: mostly up, a touch of horizontal wander.
      p.vx = (Math.random() - 0.5) * 1.2;
      p.vy = 1.2 + Math.random() * 1.0;
      p.vz = (Math.random() - 0.5) * 1.2;
      p.gravity = -1.5;       // negative = slight continued upward float
      p.spin = (Math.random() - 0.5) * 1.5;

      p.maxLife = 0.7 + Math.random() * 0.4;
      p.life = p.maxLife;
      p.startScale = 0.6 + Math.random() * 0.4;
      p.endScale = 2.0 + Math.random() * 1.0; // puffs expand as they dissipate
      p.fade = true;
      p.mesh.scale.setScalar(p.startScale);
      p.roll = Math.random() * Math.PI;
      p.mesh.rotation.z = p.roll;
    }
  }

  // ---------------------------------------------------------------------------
  // update(dt)
  // Advance every awake particle by dt seconds. Call once per frame from the
  // game loop. Sleeping particles are skipped, so this stays cheap.
  //   - move by velocity
  //   - apply gravity to vertical velocity
  //   - lerp scale from startScale -> endScale over the lifetime
  //   - fade opacity toward 0 over the lifetime (if fade is on)
  //   - sleep (hide + mark inactive) when life runs out
  //
  // Particles are billboarded to face the camera ONLY if a camera is passed;
  // otherwise they keep their fixed orientation (still looks fine for flames).
  // ---------------------------------------------------------------------------
  update(dt, camera) {
    if (!dt || dt <= 0) return;

    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      if (!p.active) continue;

      // Tick down the life clock; sleep the particle when it expires.
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }

      // Gravity pulls the vertical velocity down (or up, if gravity is negative).
      p.vy -= p.gravity * dt;

      // Integrate position by velocity.
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;

      // lifeFraction goes 1 -> 0 as the particle ages.
      const lifeFraction = p.life / p.maxLife;
      const age = 1 - lifeFraction; // 0 at birth -> 1 at death

      // Scale: linear interpolate startScale -> endScale by age.
      const scale = p.startScale + (p.endScale - p.startScale) * age;
      p.mesh.scale.setScalar(scale);

      // Fade: opacity follows lifeFraction so it reaches ~0 right as it dies.
      // We use p.startOpacity as the ceiling so semi-transparent puffs (smoke
      // starts at 0.6) fade from their own starting opacity, not from 1.
      if (p.fade) {
        p.material.opacity = lifeFraction * p.startOpacity;
      }

      // Spin (z-rotation) for confetti flutter / smoke tumble. We accumulate the
      // roll separately so billboarding (below) can re-apply it cleanly.
      if (p.spin) {
        p.roll += p.spin * dt;
      }

      if (camera) {
        // Billboard: face the camera so flat planes always read as particles
        // rather than disappearing edge-on. Then add the per-particle roll on
        // top of the camera-facing orientation.
        p.mesh.quaternion.copy(camera.quaternion);
        if (p.roll) p.mesh.rotateZ(p.roll);
      } else {
        // No camera: just apply the flat z-roll directly.
        p.mesh.rotation.z = p.roll;
      }
    }
  }

  // dispose() frees the shared geometry and every particle material, and removes
  // the meshes from the scene. Call when tearing a mode down to avoid leaks.
  dispose() {
    for (let i = 0; i < this._particles.length; i++) {
      const p = this._particles[i];
      this.scene.remove(p.mesh);
      p.material.dispose();
    }
    this._geometry.dispose();
    this._particles.length = 0;
  }
}
