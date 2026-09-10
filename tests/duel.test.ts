import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { seedMatrix } from '../src/matrix.js';
import { createDuel, recordResults, recordJudgment, getDuel, scrubIdentity, DUEL_TTL_MS, expireStaleDuels, FACT_CHECK_OFFER } from '../src/duel.js';
import { standings, pendingDuels } from '../src/standings.js';
import { pluginVersion } from '../src/version.js';
import type { Side } from '../src/types.js';

const SIDES: [Side, Side] = [
  { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
  { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
];
const ok = (output: string, tokens: number, latencyMs: number) =>
  ({ output, tokens, latencyMs, failed: false });
const FAILED = { output: null, tokens: null, latencyMs: null, failed: true };
// attestation off here — judgment mechanics under test; proof checks live in proof.test.ts
const NOPROOF = { roots: { B: null, codex: null } };
const rec: typeof recordResults = (db, id, results, opts = NOPROOF) =>
  recordResults(db, id, results, opts);
const judge = (db: any, id: number, vendor: 'anthropic' | 'openai', verdict: any, now: number,
  opts: Parameters<typeof recordJudgment>[5] = NOPROOF) =>
  recordJudgment(db, id, vendor, verdict, now, opts);

test('full duel: results → blinded packet → two judgments → judged', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  const res = rec(db, id, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) });
  assert.equal(res.status, 'awaiting_judgment');
  if (res.status !== 'awaiting_judgment') return;
  // packet is blind: outputs present under X/Y, no vendor names
  assert.deepEqual([res.packet.X, res.packet.Y].sort(), ['anth out', 'gpt out']);

  const labelMap = JSON.parse(getDuel(db, id).label_map);
  const anthLabel = labelMap.X === 'anthropic' ? 'X' : 'Y';
  assert.deepEqual(judge(db, id, 'anthropic', anthLabel as any, 2), { status: 'awaiting_judgment' });
  const fin = judge(db, id, 'openai', anthLabel as any, 3);
  assert.equal(fin.status, 'judged');
  if (fin.status !== 'judged') return;
  assert.equal(fin.winner, 'anthropic');
  assert.equal(fin.decidedBy, 'judges');
  assert.equal(getDuel(db, id).status, 'judged');
});

// v2.11.0 shipped the resolver's gate branch and promised the columns "in the next commit";
// they never landed, so for three releases SKILL told the operator a failed gate overrides any
// judge vote while gateOf() could only read undefined. End-to-end because the unit test in
// scoring.test.ts passed a gate the production path had no way to supply.
test('a controller gate FAIL overrides a judge vote that passed the side', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: true, spotCheck: false }, 1);
  rec(db, id, {
    anthropic: { ...ok('anth out', 500, 100), gate: 'fail', gateDetail: 'node tests/t.js 9/1' },
    openai: { ...ok('gpt out', 1000, 90), gate: 'pass', gateDetail: 'node tests/t.js 10/0' },
  });
  const d = getDuel(db, id);
  assert.equal(d.anth_gate, 'fail');
  assert.equal(d.gpt_gate, 'pass');
  // Both judges pass BOTH sides; only the gate separates them.
  judge(db, id, 'anthropic', 'both', 2);
  const fin = judge(db, id, 'openai', 'both', 3);
  assert.equal(fin.status, 'judged');
  if (fin.status !== 'judged') return;
  assert.equal(fin.winner, 'openai');
});

// v2.13.50: duel 298's gates recorded a bare 'pass' while Y's tree failed its repo's own r12
// suite — too-narrow gate coverage was invisible behind the token. A gate records only WITH its
// receipts: gate_detail names the commands run and their pass/fail counts, stored per side for
// the ledger and the judge package.
test('gate rides with its receipts: gate_detail stored per side, replay keeps it', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-build', SIDES, { mutating: true, spotCheck: false }, 1);
  rec(db, id, {
    anthropic: { ...ok('a', 20000, 100), gate: 'pass',
      gateDetail: 'node tests/foundations.js 128/0; node tests/fetchers.js 51/0' },
    openai: { ...ok('b', 9000, 500), gate: 'fail',
      gateDetail: 'node tests/foundations.js 127/1 (r12 enum vocabularies)' },
  });
  const d = getDuel(db, id);
  assert.equal(d.anth_gate, 'pass');
  assert.equal(d.anth_gate_detail, 'node tests/foundations.js 128/0; node tests/fetchers.js 51/0');
  assert.equal(d.gpt_gate, 'fail');
  assert.equal(d.gpt_gate_detail, 'node tests/foundations.js 127/1 (r12 enum vocabularies)');
  // idempotent replay: landed sides are immutable, receipts included
  rec(db, id, { anthropic: ok('a', 1, 1), openai: ok('b', 1, 1) });
  assert.equal(getDuel(db, id).anth_gate_detail,
    'node tests/foundations.js 128/0; node tests/fetchers.js 51/0');
});

test('a gate token without gate_detail is refused and writes nothing', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-build', SIDES, { mutating: true, spotCheck: false }, 1);
  assert.throws(() => rec(db, id, {
    anthropic: { ...ok('a', 20000, 100), gate: 'pass' },
    openai: ok('b', 9000, 500),
  }), /gate_detail/);
  assert.equal(getDuel(db, id).status, 'routed');
  // legacy shape: no gate at all (read-only kinds, pre-v2.13.50 flows) still needs no receipts
  const fin = rec(db, id, { anthropic: ok('a', 20000, 100), openai: ok('b', 9000, 500) });
  assert.equal(fin.status, 'awaiting_judgment');
});

// composed (v2.13.49 + v2.13.50): head-on X/Y votes over two RED gates resolve both_failed —
// ground truth outranks the split — so no fact-check offer rides the reply; there is nothing
// judge-side left to check.
test('composed: head-on votes over two failed gates resolve both_failed with no offer', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-build', SIDES, { mutating: true, spotCheck: false }, 1);
  rec(db, id, {
    anthropic: { ...ok('a', 20000, 100), gate: 'fail', gateDetail: 'node tests/t.js 10/2' },
    openai: { ...ok('b', 9000, 500), gate: 'fail', gateDetail: 'node tests/t.js 9/3' },
  });
  judge(db, id, 'anthropic', 'X', 2);
  const fin = judge(db, id, 'openai', 'Y', 3) as any;
  assert.equal(fin.decidedBy, 'both_failed');
  assert.equal(fin.factCheck, undefined);
  const replay = judge(db, id, 'openai', 'Y', 4) as any;
  assert.equal(replay.factCheck, undefined);
});

test('no recorded gate leaves resolution exactly as it was', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 9000, 100), openai: ok('gpt out', 8000, 90) });
  const d = getDuel(db, id);
  assert.equal(d.anth_gate, null); // read-only kind: not applicable, never a failure
  assert.equal(d.gpt_gate, null);
  judge(db, id, 'anthropic', 'both', 2);
  const fin = judge(db, id, 'openai', 'both', 3);
  assert.equal(fin.status, 'judged');
  if (fin.status !== 'judged') return;
  assert.equal(fin.decidedBy, 'latency'); // both passed, the clock separates them
  assert.equal(fin.winner, 'openai');
});

// Duel 212: a brief defect reached BOTH sides (mandated .parquet into a venv with no pyarrow),
// so the controller voided the round and re-minted it as 213. The row then sat on the pending
// surface for a week reading `abandoned, revivable by id` with no stored reason, while SKILL
// tells a later session to revive exactly that shape — which would have scored a round thrown
// away on purpose, against work 213 had already shipped.
test('a voided round is tombstoned and never reads as revivable', () => {
  const db = openDb(':memory:');
  const dead = createDuel(db, 'implementation-misc', SIDES, { mutating: true, spotCheck: false }, 1);
  const reduel = createDuel(db, 'implementation-misc', SIDES, { mutating: true, spotCheck: false }, 2);
  rec(db, dead, {
    anthropic: { ...FAILED, environment: 'VOID: brief mandated .parquet, no pyarrow in venv' },
    openai: { ...FAILED, environment: 'VOID: side stopped BLOCKED-SCOPE, claim verified' },
  }, { ...NOPROOF, supersededBy: reduel });
  const d = getDuel(db, dead);
  assert.equal(d.status, 'abandoned');
  assert.equal(d.decided_by, 'superseded');
  assert.equal(d.superseded_by, reduel);
  assert.equal(d.death_recorded, 1);

  const row = pendingDuels(db, 3).find(r => r.id === dead)!;
  assert.equal(row.displaced, true);
  assert.equal(row.voided, true); // death_recorded is what separates a void from a displacement
  assert.equal(row.supersededBy, reduel);
});

test('a displacement tombstone is not a void', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  // The displacement UPDATE never sets death_recorded — only a controller's own death record does.
  db.prepare("UPDATE duels SET status='abandoned', decided_by='superseded', superseded_by=?, "
    + 'abandoned_at=? WHERE id=?').run(id + 1, 2, id);
  const row = pendingDuels(db, 3).find(r => r.id === id)!;
  assert.equal(row.displaced, true);
  assert.equal(row.voided, false);
});

test('a void marker on a row that is not dying is refused', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  const other = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 2);
  assert.throws(() => rec(db, id, {
    anthropic: ok('anth out', 9000, 100), openai: ok('gpt out', 8000, 90),
  }, { ...NOPROOF, supersededBy: other }), /has a side that landed/);
  assert.throws(() => rec(db, id, { anthropic: FAILED, openai: FAILED },
    { ...NOPROOF, supersededBy: id }), /cannot supersede itself/);
  assert.throws(() => rec(db, id, { anthropic: FAILED, openai: FAILED },
    { ...NOPROOF, supersededBy: 9999 }), /not a duel id/);
});

test('a judge rationale is scrubbed on the way into the ledger', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 9000, 100), openai: ok('gpt out', 8000, 90) });
  judge(db, id, 'anthropic', 'both', 2, {
    ...NOPROOF,
    rationale: 'X wrote /home/x/.claude-b/projects/p/s.jsonl; Y handles the codex lane right.',
  });
  const r = db.prepare('SELECT rationale FROM judgments WHERE duel_id=?').get(id) as
    { rationale: string };
  assert.ok(!r.rationale.includes('.claude-b'), 'the lane path is a tell and must not persist');
  // Subject-matter prose survives: duels on THIS repo are about routing between vendors.
  assert.match(r.rationale, /handles the codex lane right/);
});

test('a float latency claim is stored rounded to integer ms', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, {
    anthropic: { output: 'a', tokens: 500, latencyMs: 800061.316894531, failed: false },
    openai: { output: 'b', tokens: 1000, latencyMs: 867980.5605, failed: false },
  });
  const d = getDuel(db, id);
  assert.equal(d.anth_latency_ms, 800061);
  assert.equal(d.gpt_latency_ms, 867981);
});

// duel-207 P2 (both sides): bounds must hold for the STORED integer, so claims round before
// validation. A sub-ms claim used to pass the positivity gate and land as 0 — an absolute
// clock-channel win (every reader checks null, then <).
test('a sub-millisecond latency claim is refused, not stored as 0', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  assert.throws(() => rec(db, id, {
    anthropic: { output: 'a', tokens: 500, latencyMs: 0.4, failed: false },
    openai: { output: 'b', tokens: 1000, latencyMs: 1000, failed: false },
  }), /latency_ms=0 /);
  assert.equal(getDuel(db, id).status, 'routed'); // refused whole — re-record with a real clock
});

// Composed with the v12 migration (both fixes touch latency_ms): legacy fractional rows round
// on open, and a fresh record on the migrated DB stores integers — pre-state → migrate →
// replay → write path, in one scenario.
test('v12 rounds legacy float clocks and the write path stays integer — composed, with replay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-duel-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // pre-state: pre-2.13.2 auto-measure landed fractional REALs in the INTEGER clock columns
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by, anth_latency_ms, gpt_latency_ms) VALUES ('default', 1000, '[]', '{}', 'judged',
    'anthropic', 'latency', 800061.316894531, 867980.5605)`);
  pre.exec('PRAGMA user_version = 11'); // as if written by 2.13.4
  pre.close();

  const db = openDb(path); // v12 runs
  const legacy = db.prepare(
    'SELECT anth_latency_ms a, gpt_latency_ms g FROM duels').get() as any;
  assert.equal(legacy.a, 800061);
  assert.equal(legacy.g, 867981);
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE 'v12 migration rounded fractional latency on 1 duel row%'`).get());
  // the write path on the migrated DB: a fractional claim lands integer
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, {
    anthropic: { output: 'a', tokens: 500, latencyMs: 1234.6, failed: false },
    openai: { output: 'b', tokens: 1000, latencyMs: 4321.4, failed: false },
  });
  const d2 = getDuel(db, id);
  assert.equal(d2.anth_latency_ms, 1235);
  assert.equal(d2.gpt_latency_ms, 4321);
  const logCount = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  db.close();

  // idempotent replay: a second open finds nothing fractional and logs nothing
  const again = openDb(path);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c,
    logCount);
  again.close();
});

// v13 (duel-209 F1): v12's rounding is not injective — a latency-decided row whose rounded
// clocks tie kept its winner over a record that now reads as a tie. Composed with v12
// (fractional pre-state rounds, THEN reconciles, one open), table-driven over the row shapes
// a real DB can hold, with replay and the standings surface.
test('v13 turns a rounded-to-tie latency win into the tie spelling — composed with v12', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-duel-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const ins = (status: string, winner: string, decidedBy: string, a: number, g: number): void =>
    pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
      decided_by, anth_latency_ms, gpt_latency_ms) VALUES ('default', 1000, '[]', '{}',
      '${status}', ${winner}, '${decidedBy}', ${a}, ${g})`);
  ins('judged', "'anthropic'", 'latency', 1000.40, 1000.49); // collapses to a tie → reconciled
  ins('judged', "'openai'", 'latency', 800061.3, 867980.5);  // stays a real latency win
  ins('judged', "'anthropic'", 'judges', 500.2, 500.4);      // judge-decided: ties, untouched
  ins('unresolved', 'NULL', 'unresolved', 700, 700);         // already the tie spelling
  pre.exec('PRAGMA user_version = 11'); // as if written by 2.13.4 — v12 AND v13 both run
  pre.close();

  const db = openDb(path);
  const rows = (db.prepare(`SELECT status, winner_vendor w, decided_by d,
    anth_latency_ms a, gpt_latency_ms g FROM duels ORDER BY id`).all() as any[])
    .map((r) => ({ ...r })); // sqlite rows are null-prototype — strict deepEqual minds
  assert.deepEqual(rows[0], { status: 'unresolved', w: null, d: 'unresolved', a: 1000, g: 1000 });
  assert.deepEqual(rows[1], { status: 'judged', w: 'openai', d: 'latency', a: 800061, g: 867981 });
  assert.deepEqual(rows[2], { status: 'judged', w: 'anthropic', d: 'judges', a: 500, g: 500 });
  assert.deepEqual(rows[3], { status: 'unresolved', w: null, d: 'unresolved', a: 700, g: 700 });
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE 'v13 migration reconciled 1 latency-decided duel row%'`).get());
  // public surface: standings no longer counts the reconciled row as an anthropic latency win
  const def = standings(db).find((s) => s.kind === 'default')!;
  assert.equal(def.anthLatencyWins, 0);
  assert.equal(def.gptLatencyWins, 1);
  assert.equal(def.anthJudgeWins, 1);
  const logCount = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  db.close();

  // idempotent replay: nothing left to reconcile, nothing logged
  const again = openDb(path);
  const replay = (again.prepare(`SELECT status, winner_vendor w FROM duels ORDER BY id`)
    .all() as any[]).map((r) => ({ ...r }));
  assert.deepEqual(replay, rows.map((r) => ({ status: r.status, w: r.w })));
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c,
    logCount);
  again.close();
});

