import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seedMatrix, getRow, setDecided } from '../src/matrix.js';
import { storeSnapshot } from '../src/quota/poll.js';
import { parseCodexRateLimits } from '../src/quota/parse.js';
import { routeTask, SPOT_BACKOFF_MS } from '../src/router.js';
import { recordResults, expireStaleDuels } from '../src/duel.js';
import { pluginVersion } from '../src/version.js';
import type { Lane } from '../src/types.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000, WEEK_MS = 10080 * 60_000;

function snap(db: any, lane: Lane, weeklyPct: number, opts: { msToReset?: number; fiveHourPct?: number } = {}) {
  storeSnapshot(db, { lane, fetchedAt: NOW, windows: [
    ...(opts.fiveHourPct === undefined ? [] :
      [{ windowMinutes: 300, utilization: opts.fiveHourPct, resetsAt: NOW + 2 * HOUR }]),
    { windowMinutes: 10080, utilization: weeklyPct, resetsAt: NOW + (opts.msToReset ?? WEEK_MS / 2) },
  ] });
}
function freshDb() {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 30, { fiveHourPct: 10 });
  snap(db, 'B', 10, { fiveHourPct: 10 });
  snap(db, 'codex', 20);
  return db;
}

test('undecided kind with healthy lanes → duel, sides anthropic+openai', () => {
  const db = freshDb();
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'duel');
  assert.ok(d.duelId! > 0);
  assert.deepEqual(d.sides.map(s => s.vendor), ['anthropic', 'openai']);
  assert.equal(d.sides[0].lane, 'B'); // home lane, B also least-utilized
});

// A long-lived MCP server serves whatever dist/ it started with, so "which version is running"
// is unobservable per row unless the mint writes it down. Recorded stays NULL until results land.
test('a minted duel row is stamped with the running build', () => {
  const db = freshDb();
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'duel');
  const row: any = db.prepare(
    'SELECT minted_by_version, recorded_by_version FROM duels WHERE id=?').get(d.duelId);
  assert.equal(row.minted_by_version, pluginVersion());
  assert.match(row.minted_by_version, /^\d+\.\d+\.\d+$/);
  assert.notEqual(row.minted_by_version, '0.0.0'); // 0.0.0 means the lookup fell through
  assert.equal(row.recorded_by_version, null);
});

test('open lanes steer anthropic side to lower weekly pace, even when raw utilization disagrees', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // architecture-design homes on A. A: 30% weekly, half the week elapsed -> pace -20.
  // B: 40% weekly (HIGHER than A) but only 24h left (85.7% elapsed) -> pace -45.7,
  // i.e. more underpaced than A despite the higher raw utilization. Pace must win.
  snap(db, 'A', 30, { fiveHourPct: 10 });
  snap(db, 'B', 40, { fiveHourPct: 10, msToReset: 24 * HOUR });
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'architecture-design' }, NOW);
  assert.equal(d.sides[0].lane, 'B');
});

test('union home B stays B on lower lane-A weekly pace', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 10, { fiveHourPct: 10 });
  snap(db, 'B', 30, { fiveHourPct: 10 });
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'deep-review' }, NOW);
  assert.equal(d.mode, 'union');
  assert.equal(d.sides[0].lane, 'B');
});

test('union home B stays B when B is soft and A is open', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 30, { fiveHourPct: 10 });
  snap(db, 'B', 30, { fiveHourPct: 85 });
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'deep-review' }, NOW);
  assert.equal(d.mode, 'union');
  assert.equal(d.sides[0].lane, 'B');
});

test('union home B closed shifts to A (operator, 2026-09-03) — on closure only, never pace', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 30, { fiveHourPct: 10 });
  snap(db, 'B', 97, { fiveHourPct: 10 });
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'deep-review' }, NOW);
  assert.equal(d.mode, 'union', d.notes.join(' | '));
  assert.equal(d.sides[0].vendor, 'anthropic');
  assert.equal(d.sides[0].lane, 'A');
  assert.equal(d.sides[0].model, 'fable');
  assert.ok(d.notes.some(n => /shifted B→A \(home closed\); effort \w+ not enforceable on lane A/.test(n)),
    d.notes.join(' | '));
});

test('non-union home B still shifts to A on lower weekly pace', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 10, { fiveHourPct: 10 });
  snap(db, 'B', 30, { fiveHourPct: 10 });
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'duel');
  assert.equal(d.sides[0].lane, 'A');
});

