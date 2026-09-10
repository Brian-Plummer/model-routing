import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SEED, seedMatrix, getRow, bumpSpotCounter, canonicalKind, setDecided, setVendorModel, renderMarkdown } from '../src/matrix.js';
import { SPARK_MODEL } from '../src/types.js';
import { routeTask } from '../src/router.js';

test('seedMatrix inserts v1 rows once', () => {
  const db = openDb(':memory:');
  assert.equal(seedMatrix(db, 1), 14);
  assert.equal(seedMatrix(db, 1), 0); // idempotent
  const impl = getRow(db, 'implementation-misc');
  assert.equal(impl.anth_model, 'sonnet');
  assert.equal(impl.gpt_model, 'gpt-6-astra');
  assert.equal(getRow(db, 'transcription').provisional, 1);
  assert.equal(getRow(db, 'transcription').gpt_model, 'gpt-5.3-codex-spark');
  assert.equal(getRow(db, 'long-context').gpt_model, 'gpt-6-astra');
  // duel-207 P3: the seed tests pinned only counts, so a SEED typo in the web-research row
  // (wrong effort, union flag dropped) passed the whole suite. Pin the operator state.
  const web = getRow(db, 'web-research');
  assert.equal(web.anth_model, 'opus');
  assert.equal(web.anth_effort, 'high');
  assert.equal(web.anth_lane, 'B');
  assert.equal(web.gpt_model, 'gpt-6-astra');
  assert.equal(web.gpt_effort, 'high');
  assert.equal(web.provisional, 0);
  assert.equal(web.union_mode, 1);
});

// Every seed-reachability bug in this repo's history started as a SEED edit whose reach nobody
// asked about (duel-87, duel-105, duel-207 P1 — seven instances). Since v2.13.9 an untouched clone
// re-stamps itself, so most SEED edits now need nothing; the one that still does is an edit that
// must override a RATIFIED row, which no amount of seeding will ever reach. This pin makes that
// question unskippable: change SEED, and the suite stops until someone answers it here.
// ponytail: fingerprint, not a full snapshot — the pairing assertions above already pin content;
// this only pins that a change was deliberate.
test('SEED changes are deliberate: fingerprint pin', () => {
  const fingerprint = createHash('sha256').update(JSON.stringify(SEED)).digest('hex').slice(0, 16);
  assert.equal(fingerprint, '3c499038a81b726a',
    'SEED changed. Untouched provisional clones re-stamp themselves on the next open '
    + '(v2.13.9; tier-born shapes and the FLAGGED leg v2.13.11), so a new kind or a '
    + 're-pairing needs no migration. A change that must also reach ROWS AN OPERATOR '
    + 'RATIFIED (provisional=0) does: bump USER_VERSION, write the transition with its '
    + 'table-driven test, then update this fingerprint.');
});

