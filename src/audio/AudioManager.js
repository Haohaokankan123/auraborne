// src/audio/AudioManager.js
//
// AudioManager — a self-contained Web Audio API sound system for the racer.
//
// Everything here is SYNTHESIZED at runtime (oscillators + noise + gain
// envelopes). There are NO audio asset files anywhere in the project, so this
// class never loads or fetches anything — it builds every sound from scratch.
//
// Consumed by the game modes like this:
//
//   const audio = new AudioManager();
//   // ...on a real user gesture (key press / click):
//   audio.unlock();          // creates + resumes the AudioContext
//   audio.startEngine();     // begins the continuous engine drone
//   audio.startMusic();      // (optional) starts the looping arpeggio
//
//   // every frame, while racing:
//   audio.update(playerState, dt);   // pitches the engine to match speed
//
//   // one-shots, fired by the integrator when game events happen:
//   audio.sfxDrift(tier);    audio.sfxBoost();
//   audio.sfxItemPickup();   audio.sfxItemUse();
//   audio.sfxHit();          audio.sfxCoin();
//   audio.sfxCountdown(n);   audio.sfxFinish();
//
//   // when the race ends / mode tears down:
//   audio.stopEngine();      audio.stopMusic();
//
// Design rules:
//  - NEVER throw. If the Web Audio API is missing or a node fails, we degrade
//    silently so the game keeps running. Every public method is guarded.
//  - The AudioContext is created lazily, only on a user gesture, because
//    browsers block (or auto-suspend) audio created before the first gesture.
//  - Master volume + mute persist to localStorage so the player's preference
//    survives reloads.

// localStorage keys for persisted preferences.
const LS_VOLUME = 'mk_audio_volume';
const LS_MUTED = 'mk_audio_muted';

// Master headroom. Everything routes through the master gain, and the master
// gain itself is scaled by the user's volume preference. We multiply the
// user's 0..1 volume by this ceiling so that even at 100% the mix sits well
// below 0 dBFS — that headroom is what keeps layered SFX from clipping and
// keeps the whole game from ever sounding harsh. Lower number = gentler.
const MASTER_CEILING = 0.55;

// Tuning constants for the engine drone. Pulled out so they are easy to tweak.
// The engine is intentionally LOW and QUIET — a warm hum you feel more than
// hear, not a buzzing power tool. A triangle wave (mellow, few harmonics)
// runs through a low-pass filter, so the timbre is rounded rather than buzzy.
const ENGINE_IDLE_HZ = 62; // base pitch of the engine at a standstill (low hum)
const ENGINE_MAX_HZ = 188; // pitch the engine approaches at top speed (kept low
                           // so the climb is felt as "revving" not "screaming")
const ENGINE_REF_SPEED = 60; // speed (game units) treated as "full revs" for pitch
const ENGINE_IDLE_GAIN = 0.035; // engine loudness at idle (very soft)
const ENGINE_MAX_GAIN = 0.11; // engine loudness at speed (still gentle)
const ENGINE_GLIDE = 0.09; // seconds the pitch/gain take to glide to a new target
                           // (smoothing — stops zipper noise on sudden changes)

// Low-pass filter cutoff for the engine, in Hz. A warm motor lives down here;
// anything above this is rolled off so the tone never gets bright or fatiguing.
const ENGINE_FILTER_BASE_HZ = 520; // cutoff at idle (dark, rounded)
const ENGINE_FILTER_SWEEP_HZ = 260; // how much further the cutoff opens at full
                                    // revs (so it brightens *slightly* with speed
                                    // but never crosses into harsh territory)
const ENGINE_FILTER_Q = 1.4; // gentle resonance — adds a little "vocal" body
                             // around the cutoff without ringing or whistling

// While BOOSTING the engine "revs" beyond its normal top — pitch jumps up and
// the voice gets a touch louder + brighter, so a mushroom/mini-turbo feels like
// the motor screaming. These are *multipliers/adders* applied on top of the
// speed-driven target, ramped in/out so the rev itself glides.
const ENGINE_BOOST_HZ_MULT = 1.35; // pitch x1.35 at full boost (the "rev up")
const ENGINE_BOOST_GAIN_ADD = 0.05; // extra loudness while boosting
const ENGINE_BOOST_FILTER_ADD = 220; // extra cutoff (brighter) while boosting

// A subtle high-rev "growl" voice layered on top of the engine. It's a quiet
// square through the same filter that fades IN with speed/boost, adding the
// raspy top-end of a revving motor without ever dominating the warm base hum.
const ENGINE_GROWL_GAIN_MAX = 0.022; // peak loudness of the growl layer (very soft)

// Tremolo "throb" LFO: a low sine that gently amplitude-modulates the engine
// voice so the drone PULSES like a real motor firing instead of sitting on one
// dead tone. The RATE rises with revs (set in _driveEngine) so the throb
// quickens with speed; the DEPTH also grows with revs so idle stays smooth.
const ENGINE_THROB_MIN_HZ = 7;    // throb rate at idle (a slow lope)
const ENGINE_THROB_MAX_HZ = 34;   // throb rate near full revs (a fast flutter)
const ENGINE_THROB_DEPTH = 0.014; // peak gain swing the throb adds at full revs

// A surge in speed between frames bigger than this (game units) fires one quick
// "up-shift" chirp over the engine, punctuating a boost kick / hard launch.
const ENGINE_GEARSHIFT_DV = 2.4;

// 3 distinct, energetic music beds — one per track theme. Each bed is a tiny
// sequencer spec the music scheduler reads: a stepMs (tempo), a bass line, and
// a lead melody (both in Hz, looping independently). All notes sit in a major /
// pentatonic space so the loop stays upbeat and never grates. THEME -> bed:
//   'rainbow' -> bright & bouncy   'space' -> driving & synthy
//   'sky'     -> breezy & soaring
// selectTrackMusic() maps either a theme name OR a trackId onto one of these.
const MUSIC_BEDS = {
  // RAINBOW RIDGE — bright, bouncy major bounce in C. Fast eighth-note feel.
  rainbow: {
    stepMs: 250,
    // Walking bass: C2 G2 A2 G2 (root-fifth bounce).
    bass: [65.41, 98.0, 110.0, 98.0],
    // Cheery C-major pentatonic lead, longer than the bass so they phase.
    lead: [523.25, 659.25, 783.99, 659.25, 587.33, 659.25, 880.0, 783.99],
    lpHz: 2000,
  },
  // COSMIC SPEEDWAY — driving, synthy minor-pentatonic groove in A. Punchy.
  space: {
    stepMs: 220,
    // Pulsing root bass: A1 A1 E2 A1 (insistent, club-y).
    bass: [55.0, 55.0, 82.41, 55.0],
    // A-minor-pentatonic lead with an octave leap for energy.
    lead: [440.0, 523.25, 659.25, 587.33, 440.0, 659.25, 880.0, 659.25],
    lpHz: 2400,
  },
  // CLOUDTOP CIRCUIT — breezy, soaring major in G. A touch slower, airy.
  sky: {
    stepMs: 280,
    // Gentle bass: G2 D3 E3 D3.
    bass: [98.0, 146.83, 164.81, 146.83],
    // Soaring G-major pentatonic lead.
    lead: [587.33, 783.99, 880.0, 987.77, 880.0, 783.99, 659.25, 783.99],
    lpHz: 1800,
  },
};

// On the FINAL LAP the music tightens up: faster tempo + a pitch transpose so
// the whole bed feels urgent. These are applied on top of the selected bed.
const FINAL_LAP_TEMPO_MULT = 0.82; // stepMs x0.82 -> ~22% faster
const FINAL_LAP_PITCH_MULT = 1.0595; // up a semitone (12-TET) for tension