// v2.11.0: a judge split is contested, so neither tokens nor latency may fabricate a winner.
test('judge disagreement is contested, not a latency or token tiebreak', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 20000, 100), openai: ok('b', 9000, 500) });
  judge(db, id, 'anthropic', 'X', 2);
  const fin = judge(db, id, 'openai', 'Y', 3);
  assert.deepEqual(fin,
    { status: 'unresolved', taskKind: 'implementation-misc', decidedBy: 'contested',
      factCheck: FACT_CHECK_OFFER });
  assert.equal(getDuel(db, id).winner_vendor, null);
});

// v2.13.49: a HEAD-ON split (verdicts X and Y) is usually one checkable factual claim, so the
// resolving reply carries the fact-check offer — and so does its replay, because the lost-reply
// retry is exactly the call whose offer would otherwise vanish (v2.13.48 left the round as
// SKILL prose the controller had to remember; duel 298's round was never offered).
test('head-on contested split carries the fact-check offer, replay included', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 20000, 100), openai: ok('b', 9000, 500) });
  judge(db, id, 'anthropic', 'X', 2);
  const fin = judge(db, id, 'openai', 'Y', 3) as any;
  assert.equal(fin.decidedBy, 'contested');
  assert.match(fin.factCheck, /fact-check round/);
  const replay = judge(db, id, 'openai', 'Y', 4) as any;
  assert.equal(replay.decidedBy, 'contested');
  assert.match(replay.factCheck, /fact-check round/);
});

// A neither-vs-X split is contested too, but there is no opposing factual claim to check —
// one judge failed BOTH sides — so no offer rides the reply, resolution or replay.
test('contested via neither-vs-X carries no fact-check offer', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 20000, 100), openai: ok('b', 9000, 500) });
  judge(db, id, 'anthropic', 'neither', 2);
  const fin = judge(db, id, 'openai', 'X', 3) as any;
  assert.equal(fin.decidedBy, 'contested');
  assert.equal(fin.factCheck, undefined);
  const replay = judge(db, id, 'openai', 'X', 4) as any;
  assert.equal(replay.factCheck, undefined);
});

test('one side failed → walkover for survivor, excluded semantics', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  const res = rec(db, id, { anthropic: FAILED, openai: ok('gpt out', 100, 50) });
  assert.deepEqual(res, { status: 'walkover', winner: 'openai' });
  assert.equal(getDuel(db, id).status, 'walkover');
  assert.equal(getDuel(db, id).decided_by, 'walkover');
});

// A non-union double failure was stored 'walkover', winner NULL, abandoned_at nulled: on no
// recovery surface (pendingDuels lists routed/awaiting/abandoned only) and non-revivable,
// while the router counted exactly those rows as dead audits — two subsystems disagreed about
// whether the death happened (duel-68 opus F6). It is the SAME death the union path records:
// 'abandoned', death-stamped, listed while fresh, revivable if the lanes really ran.
// Deliberate duel-68 update: this pin asserted the walkover shape.
test('both failed → abandoned with its death stamped, on the pending surface', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'x', SIDES, { mutating: false, spotCheck: false }, 1);
  const res = rec(db, id, { anthropic: FAILED, openai: FAILED });
  assert.equal(res.status, 'abandoned');
  const row = getDuel(db, id);
  assert.equal(row.status, 'abandoned');
  assert.equal(row.decided_by, 'abandoned');
  assert.ok(row.abandoned_at != null, 'the record that IS the death stamps it');
  const p = pendingDuels(db, row.abandoned_at + 1);
  assert.equal(p.length, 1); // the fresh corpse stays listed — revivable by id
  assert.equal(p[0].reJudgeable, false);
});

test('duplicate same-vendor judgment does not resolve; second distinct vendor still decides', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) });
  const first = judge(db, id, 'anthropic', 'X', 2);
  assert.deepEqual(first, { status: 'awaiting_judgment' });
  const dup = judge(db, id, 'anthropic', 'Y', 3); // same vendor, different verdict
  assert.deepEqual(dup, { status: 'awaiting_judgment' });
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
  const fin = judge(db, id, 'openai', 'X', 4); // second DISTINCT vendor resolves
  assert.equal(fin.status, 'judged');
});

test('recordJudgment on a duel not awaiting judgment throws', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  assert.throws(() => judge(db, id, 'anthropic', 'X', 2), /not awaiting judgment/);
});

test('re-recording the resolving judgment replays the resolution instead of throwing', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) });
  judge(db, id, 'anthropic', 'X', 2);
  const fin = judge(db, id, 'openai', 'X', 3);
  // the response was lost in transit; the controller retries the same call. Throwing here
  // hid the stored resolution from the caller forever.
  assert.deepEqual(judge(db, id, 'openai', 'X', 4), fin);
  assert.equal(getDuel(db, id).status, 'judged');
});

test('an unresolved duel replays as unresolved', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, {
    anthropic: { output: 'a', tokens: 9500, latencyMs: 100, failed: false },
    openai: { output: 'b', tokens: 9000, latencyMs: null, failed: false },
  });
  judge(db, id, 'anthropic', 'X', 2);
  judge(db, id, 'openai', 'Y', 3);
  // v2.11.0: replay includes the terminal quality reason, not only the broad status bucket.
  assert.deepEqual(judge(db, id, 'openai', 'Y', 4),
    { status: 'unresolved', taskKind: 'implementation-misc', decidedBy: 'contested',
      factCheck: FACT_CHECK_OFFER });
});

test('recordResults on a duel that already has results throws and leaves winner untouched', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) });
  judge(db, id, 'anthropic', 'X', 2);
  judge(db, id, 'openai', 'X', 3); // judged now
  const before = getDuel(db, id).winner_vendor;
  assert.throws(
    () => rec(db, id, { anthropic: ok('a2', 1, 1), openai: ok('b2', 1, 1) }),
    /already has results/);
  assert.equal(getDuel(db, id).winner_vendor, before);
});

test('judge disagreement with token near-tie and null latency leaves duel unresolved — excluded from standings', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, {
    anthropic: { output: 'a', tokens: 9500, latencyMs: 100, failed: false },
    openai: { output: 'b', tokens: 9000, latencyMs: null, failed: false },
  });
  judge(db, id, 'anthropic', 'X', 2);
  const fin = judge(db, id, 'openai', 'Y', 3);
  // v2.11.0: split grades are contested before the clock, even when one latency is missing.
  assert.deepEqual(fin,
    { status: 'unresolved', taskKind: 'implementation-misc', decidedBy: 'contested',
      factCheck: FACT_CHECK_OFFER });
  const d = getDuel(db, id);
  assert.equal(d.status, 'unresolved');
  assert.equal(d.winner_vendor, null);
  assert.equal(d.decided_by, 'contested');
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.equal(s.judged, 0);
  assert.equal(s.anthWins, 0);
  assert.equal(s.gptWins, 0);
});