// duel-207 P1, generalized: `INSERT OR IGNORE` let getRow's auto-clone swallow every later seed
// change, and the class had been repaired one kind at a time seven times (v6/v7/v9/v11). Seeding
// now re-stamps the untouched clone itself, so this is the LAST per-kind migration. Table-driven
// over the pre-states a real DB can hold; each case replays the seed to prove idempotence.
const preClone = (
  db: ReturnType<typeof openDb>, anth: string, anthEffort: string,
  gpt: string, gptEffort: string, provisional: number,
): void => {
  db.exec(`INSERT INTO matrix(task_kind, anth_model, anth_effort, anth_lane, gpt_model, gpt_effort,
      overflow_eligible, provisional, decided, victor_vendor, decided_mode, spot_counter,
      union_mode, updated_at)
    VALUES ('web-research','${anth}','${anthEffort}','B','${gpt}','${gptEffort}',
      1,${provisional},1,'anthropic','victory',5,0,500)`);
  db.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
    VALUES ('2026-08-12','web-research','sonnet','WIN','duel 203',0)`);
};
const changelogCount = (db: ReturnType<typeof openDb>): number => Number((db.prepare(
  'SELECT count(*) AS n FROM matrix_changelog').get() as any).n);
const unspent = (db: ReturnType<typeof openDb>): number => Number((db.prepare(
  "SELECT count(*) AS n FROM outcomes WHERE consumed=0 AND task_kind='web-research'")
  .get() as any).n);

for (const c of [
  { name: 'the current default era', anth: 'sonnet', eff: 'medium', gpt: 'gpt-6-astra', ge: 'high',
    provisional: 1, restamped: true, flagged: false },
  { name: 'the 2026-08-10 → 2026-09-05 default era', anth: 'sonnet', eff: 'medium',
    gpt: 'gpt-5.6-sol', ge: 'high', provisional: 1, restamped: true, flagged: false },
  { name: 'the pre-2026-08-10 default era', anth: 'sonnet', eff: 'medium',
    gpt: 'gpt-5.6-terra', ge: 'medium', provisional: 1, restamped: true, flagged: false },
  // duel-209 F1: getRow with a tier mints the clone at the TIER pairing — equally "routed
  // before seeded", and invisible to a default-era-only shape list.
  { name: 'an opus tier-born clone', anth: 'opus', eff: 'high', gpt: 'gpt-6-astra', ge: 'high',
    provisional: 1, restamped: true, flagged: false },
  // v7's second tell, for v7's reason (duel-163 F1): a pre-v2.10.6 writer re-paired rows without
  // clearing `provisional`, so the flag alone would stamp over deliberate pairing work. Since
  // v2.13.11 the skip is announced: one FLAGGED changelog line, row untouched.
  { name: 'a pre-v2.10.6 re-paired row still flagged provisional', anth: 'opus', eff: 'medium',
    gpt: 'gpt-6-astra', ge: 'xhigh', provisional: 1, restamped: false, flagged: true },
  { name: 'an operator-ratified row holding the default pairing', anth: 'sonnet', eff: 'medium',
    gpt: 'gpt-6-astra', ge: 'high', provisional: 0, restamped: false, flagged: false },
]) {
  test(`seedMatrix ${c.restamped ? 're-stamps' : 'never touches'} a web-research row from `
    + c.name, () => {
    const db = openDb(':memory:');
    preClone(db, c.anth, c.eff, c.gpt, c.ge, c.provisional);
    seedMatrix(db, 1);
    const row = getRow(db, 'web-research');
    if (c.restamped) {
      assert.equal(row.anth_model, 'opus');
      assert.equal(row.anth_effort, 'high');
      assert.equal(row.anth_lane, 'B');
      assert.equal(row.gpt_model, 'gpt-6-astra');
      assert.equal(row.gpt_effort, 'high');
      assert.equal(row.union_mode, 1);
      assert.equal(row.provisional, 0);
      assert.equal(row.decided, 0);            // union carries no verdict
      assert.equal(row.victor_vendor, null);
      assert.equal(row.decided_mode, null);
      assert.equal(row.spot_counter, 0);
      assert.equal(unspent(db), 0);            // evidence under the collided pairing is spent
      assert.equal(changelogCount(db), 1);
      assert.equal(routeTask(db, { kind: 'web-research' }, 2).mode, 'union'); // public surface
    } else {
      assert.equal(row.anth_model, c.anth);
      assert.equal(row.gpt_effort, c.ge);
      assert.equal(row.union_mode, 0);
      assert.equal(row.decided, 1);            // the operator's own state, untouched
      assert.equal(row.spot_counter, 5);
      assert.equal(unspent(db), 1);
      assert.equal(changelogCount(db), c.flagged ? 1 : 0);
    }
    // replay: a second open changes nothing and logs nothing new (the flag dedups by text)
    const before = JSON.stringify(getRow(db, 'web-research'));
    assert.equal(seedMatrix(db, 9), 0);
    assert.equal(JSON.stringify(getRow(db, 'web-research')), before);
    assert.equal(changelogCount(db), c.restamped || c.flagged ? 1 : 0);
  });
}

// transcription is the one SEED row born `provisional=1`, and its pairing is not a clone shape —
// the flag alone must never make a seeded row repairable on every open.
test('seedMatrix leaves the seeded provisional row alone across opens', () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  seedMatrix(db, 2);
  const t = getRow(db, 'transcription');
  assert.equal(t.provisional, 1);
  assert.equal(t.gpt_model, SPARK_MODEL);
  assert.equal(changelogCount(db), 0);
});

// duel-209 F2 (atomicity): the REPAIR's first statement clears `provisional`, so a partial
// commit is a repair no replay can ever finish — the stamp, its evidence spend and its
// changelog line must land together or not at all.
test('seedMatrix re-stamp is atomic: a failing spend rolls back stamp and log, replay repairs', () => {
  const db = openDb(':memory:');
  preClone(db, 'sonnet', 'medium', 'gpt-6-astra', 'high', 1);
  db.exec("CREATE TRIGGER boom BEFORE UPDATE ON outcomes BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => seedMatrix(db, 1));
  const row = getRow(db, 'web-research');
  assert.equal(row.provisional, 1);            // stamp rolled back — still repairable
  assert.equal(row.anth_model, 'sonnet');
  assert.equal(changelogCount(db), 0);         // no log claiming a spend that never landed
  assert.equal(unspent(db), 1);
  db.exec('DROP TRIGGER boom');
  seedMatrix(db, 2);                           // the rolled-back repair replays to completion
  assert.equal(getRow(db, 'web-research').provisional, 0);
  assert.equal(getRow(db, 'web-research').anth_model, 'opus');
  assert.equal(changelogCount(db), 1);
  assert.equal(unspent(db), 0);
});

// Composed (fix-wave rule 2): v2.13.10's transaction and v2.13.11's tier shapes touch the same
// seed pass — a tier-born clone's re-stamp must be atomic too, and must replay to completion.
test('composed: a tier-born clone re-stamp rolls back whole and replays to completion', () => {
  const db = openDb(':memory:');
  preClone(db, 'opus', 'high', 'gpt-6-astra', 'high', 1);  // the opus tier shape
  db.exec("CREATE TRIGGER boom BEFORE UPDATE ON outcomes BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => seedMatrix(db, 1));
  assert.equal(getRow(db, 'web-research').provisional, 1);
  assert.equal(getRow(db, 'web-research').union_mode, 0);
  assert.equal(changelogCount(db), 0);
  assert.equal(unspent(db), 1);
  db.exec('DROP TRIGGER boom');
  seedMatrix(db, 2);
  const row = getRow(db, 'web-research');
  assert.equal(row.provisional, 0);
  assert.equal(row.union_mode, 1);
  assert.equal(unspent(db), 0);
  assert.equal(changelogCount(db), 1);
});

// Fix-wave rule 3: the transaction claim gets a file-backed two-connection test — a racing
// writer must never observe, or leave behind, a half-committed repair.
test('seedMatrix against a racing writer: all-or-nothing on a shared file DB', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-matrix-')), 'mr.db');
  const a = openDb(path);
  preClone(a, 'sonnet', 'medium', 'gpt-6-astra', 'high', 1);
  const b = openDb(path);
  b.exec('BEGIN IMMEDIATE');                   // rival writer holds the write lock
  a.exec('PRAGMA busy_timeout=50');
  assert.throws(() => seedMatrix(a, 1));       // BEGIN IMMEDIATE refused — nothing ran at all
  assert.equal(getRow(b, 'web-research').provisional, 1);
  assert.equal(changelogCount(b), 0);
  assert.equal(unspent(b), 1);
  b.exec('ROLLBACK');
  seedMatrix(a, 2);                            // lock released — the full repair lands
  assert.equal(getRow(b, 'web-research').provisional, 0);
  assert.equal(unspent(b), 0);
  a.close();
  b.close();
});

// The 2026-08-01 split kinds seed fresh contests: haiku-tier pairing for the mechanical pair,
// sonnet@medium (not the parent's @high) for teardown, build at its 2026-08-10 operator pairing,
// and no verdict, spot progress, or union mode inherited from anything.
test('split kinds seed their agreed tier pairings, fresh and undecided', () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  for (const kind of ['mechanical-apply', 'mechanical-sweep']) {
    const r = getRow(db, kind);
    assert.equal(r.anth_model, 'haiku');
    // 2026-08-10 (operator): sweep runs haiku@medium against spark@xhigh — the auto-revert to
    // terra is overridden and both sides sit above the split's original low/low seed
    assert.equal(r.anth_effort, kind === 'mechanical-apply' ? 'low' : 'medium');
    assert.equal(r.gpt_model, 'gpt-5.3-codex-spark');
    assert.equal(r.gpt_effort, 'xhigh');
  }
  // 2026-08-10 (operator): every terra@medium row moved to sol@high (astra@high since
  // 2026-09-05); build went to opus@high vs sol@xhigh the same day — the seed caught up with
  // the live row in v2.14.1, so no seed row routes terra any more.
  for (const [kind, anth, anthEffort, gpt, gptEffort] of [
    ['implementation-build', 'opus', 'high', 'gpt-6-astra', 'xhigh'],
    ['implementation-teardown', 'sonnet', 'medium', 'gpt-6-astra', 'high'],
  ]) {
    const r = getRow(db, kind);
    assert.equal(r.anth_model, anth, kind);
    assert.equal(r.anth_effort, anthEffort, kind);
    assert.equal(r.gpt_model, gpt, kind);
    assert.equal(r.gpt_effort, gptEffort, kind);
  }
  for (const kind of ['mechanical-apply', 'mechanical-sweep',
    'implementation-build', 'implementation-teardown']) {
    const r = getRow(db, kind);
    assert.equal(r.anth_lane, 'B');
    assert.equal(r.decided, 0);
    assert.equal(r.victor_vendor, null);
    assert.equal(r.spot_counter, 0);
    assert.equal(r.union_mode, 0);
    // the two fields a mis-seed corrupts: getRow's auto-created clone is provisional=1, and a
    // collided row could carry any overflow flag (duel-87 anth P2-3)
    assert.equal(r.provisional, 0);
    assert.equal(r.overflow_eligible, 1);
  }
});

test('getRow auto-creates provisional row for unknown kind from default', () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  const notes: string[] = [];
  const row = getRow(db, 'weird-new-kind', 2, notes);
  assert.equal(row.provisional, 1);
  assert.equal(row.anth_model, 'sonnet'); // default template
  assert.equal(notes.length, 1);
  const log = db.prepare('SELECT entry FROM matrix_changelog').all() as any[];
  assert.ok(log.some(r => r.entry.includes('weird-new-kind')));
});

// The 2026-08-10 renames left the old parent spellings dead, and getRow's auto-create turned
// any straggler call into a provisional fork of the residue row (the duel-87 shape, third
// recurrence). The alias makes both spellings resolve to the one row — a reader recognizes
// legacy and modern forms (the duel-75 rule).
test('dead parent slugs alias to their -misc rows — no provisional fork, replayable', () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  const cases: Array<[dead: string, canon: string]> = [
    ['bulk-mechanical', 'bulk-mechanical-misc'],
    ['implementation', 'implementation-misc'],
  ];
  const before = (db.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c;
  for (const [dead, canon] of cases) {
    assert.equal(canonicalKind(dead), canon);
    for (let i = 0; i < 2; i++) { // replay: the second call resolves the same row, forks nothing
      const row = getRow(db, dead, 2);
      assert.equal(row.task_kind, canon);
      assert.equal(row.provisional, 0);
    }
    assert.equal(db.prepare('SELECT 1 FROM matrix WHERE task_kind=?').get(dead), undefined);
  }
  assert.equal((db.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c, before);
  assert.equal(canonicalKind('mechanical-apply'), 'mechanical-apply'); // live slugs pass through
});

test('spot counter increments and persists; setDecided flips both ways', () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  assert.equal(bumpSpotCounter(db, 'implementation-misc'), 1);
  assert.equal(bumpSpotCounter(db, 'implementation-misc'), 2);
  setDecided(db, 'implementation-misc', 'openai', 3);
  assert.equal(getRow(db, 'implementation-misc').victor_vendor, 'openai');
  setDecided(db, 'implementation-misc', null, 4);
  assert.equal(getRow(db, 'implementation-misc').decided, 0);
});

test('renderMarkdown emits a table with all kinds', () => {
  const db = openDb(':memory:');
  seedMatrix(db, 1);
  const md = renderMarkdown(db);
  assert.ok(md.includes('| implementation-misc |'));
  assert.ok(md.includes('# Routing Matrix'));
});

test('swapping a contestant clears the decision and the spot progress', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  setDecided(db, 'implementation-misc', 'anthropic', 2, 'victory');
  bumpSpotCounter(db, 'implementation-misc');
  bumpSpotCounter(db, 'implementation-misc');
  // The new pairing has never been contested, so carrying the old decision over would serve the
  // new model single on the previous model's victory — with stale spot progress riding along.
  setVendorModel(db, 'implementation-misc', 'openai', 'gpt-6-astra', 'high', 3);
  const r = getRow(db, 'implementation-misc', 3);
  assert.equal(r.decided, 0);
  assert.equal(r.victor_vendor, null);
  assert.equal(r.decided_mode, null);
  assert.equal(r.spot_counter, 0);
});

// duel-163 F4: only getRow aliased the dead slugs — every raw-key mutator silently missed (or
// 'no matrix row'-failed on) the renamed rows, splitting one user-visible kind into two
// identities across public surfaces.
test('matrix mutators canonicalize the dead slugs', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  assert.equal(bumpSpotCounter(db, 'implementation'), 1);       // hits the -misc row
  setDecided(db, 'implementation', 'anthropic', 2, 'victory');
  assert.equal(getRow(db, 'implementation-misc', 2).decided, 1);
  setVendorModel(db, 'bulk-mechanical', 'openai', 'gpt-5.6-terra', 'low', 3);
  const bulk = getRow(db, 'bulk-mechanical-misc', 3);
  assert.equal(bulk.gpt_model, 'gpt-5.6-terra');
  // and no fork appeared under either dead spelling
  assert.equal(db.prepare(
    "SELECT COUNT(*) c FROM matrix WHERE task_kind IN ('implementation','bulk-mechanical')")
    .get()!.c, 0);
});

// duel-163 F1 (both reviewers): `provisional` is v7's license to overwrite, and setVendorModel —
// the one primitive every deliberate pairing change routes through — never revoked it. A row
// born as getRow's auto-clone and then re-paired kept the tell, and the reconcile stamped the
// 2026-08-01 seed back over the operator's decision.
test('setVendorModel ratifies a provisional row — the auto-clone tell is revoked', () => {
  const db = openDb(':memory:'); seedMatrix(db, 1);
  const born = getRow(db, 'schema-migration', 2); // auto-created provisional clone
  assert.equal(born.provisional, 1);
  setVendorModel(db, 'schema-migration', 'openai', 'gpt-6-astra', 'xhigh', 3);
  assert.equal(getRow(db, 'schema-migration', 3).provisional, 0);
});

// The engine-unavailable refusal (src/cli.ts) points the controller at "the SKILL.md seed
// pairings" as the fallback that always exists — every matrix.md writer needs an open DB
// first, so a fresh install has no other table. That promise held only half: the SKILL
// carried the tier↔peer table and two kind rules — no lanes, no efforts, five kinds
// unplaced — so the refusal replaced "a file that does not exist" with "a table that is
// only half there" (duel-75 opus F2 / sol F1). Pin every SEED row's routing facts into the
// doc: matrix drift breaks this test, not the offline fallback.
test('SKILL.md carries every seed pairing the refusal points to', () => {
  const doc = readFileSync('skills/model-routing/SKILL.md', 'utf8');
  for (const row of SEED) {
    const line = doc.split('\n').find(l => l.startsWith(`| ${row.task_kind} `));
    assert.ok(line, `seed kind ${row.task_kind} has no row in SKILL.md`);
    const frags = [row.anth_model, row.anth_effort, `(${row.anth_lane})`,
      row.gpt_model, row.gpt_effort].filter(f => f != null);
    for (const frag of frags) {
      assert.ok(line!.includes(String(frag)),
        `${row.task_kind}: ${frag} missing from SKILL.md row: ${line}`);
    }
    assert.ok(line!.includes(row.union_mode ? 'union' : 'duel'),
      `${row.task_kind}: mode missing from SKILL.md row: ${line}`);
  }
});

// The seat sentence is spark's other routing surface: a spark-seeded kind missing from it reads
// as "haiku duels terra there", and unlike the fallback table nothing pinned it — the 2.7.0
// split updated it by hand and only the duel-75 table test noticed the table (duel-87 anth P3-3).
test('SKILL.md seat sentence names every spark-seeded kind', () => {
  const doc = readFileSync('skills/model-routing/SKILL.md', 'utf8');
  const seat = /duels\s+haiku directly on ([^.]+)\./.exec(doc);
  assert.ok(seat, 'spark seat sentence missing from SKILL.md');
  for (const row of SEED.filter(r => r.gpt_model === SPARK_MODEL)) {
    assert.ok(seat![1].includes(`\`${row.task_kind}\``),
      `spark seat ${row.task_kind} missing from SKILL.md seat sentence`);
  }
});