test('mutating union contest fall-through keeps its anthropic side on B', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 10, { fiveHourPct: 10 });
  snap(db, 'B', 30, { fiveHourPct: 10 });
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'deep-review', mutating: true }, NOW);
  assert.equal(d.mode, 'duel');
  assert.equal(d.sides[0].lane, 'B');
});

test('an untouched home lane keeps its work — a pace off an invented reset time is no signal', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // The live 2026-07-25 shape: B's weekly pool had just reset, so the API reported 0% and no
  // resets_at, and parse marks the window synthetic. Reading that as "0% used, 0% elapsed"
  // scored pace 0, which lost to A's -20 and pulled deep-review off the idle account onto the
  // one at 30%.
  storeSnapshot(db, { lane: 'B', fetchedAt: NOW, windows: [
    { windowMinutes: 300, utilization: 0, resetsAt: NOW + 300 * 60_000, synthetic: true },
    { windowMinutes: 10080, utilization: 0, resetsAt: NOW + WEEK_MS, synthetic: true },
  ] });
  snap(db, 'A', 30, { fiveHourPct: 10 }); // pace -20
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'deep-review' }, NOW); // homes on B
  assert.equal(d.sides[0].lane, 'B');
  assert.deepEqual(d.notes.filter(n => n.includes('pace')), []);
});

test('burn lane attracts; no-overflow kind stays home', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 50, { msToReset: 20 * HOUR, fiveHourPct: 10 }); // burn
  snap(db, 'B', 10, { fiveHourPct: 10 });
  snap(db, 'codex', 20);
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).sides[0].lane, 'A');
  assert.equal(routeTask(db, { kind: 'long-context' }, NOW).sides[0].lane, 'A'); // overflow_eligible=0 anyway
});

test('soft anthropic 5h window degrades duel to single gpt side', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 30, { fiveHourPct: 85 });
  snap(db, 'B', 30, { fiveHourPct: 85 });
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'single');
  assert.equal(d.sides[0].vendor, 'openai');
  assert.ok(d.notes.some(n => n.includes('degraded')));
});

test('long-context duels fable[1m] vs gpt-6-astra (1M ctx both sides)', () => {
  const db = freshDb();
  const d = routeTask(db, { kind: 'long-context' }, NOW);
  assert.equal(d.mode, 'duel');
  assert.equal(d.sides[0].model, 'fable[1m]');
  assert.equal(d.sides[1].model, 'gpt-6-astra');
});

test('kind with no gpt contender → single anthropic, never duels', () => {
  const db = freshDb();
  db.prepare("UPDATE matrix SET gpt_model=NULL, gpt_effort=NULL WHERE task_kind='long-context'").run();
  const d = routeTask(db, { kind: 'long-context' }, NOW);
  assert.equal(d.mode, 'single');
  assert.equal(d.sides[0].vendor, 'anthropic');
});

// The spark earn-in shadow was retired 2026-07-25 (operator): spark holds the haiku tier seat by
// the seed and contends directly, so no route ever carries a side-car run.
test('no route carries a spark shadow — the earn-in shadow is retired', () => {
  const db = freshDb();
  for (const kind of ['bulk-mechanical-misc', 'transcription', 'implementation-misc', 'deep-review']) {
    assert.equal('shadow' in routeTask(db, { kind }, NOW), false);
  }
  // …including a haiku-tier row spark has been reverted OFF, which is the last state that used
  // to produce one. It now duels whatever it was reverted to, cross-tier or not.
  db.prepare("UPDATE matrix SET gpt_model='gpt-5.6-terra' WHERE task_kind='bulk-mechanical-misc'").run();
  const d = routeTask(db, { kind: 'bulk-mechanical-misc' }, NOW);
  assert.equal('shadow' in d, false);
  assert.equal(d.mode, 'duel');
  assert.equal(d.sides[1].model, 'gpt-5.6-terra');
});

test('a spot check delayed by a degraded lane is taken later, not silently dropped', () => {
  const db = freshDb();
  db.prepare("UPDATE matrix SET decided=1, victor_vendor='openai' WHERE task_kind='implementation-misc'").run();
  snap(db, 'codex', 85); // soft → not duelable
  for (let i = 0; i < 15; i++) {
    assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single');
  }
  snap(db, 'codex', 10); // lane recovers
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'duel');
  // and the counter resets, so the next spot check is a full interval away
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single');
});

test('an unknown task kind must be a slug, not a task description', () => {
  const db = freshDb();
  assert.throws(() => routeTask(db, { kind: 'live-API probe (FMP endpoints)' }, NOW),
    /invalid task kind/);
  assert.throws(() => routeTask(db, { kind: 'Deep Review' }, NOW), /invalid task kind/);
  const d = routeTask(db, { kind: 'schema-migration' }, NOW); // valid new kind still works
  assert.ok(d.notes.some(n => /provisional/.test(n)));
});

