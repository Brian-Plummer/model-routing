import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seedMatrix, setVendorModel } from '../src/matrix.js';
import { standings, pendingDuels, latencyMargins } from '../src/standings.js';
import { pluginVersion } from '../src/version.js';

// Insert a finished duel row directly — cheaper than driving the full lifecycle here
function judged(db: any, kind: string, winner: string, spot = 0, createdAt = 1,
  anthTokens: number | null = null, gptTokens: number | null = null,
  anthLatency: number | null = null, gptLatency: number | null = null) {
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
    status, winner_vendor, decided_by, anth_tokens, gpt_tokens, anth_latency_ms, gpt_latency_ms)
    VALUES (?, ?, ?, 0, ?, '{"X":"anthropic","Y":"openai"}', 'judged', ?, 'judges', ?, ?, ?, ?)`)
    .run(kind, createdAt, spot, JSON.stringify([
      { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
      { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
    ]), winner, anthTokens, gptTokens, anthLatency, gptLatency);
}
function walkover(db: any, kind: string, spot = 0, createdAt = 1, winner: string | null = 'openai') {
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
    status, winner_vendor, decided_by)
    VALUES (?, ?, ?, 0, '[]', '{}', 'walkover', ?, 'walkover')`)
    .run(kind, createdAt, spot, winner);
}

test('standings aggregates judged duels, walkovers, and the current pairing', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  for (let i = 0; i < 3; i++) judged(db, 'implementation-misc', 'anthropic'); // judge-decided
  judgedBy(db, 'implementation-misc', 'openai', 'latency', 5000, 3000);      // latency tiebreak
  judgedBy(db, 'implementation-misc', 'anthropic', 'latency');               // latency tiebreak
  walkover(db, 'implementation-misc');
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(
    { judged: s.judged, anthWins: s.anthWins, gptWins: s.gptWins, walkovers: s.walkovers },
    { judged: 5, anthWins: 4, gptWins: 1, walkovers: 1 });
  // final totals break out by decision channel: quality (judges), then time (latency). There
  // is no token channel — cheapness decides nothing (operator, 2026-08-10).
  assert.deepEqual(
    { aj: s.anthJudgeWins, gj: s.gptJudgeWins, al: s.anthLatencyWins, gl: s.gptLatencyWins },
    { aj: 3, gj: 0, al: 1, gl: 1 });
  assert.equal(s.judgeAgreementPct, 60); // 3 of 5 judge-decided
  assert.equal(s.anthModel, 'sonnet');       // the seeded pairing rides along per kind
  assert.equal(s.gptModel, 'gpt-6-astra');
  assert.equal(s.anthEffort, 'high');        // and its efforts
  assert.equal(s.gptEffort, 'high');
});

test('duels from before a settings change are grouped as retired records', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  for (let i = 0; i < 2; i++) judged(db, 'implementation-misc', 'anthropic', 0, 2); // old-era duels
  judged(db, 'implementation-misc', 'openai', 0, 2);
  // effort-only change: same model, new effort — bumps updated_at, retiring the era above
  setVendorModel(db, 'implementation-misc', 'openai', 'gpt-5.6-terra', 'xhigh', 5);
  judged(db, 'implementation-misc', 'anthropic', 0, 6); // current-era duel
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.equal(s.judged, 1);   // the main row is the current window only
  assert.equal(s.anthWins, 1);
  assert.equal(s.gptEffort, 'xhigh');
  // the retired record carries the pairing the duels actually ran, from their sides JSON
  assert.deepEqual(s.retired, [{
    anthModel: 'sonnet', anthEffort: 'high', gptModel: 'gpt-5.6-terra', gptEffort: 'high',
    judged: 3, anthWins: 2, gptWins: 1, anthJudgeWins: 2, gptJudgeWins: 1,
    anthLatencyWins: 0, gptLatencyWins: 0, walkovers: 0,
    // these three duels stored no clocks, so there is nothing to measure — and nothing measured
    // is not zero time saved
    anthLatencySavedMs: 0, gptLatencySavedMs: 0,
    anthLatencyMedianMs: null, gptLatencyMedianMs: null, netLatencyMs: null,
  }]);
  // a kind with no settings change retires nothing
  assert.deepEqual(standings(db).find(k => k.kind === 'default')!.retired, []);
});

