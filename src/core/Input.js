// src/core/Input.js
//
// Input handling for the kart game.
//
// This class listens to the keyboard and (optionally) a connected gamepad,
// then exposes a single getState() method that returns the current control
// values in a normalized shape the rest of the game can read every frame.
//
// The returned state shape is:
//   {
//     steer:    -1..1   (-1 = full left, +1 = full right)
//     throttle:  0..1   (0 = no gas,     1 = full gas)
//     brake:     0..1   (0 = no brake,   1 = full brake)
//     drift:     boolean
//     useItem:   boolean
//     lookBack:  boolean
//   }
//
// Keyboard and gamepad are both polled inside getState(). If an active
// gamepad is found, its values OVERRIDE the keyboard values for that frame.
//
// On touch devices (phones/tablets) on-screen controls are auto-enabled (see
// enableTouch + the constructor). While a finger is on a touch control, its
// values OVERRIDE the keyboard for that frame, so touch and keyboard never
// fight each other.

import { TouchControls } from '../ui/TouchControls.js';

export class Input {
  constructor() {
    // A Set holds the `code` of every key currently held down.
    // We use KeyboardEvent.code (e.g. "KeyW", "ArrowUp", "Space") because
    // it refers to the physical key and is not affected by keyboard layout
    // or modifier keys.
    this.pressedKeys = new Set();

    // Bind the handlers once and keep references so the listeners can be
    // added (and, if ever needed, removed) reliably.
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);

    // Listen on window so input is captured no matter which element has focus.
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    // The on-screen touch controls, created lazily by enableTouch(). Null until
    // then. When set, its state overrides the keyboard while a finger is down.
    this.touch = null;