test('a crash between the second judgment and the duel update does not strand the duel', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) });
  judge(db, id, 'anthropic', 'X', 2);
  // simulate the crash: judgment 2 is committed, the duel row never got updated
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded)
    VALUES (?,?,?,?,1)`).run(id, 'openai', 'X', 3);
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
  const retry = judge(db, id, 'openai', 'X', 4); // controller retries after the crash
  assert.equal(retry.status, 'judged');
  assert.equal(getDuel(db, id).status, 'judged');
});

test('a single X grade plus both is a judges decision, not a token tiebreak', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  // anthropic is far more expensive: the old unanimity rule handed this to openai on tokens
  rec(db, id, { anthropic: ok('a', 2000, 100), openai: ok('b', 900, 100) });
  const labelMap = JSON.parse(getDuel(db, id).label_map);
  const anthLabel = labelMap.X === 'anthropic' ? 'X' : 'Y';
  judge(db, id, 'anthropic', anthLabel as any, 2);
  // v2.11.0: `both` is the absolute-grade spelling that clears both sides.
  const fin = judge(db, id, 'openai', 'both', 3);
  assert.equal(fin.status, 'judged');
  if (fin.status !== 'judged') return;
  assert.equal(fin.winner, 'anthropic');
  assert.equal(fin.decidedBy, 'judges');
});

test('judges split with identical metrics is unresolved, not a free anthropic win', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 1000, 100), openai: ok('b', 1000, 100) });
  judge(db, id, 'anthropic', 'X', 2);
  const fin = judge(db, id, 'openai', 'Y', 3);
  // v2.11.0: a judge split is contested; identical clocks cannot create a default winner.
  assert.deepEqual(fin,
    { status: 'unresolved', taskKind: 'implementation-misc', decidedBy: 'contested',
      factCheck: FACT_CHECK_OFFER });
  assert.equal(getDuel(db, id).winner_vendor, null);
});

test('scrubIdentity strips vendor self-identification but leaves code mentioning vendor names intact', () => {
  const diff = [
    'diff --git a/foo.ts b/foo.ts',
    '+  return 1;',
    '',
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    '',
    'As Claude, I made sure the tests still pass.',
  ].join('\n');
  const scrubbed = scrubIdentity(diff);
  assert.ok(!/Co-Authored-By/i.test(scrubbed));
  assert.ok(!/As Claude/i.test(scrubbed));

  const code = 'Run it with `claude -p "do the thing"` from the CLI.';
  assert.equal(scrubIdentity(code), code);
});

test('scrubIdentity redacts serena tool names — mandatory on Claude lanes since 2026-09-03, so a lane tell', () => {
  const report = 'Swept consumers with mcp__serena__jet_brains_find_referencing_symbols, then '
    + 'serena find_symbol (jet_brains_find_symbol) on src/duel.ts; see .serena/project.yml; '
    + 'lane-A worktree pass via mcp__serena-lsp__activate_project and mcp__serena-lsp__find_symbol.';
  const scrubbed = scrubIdentity(report);
  assert.ok(!/serena|jet_brains/i.test(scrubbed), scrubbed);
  assert.ok(/<redacted>/.test(scrubbed));
  // Bare LSP spellings are generic identifiers and survive.
  assert.equal(scrubIdentity('grep -n find_symbol src/x.ts'), 'grep -n find_symbol src/x.ts');
});

test('scrubIdentity redacts side-worktree paths and first-person lane self-identification (duel 409)', () => {
  // Both duel-409 reports quoted their own sha256sum line, path and all.
  assert.equal(scrubIdentity('sha256sum /home/u/duels/duel409-w2/.review-scratch/duel409-brief.md'),
    'sha256sum <path>');
  assert.equal(scrubIdentity('cwd /home/u/duels/duel409-judging-g ok'), 'cwd <path> ok');
  assert.equal(scrubIdentity('worktree duel409-w1 detached at 9273a9d'),
    'worktree <path> detached at 9273a9d');
  // X named its own lane in DEVIATIONS; the topic form survives.
  assert.equal(scrubIdentity('serena was not exposed on this Codex lane'),
    '<redacted> was not exposed on this lane');
  const prose = 'The codex lane and the claude-b forwarder both write .jsonl session files.';
  assert.equal(scrubIdentity(prose), prose);
});

test('scrubIdentity redacts the fan-out mechanism names each lane uses (duel 412)', () => {
  // Since v2.13.86 every brief carries the fan-out line, which names the mechanism per lane and
  // asks for a count — and a side that names its count names its mechanism with it.
  assert.equal(scrubIdentity('Sub-agents: 3, spawned with the Agent tool on distinct subtasks'),
    'Sub-agents: 3, spawned with the <redacted> on distinct subtasks');
  assert.equal(scrubIdentity('fanned out via the task tool; agent(prompt, {model}) is the Workflow spelling'),
    'fanned out via the <redacted>; agent(prompt, {model}) is the Workflow spelling');
  assert.equal(scrubIdentity('3 sub-agent rollouts (spawn_agent, then wait_agent)'),
    '3 <redacted> (<redacted>, then <redacted>)');
  assert.equal(
    scrubIdentity('two subagent rollouts and one child rollout; list_agents showed none, interrupt_agent unused'),
    'two <redacted> and one <redacted>; <redacted> showed none, <redacted> unused');
  // The shared vocabulary survives: bare rollout(s), bare sub-agent(s), and identifiers that
  // merely contain `agent`.
  const prose412 = 'Sub-agents: 0. The rollout under the sessions dir is the proof; each subagent '
    + 'transcript sits beside the parent (transcript agent-1); subagent_type selects the lane.';
  assert.equal(scrubIdentity(prose412), prose412);
  // The judge template's own REDACTIONS phrase quotes "sub-agent tool names": an `agent tool`
  // after a hyphen is shared vocabulary, not the mechanism (duel 415).
  assert.equal(scrubIdentity('its sub-agent tool names and phrases'),
    'its sub-agent tool names and phrases');
});

test('scrubIdentity redacts model and agent-type names inside a report\'s SUB-AGENTS section (duel 414)', () => {
  assert.equal(
    scrubIdentity('## SUB-AGENTS\n1\n- sweeper (general-purpose, opus): consumer sweep\n## CONSUMERS\nthe opus row in src/matrix.ts stays'),
    '## SUB-AGENTS\n1\n- sweeper (<redacted>, <redacted>): consumer sweep\n## CONSUMERS\nthe opus row in src/matrix.ts stays',
  );
  assert.equal(
    scrubIdentity('SUB-AGENTS:\n2 — both gpt-5.6-sol, codex sub-agents\nCHECKS RUN\nnpm test'),
    'SUB-AGENTS:\n2 — both <redacted>, <redacted> sub-agents\nCHECKS RUN\nnpm test',
  );
  assert.equal( // the bare short name of the 2026-09-05 contestant is a tell like `sol`
    scrubIdentity('SUB-AGENTS:\n1 — one astra sub-agent at xhigh\nCHECKS RUN\nnpm test'),
    'SUB-AGENTS:\n1 — one <redacted> sub-agent at xhigh\nCHECKS RUN\nnpm test',
  );
  assert.equal(
    scrubIdentity('**Sub-agents**\n0 (ran solo on claude-b)\n**Changes**\nclaude-b forwarder untouched'),
    '**Sub-agents**\n0 (ran solo on <redacted>)\n**Changes**\nclaude-b forwarder untouched',
  );
  assert.equal(
    scrubIdentity('## SUB-AGENTS\n1 (sonnet)\n## DIFF\n+  anthropic: "sonnet",'),
    '## SUB-AGENTS\n1 (<redacted>)\n## DIFF\n+  anthropic: "sonnet",',
  );
  assert.equal(
    scrubIdentity('Sub-agents: 0. The opus row and the codex lane are both named in src/matrix.ts.'),
    'Sub-agents: 0. The opus row and the codex lane are both named in src/matrix.ts.',
  );
});

test('scrubIdentity catches the forms that actually appear in a mutating duel', () => {
  // Inside a diff every added line carries a '+', which the old ^ anchor missed.
  assert.ok(!/anthropic\.com/i.test(
    scrubIdentity('+Co-Authored-By: Claude <noreply@anthropic.com>')));
  assert.ok(!/anthropic\.com/i.test(
    scrubIdentity('> Co-Authored-By: Claude <noreply@anthropic.com>')));
  // The real footer is a markdown link, so the char after "with " is '[', not 'C'.
  assert.ok(!/claude/i.test(
    scrubIdentity('🤖 Generated with [Claude Code](https://claude.com/claude-code)')));
  // Lane tells with no legitimate reason to be in a solution.
  assert.ok(!/\.claude-b/.test(scrubIdentity('ran under /home/u/.claude-b/projects/x/y.jsonl')));
  assert.ok(!/019f959a/.test(scrubIdentity('{"session_id":"019f959a-1ac1-7bf3"} then the review')));
  assert.ok(!/I am Codex/i.test(scrubIdentity('I am Codex, and I found three bugs.')));

  // Still conservative: a review of this repo must be able to name the vendors.
  const prose = 'The codex lane and the claude-b forwarder both write .jsonl session files.';
  assert.equal(scrubIdentity(prose), prose);
});

test('label map is stored and maps both labels to distinct vendors', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'x', SIDES, { mutating: true, spotCheck: true }, 1);
  const lm = JSON.parse(getDuel(db, id).label_map);
  assert.deepEqual(Object.keys(lm).sort(), ['X', 'Y']);
  assert.deepEqual(Object.values(lm).sort(), ['anthropic', 'openai']);
  assert.equal(getDuel(db, id).mutating, 1);
  assert.equal(getDuel(db, id).spot_check, 1);
});

test('blinding scrubs lane A\'s home paths too, without eating prose about .claude', () => {
  // pickAnthropicLane shifts a B-homed kind onto A whenever B is soft or stale, so the anthropic
  // side routinely runs on A. Scrubbing only .claude-b and .codex left one solution carrying a
  // live ~/.claude/projects path while the other showed '<path>' — the judge reads the lane off
  // the packet and the duel is no longer blind.
  assert.equal(scrubIdentity('wrote /home/user/.claude/projects/-home-user/a.jsonl'),
    'wrote <path>');
  assert.equal(scrubIdentity('see ~/.claude/todos/x.json'), 'see <path>');
  // the B and codex rules still hold
  assert.equal(scrubIdentity('wrote /home/user/.claude-b/projects/-h/a.jsonl'), 'wrote <path>');
  assert.equal(scrubIdentity('see /home/user/.codex/sessions/2026/r.jsonl'), 'see <path>');
  // …and reviewing this repo must still be able to discuss its own config
  const prose = 'add the rule to .claude/settings.json under permissions';
  assert.equal(scrubIdentity(prose), prose);
});

test('scrubIdentity: .claude-a paths are scrubbed like .claude-b', () => {
  assert.equal(scrubIdentity('log at /home/x/.claude-a/projects/p/s.jsonl end'), 'log at <path> end');
});

test('scrubIdentity: every .codex/ path is a lane tell, not just sessions/', () => {
  // duel-326 class (example-repo 2026-08-22): a /home/user/.codex/memories/ path in a side
  // report survived the sessions-only rule into the blinded packet; the controller had to
  // neutralize the judge-room copies by hand.
  assert.equal(scrubIdentity('noted /home/user/.codex/memories/2026/m.md end'),
    'noted <path> end');
  assert.equal(scrubIdentity('tail ~/.codex/log/codex-tui.log'), 'tail <path>');
});

test('scrubIdentity: a pinned offload dir is a lane tell too, whatever it is called', () => {
  // MR_B_CONFIG_DIR puts the offload account anywhere, and the literal .claude-[ab] rules
  // cannot see it — the packet then carries a path only the B side could have written.
  const pin = '/srv/claude-offload';
  assert.equal(scrubIdentity(`log at ${pin}/projects/p/s.jsonl end`),
    `log at ${pin}/projects/p/s.jsonl end`); // unpinned: not this rule's business
  process.env.MR_B_CONFIG_DIR = pin;
  try {
    assert.equal(scrubIdentity(`log at ${pin}/projects/p/s.jsonl end`), 'log at <path> end');
    // still narrow: prose that merely names the dir's parent survives
    assert.equal(scrubIdentity('deployed under /srv'), 'deployed under /srv');
  } finally { delete process.env.MR_B_CONFIG_DIR; }
});

test('scrubIdentity: every env that re-spells a lane root is a pin, and pins are lane tells', () => {
  // Aux dirs and proof roots can be pinned to non-default names (MR_AUX_A/B, MR_B_PROJECTS,
  // MR_A_PROJECTS, MR_CODEX_SESSIONS) — the literal .claude-[ab]/.codex rules never see those
  // spellings, so the packet carried a path only one lane could have written (deferred
  // residual from the account-aware B-lane wave).
  const pin = '/srv/acct-alpha';
  assert.equal(scrubIdentity(`log at ${pin}/projects/p/s.jsonl end`),
    `log at ${pin}/projects/p/s.jsonl end`); // unpinned: not this rule's business
  for (const env of ['MR_AUX_A', 'MR_AUX_B', 'MR_B_PROJECTS', 'MR_A_PROJECTS',
    'MR_CODEX_SESSIONS']) {
    process.env[env] = pin;
    try {
      assert.equal(scrubIdentity(`log at ${pin}/projects/p/s.jsonl end`), 'log at <path> end',
        env);
    } finally { delete process.env[env]; }
  }
});

test('scrubIdentity composed: a prefix pin cannot mangle a longer pin — longest scrubs first', () => {
  // In declaration order MR_B_CONFIG_DIR ran before MR_AUX_B, so the short pin ate the shared
  // prefix up to the '@' its tail class refuses, leaving '<path>@b/projects/…' — a fragment
  // only one lane could have written, sitting in the blind packet. Longest-first, the longer
  // spelling is still whole when its rule runs, and both pins scrub clean in one packet.
  process.env.MR_B_CONFIG_DIR = '/srv/lane';
  process.env.MR_AUX_B = '/srv/lane@b';
  try {
    assert.equal(
      scrubIdentity('wrote /srv/lane@b/projects/p/s.jsonl and read /srv/lane/cfg.json'),
      'wrote <path> and read <path>');
  } finally { delete process.env.MR_B_CONFIG_DIR; delete process.env.MR_AUX_B; }
});

test('scrubIdentity: every spelling of a pinned root scrubs — slashed or not, bare or subpath', () => {
  // Pins were read verbatim: a slashed pin (MR_B_CONFIG_DIR=/srv/lane/) built a rule that
  // demands its trailing slash at the match site, so a child echoing the BARE dir
  // (CLAUDE_CONFIG_DIR=/srv/lane) sailed through the blind packet while /srv/lane/projects/…
  // scrubbed. Pins are now canonicalized like the resolver's returns (v2.12.6).
  for (const pin of ['/srv/lane/', '/srv/lane']) {
    process.env.MR_B_CONFIG_DIR = pin;
    try {
      assert.equal(scrubIdentity('spawned with CLAUDE_CONFIG_DIR=/srv/lane and exited'),
        'spawned with CLAUDE_CONFIG_DIR=<path> and exited', `bare echo, pin ${JSON.stringify(pin)}`);
      assert.equal(scrubIdentity('log at /srv/lane/projects/p/s.jsonl end'),
        'log at <path> end', `subpath echo, pin ${JSON.stringify(pin)}`);
      // replay: scrubbing an already-scrubbed packet changes nothing
      assert.equal(scrubIdentity('spawned with CLAUDE_CONFIG_DIR=<path> and exited'),
        'spawned with CLAUDE_CONFIG_DIR=<path> and exited', `replay, pin ${JSON.stringify(pin)}`);
    } finally { delete process.env.MR_B_CONFIG_DIR; }
  }
});

test('scrubIdentity composed: canonicalization runs before the longest-first sort', () => {
  // Trailing slashes inflate a verbatim length: '/srv/lane///' (12 chars) outranks
  // '/srv/lane@b' (11) sorted as spelled, the canonical prefix rule would run first, eat the
  // shared prefix, and the duel-201 mangle ('<path>@b/projects/…') is back. The sort must
  // judge what the rules will actually match: canonical spellings.
  process.env.MR_B_CONFIG_DIR = '/srv/lane///';
  process.env.MR_AUX_B = '/srv/lane@b';
  try {
    assert.equal(
      scrubIdentity('wrote /srv/lane@b/projects/p/s.jsonl and read /srv/lane/cfg.json'),
      'wrote <path> and read <path>');
  } finally { delete process.env.MR_B_CONFIG_DIR; delete process.env.MR_AUX_B; }
});

test('scrubIdentity: every lane tell duel 391 found in the blind packet, one row per family', () => {
  // Duel 391 M1/M2: the packet's only scrub let through the engine's OWN mandated report
  // basename, the bare aux dir (the rule demanded a trailing slash), the courier header echo,
  // a bare codex rollout filename, a .claude/worktrees path and a bare uuid/ulid proof value.
  // Each row fails without its rule; the prose rows pin what must survive.
  const rows: [string, string, string][] = [
    ['vendor report basename (M1)',
      'see .review-scratch/duel391-anthropic.md and duel391-openai.md',
      'see .review-scratch/duel391-<redacted>.md and duel391-<redacted>.md'],
    ['bare aux dir, no trailing path', 'spawned under /home/user/.claude-b and exited',
      'spawned under <path> and exited'],
    ['bare aux dir A', 'HOME was ~/.claude-a for the run', 'HOME was <path> for the run'],
    ['courier header echo', 'ConfigDir: /home/user/.claude-b.\nEffort: xhigh.',
      'ConfigDir: <path>\nEffort: xhigh.'],
    ['bare rollout filename',
      'proof rollout-2026-08-29T10-59-36-0199a1b2-1ac1-7bf3-8f00-0123456789ab.jsonl landed',
      'proof <redacted> landed'],
    ['bare rollout id without extension',
      'proof rollout-2026-08-29T10-59-36-0199a1b2-1ac1-7bf3-8f00-0123456789ab landed',
      'proof <redacted> landed'],
    ['worktree path', 'cwd /home/user/example-repo/.claude/worktrees/duel393-w2/src',
      'cwd <path>'],
    ['bare uuid proof', 'session 019f959a-1ac1-7bf3-8f00-0123456789ab landed',
      'session <redacted> landed'],
    ['bare ulid proof', 'proof 01J8ZK3V9Q4X2Y7W6T5R8N1M0P landed', 'proof <redacted> landed'],
    // conservative: reviewing this repo must still be able to say all of these
    ['prose survives', 'the claude-b forwarder reads .claude/settings.json; sha ' +
      '9571407e2c5162e4617eee0000000000000000ab; short id 019f959a; fn getSessionDatabaseHandler',
      'the claude-b forwarder reads .claude/settings.json; sha ' +
      '9571407e2c5162e4617eee0000000000000000ab; short id 019f959a; fn getSessionDatabaseHandler'],
  ];
  for (const [label, input, expected] of rows) {
    assert.equal(scrubIdentity(input), expected, label);
  }
  // composed: every family in one packet, and a scrubbed packet is a fixed point
  const packet = rows.map(r => r[1]).join('\n');
  const once = scrubIdentity(packet);
  assert.equal(once, rows.map(r => r[2]).join('\n'));
  assert.equal(scrubIdentity(once), once, 'idempotent');
});

test('one session id cannot attest both sides of a duel, under either spelling', () => {
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'mr-two-'));
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  writeFileSync(join(root, `rollout-2026-07-25-${id}.jsonl`), '{}');
  const now = Date.now();
  const both = (proof: string) =>
    ({ output: 'x'.repeat(40), tokens: 5000, latencyMs: 100, failed: false, proof });
  const mk = () => createDuel(db, 'implementation-misc', [
    { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
    { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'high' }],
    { mutating: false, spotCheck: false }, now);
  assert.throws(() => recordResults(db, mk(),
    { anthropic: both(id), openai: both(id) }, { roots: { B: root, codex: root } }),
    /cannot attest two lanes/);
  // the canonical id is what counts, so the rollout filename spelling is not a second proof
  assert.throws(() => recordResults(db, mk(),
    { anthropic: both(id), openai: both(`rollout-2026-07-25-${id}.jsonl`) },
    { roots: { B: root, codex: root } }),
    /cannot attest two lanes/);
});

test('a duel nobody ever recorded expires instead of sitting in routed forever', () => {
  const db = openDb(':memory:');
  const now = 100 * 3_600_000;
  const old = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false },
    now - DUEL_TTL_MS - 1);
  const fresh = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false },
    now - DUEL_TTL_MS + 1);
  assert.deepEqual(expireStaleDuels(db, now), [old]);
  assert.equal(getDuel(db, old).status, 'abandoned');
  assert.equal(getDuel(db, fresh).status, 'routed'); // an 80-minute lane run is not abandoned
  assert.deepEqual(expireStaleDuels(db, now), []); // idempotent — abandoned rows are terminal
});

test('an abandoned duel is revivable — the sweep must not destroy work that really ran', () => {
  const db = openDb(':memory:');
  const now = 100 * 3_600_000;
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false },
    now - DUEL_TTL_MS - 1);
  expireStaleDuels(db, now);
  assert.equal(getDuel(db, id).status, 'abandoned');
  // Both lanes really ran; only the controller was interrupted. Re-routing instead would stamp a
  // newer created_at and the existing session files would fail attestation forever.
  const r = recordResults(db, id, {
    anthropic: { output: 'a', tokens: 10, latencyMs: 5, failed: false },
    openai: { output: null, tokens: null, latencyMs: null, failed: true },
  }, { roots: { B: null, codex: null } });
  assert.equal(r.status, 'walkover');
  const revived = getDuel(db, id);
  assert.equal(revived.status, 'walkover');
  assert.equal(revived.decided_by, 'walkover'); // the 'abandoned' marker is cleared, not kept
  // Reviving does not make the row re-recordable: it replays the decision like any other
  // resolved duel rather than reopening it.
  assert.deepEqual(recordResults(db, id, {
    anthropic: { output: 'other', tokens: 99, latencyMs: 5, failed: false },
    openai: { output: null, tokens: null, latencyMs: null, failed: true },
  }, { roots: { B: null, codex: null } }), { status: 'walkover', winner: 'anthropic' });
  assert.equal(getDuel(db, id).anth_output, 'a'); // first recording stands
});

test('abandoned duels are inert to standings — not a walkover for the surviving side', () => {
  const db = openDb(':memory:');
  const now = 100 * 3_600_000;
  createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false },
    now - DUEL_TTL_MS - 1);
  expireStaleDuels(db, now);
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.equal(s.judged, 0);
  assert.equal(s.walkovers, 0);
});

test('the judging window starts when results land, not when the duel was routed', () => {
  const db = openDb(':memory:');
  const now = 100 * 3_600_000;
  // Sides that took longer than the whole TTL to run: under a created_at clock this row would be
  // sweepable the moment record_duel returned, with zero seconds in which judging was possible.
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false },
    now - DUEL_TTL_MS - 60_000);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('g', 1000, 90) }, { ...NOPROOF, now });
  assert.deepEqual(expireStaleDuels(db, now + 1), []);
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
  // The fresh clock still runs out — TTL after recording, not never.
  assert.deepEqual(expireStaleDuels(db, now + DUEL_TTL_MS + 1), [id]);
  assert.equal(getDuel(db, id).status, 'abandoned');
});

test('a pre-2.6.4 awaiting_judgment row with no recorded_at still expires on created_at', () => {
  const db = openDb(':memory:');
  const now = 100 * 3_600_000;
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false },
    now - DUEL_TTL_MS - 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('g', 1000, 90) },
    { ...NOPROOF, now: now - DUEL_TTL_MS });
  db.prepare('UPDATE duels SET recorded_at=NULL WHERE id=?').run(id); // legacy row shape
  assert.deepEqual(expireStaleDuels(db, now), [id]);
});

test('a duel whose judges never came back is swept too — and a late verdict still lands', () => {
  const db = openDb(':memory:');
  const now = 100 * 3_600_000;
  const created = now - DUEL_TTL_MS - 1;
  // The other half of the stall: results recorded, then the controller died before collecting
  // votes. Sweeping only 'routed' left this one open forever — the defect the sweep was for.
  const stalled = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, created);
  rec(db, stalled, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) },
    { ...NOPROOF, now: created }); // results landed long ago too — the judging window is spent
  // A row swept out of 'routed' has no outputs at all — it must NOT become judgeable.
  const empty = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, created);
  assert.deepEqual(expireStaleDuels(db, now).sort(), [stalled, empty].sort());
  assert.equal(getDuel(db, stalled).status, 'abandoned');
  // deliberate duel-65 update (opus F4's second half): the rejection now carries the repair
  // guidance — record_duel on the original id is the fix for a swept-empty row too
  assert.throws(() => judge(db, empty, 'anthropic', 'X', now), /blank|repair/i);

  // Late judges are not wrong judges: created_at is untouched by the sweep, so their own
  // attestation window is unchanged and the duel resolves normally.
  const labels = JSON.parse(getDuel(db, stalled).label_map);
  const anthLabel = labels.X === 'anthropic' ? 'X' : 'Y';
  assert.deepEqual(judge(db, stalled, 'anthropic', anthLabel, now), { status: 'awaiting_judgment' });
  assert.equal(getDuel(db, stalled).status, 'abandoned'); // still open on one vote
  const done = judge(db, stalled, 'openai', anthLabel, now);
  assert.equal(done.status, 'judged');
  assert.equal(getDuel(db, stalled).winner_vendor, 'anthropic');
  assert.deepEqual(expireStaleDuels(db, now), []); // and it is out of the sweep for good
});

test('a swept duel holding two attested outputs cannot be re-recorded into a walkover', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth v1', 5000, 100), openai: ok('gpt v1', 6000, 90) },
    { ...NOPROOF, now: 2 });
  expireStaleDuels(db, 2 + DUEL_TTL_MS + 1);
  assert.equal(getDuel(db, id).status, 'abandoned');
  // a late judge has already voted on the stored text
  judge(db, id, 'anthropic', 'X', 3);
  // the careless recovery: one side failed, the other re-sent with new text — this call used
  // to turn two attested reports into a walkover and rewrite the outputs under the standing
  // vote (duel-62 I5 / sol#2, the duel 49/53 hazard)
  const r = rec(db, id, { anthropic: FAILED, openai: ok('gpt v2', 50, 1) }, { ...NOPROOF, now: 4 });
  assert.equal(r.status, 'awaiting_judgment');
  const row = getDuel(db, id);
  assert.equal(row.status, 'awaiting_judgment');
  assert.equal(row.anth_output, 'anth v1'); // landed sides are immutable
  assert.equal(row.gpt_output, 'gpt v1');
  assert.equal(row.gpt_tokens, 6000);
  // the vote still describes the row, so the second vote resolves it
  assert.equal(judge(db, id, 'openai', 'X', 5).status, 'judged');
});

test('the resolving vote and its resolution commit as one transaction', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 5000, 100), openai: ok('g', 6000, 90) }, { ...NOPROOF, now: 2 });
  judge(db, id, 'anthropic', 'X', 3);
  // Fault injection at the resolution write: if the resolution cannot commit, the second vote
  // must not either — committing it alone stranded two spent judge proofs on an
  // 'awaiting_judgment' row the sweep then abandoned with nothing to find it (duel-62 sol#5).
  db.exec(`CREATE TRIGGER mr_boom BEFORE UPDATE OF status ON duels
           WHEN NEW.status IN ('judged','unresolved') BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  assert.throws(() => judge(db, id, 'openai', 'X', 4), /boom/);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM judgments WHERE duel_id=?').get(id) as any).c, 1);
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
  db.exec('DROP TRIGGER mr_boom');
  assert.equal(judge(db, id, 'openai', 'X', 5).status, 'judged');
});

