// scripts/tune-battle.mjs — HEADLESS battle pop-rate harness.
//
// Runs full bot-only battles (opts.botPlayer drives the "player" record too, so
// all 8 karts are AI) straight in Node — Battle.update() is pure sim (THREE
// meshes build fine without a renderer; audio/hud/vfx are null-guarded) — and
// reports per-AI pop (score) statistics. This is how the 40-80 pops-per-AI
// (solo) and 20-40 (couch, AI_INTENSITY 0.5) targets are MEASURED, not guessed.
//
// Usage:
//   node scripts/tune-battle.mjs [matches] [tuningJSON]
//   node scripts/tune-battle.mjs 10 '{"AI_INTENSITY":0.5}'
//
// Prints a per-match table + a JSON summary line (machine-readable: the tuning
// workflow parses `SUMMARY {...}`).

// HEADLESS DOM STUB: Arena/Kart paint procedural canvas textures via
// document.createElement('canvas'). Nothing renders here, so an "anything
// proxy" (every property access/call returns itself; width/height numeric)
// satisfies the 2D-context calls without a real canvas. Installed BEFORE
// Battle is imported (dynamic import below) in case anything runs at load.
function anyProxy() {
  const fn = function () {};
  const proxy = new Proxy(fn, {
    get: (t, p) => {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'width' || p === 'height') return 256;
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}
globalThis.document = {
  createElement: () => anyProxy(),
  createElementNS: () => anyProxy(),
};
globalThis.window = globalThis.window || { devicePixelRatio: 1 };

const { Battle } = await import('../src/modes/Battle.js');

const matches = Number(process.argv[2] || 10);
const overrides = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const DT = 1 / 60;
// Minimal Scene stand-in: Battle/Arena/ItemBox/Projectiles only call add() and
// set background/fog; nothing here ever renders.
function stubScene() {
  return { add() {}, remove() {}, background: null, fog: null };
}

const allScores = []; // every AI's final score, across all matches
const perMatch = [];

for (let m = 0; m < matches; m++) {
  const b = new Battle({
    scene: stubScene(),
    audio: null,
    vfx: null,
    botPlayer: true,
    fieldSize: 8,
    tuning: overrides,
  });
  // In the browser the renderer refreshes world matrices every frame; headless
  // nobody does, so KartPhysics' raycasts against the (static) arena see stale
  // identity transforms — karts crawl and stick to walls. One deep update fixes
  // it for the whole match since the arena never moves.
  b.arena.group.updateMatrixWorld(true);
  b.release(); // skip the 3-2-1 lock — headless has no countdown overlay
  // Hard guard: TIME_LIMIT plus the end flourish, generously padded.
  const maxTicks = Math.ceil((b.tuning.TIME_LIMIT + 30) * 60);
  let ticks = 0;
  while (!b.finished && ticks++ < maxTicks) b.update(DT);
  const rows = b.getBattleResults();
  const scores = rows.map((r) => r.score);
  allScores.push(...scores);
  perMatch.push(scores);
  b.dispose();
  const mean = scores.reduce((a, c) => a + c, 0) / scores.length;
  console.log(
    `match ${String(m + 1).padStart(2)}: mean ${mean.toFixed(1).padStart(5)}  ` +
    `[${scores.map((s) => String(s).padStart(3)).join(' ')}]`
  );
}

const mean = allScores.reduce((a, c) => a + c, 0) / allScores.length;
const min = Math.min(...allScores);
const max = Math.max(...allScores);
const intensity = overrides.AI_INTENSITY != null ? overrides.AI_INTENSITY : 1.0;
// Charles's target is the per-AI MEAN ("around 40 to 80 pops on average"): solo
// [40,80], couch [20,40]. The floor is a soft sanity check — bot personalities
// vary, so the weakest ace-vs-rookie spread naturally trails the mean; we only
// fail if a kart is badly starved (well under the band), not for normal spread.
const band = intensity >= 1 ? [40, 80] : [20, 40];
const floor = intensity >= 1 ? 18 : 6;
const pass = mean >= band[0] && mean <= band[1] && min >= floor;

console.log(`SUMMARY ${JSON.stringify({ matches, intensity, tuning: overrides, mean: +mean.toFixed(2), min, max, band, floor, pass })}`);
process.exit(pass ? 0 : 1);
