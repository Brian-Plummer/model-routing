import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seedMatrix, getRow, setDecided, setUnionMode } from '../src/matrix.js';
import { createDuel, recordResults, recordJudgment, getDuel, expireStaleDuels, DUEL_TTL_MS } from '../src/duel.js';
import { routeTask } from '../src/router.js';
import { standings, pendingDuels } from '../src/standings.js';
import type { Side } from '../src/types.js';

const NOW = 1_700_000_000_000;
const SIDES: [Side, Side] = [
  { vendor: 'anthropic', lane: 'B', model: 'opus', effort: 'xhigh' },
  { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
];
const ok = (output: string, tokens: number, latencyMs: number) =>
  ({ output, tokens, latencyMs, failed: false });
const FAILED = { output: null, tokens: null, latencyMs: null, failed: true };
// attestation off — union mechanics under test; proof rules are shared with duels and
// covered in proof.test.ts
const NOPROOF = { roots: { B: null, codex: null } };
const rec: typeof recordResults = (db, id, results, opts = NOPROOF) =>
  recordResults(db, id, results, opts);

const snap = (db: any, lane: string, weeklyPct: number) =>
  db.prepare('INSERT INTO quota_snapshots(lane, fetched_at, payload) VALUES (?,?,?)')
    .run(lane, NOW, JSON.stringify({ lane, fetchedAt: NOW, windows: [
      { windowMinutes: 10080, utilization: weeklyPct, resetsAt: NOW + 86_400_000 }] }));
const freshDb = () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  for (const lane of ['A', 'B', 'codex', 'spark']) snap(db, lane, 10);
  return db;
};
const unionDuel = (db: any, kind = 'deep-review') =>
  createDuel(db, kind, SIDES, { mutating: false, spotCheck: false, unionMode: true }, 1);

test('deep-review seeds as union: both sides run, no contest, no spot-check', () => {
  const db = freshDb();
  const d = routeTask(db, { kind: 'deep-review' }, NOW);
  assert.equal(d.mode, 'union');
  assert.deepEqual(d.sides.map(s => s.vendor), ['anthropic', 'openai']);
  assert.equal(d.spotCheck, false);
  assert.ok(d.duelId);
  assert.equal(getDuel(db, d.duelId!).union_mode, 1);
});

// duel-207 P3: nothing routed the new seed row — a dropped union flag or a wrong effort in
// SEED passed 434/434. The route pin beside deep-review's closes that for web-research.
test('web-research seeds as union at opus@high (B): both sides run, no spot-check', () => {
  const db = freshDb();
  const d = routeTask(db, { kind: 'web-research' }, NOW);
  assert.equal(d.mode, 'union');
  assert.deepEqual(d.sides.map(s => s.vendor), ['anthropic', 'openai']);
  const anth = d.sides.find(s => s.vendor === 'anthropic')!;
  assert.equal(anth.model, 'opus');
  assert.equal(anth.effort, 'high');
  assert.equal(anth.lane, 'B');
  assert.equal(d.spotCheck, false);
  assert.ok(d.duelId);
  assert.equal(getDuel(db, d.duelId!).union_mode, 1);
});

test('a union kind never routes single off a stale victory, and never spot-checks', () => {
  const db = freshDb();
  // a decision left over from the contest era must not resurrect single-vendor routing
  setDecided(db, 'deep-review', 'openai', 2, 'victory');
  setUnionMode(db, 'deep-review', true, 3);
  assert.equal(getRow(db, 'deep-review').decided, 0);
  for (let i = 0; i < 12; i++) {
    const d = routeTask(db, { kind: 'deep-review' }, NOW);
    assert.equal(d.mode, 'union');
    assert.equal(d.spotCheck, false);
  }
});

test('a soft lane does NOT degrade a union to single — half the coverage is the whole point', () => {
  const db = freshDb();
  snap(db, 'codex', 85); // soft: enough to stop a duel, not enough to stop a union
  assert.equal(routeTask(db, { kind: 'deep-review' }, NOW).mode, 'union');
  // ...but a closed lane leaves nothing to merge with, and says so
  const db2 = freshDb();
  snap(db2, 'codex', 97);
  const d = routeTask(db2, { kind: 'deep-review' }, NOW);
  assert.equal(d.mode, 'single');
  assert.equal(d.sides[0].vendor, 'anthropic');
  assert.ok(d.notes.some(n => /merged coverage is incomplete/.test(n)));
});