// ——— duel-64 ledger ———

// A blank stored output is NOT a landed report: it must not be judgeable — the vote would be
// cast against an empty rival — and it must be repairable (duel-64 opus #2 / sol #4).
test('a row with a blank side is not judgeable — repair first', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) });
  db.prepare("UPDATE duels SET anth_output='   ' WHERE id=?").run(id); // pre-2.6.1 legacy shape
  assert.throws(() => judge(db, id, 'openai', 'Y', 2), /blank|repair/i);
  // same for a swept row: a blank side means not re-judgeable either
  db.prepare("UPDATE duels SET status='abandoned' WHERE id=?").run(id);
  assert.throws(() => judge(db, id, 'anthropic', 'Y', 3), /not awaiting judgment|blank|repair/i);
});

test('a blank awaiting side is repairable, and the repair voids votes cast on the old packet', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) });
  // legacy shape: one judge already voted, then the anth side turns out to be blank error text
  judge(db, id, 'openai', 'Y', 2);
  db.prepare("UPDATE duels SET anth_output='  \n ' WHERE id=?").run(id);
  const r = rec(db, id, { anthropic: ok('repaired report', 600, 120), openai: FAILED });
  assert.equal(r.status, 'awaiting_judgment');
  const row: any = getDuel(db, id);
  assert.equal(row.anth_output, 'repaired report');
  assert.equal(row.gpt_output, 'gpt out'); // landed side untouched
  // the stale vote was about a packet that no longer exists
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM judgments WHERE duel_id=?').get(id) as any).c, 0);
  // fresh votes on the repaired packet resolve normally
  judge(db, id, 'anthropic', 'X', 4);
  assert.equal(judge(db, id, 'openai', 'X', 5).status, 'judged');
});

// The audit slot is spent by the audit's FIRST recording only: re-recording a swept audit's
// unchanged results must not subtract a second interval — that forgave real debt (duel-64 sol #3).
test('reviving a recorded spot audit does not spend the slot again', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.prepare("UPDATE matrix SET spot_counter=15 WHERE task_kind='implementation-misc'").run();
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) });
  const counter = () => (db.prepare(
    "SELECT spot_counter FROM matrix WHERE task_kind='implementation-misc'").get() as any).spot_counter;
  assert.equal(counter(), 5); // 15 minus one interval
  // routes keep accruing, the awaiting row gets swept, the controller revives it unchanged
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  db.prepare("UPDATE duels SET status='abandoned' WHERE id=?").run(id);
  rec(db, id, { anthropic: FAILED, openai: FAILED });
  assert.equal(counter(), 9); // unchanged — the slot was already spent at first record
});

// One in-flight audit per kind means the whole in-flight window: the routed-only index let an
// awaiting_judgment audit coexist with a freshly raced routed one (duel-64 sol #2).
test('one in-flight spot audit per kind — awaiting_judgment counts as in flight', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) }); // → awaiting_judgment
  assert.throws(
    () => createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2),
    /UNIQUE/i);
});

// Revival conflict handling for the widened invariant: a swept audit revived while a NEW audit
// is in flight cannot rejoin as a second concurrent audit — it lands as a plain record instead,
// keeping the attested outputs without breaking the invariant.
test('reviving a swept audit while a new audit is in flight demotes it to a plain record', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const id1 = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  rec(db, id1, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) });
  db.prepare("UPDATE duels SET status='abandoned' WHERE id=?").run(id1); // swept
  const id2 = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  // explicit now on the fixture clock: a Date.now() revival would read id2's created_at=2 as
  // TTL-dead and expire it instead of demoting this row (duel-66 opus I1's sitter-expiry)
  const r = rec(db, id1, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: 3 }); // revival: both landed, replay fill
  assert.equal(r.status, 'awaiting_judgment');
  assert.equal(getDuel(db, id1).spot_check, 0); // demoted — id2 is THE audit now
  assert.equal(getDuel(db, id2).status, 'routed');
});

// ——— duel-65 ledger ———


// duel-65 opus F10 reworked (duel-66 opus I1): the demotion predicate must answer the
// symmetric index's question — ANY other in-flight audit demotes (id<>) — and the
// stale-sitter concern is handled by expiring a TTL-dead routed conflictor at record time,
// exactly as the sweep would have. Deliberate test update: the sitter now lands 'abandoned'
// with its death stamped, instead of staying 'routed' while the recording audit dodged
// demotion on id order.
test('recording an audit expires a TTL-dead older sitter instead of being demoted by it', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot'); // the deferred-gate world (opus F1)
  const stale = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  const live = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  const at = 2 + DUEL_TTL_MS + 60_000; // the sitter is sweep-eligible by the time this records
  rec(db, live, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) },
    { roots: { B: null, codex: null }, now: at });
  assert.equal(getDuel(db, live).spot_check, 1); // the audit that ran keeps its identity
  const s = getDuel(db, stale);
  assert.equal(s.status, 'abandoned'); // the dead sitter is expired, not deferred to
  assert.equal(s.abandoned_at, at); // …with its death stamped for the router's backoff
});

// `id>` left an audit conflicting with an OLDER in-flight row undemoted, and the UPDATE then
// hit the symmetric unique index — permanently, since every retry re-derived demoted=false:
// two swept audits revived in ascending id order could never store the second's attested runs
// (duel-66 opus I1).
test('two swept audits revived in ascending id order both record — the second demotes', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const a1 = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  db.prepare("UPDATE duels SET status='abandoned' WHERE id=?").run(a1); // swept un-run
  const a2 = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  db.prepare("UPDATE duels SET status='abandoned' WHERE id=?").run(a2); // swept un-run
  const r1 = rec(db, a1, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) },
    { roots: { B: null, codex: null }, now: 3 });
  assert.equal(r1.status, 'awaiting_judgment');
  assert.equal(getDuel(db, a1).spot_check, 1); // first revival is THE audit
  const r2 = rec(db, a2, { anthropic: ok('c', 500, 100), openai: ok('d', 1000, 90) },
    { roots: { B: null, codex: null }, now: 4 });
  assert.equal(r2.status, 'awaiting_judgment'); // was: UNIQUE constraint failed, forever
  assert.equal(getDuel(db, a2).spot_check, 0);
  assert.equal(getDuel(db, a2).demoted_audit, 1); // still a PAID audit for the reopen scan
});

// abandoned_at must not outlive the record it predates: a revived row carrying a stale death
// stamp would feed the router's backoff clock, which now prefers abandoned_at (duel-66 M6).
test('a revival clears the death stamp', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  db.prepare("UPDATE duels SET status='abandoned', abandoned_at=100 WHERE id=?").run(id);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) },
    { roots: { B: null, codex: null }, now: 200 });
  assert.equal(getDuel(db, id).abandoned_at, null);
});

// A packet-changing repair deleted judgments whose proof had no claims row — the pre-2.5
// writer shape legacyProofOwner exists for. With both vote and claim gone, the pre-repair
// judge run could re-send its id and vote on a packet it never saw (duel-66 opus M8 / sol F5).
// The repair now tombstones vote proofs into proof_claims before deleting the votes.
test('a repair tombstones a claimless legacy judge proof — the old run cannot re-vote', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) });
  const P = '7d15b6ee-23c1-48a2-b51c-1836bf431799';
  // pre-2.5 writer shape: the vote carries its proof, proof_claims has never heard of it
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof)
    VALUES (?, 'openai', 'Y', 2, ?)`).run(id, P);
  // the anth side turns out to be legacy blank error text; the repair voids the vote
  db.prepare("UPDATE duels SET anth_output='  \n ' WHERE id=?").run(id);
  rec(db, id, { anthropic: ok('repaired report', 600, 120), openai: FAILED });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM judgments WHERE duel_id=?').get(id) as any).c, 0);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'Y', 3, { roots: { B: null, codex: null }, proof: P }),
    /already used/i);
});

// A packet-changing repair deletes votes but keeps their proof claims spent. The same-slot
// replay exemption then read the spent judge proof as an idempotent re-send and let the SAME
// judge run vote on a packet it never saw (duel-65 sol S4).
test('a repair voids a vote AND its proof — the old judge run cannot re-vote on the new packet', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) });
  const P = '6d15b6ee-23c1-48a2-b51c-1836bf431724';
  recordJudgment(db, id, 'openai', 'Y', 2, { roots: { B: null, codex: null }, proof: P });
  // the anth side turns out to be legacy blank error text; the repair voids the vote
  db.prepare("UPDATE duels SET anth_output='  \n ' WHERE id=?").run(id);
  rec(db, id, { anthropic: ok('repaired report', 600, 120), openai: FAILED });
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'Y', 3, { roots: { B: null, codex: null }, proof: P }),
    /already used/i);
  // a fresh judge run votes fine
  const P2 = 'f1e2d3c4-b5a6-4789-9012-3456789abcde';
  assert.equal(recordJudgment(db, id, 'openai', 'Y', 4,
    { roots: { B: null, codex: null }, proof: P2 }).status, 'awaiting_judgment');
});

const A65_SIDES: [Side, Side] = [
  { vendor: 'anthropic', lane: 'A', model: 'opus', effort: 'high' },
  { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
];

// The lane-A ignore path caught claimProof's throw AFTER its INSERT had landed: the commit
// kept a proof_claims row attributing the proof to THIS duel while the duel stored no
// anth_proof — namespace and duels table disagreed (duel-65 opus F9a).
test('an ignored lane-A proof leaves no orphan claim row behind', () => {
  const db = openDb(':memory:');
  const P = '6d15b6ee-23c1-48a2-b51c-1836bf431724';
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, anth_proof)
    VALUES ('implementation-misc', 1, '[]', '{}', 'judged', ?)`).run(P); // pre-2.5 legacy owner
  const root = mkdtempSync(join(tmpdir(), 'mr-a65-'));
  writeFileSync(join(root, `${P}.jsonl`), '{}\n');
  const id = createDuel(db, 'implementation-misc', A65_SIDES, { mutating: false, spotCheck: false }, 1);
  const r = recordResults(db, id, {
    anthropic: { output: 'anth out', tokens: 500, latencyMs: 100, failed: false, proof: P },
    openai: FAILED,
  }, { roots: { B: null, codex: null, A: root } });
  assert.equal(r.status, 'walkover');
  assert.equal(getDuel(db, id).anth_proof, null); // ignored, not stored
  assert.equal((db.prepare('SELECT COUNT(*) c FROM proof_claims WHERE proof=?').get(P) as any).c, 0);
});

// F9b: the lane-A catch was unconditional — a real storage failure during the claim INSERT
// (FULL/BUSY, here a missing table) was reclassified as "decorative lane-A proof" and the
// transaction committed claimless. Only the double-spend refusal is ignorable.
test('a lane-A claim failure that is not a double-spend propagates', () => {
  const db = openDb(':memory:');
  const P = 'cccc1111-2222-4333-8444-555566667777';
  const root = mkdtempSync(join(tmpdir(), 'mr-a65b-'));
  writeFileSync(join(root, `${P}.jsonl`), '{}\n');
  const id = createDuel(db, 'implementation-misc', A65_SIDES, { mutating: false, spotCheck: false }, 1);
  db.exec('DROP TABLE proof_claims');
  assert.throws(() => recordResults(db, id, {
    anthropic: { output: 'anth out', tokens: 500, latencyMs: 100, failed: false, proof: P },
    openai: FAILED,
  }, { roots: { B: null, codex: null, A: root } }), /no such table/i);
});

// The first-recording test was `recorded_at == null` — a column added in 2.6.4, NULL on every
// row predating it: reviving such an audit re-spent the slot and forgave up to ten routes of
// debt (duel-65 opus F6). First recording = no side had landed yet.
test('reviving a pre-2.6.4 audit (no recorded_at) does not spend the slot again', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) });
  // age it into the pre-2.6.4 shape: recorded then swept, before the columns existed
  db.prepare("UPDATE duels SET status='abandoned', recorded_at=NULL, outputs_at=NULL WHERE id=?")
    .run(id);
  db.prepare("UPDATE matrix SET spot_counter=9 WHERE task_kind='implementation-misc'").run();
  rec(db, id, { anthropic: FAILED, openai: FAILED }); // unchanged revival
  assert.equal((db.prepare("SELECT spot_counter FROM matrix WHERE task_kind='implementation-misc'")
    .get() as any).spot_counter, 9); // its outputs landed long ago — nothing new was audited
});