test('kinds with no duels still appear — the open-contest count is the whole matrix', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // Driving the query FROM duels dropped every never-duelled kind, so a freshly seeded install
  // reported "open contests: 0" with nine of them.
  const s = standings(db);
  assert.equal(s.length, 14);
  assert.equal(s.filter(k => !k.decided).length, 14);
  const impl = s.find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(
    { judged: impl.judged, anthWins: impl.anthWins, walkovers: impl.walkovers,
      pct: impl.judgeAgreementPct },
    { judged: 0, anthWins: 0, walkovers: 0, pct: null });

  // a duelled kind whose matrix row was deleted must still keep its history
  judged(db, 'implementation-misc', 'anthropic');
  db.prepare("DELETE FROM matrix WHERE task_kind='implementation-misc'").run();
  const orphan = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.equal(orphan.judged, 1);
  assert.equal(orphan.anthModel, null); // no matrix row — no pairing to report
  assert.equal(orphan.anthEffort, null);
});

test('pending and recently-abandoned duels are listed with ids and kinds', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_800_000_000_000;
  const DAY = 24 * 3_600_000;
  const ins = (kind: string, status: string, createdAt: number, outputs: boolean, union = 0) =>
    Number(db.prepare(
      `INSERT INTO duels(task_kind, created_at, sides, label_map, status, union_mode,
         anth_output, gpt_output) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(kind, createdAt, '[]', '{}', status, union,
      outputs ? 'a' : null, outputs ? 'g' : null).lastInsertRowid);
  const routed = ins('deep-review', 'routed', now - 3_600_000, false);
  const waiting = ins('implementation-misc', 'awaiting_judgment', now - 3_600_000, true);
  const revivable = ins('bulk-mechanical', 'abandoned', now - DAY, true);
  const unionDead = ins('deep-review', 'abandoned', now - DAY, true, 1); // union: never judged
  ins('bulk-mechanical', 'abandoned', now - 8 * DAY, true); // outside the 7-day window
  ins('implementation-misc', 'judged', now - 3_600_000, true);   // terminal — never listed
  const p = pendingDuels(db, now);
  assert.deepEqual(p.map(r => [r.id, r.kind, r.status]), [
    [routed, 'deep-review', 'routed'],
    [waiting, 'implementation-misc', 'awaiting_judgment'],
    [revivable, 'bulk-mechanical', 'abandoned'],
    [unionDead, 'deep-review', 'abandoned'],
  ]);
  // Re-judgeable is recordJudgment's own revival test: abandoned + both outputs + not a union.
  assert.equal(p.find(r => r.id === revivable)!.reJudgeable, true);
  assert.equal(p.find(r => r.id === unionDead)!.reJudgeable, false);
  assert.equal(p.find(r => r.id === routed)!.reJudgeable, false); // nothing to vote on
});

// decided_by separates judge verdicts from token/latency tiebreaks (duel-62 I6).
function judgedBy(db: any, kind: string, winner: string, decidedBy: string,
  anthTokens: number | null = null, gptTokens: number | null = null) {
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
    status, winner_vendor, decided_by, anth_tokens, gpt_tokens)
    VALUES (?, 1, 0, 0, '[]', '{"X":"anthropic","Y":"openai"}', 'judged', ?, ?, ?, ?)`)
    .run(kind, winner, decidedBy, anthTokens, gptTokens);
}

// A duel the CLOCK decided, with both stored clocks and the same pairing `judged` writes — the
// sides JSON is what a retired record groups by, so a clock duel needs a real one.
function clock(db: any, kind: string, winner: string, anthLatency: number, gptLatency: number,
  createdAt = 1) {
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
    status, winner_vendor, decided_by, anth_tokens, gpt_tokens, anth_latency_ms, gpt_latency_ms)
    VALUES (?, ?, 0, 0, ?, '{"X":"anthropic","Y":"openai"}', 'judged', ?, 'latency', 9000, 9000,
    ?, ?)`)
    .run(kind, createdAt, JSON.stringify([
      { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
      { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
    ]), winner, anthLatency, gptLatency);
}

// pendingDuels advertises reJudgeable with recordJudgment's own revival test — which now
// demands two LANDED (non-blank) outputs, not merely two non-null ones (duel-64 sol #4).
test('a blank stored output does not make an abandoned row re-judgeable', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
    status, anth_output, gpt_output)
    VALUES ('implementation-misc', 1, 0, 0, '[]', '{}', 'abandoned', '   ', 'real report')`).run();
  const p = pendingDuels(db, 2);
  assert.equal(p.length, 1);
  assert.equal(p[0].reJudgeable, false);
});