test('recording a union stores both outputs and closes the row — no judging packet', () => {
  const db = freshDb();
  const id = unionDuel(db);
  const r = rec(db, id, { anthropic: ok('opus findings', 500, 100), openai: ok('sol findings', 400, 120) });
  assert.equal(r.status, 'union');
  if (r.status !== 'union') return;
  assert.deepEqual(r.sidesRecorded, ['anthropic', 'openai']);
  assert.deepEqual(r.failed, []);
  const row = getDuel(db, id);
  assert.equal(row.status, 'union');
  assert.equal(row.decided_by, 'union');
  assert.equal(row.winner_vendor, null);       // a union has no winner, ever
  assert.equal(row.anth_output, 'opus findings');
  assert.equal(row.gpt_output, 'sol findings');
});

test('one hung lane still closes a union row — the duel-37 case', () => {
  const db = freshDb();
  const id = unionDuel(db);
  // D7 2026-07-25: the codex side hung, the opus report was used, and under duel semantics the
  // row had nowhere to go but 'routed' until the 6h sweep marked it abandoned.
  const r = rec(db, id, { anthropic: ok('opus findings', 500, 100), openai: FAILED });
  assert.equal(r.status, 'union');
  if (r.status !== 'union') return;
  assert.deepEqual(r.sidesRecorded, ['anthropic']);
  assert.deepEqual(r.failed, ['openai']);
  const row = getDuel(db, id);
  assert.equal(row.status, 'union');           // closed, not left for the sweep
  assert.equal(row.winner_vendor, null);       // survivor is NOT promoted to a winner
  assert.equal(row.anth_output, 'opus findings');
  // and the sweep has nothing left to expire
  assert.deepEqual(expireStaleDuels(db, 1 + DUEL_TTL_MS + 1), []);
});

test('both lanes hung → abandoned, not a union with nothing in it', () => {
  const db = freshDb();
  const id = unionDuel(db);
  const r = rec(db, id, { anthropic: FAILED, openai: FAILED });
  // the row is stored 'abandoned', so the tool must say 'abandoned' — reporting 'union' told the
  // controller to ship a merge of nothing, and standings' unionRuns counted no such run either
  assert.equal(r.status, 'abandoned');
  if (r.status !== 'abandoned') return;
  assert.deepEqual(r.sidesRecorded, []);
  assert.deepEqual(r.failed, ['anthropic', 'openai']);
  assert.equal(getDuel(db, id).status, 'abandoned');
});

test('re-recording a union is idempotent, not an error', () => {
  const db = freshDb();
  const id = unionDuel(db);
  const first = rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 400, 120) });
  const again = rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 400, 120) });
  assert.deepEqual(again, first);
});

test('a union is never judged — judges are refused with a usable message', () => {
  const db = freshDb();
  const id = unionDuel(db);
  rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 400, 120) });
  assert.throws(() => recordJudgment(db, id, 'anthropic', 'X', 2, NOPROOF),
    /union run .* never judged|merge the reports/);
  assert.equal(getDuel(db, id).status, 'union');
});

test('union runs feed no contest aggregates — only unionRuns', () => {
  const db = freshDb();
  for (let i = 0; i < 10; i++) {
    const id = unionDuel(db);
    rec(db, id, { anthropic: ok('a', 500, 100), openai: ok('b', 400, 120) });
  }
  const s = standings(db).find(k => k.kind === 'deep-review')!;
  assert.equal(s.judged, 0);
  assert.equal(s.anthWins, 0);
  assert.equal(s.gptWins, 0);
  assert.equal(s.walkovers, 0);
  assert.equal(s.union, true);
  assert.equal(s.unionRuns, 10);
  assert.equal(getRow(db, 'deep-review').decided, 0);
});

test('a hung side stores no output, so its interim text cannot pass as a report', () => {
  const db = freshDb();
  const id = unionDuel(db);
  // The codex-hang shape from 2026-07-25: the run died leaving only a progress message, and the
  // controller records it failed:true but still passes what it has. Deriving "landed" from the
  // output text put that blob in sidesRecorded — the merge would have shipped it as findings.
  const r = rec(db, id, {
    anthropic: ok('opus findings', 500, 100),
    openai: { output: '[interim] scanning files…', tokens: 12, latencyMs: 90, failed: true },
  });
  assert.equal(r.status, 'union');
  if (r.status !== 'union') return;
  assert.deepEqual(r.sidesRecorded, ['anthropic']);
  assert.deepEqual(r.failed, ['openai']);
  assert.equal(getDuel(db, id).gpt_output, null);
});

