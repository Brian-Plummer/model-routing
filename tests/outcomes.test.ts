import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { seedMatrix, getRow, setDecided, bumpSpotCounter, setVendorModel } from '../src/matrix.js';
import { recordOutcome, importScorecard, type OutcomeInput } from '../src/outcomes.js';

const SPARK = 'gpt-5.3-codex-spark';

// record_outcome attests spark runs exactly like a duel side, so these tests need a sessions
// root holding a real file per run. Ids are unique per call: proofs are single-use across the
// whole namespace, so re-using one would (correctly) be rejected as a double-spend.
// The file must also *be* a spark rollout — every codex-family run writes into this one
// directory, so the attestation reads the model out of the file.
const SPARK_ROOT = mkdtempSync(join(tmpdir(), 'mr-spark-'));
const ROOTS = { B: null, codex: SPARK_ROOT };
const settingsLine = (model: string) => JSON.stringify({
  type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_settings: { model, model_provider_id: 'openai' } },
});
let sparkSeq = 0;
const runId = (): string =>
  `${(++sparkSeq).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
const rollout = (model: string): string => {
  const id = runId();
  writeFileSync(join(SPARK_ROOT, `rollout-${id}.jsonl`), settingsLine(model) + '\n');
  return id;
};
const sparkRun = (): string => rollout(SPARK);
const rec = (db: any, o: OutcomeInput, now: number) =>
  recordOutcome(db, o, now, { roots: ROOTS });

// Since luna was retired (2026-07-25), spark IS the seeded gpt side of every haiku-tier row, so
// the earn-in path has no starting state in the seed any more. This simulates the operator
// re-pairing a row OFF spark — the only state left from which spark could try to earn one back.
const unspark = (db: any, kind: string, now: number) =>
  setVendorModel(db, kind, 'openai', 'gpt-5.6-terra', 'low', now);

const fail = (model: string, kind = 'implementation-misc'): OutcomeInput =>
  ({ date: '2026-07-23', taskKind: kind, model, kind: 'FAIL' as const, evidence: 'test',
    ...(model === SPARK ? { proof: sparkRun() } : {}) });
const promote = (model: string, kind = 'implementation-misc'): OutcomeInput =>
  ({ ...fail(model, kind), kind: 'PROMOTE' as const });

test('single FAIL never shifts the matrix', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  assert.equal(rec(db, fail('sonnet'), 2).applied, null);
  assert.equal(getRow(db, 'implementation-misc').anth_model, 'sonnet');
});

test('second FAIL on same kind+model flags the streak — the matrix does not move', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  rec(db, fail('sonnet'), 2);
  const r = rec(db, fail('sonnet'), 3);
  assert.equal(r.applied, null);
  assert.match(r.reason!, /FLAGGED for the operator/);
  assert.equal(getRow(db, 'implementation-misc').anth_model, 'sonnet');
});

test('two PROMOTEs flag the gpt side the same way; no rung is ever taken', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  rec(db, promote('gpt-6-astra', 'deep-review'), 2);
  const r = rec(db, promote('gpt-6-astra', 'deep-review'), 3);
  assert.equal(r.applied, null);
  assert.match(r.reason!, /FLAGGED/);
  assert.equal(getRow(db, 'deep-review').gpt_model, 'gpt-6-astra');
  // a model at the roster's end flags identically — there is no step left to refuse, only
  // evidence for the operator (terra is the ladder's floor; no seed row routes it since
  // 2026-09-05, so the operator re-pairs one onto it first)
  setVendorModel(db, 'implementation-build', 'openai', 'gpt-5.6-terra', 'medium', 3);
  rec(db, promote('gpt-5.6-terra', 'implementation-build'), 4);
  const r2 = rec(db, promote('gpt-5.6-terra', 'implementation-build'), 5);
  assert.match(r2.reason!, /FLAGGED/);
  assert.equal(getRow(db, 'implementation-build').gpt_model, 'gpt-5.6-terra');
});

test('no flag when matrix row no longer uses that model; a top-of-roster streak still flags', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  rec(db, fail('haiku'), 2);
  assert.equal(rec(db, fail('haiku'), 3).applied, null); // implementation-misc uses sonnet
  rec(db, fail('fable', 'debugging'), 4);
  const r = rec(db, fail('fable', 'debugging'), 5);
  assert.match(r.reason!, /FLAGGED/); // nowhere up to go, flagged anyway
  assert.equal(getRow(db, 'debugging').anth_model, 'fable');
});

test('spark holds its seeded haiku rows; 2 straight FAILs flag and never evict', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK); // seeded, not earned
  rec(db, fail(SPARK, 'bulk-mechanical-misc'), 4);
  const r2 = rec(db, fail(SPARK, 'bulk-mechanical-misc'), 5);
  assert.equal(r2.applied, null);
  assert.match(r2.reason!, /FLAGGED/);
  assert.match(r2.reason!, /no longer auto-evicts/);
  const row = getRow(db, 'bulk-mechanical-misc');
  assert.equal(row.gpt_model, SPARK);       // spark keeps fighting for its position
  assert.equal(row.gpt_effort, 'xhigh');
});

test('the earn-in shadow is retired: spark can never take a row it was not seeded onto', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  unspark(db, 'bulk-mechanical-misc', 1);
  // Two PROMOTEs used to hand spark the row outright. Now they are refused and logged SPENT, so
  // they cannot combine with anything later either.
  for (const at of [2, 3]) {
    const r = rec(db, promote(SPARK, 'bulk-mechanical-misc'), at);
    assert.equal(r.applied, null);
    assert.match(r.reason!, /does not route|earn-in shadow was retired/);
  }
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, 'gpt-5.6-terra');
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM outcomes WHERE model=? AND consumed=0").get(SPARK) as any).c, 0);
});

test('spark stays off GPT_LADDER — an outcome never ladder-steps it', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // transcription is seeded haiku vs spark. A PROMOTE cannot step spark "cheaper" onto a ladder
  // it is not on, and a broken streak cannot revert it either.
  rec(db, fail(SPARK, 'transcription'), 3);
  assert.equal(rec(db, promote(SPARK, 'transcription'), 4).applied, null);
  assert.equal(getRow(db, 'transcription').gpt_model, SPARK);
});

test('re-importing a scorecard imported by <=2.4 does not duplicate it', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const line = '2026-07-21 | task-review | claude-b:sonnet | FAIL(harness) ×2 | output lost';
  // exactly what 2.4 wrote: imported history with no role at all
  db.prepare('INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed) '
    + 'VALUES (?,?,?,?,?,NULL,1)').run('2026-07-21', 'task-review', 'sonnet', 'FAIL', 'output lost');
  assert.deepEqual(importScorecard(db, line), { imported: 0, skipped: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) c FROM outcomes WHERE task_kind='task-review'")
    .get() as any).c, 1);
});

test('a canonical PROMOTE breaks the spark FAIL streak — no flag on FAIL/PROMOTE/FAIL', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  assert.equal(getRow(db, 'transcription').gpt_model, SPARK); // spark holds the row by seed
  rec(db, fail(SPARK, 'transcription'), 4);
  // a PROMOTE for a row spark already holds shifts nothing, but it is still evidence:
  // written spent, it was invisible to the streak and the next FAIL read as "2× consecutive"
  assert.equal(rec(db, promote(SPARK, 'transcription'), 5).applied, null);
  const broken = rec(db, fail(SPARK, 'transcription'), 6);
  assert.match(broken.reason!, /needs 2 consecutive/); // streak broken by the PROMOTE
  // two genuinely consecutive FAILs flag — and still move nothing
  const r = rec(db, fail(SPARK, 'transcription'), 7);
  assert.match(r.reason!, /FLAGGED/);
  assert.equal(getRow(db, 'transcription').gpt_model, SPARK);
});

test('importScorecard parses v1 lines as history without shifting', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const text = [
    '# Model Routing Scorecard', '---',
    '2026-07-20 | smoke-test | claude-b:haiku + codex:luna@low + A:haiku@low | baseline | all lanes ok',
    '2026-07-21 | task-review | claude-b:sonnet | FAIL(harness) ×2 | output lost',
    '2026-07-21 | fully-specified implementation | claude-b:sonnet | PROMOTE-CANDIDATE | 5 aced',
    '2026-07-21 | live-API probe (FMP endpoints) | sonnet@claude-b | FAIL | false dead-key claim',
  ].join('\n');
  const r = importScorecard(db, text);
  // baseline has no FAIL/PROMOTE; the two prose "kinds" are no longer accepted as task kinds
  assert.equal(r.imported, 1);
  assert.equal(r.skipped, 3);
  const rows = db.prepare('SELECT model, kind FROM outcomes ORDER BY id').all() as any[];
  assert.deepEqual(rows.map(x => x.kind), ['FAIL']);
  assert.ok(rows.every(x => x.model === 'sonnet'));
  assert.equal(getRow(db, 'task-review').provisional, 1); // created, but model unshifted
});

// The family prefix is no longer uniform (gpt-5.6-… vs gpt-6-…): a line may name the short name
// or the full id, and a legacy sol line still attributes to sol.
test('importScorecard attributes astra lines to gpt-6-astra and sol lines to gpt-5.6-sol', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const r = importScorecard(db, [
    '2026-09-05 | debugging | codex:astra@xhigh | FAIL | missed the root cause',
    '2026-09-05 | debugging | gpt-6-astra | PROMOTE-CANDIDATE | aced',
    '2026-09-04 | debugging | codex:sol@xhigh | FAIL | legacy line',
  ].join('\n'));
  assert.deepEqual(r, { imported: 3, skipped: 0 });
  assert.deepEqual((db.prepare('SELECT model FROM outcomes ORDER BY id').all() as any[])
    .map(x => x.model), ['gpt-6-astra', 'gpt-6-astra', 'gpt-5.6-sol']);
});

test('a flag spends nothing — the operator re-pair does, and streaks die with the tenure', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // pre-state: 2× sonnet FAIL reaches the threshold → flag only, evidence stays unspent
  rec(db, fail('sonnet'), 2);
  assert.match(rec(db, fail('sonnet'), 3).reason!, /FLAGGED/);
  assert.equal(getRow(db, 'implementation-misc').anth_model, 'sonnet');
  // a third consistent FAIL re-raises the same flag — an un-acted-on flag cannot expire
  assert.match(rec(db, fail('sonnet'), 4).reason!, /FLAGGED/);
  // the operator acts on it; setVendorModel spends the whole sonnet streak
  setVendorModel(db, 'implementation-misc', 'anthropic', 'opus', 'high', 5);
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM outcomes WHERE model='sonnet' AND consumed=0").get() as any).c, 0);
  // replay of the evicted model is refused-and-spent, not banked
  assert.match(rec(db, fail('sonnet'), 6).reason!, /no longer routes/);
  // the new tenure starts at streak zero
  assert.match(rec(db, fail('opus'), 7).reason!, /needs 2/);
});

test('a flagged streak never re-pairs the other vendor', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // implementation-build seeds opus@high vs astra@xhigh; repair() used to move the gpt side to
  // the flagged tier's peer here — for opus that is astra@high, so the effort is the tell
  assert.equal(getRow(db, 'implementation-build').gpt_effort, 'xhigh');
  rec(db, fail('opus', 'implementation-build'), 2);
  const r = rec(db, fail('opus', 'implementation-build'), 3);
  assert.equal(r.applied, null);
  assert.match(r.reason!, /FLAGGED/);
  const row = getRow(db, 'implementation-build');
  assert.equal(row.anth_model, 'opus');         // no rung taken
  assert.equal(row.gpt_model, 'gpt-6-astra');   // and no tier repair
  assert.equal(row.gpt_effort, 'xhigh');        // not silently re-effort'd either
});

test('evidence for a model the row does not route is logged spent, never banked', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // 'implementation-misc' routes sonnet, so a haiku FAIL is inadmissible — it used to land unspent
  assert.match(rec(db, fail('haiku'), 2).reason!, /no longer routes/);
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE model='haiku'").get() as any).consumed, 1);
  // the operator routes the kind to haiku; the spent FAIL must still count for nothing
  setVendorModel(db, 'implementation-misc', 'anthropic', 'haiku', 'medium', 3);
  assert.match(rec(db, fail('haiku'), 4).reason!, /needs 2/); // streak 1 of 2, not "2× consecutive"
  assert.match(rec(db, fail('haiku'), 5).reason!, /FLAGGED/); // a real pair flags
  assert.equal(getRow(db, 'implementation-misc').anth_model, 'haiku');
});

test('an off-ladder model is logged spent with a reason', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const r = rec(db, fail('gpt-4-turbo'), 2);
  assert.match(r.reason!, /not on either ladder/);
  // v2.13.45: the row is a backup-seat observation, not a discard — luna's duel-284
  // ground-truth win had nowhere queryable to land while spark's seat was closed.
  const row = db.prepare('SELECT consumed, role FROM outcomes').get() as any;
  assert.equal(row.consumed, 1);
  assert.equal(row.role, 'backup');
  assert.match(r.reason!, /backup-seat observation/);
});

test('a flag leaves a decided contest standing — only the operator swap reopens it', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // The contest was settled the honest way — 8 judged, attested duels. A flag is evidence, not
  // a contestant swap, so it must not clear the verdict; the operator swap that acts on it
  // does (duel-62 I3/S8: a verdict surviving a swap served the untested replacement single,
  // 1-in-10 audited, on the evicted model's win).
  setDecided(db, 'bulk-mechanical-misc', 'openai', 4, 'victory');
  bumpSpotCounter(db, 'bulk-mechanical-misc');
  rec(db, { date: '2026-07-25', taskKind: 'bulk-mechanical-misc', model: SPARK, kind: 'FAIL', evidence: 'hung' }, 5);
  const r = rec(db, { date: '2026-07-25', taskKind: 'bulk-mechanical-misc', model: SPARK, kind: 'FAIL', evidence: 'hung' }, 6);
  assert.match(r.reason!, /FLAGGED/);
  let row = getRow(db, 'bulk-mechanical-misc');
  assert.equal(row.gpt_model, SPARK);           // no demotion
  assert.equal(row.decided, 1);                 // verdict untouched by evidence alone
  assert.equal(row.victor_vendor, 'openai');
  // the operator acts on the flag: the swap clears the verdict and restarts the schedule
  setVendorModel(db, 'bulk-mechanical-misc', 'openai', 'gpt-5.6-sol', 'high', 7);
  row = getRow(db, 'bulk-mechanical-misc');
  assert.equal(row.decided, 0);
  assert.equal(row.victor_vendor, null);
  assert.equal(row.decided_mode, null);
  assert.equal(row.spot_counter, 0);            // fresh contest, fresh schedule
  assert.equal(row.updated_at, 7);              // victory window restarts at the swap
  // and the flagged spark evidence died with the tenure
  assert.equal((db.prepare(
    'SELECT COUNT(*) c FROM outcomes WHERE model=? AND consumed=0').get(SPARK) as any).c, 0);
});

test('the flag is tier-blind — no revert target is computed any more', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK);
  // the operator moves the anthropic side to opus while spark holds the row; a streak used to
  // pick a revert target off the anthropic tier (TIER_PEER/SPARK_FALLBACK) — both are gone
  setVendorModel(db, 'bulk-mechanical-misc', 'anthropic', 'opus', 'high', 4);
  assert.equal(getRow(db, 'bulk-mechanical-misc').anth_model, 'opus');
  rec(db, fail(SPARK, 'bulk-mechanical-misc'), 8);
  const r = rec(db, fail(SPARK, 'bulk-mechanical-misc'), 9);
  assert.equal(r.applied, null);
  assert.match(r.reason!, /FLAGGED/);
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK);
});

test('every spark outcome comes back with a reason', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const offRow = rec(db, fail(SPARK, 'implementation-misc'), 2); // sonnet-tier, spark not on it
  assert.equal(offRow.applied, null);
  assert.match(offRow.reason!, /does not route/);
  const noop = rec(db, promote(SPARK, 'transcription'), 5); // spark holds it already
  assert.match(noop.reason!, /already holds/);
  const streak = rec(db, fail(SPARK, 'transcription'), 6);
  assert.match(streak.reason!, /2 consecutive canonical FAILs/);
});

test('an anthropic streak on a spark-held row leaves spark untouched', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // transcription is seeded haiku vs spark. Repair() used to be able to hand a row a contender
  // it never contested; with the flag-only rule, a haiku streak moves neither side.
  rec(db, promote('haiku', 'transcription'), 4);
  assert.match(rec(db, promote('haiku', 'transcription'), 5).reason!, /FLAGGED/);
  const row = getRow(db, 'transcription');
  assert.equal(row.anth_model, 'haiku');
  assert.equal(row.gpt_model, SPARK);
  assert.equal(row.gpt_effort, 'xhigh');
  // no spark outcome rows were minted by any of this
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM outcomes WHERE model=?").get(SPARK) as any).c, 0);
});

test('importScorecard is idempotent — the same file twice imports once', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const text = '2026-07-21 | task-review | claude-b:sonnet | FAIL | output lost\n';
  assert.deepEqual(importScorecard(db, text), { imported: 1, skipped: 0 });
  assert.deepEqual(importScorecard(db, text), { imported: 0, skipped: 1 });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM outcomes').get() as any).c, 1);
});

test('importScorecard skips lines that name both vendors instead of blaming anthropic', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const r = importScorecard(db,
    '2026-07-21 | task-review | claude-b:sonnet + codex:terra | FAIL | which side failed?\n');
  assert.equal(r.imported, 0);
  assert.equal(r.skipped, 1);
});

test('imported history is spent evidence — it cannot arm a live one-strike flag', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  importScorecard(db,
    ['2026-07-21 | task-review | claude-b:sonnet | FAIL | a',
     '2026-07-21 | task-review | claude-b:sonnet | FAIL | b'].join('\n'));
  // two historical FAILs are on file, but the row was never touched by the import …
  assert.equal(getRow(db, 'task-review').anth_model, 'sonnet');
  // … and spent history is invisible to the streak: a lone live FAIL after a PROMOTE must not
  // combine with imports into a bogus flag.
  rec(db, promote('sonnet', 'task-review'), 5);
  const r = rec(db, fail('sonnet', 'task-review'), 6);
  assert.equal(r.applied, null);
  assert.match(r.reason!, /needs 2/);
  assert.equal(getRow(db, 'task-review').anth_model, 'sonnet');
});

test('a live unspent outcome is not mistaken for a legacy import', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const line = '2026-07-21 | task-review | claude-b:sonnet | FAIL(harness) ×2 | output lost';
  // Role-less like a ≤2.4 import, but UNSPENT — importScorecard always writes consumed=1, so an
  // unspent role-less row is live evidence and must not swallow the history line it resembles.
  db.prepare('INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed) '
    + 'VALUES (?,?,?,?,?,NULL,0)').run('2026-07-21', 'task-review', 'sonnet', 'FAIL', 'output lost');
  assert.deepEqual(importScorecard(db, line), { imported: 1, skipped: 0 });
});

test('a spark FAIL needs no proof — the run that never started has no session id to give', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // SKILL.md's documented recovery for a hung codex-exec is `record_outcome {kind: FAIL}`, and
  // a lane that never wrote a rollout cannot attest anything.
  const f = { date: '2026-07-25', taskKind: 'bulk-mechanical-misc', model: SPARK,
    kind: 'FAIL' as const, evidence: 'codex-exec hung, no rollout' };
  assert.equal(rec(db, f, 2).applied, null);
  assert.match(rec(db, f, 3).reason!, /FLAGGED/); // proofless FAILs still reach the flag
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK);
});

test('importScorecard no longer mints outcome rows for retired luna', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // luna is on no ladder and in no matrix row, so an imported luna outcome is audit noise that
  // dashboards still read.
  const r = importScorecard(db, '2026-07-21 | bulk-mechanical-misc | codex:luna | FAIL | slow\n');
  assert.deepEqual(r, { imported: 0, skipped: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) c FROM outcomes WHERE model LIKE '%luna%'").get() as any).c, 0);
});

test('evidence dies with its tenure — a streak cannot span an eviction', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // terra holds implementation-build by operator re-pair (no seed row routes it since 2026-09-05)
  setVendorModel(db, 'implementation-build', 'openai', 'gpt-5.6-terra', 'medium', 1);
  // one real terra FAIL while terra holds implementation-build: 1 of 2, unspent
  rec(db, fail('gpt-5.6-terra', 'implementation-build'), 2);
  // the operator re-pairs terra→sol; the eviction spends terra's evidence, because
  // "consecutive" only means anything within one tenure (duel-62 sol#1: production outcomes
  // 6+14, six days and a pairing change apart, shifted 'implementation-misc' terra→sol as a
  // bogus "2× consecutive")
  setVendorModel(db, 'implementation-build', 'openai', 'gpt-5.6-sol', 'high', 3);
  assert.equal((db.prepare(
    "SELECT consumed FROM outcomes WHERE model='gpt-5.6-terra'").get() as any).consumed, 1);
  // terra returns to the row; one fresh FAIL is ONE fail — not the back half of a cross-era streak
  setVendorModel(db, 'implementation-build', 'openai', 'gpt-5.6-terra', 'medium', 4);
  const r = rec(db, fail('gpt-5.6-terra', 'implementation-build'), 5);
  assert.equal(r.applied, null);
  assert.match(r.reason!, /needs 2 consecutive/);
  assert.equal(getRow(db, 'implementation-build').gpt_model, 'gpt-5.6-terra');
});

// duel-97 remediation, v2.10.1 form: integrity-class FAILs (proven falsification) skip the
// 2-streak and raise the operator flag on the FIRST one. Nothing auto-evicts.
// Table: pre-state (spark seeded) → outcome applied → replay → public surface (matrix row).
test('one integrity FAIL flags immediately — falsification skips the streak, not the operator', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK);
  const r = rec(db, { ...fail(SPARK, 'bulk-mechanical-misc'), integrity: true }, 2);
  assert.equal(r.applied, null);
  assert.match(r.reason!, /OPERATOR REVIEW REQUIRED/);
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK); // nothing moved
  // the evidence stays unspent — only an operator swap spends it
  assert.equal((db.prepare(
    'SELECT COUNT(*) c FROM outcomes WHERE model=? AND consumed=0').get(SPARK) as any).c, 1);
});

test('integrity FAIL composed with a prior plain FAIL; the flag re-raises until the operator acts', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  rec(db, fail(SPARK, 'bulk-mechanical-misc'), 2); // plain FAIL #1 — no flag
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK);
  const r = rec(db, { ...fail(SPARK, 'bulk-mechanical-misc'), integrity: true }, 3);
  assert.match(r.reason!, /OPERATOR REVIEW REQUIRED/);
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK);
  // replay: spark still holds the row, so the flag re-raises — it cannot expire un-acted-on
  const r2 = rec(db, { ...fail(SPARK, 'bulk-mechanical-misc'), integrity: true }, 4);
  assert.match(r2.reason!, /OPERATOR REVIEW REQUIRED/);
  // the operator evicts by hand; the replay after THAT is refused-and-spent
  setVendorModel(db, 'bulk-mechanical-misc', 'openai', 'gpt-5.6-sol', 'high', 5);
  const r3 = rec(db, { ...fail(SPARK, 'bulk-mechanical-misc'), integrity: true }, 6);
  assert.equal(r3.applied, null);
  assert.match(r3.reason!, /does not route/);
  assert.equal((db.prepare(
    'SELECT COUNT(*) c FROM outcomes WHERE model=? AND consumed=0').get(SPARK) as any).c, 0);
});

test('legacy callers without the integrity field keep plain 2-streak semantics', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const r = rec(db, fail(SPARK, 'bulk-mechanical-misc'), 2); // integrity undefined
  assert.equal(r.applied, null);
  assert.match(r.reason!, /needs 2 consecutive/);
  assert.equal(getRow(db, 'bulk-mechanical-misc').gpt_model, SPARK);
});

test('integrity flag never accelerates the ladder — a fabricating sonnet still needs the streak', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const r = rec(db, { ...fail('sonnet'), integrity: true }, 2);
  assert.equal(r.applied, null);
  assert.equal(getRow(db, 'implementation-misc').anth_model, 'sonnet');
  // integrity PROMOTE is meaningless — logged, streak semantics untouched
  const r2 = rec(db, { ...promote('sonnet'), integrity: true }, 3);
  assert.equal(r2.applied, null);
  assert.equal(getRow(db, 'implementation-misc').anth_model, 'sonnet');
});

// v2.10.0 + v2.10.1 composed (fix-wave rule 2: both changes write outcomes/consumed and read
// the same matrix rows): a ladder flag and a spark flag in one DB — neither moves anything,
// and the operator swap that answers one flag must not spend the other row's streak.
test('composed: ladder flag and spark flag coexist; an operator swap spends only its own row', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  rec(db, fail('sonnet'), 2);
  assert.match(rec(db, fail('sonnet'), 3).reason!, /FLAGGED/);        // implementation-misc
  rec(db, fail(SPARK, 'transcription'), 4);
  assert.match(rec(db, fail(SPARK, 'transcription'), 5).reason!, /FLAGGED/);
  const misc = getRow(db, 'implementation-misc'), tr = getRow(db, 'transcription');
  assert.equal(misc.anth_model, 'sonnet'); assert.equal(misc.gpt_model, 'gpt-6-astra');
  assert.equal(tr.anth_model, 'haiku');    assert.equal(tr.gpt_model, SPARK);
  // the operator answers the sonnet flag only
  setVendorModel(db, 'implementation-misc', 'anthropic', 'opus', 'high', 6);
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM outcomes WHERE model='sonnet' AND consumed=0").get() as any).c, 0);
  // spark's streak survives untouched and keeps flagging
  assert.match(rec(db, fail(SPARK, 'transcription'), 7).reason!, /FLAGGED/);
  assert.equal(getRow(db, 'transcription').gpt_model, SPARK);
});

// 2026-08-10 renames: evidence keys on task_kind directly, so a straggler call under the dead
// spelling used to open a second ledger next to the one the renamed row reads. Transition table:
// old spelling and canonical spelling must share one ledger, one streak, one flag.
test('recordOutcome under a dead slug files evidence under the canonical kind', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  // pre-state: nothing recorded. Step 1 — a FAIL under the DEAD spelling
  const r1 = rec(db, { ...fail('sonnet', 'implementation'), evidence: 'e1' }, 2);
  assert.match(r1.reason!, /needs 2 consecutive/);
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM outcomes WHERE task_kind='implementation'").get() as any).c, 0);
  assert.equal((db.prepare(
    "SELECT task_kind FROM outcomes WHERE evidence='e1'").get() as any).task_kind,
  'implementation-misc');
  // step 2 — a FAIL under the CANONICAL spelling composes into one streak and flags
  const r2 = rec(db, { ...fail('sonnet'), evidence: 'e2' }, 3);
  assert.match(r2.reason!, /FLAGGED/);
  assert.match(r2.reason!, /'implementation-misc'/); // the flag names the canonical kind
  // replay-shaped retry: the dead spelling again — admissibility still reads the -misc row
  const r3 = rec(db, { ...fail('haiku', 'implementation'), evidence: 'e3' }, 4);
  assert.match(r3.reason!, /no longer routes|not on either ladder|needs 2/);
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM outcomes WHERE task_kind='implementation'").get() as any).c, 0);
});

// v1 scorecard lines predate the renames — import must file their history canonically, and the
// dupe guard must catch a re-import spelled either way.
test('importScorecard canonicalizes dead slugs and dedupes across spellings', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const line = '2026-07-19 | implementation | sonnet | FAIL | missed edge case';
  assert.deepEqual(importScorecard(db, line), { imported: 1, skipped: 0 });
  assert.equal((db.prepare(
    "SELECT task_kind FROM outcomes WHERE evidence='missed edge case'").get() as any).task_kind,
  'implementation-misc');
  // replay under the OLD spelling and under the NEW one: both are the same historical row
  assert.deepEqual(importScorecard(db, line), { imported: 0, skipped: 1 });
  assert.deepEqual(importScorecard(db,
    '2026-07-19 | implementation-misc | sonnet | FAIL | missed edge case'),
  { imported: 0, skipped: 1 });
});

// Duel 391 M3: `record_outcome {integrity: true}` was acted on in the reply and dropped from the
// row — the outcomes table had no column for it. Table: current schema → previous schema
// (file-backed, second connection) → replay → public surface (the row itself).
test('integrity is written with the outcome row — current schema, legacy schema, replay', () => {
  const read = (db: any, model: string) => (db.prepare(
    'SELECT integrity FROM outcomes WHERE model=? ORDER BY id').all(model) as any[]).map(r => r.integrity);
  // current schema
  const fresh = openDb(':memory:'); seedMatrix(fresh, 1);
  rec(fresh, { ...fail('sonnet'), integrity: true }, 2);
  rec(fresh, fail('sonnet'), 3);
  rec(fresh, promote('sonnet'), 4);
  assert.deepEqual(read(fresh, 'sonnet'), [1, 0, 0]);
  // previous schema: a populated pre-M3 file, upgraded by a peer while the old connection lives
  const path = join(mkdtempSync(join(tmpdir(), 'mr-outcomes-')), 'mr.db');
  const USER_VERSION = (fresh.prepare('PRAGMA user_version').get() as any).user_version;
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE outcomes (
    id INTEGER PRIMARY KEY, date TEXT NOT NULL, task_kind TEXT NOT NULL, model TEXT NOT NULL,
    kind TEXT NOT NULL, evidence TEXT NOT NULL, role TEXT, consumed INTEGER NOT NULL DEFAULT 0
  ); PRAGMA user_version = ${USER_VERSION}`);
  old.prepare(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed)
    VALUES ('2026-08-01', 'implementation-misc', 'sonnet', 'FAIL', 'legacy', NULL, 0)`).run();
  const upgraded = openDb(path); seedMatrix(upgraded, 1);
  assert.deepEqual(read(upgraded, 'sonnet'), [null]); // pre-M3 rows: unknown, never false
  rec(upgraded, { ...fail('sonnet'), integrity: true }, 5);
  old.prepare(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed)
    VALUES ('2026-08-02', 'implementation-misc', 'sonnet', 'FAIL', 'old writer', NULL, 0)`).run();
  assert.deepEqual(read(upgraded, 'sonnet'), [null, 1, null]);
  // replay: a second open changes nothing
  assert.deepEqual(read(openDb(path), 'sonnet'), [null, 1, null]);
});