test('a new kind can be seeded at a chosen tier with its gpt peer', () => {
  const db = freshDb();
  const d = routeTask(db, { kind: 'log-triage', tier: 'haiku' }, NOW);
  assert.deepEqual(d.sides.map(s => s.model).sort(), ['gpt-5.3-codex-spark', 'haiku']);
  assert.equal(getRow(db, 'log-triage').anth_effort, 'low');
  // without a tier it still clones the default row (sonnet@medium vs sol@high since 2026-08-10)
  assert.deepEqual(routeTask(db, { kind: 'log-triage-two' }, NOW).sides.map(s => s.model).sort(),
    ['gpt-6-astra', 'sonnet']);
  // the sonnet tier peers cross-effort since 2026-08-10: sonnet@medium vs sol@high
  routeTask(db, { kind: 'log-triage-four', tier: 'sonnet' }, NOW);
  const sonnetTier = getRow(db, 'log-triage-four');
  assert.equal(sonnetTier.gpt_model, 'gpt-6-astra');
  assert.equal(sonnetTier.gpt_effort, 'high');
  assert.equal(sonnetTier.anth_effort, 'medium'); // the override is gpt-side only
  assert.throws(() => routeTask(db, { kind: 'log-triage-three', tier: 'gpt-9' }, NOW),
    /unknown tier/);
});

test('decided kind routes victor; every 10th becomes spot-check duel', () => {
  const db = freshDb();
  db.prepare("UPDATE matrix SET decided=1, victor_vendor='openai' WHERE task_kind='implementation-misc'").run();
  const modes: string[] = [];
  for (let i = 0; i < 10; i++) modes.push(routeTask(db, { kind: 'implementation-misc' }, NOW).mode);
  assert.equal(modes.filter(m => m === 'single').length, 9);
  assert.equal(modes[9], 'duel');
  const spot = db.prepare('SELECT spot_check FROM duels ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(spot.spot_check, 1);
});

test('a closed judge lane suppresses the duel — routing one would be unjudgeable from creation', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 30, { fiveHourPct: 10 });
  snap(db, 'B', 97, { fiveHourPct: 10 }); // anthropic judge lane closed
  snap(db, 'codex', 20);
  // The side happily shifts B→A, so side-lane checks alone say "duel" — that was the trap: both
  // sides run and attest, and the row sits unjudgeable until the sweep abandons it.
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'single');
  assert.ok(d.notes.some(n => /judge lane/.test(n)));
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM duels').get() as any).c, 0);
});

test('judge lanes are B and codex even when neither side runs there', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 10, { fiveHourPct: 10 });
  snap(db, 'B', 10, { fiveHourPct: 10 });
  snap(db, 'codex', 97); // openai judge lane closed; the spark side itself is unmetered and open
  const d = routeTask(db, { kind: 'bulk-mechanical-misc' }, NOW); // haiku vs spark — codex is no side
  assert.equal(d.mode, 'single');
  assert.ok(d.notes.some(n => /judge lane/.test(n)));
});

test('a spot check blocked by a closed judge lane is delayed, not silently dropped', () => {
  const db = freshDb();
  db.prepare("UPDATE matrix SET decided=1, victor_vendor='openai' WHERE task_kind='implementation-misc'").run();
  snap(db, 'B', 97, { fiveHourPct: 10 }); // judge lane closed; both side lanes stay duelable
  for (let i = 0; i < 15; i++) {
    assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single');
  }
  snap(db, 'B', 10, { fiveHourPct: 10 }); // judge lane recovers
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'duel');
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single'); // counter reset
});

test('all lanes closed → blocked', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'A', 96, { fiveHourPct: 10 });
  snap(db, 'B', 96, { fiveHourPct: 10 });
  snap(db, 'codex', 97);
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'blocked');
});

test('unknown kind gets provisional row and still routes', () => {
  const db = freshDb();
  const d = routeTask(db, { kind: 'never-seen-before' }, NOW);
  assert.equal(d.mode, 'duel');
  assert.equal(getRow(db, 'never-seen-before').provisional, 1);
  assert.ok(d.notes.some(n => n.includes('provisional')));
});