// F4's second half: the operator who followed the wrong rejection ('not awaiting judgment')
// re-routed instead of repairing. An abandoned row with a blank stored side gets the repair
// guidance.
test('an abandoned row with a blank side rejects with the repair guidance', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('anth out', 500, 100), openai: ok('gpt out', 1000, 90) });
  db.prepare("UPDATE duels SET anth_output=char(10)||char(9), status='abandoned' WHERE id=?").run(id);
  assert.throws(() => judge(db, id, 'openai', 'Y', 2), /repair/i);
});

// ——— duel-67 ledger ———

// The expired sitter matched the router's dead-audit predicate exactly (spot, abandoned, no
// winner, no landed side), so the SUCCESSFUL audit that displaced it armed the 1h dying-audit
// backoff — and the operator note blaming dying audits — on its own kind (duel-67 opus F7).
// A displacement is not a death by sickness: the sitter dies 'superseded', which the router's
// backoff ignores.
test('a sitter expired by a successful audit dies superseded, not as a dying-audit signal', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  const stale = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  const live = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  const at = 2 + DUEL_TTL_MS + 60_000;
  rec(db, live, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) },
    { roots: { B: null, codex: null }, now: at });
  assert.equal(getDuel(db, stale).decided_by, 'superseded');
});

// ——— duel-68 ledger ———

// The sitter-expiry was SILENT to its caller: no RETURNING, and the function's return named
// only the audit being recorded — the held id changed state to terminal with nothing surfacing
// it, and the sweep cannot name a row that is already 'abandoned' (duel-68 sol F3; the
// duel-67 review's silent-expiry defect, left standing by the superseded stamp).
test('the recording audit names the sitter it superseded in its return value', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  const stale = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  const live = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  const at = 2 + DUEL_TTL_MS + 60_000;
  const r = rec(db, live, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) },
    { roots: { B: null, codex: null }, now: at });
  assert.equal(r.status, 'awaiting_judgment');
  if (r.status !== 'awaiting_judgment') return;
  assert.deepEqual(r.superseded, [stale]);
});

// The sitter-expiry deliberately touches only status='routed': a TTL-dead awaiting_judgment
// conflictor HOLDS recorded evidence, and demoting to it is the right call — the recorder
// lands as a plain paid record, the evidence-bearing audit keeps the seat (duel-67 pin of a
// duel-66 test gap).
test('a TTL-dead awaiting conflictor keeps the seat — the recording audit demotes to it', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  const older = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  rec(db, older, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) },
    { roots: { B: null, codex: null }, now: 2 }); // holds evidence, awaiting judges
  const live = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 3);
  const at = 3 + DUEL_TTL_MS + 60_000;
  rec(db, live, { anthropic: ok('c', 500, 100), openai: ok('d', 1000, 90) },
    { roots: { B: null, codex: null }, now: at });
  assert.equal(getDuel(db, older).status, 'awaiting_judgment'); // evidence preserved
  assert.equal(getDuel(db, live).spot_check, 0);                // the recorder is demoted
  assert.equal(getDuel(db, live).demoted_audit, 1);
});

// ——— duel-69 ledger ———

// 'abandoned' is revivable by design, so a repeated double-failure record rewrote the death
// stamps on every retry — and the router's backoff runs from the LATEST stamp, so a controller
// re-sending a lost-response record (or retrying what it read as an error) kept pushing the
// next audit an hour out, indefinitely: the unfalsifiable incumbent through a new door
// (duel-69 opus F8 / sol M4, found by BOTH). A record that adds no evidence to a row already
// dead is a replay — it keeps the original clocks.
test('replaying a double failure does not restart the death clock', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  const first = rec(db, id, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: 1000 });
  assert.equal(first.status, 'abandoned');
  assert.equal(getDuel(db, id).abandoned_at, 1000);
  assert.equal(getDuel(db, id).recorded_at, 1000);
  const again = rec(db, id, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: 3_001_000 });
  assert.equal(again.status, 'abandoned');
  assert.equal(getDuel(db, id).abandoned_at, 1000);  // the death happened once
  assert.equal(getDuel(db, id).recorded_at, 1000);   // and the replay is not a new record
});

// The sitter expiry is TERMINAL, and its ids were returned exactly once: a controller whose
// response was lost hit the landed-both replay on retry and got a packet with no `superseded`
// field — the transition the RETURNING was added to surface, silent again on the one path
// retries actually take (duel-69 sol M3). The expiry now writes superseded_by, and the replay
// reconstructs the ids from it.
test('a replayed recording still names the sitter it superseded', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  const stale = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  const live = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  const at = 2 + DUEL_TTL_MS + 60_000;
  const payload = { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) };
  const r1 = rec(db, live, payload, { roots: { B: null, codex: null }, now: at });
  assert.equal(r1.status, 'awaiting_judgment');
  if (r1.status !== 'awaiting_judgment') return;
  assert.deepEqual(r1.superseded, [stale]);
  const r2 = rec(db, live, payload, { roots: { B: null, codex: null }, now: at + 1000 });
  assert.equal(r2.status, 'awaiting_judgment');
  if (r2.status !== 'awaiting_judgment') return;
  assert.deepEqual(r2.superseded, [stale]); // the lost-response retry sees the same fact
});

// ——— duel-70 ledger ———

// deadReplay's proxy was `recorded_at != null` — true for a pre-2.6.8 legacy row (blank sides
// recorded once, then swept, abandoned_at never stamped), so the controller's first statement
// of the death was classified a replay and PROPAGATED the NULL stamp: the row left every
// recovery surface the moment it was declared dead, forever (duel-70 anth F2). Only a real
// death record stamps BOTH clocks with one `now`; the sweep never touches recorded_at, so
// clock equality is the discriminator.
test('a first death record on a legacy NULL-stamp row stamps now, not NULL', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    recorded_at) VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned', 'abandoned', 1000)`).run();
  const id = (db.prepare('SELECT MAX(id) AS id FROM duels').get() as any).id;
  const r = rec(db, id, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: 5_000_000 });
  assert.equal(r.status, 'abandoned');
  assert.equal(getDuel(db, id).abandoned_at, 5_000_000);
  assert.equal(getDuel(db, id).recorded_at, 5_000_000);
  assert.ok(pendingDuels(db, 5_000_001).some(p => p.id === id));
});

// The same proxy misread a row the SWEEP had abandoned after its blank sides were recorded:
// recorded_at (the old side-recording) and abandoned_at (the sweep) differ, yet the
// controller's FIRST statement of the death kept the sweep's clock — while the code's own
// comment said that record "is not a replay: it stamps now" (duel-70 anth F2, second half).
test('the first death record after a sweep stamps now — the sweep clock is not a record', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    recorded_at, abandoned_at) VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned',
    'abandoned', 1000, 8000)`).run();
  const id = (db.prepare('SELECT MAX(id) AS id FROM duels').get() as any).id;
  const r = rec(db, id, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: 5_000_000 });
  assert.equal(r.status, 'abandoned');
  assert.equal(getDuel(db, id).abandoned_at, 5_000_000);
  assert.equal(getDuel(db, id).recorded_at, 5_000_000);
});

// A superseded sitter is terminal only until its late results arrive — revival by id is the
// documented path. superseded_by survived the revival, so a lost-response retry of the
// RECORDING duel kept reporting the now-live sitter as terminally superseded: the controller
// stopped looking, no judges were spawned, and two attested outputs died at the TTL
// (duel-70, found by BOTH sides). Revival clears the tombstone; the replay reads only rows
// that are still dead.
test('a revived sitter leaves the recording duel\'s superseded list', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  const stale = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  const live = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  const at = 2 + DUEL_TTL_MS + 60_000;
  const payload = { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) };
  const r1 = rec(db, live, payload, { roots: { B: null, codex: null }, now: at });
  assert.equal(r1.status, 'awaiting_judgment');
  if (r1.status !== 'awaiting_judgment') return;
  assert.deepEqual(r1.superseded, [stale]);
  // the sitter's lanes really ran — late results revive it by id (demoted: live is in flight)
  const r2 = rec(db, stale, { anthropic: ok('c', 500, 100), openai: ok('d', 1000, 90) },
    { roots: { B: null, codex: null }, now: at + 1000 });
  assert.equal(r2.status, 'awaiting_judgment');
  assert.equal(getDuel(db, stale).superseded_by, null); // the tombstone is gone
  const r3 = rec(db, live, payload, { roots: { B: null, codex: null }, now: at + 2000 });
  assert.equal(r3.status, 'awaiting_judgment');
  if (r3.status !== 'awaiting_judgment') return;
  assert.equal(r3.superseded, undefined); // an alive row is not a terminal transition
});

// An already-running pre-2.6.11 writer can store the OLD double-failure spelling after the
// one-shot migration has come and gone — the ops doc promises exactly this topology (an old
// MCP server keeps its code until its session restarts). Readers recognize the legacy-dead
// shape now: the row is revivable, and the revival normalizes it (duel-70 sol P2).
test('a legacy-spelling double failure written after the migration is still revivable', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by, recorded_at) VALUES ('implementation-misc', 1,
    '[{"vendor":"anthropic","lane":"B","model":"sonnet","effort":"high"},
      {"vendor":"openai","lane":"codex","model":"gpt-5.6-terra","effort":"high"}]',
    '{"X":"anthropic","Y":"openai"}', 'walkover', NULL, 'walkover', 2000)`).run();
  const id = (db.prepare('SELECT MAX(id) AS id FROM duels').get() as any).id;
  const r = rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) },
    { roots: { B: null, codex: null }, now: 3000 });
  assert.equal(r.status, 'awaiting_judgment'); // revived, not short-circuited as a walkover
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
});

// ——— duel-71 ledger ———