// ——— duel-65 ledger ———

// SQLite's one-arg TRIM strips spaces ONLY, while landedOf uses JS .trim(): a side stored
// '\n\t' was advertised reJudgeable, the operator burned two single-use judge runs, and
// recordJudgment refused both (duel-65 opus F4 / sol S9). One predicate for both languages.
test('a tab/newline-blank side is not re-judgeable either', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status,
    anth_output, gpt_output) VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned',
    char(10)||char(9), 'real report')`).run();
  assert.equal(pendingDuels(db, 2)[0].reJudgeable, false);
});

// ——— duel-66 ledger ———

// pendingDuels aged abandoned rows by created_at even though abandoned_at records the death:
// an install idle past the window swept a day-zero routed duel and every pending surface
// omitted the freshly-dead row immediately — visible once on the sweep line, then gone
// (duel-66 sol F6). The horizon runs from the death stamp, created_at only as the legacy
// fallback.
test('a freshly swept row stays listed even when created long before the window', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, abandoned_at)
    VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned', ?)`).run(now - 60_000);
  const p = pendingDuels(db, now);
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'abandoned');
});

// ——— duel-70 ledger ———

// pendingDuels aged an abandoned row by abandoned_at alone: a stale sweep stamp on a row whose
// death was RECORDED a minute ago hid it from the 7-day window immediately (duel-70 sol P2).
// The horizon takes the row's LATEST clock, mirroring the router's lastDead.
test('a fresh death record outranks a stale sweep stamp on the pending surface', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    abandoned_at, recorded_at) VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned',
    'abandoned', ?, ?)`).run(now - 10 * 86_400_000, now - 60_000);
  const p = pendingDuels(db, now);
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'abandoned');
});

// A pre-2.6.11 writer still running after the migration writes the OLD dead spelling — those
// rows are revivable in principle but were findable never: no recovery surface named them
// (duel-70 sol P2). The pending surface recognizes the legacy-dead shape while it is fresh.
test('a legacy-spelling double failure is listed on the pending surface while fresh', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by, recorded_at) VALUES ('implementation-misc', 1, '[]', '{}', 'walkover', NULL,
    'walkover', ?)`).run(now - 60_000);
  const p = pendingDuels(db, now);
  assert.equal(p.length, 1);
  // Normalized at the recovery boundary: the raw row says 'walkover', but on every pending
  // surface that word means a SUCCESSFUL one-sided duel — and the declared PendingDuel type
  // never admitted it (duel-71, found by BOTH sides). The row's pending semantics are
  // 'abandoned': dead, revivable by id.
  assert.equal(p[0].status, 'abandoned');
  // The same row must not speak the other vocabulary in the aggregate: standings() counted it
  // a walkover while pending called it abandoned — one row, two stories, on the two surfaces
  // an operator compares (duel-73 opus F7).
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.equal(s.walkovers, 0);
});