test('the audit slot is spent when the audit records, not when it is routed', () => {
  const db = freshDb();
  db.prepare("UPDATE matrix SET decided=1, victor_vendor='openai' WHERE task_kind='implementation-misc'").run();
  for (let i = 0; i < 9; i++) assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single');
  const spot = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(spot.mode, 'duel');
  assert.ok(spot.spotCheck);
  // while the audit is in flight, no duplicate is minted…
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single');
  // …but an audit that dies un-run re-fires once the backoff clears: it used to reset the
  // counter at creation, buying the incumbent another ten unaudited routes per dead audit
  // (duel-62 I4/S7); since duel-64 opus #5 the re-fire waits out SPOT_BACKOFF_MS
  db.prepare("UPDATE duels SET status='abandoned', decided_by='abandoned' WHERE id=?").run(spot.duelId);
  const refire = routeTask(db, { kind: 'implementation-misc' }, NOW + HOUR);
  assert.equal(refire.mode, 'duel');
  assert.ok(refire.spotCheck);
  // recording the audit's results spends ONE interval, not the whole balance: 12 routes have
  // passed (10 + the pending-gated one + the refire), so 2 of debt carry over — zeroing here
  // forgave every route taken while the audit was in flight (duel-63 opus #3)
  recordResults(db, refire.duelId!,
    { anthropic: { output: 'a', tokens: 5000, latencyMs: 50, failed: false },
      openai: { output: null, tokens: null, latencyMs: null, failed: true } },
    { roots: { B: null, codex: null } });
  assert.equal(getRow(db, 'implementation-misc').spot_counter, 2);
  for (let i = 0; i < 7; i++) assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single');
  // debt carried over (the dead first audit is an hour old by now — past the backoff)
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW + HOUR).mode, 'duel');
});

test('a double-failure record does not spend the audit slot — no evidence, no audit', () => {
  const db = freshDb();
  db.prepare("UPDATE matrix SET decided=1, victor_vendor='openai' WHERE task_kind='implementation-misc'").run();
  for (let i = 0; i < 9; i++) routeTask(db, { kind: 'implementation-misc' }, NOW);
  const spot = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.ok(spot.spotCheck);
  // both sides failed: zero proof checks, nothing attested — spending the slot here was the
  // unfalsifiable incumbent through the other door (duel-63 opus #2)
  const bothDead = { output: null, tokens: null, latencyMs: null, failed: true };
  recordResults(db, spot.duelId!, { anthropic: bothDead, openai: bothDead },
    { roots: { B: null, codex: null }, now: NOW });
  assert.equal(getRow(db, 'implementation-misc').spot_counter, 10); // debt still standing
  // the null-winner walkover is terminal, so the pending gate clears — and the re-fire waits
  // out the backoff instead of burning every route (duel-64 opus #5)
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).mode, 'single');
  const next = routeTask(db, { kind: 'implementation-misc' }, NOW + HOUR);
  assert.equal(next.mode, 'duel');
  assert.ok(next.spotCheck);
});

// ——— duel-64 ledger ———

const FAILED_SIDE = { output: null, tokens: null, latencyMs: null, failed: true };

// A double-failure audit leaves the debt standing (nothing was audited), but the re-fire is
// backed off: without a cooldown every subsequent route spawned a fresh audit plus two judges —
// 1-in-10 became 1-in-1, one permanent walkover row per route (duel-64 opus #5).
test('a failed spot audit re-fires only after the backoff, not on every route', () => {
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'openai', NOW, 'victory');
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  const d1 = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d1.mode, 'duel');
  assert.equal(d1.spotCheck, true);
  // both lanes die: null-winner walkover — terminal, the debt stands
  recordResults(db, d1.duelId!, { anthropic: FAILED_SIDE, openai: FAILED_SIDE },
    { roots: { B: null, codex: null }, now: NOW });
  // immediate next route: the audit is suppressed, single to the incumbent
  const d2 = routeTask(db, { kind: 'implementation-misc' }, NOW + 60_000);
  assert.equal(d2.mode, 'single');
  assert.ok(d2.notes.some(n => /backed off|backoff/i.test(n)));
  // past the backoff the audit fires again — the debt was never forgiven
  const d3 = routeTask(db, { kind: 'implementation-misc' }, NOW + 2 * HOUR);
  assert.equal(d3.mode, 'duel');
  assert.equal(d3.spotCheck, true);
});

// ——— duel-65 ledger ———

