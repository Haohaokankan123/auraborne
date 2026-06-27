// src/ui/TouchControls.js
//
// On-screen TOUCH controls for phones and tablets (Milestone 6).
//
// Desktop players drive with the keyboard or a gamepad (see core/Input.js).
// Touch devices have neither, so this module draws virtual controls ON TOP of
// the 3D canvas and reports their pressed state the same way the keyboard does.
//
// LAYOUT (bottom of the screen, thumbs rest on the lower corners):
//   - LEFT  side: a STEER PAD (thumb-stick). Drag left/right inside it to steer.
//   - RIGHT side: a stack of round buttons:
//       ACCEL  (gas / throttle)
//       BRAKE  (reverse / brake)
//       DRIFT  (hop + drift)
//       ITEM   (use held item)
//
// PUBLIC API (mirrors the keyboard half of Input.getState()):
//   getState() -> { steer:-1..1, throttle:0..1, brake:0..1, drift:bool, useItem:bool }
//   show()  -> reveal the controls
//   hide()  -> hide the controls
//   isActive() -> true while at least one touch is currently on a control
//                 (Input uses this to decide whether touch should override keys)
//
// MULTITOUCH: every touch carries a unique `identifier`. We track each finger by
// its id so the player can hold ACCEL with one thumb while steering with the
// other. The steer pad and each button each remember which touch id "owns" them,
// and only release when THAT id ends.
//
// STYLING: the controls use inline styles (not Tailwind classes) so their exact
// size, position, and — most importantly — `pointer-events` behaviour is
// guaranteed regardless of what utility classes are or aren't loaded. The root
// overlay is pointer-events:none (taps pass through to the game) while each
// individual control re-enables pointer-events:auto so it can be pressed.

export class TouchControls {
  // container: the DOM element to attach the controls to (usually document.body).
  constructor(container) {
    this.container = container || document.body;

    // --- Live control state (read every frame by getState()). ----------------
    // steer is a continuous -1..1 from the thumb-stick; throttle/brake are 0..1.
    this._steer = 0;
    this._throttle = 0;
    this._brake = 0;
    this._drift = false;
    this._useItem = false;
    this._overdrive = false; // signature hook: spend a full overdrive meter

    // --- Touch ownership bookkeeping. ----------------------------------------
    // Which touch identifier currently controls the steer pad (null = none).
    this._steerTouchId = null;
    // The pixel x-coordinate of the steer pad's centre, captured on press, so
    // we can measure how far the finger has dragged left/right from it.
    this._steerCenterX = 0;
    // Half-width (px) that maps to full lock (steer = +/-1). Set from pad size.
    this._steerRadius = 60;

    // Map of touch identifier -> button key ('throttle'|'brake'|'drift'|'item')
    // for every finger currently holding a button. Lets multitouch release the
    // exact button a lifted finger was on.
    this._buttonTouches = new Map();

    // Build the DOM and wire the listeners.
    this._buildDom();
    this._attachListeners();

    // Hidden until a mode calls show() (Input auto-enables on touch devices).
    this.hide();
  }