// A union row closed one-sided is, by explicit design, the ONE closed state that stays open
// to new evidence (duel.ts replay; SKILL.md union step 7: record the recovered side on the
// SAME id) — yet pendingDuels matched no union status at all. The id a recovery needs was on
// no surface: hook line, mrctl status/standings and the MCP pending field all render
// pendingDuels, so the documented path was unfollowable once the routing transcript was gone
// (duel-74 opus F1). A union row missing a side is pending; the listing ages like the other
// dead shapes; the row itself stays recordable forever.
test('a one-sided union row is listed on the pending surface', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, union_mode,
    anth_output, recorded_at) VALUES ('deep-review', 1, '[]', '{}', 'union', 1, 'report', ?)`)
    .run(now - 60_000);
  const p = pendingDuels(db, now);
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'union');
  assert.equal(p[0].union, true);
  assert.equal(p[0].reJudgeable, false); // a union row is never judged
  // duel 391 M15: a one-sided run counts as a run AND says so — 102 = 94 + 8 was arithmetic
  // the operator had to redo by hand
  const s = standings(db).find(k => k.kind === 'deep-review')!;
  assert.equal(s.unionRuns, 1);
  assert.equal(s.unionOneSided, 1);
});

// Duel 391 M14: one-sided unions whose missing side DIED AT SPAWN (its env recorded, no
// session artifact anywhere) were listed for seven days exactly like a hung lane whose
// rollout exists — "recoverable" with nothing to recover. The listing now names the missing
// side and whether its death was recorded.
test('a one-sided union listing names the missing side and whether its death was recorded', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  const ins = db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status,
    union_mode, anth_output, gpt_output, gpt_env, anth_env, recorded_at)
    VALUES ('deep-review', 1, '[]', '{}', 'union', 1, ?, ?, ?, ?, ?)`);
  ins.run('report', null, 'CLAUDE-B-FAILED at spawn: 429', null, now - 60_000);
  ins.run('report', null, null, null, now - 60_000);
  ins.run(null, 'report', null, 'hung', now - 60_000);
  ins.run('report', 'report', null, null, now - 60_000); // fully landed: not pending
  const p = pendingDuels(db, now);
  assert.deepEqual(p.map(r => r.missing), [
    [{ vendor: 'openai', deathRecorded: true }],
    [{ vendor: 'openai', deathRecorded: false }],
    [{ vendor: 'anthropic', deathRecorded: true }],
  ]);
  // non-union pending rows carry no missing list — the field is a union recovery fact
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status)
    VALUES ('implementation-misc', 1, '[]', '{}', 'routed')`).run();
  assert.equal(pendingDuels(db, now).at(-1)!.missing, undefined);
});

// The all-blank shape (2.6.0–2.6.4 era double failure stored as status='union', nothing
// landed) was invisible to pending AND counted as a completed run in unionRuns — one row,
// two stories, the walkover twin duel-73 opus F7 closed (duel-74 opus F1, second shape).
test('an all-blank union row is pending, not a completed union run', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, union_mode,
    recorded_at) VALUES ('deep-review', 1, '[]', '{}', 'union', 1, ?)`).run(now - 60_000);
  const p = pendingDuels(db, now);
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'union');
  const s = standings(db).find(k => k.kind === 'deep-review')!;
  assert.equal(s.unionRuns, 0);
});

// The other direction must not regress: a fully-landed union is DONE (both reports shipped,
// nothing to recover) and it is exactly what unionRuns counts.
test('a fully-landed union row is not pending and still counts as a union run', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, union_mode,
    anth_output, gpt_output, recorded_at) VALUES ('deep-review', 1, '[]', '{}', 'union', 1,
    'report A', 'report B', ?)`).run(now - 60_000);
  assert.equal(pendingDuels(db, now).length, 0);
  const s = standings(db).find(k => k.kind === 'deep-review')!;
  assert.equal(s.unionRuns, 1);
  assert.equal(s.unionOneSided, 0);
});

// The LISTING ages out on the same 7-day horizon as every other dead shape — the row is
// still open to record_duel forever, only the surface stops repeating it.
test('a one-sided union listing ages out of the pending window', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, union_mode,
    anth_output, recorded_at) VALUES ('deep-review', 1, '[]', '{}', 'union', 1, 'report', ?)`)
    .run(now - 8 * 86_400_000);
  assert.equal(pendingDuels(db, now).length, 0);
});

// A displaced sitter's tombstone was indistinguishable from a genuine corpse on every later
// pending surface: the superseded consumer rule (revive-or-leave-alone, f70d986) lived only
// on the record_duel response, which dies with the turn that produced it. The next session's
// controller, following the generic both-failed recovery, rewrote the tombstone — decided_by
// respelled, clocks advanced, pending horizon restarted (duel-74 sol F1). The listing now
// carries the displacement so the conditional rule is followable where the decision is made.
test('a displaced tombstone is marked on the pending surface', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    superseded_by, abandoned_at) VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned',
    'superseded', 2, ?)`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    abandoned_at) VALUES ('debugging', 1, '[]', '{}', 'abandoned', 'abandoned', ?)`)
    .run(now - 60_000);
  const p = pendingDuels(db, now);
  assert.equal(p.length, 2);
  assert.equal(p[0].supersededBy, 2);
  assert.equal(p[1].supersededBy, null);
});