// The duel-70 wave's two headline fixes composed into the bug each was written to close: v6
// backfilled abandoned_at := recorded_at on exactly the legacy shapes, manufacturing the clock
// equality deadReplay then read as "this death was already recorded" — so the controller's
// FIRST real death statement replayed, kept the ancient clocks, and the row fell off the
// pending horizon the moment its death was declared (duel-71 F1, found by BOTH sides; the
// composition was never tested — no test ran a migration and a record against the same row).
// Replay detection now keys to a persisted death_recorded marker that only a death RECORD
// writes; no migration can manufacture it.
test('a death record on a row v6 just re-stamped still stamps now', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-v6rec-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    recorded_at) VALUES ('implementation-misc', 1, '[]', '{}', 'abandoned', 'abandoned', 2000)`);
  pre.exec('PRAGMA user_version = 5'); // as if written by 2.6.12
  pre.close();
  const db = openDb(path); // v6 backfills abandoned_at from recorded_at
  const id = (db.prepare('SELECT MAX(id) AS id FROM duels').get() as any).id;
  assert.equal(getDuel(db, id).abandoned_at, 2000);
  const r = rec(db, id, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: 5_000_000_000_000 });
  assert.equal(r.status, 'abandoned');
  assert.equal(getDuel(db, id).abandoned_at, 5_000_000_000_000);
  assert.equal(getDuel(db, id).recorded_at, 5_000_000_000_000);
  assert.ok(pendingDuels(db, 5_000_000_000_001).some(p => p.id === id));
});

// A superseded sitter whose double failure was later RECORDED left the recording duel's
// replay: the death record respelled decided_by to 'abandoned', the replay filtered on
// 'superseded', and the tombstone the row still held had no reader left (duel-71 opus F2 —
// sol M3 reopened for that path). A row still dead that points at the recording duel was
// superseded by it, however its death is spelled.
test('a superseded sitter recorded dead stays on the recording duel\'s superseded list', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  const stale = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 1);
  const live = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: true }, 2);
  const at = 2 + DUEL_TTL_MS + 60_000;
  const payload = { anthropic: ok('a', 500, 100), openai: ok('b', 1000, 90) };
  const r1 = rec(db, live, payload, { roots: { B: null, codex: null }, now: at });
  assert.equal(r1.status, 'awaiting_judgment');
  if (r1.status !== 'awaiting_judgment') return;
  assert.deepEqual(r1.superseded, [stale]);
  // the sitter's lanes never came back — the controller records its death by id
  const r2 = rec(db, stale, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: at + 1000 });
  assert.equal(r2.status, 'abandoned');
  const r3 = rec(db, live, payload, { roots: { B: null, codex: null }, now: at + 2000 });
  assert.equal(r3.status, 'awaiting_judgment');
  if (r3.status !== 'awaiting_judgment') return;
  assert.deepEqual(r3.superseded, [stale]); // dead is dead, however it is spelled
  const row = db.prepare('SELECT decided_by, superseded_by FROM duels WHERE id=?').get(stale) as any;
  assert.equal(row.decided_by, 'abandoned'); // the record respells the death —
  assert.equal(row.superseded_by, live);     // — but the tombstone still names the displacement
});

// ——— duel-74 ledger ———

// recordJudgment was the LAST reader still speaking 'walkover' for the pre-2.6.11 legacy-dead
// shape (NULL winner, nothing landed — still writable post-migration by an already-running old
// MCP process): it rejected with 'not awaiting judgment', the diagnosis that sends an operator
// to re-route (destroying the attestation window), instead of the blank-side repair guidance
// the same row gets on every other surface (duel-74 opus F5). Four spellings of one shape was
// the hazard; the predicate is shared now.
test('a legacy-dead row gets the repair guidance, not the re-route diagnosis', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  db.prepare(`UPDATE duels SET status='walkover', winner_vendor=NULL, decided_by='walkover',
    anth_output=NULL, gpt_output=NULL, recorded_at=2 WHERE id=?`).run(id);
  let msg = '';
  try { judge(db, id, 'openai', 'Y', 3); } catch (e) { msg = (e as Error).message; }
  assert.match(msg, /repair the blank side/);
  assert.doesNotMatch(msg, /not awaiting judgment/);
});

// Duel 146 (2026-08-10): gpt_latency_ms=4,700,000 was recorded on a duel only 1,874,355ms old,
// whose own proof rollout attests a 25-minute run — a controller-estimated round number entered
// during a messy recovery. The invented "78-minute codex run" then drove a false degradation
// narrative. A side spawns only after routing, so its wall-clock is bounded by the row's age.
test('latency exceeding the duel\'s own age is refused for either vendor; measured retry lands', () => {
  for (const vendor of ['anthropic', 'openai'] as const) {
    const db = openDb(':memory:');
    const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1_000_000);
    const claim = (latencyMs: number) => ({
      anthropic: ok('a out', 100, vendor === 'anthropic' ? latencyMs : 100),
      openai: ok('g out', 100, vendor === 'openai' ? latencyMs : 100),
    });
    const at146 = { ...NOPROOF, now: 1_000_000 + 1_874_355 }; // the real duel-146 window
    assert.throws(() => recordResults(db, id, claim(4_700_000), at146),
      new RegExp(`${vendor} side reports latency_ms=4700000 — impossible`));
    assert.equal(getDuel(db, id).status, 'routed'); // refusal leaves the row recordable
    const res = recordResults(db, id, claim(1_516_636), at146); // rollout-attested measurement
    assert.equal(res.status, 'awaiting_judgment');
  }
});

test('union one-side recovery cannot backfill an impossible latency (duel-146 shape)', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'deep-review', SIDES,
    { mutating: false, spotCheck: false, unionMode: true }, 1_000_000);
  // partner lane lands first; the hung lane is recovered from its rollout later
  recordResults(db, id, { anthropic: ok('anth report', 100, 200_000), openai: FAILED },
    { ...NOPROOF, now: 1_300_000 });
  const fill = (latencyMs: number) => ({ anthropic: FAILED, openai: ok('gpt report', 100, latencyMs) });
  assert.throws(() => recordResults(db, id, fill(4_700_000), { ...NOPROOF, now: 2_874_355 }),
    /impossible/);
  const res = recordResults(db, id, fill(1_516_636), { ...NOPROOF, now: 2_874_355 });
  assert.equal(res.status, 'union');
  assert.equal(getDuel(db, id).gpt_latency_ms, 1_516_636);
  assert.equal(getDuel(db, id).anth_latency_ms, 200_000); // landed side untouched by the fill
});

test('null latency and within-age latency still land untouched by the age bound', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1_000_000);
  const res = recordResults(db, id, {
    anthropic: { output: 'a out', tokens: 100, latencyMs: null, failed: false },
    openai: ok('g out', 100, 500_000),
  }, { ...NOPROOF, now: 1_500_000 });
  assert.equal(res.status, 'awaiting_judgment');
  assert.equal(getDuel(db, id).anth_latency_ms, null);
  assert.equal(getDuel(db, id).gpt_latency_ms, 500_000); // 500s in a 500s+slack window: measured, kept
});

// The other direction of duel 146: since v2.9.0 the clock DECIDES a duel after quality, so the
// incentive flipped from over-claiming (capped at the row's age, v2.7.4) to UNDER-claiming —
// and nothing checked that direction. The attested session file is the value the side doesn't
// control: its own start stamp to its last write is the floor a claim cannot dive under.
test('latency far below the session artifact\'s own span is refused; the measured claim lands', () => {
  const db = openDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'mr-span-'));
  const id = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
  const created = Date.parse('2026-08-10T10:00:00.000Z');
  const start = created + 10_000; // rollout starts 10s after routing…
  const path = join(root, `rollout-2026-08-10-${id}.jsonl`);
  const iso = new Date(start).toISOString();
  writeFileSync(path,
    `{"timestamp":"${iso}","type":"session_meta","payload":{"timestamp":"${iso}"}}\n`);
  const end = (start + 1_200_000) / 1000; // …and its last write lands 20 minutes later
  utimesSync(path, end, end);
  const duelId = createDuel(db, 'implementation-misc', SIDES,
    { mutating: false, spotCheck: false }, created);
  const claim = (latencyMs: number) => ({
    anthropic: ok('a out', 100, 100_000), // lane-B root disabled — only the codex side is gated
    openai: { output: 'g out', tokens: 100, latencyMs, failed: false, proof: id },
  });
  const opts = { roots: { B: null, codex: root }, now: created + 1_300_000 };
  // a 90s claim against a 20-minute artifact: refused, and the refusal leaves the row recordable
  assert.throws(() => recordResults(db, duelId, claim(90_000), opts),
    /impossible: its own session file spans/);
  assert.equal(getDuel(db, duelId).status, 'routed');
  // the measured duration (the artifact's own span, within slack) lands
  const res = recordResults(db, duelId, claim(1_190_000), opts);
  assert.equal(res.status, 'awaiting_judgment');
  assert.equal(getDuel(db, duelId).gpt_latency_ms, 1_190_000);

  // a file with no parseable start yields no floor: the gate skips, it never misfires
  const bare = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const barePath = join(root, `rollout-2026-08-10-${bare}.jsonl`);
  writeFileSync(barePath, '{}\n');
  utimesSync(barePath, end, end);
  const duel2 = createDuel(db, 'implementation-misc', SIDES,
    { mutating: false, spotCheck: false }, created);
  const res2 = recordResults(db, duel2, {
    anthropic: ok('a out', 100, 100_000),
    openai: { output: 'g out', tokens: 100, latencyMs: 90_000, failed: false, proof: bare },
  }, opts);
  assert.equal(res2.status, 'awaiting_judgment');
});

// duel-163 F5/F9 (closed v2.10.12): the floor's two escape hatches, closed together — they
// share the gate. (1) mtime moves whenever a session is resumed or appended, so on the revival
// flows SKILL.md itself prescribes, the honest measured claim sat >60s under the inflated span
// and was refused — the floor now binds only the fresh first recording. (2) On that fresh path
// a refused under-claim could simply be re-sent as null and dodge the clock channel into an
// unresolved duel — a null claim is now MEASURED from the artifact's own span; on revivals an
// absent measurement stays absent.
test('latency floor table: boundary, null derivation, cap composition, revival skip', () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-span2-'));
  const created = Date.parse('2026-08-10T10:00:00.000Z');
  const mkRollout = (id: string, startMs: number, endMs: number) => {
    const p = join(root, `rollout-2026-08-10-${id}.jsonl`);
    const iso = new Date(startMs).toISOString();
    writeFileSync(p,
      `{"timestamp":"${iso}","type":"session_meta","payload":{"timestamp":"${iso}"}}\n`);
    utimesSync(p, endMs / 1000, endMs / 1000);
  };
  const opts = (now: number) => ({ roots: { B: null, codex: root }, now });
  const fresh = (db: any) =>
    createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, created);

  // exact slack boundary: claim + 60s == span passes (the inequality is strict)
  {
    const db = openDb(':memory:');
    const id = 'aaaaaaaa-0000-0000-0000-000000000001';
    mkRollout(id, created + 10_000, created + 610_000); // span 600s
    const duel = fresh(db);
    const res = recordResults(db, duel, {
      anthropic: ok('a out', 100, 100_000),
      openai: { output: 'g out', tokens: 100, latencyMs: 540_000, failed: false, proof: id },
    }, opts(created + 700_000));
    assert.equal(res.status, 'awaiting_judgment');
    assert.equal(getDuel(db, duel).gpt_latency_ms, 540_000);
  }
  // null claim on the fresh path: measured from the artifact — the unresolved-duel dodge closes
  {
    const db = openDb(':memory:');
    const id = 'aaaaaaaa-0000-0000-0000-000000000002';
    mkRollout(id, created + 10_000, created + 610_000);
    const duel = fresh(db);
    const res = recordResults(db, duel, {
      anthropic: ok('a out', 100, 100_000),
      openai: { output: 'g out', tokens: 100, latencyMs: null, failed: false, proof: id },
    }, opts(created + 700_000));
    assert.equal(res.status, 'awaiting_judgment');
    assert.equal(getDuel(db, duel).gpt_latency_ms, 600_000); // the span, stored as measured
  }
  // composition with the v2.7.4 cap: a claim above the row's age is refused even though the
  // artifact's span would tolerate it — the cap runs first, the floor never overrides it
  {
    const db = openDb(':memory:');
    const id = 'aaaaaaaa-0000-0000-0000-000000000003';
    mkRollout(id, created + 10_000, created + 610_000);
    const duel = fresh(db);
    assert.throws(() => recordResults(db, duel, {
      anthropic: ok('a out', 100, 100_000),
      openai: { output: 'g out', tokens: 100, latencyMs: 900_000, failed: false, proof: id },
    }, opts(created + 700_000)), /the duel is only \d+ms old/);
  }
  // duel-207 P2 (sol): a fractional claim at the floor boundary — span 61,000.4ms vs claim
  // 1,000.49 used to pass the pre-round comparison, then persist 1,000, >60s below the
  // attested span. Claims round BEFORE the floor now, so the stored value is what it judges.
  {
    const db = openDb(':memory:');
    const id = 'aaaaaaaa-0000-0000-0000-000000000006';
    mkRollout(id, created + 10_000, created + 71_000.4); // span 61,000.4ms
    const duel = fresh(db);
    assert.throws(() => recordResults(db, duel, {
      anthropic: ok('a out', 100, 100_000),
      openai: { output: 'g out', tokens: 100, latencyMs: 1_000.49, failed: false, proof: id },
    }, opts(created + 700_000)), /session file spans/);
  }
  // revival: the row died, the run is recovered later, the artifact was appended meanwhile —
  // the honest small claim must still record (the floor would have refused 300s vs ~1h span)
  {
    const db = openDb(':memory:');
    const id = 'aaaaaaaa-0000-0000-0000-000000000004';
    mkRollout(id, created + 10_000, created + 3_600_000);
    const duel = fresh(db);
    recordResults(db, duel, { anthropic: FAILED, openai: FAILED }, opts(created + 100_000));
    assert.equal(getDuel(db, duel).status, 'abandoned');
    const res = recordResults(db, duel, {
      anthropic: FAILED,
      openai: { output: 'g out', tokens: 100, latencyMs: 300_000, failed: false, proof: id },
    }, opts(created + 4_000_000));
    assert.equal(res.status, 'walkover');
    assert.equal(getDuel(db, duel).gpt_latency_ms, 300_000);
  }
  // revival with no measurement: null stays null — a moved mtime must not mint an inflated one
  {
    const db = openDb(':memory:');
    const id = 'aaaaaaaa-0000-0000-0000-000000000005';
    mkRollout(id, created + 10_000, created + 3_600_000);
    const duel = fresh(db);
    recordResults(db, duel, { anthropic: FAILED, openai: FAILED }, opts(created + 100_000));
    const res = recordResults(db, duel, {
      anthropic: FAILED,
      openai: { output: 'g out', tokens: 100, latencyMs: null, failed: false, proof: id },
    }, opts(created + 4_000_000));
    assert.equal(res.status, 'walkover');
    assert.equal(getDuel(db, duel).gpt_latency_ms, null);
  }
});

// The floor's remaining table rows, all on lane B — every row above ran the codex lane, so the
// per-lane start mode and the shapes that yield no span at all were untested at the gate that
// uses them.
test('latency floor table: lane-B earliest mode, spanless shapes', () => {
  const created = Date.parse('2026-08-10T10:00:00.000Z');
  const bRoot = mkdtempSync(join(tmpdir(), 'mr-spanb-'));
  // lane B names its file after the session id alone; each head line carries its own stamp
  const mkB = (id: string, stamps: number[], endMs: number, suffix = '') => {
    const p = join(bRoot, `${id}${suffix}.jsonl`);
    writeFileSync(p, stamps.map(ms => `{"timestamp":"${new Date(ms).toISOString()}"}`).join('\n') + '\n');
    utimesSync(p, endMs / 1000, endMs / 1000);
  };
  const opts = (now: number) => ({ roots: { B: bRoot, codex: null }, now });
  const fresh = (db: any) =>
    createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, created);
  // the codex root is disabled in every row: only the lane-B side is under the gate here
  const gpt = ok('g out', 100, 100_000);

  // lane B floors against the EARLIEST stamp in the head, not line 1's — the head is not
  // timestamp-ordered, and a line-1 read would hand back a span short enough to pass the very
  // under-claim the floor exists to refuse
  {
    const db = openDb(':memory:');
    const id = 'bbbbbbbb-0000-0000-0000-000000000001';
    mkB(id, [created + 400_000, created + 10_000], created + 610_000); // line-1 span 210s, earliest 600s
    const duel = fresh(db);
    const anth = (latencyMs: number) =>
      ({ output: 'a out', tokens: 100, latencyMs, failed: false, proof: id });
    assert.throws(() => recordResults(db, duel, { anthropic: anth(210_000), openai: gpt },
      opts(created + 700_000)), /spans 600000ms/);
    const res = recordResults(db, duel, { anthropic: anth(545_000), openai: gpt },
      opts(created + 700_000));
    assert.equal(res.status, 'awaiting_judgment');
    assert.equal(getDuel(db, duel).anth_latency_ms, 545_000);
  }
  // a start stamp later than the last write is not a span: the gate skips rather than flooring
  // against a negative, exactly as it does for a file with no parseable start
  {
    const db = openDb(':memory:');
    const id = 'bbbbbbbb-0000-0000-0000-000000000002';
    mkB(id, [created + 500_000], created + 100_000);
    const duel = fresh(db);
    const res = recordResults(db, duel, {
      anthropic: { output: 'a out', tokens: 100, latencyMs: 5_000, failed: false, proof: id },
      openai: gpt,
    }, opts(created + 700_000));
    assert.equal(res.status, 'awaiting_judgment');
    assert.equal(getDuel(db, duel).anth_latency_ms, 5_000);
  }
  // the mtime skew window is the same shape reached from the other side: a last write up to
  // MTIME_SKEW_MS BEFORE the row still attests, but the session's start necessarily post-dates
  // that coarse mtime, so no span exists and a null claim stays null — the v2.10.12 derivation
  // cannot mint a measurement here
  {
    const db = openDb(':memory:');
    const id = 'bbbbbbbb-0000-0000-0000-000000000003';
    mkB(id, [created + 1_000], created - 1_500);
    const duel = fresh(db);
    const res = recordResults(db, duel, {
      anthropic: { output: 'a out', tokens: 100, latencyMs: null, failed: false, proof: id },
      openai: gpt,
    }, opts(created + 700_000));
    assert.equal(res.status, 'awaiting_judgment');
    assert.equal(getDuel(db, duel).anth_latency_ms, null);
  }
});

// One session id naming more than one FRESH file is an anomaly, not a selection problem: a proof
// is single-use, one run writes one file, and whichever file the engine picked, the side that
// wrote them chose the answer. Sorting made the pick deterministic and therefore plantable —
// `<id>-0.jsonl` sorts before `<id>.jsonl` and carries whatever span its author wants. The engine
// refuses the recording and names the files instead of measuring one of them.
test('one id, two fresh files: the recording is refused and both files are named', () => {
  const created = Date.parse('2026-08-10T10:00:00.000Z');
  const root = mkdtempSync(join(tmpdir(), 'mr-spandup-'));
  const id = 'bbbbbbbb-0000-0000-0000-000000000004';
  const mk = (suffix: string, endMs: number) => {
    const p = join(root, `${id}${suffix}.jsonl`);
    writeFileSync(p, `{"timestamp":"${new Date(created + 10_000).toISOString()}"}\n`);
    utimesSync(p, endMs / 1000, endMs / 1000);
  };
  // written big-span first, so insertion order and sorted order disagree
  mk('-b', created + 1_210_000); // sorts second: 20-minute span
  mk('-a', created + 130_000);   // sorts FIRST: 2-minute span — the decoy's position
  const opts = { roots: { B: root, codex: null }, now: created + 1_300_000 };
  const fresh = (db: any) =>
    createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, created);
  const anth = (latencyMs: number | null) =>
    ({ output: 'a out', tokens: 100, latencyMs, failed: false, proof: id });

  // the under-claim the short file would have waved through
  {
    const db = openDb(':memory:');
    assert.throws(() => recordResults(db, fresh(db), {
      anthropic: anth(70_000),
      openai: ok('g out', 100, 100_000), // codex root disabled — only lane B is gated here
    }, opts), /names 2 session files.*000000000004-a\.jsonl.*000000000004-b\.jsonl/s);
  }
  // and the null that would have been MEASURED off whichever file sorted first
  {
    const db = openDb(':memory:');
    assert.throws(() => recordResults(db, fresh(db),
      { anthropic: anth(null), openai: ok('g out', 100, 100_000) }, opts), /names 2 session files/);
  }
  // the refusal is actionable, not terminal: with the stray copy gone the same record lands, and
  // the surviving file is the one that both attests and measures
  {
    const db = openDb(':memory:');
    const duel = fresh(db);
    rmSync(join(root, `${id}-a.jsonl`));
    const res = recordResults(db, duel,
      { anthropic: anth(null), openai: ok('g out', 100, 100_000) }, opts);
    assert.equal(res.status, 'awaiting_judgment');
    assert.equal(getDuel(db, duel).anth_latency_ms, 1_200_000);
  }
});

// The same two-file root, one filter apart. Sorted order alone did not make the two scans agree:
// the attesting scan skips a candidate whose session STARTED before the duel row existed, the
// measuring scan applied no such test, so an archived copy — stale start, fresh mtime — sorted
// first and floored the claim against a span that begins before the duel does. Both scans run
// ONE filter now, and the file that attests a side is the file that measures it.
test('one id, two files: a stale-start archive attests nothing and floors nothing', () => {
  const created = Date.parse('2026-08-10T10:00:00.000Z');
  const root = mkdtempSync(join(tmpdir(), 'mr-spanpick-'));
  const id = 'bbbbbbbb-0000-0000-0000-000000000005';
  const mk = (suffix: string, startMs: number, endMs: number) => {
    const p = join(root, `${id}${suffix}.jsonl`);
    writeFileSync(p, `{"timestamp":"${new Date(startMs).toISOString()}"}\n`);
    utimesSync(p, endMs / 1000, endMs / 1000);
  };
  // sorts FIRST and its last write is recent enough to attest — but it started 10 minutes before
  // the duel row, so it is not this run's file
  mk('-a', created - 600_000, created + 1_200_000);
  // the live rollout: starts after the duel, spans 2 minutes
  mk('-b', created + 10_000, created + 130_000);
  const opts = { roots: { B: root, codex: null }, now: created + 1_300_000 };
  const fresh = (db: any) =>
    createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, created);
  const anth = (latencyMs: number | null) =>
    ({ output: 'a out', tokens: 100, latencyMs, failed: false, proof: id });

  // a truthful 70s claim records — the archive's 30-minute span never reaches the floor
  {
    const db = openDb(':memory:');
    const duel = fresh(db);
    const res = recordResults(db, duel, { anthropic: anth(70_000), openai: ok('g out', 100, 100_000) }, opts);
    assert.equal(res.status, 'awaiting_judgment');
    assert.equal(getDuel(db, duel).anth_latency_ms, 70_000);
  }
  // the null derivation measures the live rollout: a 2-minute run is not recorded as a 30-minute one
  {
    const db = openDb(':memory:');
    const duel = fresh(db);
    recordResults(db, duel, { anthropic: anth(null), openai: ok('g out', 100, 100_000) }, opts);
    assert.equal(getDuel(db, duel).anth_latency_ms, 120_000);
  }
  // and the floor still binds — against the file that actually attested
  {
    const db = openDb(':memory:');
    const duel = fresh(db);
    assert.throws(() => recordResults(db, duel,
      { anthropic: anth(1_000), openai: ok('g out', 100, 100_000) }, opts), /spans 120000ms/);
  }
});

test('v2.11: both judges grade neither → terminal quality failure, no latency winner', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  assert.deepEqual(judge(db, id, 'anthropic', 'neither', 2),
    { status: 'awaiting_judgment' });
  const r = judge(db, id, 'openai', 'neither', 3);
  assert.deepEqual(r, { status: 'unresolved', taskKind: 'debugging', decidedBy: 'both_failed' });
  const row = db.prepare('SELECT status, winner_vendor, decided_by FROM duels WHERE id=?')
    .get(id) as any;
  assert.deepEqual({ ...row },
    { status: 'unresolved', winner_vendor: null, decided_by: 'both_failed' });
});

test('v2.11: judges clearing different sides → contested, and the faster side does NOT win', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  judge(db, id, 'anthropic', 'X', 2);
  const r = judge(db, id, 'openai', 'Y', 3);
  assert.deepEqual(r, { status: 'unresolved', taskKind: 'debugging', decidedBy: 'contested',
    factCheck: FACT_CHECK_OFFER });
  const row = db.prepare('SELECT status, winner_vendor, decided_by FROM duels WHERE id=?')
    .get(id) as any;
  assert.deepEqual({ ...row },
    { status: 'unresolved', winner_vendor: null, decided_by: 'contested' });
});

test('v2.11: both graded pass → latency decides and the row is judged', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  judge(db, id, 'anthropic', 'both', 2);
  const r = judge(db, id, 'openai', 'both', 3);
  assert.equal(r.status, 'judged');
  assert.equal(r.decidedBy, 'latency');
});

test('v2.11: every new vote is stamped graded=1', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  judge(db, id, 'anthropic', 'both', 2);
  const rows = db.prepare('SELECT graded FROM judgments WHERE duel_id=?').all(id);
  assert.deepEqual(rows.map(row => ({ ...row })), [{ graded: 1 }]);
});

test('v2.11: a duel holding a pre-upgrade preference vote refuses a graded second vote', () => {
  // Pre-state: a real v2.10 row, still awaiting_judgment across the upgrade (duel #167's shape).
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, graded)
    VALUES (?,?,?,?,?,0)`).run(id, 'anthropic', 'X', 2, null);
  const proof = '019f95bb-2cd2-8ac4-b1e6-d41f574eef71';
  assert.throws(() => judge(db, id, 'openai', 'both', 3, { ...NOPROOF, proof }),
    /pre-v2\.11\.0 preference vote/);
  // The refusal costs the caller nothing: the proof is NOT spent, so the re-judge can reuse it.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM proof_claims WHERE proof=?')
    .get(proof) as any).n, 0);
  // ...and the row is untouched: still awaiting, still holding exactly the one legacy vote.
  assert.equal((db.prepare('SELECT status FROM duels WHERE id=?').get(id) as any).status,
    'awaiting_judgment');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM judgments WHERE duel_id=?')
    .get(id) as any).n, 1);
});