test('a union closed one-sided accepts the recovered partner later', () => {
  const db = freshDb();
  const id = unionDuel(db);
  rec(db, id, { anthropic: ok('opus findings', 500, 100), openai: FAILED });
  // The hung lane's run is regularly recovered from its rollout afterwards — under duel
  // semantics the row was closed and that work could never be recorded at all.
  const second = rec(db, id, { anthropic: FAILED, openai: ok('recovered sol findings', 400, 120) });
  assert.equal(second.status, 'union');
  if (second.status !== 'union') return;
  assert.deepEqual(second.sidesRecorded, ['anthropic', 'openai']);
  assert.deepEqual(second.failed, []);
  const row = getDuel(db, id);
  assert.equal(row.anth_output, 'opus findings');       // the side that already landed is kept
  assert.equal(row.anth_tokens, 500);
  assert.equal(row.gpt_output, 'recovered sol findings');
  // and once both sides are in, it is idempotent again
  assert.deepEqual(rec(db, id, { anthropic: FAILED, openai: FAILED }), second);
});

test('setUnionMode reports whether a row was actually touched', () => {
  const db = freshDb();
  assert.equal(setUnionMode(db, 'deep-review', false, 3), 'changed');
  assert.equal(getRow(db, 'deep-review').union_mode, 0);
  assert.equal(setUnionMode(db, 'no-such-kind', true, 4), 'missing'); // a typo is not a success
});

test('union off on a kind that was never union leaves its verdict alone', () => {
  // The write clears decided/victor/spot_counter and bumps updated_at, which restarts the 8-duel
  // window. On a row already in the requested state that is pure destruction reported as success:
  // `mrctl union implementation off` used to wipe a settled contest and print "union off".
  const db = freshDb();
  setDecided(db, 'implementation-misc', 'anthropic', 1000, 'victory');
  assert.equal(setUnionMode(db, 'implementation-misc', false, NOW), 'unchanged');
  const row = getRow(db, 'implementation-misc');
  assert.equal(row.decided, 1);
  assert.equal(row.victor_vendor, 'anthropic');
  assert.equal(row.decided_mode, 'victory');
  assert.equal(row.updated_at, 1000); // untouched — the contest window does not restart
});

test('union on a row already union is a no-op, not a verdict wipe', () => {
  const db = freshDb();
  assert.equal(setUnionMode(db, 'deep-review', true, NOW), 'unchanged');
  assert.equal(getRow(db, 'deep-review').updated_at, 1); // seedMatrix's stamp, not NOW
});

test('a mutating task on a union kind routes as a contest, not a union', () => {
  // Two independent diffs have no merge — whose edit to a line survives is not a content
  // question. SKILL.md said route it as a duel; nothing enforced it, so route_task handed back
  // two diffs and no rule for applying either.
  const db = freshDb();
  const d = routeTask(db, { kind: 'deep-review', mutating: true }, NOW);
  assert.equal(d.mode, 'duel');
  assert.ok(d.notes.some(n => /reconcile two independent diffs/.test(n)), d.notes.join('; '));
  assert.equal(getDuel(db, d.duelId!).union_mode, 0); // recorded as what it ran as
  // Read-only work on the same kind is untouched.
  assert.equal(routeTask(db, { kind: 'deep-review' }, NOW).mode, 'union');
});

test('a landed union side is immutable — a careless second call cannot overwrite it', () => {
  const db = freshDb();
  const id = unionDuel(db);
  rec(db, id, { anthropic: ok('LONG opus report', 9000, 100), openai: FAILED });
  // The documented recovery passes the landed side failed:true. The CARELESS one re-sends it
  // as real, with different (truncated) text — that call used to rewrite the whole row and
  // silently destroy the attested report the union existed to preserve (duel-62 I5).
  const r = rec(db, id, { anthropic: ok('truncated', 10, 1), openai: ok('sol report', 8000, 90) });
  assert.equal(r.status, 'union');
  assert.deepEqual([...r.sidesRecorded].sort(), ['anthropic', 'openai']);
  const row = getDuel(db, id);
  assert.equal(row.anth_output, 'LONG opus report');
  assert.equal(row.anth_tokens, 9000);
  assert.equal(row.gpt_output, 'sol report'); // the missing side was filled in
});