// The tombstone has TWO writers across schema generations: a current writer stamps the column
// AND the `decided_by='superseded'` spelling; a pre-2.6.12 writer (the column is absent from
// its code, and it was added with no backfill by design) stamps only the spelling. The router's
// lastDead tests both for exactly this reason — the pending surface keyed on the column alone,
// so the legacy class arrived unmarked and the generic both-failed recovery rewrote the
// tombstone: decided_by respelled, clocks advanced, dying-audit backoff re-armed against an
// audit that SUCCEEDED (duel-75 opus F1; the duel-73/74 harms through the one writer
// generation the duel-74 fix did not cover).
test('a tombstone is marked whichever writer generation stamped it', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  const rows: Array<[kind: string, decidedBy: string, supersededBy: number | null,
    displaced: boolean]> = [
    ['architecture-design', 'superseded', 2, true],     // current schema: both markers
    ['implementation-misc', 'superseded', null, true],       // pre-2.6.12 writer: spelling only
    ['debugging', 'abandoned', null, false],            // genuine corpse: neither
  ];
  for (const [kind, decidedBy, supersededBy] of rows) {
    db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
      superseded_by, abandoned_at) VALUES (?, 1, '[]', '{}', 'abandoned', ?, ?, ?)`)
      .run(kind, decidedBy, supersededBy, now - 60_000);
  }
  const p = pendingDuels(db, now);
  assert.equal(p.length, rows.length);
  rows.forEach(([kind, , supersededBy, displaced], i) => {
    assert.equal(p[i].kind, kind);
    assert.equal(p[i].displaced, displaced, `${kind}: displaced`);
    assert.equal(p[i].supersededBy, supersededBy, `${kind}: supersededBy`);
  });
  // replay: the surface is a pure read — asking again changes nothing
  assert.deepEqual(pendingDuels(db, now), p);
});

// Composed scenario (process rule 2): both duel-74 pending-surface closures share the
// PendingDuel projection and its SELECT — assert them applied together, one database.
test('a union recovery row and a displaced tombstone coexist on one pending surface', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, union_mode,
    anth_output, recorded_at) VALUES ('deep-review', 1, '[]', '{}', 'union', 1, 'report', ?)`)
    .run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    superseded_by, abandoned_at) VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned',
    'superseded', 1, ?)`).run(now - 60_000);
  const p = pendingDuels(db, now);
  assert.equal(p.length, 2);
  assert.equal(p[0].status, 'union');
  assert.equal(p[0].supersededBy, null);
  assert.equal(p[0].displaced, false); // a union missing a side is recoverable, not a tombstone
  assert.equal(p[1].status, 'abandoned');
  assert.equal(p[1].supersededBy, 1);
  assert.equal(p[1].displaced, true);
  assert.equal(p[1].reJudgeable, false); // a tombstone holds no judgeable packet
});

// ——— latency margins ———

// A clock win's COUNT says nothing about its size: five one-second wins and one four-minute win
// are the same 5–1 record and forty-eight times apart in the time actually saved. The margin is
// read off the two stored clocks, one pass for both the totals and the medians.
test('latencyMargins totals and medians every clock win, and nets every judged duel', () => {
  const row = (decidedBy: string, winner: string | null, anth: number, gpt: number) =>
    ({ decidedBy, winner, anth, gpt });
  const m = latencyMargins([
    row('latency', 'anthropic', 1_000, 2_000),   // anth saved 1s
    row('latency', 'anthropic', 1_000, 2_000),   // anth saved 1s
    row('latency', 'anthropic', 3_000, 243_000), // anth saved 4m — the outlier
    row('latency', 'openai', 5_000, 1_000),      // gpt saved 4s
    row('judges', 'anthropic', 9_000, 1_000),    // quality win, slower: nets against anth
  ]);
  assert.deepEqual(m, {
    anthLatencySavedMs: 242_000,   // 1000 + 1000 + 240000
    gptLatencySavedMs: 4_000,
    anthLatencyMedianMs: 1_000,    // three margins: 1000, 1000, 240000
    gptLatencyMedianMs: 4_000,     // one margin is its own median
    netLatencyMs: 230_000,         // (2000-1000)+(2000-1000)+(243000-3000)+(1000-5000)+(1000-9000)
  });
});

// Even counts take the mean of the two middles, rounded to whole milliseconds — the clocks are
// integers and half a millisecond is not a measurement.
test('an even number of clock wins takes the mean of the two middle margins', () => {
  const m = latencyMargins([
    { decidedBy: 'latency', winner: 'anthropic', anth: 0, gpt: 1_000 },
    { decidedBy: 'latency', winner: 'anthropic', anth: 0, gpt: 1_001 },
    { decidedBy: 'latency', winner: 'anthropic', anth: 0, gpt: 4 },
    { decidedBy: 'latency', winner: 'anthropic', anth: 0, gpt: 9 },
  ]);
  assert.equal(m.anthLatencyMedianMs, 505); // middles 9 and 1000 → 504.5, rounded
  assert.equal(m.anthLatencySavedMs, 2_014);
});

// Zero and null are different answers: a side with no clock win saved nothing (0), and there is
// no margin to take a median OF (null). An empty group has no net to report either.
test('a side with no clock win reports zero saved and a null median', () => {
  const m = latencyMargins([{ decidedBy: 'judges', winner: 'anthropic', anth: 100, gpt: 400 }]);
  assert.deepEqual(
    { saved: m.anthLatencySavedMs, med: m.anthLatencyMedianMs, gmed: m.gptLatencyMedianMs },
    { saved: 0, med: null, gmed: null });
  assert.equal(m.netLatencyMs, 300); // the judge-decided row still nets
  assert.equal(latencyMargins([]).netLatencyMs, null); // nothing measured is not zero
});


// Table-driven per the repo's closure rules: current-schema clock duels, a judge-decided duel
// with clocks, a legacy row with no clocks at all, and the terminal no-winner shapes — one
// window, one assertion set, so no two of them can cancel out unnoticed.
test('standings reports the margin of every clock win in the current window', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  clock(db, 'implementation-misc', 'anthropic', 1_000, 2_000);   // anth saved 1s
  clock(db, 'implementation-misc', 'anthropic', 1_000, 2_000);   // anth saved 1s
  clock(db, 'implementation-misc', 'anthropic', 3_000, 243_000); // anth saved 4m
  clock(db, 'implementation-misc', 'openai', 5_000, 1_000);      // gpt saved 4s
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(
    { al: s.anthLatencyWins, gl: s.gptLatencyWins,
      aSaved: s.anthLatencySavedMs, gSaved: s.gptLatencySavedMs,
      aMed: s.anthLatencyMedianMs, gMed: s.gptLatencyMedianMs, net: s.netLatencyMs },
    { al: 3, gl: 1, aSaved: 242_000, gSaved: 4_000, aMed: 1_000, gMed: 4_000, net: 238_000 });
  // replay: the surface is a pure read — asking twice returns the same numbers
  assert.deepEqual(standings(db), standings(db));
});

// netLatencyMs covers the duels the saved totals deliberately ignore: a side can win on quality
// while being the slower one, and that costs wall-clock the clock channel never records.
test('a quality win by the slower side shows up in the net, not in the saved total', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  judged(db, 'debugging', 'anthropic', 0, 1, 9_000, 9_000, 40_000, 10_000); // anth won, 30s slower
  const s = standings(db).find(k => k.kind === 'debugging')!;
  assert.deepEqual(
    { wins: s.anthWins, jw: s.anthJudgeWins, lw: s.anthLatencyWins,
      saved: s.anthLatencySavedMs, med: s.anthLatencyMedianMs, net: s.netLatencyMs },
    { wins: 1, jw: 1, lw: 0, saved: 0, med: null, net: -30_000 });
});

// Legacy shape: a pre-latency-column row stores no clocks. It stays in `judged` (unchanged), and
// it must neither contribute a phantom zero to the net nor blank out the kinds that DO measure.
test('a judged row with no stored clocks is counted but never measured', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  judgedBy(db, 'debugging', 'anthropic', 'judges');                       // no clocks at all
  judgedBy(db, 'architecture-design', 'anthropic', 'judges');             // the only row there
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
    status, winner_vendor, decided_by, anth_tokens, gpt_tokens, anth_latency_ms, gpt_latency_ms)
    VALUES ('debugging', 1, 0, 0, '[]', '{"X":"anthropic","Y":"openai"}', 'judged',
      'openai', 'tokens', 9000, 5000, 12000, 8000)`).run();
  clock(db, 'debugging', 'openai', 8_000, 3_000);                         // 5s to gpt
  const s = standings(db).find(k => k.kind === 'debugging')!;
  assert.equal(s.judged, 3);            // both legacy rows still count as judged duels
  assert.equal(s.netLatencyMs, -9_000); // the clockless row contributes nothing; tokens nets -4s
  assert.equal(s.gptLatencySavedMs, 5_000);
  assert.equal(s.anthLatencyMedianMs, null);
  assert.equal(s.gptLatencyMedianMs, 5_000);
  const bare = standings(db).find(k => k.kind === 'architecture-design')!;
  assert.equal(bare.judged, 1);
  assert.equal(bare.netLatencyMs, null); // nothing measured is not zero
  assert.equal(bare.anthLatencyMedianMs, null);
});