// This test used to stamp the duel TERMINAL before calling the writer, so recordJudgment returned
// from the stored duels row at the top — before the vocabulary guard and before the judgments
// SELECT — and passed whether or not the two legacy rows existed at all (duel-174 F6). The
// contract in its name is that the resolution is reached THROUGH the stored legacy votes, so the
// pre-state now leaves the duel awaiting and those votes are the only thing that can resolve it.
test('v2.11: a fully legacy pair resolves THROUGH its stored votes — readable, never rewritten', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, graded)
    VALUES (?,?,?,?,?,0), (?,?,?,?,?,0)`)
    .run(id, 'anthropic', 'tie', 2, null, id, 'openai', 'tie', 3, null);
  assert.equal(getDuel(db, id).status, 'awaiting_judgment'); // nothing terminal to return early on
  // 'tie' asserted that neither side was worse, i.e. neither failed: both sides pass, so the
  // clock separates them and anthropic (100ms vs 200ms) wins.
  const r = judge(db, id, 'anthropic', 'both', 4);
  assert.deepEqual(r,
    { status: 'judged', winner: 'anthropic', decidedBy: 'latency', taskKind: 'debugging' });
  // the legacy rows were READ, not rewritten: still 'tie', still graded=0, and no third row —
  // the incoming graded vote is discarded by the unique index, so nothing mixed is stored.
  assert.deepEqual(
    db.prepare('SELECT verdict, graded FROM judgments WHERE duel_id=? ORDER BY id').all(id)
      .map(row => ({ ...row })),
    [{ verdict: 'tie', graded: 0 }, { verdict: 'tie', graded: 0 }]);
  // and the stored resolution replays from the duels row on the next call
  assert.deepEqual(judge(db, id, 'openai', 'both', 5), r);
});

// A pre-upgrade crash between the second legacy INSERT and the duel UPDATE leaves a duel
// awaiting_judgment holding TWO complete legacy votes — the exact stranded shape the retry path
// exists for. v2.11.0's blanket guard refused it before reaching the duplicate-insert recovery,
// even though both proofs were already spent: a losslessly resolvable duel cost two fresh judge
// runs or was stranded outright (duel-174 F2). An all-legacy pair is not MIXED, it is old.
test('v2.11: a pre-upgrade crash holding two legacy votes still resolves on retry', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  const anthLabel = JSON.parse(getDuel(db, id).label_map).X === 'anthropic' ? 'X' : 'Y';
  // both v2.10 votes committed, the duel row never updated
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, graded)
    VALUES (?,?,?,?,?,0), (?,?,?,?,?,0)`)
    .run(id, 'anthropic', anthLabel, 2, null, id, 'openai', anthLabel, 3, null);
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
  // legacy 'X'/'Y' says that side is the better one, which under the absolute read means it is
  // the side that did not fail: both judges cleared the same one, so quality decides.
  const retry = judge(db, id, 'openai', 'both', 4);
  assert.deepEqual(retry,
    { status: 'judged', winner: 'anthropic', decidedBy: 'judges', taskKind: 'debugging' });
  assert.equal(getDuel(db, id).status, 'judged');
  // idempotent on a second retry, and the stored votes are untouched
  assert.deepEqual(judge(db, id, 'openai', 'both', 5), retry);
  assert.deepEqual(
    db.prepare('SELECT verdict, graded FROM judgments WHERE duel_id=? ORDER BY id').all(id)
      .map(row => ({ ...row })),
    [{ verdict: anthLabel, graded: 0 }, { verdict: anthLabel, graded: 0 }]);
});

// The refusal is for MIXED provenance, so the already-mixed pair a racing old writer can leave
// behind must stay refused — it is the one combination whose resolution would be fabricated.
test('v2.11: a stored pair of one legacy and one graded vote is refused, not resolved', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, graded)
    VALUES (?,?,?,?,NULL,1), (?,?,?,?,NULL,0)`)
    .run(id, 'anthropic', 'both', 2, id, 'openai', 'X', 3);
  assert.throws(() => judge(db, id, 'openai', 'both', 4), /pre-v2\.11\.0 preference vote/);
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
  assert.equal(getDuel(db, id).winner_vendor, null);
});

test('v2.11: an unresolved row replays its decided_by, not a bare unresolved', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  judge(db, id, 'anthropic', 'neither', 2);
  judge(db, id, 'openai', 'neither', 3);
  // Idempotent replay of the resolving vote.
  assert.deepEqual(judge(db, id, 'openai', 'neither', 4),
    { status: 'unresolved', taskKind: 'debugging', decidedBy: 'both_failed' });
});

test('v2.11: a union row still refuses every grade token', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'debugging', SIDES,
    { mutating: false, spotCheck: false, unionMode: true }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  for (const t of ['X', 'Y', 'both', 'neither'] as const) {
    assert.throws(() => judge(db, id, 'anthropic', t, 2), /never judged/);
  }
});

// ——— duel-174: the graded-vocabulary transition ———

// Table-driven per the repo's transition rule: pre-state → migration → retry/replay → public
// surface, across the current schema, the immediately previous one, and the legacy spellings.
// The v2.11.0 compatibility test opened a CURRENT-schema in-memory DB and wrote graded=0 by
// hand, so it never exercised the migration's DEFAULT, never opened a pre-v2.11.0 judgments
// table, and never used the legacy 'tie' spelling (duel-174 F7).
const legacyDuel = (db: any) => {
  seedMatrix(db, 1);
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  return id;
};
// Exactly the pre-v2.11.0 writer's INSERT: its code has no `graded` column, so it names none.
const LEGACY_INSERT = `INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof)
  VALUES (?,?,?,?,NULL), (?,?,?,?,NULL)`;

const GRADED_PRE_STATES: Array<{ name: string; build: () => { db: any; id: number } }> = [
  {
    name: 'the current schema, legacy rows stamped graded=0 explicitly',
    build: () => {
      const db = openDb(':memory:');
      const id = legacyDuel(db);
      db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, graded)
        VALUES (?,?,?,?,NULL,0), (?,?,?,?,NULL,0)`)
        .run(id, 'anthropic', 'tie', 2, id, 'openai', 'tie', 3);
      return { db, id };
    },
  },
  {
    name: 'the current schema with the column OMITTED, so the DEFAULT marks the rows legacy',
    build: () => {
      const db = openDb(':memory:');
      const id = legacyDuel(db);
      // This is what an already-running pre-v2.11.0 process writes into a migrated DB.
      db.prepare(LEGACY_INSERT).run(id, 'anthropic', 'tie', 2, id, 'openai', 'tie', 3);
      return { db, id };
    },
  },
  {
    name: 'the immediately previous schema — no graded column at all until openDb migrates it in',
    build: () => {
      const path = join(mkdtempSync(join(tmpdir(), 'mr-graded-')), 'mr.db');
      const pre = openDb(path);
      const id = legacyDuel(pre);
      // back to v2.10's judgments table, then write the votes as v2.10 wrote them
      pre.exec('ALTER TABLE judgments DROP COLUMN graded');
      pre.prepare(LEGACY_INSERT).run(id, 'anthropic', 'tie', 2, id, 'openai', 'tie', 3);
      pre.close();
      // the additive migration runs on this open and marks every pre-existing row legacy —
      // correctly, and with no backfill pass to get wrong
      return { db: openDb(path), id };
    },
  },
];

for (const c of GRADED_PRE_STATES) {
  test(`v2.11: legacy 'tie' votes under ${c.name} resolve, replay, and reach standings`, () => {
    const { db, id } = c.build();
    // pre-state: two legacy rows, however they were written, and a duel still awaiting
    assert.deepEqual(
      db.prepare('SELECT verdict, graded FROM judgments WHERE duel_id=? ORDER BY id').all(id)
        .map((row: any) => ({ ...row })),
      [{ verdict: 'tie', graded: 0 }, { verdict: 'tie', graded: 0 }]);
    assert.equal(getDuel(db, id).status, 'awaiting_judgment');

    // retry: resolved through the stored legacy votes, on the clock ('tie' clears both sides)
    const r = judge(db, id, 'openai', 'both', 4);
    assert.deepEqual(r,
      { status: 'judged', winner: 'anthropic', decidedBy: 'latency', taskKind: 'debugging' });
    assert.equal(getDuel(db, id).decided_by, 'latency');
    // idempotent replay
    assert.deepEqual(judge(db, id, 'openai', 'both', 5), r);

    // public surface: counted once, on the time channel, and the two 'tie' votes ARE agreement
    const s = standings(db).find(k => k.kind === 'debugging')!;
    assert.deepEqual(
      { judged: s.judged, anthWins: s.anthWins, aj: s.anthJudgeWins, al: s.anthLatencyWins,
        pct: s.judgeAgreementPct },
      { judged: 1, anthWins: 1, aj: 0, al: 1, pct: 100 });
  });
}