  // -------------------------------------------------------------------------
  // DOM construction.
  // -------------------------------------------------------------------------
  _buildDom() {
    // Root overlay: full-screen, sits above the canvas, but lets taps fall
    // through EXCEPT where a real control re-enables pointer events.
    const root = document.createElement('div');
    root.id = 'touch-controls';
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '40', // above the canvas; HUD text can sit above or below freely
      pointerEvents: 'none', // taps pass through to the game by default
      userSelect: 'none',
      touchAction: 'none', // stop the browser scrolling/zooming on drag
      WebkitUserSelect: 'none',
      WebkitTapHighlightColor: 'transparent',
    });
    this.root = root;

    // ---- LEFT: steer pad (thumb-stick) -------------------------------------
    // A round base in the lower-left. A smaller "knob" inside it follows the
    // finger horizontally to show how far the player has steered.
    const pad = document.createElement('div');
    Object.assign(pad.style, {
      position: 'absolute',
      left: '24px',
      bottom: '24px',
      width: '160px',
      height: '160px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.08)',
      border: '2px solid rgba(255,255,255,0.35)',
      pointerEvents: 'auto', // this control IS pressable
      touchAction: 'none',
      boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
    });
    pad.dataset.role = 'steer';
    this.pad = pad;

    // The movable knob, centred to start.
    const knob = document.createElement('div');
    Object.assign(knob.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '72px',
      height: '72px',
      marginLeft: '-36px',
      marginTop: '-36px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.85)',
      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      pointerEvents: 'none', // the knob is decorative; the pad handles touches
      transition: 'transform 0.05s linear',
    });
    this.knob = knob;
    pad.appendChild(knob);
    root.appendChild(pad);

    // ---- RIGHT: action buttons --------------------------------------------
    // Helper that builds one round button and registers it.
    const makeButton = (role, label, color, extra) => {
      const btn = document.createElement('div');
      Object.assign(
        btn.style,
        {
          position: 'absolute',
          width: '88px',
          height: '88px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          fontWeight: '700',
          fontSize: '15px',
          color: '#fff',
          textShadow: '0 1px 2px rgba(0,0,0,0.6)',
          background: color,
          border: '2px solid rgba(255,255,255,0.6)',
          pointerEvents: 'auto',
          touchAction: 'none',
          boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
        },
        extra
      );
      btn.textContent = label;
      btn.dataset.role = role;
      root.appendChild(btn);
      return btn;
    };

    // ACCEL: big, bottom-right (primary thumb position).
    this.btnThrottle = makeButton('throttle', 'GAS', 'rgba(46,160,67,0.85)', {
      right: '24px',
      bottom: '40px',
      width: '110px',
      height: '110px',
      fontSize: '18px',
    });

    // BRAKE: left of / above accel.
    this.btnBrake = makeButton('brake', 'BRAKE', 'rgba(200,60,60,0.85)', {
      right: '150px',
      bottom: '40px',
    });

    // DRIFT: above accel.
    this.btnDrift = makeButton('drift', 'DRIFT', 'rgba(60,120,220,0.85)', {
      right: '40px',
      bottom: '160px',
    });

    // ITEM: above brake.
    this.btnItem = makeButton('item', 'ITEM', 'rgba(180,120,40,0.9)', {
      right: '160px',
      bottom: '160px',
    });

    // OVERDRIVE: top of the stack (cyan, the signature surge). Smaller so it reads
    // as the special move, sitting above the drift/item row.
    this.btnOverdrive = makeButton('overdrive', 'OD', 'rgba(34,211,238,0.9)', {
      right: '90px',
      bottom: '270px',
      width: '72px',
      height: '72px',
      fontSize: '16px',
    });

    // Quick lookups used when a touch starts on a button.
    this._buttons = [this.btnThrottle, this.btnBrake, this.btnDrift, this.btnItem, this.btnOverdrive];

    this.container.appendChild(root);
  }

  // -------------------------------------------------------------------------
  // Event wiring. We listen on the root (capturing all touches inside it) and
  // route each touch by which element it started on.
  // -------------------------------------------------------------------------
  _attachListeners() {
    // Bind once so we can add (and could later remove) the same references.
    this._onTouchStart = this._handleTouchStart.bind(this);
    this._onTouchMove = this._handleTouchMove.bind(this);
    this._onTouchEnd = this._handleTouchEnd.bind(this);

    // passive:false lets us call preventDefault() to stop scrolling/zooming.
    this.root.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.root.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.root.addEventListener('touchend', this._onTouchEnd, { passive: false });
    this.root.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
  }

  // A finger touched down. It may have landed on the steer pad or a button.
  _handleTouchStart(event) {
    // Only act on touches whose target is one of our controls.
    let handled = false;

    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      const target = touch.target;
      const role = target && target.dataset ? target.dataset.role : null;

      if (role === 'steer') {
        // Claim the steer pad for this finger and remember its centre x so we
        // can measure left/right drag distance from it.
        this._steerTouchId = touch.identifier;
        const rect = this.pad.getBoundingClientRect();
        this._steerCenterX = rect.left + rect.width / 2;
        this._steerRadius = rect.width / 2;
        this._updateSteerFromTouch(touch);
        handled = true;
      } else if (
        role === 'throttle' ||
        role === 'brake' ||
        role === 'drift' ||
        role === 'item' ||
        role === 'overdrive'
      ) {
        // Remember which button this finger holds, then set its state.
        this._buttonTouches.set(touch.identifier, role);
        this._setButtonState(role, true);
        this._setButtonPressedStyle(target, true);
        handled = true;
      }
    }

    if (handled) {
      event.preventDefault();
    }
  }

  // A finger moved. Only the steer pad cares about movement (buttons are
  // on/off). We update steering if the steer-owning finger moved.
  _handleTouchMove(event) {
    if (this._steerTouchId === null) {
      return;
    }

    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      if (touch.identifier === this._steerTouchId) {
        this._updateSteerFromTouch(touch);
        event.preventDefault();
        break;
      }
    }
  }

  // A finger lifted (or was cancelled). Release whatever it owned.
  _handleTouchEnd(event) {
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i];
      const id = touch.identifier;

      // Was this the steer finger? Recentre the stick.
      if (id === this._steerTouchId) {
        this._steerTouchId = null;
        this._steer = 0;
        this._setKnob(0);
      }

      // Was this finger holding a button? Release that exact button.
      if (this._buttonTouches.has(id)) {
        const role = this._buttonTouches.get(id);
        this._buttonTouches.delete(id);
        this._setButtonState(role, false);
        this._setButtonPressedStyle(this._buttonForRole(role), false);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Steering math.
  // -------------------------------------------------------------------------
  // Convert a touch's horizontal distance from the pad centre into a -1..1
  // steer value, clamp it, move the knob to match.
  _updateSteerFromTouch(touch) {
    const dx = touch.clientX - this._steerCenterX;
    // Normalize by the pad radius so the edge of the pad is full lock.
    let steer = dx / this._steerRadius;
    if (steer > 1) steer = 1;
    if (steer < -1) steer = -1;
    this._steer = steer;
    this._setKnob(steer);
  }

  // Slide the knob horizontally to mirror the steer value (visual feedback).
  _setKnob(steer) {
    // Move the knob up to ~40px from centre at full lock.
    const offset = steer * 40;
    this.knob.style.transform = `translateX(${offset}px)`;
  }

  // -------------------------------------------------------------------------
  // Button helpers.
  // -------------------------------------------------------------------------
  // Apply a button press/release to the matching state field. Throttle and
  // brake are analog elsewhere but binary here (held = full).
  _setButtonState(role, pressed) {
    if (role === 'throttle') this._throttle = pressed ? 1 : 0;
    else if (role === 'brake') this._brake = pressed ? 1 : 0;
    else if (role === 'drift') this._drift = pressed;
    else if (role === 'item') this._useItem = pressed;
    else if (role === 'overdrive') this._overdrive = pressed;
  }

  // Map a role string back to its button element (for press styling).
  _buttonForRole(role) {
    if (role === 'throttle') return this.btnThrottle;
    if (role === 'brake') return this.btnBrake;
    if (role === 'drift') return this.btnDrift;
    if (role === 'item') return this.btnItem;
    if (role === 'overdrive') return this.btnOverdrive;
    return null;
  }

  // Dim/brighten a button so the player sees it register the press.
  _setButtonPressedStyle(el, pressed) {
    if (!el) return;
    el.style.filter = pressed ? 'brightness(1.4)' : 'none';
    el.style.transform = pressed ? 'scale(0.94)' : 'none';
  }

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------
  // The current control state. Same field names/ranges as Input's keyboard half
  // (minus lookBack, which has no touch button — it stays whatever Input merges).
  getState() {
    return {
      steer: this._steer,
      throttle: this._throttle,
      brake: this._brake,
      drift: this._drift,
      useItem: this._useItem,
      overdrive: this._overdrive,
    };
  }

  // True while any finger is currently on a control. Input uses this to decide
  // whether touch input should override the keyboard this frame.
  isActive() {
    return this._steerTouchId !== null || this._buttonTouches.size > 0;
  }

  // Reveal the controls.
  show() {
    this.root.style.display = 'block';
  }

  // Hide the controls and clear any held state so nothing "sticks" while hidden.
  hide() {
    this.root.style.display = 'none';
    this._steerTouchId = null;
    this._buttonTouches.clear();
    this._steer = 0;
    this._throttle = 0;
    this._brake = 0;
    this._drift = false;
    this._useItem = false;
    this._overdrive = false;
    this._setKnob(0);
  }
}