// Terminal no-winner rows (v2.11.0 contested / both_failed, status='unresolved') and walkovers
// leave the judged bucket on every other counter; they are not time saved either.
test('terminal no-winner rows and walkovers are not time saved', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  for (const by of ['contested', 'both_failed']) {
    db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
      decided_by, anth_latency_ms, gpt_latency_ms)
      VALUES ('bulk-mechanical', 1, '[]', '{}', 'unresolved', NULL, ?, 1000, 90000)`).run(by);
  }
  walkover(db, 'bulk-mechanical');
  const s = standings(db).find(k => k.kind === 'bulk-mechanical')!;
  assert.deepEqual(
    { judged: s.judged, walkovers: s.walkovers, net: s.netLatencyMs,
      aSaved: s.anthLatencySavedMs, aMed: s.anthLatencyMedianMs },
    { judged: 0, walkovers: 1, net: null, aSaved: 0, aMed: null });
});

// A settings change retires an era; its time savings retire with it. Every duel counts in exactly
// one row of the one-table view, and the margins must obey that partition too — otherwise a
// pairing swap either erases the old era's saved time or double-counts it on the current row.
test('a retired era keeps the margins of the duels it actually ran', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  clock(db, 'implementation-misc', 'anthropic', 1_000, 61_000, 2); // old era: anth saved 60s
  clock(db, 'implementation-misc', 'openai', 4_000, 2_000, 2);     // old era: gpt saved 2s
  // a judge-decided old-era duel: it nets but grows no margin, so the retired path has to read the
  // same rule as the current window — saved totals and medians below are unmoved by this row.
  judged(db, 'implementation-misc', 'anthropic', 0, 2, 9_000, 9_000, 10_000, 4_000); // 6s slower
  setVendorModel(db, 'implementation-misc', 'openai', 'gpt-5.6-terra', 'xhigh', 5);
  clock(db, 'implementation-misc', 'openai', 9_000, 4_000, 6);     // current era: gpt saved 5s
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(
    { saved: s.gptLatencySavedMs, med: s.gptLatencyMedianMs, aSaved: s.anthLatencySavedMs,
      net: s.netLatencyMs },
    { saved: 5_000, med: 5_000, aSaved: 0, net: -5_000 }); // current window only
  assert.equal(s.retired.length, 1);
  const rec = s.retired[0];
  assert.deepEqual(
    { aSaved: rec.anthLatencySavedMs, gSaved: rec.gptLatencySavedMs,
      aMed: rec.anthLatencyMedianMs, gMed: rec.gptLatencyMedianMs, net: rec.netLatencyMs },
    { aSaved: 60_000, gSaved: 2_000, aMed: 60_000, gMed: 2_000, net: 52_000 });
});

// The latency columns are declared INTEGER, but SQLite is dynamically typed: rows written
// before v2.13.2's integer normalization (or restored from a pre-v12 backup) hold fractional
// REALs, and the reader stays tolerant of them — synthetic fixtures keep that deterministic.
// The reader reports whole milliseconds anyway: rounding once at the end, on every statistic, so
// the operator never reads 83248.10546875 off a surface that means "how much time did this save".
test('fractional stored clocks are reported as whole milliseconds', () => {
  const m = latencyMargins([
    { decidedBy: 'latency', winner: 'anthropic', anth: 1_000.4, gpt: 2_000.9 },   // margin 1000.5
    { decidedBy: 'latency', winner: 'anthropic', anth: 10.25, gpt: 12.75 },       // margin 2.5
    { decidedBy: 'judges', winner: 'openai', anth: 5.5, gpt: 1.25 },              // nets -4.25
  ]);
  assert.deepEqual(
    { saved: m.anthLatencySavedMs, med: m.anthLatencyMedianMs, net: m.netLatencyMs },
    { saved: 1_003, med: 502, net: 999 });
  // odd counts round too — the old code returned the middle element untouched
  assert.equal(latencyMargins([
    { decidedBy: 'latency', winner: 'openai', anth: 9.6, gpt: 1.1 },
  ]).gptLatencyMedianMs, 9);
});

// pendingDuels is the operator's live surface, so its skew question is the LIVE one: was this
// row minted by a build other than the one answering right now? Absent otherwise — every clean
// row keeps the shape existing consumers already parse.
test('pending rows name a mint-versus-running-server skew, and nothing else', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const ins = (minted: string | null) => Number(db.prepare(
    `INSERT INTO duels(task_kind, created_at, sides, label_map, status, minted_by_version)
     VALUES ('implementation-misc', 1, '[]', '{}', 'routed', ?)`).run(minted).lastInsertRowid);
  const stale = ins('2.13.19');
  const current = ins(pluginVersion());
  const legacy = ins(null);
  const p = pendingDuels(db, 2);
  assert.equal(p.find(r => r.id === stale)!.versions,
    `minted v2.13.19, server v${pluginVersion()}`);
  assert.equal('versions' in p.find(r => r.id === current)!, false);
  assert.equal('versions' in p.find(r => r.id === legacy)!, false);
});

// v2.13.28: GPA. Grades map to points through the duel's OWN label_map (a grade_x belongs to
// whichever vendor X was in that duel), split by grading judge because the two judges'
// calibrations are known to differ — one blended number would smear exactly the bias the
// operator needs to see.
function gradedVote(db: any, duelId: number, judgeVendor: string, gx: string | null,
  gy: string | null, verdict = 'both') {
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded,
    grade_x, grade_y) VALUES (?, ?, ?, 1, 1, ?, ?)`)
    .run(duelId, judgeVendor, verdict, gx, gy);
}
function lastDuelId(db: any): number {
  return Number(db.prepare('SELECT MAX(id) m FROM duels').get().m);
}