// The dead-audit backoff was clocked from created_at, but a sweep only abandons a row 6h after
// routing — arithmetically past the 1h backoff, so SWEPT audits re-fired instantly, forever
// (duel-65 opus F3 / sol S5). Death is when the audit died: recorded_at for a recorded double
// failure, the sweep's own stamp for an un-run row.
test('a swept un-run audit backs off from its DEATH, not its birth', () => {
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'anthropic', NOW - 10 * HOUR, 'victory');
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  const d1 = routeTask(db, { kind: 'implementation-misc' }, NOW - 7 * HOUR);
  assert.equal(d1.spotCheck, true);
  assert.equal(expireStaleDuels(db, NOW).length, 1); // swept 7h after routing
  const d2 = routeTask(db, { kind: 'implementation-misc' }, NOW + 60_000);
  assert.equal(d2.mode, 'single');
  assert.ok(d2.notes.some(n => /backed off/i.test(n)));
  const d3 = routeTask(db, { kind: 'implementation-misc' }, NOW + SPOT_BACKOFF_MS + 60_000);
  assert.equal(d3.spotCheck, true);
});

// ——— duel-66 ledger ———

// A dead audit carrying BOTH stamps died at the SWEEP, not at the record: COALESCE preferring
// recorded_at read a legacy blank-side audit recorded long ago and swept just now as a death
// in the distant past — the backoff bypassed entirely, F3 through the COALESCE order
// (duel-66 opus M6 / sol F3).
test('a recorded-then-swept dead audit backs off from the sweep, not the old record', () => {
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'anthropic', NOW - 100 * HOUR, 'victory');
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  // legacy shape: an evidence-free audit recorded (blank sides) long ago, swept a minute ago
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    decided_by, recorded_at, abandoned_at) VALUES ('implementation-misc', ?, 1, '[]', '{}',
    'abandoned', 'abandoned', ?, ?)`)
    .run(NOW - 90 * HOUR, NOW - 89 * HOUR, NOW - 60_000);
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'single');
  assert.ok(d.notes.some(n => /backed off/i.test(n)));
});

// The dead-audit predicate also matched abandoned audits that EXECUTED (results recorded,
// judges never came): those are revivable work, not a dying-audit signal, and counting them
// would back off healthy kinds (duel-65 opus F3 secondary). Dead = never carried evidence.
test('an audit that executed before being swept is not a dead audit — no backoff from it', () => {
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'anthropic', NOW - 10 * HOUR, 'victory');
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    anth_output, gpt_output, recorded_at) VALUES ('implementation-misc', ?, 1, '[]', '{}',
    'abandoned', 'a', 'g', ?)`).run(NOW - 8 * HOUR, NOW - 600_000);
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  assert.equal(routeTask(db, { kind: 'implementation-misc' }, NOW).spotCheck, true);
});

// ——— duel-67 ledger ———

// ≤2.6.8 wrote rows whose abandoned_at PREdates a later record (nothing cleared the sweep's
// stamp back then), and no migration repairs them: any fixed COALESCE preference misreads one
// generation or the other. The death is the LATEST stamp the row carries
// (duel-67 sol F2 / opus F3).
test('a legacy row swept long ago but recorded just now backs off from the record', () => {
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'anthropic', NOW - 100 * HOUR, 'victory');
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  // 2.6.8 shape: swept at T1, revived and double-failure-recorded at T2 > T1, stamp kept
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    decided_by, recorded_at, abandoned_at) VALUES ('implementation-misc', ?, 1, '[]', '{}',
    'walkover', 'walkover', ?, ?)`)
    .run(NOW - 90 * HOUR, NOW - 60_000, NOW - 7 * HOUR);
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'single');
  assert.ok(d.notes.some(n => /backed off/i.test(n)));
});

// A sitter expired 'superseded' by a successful audit is a displacement, not a dying audit —
// it must not back off the kind whose audit just SUCCEEDED (duel-67 opus F7).
test('a superseded sitter does not back off the kind its live audit just served', () => {
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'anthropic', NOW - 10 * HOUR, 'victory');
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    decided_by, abandoned_at) VALUES ('implementation-misc', ?, 1, '[]', '{}', 'abandoned',
    'superseded', ?)`).run(NOW - 8 * HOUR, NOW - 60_000);
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'duel');
  assert.equal(d.spotCheck, true);
});