    // Auto-enable touch controls on devices that report touch support. We check
    // for a touch event API OR a "coarse" pointer (the media query browsers use
    // to describe finger/stylus input). Either one means a virtual pad helps.
    if (this._isTouchDevice()) {
      this.enableTouch(document.body);
    }
  }

  // Heuristic: does this device have touch input? True on phones/tablets.
  // 'ontouchstart' in window  -> the touch event API exists.
  // matchMedia('(pointer: coarse)') -> the primary pointer is finger-sized.
  _isTouchDevice() {
    const hasTouchEvents = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
    let coarsePointer = false;
    if (typeof window.matchMedia === 'function') {
      coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    }
    return hasTouchEvents || coarsePointer;
  }

  // Called on every keydown event.
  _handleKeyDown(event) {
    // Prevent the browser's default behavior for keys that would otherwise
    // scroll the page (Arrow keys) or scroll/activate buttons (Space).
    if (this._shouldPreventDefault(event.code)) {
      event.preventDefault();
    }

    this.pressedKeys.add(event.code);
  }

  // Called on every keyup event.
  _handleKeyUp(event) {
    if (this._shouldPreventDefault(event.code)) {
      event.preventDefault();
    }

    this.pressedKeys.delete(event.code);
  }

  // Returns true for keys whose default browser action we want to suppress.
  _shouldPreventDefault(code) {
    return (
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Space'
    );
  }

  // Small helper: is the given key code currently held down?
  _isDown(code) {
    return this.pressedKeys.has(code);
  }

  // Returns the current control state for this frame.
  // Reads the keyboard first, then lets an active gamepad override it.
  getState() {
    // ---- Keyboard ----

    // throttle: W or ArrowUp -> 1, otherwise 0
    const throttleDown = this._isDown('KeyW') || this._isDown('ArrowUp');

    // brake: S or ArrowDown -> 1, otherwise 0
    const brakeDown = this._isDown('KeyS') || this._isDown('ArrowDown');

    // steer: right keys add +1, left keys subtract 1.
    // (D / ArrowRight = +1 right) - (A / ArrowLeft = +1 left) => -1..1
    const rightDown = this._isDown('KeyD') || this._isDown('ArrowRight');
    const leftDown = this._isDown('KeyA') || this._isDown('ArrowLeft');

    // drift: Space held
    const driftDown = this._isDown('Space');

    // useItem: either Shift key or KeyE held
    const useItemDown =
      this._isDown('ShiftLeft') ||
      this._isDown('ShiftRight') ||
      this._isDown('KeyE');

    // lookBack: KeyF held
    const lookBackDown = this._isDown('KeyF');

    // overdrive: KeyQ held — spend a full overdrive meter for a strong surge.
    // Q is the one free letter near the steering hand (WASD); all other actions
    // are taken (Space=drift, Shift/E=item, F=lookBack).
    const overdriveDown = this._isDown('KeyQ');

    // Build the keyboard-based state object.
    const state = {
      steer: (rightDown ? 1 : 0) - (leftDown ? 1 : 0),
      throttle: throttleDown ? 1 : 0,
      brake: brakeDown ? 1 : 0,
      drift: driftDown,
      useItem: useItemDown,
      lookBack: lookBackDown,
      overdrive: overdriveDown,
    };

    // ---- Gamepad (overrides keyboard if a pad is active) ----
    this._applyGamepad(state);

    // ---- Touch (overrides the above while a finger is on a control) ----
    this._applyTouch(state);

    return state;
  }

  // Merges the on-screen touch controls into `state`. Touch only overrides when
  // it is actively being used (a finger is down on a control), so on a device
  // that also has a keyboard/gamepad the touch pad doesn't zero things out when
  // idle. lookBack has no touch button, so it is left untouched.
  _applyTouch(state) {
    if (!this.touch || typeof this.touch.getState !== 'function') {
      return;
    }
    // Only override while at least one touch is live on a control.
    if (typeof this.touch.isActive === 'function' && !this.touch.isActive()) {
      return;
    }

    const t = this.touch.getState();
    // steer: the thumb-stick value wins.
    state.steer = t.steer;
    // throttle/brake/drift/item: OR-merge so a held button stays on even if the
    // matching keyboard key isn't pressed (and vice versa).
    state.throttle = Math.max(state.throttle, t.throttle);
    state.brake = Math.max(state.brake, t.brake);
    state.drift = state.drift || t.drift;
    state.useItem = state.useItem || t.useItem;
    state.overdrive = state.overdrive || t.overdrive;
  }

  // Polls the Gamepad API. If an active pad is found, its inputs overwrite
  // the matching fields on `state`. Standard gamepad mapping is assumed:
  //   axes[0]    -> left stick X (steering)
  //   buttons[7] -> right trigger (RT)        -> throttle
  //   buttons[6] -> left trigger (LT)         -> brake
  //   buttons[0] -> A / cross                 -> throttle (fallback)
  //   buttons[1] -> B / circle                -> brake (fallback)
  //   buttons[5] -> right bumper (RB)         -> drift
  //   buttons[4] -> left bumper (LB)          -> useItem
  //   buttons[3] -> Y / triangle              -> lookBack
  _applyGamepad(state) {
    // navigator.getGamepads() may not exist in every environment, so guard it.
    if (!navigator.getGamepads) {
      return;
    }

    const gamepads = navigator.getGamepads();
    if (!gamepads) {
      return;
    }

    // Find the first connected pad with usable axes/buttons.
    let pad = null;
    for (let i = 0; i < gamepads.length; i++) {
      const candidate = gamepads[i];
      if (candidate && candidate.connected) {
        pad = candidate;
        break;
      }
    }

    if (!pad) {
      return;
    }

    const axes = pad.axes || [];
    const buttons = pad.buttons || [];

    // Only override while the pad is actually being touched. A merely-connected
    // idle pad (common when a controller is paired but the player is on WASD/touch)
    // must NOT zero out keyboard/touch inputs every frame. Mirrors _applyTouch's
    // isActive() gate.
    const active =
      axes.some((a) => Math.abs(a) > 0.15) ||
      buttons.some((b) => b && (b.pressed || (b.value || 0) > 0.1));
    if (!active) {
      return;
    }

    // steer: left stick X axis with a small deadzone so a resting stick
    // (which often reports a tiny non-zero value) does not cause drift.
    if (axes.length > 0) {
      state.steer = this._applyDeadzone(axes[0]);
    }

    // throttle: right trigger analog value, or A button as a digital fallback.
    const rt = buttons[7] ? buttons[7].value : 0;
    const aBtn = buttons[0] ? buttons[0].pressed : false;
    state.throttle = rt || (aBtn ? 1 : 0);

    // brake: left trigger analog value, or B button as a digital fallback.
    const lt = buttons[6] ? buttons[6].value : 0;
    const bBtn = buttons[1] ? buttons[1].pressed : false;
    state.brake = lt || (bBtn ? 1 : 0);

    // drift: right bumper (RB).
    state.drift = buttons[5] ? buttons[5].pressed : false;

    // useItem: left bumper (LB).
    state.useItem = buttons[4] ? buttons[4].pressed : false;

    // lookBack: Y / triangle.
    state.lookBack = buttons[3] ? buttons[3].pressed : false;

    // overdrive: X / square (button 2) — the one free face button.
    state.overdrive = buttons[2] ? buttons[2].pressed : false;
  }

  // Applies a deadzone to an analog axis value so small resting noise reads
  // as exactly 0. Values outside the deadzone are passed through unchanged
  // and clamped to the -1..1 range.
  _applyDeadzone(value) {
    const DEADZONE = 0.15;

    if (Math.abs(value) < DEADZONE) {
      return 0;
    }

    // Clamp to the expected -1..1 range in case the pad reports slightly outside it.
    if (value > 1) return 1;
    if (value < -1) return -1;
    return value;
  }

  // Creates (once) the on-screen TouchControls and shows them. Called
  // automatically on touch devices from the constructor, but also safe to call
  // manually. `container` is the DOM element to attach the controls to
  // (defaults to document.body). Idempotent: a second call just re-shows them.
  enableTouch(container) {
    const target = container || document.body;
    if (!this.touch) {
      this.touch = new TouchControls(target);
    }
    this.touch.show();
    return this.touch;
  }

  // Hides the touch controls (if any) without destroying them.
  disableTouch() {
    if (this.touch && typeof this.touch.hide === 'function') {
      this.touch.hide();
    }
  }
}