// Nominal music-bus level. Quiet by design (it sits UNDER gameplay). Pulled out
// so _duckMusic() can dip it toward silence on the big cues and restore exactly.
const MUSIC_BASE_GAIN = 0.05;

// Look-ahead music scheduler ("A Tale of Two Clocks"): we wake on a coarse JS
// timer and schedule any notes due within the look-ahead window directly on the
// precise audio clock, so the tempo stays rock-steady even when the main thread
// jitters (a bare setInterval drifts and stutters under load).
const MUSIC_LOOKAHEAD_S = 0.1; // schedule notes up to 100ms ahead
const MUSIC_TICK_MS = 25;      // wake the scheduler roughly every 25ms

export class AudioManager {
  constructor() {
    // The AudioContext is created lazily in unlock(); null until then.
    this.ctx = null;

    // Master gain node — every sound routes through this, so setVolume/mute
    // affect the whole mix with one node. Created with the context.
    this.master = null;

    // Soft limiter (DynamicsCompressor) sitting between the master gain and the
    // speakers. It tames peaks when many SFX overlap so the mix never clips.
    this.limiter = null;

    // Engine voice nodes (built on demand in startEngine()).
    this.engine = null; // { osc, sub, growl, growlGain, gain, filter, running }

    // Engine "rev" state set by setEngineState(): how far into the boost rev we
    // are (0..1, glided toward the boost flag) and the last speed/maxSpeed we
    // were told. update() (the legacy per-frame call) falls back to these.
    this._engineSpeed = 0;
    this._engineMaxSpeed = 44;
    this._engineBoost = 0; // 0..1, target is 1 while boosting

    // Continuous tyre-screech (skid) + off-road rumble loops. Each is ONE
    // persistent looping noise node whose GAIN is modulated (silent when idle),
    // not a per-frame burst — cheap and LOW-tier safe. Built lazily on first use,
    // torn down per race in stopEngine().
    this.skid = null;    // { src, filter, gain, active }
    this.offroad = null; // { src, filter, gain }

    // Gear-shift detection: the last speed _driveEngine saw + when we last
    // chirped, so a big speed surge fires at most one debounced "up-shift" tick.
    this._lastDriveSpeed = 0;
    this._lastGearShift = 0;

    // Music scheduler state (built on demand in startMusic()).
    this.music = null; // { gain, timer, bassStep, leadStep, running, bed, ... }

    // Which track bed to play. Defaults to the bright 'rainbow' bed. Set via
    // selectTrackMusic() before startMusic() to pick a per-track theme.
    this._musicBed = 'rainbow';

    // Final-lap tension flag. When true, startMusic()/the scheduler speed up the
    // tempo and transpose the bed up. Toggled by setFinalLap().
    this._finalLap = false;

    // Persisted preferences. Defaults: 70% volume, not muted.
    this.volume = this._loadVolume();
    this.muted = this._loadMuted();

    // True once we have successfully created a context at least once.
    this.unlocked = false;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle / unlocking
  // ---------------------------------------------------------------------------

  /**
   * Create the AudioContext (if needed) and resume it. MUST be called from a
   * real user gesture handler (keydown / click / touch) the first time, or the
   * browser will keep the context suspended and nothing will be audible.
   * Safe to call repeatedly — it just resumes an already-running context.
   * @returns {boolean} true if audio is now usable, false if unavailable.
   */
  unlock() {
    if (!this.ctx) {
      // Feature-detect. Some browsers only expose the webkit-prefixed name.
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        // No Web Audio support at all — give up gracefully, never throw.
        return false;
      }
      try {
        this.ctx = new AC();
      } catch (e) {
        // Context construction can fail (e.g. too many contexts). Degrade.
        this.ctx = null;
        return false;
      }

      // Build the master gain and wire it to the speakers (destination).
      // We don't connect the master straight to the destination — instead we
      // route it through a DynamicsCompressor acting as a soft limiter. When
      // several SFX stack on top of the engine + music, their summed amplitude
      // can exceed 1.0 and clip (a nasty crackle). The compressor catches those
      // peaks and squashes them gently so the mix stays clean and never harsh.
      this.master = this.ctx.createGain();
      // Master gain carries the user's volume scaled into our headroom ceiling,
      // so "100%" is still a comfortable, non-blaring level.
      this.master.gain.value = this.muted ? 0 : this.volume * MASTER_CEILING;

      const limiter = this.ctx.createDynamicsCompressor();
      // A limiter-style compressor: high threshold, high ratio, fast-ish attack,
      // smooth release. It only acts on the loudest transient peaks.
      limiter.threshold.value = -6;  // start gently compressing near -6 dBFS
      limiter.knee.value = 6;        // soft knee -> no abrupt "grab", smooth onset
      limiter.ratio.value = 12;      // strong ratio above threshold = limiting
      limiter.attack.value = 0.004;  // catch peaks quickly (4 ms)
      limiter.release.value = 0.18;  // let go smoothly so it "breathes" naturally

      this.master.connect(limiter);
      limiter.connect(this.ctx.destination);
      this.limiter = limiter;

      this.unlocked = true;
    }

    // Resume if the browser auto-suspended it. resume() returns a promise; we
    // swallow rejections so a failed resume never bubbles up.
    this.resume();
    return true;
  }