// Repo rule 3: every concurrency claim gets a FILE-BACKED, TWO-CONNECTION test — one :memory:
// connection proves nothing about racing writers. The claim is that the mixed-vocabulary refusal
// is atomic, and at v2.11.0 it was not: the guard counted graded=0 rows in autocommit and
// BEGIN IMMEDIATE came ~60 lines later, so an already-running pre-v2.11.0 MCP server (the ops
// doc promises exactly that topology — "an old MCP server keeps its code until its session
// restarts") could commit its default-graded=0 vote inside that window, and this process would
// then resolve a legacy preference token together with an absolute grade and persist a
// fabricated result (duel-174 F1). onBeforeWriteLock fires exactly where the stale read used to
// sit, so a guard moved back outside the transaction fails this test.
test('a pre-v2.11.0 writer racing the guard window cannot fabricate a mixed resolution', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-mixvote-')), 'mr.db');
  const db = openDb(path);
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  const proof = '019f95bb-2cd2-8ac4-b1e6-d41f574eef72';
  let raced = false;
  assert.throws(() => recordJudgment(db, id, 'openai', 'both', 3, {
    ...NOPROOF, proof,
    onBeforeWriteLock: () => {
      if (raced) return; // the rival process votes once
      raced = true;
      // SECOND CONNECTION, running the OLD code: no `graded` column exists in its INSERT, so
      // the migration default marks the row legacy.
      const old = openDb(path);
      old.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof)
        VALUES (?,?,?,?,NULL)`).run(id, 'anthropic', 'X', 2);
      old.close();
    },
  }), /pre-v2\.11\.0 preference vote/);
  assert.ok(raced, 'the rival never got its window — this test proved nothing');
  // nothing fabricated: the graded vote was never stored, so no resolution could be computed
  assert.deepEqual(
    db.prepare('SELECT judge_vendor, verdict, graded FROM judgments WHERE duel_id=?').all(id)
      .map((row: any) => ({ ...row })),
    [{ judge_vendor: 'anthropic', verdict: 'X', graded: 0 }]);
  assert.equal(getDuel(db, id).status, 'awaiting_judgment');
  assert.equal(getDuel(db, id).winner_vendor, null);
  // and the refusal still costs the caller nothing — the re-judge needs this session id back
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM proof_claims WHERE proof=?')
    .get(proof) as any).n, 0);
  db.close();
});

// judgeAgreementPct spans two populations at once, and the ratio is only honest if BOTH are read
// by the rule they were written under (duel-174 F3). A vote pair is read from the tokens — the
// v2.11.0 meaning — while a pre-v2.11.0 judged row retained no votes at all, so the tokens cannot
// be consulted and its decided_by, which back then DID encode preference agreement, still is the
// correct reading of that row. Reading the residue by the new rule would drop every pre-upgrade
// duel out of the ratio; reading the pairs by the old one is the bug the finding names.
test('v2.11: judge agreement reads vote pairs by their tokens and pre-upgrade rows by decided_by',
  () => {
    const db = openDb(':memory:');
    seedMatrix(db, 1);
    const duel = (anth: number, gpt: number) => {
      const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
      rec(db, id, { anthropic: ok('a', 9_000, anth), openai: ok('b', 9_000, gpt) });
      return id;
    };
    // AGREE, on the clock: identical grades, so the tokens agree even though latency separated
    // the sides — the exact case the retired decided_by reading scored as disagreement.
    const agreeing = duel(100, 200);
    judge(db, agreeing, 'anthropic', 'both', 2);
    judge(db, agreeing, 'openai', 'both', 3);
    // DISAGREE, decided by the judges: 'both' vs 'X' clears only X, so decided_by='judges' —
    // the retired reading scored this one as agreement. Both errors are corrected here at once.
    const split = duel(100, 200);
    judge(db, split, 'anthropic', 'both', 4);
    judge(db, split, 'openai', 'X', 5);
    // A half-collected pair is in neither population: there is no agreement in one vote.
    const halfVoted = duel(100, 200);
    judge(db, halfVoted, 'anthropic', 'both', 6);
    assert.equal(getDuel(db, halfVoted).status, 'awaiting_judgment');
    // Pre-v2.11.0 residue: judged rows whose votes were never retained. Only a direct INSERT can
    // build them — the current writer always stores its votes — and they are why the fixture in
    // tests/standings.test.ts still reads 60%.
    const residue = (decidedBy: string) => db.prepare(
      `INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map,
         status, winner_vendor, decided_by)
       VALUES ('debugging', 1, 0, 0, '[]', '{"X":"anthropic","Y":"openai"}',
         'judged', 'anthropic', ?)`).run(decidedBy);
    residue('judges');    // the two preferences matched → agreement, under the old vocabulary
    residue('latency');   // they did not

    const s = standings(db).find(k => k.kind === 'debugging')!;
    // 4 readable duels (2 pairs + 2 residue rows; the half-voted one is excluded), 2 agreeing:
    // one from each population, so neither rule alone can produce this number.
    assert.equal(s.judgeAgreementPct, 50);
    assert.equal(s.judged, 4); // the half-voted duel is still awaiting, so it is not judged
  });

// The null is "nothing to report", not 0% — a kind whose duels never reached a judge has no
// agreement to state, and reporting 0 would read as judges who never agree.
test('v2.11: judge agreement is null when no duel in the window can be read at all', () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  const id = createDuel(db, 'debugging', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 9_000, 100), openai: ok('b', 9_000, 200) });
  judge(db, id, 'anthropic', 'both', 2); // one vote: half a pair, and the row is not judged
  assert.equal(standings(db).find(k => k.kind === 'debugging')!.judgeAgreementPct, null);
});

// v15: recorded_by_version answers "which build FIRST wrote results on this row" — never
// "which build touched it last". The three first-recording shapes stamp; every later write
// (late fill, revival, dead replay) leaves whatever the row already holds, NULL included.
const V15_FIRST_RECORDINGS: Array<{
  name: string; run: (db: any, id: number) => void; status: string;
}> = [
  { name: 'real sides', status: 'awaiting_judgment',
    run: (db, id) => rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('g', 900, 80) }) },
  { name: 'walkover', status: 'walkover',
    run: (db, id) => rec(db, id, { anthropic: ok('a', 500, 100), openai: FAILED }) },
  { name: 'both-failed death', status: 'abandoned',
    run: (db, id) => rec(db, id, { anthropic: FAILED, openai: FAILED }) },
];

for (const row of V15_FIRST_RECORDINGS) {
  test(`the first recording stamps the running build: ${row.name}`, () => {
    const db = openDb(':memory:');
    const id = createDuel(db, 'implementation-misc', SIDES,
      { mutating: false, spotCheck: false }, 1);
    assert.equal(getDuel(db, id).recorded_by_version, null); // routed: nothing recorded yet
    row.run(db, id);
    const d = getDuel(db, id);
    assert.equal(d.status, row.status);
    assert.equal(d.recorded_by_version, pluginVersion());
    assert.equal(d.minted_by_version, pluginVersion());
  });
}

test('a void recording stamps the build like any other first recording', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  const reduel = createDuel(db, 'implementation-misc', SIDES,
    { mutating: false, spotCheck: false }, 2);
  rec(db, id, { anthropic: FAILED, openai: FAILED }, { ...NOPROOF, supersededBy: reduel });
  assert.equal(getDuel(db, id).recorded_by_version, pluginVersion());
});

test('a late union fill keeps the original stamp — and leaves a pre-v15 NULL alone', () => {
  const db = openDb(':memory:');
  const fill = (stamp: string | null) => {
    const id = createDuel(db, 'deep-review', SIDES,
      { mutating: false, spotCheck: false, unionMode: true }, 1);
    rec(db, id, { anthropic: ok('a', 500, 100), openai: FAILED });
    assert.equal(getDuel(db, id).recorded_by_version, pluginVersion());
    // Rewrite the stamp to what an older build (or a pre-v15 one) would have left behind.
    db.prepare('UPDATE duels SET recorded_by_version=? WHERE id=?').run(stamp, id);
    rec(db, id, { anthropic: FAILED, openai: ok('g', 900, 80) });
    assert.equal(getDuel(db, id).status, 'union');
    assert.ok(getDuel(db, id).gpt_output); // the fill really landed
    return getDuel(db, id).recorded_by_version;
  };
  assert.equal(fill('2.13.19'), '2.13.19');
  assert.equal(fill(null), null);
});

test('a dead replay does not re-stamp a row whose death was already recorded', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: FAILED, openai: FAILED });
  db.prepare('UPDATE duels SET recorded_by_version=NULL WHERE id=?').run(id); // as a v14 build left it
  rec(db, id, { anthropic: FAILED, openai: FAILED });
  assert.equal(getDuel(db, id).recorded_by_version, null);
});

test('reviving a swept row that never recorded anything stamps the reviving build', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  expireStaleDuels(db, 1 + DUEL_TTL_MS + 1);
  assert.equal(getDuel(db, id).status, 'abandoned');
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('g', 900, 80) });
  assert.equal(getDuel(db, id).recorded_by_version, pluginVersion());
});

// v2.13.28: judge letter grades. Observational — stored beside the verdict for the operator's
// GPA trend, never consulted by resolveVerdict. Both-or-neither: a one-sided grade says
// nothing comparable about the duel and is refused before anything is written.
test('recordJudgment stores per-side letter grades on the vote', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('g', 900, 80) });
  judge(db, id, 'anthropic', 'both', 2, { ...NOPROOF, gradeX: 'A-', gradeY: 'B+' });
  const row = db.prepare('SELECT grade_x, grade_y FROM judgments WHERE duel_id=?').get(id) as any;
  assert.deepEqual({ x: row.grade_x, y: row.grade_y }, { x: 'A-', y: 'B+' });
});

test('a one-sided grade is refused and writes no vote', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('g', 900, 80) });
  assert.throws(
    () => judge(db, id, 'anthropic', 'both', 2, { ...NOPROOF, gradeX: 'A' }),
    /both sides or neither/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM judgments WHERE duel_id=?').get(id)!.c, 0);
});

test('an unrecognized grade token is refused', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('g', 900, 80) });
  assert.throws(
    () => judge(db, id, 'anthropic', 'both', 2, { ...NOPROOF, gradeX: 'E', gradeY: 'A' }),
    /not a letter grade/);
});

test('grades never influence resolution — a graded duel resolves exactly as an ungraded one', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 5000, 100), openai: ok('g', 9000, 80) });
  const labelMap = JSON.parse(getDuel(db, id).label_map);
  const anthLabel = labelMap.X === 'anthropic' ? 'X' : 'Y';
  // The grades say the losing side was nearly perfect; the verdicts alone must decide.
  judge(db, id, 'anthropic', anthLabel, 2,
    { ...NOPROOF, gradeX: labelMap.X === 'anthropic' ? 'A' : 'A+', gradeY: labelMap.X === 'anthropic' ? 'A+' : 'A' });
  const fin = judge(db, id, 'openai', anthLabel, 3, NOPROOF);
  assert.equal(fin.status, 'judged');
  if (fin.status !== 'judged') return;
  assert.equal(fin.winner, 'anthropic');
});

// v2.13.29: the merge path. A judge may RECOMMEND a path beside its verdict ('X', 'Y' or
// 'merge'); when BOTH judges direct a merge and BOTH sides met the bar, the best answer is the
// composition, so the duel resolves with no winner to credit: decided_by 'merge', a terminal
// judged row. Anything less than that agreement is advisory — resolution is unchanged.
test('both judges directing a merge on two passing sides resolves decided_by merge, no winner', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: true, spotCheck: false }, 1);
  rec(db, id, { anthropic: { ...ok('a', 5000, 100), gate: 'pass', gateDetail: 'node tests/t.js 10/0' },
    openai: { ...ok('g', 9000, 80), gate: 'pass', gateDetail: 'node tests/t.js 10/0' } });
  judge(db, id, 'anthropic', 'both', 2, { ...NOPROOF, path: 'merge' });
  const fin = judge(db, id, 'openai', 'both', 3, { ...NOPROOF, path: 'merge' });
  assert.deepEqual(fin, { status: 'judged', winner: null, decidedBy: 'merge',
    taskKind: 'implementation-misc' });
  const d = getDuel(db, id);
  assert.deepEqual({ status: d.status, winner: d.winner_vendor, by: d.decided_by },
    { status: 'judged', winner: null, by: 'merge' });
});

test('a single merge recommendation is advisory — resolution proceeds as if unrecommended', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 5000, 100), openai: ok('g', 9000, 80) });
  judge(db, id, 'anthropic', 'both', 2, { ...NOPROOF, path: 'merge' });
  const fin = judge(db, id, 'openai', 'both', 3, NOPROOF);
  // both passed, clocks differ: the openai side is faster — the ordinary latency resolution
  assert.deepEqual(fin, { status: 'judged', winner: 'openai', decidedBy: 'latency',
    taskKind: 'implementation-misc' });
});

test('a failed gate blocks the merge — ground truth outranks two merge recommendations', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: true, spotCheck: false }, 1);
  rec(db, id, { anthropic: { ...ok('a', 5000, 100), gate: 'fail', gateDetail: 'node tests/t.js 9/1' },
    openai: { ...ok('g', 9000, 80), gate: 'pass', gateDetail: 'node tests/t.js 10/0' } });
  judge(db, id, 'anthropic', 'both', 2, { ...NOPROOF, path: 'merge' });
  const fin = judge(db, id, 'openai', 'both', 3, { ...NOPROOF, path: 'merge' });
  assert.deepEqual(fin, { status: 'judged', winner: 'openai', decidedBy: 'judges',
    taskKind: 'implementation-misc' });
});

test('an unrecognized path token is refused before anything is written', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1);
  rec(db, id, { anthropic: ok('a', 5000, 100), openai: ok('g', 9000, 80) });
  assert.throws(
    () => judge(db, id, 'anthropic', 'both', 2, { ...NOPROOF, path: 'combine' as any }),
    /not a path/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM judgments WHERE duel_id=?').get(id)!.c, 0);
});

// Composed (repo rule 2): grades and path share the judgments row — one vote carrying both
// must store both, resolve by merge, and still feed the GPA.
test('a vote carrying grades AND a merge path stores both and both channels read it', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'implementation-misc', SIDES, { mutating: true, spotCheck: false }, 1);
  rec(db, id, { anthropic: { ...ok('a', 5000, 100), gate: 'pass', gateDetail: 'node tests/t.js 10/0' },
    openai: { ...ok('g', 9000, 80), gate: 'pass', gateDetail: 'node tests/t.js 10/0' } });
  judge(db, id, 'anthropic', 'both', 2,
    { ...NOPROOF, path: 'merge', gradeX: 'A', gradeY: 'A-' });
  const fin = judge(db, id, 'openai', 'both', 3,
    { ...NOPROOF, path: 'merge', gradeX: 'A-', gradeY: 'A' });
  assert.equal(fin.status === 'judged' && fin.decidedBy, 'merge');
  const rows = db.prepare(
    'SELECT path, grade_x, grade_y FROM judgments WHERE duel_id=? ORDER BY id').all(id) as any[];
  assert.deepEqual(rows.map(r => ({ p: r.path, x: r.grade_x, y: r.grade_y })),
    [{ p: 'merge', x: 'A', y: 'A-' }, { p: 'merge', x: 'A-', y: 'A' }]);
  const s = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.equal(s.gpa.gradedVotes, 2);
  assert.equal(s.mergedShips, 1);
});

// Duel 391 M8: the void tombstone was a listing marker only — recordResults admitted any
// `abandoned` row and a record that left it alive cleared superseded_by and death_recorded, so
// a later session could revive a round the controller threw away on purpose (212, re-run as
// 213) and score it against work the re-duel had already shipped.
test('a voided round is never revived; a displaced one still is; a dead replay against a void is a no-op', () => {
  const db = openDb(':memory:');
  const mk = (n: number) =>
    createDuel(db, 'implementation-misc', SIDES, { mutating: true, spotCheck: false }, n);
  const reduel = mk(1);
  const both = { anthropic: ok('a', 9000, 100), openai: ok('g', 8000, 90) };
  // voided: the controller's own death record carries the marker
  const voided = mk(2);
  rec(db, voided, {
    anthropic: { ...FAILED, environment: 'VOID: brief defect' },
    openai: { ...FAILED, environment: 'VOID: brief defect' },
  }, { ...NOPROOF, supersededBy: reduel });
  const before = getDuel(db, voided);
  assert.throws(() => rec(db, voided, both), /voided/);
  assert.throws(() => rec(db, voided, { anthropic: ok('a', 9000, 100), openai: FAILED }), /voided/);
  assert.deepEqual(getDuel(db, voided), before);
  // dead replay against the void: no-op — tombstone kept, clocks unmoved
  rec(db, voided, { anthropic: FAILED, openai: FAILED });
  const after = getDuel(db, voided);
  for (const f of ['status', 'superseded_by', 'death_recorded', 'abandoned_at', 'recorded_at']) {
    assert.equal(after[f], before[f], f);
  }
  // legacy spelling: decided_by='superseded' with a NULL link, death recorded
  const legacy = mk(3);
  rec(db, legacy, { anthropic: FAILED, openai: FAILED });
  db.prepare("UPDATE duels SET decided_by='superseded' WHERE id=?").run(legacy);
  assert.throws(() => rec(db, legacy, both), /voided/);
  // displaced: a rival audit's success wrote the link; nobody recorded this round's death
  const displaced = mk(4);
  db.prepare("UPDATE duels SET status='abandoned', decided_by='superseded', superseded_by=?, "
    + 'abandoned_at=? WHERE id=?').run(reduel, 5, displaced);
  rec(db, displaced, both);
  const d = getDuel(db, displaced);
  assert.equal(d.status, 'awaiting_judgment');
  assert.equal(d.superseded_by, null);
  assert.equal(d.death_recorded, 0);
});