// The death-record door of the same defect: recording the sitter's double failure recomputes
// decided_by to 'abandoned' (recordResults), which erased the spelling guard above — the
// superseded_by tombstone carries the displacement however the death is spelled
// (duel-73 opus F1, reopening duel-67 opus F7).
test('a superseded sitter recorded dead still does not back off the kind', () => {
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'anthropic', NOW - 10 * HOUR, 'victory');
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    decided_by, superseded_by, death_recorded, recorded_at, abandoned_at)
    VALUES ('implementation-misc', ?, 1, '[]', '{}', 'abandoned', 'abandoned', 2, 1, ?, ?)`)
    .run(NOW - 8 * HOUR, NOW - 60_000, NOW - 60_000);
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'duel');
  assert.equal(d.spotCheck, true);
});

// A fresh quota snapshot says nothing about WHICH account the offload dir holds — the operator can
// re-login the main session into account B while B's numbers stay green. Routing to B then bills
// the MAIN account, silently; an unresolvable offload dir closes the lane for that route instead.
test('routeTask: bBlocked closes lane B, and the FULL composed trail says what happened', () => {
  const db = freshDb();
  // Control: on this fixture the kind's anthropic side routes to B while the lane is open.
  assert.equal(routeTask(db, { kind: 'route-bblocked-test' }, NOW).sides[0].lane, 'B');
  const d = routeTask(db, { kind: 'route-bblocked-test' }, NOW,
    { bBlocked: 'no aux config dir differs' });
  // The whole cascade, in order — closing B does three distinct things to this route, and the
  // old any-note check let two of them regress silently (task-4 review minor): the SIDE
  // survives by shifting B→A, but the DUEL does not (its anthropic judge is lane-B fixed and
  // unshiftable), and the resulting single lands on codex by weekly pace, not on the shifted
  // A side.
  assert.equal(d.mode, 'single');
  assert.deepEqual(d.sides.map(s => `${s.lane}/${s.vendor}`), ['codex/openai']);
  assert.equal(d.notes.length, 3, `unexpected extra notes: ${JSON.stringify(d.notes)}`);
  assert.match(d.notes[0], /lane B closed: offload unresolvable — no aux config dir differs/);
  assert.match(d.notes[1], /anthropic lane shifted B→A \(home closed\)/);
  // duel 391 M9: the Agent tool has no effort channel — a side shifted onto A runs at the session default
  assert.match(d.notes[1], /effort \w+ not enforceable on lane A/);
  assert.match(d.notes[2], /duel suppressed — judge lane B closed.*single on lower weekly pace/);
});

// --- spark backup (operator, 2026-08-20) ----------------------------------------------------
// Duel 268: spark's own weekly pool hit 100% mid-task and duels 269-272 walked over on a lane
// that could not spawn. The operator's standing order: when spark is closed, the openai side
// falls back to gpt-5.6-luna@high on the codex lane so the kind keeps dueling. Luna stays
// retired everywhere else (no ladder seat, no scorecard import) — this is a backup, not a return.

test('spark closed → openai side falls back to luna@high on codex', () => {
  const db = freshDb();
  snap(db, 'spark', 100, { msToReset: 26 * HOUR }); // duel 268's shape: weekly capped, reset ~26h out
  const d = routeTask(db, { kind: 'transcription', mutating: true }, NOW);
  assert.equal(d.mode, 'duel');
  const gpt = d.sides[1];
  assert.equal(gpt.model, 'gpt-5.6-luna');
  assert.equal(gpt.lane, 'codex');
  assert.equal(gpt.effort, 'high');
  assert.equal(d.sides[0].vendor, 'anthropic'); // the seeded side is untouched
  assert.ok(d.notes.some(n => /spark closed — gpt-5\.6-luna@high backup on codex/.test(n)),
    `missing backup note: ${JSON.stringify(d.notes)}`);
});

test('spark open or merely unknown keeps the seeded spark side', () => {
  // stale is unknown, not unavailable — spark's steady state when it has not run recently.
  const stale = routeTask(freshDb(), { kind: 'transcription' }, NOW); // no spark snapshot at all
  assert.equal(stale.sides[1].model, 'gpt-5.3-codex-spark');
  assert.equal(stale.sides[1].lane, 'spark');
  const db = freshDb();
  snap(db, 'spark', 40);
  const open = routeTask(db, { kind: 'transcription' }, NOW);
  assert.equal(open.sides[1].model, 'gpt-5.3-codex-spark');
  assert.equal(open.sides[1].lane, 'spark');
});

test('spark closed AND codex closed → no backup, single anthropic', () => {
  const db = freshDb();
  snap(db, 'spark', 100);
  snap(db, 'codex', 97);
  const d = routeTask(db, { kind: 'transcription' }, NOW);
  assert.equal(d.mode, 'single');
  assert.equal(d.sides[0].vendor, 'anthropic');
});

test('composed: a real spark rollout tail at 100% weekly routes the luna backup', () => {
  // Wave-1 (spark metered from its own rollouts, closure held past STALE_MS) and wave-2 (luna
  // backup) applied to one scenario — duel 268's actual tail shape: mixed limit_id events
  // ("codex" then "codex_bengalfox"), 5h pool at 54%, weekly at 100%, reading 7h old.
  const db = freshDb();
  const ev = (id: string, weeklyPct: number) => JSON.stringify({ payload: { info: { rate_limits: {
    limit_id: id,
    primary: { used_percent: 54, window_minutes: 300, resets_at: (NOW + 3 * HOUR) / 1000 },
    secondary: { used_percent: weeklyPct, window_minutes: 10080, resets_at: (NOW + 26 * HOUR) / 1000 },
  } } } });
  const tail = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied',
      thread_settings: { model: 'gpt-5.3-codex-spark', model_provider_id: 'openai' } } }),
    ev('codex', 98), ev('codex_bengalfox', 100),
  ].join('\n');
  const [usage] = parseCodexRateLimits(tail, NOW - 7 * HOUR, 'spark');
  storeSnapshot(db, usage);
  const d = routeTask(db, { kind: 'mechanical-apply', mutating: true }, NOW);
  assert.equal(d.mode, 'duel');
  assert.equal(d.sides[1].model, 'gpt-5.6-luna');
  assert.equal(d.sides[1].lane, 'codex');
  assert.equal(d.sides[1].effort, 'high');
});

test('composed status→route: a hard-capped fable pool refuses fable on that lane (duel 391 M7)', () => {
  // Rows 311/318/325/361/366/371/380: B's account windows read 66-75% while the fable pool was
  // at 100, and every fable-B side died at spawn on a 429 the router had no way to see.
  const withPool = (lane: Lane, weeklyPct: number, fablePct: number) => storeSnapshot(db, {
    lane, fetchedAt: NOW, windows: [
      { windowMinutes: 300, utilization: 10, resetsAt: NOW + 2 * HOUR },
      { windowMinutes: 10080, utilization: weeklyPct, resetsAt: NOW + WEEK_MS / 2 },
      { windowMinutes: 10080, utilization: fablePct, resetsAt: NOW + 26 * HOUR, model: 'fable' },
    ] });
  const db = openDb(':memory:'); seedMatrix(db, 1);
  snap(db, 'codex', 20);
  // stored and read back through the snapshot table, not handed to laneStatus directly
  withPool('A', 30, 32);
  withPool('B', 10, 100);
  // deep-review: union, fable homed on B. The closed pool shifts the side onto A's open fable
  // pool (operator, 2026-09-03) — a dead fable-B side is not minted and the union keeps both sides.
  const union = routeTask(db, { kind: 'deep-review' }, NOW);
  assert.equal(union.mode, 'union', union.notes.join(' | '));
  assert.equal(union.sides[0].lane, 'A');
  assert.equal(union.sides[0].model, 'fable');
  assert.ok(union.notes.some(n => /lane B: fable pool 100%.*closed until/.test(n)), union.notes.join(' | '));
  // debugging: fable homed on A — the same pool closure on A shifts it to B (home closed)
  withPool('A', 30, 100);
  withPool('B', 10, 32);
  const shifted = routeTask(db, { kind: 'debugging' }, NOW);
  assert.equal(shifted.sides[0].lane, 'B', shifted.notes.join(' | '));
  assert.ok(shifted.notes.some(n => /lane A: fable pool 100%/.test(n)));
  // a non-fable kind on the same lane never sees the fable pool
  withPool('B', 10, 100);
  const other = db.prepare(
    "SELECT task_kind FROM matrix WHERE anth_lane='B' AND anth_model!='fable' AND union_mode=0 LIMIT 1",
  ).get() as { task_kind: string };
  const unaffected = routeTask(db, { kind: other.task_kind }, NOW);
  assert.equal(unaffected.sides[0].lane, 'B', `${other.task_kind}: ${unaffected.notes.join(' | ')}`);
  assert.deepEqual(unaffected.notes.filter(n => /pool/.test(n)), []);
});

test('fable-closed backup (operator, 2026-09-03): a closed home pool shifts the side, both pools closed run opus', () => {
  const withPool = (db: any, lane: Lane, weeklyPct: number, fablePct: number) => storeSnapshot(db, {
    lane, fetchedAt: NOW, windows: [
      { windowMinutes: 300, utilization: 10, resetsAt: NOW + 2 * HOUR },
      { windowMinutes: 10080, utilization: weeklyPct, resetsAt: NOW + WEEK_MS / 2 },
      { windowMinutes: 10080, utilization: fablePct, resetsAt: NOW + 26 * HOUR, model: 'fable' },
    ] });
  type Want = { mode: string; vendor?: string; lane?: Lane; model?: string; effort?: string; note?: RegExp };
  const rows: { label: string; kind: string; A: [number, number]; B: [number, number];
    bBlocked?: string; want: Want }[] = [
    { label: 'union: B fable pool closed, A fable open → fable shifts to A',
      kind: 'deep-review', A: [30, 32], B: [10, 100],
      want: { mode: 'union', lane: 'A', model: 'fable', effort: 'xhigh',
        note: /shifted B→A \(home closed\); effort xhigh not enforceable on lane A/ } },
    { label: 'union: both fable pools closed, both accounts open → opus at the row effort on home B',
      kind: 'deep-review', A: [30, 100], B: [10, 100],
      want: { mode: 'union', lane: 'B', model: 'opus', effort: 'xhigh',
        note: /^fable closed on A and B — opus@xhigh backup on lane B \(operator standing order, 2026-09-03\)$/ } },
    { label: 'union: both fable pools closed, B account closed → opus on A, effort noted unenforceable',
      kind: 'deep-review', A: [30, 100], B: [97, 100],
      want: { mode: 'union', lane: 'A', model: 'opus',
        note: /opus@xhigh backup on lane A .*; effort xhigh not enforceable on lane A/ } },
    { label: 'union: both accounts closed → single openai, as before (no lane can run any model)',
      kind: 'deep-review', A: [97, 100], B: [97, 100],
      want: { mode: 'single', vendor: 'openai' } },
    { label: 'lane-A fable kind: both fable pools closed → opus on home A, still a judged duel',
      kind: 'debugging', A: [30, 100], B: [10, 100],
      want: { mode: 'duel', lane: 'A', model: 'opus', effort: 'xhigh' } },
    { label: 'lane-A fable kind: only B fable pool closed → fable stays on A; the opus judge on B is not behind the fable pool',
      kind: 'debugging', A: [30, 32], B: [10, 100],
      want: { mode: 'duel', lane: 'A', model: 'fable' } },
    { label: 'union: B soft on its weekly window, pools open → stays B (soft never shifts a union)',
      kind: 'deep-review', A: [30, 32], B: [85, 32],
      want: { mode: 'union', lane: 'B', model: 'fable' } },
    // Composed with the offload block: every lane-B reading closes under it, so the opus backup
    // must land on A — a fresh B snapshot for opus is exactly the reading the block overrides.
    { label: 'union: both fable pools closed, B offload blocked → opus on A, never on the blocked B',
      kind: 'deep-review', A: [30, 100], B: [10, 100], bBlocked: 'aux config dir differs',
      want: { mode: 'union', lane: 'A', model: 'opus', note: /opus@xhigh backup on lane A/ } },
  ];
  for (const r of rows) {
    const db = openDb(':memory:'); seedMatrix(db, 1);
    snap(db, 'codex', 20);
    withPool(db, 'A', ...r.A);
    withPool(db, 'B', ...r.B);
    const d = routeTask(db, { kind: r.kind }, NOW, r.bBlocked ? { bBlocked: r.bBlocked } : {});
    const ctx = `${r.label}: ${d.notes.join(' | ')}`;
    assert.equal(d.mode, r.want.mode, ctx);
    const s = d.sides[0];
    if (r.want.vendor) assert.equal(s.vendor, r.want.vendor, ctx);
    if (r.want.lane) {
      assert.equal(s.vendor, 'anthropic', ctx);
      assert.equal(s.lane, r.want.lane, ctx);
      assert.equal(s.model, r.want.model, ctx);
      if (r.want.effort) assert.equal(s.effort, r.want.effort, ctx);
    }
    if (r.want.note) assert.ok(d.notes.some(n => r.want.note!.test(n)), ctx);
  }
});

test('composed status→route: an aged soft reading still degrades a duel (duel 391 M5)', () => {
  // Same shape as the fresh soft test above, 30 h old: `stale` was duelable, `soft` is not.
  const db = openDb(':memory:'); seedMatrix(db, 1);
  for (const lane of ['A', 'B'] as Lane[]) {
    storeSnapshot(db, { lane, fetchedAt: NOW - 30 * HOUR, windows: [
      { windowMinutes: 300, utilization: 10, resetsAt: NOW + 2 * HOUR },
      { windowMinutes: 10080, utilization: 85, resetsAt: NOW + 26 * HOUR },
    ] });
  }
  snap(db, 'codex', 20);
  const d = routeTask(db, { kind: 'implementation-misc' }, NOW);
  assert.equal(d.mode, 'single', d.notes.join(' | '));
  assert.equal(d.sides[0].vendor, 'openai');
});