test('a blank stored output is not a landed side — the repair path stays open', () => {
  const db = freshDb();
  const id = unionDuel(db);
  // a pre-2.6.1-shaped row: something empty landed in the output column
  db.prepare("UPDATE duels SET anth_output='   ', status='union', decided_by='union' WHERE id=?").run(id);
  // the recovery arrives with the real report — blank must not be immutable (duel-63 opus #7)
  const r = rec(db, id, { anthropic: ok('real report', 9000, 100), openai: FAILED });
  assert.equal(r.status, 'union');
  assert.equal(getDuel(db, id).anth_output, 'real report');
});

// ——— duel-65 ledger ———

// The union double-failure test was `=== null`, not the landed predicate: an all-blank legacy
// union retried with both sides failed returned {status:'union', sidesRecorded:[]} — an empty
// merge shipped as success, and unionRuns counted it (duel-65 sol S3).
test('retrying an all-blank legacy union with both sides failed is abandoned, not an empty union', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'deep-review', SIDES,
    { mutating: false, spotCheck: false, unionMode: true }, 1);
  db.prepare(`UPDATE duels SET status='abandoned', anth_output='   ',
    gpt_output=char(10)||char(9) WHERE id=?`).run(id); // pre-2.6.1 hung-lane error-text shapes
  const r = rec(db, id, { anthropic: FAILED, openai: FAILED });
  assert.equal(r.status, 'abandoned');
  assert.deepEqual((r as any).sidesRecorded, []);
  assert.equal(getDuel(db, id).status, 'abandoned');
});

// ——— duel-66 ledger ———

// The S3 fix reached only rows the sweep had already abandoned: an all-blank legacy row still
// in status='union' hit the replay guard FIRST — missing() is false for a failed caller side —
// and returned {status:'union', sidesRecorded:[]}, the same empty merge shipped as success
// (duel-66 opus I4). The guard now replays only rows that actually hold something.
test('retrying an all-blank legacy union still in status union lands abandoned too', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'deep-review', SIDES,
    { mutating: false, spotCheck: false, unionMode: true }, 1);
  db.prepare(`UPDATE duels SET status='union', decided_by='union', anth_output='   ',
    gpt_output=char(10)||char(9) WHERE id=?`).run(id); // pre-2.6.1 hung-lane error-text shapes
  const r = rec(db, id, { anthropic: FAILED, openai: FAILED });
  assert.equal(r.status, 'abandoned');
  assert.deepEqual((r as any).sidesRecorded, []);
  assert.equal(getDuel(db, id).status, 'abandoned');
});

// ——— duel-67 ledger ———

// The record whose own outcome IS 'abandoned' (union double failure) was the one record the
// unconditional abandoned_at=NULL must not touch: the row landed dead with no death stamp,
// pendingDuels' death-based horizon fell back to birth, and a freshly-dead old union vanished
// from every recovery surface the moment it died (duel-67 opus F2 / sol F3).
test('a union double failure stamps its own death — the row stays on the pending list', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'deep-review', SIDES,
    { mutating: false, spotCheck: false, unionMode: true }, NOW - 9 * 86_400_000);
  // swept yesterday: abandoned_at set by the sweep, still listed on the pending surfaces
  db.prepare(`UPDATE duels SET status='abandoned', abandoned_at=? WHERE id=?`)
    .run(NOW - 86_400_000, id);
  const r = rec(db, id, { anthropic: FAILED, openai: FAILED },
    { roots: { B: null, codex: null }, now: NOW });
  assert.equal(r.status, 'abandoned');
  assert.equal(getDuel(db, id).abandoned_at, NOW);
  assert.ok(pendingDuels(db, NOW).some(p => p.id === id),
    'a freshly-dead union must stay visible for revival');
});

// The narrowed replay guard exists so an all-blank status='union' row can still be COMPLETED:
// one real side falls through, is attested and stored, and the merge ships one-sided — the
// other half of the duel-66 opus I4 fix, pinned by duel-67.
test('an all-blank legacy union row accepts a late real side and ships it', () => {
  const db = openDb(':memory:');
  const id = createDuel(db, 'deep-review', SIDES,
    { mutating: false, spotCheck: false, unionMode: true }, 1);
  db.prepare(`UPDATE duels SET status='union', decided_by='union', anth_output='   ',
    gpt_output=char(10) WHERE id=?`).run(id);
  const r = rec(db, id, { anthropic: ok('recovered opus report', 500, 1000), openai: FAILED });
  assert.equal(r.status, 'union');
  assert.deepEqual((r as any).sidesRecorded, ['anthropic']);
  assert.equal(getDuel(db, id).anth_output, 'recovered opus report');
});