  /**
   * Resume a suspended context. Browsers suspend audio when the tab is hidden
   * or before the first gesture. Call this from gesture handlers and on
   * visibility changes. No-op (and never throws) if there is no context.
   */
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      // resume() is async and can reject; ignore the rejection.
      this.ctx.resume().catch(() => {});
    }
  }

  // Convenience: is the context live and ready to make sound?
  _ready() {
    return !!this.ctx && !!this.master;
  }

  // The audio clock "now". Used as the start time for all envelopes.
  _now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // ---------------------------------------------------------------------------
  // Master volume + mute (persisted)
  // ---------------------------------------------------------------------------

  /**
   * Set the master volume (0..1). Persists to localStorage. Applies instantly
   * unless muted (mute wins — volume is remembered but not heard).
   * @param {number} v desired volume, clamped to [0,1]
   */
  setVolume(v) {
    // Clamp so a bad value can never blow out the speakers or go negative.
    this.volume = Math.max(0, Math.min(1, Number(v) || 0));
    this._saveVolume(this.volume);
    this._applyMasterGain();
  }

  getVolume() {
    return this.volume;
  }

  /** Mute all audio (remembers the underlying volume). Persisted. */
  mute() {
    this.muted = true;
    this._saveMuted(true);
    this._applyMasterGain();
  }

  /** Unmute, restoring the previously set volume. Persisted. */
  unmute() {
    this.muted = false;
    this._saveMuted(false);
    this._applyMasterGain();
  }

  /** Flip mute on/off. Returns the new muted state. */
  toggleMute() {
    if (this.muted) this.unmute();
    else this.mute();
    return this.muted;
  }

  isMuted() {
    return this.muted;
  }

  // Push the current volume/mute state onto the master gain with a short ramp
  // (avoids an audible click when volume jumps).
  _applyMasterGain() {
    if (!this._ready()) return;
    // Scale by MASTER_CEILING so this matches the level unlock() set — otherwise
    // changing the volume slider would jump the mix louder than the headroom we
    // designed for and reintroduce clipping/harshness.
    const target = this.muted ? 0 : this.volume * MASTER_CEILING;
    const now = this._now();
    const g = this.master.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + 0.03);
    } catch (e) {
      // Some engines are picky about scheduling; fall back to a direct set.
      g.value = target;
    }
  }

  // ---------------------------------------------------------------------------
  // Engine drone — a continuous voice whose pitch/volume track player speed.
  // ---------------------------------------------------------------------------

  /**
   * Start the continuous engine sound. Idempotent — calling it twice does
   * nothing the second time. Call when a race begins (after unlock()).
   *
   * The engine is a warm triangle oscillator plus a sine sub one octave down
   * (a mellow main + low-end body, NOT a buzzy sawtooth) through a low-pass
   * filter, so the timbre is a rounded hum rather than a power-tool whine.
   * update() later modulates their frequency and the gain with speed.
   */
  startEngine() {
    if (!this._ready()) return;
    if (this.engine && this.engine.running) return;

    const ctx = this.ctx;

    // Main oscillator: triangle is mellow (few, fast-decaying harmonics) — it
    // reads as a warm motor hum instead of a harsh buzz.
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = ENGINE_IDLE_HZ;

    // Sub oscillator one octave below, slightly detuned, for low-end body. A
    // pure sine here adds weight with zero extra harshness.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = ENGINE_IDLE_HZ * 0.5;
    sub.detune.value = -8; // a few cents flat -> gentle beating, less sterile

    // Low-pass filter keeps the engine warm — everything above the cutoff is
    // rolled off so the tone never gets bright or fatiguing. update() opens the
    // cutoff slightly with revs so it brightens a touch at speed.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = ENGINE_FILTER_BASE_HZ;
    filter.Q.value = ENGINE_FILTER_Q;

    // Growl layer: a quiet square at the main pitch that fades IN with revs to
    // add the raspy top-end of a revving motor. It routes through the SAME warm
    // filter so it stays rounded, and through its own gain so we can swell it
    // independently of the base hum (silent at idle, audible at speed/boost).
    const growl = ctx.createOscillator();
    growl.type = 'square';
    growl.frequency.value = ENGINE_IDLE_HZ;
    const growlGain = ctx.createGain();
    growlGain.gain.value = 0.0001; // effectively silent at idle

    // Voice gain — starts at idle loudness; update() rides this with speed.
    const gain = ctx.createGain();
    gain.gain.value = ENGINE_IDLE_GAIN;

    // Tremolo LFO: a low sine -> small gain -> ADDED onto the voice gain's value,
    // so the drone pulses (a subtle "throb"). Its rate + depth rise with revs in
    // _driveEngine, so the throb quickens and deepens as the player speeds up.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = ENGINE_THROB_MIN_HZ;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = ENGINE_THROB_DEPTH * 0.45; // gentle at idle; grows with revs

    // Wire: hum oscillators -> filter; growl -> its own gain -> filter; then
    // filter -> voice gain -> master. The LFO modulates the voice gain's value.
    osc.connect(filter);
    sub.connect(filter);
    growl.connect(growlGain);
    growlGain.connect(filter);
    filter.connect(gain);
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    gain.connect(this.master);

    try {
      osc.start();
      sub.start();
      growl.start();
      lfo.start();
    } catch (e) {
      // If starting fails, bail out cleanly without an engine.
      return;
    }

    this.engine = { osc, sub, growl, growlGain, gain, filter, lfo, lfoGain, running: true };
  }

  /**
   * NEW preferred per-frame engine driver. Pitches AND swells the engine to the
   * player's speed, and *revs it up* (higher pitch + louder + brighter + a
   * raspy growl) while boosting. Call this every frame while racing.
   *
   * This supersedes update() but does NOT replace it — update() still works and
   * now simply forwards into the same internal modulation. Use whichever the
   * caller already has wired; prefer setEngineState for the boost rev.
   *
   * @param {number} speed     the player's current speed in game units (0..~75
   *                           including boost). Negative (reversing) is fine —
   *                           we use the magnitude.
   * @param {number} maxSpeed  the normal (non-boost) top speed, e.g. 44. Used as
   *                           the reference for "full revs"; speeds above it
   *                           (from boost) push the pitch past the normal max.
   * @param {boolean} boosting true while a mushroom / mini-turbo boost is active.
   */
  setEngineState(speed, maxSpeed, boosting) {
    // Remember the inputs so a stray update() call stays consistent, and so we
    // glide the boost rev between frames.
    this._engineSpeed = typeof speed === 'number' ? Math.abs(speed) : 0;
    this._engineMaxSpeed = (typeof maxSpeed === 'number' && maxSpeed > 1)
      ? maxSpeed : 44;
    // Glide the boost amount toward 0/1 so the rev itself eases in and out
    // instead of snapping (we step it per call; ENGINE_GLIDE smooths the audio).
    const boostTarget = boosting ? 1 : 0;
    this._engineBoost += (boostTarget - this._engineBoost) * 0.25;
    this._driveEngine(this._engineSpeed, this._engineMaxSpeed, this._engineBoost);
  }

  /**
   * Per-frame engine modulation. Reads the player's speed and glides the
   * engine pitch + loudness toward a target so faster = higher + louder.
   *
   * @param {Object} playerState the kart state; we read `.speed` (game units).
   *                             Missing/zero speed -> idle hum.
   * @param {number} dt          frame delta in seconds (currently unused for
   *                             the engine since we use the audio clock's own
   *                             time-constant glide, but kept in the signature
   *                             so modes can call update(state, dt) uniformly).
   */
  update(playerState, dt) {
    // Always cheap-exit if there is nothing to drive.
    if (!this._ready() || !this.engine || !this.engine.running) return;

    // Pull speed defensively — handle null state or missing field.
    const rawSpeed = playerState && typeof playerState.speed === 'number'
      ? Math.abs(playerState.speed)
      : 0;
    this._engineSpeed = rawSpeed;

    // Legacy callers don't pass a boost flag here. If a boostTimer is present on
    // the state we glide toward a rev; otherwise we ease the rev back out. This
    // keeps the old update(state, dt) call working AND boost-aware for free.
    const boostTarget = (playerState && (playerState.boostTimer || 0) > 0) ? 1 : 0;
    this._engineBoost += (boostTarget - this._engineBoost) * 0.25;

    // Reference "full revs" speed: prefer the maxSpeed setEngineState last saw,
    // else the module default. (ENGINE_REF_SPEED still anchors the legacy feel.)
    this._driveEngine(rawSpeed, this._engineMaxSpeed, this._engineBoost);
  }

  /**
   * Shared engine modulation used by BOTH update() and setEngineState(). Glides
   * the hum pitch/gain/filter and the growl layer toward targets derived from
   * speed (normalized against maxSpeed) and a 0..1 boost amount.
   */
  _driveEngine(rawSpeed, maxSpeed, boostAmt) {
    if (!this.engine || !this.engine.running) return;

    // Normalize speed to 0..1 against the reference "full revs" speed. We blend
    // the explicit maxSpeed with the legacy ENGINE_REF_SPEED so the old feel is
    // preserved while higher reported max speeds still read as "full revs".
    const ref = (maxSpeed && maxSpeed > 1) ? maxSpeed : ENGINE_REF_SPEED;
    const t = Math.max(0, Math.min(1, rawSpeed / ref));

    // Slight curve (t^0.85) makes the low-speed pitch climb feel responsive.
    const curve = Math.pow(t, 0.85);

    // Boost rev: pitch jumps up, voice gets louder + brighter, growl swells.
    const b = Math.max(0, Math.min(1, boostAmt || 0));
    const hzMult = 1 + (ENGINE_BOOST_HZ_MULT - 1) * b;

    const targetHz = (ENGINE_IDLE_HZ + (ENGINE_MAX_HZ - ENGINE_IDLE_HZ) * curve) * hzMult;
    const targetGain = ENGINE_IDLE_GAIN
      + (ENGINE_MAX_GAIN - ENGINE_IDLE_GAIN) * curve
      + ENGINE_BOOST_GAIN_ADD * b;
    const targetFilter = ENGINE_FILTER_BASE_HZ
      + ENGINE_FILTER_SWEEP_HZ * curve
      + ENGINE_BOOST_FILTER_ADD * b;
    // Growl fades in with revs and surges with boost (clamped to its ceiling).
    const targetGrowl = Math.max(
      0.0001,
      ENGINE_GROWL_GAIN_MAX * Math.min(1, curve * 0.7 + b * 0.6));

    // Throb: the tremolo quickens AND deepens with revs (idle stays smooth).
    const targetThrobHz = ENGINE_THROB_MIN_HZ
      + (ENGINE_THROB_MAX_HZ - ENGINE_THROB_MIN_HZ) * curve;
    const targetThrobDepth = ENGINE_THROB_DEPTH * (0.45 + 0.55 * curve);

    const now = this._now();
    const { osc, sub, growl, growlGain, gain, filter, lfo, lfoGain } = this.engine;

    // Gear-shift chirp: a clear speed surge between frames fires one debounced
    // up-shift tick layered over the rev. A cleared speed (race start / stop)
    // resets _lastDriveSpeed so the first acceleration ramp doesn't chirp.
    const dv = rawSpeed - this._lastDriveSpeed;
    this._lastDriveSpeed = rawSpeed;
    if (dv > ENGINE_GEARSHIFT_DV && (now - this._lastGearShift) > 0.12) {
      this._lastGearShift = now;
      this._gearShiftTick();
    }

    // setTargetAtTime glides exponentially toward the target with a time
    // constant (ENGINE_GLIDE). This smooths sudden speed jumps so the pitch
    // slides instead of stepping — no zipper noise, and it's frame-rate
    // independent (which is why dt isn't needed here).
    try {
      osc.frequency.setTargetAtTime(targetHz, now, ENGINE_GLIDE);
      sub.frequency.setTargetAtTime(targetHz * 0.5, now, ENGINE_GLIDE);
      if (growl) growl.frequency.setTargetAtTime(targetHz, now, ENGINE_GLIDE);
      gain.gain.setTargetAtTime(targetGain, now, ENGINE_GLIDE);
      if (growlGain) growlGain.gain.setTargetAtTime(targetGrowl, now, ENGINE_GLIDE);
      filter.frequency.setTargetAtTime(targetFilter, now, ENGINE_GLIDE);
      if (lfo) lfo.frequency.setTargetAtTime(targetThrobHz, now, ENGINE_GLIDE);
      if (lfoGain) lfoGain.gain.setTargetAtTime(targetThrobDepth, now, ENGINE_GLIDE);
    } catch (e) {
      // Ignore scheduling errors; engine just won't glide this frame.
    }
  }

  /**
   * A quick mechanical "up-shift" chirp layered over the engine when the player
   * surges (a boost kick / hard launch). A short muffled saw up-blip — it just
   * punctuates the rev, it isn't a melodic SFX. Fired (debounced) from
   * _driveEngine when the frame-to-frame speed jump exceeds ENGINE_GEARSHIFT_DV.
   */
  _gearShiftTick() {
    this._blip({ type: 'sawtooth', freq: 240, freqTo: 540, dur: 0.07, gain: 0.05, attack: 0.002, filterHz: 1200 });
  }

  /**
   * Stop and tear down the engine voice. Call when the race ends. Safe to call
   * when no engine is running.
   */
  stopEngine() {
    // Free the continuous skid / off-road loops too — they only live during a
    // race, and stopEngine() is the per-race audio teardown. Safe if none exist.
    this._stopLoops();
    if (!this.engine) return;
    const { osc, sub, growl, lfo, gain } = this.engine;
    const now = this._now();
    try {
      // Quick fade to avoid a click, then stop the oscillators shortly after.
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.08);
      osc.stop(now + 0.1);
      sub.stop(now + 0.1);
      if (growl) growl.stop(now + 0.1);
      if (lfo) lfo.stop(now + 0.1);
    } catch (e) {
      // If stopping fails we still drop our reference below.
    }
    this.engine = null;
    // Reset the rev so the next race starts from idle, not mid-boost.
    this._engineBoost = 0;
    this._engineSpeed = 0;
    this._lastDriveSpeed = 0; // so the next race's first accel doesn't gear-chirp
  }

  // ---------------------------------------------------------------------------
  // One-shot SFX. Each builds throwaway nodes, plays a short envelope, and the
  // nodes are garbage-collected once they finish (osc.stop frees them).
  // ---------------------------------------------------------------------------

  /**
   * Internal helper: route a finished voice into the master bus, OPTIONALLY
   * through a StereoPannerNode for a cheap spatial cue. `pan` in [-1,1] places
   * the sound left/right; null/undefined keeps it centered (no extra node). The
   * panner is the cheapest spatial node in Web Audio, so this is LOW-tier safe,
   * and we only build one when a pan is actually requested. Guarded for old
   * engines that lack createStereoPanner (falls back to centered).
   */
  _connectToMaster(node, pan = null) {
    if (pan != null && this.ctx && typeof this.ctx.createStereoPanner === 'function') {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p);
      p.connect(this.master);
    } else {
      node.connect(this.master);
    }
  }

  /**
   * Internal helper: play a single short tone with a percussive envelope.
   * @param {Object} opts
   *   type   oscillator waveform ('sine'|'square'|'sawtooth'|'triangle')
   *   freq   start frequency in Hz
   *   freqTo optional end frequency (a pitch sweep if given)
   *   dur    duration in seconds
   *   gain    peak gain (before master) of this blip
   *   delay   start offset in seconds from "now"
   *   attack  envelope attack time in seconds. Default 18 ms — long enough that
   *           the note eases in instead of CLICKING (instant attacks on square
   *           waves are exactly what made the old SFX harsh).
   *   filterHz optional low-pass cutoff (Hz). When given, the tone runs through
   *           a lowpass so its bright upper harmonics are rounded off — the
   *           single biggest factor in making a blip sound pleasant not piercing.
   *   pan     optional stereo pan in [-1,1] for a spatial cue (default centered).
   */
  _blip({ type = 'triangle', freq = 440, freqTo = null, dur = 0.15, gain = 0.25, delay = 0, attack = 0.018, filterHz = null, pan = null }) {
    if (!this._ready()) return;
    const ctx = this.ctx;
    const t0 = this._now() + delay;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqTo !== null) {
      // Exponential sweep needs strictly positive values; clamp away from 0.
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur);
    }

    const g = ctx.createGain();
    // Soft AD envelope: ease up over `attack` (no click), then exponential decay
    // to near-silence. exponentialRamp can't reach exactly 0, so we use a tiny
    // floor (0.0001) and stop the node afterwards.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    // Optional low-pass to tame harsh harmonics into a rounded, friendly tone.
    let tail = g;
    if (filterHz !== null) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = filterHz;
      osc.connect(g);
      g.connect(lp);
      tail = lp;
    } else {
      osc.connect(g);
    }
    this._connectToMaster(tail, pan);

    try {
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (e) {
      // Ignore — a failed blip just makes no sound.
    }
  }

  /**
   * Internal helper: a short burst of filtered white noise (for hits / drift
   * sparks). Builds a one-shot buffer of random samples and plays it once.
   * @param {Object} opts
   *   dur     duration in seconds
   *   gain    peak gain
   *   type    filter type ('highpass'|'lowpass'|'bandpass')
   *   freq    filter cutoff/center frequency
   *   delay   start offset in seconds
   *   pan     optional stereo pan in [-1,1] for a spatial cue (default centered).
   */
  _noise({ dur = 0.2, gain = 0.25, type = 'highpass', freq = 1000, delay = 0, pan = null }) {
    if (!this._ready()) return;
    const ctx = this.ctx;
    const t0 = this._now() + delay;

    // Fill a buffer with white noise (random samples in [-1, 1]).
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    // Filter shapes the noise: highpass = hissy spark, lowpass = thuddy impact.
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // fast decay

    src.connect(filter);
    filter.connect(g);
    this._connectToMaster(g, pan);

    try {
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    } catch (e) {
      // Ignore — a failed noise burst just makes no sound.
    }
  }

  // ---------------------------------------------------------------------------
  // Continuous loops — single persistent looping-noise voices (skid + off-road)
  // whose GAIN is ridden each frame. One node each (not a per-frame burst), so
  // they stay cheap and LOW-tier safe. Built lazily, freed in stopEngine().
  // ---------------------------------------------------------------------------

  /**
   * Build a persistent looping white-noise voice: src(loop) -> filter -> gain ->
   * master, started silent. Returns { src, filter, gain } or null on failure.
   */
  _makeNoiseLoop({ filterType = 'bandpass', freq = 1600, q = 1 }) {
    if (!this._ready()) return null;
    const ctx = this.ctx;
    // ~1s of white noise, looped — long enough that the loop period isn't audible.
    const frames = Math.max(1, Math.floor(ctx.sampleRate));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001; // silent until updateSkid()/setOffroad() rides it up

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    try {
      src.start();
    } catch (e) {
      return null;
    }
    return { src, filter, gain };
  }

  /**
   * Start the tyre-screech (skid) loop. Idempotent — builds the persistent node
   * once, then just marks it active so updateSkid() rides its gain up. Call on
   * the rising edge of a drift; updateSkid() each frame; stopSkid() when it ends.
   */
  startSkid() {
    if (!this._ready()) return;
    if (!this.skid) {
      // A focused bandpass so the noise reads as a tight tyre SCREECH, not hiss.
      const loop = this._makeNoiseLoop({ filterType: 'bandpass', freq: 1600, q: 2.6 });
      if (!loop) return;
      this.skid = { ...loop, active: false };
    }
    this.skid.active = true;
  }

  /**
   * Ride the skid loop's pitch + energy with speed and mini-turbo tier, so the
   * screech climbs as the kart slides faster AND brightens/loudens as the charge
   * builds toward release (telegraphing the boost). No-op unless skidding.
   * @param {number} speed the player's speed (game units)
   * @param {number} tier  mini-turbo charge tier 0..3
   */
  updateSkid(speed, tier) {
    if (!this.skid || !this.skid.active) return;
    const t = Math.max(0, Math.min(1, Math.abs(speed || 0) / 44));
    const lvl = Math.max(0, Math.min(3, tier | 0)) / 3; // 0..1
    // Center frequency climbs with speed and especially the charge tier so the
    // screech audibly rises as the mini-turbo builds.
    const centerHz = 1400 + 1200 * (0.45 * t + 0.55 * lvl);
    // Energy: present while sliding, louder/brighter as speed + tier build.
    const g = 0.04 + 0.05 * t + 0.045 * lvl;
    const now = this._now();
    try {
      this.skid.filter.frequency.setTargetAtTime(centerHz, now, 0.05);
      this.skid.gain.gain.setTargetAtTime(g, now, 0.05);
    } catch (e) {
      // Ignore scheduling errors; the screech just won't track this frame.
    }
  }

  /** Stop the skid screech (ramp it to silence). Keeps the node for re-use. */
  stopSkid() {
    if (!this.skid) return;
    this.skid.active = false;
    const now = this._now();
    try {
      this.skid.gain.gain.setTargetAtTime(0.0001, now, 0.06);
    } catch (e) {
      // Ignore.
    }
  }

  /**
   * Drive the off-road rumble loop: a low, gritty lowpassed-noise voice that
   * swells with speed while the kart is on a rough surface (grass/dirt), and
   * silent on the track. Level-driven (called every frame) — built lazily the
   * first time the player actually leaves the road, then ridden to silence.
   * @param {boolean} active true while off the racing surface
   * @param {number}  speed  the player's speed (game units)
   */
  setOffroad(active, speed) {
    if (!this._ready()) return;
    if (!active && !this.offroad) return; // never built one, nothing off-road yet
    if (!this.offroad) {
      const loop = this._makeNoiseLoop({ filterType: 'lowpass', freq: 320, q: 0.8 });
      if (!loop) return;
      this.offroad = loop;
    }
    const t = Math.max(0, Math.min(1, Math.abs(speed || 0) / 44));
    // Rumble swells with speed off-road; the cutoff opens a touch so faster =
    // grittier (≈200-500Hz). On the road the gain rides back down to silence.
    const g = active ? (0.03 + 0.11 * t) : 0.0001;
    const cutoff = 200 + 300 * t;
    const now = this._now();
    try {
      this.offroad.gain.gain.setTargetAtTime(Math.max(0.0001, g), now, 0.08);
      this.offroad.filter.frequency.setTargetAtTime(cutoff, now, 0.08);
    } catch (e) {
      // Ignore.
    }
  }

  /** Stop + free both continuous loops. Called from stopEngine()/dispose(). */
  _stopLoops() {
    for (const loop of [this.skid, this.offroad]) {
      if (!loop) continue;
      try {
        loop.src.stop();
      } catch (e) {
        // Ignore — already stopped or never started.
      }
    }
    this.skid = null;
    this.offroad = null;
  }

  /**
   * Drift CHARGE crackle. Tier 0..3 (mini-turbo charge level): a short rising
   * spark whose pitch + energy climb with the tier, so each tier-up "cracks"
   * higher — the audible build toward the boost release. Fired when a mini-turbo
   * tier increases mid-drift.
   *
   * NOTE: sfxDrift(tier) is kept as an alias of this so existing callers (and
   * main.js) keep working unchanged.
   * @param {number} tier 0..3
   */
  driftCharge(tier = 1) {
    if (!this._ready()) return;
    const lvl = Math.max(0, Math.min(3, tier | 0));
    // Higher tiers sit higher in pitch and a touch louder — escalating "crackle".
    // A tight highpass-noise spark + a quick rising blip "tick" so the charge
    // reads as crackling sparks rather than just a hiss.
    const freq = 1800 + lvl * 900;
    this._noise({ dur: 0.12, gain: 0.12 + lvl * 0.03, type: 'highpass', freq });
    // A bright upward tick layered on top — climbs with tier for the "charging".
    this._blip({
      type: 'triangle',
      freq: 900 + lvl * 220,
      freqTo: 1300 + lvl * 320,
      dur: 0.09,
      gain: 0.06 + lvl * 0.02,
      attack: 0.004,
      filterHz: 3600,
    });
  }

  /** Backwards-compatible alias for driftCharge() (old call sites use this). */
  sfxDrift(tier = 1) {
    this.driftCharge(tier);
  }

  /**
   * Drift RELEASE whoosh — the satisfying "fwoosh" when a charged mini-turbo
   * fires and the boost kicks in. A rising warm swell + an airy noise puff.
   *
   * NOTE: sfxBoost() is kept as an alias of this so existing callers keep working.
   */
  driftRelease() {
    if (!this._ready()) return;
    // Warm triangle swell (was a harsh sawtooth) + a soft airy puff, with a
    // brighter top-tick so the release "pops" a little more than the old boost.
    this._blip({ type: 'triangle', freq: 220, freqTo: 760, dur: 0.3, gain: 0.2, filterHz: 1800 });
    this._blip({ type: 'triangle', freq: 520, freqTo: 1180, dur: 0.22, gain: 0.1, attack: 0.005, filterHz: 3200 });
    this._noise({ dur: 0.3, gain: 0.1, type: 'bandpass', freq: 900 });
  }

  /** Backwards-compatible alias for driftRelease() (old call sites use this). */
  sfxBoost() {
    this.driftRelease();
  }

  /** Item box pickup — a friendly two-note rising "bloop". */
  sfxItemPickup() {
    if (!this._ready()) return;
    // Rounded triangle tones through a low-pass — soft, not a bleepy square.
    this._blip({ type: 'triangle', freq: 660, dur: 0.1, gain: 0.18, filterHz: 2200 });
    this._blip({ type: 'triangle', freq: 990, dur: 0.14, gain: 0.18, delay: 0.1, filterHz: 2600 });
  }

  /**
   * Item used / fired — a quick downward "pew". Optionally pass the item id so
   * different items get a distinct flavour: heavier "thunk" for shells, a softer
   * launch for banana, a bright zap for lightning, an energetic swirl for star.
   * Unknown / no id falls back to the generic pew, so old callers (sfxItemUse())
   * still work unchanged.
   * @param {string} [id] optional item id (e.g. 'shell','banana','lightning','star','mushroom')
   */
  sfxItemUse(id) {
    if (!this._ready()) return;
    switch (id) {
      case 'shell':
      case 'greenShell':
      case 'redShell':
        // Firm forward "thwip" — a snappier descending tone.
        this._blip({ type: 'triangle', freq: 900, freqTo: 360, dur: 0.16, gain: 0.2, attack: 0.006, filterHz: 2400 });
        this._noise({ dur: 0.1, gain: 0.06, type: 'bandpass', freq: 1400 });
        return;
      case 'banana':
        // Soft, comedic low "plop" dropped behind you.
        this._blip({ type: 'sine', freq: 360, freqTo: 150, dur: 0.18, gain: 0.18, filterHz: 1400 });
        return;
      case 'lightning':
        // Bright crackling zap — fast downward sweep + hissy spark.
        this._blip({ type: 'triangle', freq: 2200, freqTo: 520, dur: 0.26, gain: 0.16, attack: 0.003, filterHz: 5000 });
        this._noise({ dur: 0.22, gain: 0.12, type: 'highpass', freq: 3200 });
        return;
      case 'star':
        // Energetic ascending swirl — a quick three-note flourish.
        this._blip({ type: 'triangle', freq: 660, dur: 0.08, gain: 0.16, attack: 0.005, filterHz: 3200 });
        this._blip({ type: 'triangle', freq: 880, dur: 0.08, gain: 0.16, delay: 0.06, attack: 0.005, filterHz: 3400 });
        this._blip({ type: 'triangle', freq: 1180, dur: 0.12, gain: 0.16, delay: 0.12, attack: 0.005, filterHz: 3800 });
        return;
      case 'mushroom':
        // Quick warm "boing" up — handing off to the boost feel.
        this._blip({ type: 'triangle', freq: 420, freqTo: 980, dur: 0.18, gain: 0.18, attack: 0.005, filterHz: 2600 });
        return;
      default:
        // Generic launch "pew" (the original sound).
        this._blip({ type: 'triangle', freq: 820, freqTo: 300, dur: 0.18, gain: 0.2, filterHz: 2000 });
    }
  }

  /**
   * Getting HIT / spun out (shell / bump / spin-out) — a soft low impact thud
   * plus a dizzy descending "wobble" so a spin-out reads as comedic, not just a
   * dull bump.
   */
  sfxHit() {
    if (!this._ready()) return;
    // Lowpassed noise thud (no buzzy fizz) + a rounded sine drop (not a square).
    this._noise({ dur: 0.24, gain: 0.22, type: 'lowpass', freq: 380 });
    this._blip({ type: 'sine', freq: 300, freqTo: 90, dur: 0.26, gain: 0.18 });
    // Dizzy "wobble" tail — two quick descending warbles for the spin.
    this._blip({ type: 'triangle', freq: 520, freqTo: 360, dur: 0.12, gain: 0.1, delay: 0.06, filterHz: 1800 });
    this._blip({ type: 'triangle', freq: 420, freqTo: 240, dur: 0.14, gain: 0.09, delay: 0.2, filterHz: 1600 });
  }

  /**
   * Kart-kart CRASH thud — a dull, low body-on-body knock for a bump/side-swipe,
   * scaled by impact (0 graze .. 1 hard hit). Deliberately distinct from sfxHit
   * (the dizzy spin-out warble): just a short lowpassed thump + a low sine knock,
   * no fizz or warble, so a crash sounds like contact, not getting shelled.
   * @param {number} [impact=0.5] scales loudness + thump weight.
   * @param {number} [pan=null] optional stereo pan in [-1,1] — used to place a
   *   REMOTE blast/impact (an item strike on another racer) in the stereo field;
   *   the player's own crash is left centered (it has no meaningful direction).
   */
  sfxBump(impact = 0.5, pan = null) {
    if (!this._ready()) return;
    const i = Math.max(0, Math.min(1, impact));
    const g = 0.1 + 0.22 * i; // graze stays soft; a hard crash hits ~0.32
    this._noise({ dur: 0.12 + 0.06 * i, gain: g, type: 'lowpass', freq: 240, pan });
    this._blip({ type: 'sine', freq: 180, freqTo: 70, dur: 0.14 + 0.05 * i, gain: g * 0.9, attack: 0.002, pan });
  }

  /**
   * Balloon POP (Battle) — a short, punchy burst: a snappy down-blip plus a tight
   * noise crack, so popping a balloon lands with a satisfying "pop!". Kept brief
   * and bright (but low-pass rounded) so a busy free-for-all never gets harsh.
   */
  sfxPop() {
    if (!this._ready()) return;
    // Snappy pitch-down "pop" tick + a tight noise crack for the burst.
    this._blip({ type: 'triangle', freq: 1300, freqTo: 420, dur: 0.1, gain: 0.2, attack: 0.002, filterHz: 3600 });
    this._noise({ dur: 0.07, gain: 0.14, type: 'bandpass', freq: 2200 });
  }

  /** Coin / collectible — a bright but soft short "ting". */
  sfxCoin() {
    if (!this._ready()) return;
    this._blip({ type: 'triangle', freq: 1320, dur: 0.07, gain: 0.15, attack: 0.008, filterHz: 3500 });
    this._blip({ type: 'triangle', freq: 1760, dur: 0.13, gain: 0.15, delay: 0.06, attack: 0.008, filterHz: 4000 });
  }

  /**
   * Lap complete — a quick two-note "ding-ding" up a fifth. A crisp lap marker,
   * deliberately SHORTER + simpler than the 4-note finish fanfare so crossing the
   * line each lap reads as "another lap down" without stealing the finish moment.
   */
  sfxLap() {
    if (!this._ready()) return;
    // A5 -> E6 (a perfect fifth): bright, snappy, two ascending dings.
    this._blip({ type: 'triangle', freq: 880, dur: 0.1, gain: 0.17, attack: 0.004, filterHz: 3800 });
    this._blip({ type: 'triangle', freq: 1318.5, dur: 0.16, gain: 0.17, delay: 0.08, attack: 0.004, filterHz: 4200 });
  }

  /**
   * Incoming-THREAT alert — an urgent two-tone "beep-beep" warning that a homing
   * projectile is closing on the player. Deliberately distinct from sfxHit (the
   * impact itself): a tight high double-beep that reads as "look out", not "ow".
   */
  sfxThreat() {
    if (!this._ready()) return;
    // Two identical short high beeps — the universal "alert" shape. Kept modest
    // in level since it fires the moment a threat appears, not on contact.
    this._blip({ type: 'triangle', freq: 1180, dur: 0.09, gain: 0.13, attack: 0.003, filterHz: 4200 });
    this._blip({ type: 'triangle', freq: 1180, dur: 0.11, gain: 0.13, delay: 0.13, attack: 0.003, filterHz: 4200 });
  }

  /**
   * Countdown beep. Pass the count (3, 2, 1) for the low "ready" beeps and 0
   * for the high "GO!" beep. Pitch rises as the count falls.
   * @param {number} n 3 | 2 | 1 for the build-up, 0 for GO
   */
  sfxCountdown(n) {
    if (!this._ready()) return;
    if (n === 0) {
      // GO! — a brighter, longer beep, but rounded (triangle + low-pass), and
      // a soft octave below it for a fuller, more musical "go" chime.
      this._blip({ type: 'triangle', freq: 880, dur: 0.4, gain: 0.24, filterHz: 3000 });
      this._blip({ type: 'sine', freq: 440, dur: 0.4, gain: 0.12 });
    } else {
      // 3,2,1 — soft mid beeps that climb slightly each step (no square buzz).
      const freq = 440 + (3 - Math.max(1, n)) * 60;
      this._blip({ type: 'triangle', freq, dur: 0.2, gain: 0.2, filterHz: 2400 });
    }
  }

  /** Race finish — a short triumphant ascending arpeggio fanfare. */
  sfxFinish() {
    if (!this._ready()) return;
    // Duck the music under the fanfare so the celebration rings out clearly.
    this._duckMusic(0.55, 0.85);
    // C5, E5, G5, C6 — a major arpeggio, each note staggered for a fanfare.
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      this._blip({ type: 'triangle', freq: f, dur: 0.26, gain: 0.2, delay: i * 0.12, filterHz: 3200 });
    });
  }

  /**
   * AIR-TRICK whoosh (signature hook) — an airy rising riser played when the
   * player starts working a mid-air trick: a soft upward tone + a bandpass noise
   * sweep, distinct from the drift release so a trick reads as "in the air".
   */
  sfxTrickWhoosh() {
    if (!this._ready()) return;
    this._blip({ type: 'sine', freq: 360, freqTo: 1120, dur: 0.34, gain: 0.1, attack: 0.02, filterHz: 2600 });
    this._noise({ dur: 0.32, gain: 0.07, type: 'bandpass', freq: 1600 });
  }

  /**
   * AIR-TRICK clean-landing chime (signature hook) — a bright three-note sparkle
   * that rewards banking a trick on touchdown. Brighter + more "ding!" than
   * driftRelease so a trick boost feels like its own special payoff.
   */
  sfxTrickLand() {
    if (!this._ready()) return;
    this._blip({ type: 'triangle', freq: 880, dur: 0.1, gain: 0.18, attack: 0.004, filterHz: 4200 });
    this._blip({ type: 'triangle', freq: 1320, dur: 0.16, gain: 0.18, delay: 0.07, attack: 0.004, filterHz: 4600 });
    this._blip({ type: 'triangle', freq: 1760, dur: 0.2, gain: 0.14, delay: 0.14, attack: 0.004, filterHz: 5000 });
  }

  /**
   * OVERDRIVE activation roar (signature hook) — a deep, powerful swell when the
   * player spends a full overdrive meter: a low rising tone + a sub thump + a
   * lowpassed rush. The beefiest cue in the kit, for the game's biggest moment.
   */
  sfxOverdrive() {
    if (!this._ready()) return;
    // The beefiest cue in the kit — duck the music hardest so the roar dominates.
    this._duckMusic(0.65, 0.7);
    this._blip({ type: 'triangle', freq: 120, freqTo: 320, dur: 0.5, gain: 0.26, attack: 0.01, filterHz: 1400 });
    this._blip({ type: 'sine', freq: 60, freqTo: 150, dur: 0.55, gain: 0.2, attack: 0.01 });
    this._noise({ dur: 0.4, gain: 0.12, type: 'lowpass', freq: 600 });
  }

  // ---------------------------------------------------------------------------
  // Background music — a gentle looping synth arpeggio, low and unobtrusive.
  // ---------------------------------------------------------------------------

  /**
   * Pick which track's music bed plays. Accepts either a THEME name
   * ('rainbow' | 'space' | 'sky') or a trackId — anything that isn't a known
   * theme is mapped onto a bed by a tiny lookup so the caller can pass the
   * trackId directly without knowing the theme. Call BEFORE startMusic() (or
   * call it then restartMusic via stop/start) to switch beds when a race starts.
   * @param {string} themeOrTrackId 'rainbow'|'space'|'sky' or a trackId
   */
  selectTrackMusic(themeOrTrackId) {
    // Map common trackIds onto themes so callers can pass either. Unknown values
    // fall back to the bright 'rainbow' bed (never throws, always picks a bed).
    const TRACK_TO_THEME = {
      circuit: 'rainbow',
      oval: 'space',
      figure: 'sky',
    };
    let bed = themeOrTrackId;
    if (!MUSIC_BEDS[bed]) {
      bed = TRACK_TO_THEME[themeOrTrackId] || 'rainbow';
    }
    this._musicBed = bed;
    // If music is already playing, swap to the new bed live by restarting it so
    // the change takes effect immediately (cheap; teardown fades, restart begins).
    if (this.music && this.music.running) {
      this.stopMusic();
      this.startMusic();
    }
  }

  /**
   * Final-lap tension toggle. When true, the music tempo tightens and the bed is
   * transposed up a semitone for urgency. Applies live if music is playing.
   * @param {boolean} on true on the final lap, false to relax back
   */
  setFinalLap(on) {
    const next = !!on;
    if (next === this._finalLap) return;
    this._finalLap = next;
    if (this.music && this.music.running) {
      // Re-arm the scheduler at the new tempo (pitch is read per-note, so it
      // takes effect on the next notes immediately either way).
      this._restartMusicTimer();
    }
  }

  /**
   * Start the looping background music for the selected track bed. Idempotent.
   * Low volume by design so it sits under the engine and SFX without annoying.
   *
   * Implementation: a JS setInterval steps a sequencer that plays a BASS note
   * and a LEAD note per step (two independent looping lines from the bed) into a
   * dedicated music gain bus -> low-pass -> master. Pentatonic/major beds keep
   * the endless loop easy on the ears; the final-lap flag tightens tempo + pitch.
   */
  startMusic() {
    if (!this._ready()) return;
    if (this.music && this.music.running) return;

    // Dedicated low-level gain bus for music -> low-pass -> master. The low-pass
    // rounds off the upper harmonics of every note so the loop sounds soft and
    // warm (a music box / soft synth pad), never bright or repetitive-grating.
    const bed = MUSIC_BEDS[this._musicBed] || MUSIC_BEDS.rainbow;
    const gain = this.ctx.createGain();
    gain.gain.value = MUSIC_BASE_GAIN; // intentionally quiet — it sits UNDER gameplay
    const warmth = this.ctx.createBiquadFilter();
    warmth.type = 'lowpass';
    warmth.frequency.value = bed.lpHz;
    warmth.Q.value = 0.4;
    gain.connect(warmth);
    warmth.connect(this.master);

    const state = {
      gain,
      warmth,
      timer: null,
      bassStep: 0,
      leadStep: 0,
      running: true,
      bed,
      // Audio-clock time of the next step to schedule (look-ahead scheduler).
      nextNoteTime: this._now(),
    };

    this.music = state;

    // Arm the look-ahead scheduler, then prime the first window immediately so
    // there's no silent gap before the loop starts.
    this._restartMusicTimer();
    this._musicScheduler();
  }

  // (Re)arm the look-ahead scheduler's wake timer. The note TEMPO is read live in
  // _musicScheduler() (so the final-lap multiplier just applies to the next notes
  // scheduled), which is why this only needs re-calling on start. setFinalLap()
  // still calls it to re-establish a timer after a stop, harmlessly.
  _restartMusicTimer() {
    if (!this.music) return;
    if (this.music.timer) clearInterval(this.music.timer);
    this.music.timer = setInterval(() => this._musicScheduler(), MUSIC_TICK_MS);
  }

  // Look-ahead scheduler tick ("two-clock"): schedule every note due within the
  // look-ahead window directly on the precise audio clock, advancing nextNoteTime
  // by the CURRENT step length (so a final-lap tempo change takes effect on the
  // next notes). Stays steady even when the JS timer jitters under load.
  _musicScheduler() {
    if (!this._ready() || !this.music || !this.music.running) return;
    const m = this.music;
    const baseMs = m.bed.stepMs;
    const stepSec = Math.max(0.06, (baseMs * (this._finalLap ? FINAL_LAP_TEMPO_MULT : 1)) / 1000);
    const now = this._now();
    // If a stall (e.g. a hidden tab throttling timers) left nextNoteTime in the
    // past, snap it to now so we don't dump a backlog of overlapping notes.
    if (m.nextNoteTime < now) m.nextNoteTime = now;
    const horizon = now + MUSIC_LOOKAHEAD_S;
    while (m.nextNoteTime < horizon) {
      this._musicStep(m.nextNoteTime);
      m.nextNoteTime += stepSec;
    }
  }

  // Play one sequencer step at audio-clock time `when`: a bass note + a lead note
  // from the current bed.
  _musicStep(when) {
    if (!this._ready() || !this.music) return;
    const m = this.music;
    const bed = m.bed;
    // Per-final-lap pitch transpose (semitone up) for tension. Read per-step so
    // toggling setFinalLap() takes effect on the very next notes.
    const pitch = this._finalLap ? FINAL_LAP_PITCH_MULT : 1;

    // BASS line (its own loop) — short, warm, sits low under everything.
    const bassFreq = bed.bass[m.bassStep % bed.bass.length] * pitch;
    m.bassStep++;
    this._musicVoice(bassFreq, { type: 'triangle', dur: 0.42, peak: 0.5, sub: false, when });

    // LEAD line (its own, longer loop so the two phase against each other).
    const leadFreq = bed.lead[m.leadStep % bed.lead.length] * pitch;
    m.leadStep++;
    this._musicVoice(leadFreq, { type: 'triangle', dur: 0.5, peak: 0.42, sub: true, when });
  }

  /**
   * Play one soft music note into the music bus. Used by _musicStep() for both
   * the bass and the lead. A triangle lead (mellow) with an optional sine sub an
   * octave below for body; soft swell-and-fade envelope so notes never click.
   */
  _musicVoice(freq, { type = 'triangle', dur = 0.5, peak = 0.45, sub = true, when = null } = {}) {
    if (!this._ready() || !this.music) return;
    const ctx = this.ctx;
    const m = this.music;
    // Start at the scheduled audio-clock time when given (look-ahead scheduler),
    // else right now (defensive fallback for any direct caller).
    const t0 = when != null ? when : this._now();

    const osc = ctx.createOscillator();
    osc.type = type; // triangle is mellow, flute-like — softer than sawtooth
    osc.frequency.value = freq;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(m.gain);

    let subOsc = null;
    let subG = null;
    if (sub) {
      // A quiet sine one octave below adds gentle body/warmth under the lead
      // without muddying it — like a soft pad supporting the melody note.
      subOsc = ctx.createOscillator();
      subOsc.type = 'sine';
      subOsc.frequency.value = freq * 0.5;
      subG = ctx.createGain();
      subG.gain.setValueAtTime(0.0001, t0);
      subG.gain.exponentialRampToValueAtTime(peak * 0.45, t0 + 0.06);
      subG.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      subOsc.connect(subG);
      subG.connect(m.gain);
    }

    try {
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
      if (subOsc) {
        subOsc.start(t0);
        subOsc.stop(t0 + dur + 0.02);
      }
    } catch (e) {
      // Ignore a failed note.
    }
  }

  /**
   * Briefly DUCK the music under a big one-shot so the cue cuts through, then
   * restore it. `amount` (0..1) is how far toward silence to dip; `dur` is the
   * total seconds before it's back at full level. No-op when music isn't playing.
   * @param {number} amount fraction to duck (0 = none, 1 = full silence)
   * @param {number} dur    seconds until the music is restored to base level
   */
  _duckMusic(amount = 0.5, dur = 0.6) {
    if (!this.music || !this.music.running) return;
    const a = Math.max(0, Math.min(1, amount));
    const ducked = Math.max(0.0001, MUSIC_BASE_GAIN * (1 - a));
    const now = this._now();
    const g = this.music.gain.gain;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(ducked, now + 0.04); // quick dip
      g.linearRampToValueAtTime(MUSIC_BASE_GAIN, now + Math.max(0.1, dur)); // ease back
    } catch (e) {
      // Ignore — ducking is best-effort polish.
    }
  }

  /** Stop and tear down the background music. Safe if not playing. */
  stopMusic() {
    if (!this.music) return;
    if (this.music.timer) clearInterval(this.music.timer);
    const m = this.music;
    m.running = false;
    const now = this._now();
    try {
      // Fade the music bus out smoothly before dropping it.
      m.gain.gain.cancelScheduledValues(now);
      m.gain.gain.setValueAtTime(m.gain.gain.value, now);
      m.gain.gain.linearRampToValueAtTime(0, now + 0.2);
    } catch (e) {
      // Ignore.
    }
    this.music = null;
  }

  /**
   * Toggle background music on/off. Returns the new state (true = now playing).
   */
  toggleMusic() {
    if (this.music && this.music.running) {
      this.stopMusic();
      return false;
    }
    this.startMusic();
    return !!(this.music && this.music.running);
  }

  isMusicPlaying() {
    return !!(this.music && this.music.running);
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  /**
   * Fully tear down all audio: stop engine + music and close the context.
   * After dispose() you must call unlock() again to use the manager. Never
   * throws.
   */
  dispose() {
    this.stopEngine();
    this.stopMusic();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch (e) {
        // Ignore close errors.
      }
    }
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.unlocked = false;
  }

  // ---------------------------------------------------------------------------
  // localStorage persistence helpers (all guarded — localStorage can throw in
  // private-mode / sandboxed iframes, so every access is wrapped).
  // ---------------------------------------------------------------------------

  _loadVolume() {
    try {
      const raw = localStorage.getItem(LS_VOLUME);
      if (raw === null) return 0.7; // sensible default
      const v = parseFloat(raw);
      return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7;
    } catch (e) {
      return 0.7;
    }
  }

  _saveVolume(v) {
    try {
      localStorage.setItem(LS_VOLUME, String(v));
    } catch (e) {
      // Ignore — persistence is best-effort.
    }
  }

  _loadMuted() {
    try {
      return localStorage.getItem(LS_MUTED) === '1';
    } catch (e) {
      return false;
    }
  }

  _saveMuted(m) {
    try {
      localStorage.setItem(LS_MUTED, m ? '1' : '0');
    } catch (e) {
      // Ignore.
    }
  }
}

export default AudioManager;