test('standings reports GPA per side, overall and split by grading judge', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  judged(db, 'implementation-misc', 'openai');            // label_map X=anthropic
  const d1 = lastDuelId(db);
  gradedVote(db, d1, 'anthropic', 'A', 'B');              // anth 4.0, gpt 3.0
  gradedVote(db, d1, 'openai', 'B+', 'A-');               // anth 3.3, gpt 3.7
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
    status, winner_vendor, decided_by)
    VALUES ('implementation-misc', 1, 0, 0, '[]', '{"X":"openai","Y":"anthropic"}',
    'judged', 'anthropic', 'judges')`).run();             // flipped labels
  const d2 = lastDuelId(db);
  gradedVote(db, d2, 'anthropic', 'F', 'A+');             // gpt 0, anth 4.3
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(s.gpa, {
    anth: { overall: 3.87, byAnthJudge: 4.15, byGptJudge: 3.3 },
    gpt: { overall: 2.23, byAnthJudge: 1.5, byGptJudge: 3.7 },
    gradedVotes: 3,
  });
});

test('ungraded votes and kinds without grades report a null GPA, not zero', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  judged(db, 'implementation-misc', 'openai');
  const d = lastDuelId(db);
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded)
    VALUES (?, 'anthropic', 'both', 1, 1)`).run(d);      // graded-vocabulary vote, no letters
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(s.gpa, {
    anth: { overall: null, byAnthJudge: null, byGptJudge: null },
    gpt: { overall: null, byAnthJudge: null, byGptJudge: null },
    gradedVotes: 0,
  });
});

test('GPA covers the current contest window only — pre-settings-change grades retire', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  judged(db, 'implementation-misc', 'openai', 0, 1);      // created_at 1
  const old = lastDuelId(db);
  gradedVote(db, old, 'anthropic', 'F', 'F');
  setVendorModel(db, 'implementation-misc', 'openai', 'gpt-5.6-terra', 'xhigh', 5);
  judged(db, 'implementation-misc', 'openai', 0, 9);      // created_at 9, inside new window
  const cur = lastDuelId(db);
  gradedVote(db, cur, 'anthropic', 'A', 'A');
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(s.gpa.anth, { overall: 4, byAnthJudge: 4, byGptJudge: null });
  assert.equal(s.gpa.gradedVotes, 1);
});

// v2.13.29: a merged ship is a judged terminal row with NO winner — counted per kind so the
// operator sees how often the best answer was the composition, credited to nobody's wins.
test('standings counts merged ships in the window without crediting a win', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  judgedBy(db, 'implementation-misc', null as any, 'merge');
  judged(db, 'implementation-misc', 'openai');
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.deepEqual(
    { judged: s.judged, anthWins: s.anthWins, gptWins: s.gptWins, merged: s.mergedShips },
    { judged: 2, anthWins: 0, gptWins: 1, merged: 1 });
});
