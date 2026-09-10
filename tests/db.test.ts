import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureColumn, openDb } from '../src/db.js';
import { getRow, seedMatrix, setVendorModel } from '../src/matrix.js';
import { standings } from '../src/standings.js';

const V14_DUEL_COLUMNS = [
  'anth_model_attested', 'anth_effort_attested',
  'gpt_model_attested', 'gpt_effort_attested',
];
const V14_JUDGMENT_COLUMNS = ['judge_model_attested', 'judge_effort_attested'];
const V15_DUEL_COLUMNS = ['minted_by_version', 'recorded_by_version'];
const CURRENT_USER_VERSION = 17;
const tableColumns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as any[]).map(r => r.name);

test('openDb creates schema and is idempotent', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((r: any) => r.name);
  for (const t of ['duels','judgments','matrix','matrix_changelog','outcomes','proof_claims',
    'quota_snapshots','report_claims']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  db.exec("INSERT INTO matrix_changelog(date, entry) VALUES ('2026-07-23','test')");
  const db2 = openDb(':memory:'); // fresh handle, schema re-applied without error
  assert.ok(db2);
});

test('v14 adds nullable attestation columns to v13 data and replays idempotently', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const duelId = Number(pre.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map,
    status, anth_output, gpt_output) VALUES ('implementation-misc', 123,
    '[{"vendor":"anthropic","lane":"B","model":"sonnet","effort":"high"},'
      || '{"vendor":"openai","lane":"codex","model":"gpt-5.6-sol","effort":"xhigh"}]',
    '{"X":"anthropic","Y":"openai"}', 'awaiting_judgment', 'a', 'g')`).run().lastInsertRowid);
  pre.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, rationale)
    VALUES (?, 'anthropic', 'X', 456, 'judge-proof', 'legacy rationale')`).run(duelId);
  // Build the exact pre-state whether this test is running red against v13 or green against v14.
  for (const [table, columns] of [
    ['duels', V14_DUEL_COLUMNS], ['judgments', V14_JUDGMENT_COLUMNS],
  ] as const) {
    const present = tableColumns(pre, table);
    for (const column of columns) if (present.includes(column)) {
      pre.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  pre.exec('PRAGMA user_version = 13');
  pre.close();

  const db = openDb(path);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  for (const column of V14_DUEL_COLUMNS) assert.ok(tableColumns(db, 'duels').includes(column));
  for (const column of V14_JUDGMENT_COLUMNS) {
    assert.ok(tableColumns(db, 'judgments').includes(column));
  }
  const duel: any = db.prepare(`SELECT anth_output, gpt_output, anth_model_attested,
    anth_effort_attested, gpt_model_attested, gpt_effort_attested FROM duels WHERE id=?`)
    .get(duelId);
  assert.deepEqual({ ...duel }, { anth_output: 'a', gpt_output: 'g', anth_model_attested: null,
    anth_effort_attested: null, gpt_model_attested: null, gpt_effort_attested: null });
  const judgment: any = db.prepare(`SELECT proof, rationale, judge_model_attested,
    judge_effort_attested FROM judgments WHERE duel_id=?`).get(duelId);
  assert.deepEqual({ ...judgment }, { proof: 'judge-proof', rationale: 'legacy rationale',
    judge_model_attested: null, judge_effort_attested: null });
  db.close();

  const replay = openDb(path);
  assert.equal((replay.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  for (const column of V14_DUEL_COLUMNS) {
    assert.equal(tableColumns(replay, 'duels').filter(c => c === column).length, 1);
  }
  for (const column of V14_JUDGMENT_COLUMNS) {
    assert.equal(tableColumns(replay, 'judgments').filter(c => c === column).length, 1);
  }
  assert.equal((replay.prepare('SELECT COUNT(*) c FROM duels WHERE id=?').get(duelId) as any).c, 1);
  replay.close();
});

test('a fresh DB lands directly at v14 with every attestation column', () => {
  const db = openDb(':memory:');
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  for (const column of V14_DUEL_COLUMNS) assert.ok(tableColumns(db, 'duels').includes(column));
  for (const column of V14_JUDGMENT_COLUMNS) {
    assert.ok(tableColumns(db, 'judgments').includes(column));
  }
  db.close();
});

// v15: which BUILD minted a row and which first recorded it. Legacy rows stay NULL — NULL is
// "pre-v15", never a failure — so the migration is columns-only and the data must survive it.
test('v15 adds nullable server-build columns to v14 data and replays idempotently', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const duelId = Number(pre.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map,
    status, anth_output, gpt_output, anth_model_attested)
    VALUES ('implementation-misc', 123, '[]', '{}', 'awaiting_judgment', 'a', 'g',
      'claude-sonnet-5')`).run().lastInsertRowid);
  // Build the exact v14 pre-state whether this test runs red against v14 or green against v15.
  const present = tableColumns(pre, 'duels');
  for (const column of V15_DUEL_COLUMNS) {
    if (present.includes(column)) pre.exec(`ALTER TABLE duels DROP COLUMN ${column}`);
  }
  pre.exec('PRAGMA user_version = 14');
  pre.close();

  const db = openDb(path);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  for (const column of V15_DUEL_COLUMNS) assert.ok(tableColumns(db, 'duels').includes(column));
  const duel: any = db.prepare(`SELECT anth_output, gpt_output, anth_model_attested,
    minted_by_version, recorded_by_version FROM duels WHERE id=?`).get(duelId);
  assert.deepEqual({ ...duel }, { anth_output: 'a', gpt_output: 'g',
    anth_model_attested: 'claude-sonnet-5', minted_by_version: null, recorded_by_version: null });
  db.close();

  const replay = openDb(path);
  assert.equal((replay.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  for (const column of V15_DUEL_COLUMNS) {
    assert.equal(tableColumns(replay, 'duels').filter(c => c === column).length, 1);
  }
  assert.equal((replay.prepare('SELECT COUNT(*) c FROM duels WHERE id=?').get(duelId) as any).c, 1);
  replay.close();
});

test('a fresh DB lands directly at v15 with both server-build columns', () => {
  const db = openDb(':memory:');
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  for (const column of V15_DUEL_COLUMNS) assert.ok(tableColumns(db, 'duels').includes(column));
  db.close();
});

// Two connections on one FILE: the additive promise is that an already-running v14 process can
// keep using its named-column INSERTs after a peer upgrades the shared DB to v15.
test('a file-backed v14 connection can insert a named-column duel after another opens v15', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE duels (
    id INTEGER PRIMARY KEY,
    task_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    spot_check INTEGER NOT NULL DEFAULT 0,
    mutating INTEGER NOT NULL DEFAULT 0,
    union_mode INTEGER NOT NULL DEFAULT 0,
    sides TEXT NOT NULL,
    label_map TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'routed',
    anth_output TEXT, gpt_output TEXT,
    anth_tokens INTEGER, gpt_tokens INTEGER,
    anth_latency_ms INTEGER, gpt_latency_ms INTEGER,
    anth_proof TEXT, gpt_proof TEXT,
    anth_model_attested TEXT, anth_effort_attested TEXT,
    gpt_model_attested TEXT, gpt_effort_attested TEXT,
    anth_env TEXT, gpt_env TEXT,
    anth_gate TEXT, gpt_gate TEXT,
    winner_vendor TEXT,
    decided_by TEXT,
    recorded_at INTEGER,
    outputs_at INTEGER,
    demoted_audit INTEGER NOT NULL DEFAULT 0,
    abandoned_at INTEGER,
    superseded_by INTEGER,
    death_recorded INTEGER NOT NULL DEFAULT 0
  );
  PRAGMA user_version = 14`);

  const upgraded = openDb(path);
  assert.equal((upgraded.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  old.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status)
    VALUES ('implementation-misc', 789, '[]', '{}', 'routed')`).run();

  const row: any = upgraded.prepare(`SELECT task_kind, minted_by_version, recorded_by_version
    FROM duels WHERE created_at=789`).get();
  assert.deepEqual({ ...row }, { task_kind: 'implementation-misc',
    minted_by_version: null, recorded_by_version: null });
  old.close();
  upgraded.close();
});

test('a file-backed v13 connection can insert a named-column duel after another opens v14', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE duels (
    id INTEGER PRIMARY KEY,
    task_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    spot_check INTEGER NOT NULL DEFAULT 0,
    mutating INTEGER NOT NULL DEFAULT 0,
    union_mode INTEGER NOT NULL DEFAULT 0,
    sides TEXT NOT NULL,
    label_map TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'routed',
    anth_output TEXT, gpt_output TEXT,
    anth_tokens INTEGER, gpt_tokens INTEGER,
    anth_latency_ms INTEGER, gpt_latency_ms INTEGER,
    anth_proof TEXT, gpt_proof TEXT,
    anth_env TEXT, gpt_env TEXT,
    anth_gate TEXT, gpt_gate TEXT,
    winner_vendor TEXT,
    decided_by TEXT,
    recorded_at INTEGER,
    outputs_at INTEGER,
    demoted_audit INTEGER NOT NULL DEFAULT 0,
    abandoned_at INTEGER,
    superseded_by INTEGER,
    death_recorded INTEGER NOT NULL DEFAULT 0
  );
  PRAGMA user_version = 13`);

  const upgraded = openDb(path);
  assert.equal((upgraded.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  old.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status)
    VALUES ('implementation-misc', 789, '[]', '{}', 'routed')`).run();

  const row: any = upgraded.prepare(`SELECT task_kind, anth_model_attested,
    anth_effort_attested, gpt_model_attested, gpt_effort_attested
    FROM duels WHERE created_at=789`).get();
  assert.deepEqual({ ...row }, { task_kind: 'implementation-misc', anth_model_attested: null,
    anth_effort_attested: null, gpt_model_attested: null, gpt_effort_attested: null });
  old.close();
  upgraded.close();
});

// The migration exists for a POPULATED pre-2.5 DB, so it has to be tested against one: an
// in-memory handle is always empty and would run every statement over zero rows.
test('the fossil sweep is deferred while the matrix is unseeded, not run against nothing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  // outcomes but no matrix rows: every model looks un-routed, so an unguarded sweep consumes
  // the lot and user_version=1 makes that permanent
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
            VALUES ('2026-07-23','implementation-misc','sonnet','FAIL','live',0)`);
  pre.exec('PRAGMA user_version = 0');
  pre.close();

  const db = openDb(path);
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE evidence='live'").get() as any).consumed, 0);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 0); // retried later
  seedMatrix(db, 1);
  db.close();
  const again = openDb(path); // now the matrix can answer "does this row route sonnet?"
  assert.equal((again.prepare("SELECT consumed FROM outcomes WHERE evidence='live'").get() as any).consumed, 0);
  assert.equal((again.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
});

test('migration claims existing proofs, spends fossil evidence, and runs once', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // a pre-2.5 duel: proofs live in `duels`/`judgments`, proof_claims does not know them
  pre.exec(`INSERT INTO duels(id, task_kind, created_at, sides, label_map, status,
              anth_proof, gpt_proof, winner_vendor, decided_by)
            VALUES (7,'default',10,'[]','{}','judged',
              '6d15b6ee-23c1-48a2-b51c-1836bf431724',
              'rollout-2026-07-24T15-28-52-019f959a-1ac1-7bf3-a0d5-c30f463dde69.jsonl',
              'anthropic','judges')`);
  pre.exec(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof)
            VALUES (7,'anthropic','X',11,'f1e2d3c4-b5a6-4789-9012-3456789abcde')`);
  // evidence 2.4.0 logged before its guard: 'default' routes sonnet, not haiku. (The fixture
  // sits on 'default', not a real kind, so the v7 split reconcile cannot shadow the v1 pin.)
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
            VALUES ('2026-07-23','default','haiku','FAIL','stale',0)`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
            VALUES ('2026-07-23','default','sonnet','FAIL','live',0)`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed)
            VALUES ('2026-07-23','bulk-mechanical','gpt-5.3-codex-spark','FAIL','shadow','shadow',0)`);
  pre.exec('PRAGMA user_version = 0'); // as if written by 2.4.0
  pre.close();

  const db = openDb(path); // upgrade happens here
  const claims = db.prepare('SELECT proof, slot FROM proof_claims ORDER BY slot').all() as any[];
  assert.deepEqual(claims.map(c => c.slot), ['anthropic', 'judge:anthropic', 'openai']);
  // the filename-spelled proof is claimed under its canonical id
  assert.ok(claims.some(c => c.proof === '019f959a-1ac1-7bf3-a0d5-c30f463dde69'));

  const spent = (evidence: string) => (db.prepare(
    'SELECT consumed FROM outcomes WHERE evidence=?').get(evidence) as any).consumed;
  assert.equal(spent('stale'), 1);  // fossil: the row does not route haiku
  assert.equal(spent('live'), 0);   // still admissible
  // v2 retires the earn-in shadow, so shadow evidence is spent with the mechanism it fed —
  // left unspent on a row spark now holds by seed, it is one loss from reading as a 2× streak.
  assert.equal(spent('shadow'), 1);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);

  // second open must not re-run: a new unspent fossil row survives the next open untouched
  db.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
           VALUES ('2026-07-24','default','haiku','FAIL','after',0)`);
  db.close();
  const again = openDb(path);
  assert.equal((again.prepare("SELECT consumed FROM outcomes WHERE evidence='after'")
    .get() as any).consumed, 0);
});

test('a migration that fails part-way leaves no half-applied writes behind', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // a pre-2.5 duel whose proof the backfill claims first, then the fossil the sweep would spend
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, anth_proof)
            VALUES ('implementation', 1, '[]', '{}', 'judged',
                    '6d15b6ee-23c1-48a2-b51c-c1ffe5161392')`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
            VALUES ('2026-07-23','implementation','gpt-5.6-luna','FAIL','fossil',0)`);
  pre.exec('DELETE FROM proof_claims');
  // the sweep's UPDATE explodes after the backfill has already inserted its claims
  pre.exec(`CREATE TRIGGER boom BEFORE UPDATE ON outcomes
            BEGIN SELECT RAISE(ABORT, 'sweep exploded'); END`);
  pre.exec('PRAGMA user_version = 0');
  pre.close();

  const db = openDb(path); // migrate() must roll the backfill back, not bank it
  assert.equal((db.prepare('SELECT COUNT(*) c FROM proof_claims').get() as any).c, 0);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 0);
});

test('v2 migration retires luna and switches deep-review to union on an existing DB', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // the kind's historical name at this schema era (renamed -misc 2026-08-10)
  pre.exec("UPDATE matrix SET task_kind='bulk-mechanical' WHERE task_kind='bulk-mechanical-misc'");
  // Roll the matrix back to what a v2.5.x install actually holds: luna on both haiku rows,
  // deep-review a decided duel. seedMatrix is INSERT OR IGNORE, so nothing in the release could
  // deliver v2.6's routing to this DB — the feature shipped as a schema change with no data.
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-luna', gpt_effort='low'
            WHERE task_kind IN ('bulk-mechanical','transcription')`);
  pre.exec(`UPDATE matrix SET union_mode=0, decided=1, victor_vendor='openai',
            decided_mode='victory', spot_counter=4 WHERE task_kind='deep-review'`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed)
            VALUES ('2026-07-24','bulk-mechanical','gpt-5.3-codex-spark','FAIL','shadow','shadow',0)`);
  pre.exec('PRAGMA user_version = 1'); // as if written by 2.5.8
  pre.close();

  const db = openDb(path);
  const row = (k: string): any => db.prepare('SELECT * FROM matrix WHERE task_kind=?').get(k);
  assert.equal(row('deep-review').union_mode, 1);
  assert.equal(row('deep-review').decided, 0);          // a union kind has no victor
  assert.equal(row('deep-review').victor_vendor, null);
  assert.equal(row('deep-review').spot_counter, 0);
  // haiku's seat goes to spark (v2); v9 then renames the row and re-stamps the pairing at its
  // 2026-08-10 state, so the old spelling is gone and the effort reads xhigh, not v2's low
  assert.equal(row('bulk-mechanical'), undefined);
  assert.equal(row('bulk-mechanical-misc').gpt_model, 'gpt-5.3-codex-spark');
  assert.equal(row('bulk-mechanical-misc').gpt_effort, 'xhigh');
  assert.equal(row('transcription').gpt_model, 'gpt-5.3-codex-spark');
  assert.equal((db.prepare("SELECT COUNT(*) c FROM matrix WHERE gpt_model='gpt-5.6-luna'")
    .get() as any).c, 0);
  // the shadow evidence goes with the mechanism it fed
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE evidence='shadow'")
    .get() as any).consumed, 1);
  assert.ok((db.prepare("SELECT COUNT(*) c FROM matrix_changelog WHERE entry LIKE '%luna retired%'")
    .get() as any).c > 0);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  db.close();

  // idempotent: a second open must not re-log or re-clear anything
  const again = openDb(path);
  again.exec(`UPDATE matrix SET decided=1, victor_vendor='anthropic' WHERE task_kind='deep-review'`);
  again.close();
  const third = openDb(path);
  assert.equal((third.prepare("SELECT decided FROM matrix WHERE task_kind='deep-review'")
    .get() as any).decided, 1); // untouched — the migration ran once
});

test('v2 migration moves the contest window past the swap, so luna-era duels stop counting', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec("UPDATE matrix SET task_kind='bulk-mechanical' WHERE task_kind='bulk-mechanical-misc'");
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-luna', gpt_effort='low', updated_at=1000
            WHERE task_kind='bulk-mechanical'`);
  // a judged duel fought against luna, inside the pre-swap window
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor, decided_by)
            VALUES ('bulk-mechanical', 5000,
              '[{"vendor":"anthropic","lane":"B","model":"haiku"},{"vendor":"openai","lane":"codex","model":"gpt-5.6-luna"}]',
              '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 1');
  pre.close();

  const db = openDb(path);
  // v9 renames the row on the same open, so the surface reads under the canonical name
  const row = db.prepare("SELECT * FROM matrix WHERE task_kind='bulk-mechanical-misc'").get() as any;
  assert.equal(row.gpt_model, 'gpt-5.3-codex-spark');
  // the window is the verdict's evidentiary basis: it must not reach back past the swap,
  // or 7 wins against a retired model plus 1 against spark read as an 8-duel victory.
  assert.ok(row.updated_at > 5001,
    `updated_at ${row.updated_at} was not stamped past the luna duel`);
  // v2's swap stamped the window itself: the v3 repair (which stops at last-luna-duel+1)
  // never needed to fire on this install
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM matrix_changelog WHERE entry LIKE '%contest window repaired%'")
    .get() as any).c, 0);
});

test('v3 repair closes pre-swap windows on installs the v2 migration already visited', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // Fixture kinds sit OFF the v7/v9 target sets (split children and renamed parents), so the
  // exact repair floor stays observable after the whole ladder runs.
  // what the live DB looks like after the v2 bug: spark installed, window left at T0
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.3-codex-spark', gpt_effort='low', updated_at=1000
            WHERE task_kind IN ('transcription','long-context')`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor, decided_by)
            VALUES ('transcription', 5000,
              '[{"vendor":"anthropic","lane":"B","model":"haiku"},{"vendor":"openai","lane":"codex","model":"gpt-5.6-luna"}]',
              '{}', 'judged', 'anthropic', 'judges')`);
  // long-context's luna duel PREdates its window — that row needs no repair and must not move
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor, decided_by)
            VALUES ('long-context', 500,
              '[{"vendor":"anthropic","lane":"B","model":"haiku"},{"vendor":"openai","lane":"spark","model":"gpt-5.6-luna"}]',
              '{}', 'walkover', 'anthropic', 'walkover')`);
  pre.exec('PRAGMA user_version = 2'); // v2 already ran here — only a v3 pass can fix it
  pre.close();

  const db = openDb(path);
  const row = (k: string): any => db.prepare('SELECT * FROM matrix WHERE task_kind=?').get(k);
  assert.equal(row('transcription').updated_at, 5001); // just past the last luna duel
  assert.equal(row('long-context').updated_at, 1000);  // clean window untouched
  assert.ok((db.prepare('PRAGMA user_version').get() as any).user_version >= 3);
  db.close();

  // idempotent: the repair keys on contamination, which it just removed
  const again = openDb(path);
  assert.equal((again.prepare("SELECT updated_at FROM matrix WHERE task_kind='transcription'")
    .get() as any).updated_at, 5001);
});

test('a fresh seeded DB is born v2 without a spurious changelog entry', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1); db.close();
  const again = openDb(path);
  assert.equal((again.prepare("SELECT union_mode FROM matrix WHERE task_kind='deep-review'")
    .get() as any).union_mode, 1);                       // from SEED, not the migration
  assert.equal((again.prepare(
    "SELECT COUNT(*) c FROM matrix_changelog WHERE entry LIKE '%switched to union%'").get() as any).c, 0);
});

test('v4 spends cross-era evidence for models their rows no longer route', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // an unspent FAIL for a model its row no longer routes (evicted before the eviction rule
  // existed) and one for the model the row still routes
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed) VALUES
    ('2026-07-23','implementation-misc','gpt-5.6-luna','FAIL','cross-era',0),
    ('2026-07-29','implementation-misc','sonnet','FAIL','current-era',0)`);
  pre.exec('PRAGMA user_version = 3'); // as if written by 2.6.4
  pre.close();
  const db = openDb(path);
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE evidence='cross-era'").get() as any).consumed, 1);
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE evidence='current-era'").get() as any).consumed, 0);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
});

test('v4 spares same-tenure evidence: canonical spark FAILs and suffixed models survive', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // The sweep's two most dangerous false positives: a canonical spark FAIL on a row that
  // STILL routes spark (spending it silently resets an in-progress revert streak), and a
  // suffixed model id that must compare verbatim against the matrix. The spark row sits on
  // 'transcription', off the v9 rename set, whose era-spend would mask the sweep's verdict.
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed) VALUES
    ('2026-07-29','transcription','gpt-5.3-codex-spark','FAIL','spark-live','canonical',0),
    ('2026-07-29','long-context','fable[1m]','FAIL','suffixed-live',NULL,0)`);
  pre.exec('PRAGMA user_version = 3');
  pre.close();
  const db = openDb(path);
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE evidence='spark-live'").get() as any).consumed, 0);
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE evidence='suffixed-live'").get() as any).consumed, 0);
});

test('only one ROUTED spot audit can exist per kind — the creation race has a real gate', () => {
  const db = openDb(':memory:');
  const sides = JSON.stringify([
    { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
    { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
  ]);
  const mk = () => db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating,
    sides, label_map) VALUES ('implementation', 1, 1, 0, ?, '{}')`).run(sides);
  mk();
  assert.throws(mk, /UNIQUE/i); // duel-63 sol#4: the router's SELECT-then-INSERT is not atomic
  // a routed spot audit on ANOTHER kind is fine, and a non-spot duel on the same kind is fine
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map)
    VALUES ('deep-review', 1, 1, 0, ?, '{}')`).run(sides);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating, sides, label_map)
    VALUES ('implementation', 1, 0, 0, ?, '{}')`).run(sides);
  // …and once the first leaves 'routed', the kind can route its next audit
  db.prepare("UPDATE duels SET status='abandoned' WHERE task_kind='implementation' AND spot_check=1").run();
  mk();
});

// ——— duel-64 ledger ———

// The index-creation catch conflated "duplicates present" with BUSY and read-only; the router
// calls this index the real gate, so its silent absence needs an operator signal (duel-64 opus #8).
test('a deferred spot-audit index is logged, not swallowed', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const mk = () => db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, mutating,
    sides, label_map, status) VALUES ('implementation', 1, 1, 0, '[]', '{}', 'routed')`).run();
  mk(); mk(); // duplicate in-flight audits block index creation on the next open
  db.close();
  const logged: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => { logged.push(String(m)); };
  try { openDb(path); } finally { console.error = orig; }
  assert.ok(logged.some(l => /idx_one_inflight_spot/.test(l)),
    `expected a deferral log naming the index, got: ${JSON.stringify(logged)}`);
});

// ——— duel-65 ledger ———

// 2.6.7 dropped the old routed-only gate BEFORE creating its replacement, so on exactly the
// state that blocks the new index (a 2.6.6-legal routed+awaiting pair, or a transient BUSY)
// the open completed with NO spot gate at all — the router's SELECT-then-INSERT race ran
// unguarded, worse than 2.6.6 (duel-65 opus F1 / sol S6). Create first, drop after — and since
// duel-67, normalize the blocking data and retry, so a dead pair cannot defer the gate at all.
test('a blocked in-flight index is normalized on open — the full gate lands over a dead pair', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  // roll back to a 2.6.6 install: old index present, new one absent
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_routed_spot ON duels(task_kind) " +
    "WHERE spot_check=1 AND status='routed'");
  // 2.6.6-legal: one routed + one awaiting_judgment spot audit on the same kind
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', 1, 1, '[]', '{}', 'awaiting_judgment')`).run();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', 2, 1, '[]', '{}', 'routed')`).run();
  db.close();

  const orig = console.error; console.error = () => {};
  let re: ReturnType<typeof openDb>;
  try { re = openDb(path); } finally { console.error = orig; }
  const idx = (d: ReturnType<typeof openDb>, n: string) => d.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(n);
  // deliberate duel-67 update (opus F8 / sol F1): the blocking pair is TTL-dead DATA, and the
  // open now applies the sweep before retrying — the full gate lands on the FIRST reopen
  // instead of parking on the routed-only fallback forever.
  assert.ok(idx(re, 'idx_one_inflight_spot'), 'the sweep clears the dead pair and the gate lands');
  assert.ok(!idx(re, 'idx_one_routed_spot'));
  assert.equal((re.prepare(
    "SELECT COUNT(*) AS n FROM duels WHERE status='abandoned'").get() as any).n, 2);
  re.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', 3, 1, '[]', '{}', 'awaiting_judgment')`).run();
  assert.throws(() => re.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides,
    label_map, status) VALUES ('implementation', 4, 1, '[]', '{}', 'routed')`).run(), /UNIQUE/i);
});

// The blind ALTER catch read EVERY failure as "column exists": a BUSY (or any real error)
// during the outputs_at ALTER returned a connection whose writes then fail
// 'no such column: outputs_at' (duel-65 sol S8). Swallow only when the column is really there.
test('ensureColumn swallows only "already exists" — a real ALTER failure throws', () => {
  const db = openDb(':memory:');
  assert.throws(() => ensureColumn(db, 'nonexistent', 'outputs_at INTEGER'), /no such table/i);
  ensureColumn(db, 'duels', 'outputs_at INTEGER'); // duplicate column: silently kept
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('duels') WHERE name='outputs_at'").get());
});

// ——— duel-66 ledger ———

// A DB that opened under 2.6.7 in the blocking state had already dropped the old gate and then
// failed the create: NO index at all, and 2.6.8's create-then-drop had nothing to keep — the
// log said "old gate kept if present" while the router's SELECT-then-INSERT race ran unguarded
// (duel-66 sol F1 / opus M7). Deliberate duel-67 update (opus F8 / sol F1): the no-gate DB is
// normalized (the dead pair swept) and the FULL gate created on retry — the fallback is
// reserved for real storage errors, not a permanent parking spot the data can never leave.
test('a no-gate DB is swept on open and regains the full in-flight gate', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot'); // the 2.6.7 aftermath: nothing at all
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', 1, 1, '[]', '{}', 'awaiting_judgment')`).run();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', 2, 1, '[]', '{}', 'routed')`).run();
  db.close();
  const orig = console.error; console.error = () => {};
  let re: ReturnType<typeof openDb>;
  try { re = openDb(path); } finally { console.error = orig; }
  const idx = (n: string) => re.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(n);
  assert.ok(idx('idx_one_inflight_spot'), 'the dead pair is swept and the full gate lands');
  assert.ok(!idx('idx_one_routed_spot'));
  assert.throws(() => {
    re.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
      VALUES ('implementation', 3, 1, '[]', '{}', 'routed')`).run();
    re.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
      VALUES ('implementation', 4, 1, '[]', '{}', 'awaiting_judgment')`).run();
  }, /UNIQUE/i);
});

// ensureColumn is exported with the table name interpolated into SQL — validate the boundary
// (duel-66 opus M10).
test('ensureColumn refuses a non-identifier table name', () => {
  const db = openDb(':memory:');
  assert.throws(() => ensureColumn(db, 'duels; DROP TABLE duels', 'x INTEGER'), /invalid table/i);
});

// ——— duel-67 ledger ———

// A FRESH duplicate pair (younger than the sweep TTL) cannot be expired — it is demoted, the
// same resolution recordResults applies when a revival races a live audit: the awaiting row
// (it holds evidence) keeps the audit identity, the routed one becomes a plain paid record,
// and the full gate lands (duel-67 opus F8 / sol F1).
test('a fresh in-flight duplicate pair is demoted, not expired — and the full gate lands', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'awaiting_judgment')`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 30_000);
  db.close();
  const orig = console.error; console.error = () => {};
  let re: ReturnType<typeof openDb>;
  try { re = openDb(path); } finally { console.error = orig; }
  const idx = (n: string) => re.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(n);
  assert.ok(idx('idx_one_inflight_spot'), 'the duplicate pair is demoted and the gate lands');
  const rows = (re.prepare(
    'SELECT status, spot_check, demoted_audit FROM duels ORDER BY id').all() as any[])
    .map(r => ({ ...r })); // node:sqlite rows are null-prototype — normalize for deepEqual
  assert.deepEqual(rows, [
    { status: 'awaiting_judgment', spot_check: 1, demoted_audit: 0 }, // evidence keeps the seat
    { status: 'routed', spot_check: 0, demoted_audit: 1 },            // still a PAID audit
  ]);
});

// ——— duel-68 ledger ———

// The demotion picked the survivor by STATUS then id — the exact proxy the rest of this
// codebase refuses to accept: a blank-side awaiting_judgment row (the pre-2.6.1 legacy shape
// this healing path exists for) outranked an older row holding two real outputs. The blank
// seat-holder is unjudgeable, dies evidence-free at the TTL, and arms the dying-audit backoff
// plus the operator note on a kind whose audit SUCCEEDED — the superseded fix's harm through
// the normalization door (duel-68 opus F2). Evidence first, then status, then recency:
// landed() is registered on this very connection.
test('a blank awaiting duplicate does not outrank the row holding two real outputs', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    anth_output, gpt_output) VALUES ('implementation', ?, 1, '[]', '{}', 'awaiting_judgment',
    'real anth report', 'real gpt report')`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    anth_output, gpt_output) VALUES ('implementation', ?, 1, '[]', '{}', 'awaiting_judgment',
    '   ', NULL)`).run(now - 30_000);
  db.close();
  const orig = console.error; console.error = () => {};
  let re: ReturnType<typeof openDb>;
  try { re = openDb(path); } finally { console.error = orig; }
  assert.ok(re.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_one_inflight_spot'").get());
  const rows = (re.prepare(
    'SELECT spot_check, demoted_audit FROM duels ORDER BY id').all() as any[]).map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { spot_check: 1, demoted_audit: 0 }, // the evidence-bearing row keeps the audit seat
    { spot_check: 0, demoted_audit: 1 }, // the blank duplicate becomes the plain record
  ]);
});

// The open-time heal runs expireStaleDuels and DISCARDED the ids — the RETURNING clause exists
// because a silent sweep was itself a defect (C3), and the sweep here is unconditioned on kind:
// an unrelated TTL-dead duel is abandoned by a read-intent openDb with nothing naming it, and
// the CLI's own sweep two statements later returns [] (duel-68 opus F3).
test('duels swept by the open-time heal are named on stderr, not silently abandoned', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  // the TTL-dead blocking pair…
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', 1, 1, '[]', '{}', 'routed')`).run();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', 2, 1, '[]', '{}', 'routed')`).run();
  // …and an unrelated TTL-dead duel the heal's sweep also takes
  const bystander = Number(db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check,
    sides, label_map, status) VALUES ('transcription', 3, 0, '[]', '{}', 'routed')`)
    .run().lastInsertRowid);
  db.close();
  const logged: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => { logged.push(String(m)); };
  try { openDb(path); } finally { console.error = orig; }
  assert.ok(logged.some(l => new RegExp(`swept duel\\(s\\).*\\b${bystander}\\b.*abandoned`).test(l)),
    `expected the swept ids on stderr, got: ${JSON.stringify(logged)}`);
});

// Healing ran as three autocommit statements against the very concurrent writers the index
// exists to gate: a racing route could insert a fresh audit between the demotion and the
// CREATE, failing the retry and parking on the routed-only fallback with the awaiting half
// unguarded — and a failure partway left the sweep's collateral committed without the gate it
// was taken for (duel-68 sol F2). One transaction: a mid-heal failure rolls the sweep back too.
test('the heal is atomic — a mid-heal failure rolls back the sweep with it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  // a TTL-dead bystander the sweep takes as collateral…
  const bystander = Number(db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check,
    sides, label_map, status) VALUES ('transcription', 1, 0, '[]', '{}', 'routed')`)
    .run().lastInsertRowid);
  // …and a FRESH duplicate pair that blocks both creates and needs the demotion step
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 30_000);
  // fault injection: the demotion dies mid-heal
  db.exec(`CREATE TRIGGER heal_fault BEFORE UPDATE OF demoted_audit ON duels
    BEGIN SELECT RAISE(ABORT, 'injected heal fault'); END`);
  db.close();
  // Both creates fail here (the fresh routed pair blocks the fallback too), and an open that
  // can install NO gate now REFUSES instead of returning an ungated writable connection —
  // the router treats the index as the real cross-process gate, and two processes racing
  // pendingSpotDuel through a gateless DB both land their audit (duel-71 sol F4).
  // The refusal diagnostics leave via writeSync, not console.error — a console write queued
  // before the CLI's process.exit can drop on async-pipe platforms (duel-75 opus F3) — so
  // their content is pinned where it is consumed: the child-process pipe test in cli.test.ts
  // ('NO-GATE refusal diagnostics survive the hook exit'), not a console capture here.
  assert.throws(() => openDb(path), /no uniqueness gate/);
  const re = new DatabaseSync(path);
  // the whole heal rolled back: the bystander was NOT abandoned by a heal that never landed
  assert.equal((re.prepare('SELECT status FROM duels WHERE id=?').get(bystander) as any).status,
    'routed');
});

// The identifier check validated one of the two interpolations: columnDdl is the parameter
// that actually carries free text (duel-67 opus F6).
test('ensureColumn refuses a column DDL that is not a plain column definition', () => {
  const db = openDb(':memory:');
  assert.throws(() => ensureColumn(db, 'duels', 'x INTEGER; DROP TABLE duels'), /invalid column/i);
  assert.throws(() => ensureColumn(db, 'duels', 'x INTEGER, y INTEGER'), /invalid column/i);
  assert.ok(db.prepare('SELECT 1 FROM duels LIMIT 0')); // the table survived the attempts
});

// The duel-67 charset validated more than the boundary needs: its tail excluded `-`, `.`, `<`,
// `>`, so ordinary column DDL — DEFAULT -1, DEFAULT 0.5, CHECK (x <> '') — threw, and the
// throw sits inside openDb with nothing catching it: the first future migration needing any of
// those takes down every entry point at open (duel-68 opus F7). Reject what is actually
// dangerous (statement close, second column, comments); accept the rest of the grammar.
test('ensureColumn accepts ordinary column DDL — negative defaults, decimals, CHECK', () => {
  const db = openDb(':memory:');
  ensureColumn(db, 'duels', "extra_a INTEGER DEFAULT -1");
  ensureColumn(db, 'duels', "extra_b REAL DEFAULT 0.5");
  ensureColumn(db, 'duels', "extra_c TEXT CHECK (extra_c <> 'x')");
  const cols = (db.prepare("SELECT name FROM pragma_table_info('duels')").all() as any[])
    .map(r => r.name);
  for (const c of ['extra_a', 'extra_b', 'extra_c']) assert.ok(cols.includes(c), c);
  // the boundary still holds
  assert.throws(() => ensureColumn(db, 'duels', "x INTEGER -- comment"), /invalid column/i);
  assert.throws(() => ensureColumn(db, 'duels', "x INTEGER /* c */"), /invalid column/i);
  assert.throws(() => ensureColumn(db, 'duels', "1bad INTEGER"), /invalid column/i);
});

// The pragma probe re-enters SQLite and can fail on the same lock/IO condition that failed
// the ALTER — its error must not replace the real one (duel-66 opus M10; pinned by duel-67
// sol F4).
test('a pragma probe that also fails cannot replace the ALTER error', () => {
  const alterErr = new Error('disk I/O error');
  const fake: any = {
    exec() { throw alterErr; },
    prepare() { throw new Error('database is locked'); },
  };
  assert.throws(() => ensureColumn(fake, 'duels', 'x INTEGER'), /disk I\/O error/);
});

// ——— duel-69 ledger ———

// The heal ranked evidence as a CONJUNCTION — landed(anth) AND landed(gpt) — so a row holding
// ONE real output scored 0, exactly like a fully blank row, and lost the audit seat to a newer
// blank duplicate on the id tiebreak. The blank seat-holder is unjudgeable, dies evidence-free
// at the TTL, and arms the dying-audit backoff — the precise harm the duel-68 fix was written
// for, reproduced one evidence-level down (duel-69 opus F4 / sol F1, found by BOTH reviewers).
// Evidence is a COUNT: two landed sides, then one, then none — status and id break ties below.
test('one landed output outranks a blank duplicate in the heal', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    anth_output, gpt_output) VALUES ('implementation', ?, 1, '[]', '{}', 'awaiting_judgment',
    'real partial report', NULL)`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    anth_output, gpt_output) VALUES ('implementation', ?, 1, '[]', '{}', 'awaiting_judgment',
    '   ', NULL)`).run(now - 30_000);
  db.close();
  const orig = console.error; console.error = () => {};
  let re: ReturnType<typeof openDb>;
  try { re = openDb(path); } finally { console.error = orig; }
  assert.ok(re.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_one_inflight_spot'").get());
  const rows = (re.prepare(
    'SELECT spot_check, demoted_audit FROM duels ORDER BY id').all() as any[]).map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { spot_check: 1, demoted_audit: 0 }, // one real output is evidence — the seat stays
    { spot_check: 0, demoted_audit: 1 }, // the blank duplicate becomes the plain record
  ]);
});

// The demotion strips an audit of its identity permanently, on a read-intent openDb — the same
// "a silent sweep was itself a defect" principle the swept ids were surfaced for applies to it
// (duel-69 opus F10). The heal names both sets on its one surface.
test('the heal names the demoted ids too', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    anth_output, gpt_output) VALUES ('implementation', ?, 1, '[]', '{}', 'awaiting_judgment',
    'real anth report', 'real gpt report')`).run(now - 60_000);
  const demotee = Number(db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides,
    label_map, status) VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`)
    .run(now - 30_000).lastInsertRowid);
  db.close();
  const logged: string[] = [];
  const orig = console.error;
  console.error = (m?: unknown) => { logged.push(String(m)); };
  try { openDb(path); } finally { console.error = orig; }
  assert.ok(logged.some(l => new RegExp(`demoted duel\\(s\\).*\\b${demotee}\\b`).test(l)),
    `expected the demoted id on stderr, got: ${JSON.stringify(logged)}`);
});

// A failed heal reported only the original index-create error; the exception saying WHY the
// normalization itself failed was discarded by the outer catch, leaving the operator to guess
// (duel-69 sol M6). Both errors belong on the one line this path has.
test('a failed heal keeps the heal exception in the diagnostic', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-idx-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 30_000);
  db.exec(`CREATE TRIGGER heal_fault BEFORE UPDATE OF demoted_audit ON duels
    BEGIN SELECT RAISE(ABORT, 'injected heal fault'); END`);
  db.close();
  // This state now also ends in the refused ungated open (duel-71 sol F4) — the point here
  // stays the same: the heal's own exception must survive into the diagnostic. The refusal
  // branch prints via writeSync since duel-75 opus F3 (a console write queued before the
  // CLI's process.exit can drop on async-pipe platforms), so a console capture no longer
  // sees it — read the diagnostic where the operator does, on a real child stderr pipe,
  // through the scripted (non-hook, exit 1) CLI path.
  const res = spawnSync('node', ['dist/src/cli.js', 'status'],
    { env: { ...process.env, MR_DB_PATH: path, MR_DATA_DIR: dirname(path) }, encoding: 'utf8' });
  assert.equal(res.status, 1); // a scripted command must still see the failure
  assert.match(res.stderr, /no uniqueness gate/);
  assert.match(res.stderr, /heal failed: injected heal fault/,
    `expected the heal exception on stderr, got: ${res.stderr}`);
});

// The commit that gave a non-union double failure the 'abandoned' spelling changed NEW records
// only: rows already stored as null-winner walkovers with nothing landed keep the old spelling —
// unlisted by pendingDuels, non-revivable (recordResults short-circuits on 'walkover'), yet
// counted dead by the router. The two-subsystem disagreement the fix describes stays true for
// every legacy row until a data migration rewrites them (duel-69 opus F7).
test('v5 rewrites legacy double-failure walkovers into revivable abandoned rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // the legacy double-failure spelling: null winner, nothing landed, death stamp nulled
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by, recorded_at) VALUES ('implementation', 1000, '[]', '{}', 'walkover', NULL,
    'walkover', 2000)`);
  // a REAL walkover — one side landed, winner declared — must not be touched
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by, anth_output, recorded_at) VALUES ('implementation', 1000, '[]', '{}', 'walkover',
    'anthropic', 'walkover', 'real report', 2000)`);
  pre.exec('PRAGMA user_version = 4'); // as if written by 2.6.11
  pre.close();
  const db = openDb(path);
  const rows = (db.prepare(
    'SELECT status, decided_by, abandoned_at FROM duels ORDER BY id').all() as any[])
    .map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { status: 'abandoned', decided_by: 'abandoned', abandoned_at: 2000 }, // revivable now
    { status: 'walkover', decided_by: 'walkover', abandoned_at: null },   // untouched
  ]);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
});

// The danger scan had no notion of string literals or paren depth: a comma inside NUMERIC(10,2)
// or a quoted DEFAULT, and comment markers inside quoted data, all threw — inside openDb, where
// the failure mode is "no entry point starts" (duel-69 opus F5 / sol M5, found by BOTH).
// Literals are blanked first; commas count only at paren depth 0; stray quotes reject.
test('ensureColumn accepts quoted and parenthesised DDL — commas and markers inside literals', () => {
  const db = openDb(':memory:');
  ensureColumn(db, 'duels', 'extra_d NUMERIC(10,2)');
  ensureColumn(db, 'duels', "extra_e TEXT DEFAULT 'a,b'");
  ensureColumn(db, 'duels', "extra_f TEXT DEFAULT 'a--b'");
  ensureColumn(db, 'duels', "extra_g TEXT CHECK (extra_g IN ('a','b'))");
  const cols = (db.prepare("SELECT name FROM pragma_table_info('duels')").all() as any[])
    .map(r => r.name);
  for (const c of ['extra_d', 'extra_e', 'extra_f', 'extra_g']) assert.ok(cols.includes(c), c);
  // the boundary still holds — outside a literal the tokens stay fatal
  assert.throws(() => ensureColumn(db, 'duels', 'x INTEGER; DROP TABLE duels'), /invalid column/i);
  assert.throws(() => ensureColumn(db, 'duels', 'x INTEGER, y INTEGER'), /invalid column/i);
  assert.throws(() => ensureColumn(db, 'duels', 'x INTEGER -- comment'), /invalid column/i);
  assert.throws(() => ensureColumn(db, 'duels', "x TEXT DEFAULT 'a"), /invalid column/i);
  assert.throws(() => ensureColumn(db, 'duels', 'x TEXT CHECK (x'), /invalid column/i);
});

// ——— duel-70 ledger ———

// v5 backfilled only the rows it CONVERTED: a pre-2.6.8 row already stored 'abandoned' with a
// NULL death stamp stayed NULL (the shape deadReplay then propagated), and a sweep stamp older
// than the row's own recorded death survived as the horizon clock, hiding a fresh corpse from
// the pending window (duel-70 anth F2/F8 + sol P2). v6 re-stamps every abandoned row's death
// at its LATEST clock, once, for all eras.
test('v6 backfills legacy death stamps at the latest clock', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    recorded_at) VALUES ('implementation', 1, '[]', '{}', 'abandoned', 'abandoned', 2000)`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    recorded_at, abandoned_at) VALUES ('implementation', 1, '[]', '{}', 'abandoned',
    'abandoned', 9000, 500)`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    recorded_at, abandoned_at) VALUES ('implementation', 1, '[]', '{}', 'abandoned',
    'abandoned', 9000, 9500)`);
  pre.exec('PRAGMA user_version = 5'); // as if written by 2.6.12
  pre.close();
  const db = openDb(path);
  const stamps = (db.prepare('SELECT abandoned_at FROM duels ORDER BY id').all() as any[])
    .map(r => r.abandoned_at);
  assert.deepEqual(stamps, [2000, 9000, 9500]); // NULL→recorded_at, stale→newer, newest kept
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  assert.ok(db.prepare("SELECT entry FROM matrix_changelog WHERE entry LIKE 'v6%'").get());
});

// ——— duel-87 ledger ———

// v2.7.0 shipped the 2026-08-01 kind split data-only: INSERT OR IGNORE could not correct a row
// already sitting under a child's name (getRow's provisional default clone — for the
// implementation children the clone even matches the seeded pairing, so `provisional` is the
// only tell), and the parents kept their pre-split mixed-population records inside the live
// victory window (duel-87, both sides). v7 reconciles the children and restarts the parents.
test('v7 reconciles collided split rows and restarts parent windows — composed, with replay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec("UPDATE matrix SET task_kind='bulk-mechanical' WHERE task_kind='bulk-mechanical-misc'");
  // pre-state: a 2.6.18 install — the children do not exist yet…
  pre.exec(`DELETE FROM matrix WHERE task_kind IN ('mechanical-apply','mechanical-sweep',
    'implementation-build','implementation-teardown')`);
  // …except one a controller auto-created ahead of the seed: a provisional default clone
  // carrying a verdict, spot progress, union flag and unspent evidence under the wrong pairing
  pre.exec(`INSERT INTO matrix(task_kind, anth_model, anth_effort, anth_lane, gpt_model,
    gpt_effort, provisional, decided, victor_vendor, decided_mode, spot_counter, union_mode,
    updated_at) VALUES ('mechanical-apply','sonnet','medium','B','gpt-5.6-terra','medium',
    1, 1, 'openai', 'victory', 7, 1, 1000)`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence) VALUES
    ('2026-07-30','mechanical-apply','gpt-5.6-terra','FAIL','logged under the collided pairing')`);
  // …and a parent both decided and holding a pre-split judged duel inside its window, plus a
  // post-split residue duel that must SURVIVE the re-window
  pre.exec(`UPDATE matrix SET updated_at=500, decided=1, victor_vendor='anthropic',
    decided_mode='victory', spot_counter=3 WHERE task_kind='bulk-mechanical'`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('bulk-mechanical', 1000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('bulk-mechanical', 1786000000000, '[]', '{}', 'judged', 'openai',
    'judges')`); // post-split (SPLIT_EPOCH = 1785590186000)
  pre.exec('PRAGMA user_version = 6'); // as if written by 2.6.18
  pre.close();

  const db = openDb(path); // v7 runs
  // the collided child is reconciled to its seed, wholesale
  const apply = db.prepare(
    "SELECT * FROM matrix WHERE task_kind='mechanical-apply'").get() as any;
  assert.equal(apply.anth_model, 'haiku');
  assert.equal(apply.anth_effort, 'low');
  assert.equal(apply.gpt_model, 'gpt-5.3-codex-spark');
  assert.equal(apply.gpt_effort, 'low');
  assert.equal(apply.provisional, 0);
  assert.equal(apply.decided, 0);
  assert.equal(apply.victor_vendor, null);
  assert.equal(apply.decided_mode, null);
  assert.equal(apply.spot_counter, 0);
  assert.equal(apply.union_mode, 0);
  // its wrong-pairing evidence is spent
  assert.equal((db.prepare(
    "SELECT consumed FROM outcomes WHERE task_kind='mechanical-apply'").get() as any).consumed, 1);
  // the parent reopened by v7 (changelog proves it below), then renamed and re-stamped by v9
  // on the same open — the old spelling leaves the matrix and both its duels ride the rename
  assert.equal(db.prepare("SELECT 1 FROM matrix WHERE task_kind='bulk-mechanical'").get(), undefined);
  const parent = db.prepare(
    "SELECT * FROM matrix WHERE task_kind='bulk-mechanical-misc'").get() as any;
  assert.equal(parent.decided, 0);
  assert.equal(parent.victor_vendor, null);
  assert.equal(parent.spot_counter, 0);
  assert.ok(parent.updated_at > 1001); // v9's fresh window supersedes v7's just-past-the-duel floor
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM duels WHERE task_kind='bulk-mechanical-misc'").get() as any).c, 2);
  // public surface: the seed lands only the three still-missing children — the renamed row
  // already holds the bulk-mechanical-misc name
  assert.equal(seedMatrix(db), 3);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c, 14);
  // every action has an author in the changelog
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%mechanical-apply%reconciled%'").get());
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%parent row(s) restarted%'").get());
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%v9 migration renamed%'").get());
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  const logCount = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  const stamp = parent.updated_at;
  db.close();

  // idempotent replay: a second open moves nothing
  const again = openDb(path);
  assert.equal((again.prepare(
    "SELECT updated_at FROM matrix WHERE task_kind='bulk-mechanical-misc'").get() as any)
    .updated_at, stamp);
  assert.equal(
    (again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logCount);
  assert.equal(seedMatrix(again), 0);
  again.close();
});

// The other side of v7: an install that never collided and never duelled the parents must come
// through the migration untouched — no reconcile, no restart, no changelog noise.
test('v7 is silent on a clean install', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec("UPDATE matrix SET task_kind='bulk-mechanical' WHERE task_kind='bulk-mechanical-misc'");
  // v6-era pairings: spark@xhigh on apply, sol@high (astra since v2.14.0) on the teardown/default
  // rows and opus@high vs astra@xhigh on build are 2026-08-10 operator decisions no v6 install
  // can hold
  pre.exec("UPDATE matrix SET gpt_effort='low' WHERE task_kind='mechanical-apply'");
  pre.exec(`UPDATE matrix SET anth_effort='low', gpt_effort='low'
    WHERE task_kind='mechanical-sweep'`);
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-terra', gpt_effort='medium'
    WHERE task_kind IN ('implementation-teardown','default')`);
  pre.exec(`UPDATE matrix SET anth_model='sonnet', anth_effort='medium',
    gpt_model='gpt-5.6-terra', gpt_effort='medium' WHERE task_kind='implementation-build'`);
  // a post-split duel on an untouched kind: enough history that the migrations actually run
  // (a duel-less, outcome-less DB is stamped current and skips them — see migrate)
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('default', 1786000000000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 6');
  pre.close();
  const db = openDb(path);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM matrix_changelog
    WHERE entry LIKE '%2026-08-01 seed%' OR entry LIKE '%restarted as ambiguous%'`).get() as any)
    .c, 0);
  // v9 is NOT silent here — the clean install still carries the old spelling, and the rename
  // is the whole point: exactly one entry, row now canonical
  assert.equal(db.prepare("SELECT 1 FROM matrix WHERE task_kind='bulk-mechanical'").get(), undefined);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM matrix_changelog
    WHERE entry LIKE '%v9 migration%'`).get() as any).c, 1);
  db.close();
});

// duel-105 P1 (closed v2.10.4): the split reconcile keyed on state drift alone, so an at<7 DB
// whose child row was deliberately re-paired — the old automatism's spark eviction, or an
// operator swap — got stamped BACK to the 2026-08-01 seed, resurrecting the very contender the
// re-pairing removed. provisional=1 is the auto-created clone's tell; without it v7 now flags
// and moves nothing (the v2.10.x doctrine).
test('v7 leaves a deliberately re-paired child alone and flags it — no spark resurrection', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // v6-era pairings the other children legitimately held (no drift, no flag noise)
  pre.exec(`UPDATE matrix SET anth_effort='low', gpt_effort='low'
    WHERE task_kind='mechanical-sweep'`);
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-terra', gpt_effort='medium'
    WHERE task_kind='implementation-teardown'`);
  // the P1 shape: mechanical-apply moved OFF spark deliberately (provisional=0), with unspent
  // evidence for the live tenure
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-terra', gpt_effort='low', provisional=0,
    updated_at=1000 WHERE task_kind='mechanical-apply'`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
    VALUES ('2026-08-02','mechanical-apply','gpt-5.6-terra','FAIL','tenure-live',0)`);
  // enough history that the migrations actually run
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('default', 1786000000000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 6');
  pre.close();

  const db = openDb(path);
  const row = db.prepare("SELECT * FROM matrix WHERE task_kind='mechanical-apply'").get() as any;
  assert.equal(row.gpt_model, 'gpt-5.6-terra'); // NOT resurrected to spark
  assert.equal(row.gpt_effort, 'low');
  assert.equal(row.updated_at, 1000);           // window untouched
  // its live-tenure evidence survives — nothing was reconciled
  assert.equal((db.prepare(
    "SELECT consumed FROM outcomes WHERE evidence='tenure-live'").get() as any).consumed, 0);
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%''mechanical-apply'' diverges%FLAGGED%'").get());
  assert.equal(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%mechanical-apply%reconciled%'").get(),
  undefined);
  const logs = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  db.close();
  // replay: the flag is logged once — the ladder is version-gated
  const again = openDb(path);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logs);
  again.close();
});

// duel-163 F1 (both reviewers, closed v2.10.6): the tell alone had a false converse. Until
// v2.10.6, setVendorModel re-paired a row without clearing `provisional`, so a pre-v7 copy can
// hold a row that is BOTH deliberately re-paired AND still provisional=1 — and the v2.10.4
// predicate stamped the seed back over it anyway. The clone's era pairing (sonnet@medium vs
// gpt-5.6-terra@medium) is the second tell: a provisional row anywhere else shows pairing work.
test('v7 never re-stamps a provisional row a pre-2.10.6 writer re-paired — flags it instead', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // v6-era pairings on the untouched children (no flag noise from them)
  pre.exec("UPDATE matrix SET gpt_effort='low' WHERE task_kind='mechanical-apply'");
  pre.exec(`UPDATE matrix SET anth_effort='low', gpt_effort='low'
    WHERE task_kind='mechanical-sweep'`);
  // the F1 shape, written as the pre-2.10.6 setVendorModel did: pairing changed, verdict/spot
  // cleared, window moved, evidence for the live tenure unspent — but provisional NEVER cleared.
  // terra@high, not sol: v17 swaps every sol row, so a sol shape here would test v17, not v7.
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-terra', gpt_effort='high', provisional=1,
    decided=0, victor_vendor=NULL, decided_mode=NULL, spot_counter=0, updated_at=2000
    WHERE task_kind='implementation-teardown'`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
    VALUES ('2026-08-02','implementation-teardown','gpt-5.6-terra','FAIL','tenure-live',0)`);
  // enough history that the migrations actually run
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('default', 1786000000000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 6');
  pre.close();

  const db = openDb(path);
  const row = db.prepare(
    "SELECT * FROM matrix WHERE task_kind='implementation-teardown'").get() as any;
  assert.equal(row.gpt_model, 'gpt-5.6-terra'); // NOT stamped back to the seed
  assert.equal(row.gpt_effort, 'high');
  assert.equal(row.updated_at, 2000);           // window untouched
  assert.equal((db.prepare(
    "SELECT consumed FROM outcomes WHERE evidence='tenure-live'").get() as any).consumed, 0);
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%''implementation-teardown'' diverges%FLAGGED%'").get());
  assert.equal(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%implementation-teardown%reconciled%'").get(),
  undefined);
  db.close();
});

// The composed pair (fix-wave rule 2): the same open must reconcile a genuine untouched clone
// AND preserve a re-paired provisional row — the predicate separates them by pairing shape only.
test('v7 composed: untouched clone re-stamped while re-paired provisional survives, one open', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec(`UPDATE matrix SET anth_effort='low', gpt_effort='low'
    WHERE task_kind='mechanical-sweep'`);
  pre.exec("UPDATE matrix SET gpt_effort='low' WHERE task_kind='mechanical-apply'");
  // untouched auto-clone: era default pairing, tell intact
  pre.exec(`UPDATE matrix SET anth_model='sonnet', anth_effort='medium',
    gpt_model='gpt-5.6-terra', gpt_effort='medium', provisional=1, updated_at=500
    WHERE task_kind='implementation-build'`);
  // re-paired provisional (pre-2.10.6 writer); terra@high so v17 leaves the shape alone
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-terra', gpt_effort='high', provisional=1,
    updated_at=2000 WHERE task_kind='implementation-teardown'`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('default', 1786000000000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 6');
  pre.close();

  const db = openDb(path);
  const build = db.prepare(
    "SELECT * FROM matrix WHERE task_kind='implementation-build'").get() as any;
  assert.equal(build.gpt_model, 'gpt-5.6-terra'); // clone reconciled to its 2026-08-01 seed
  assert.equal(build.provisional, 0);
  assert.ok(build.updated_at > 500);              // fresh contest
  const tear = db.prepare(
    "SELECT * FROM matrix WHERE task_kind='implementation-teardown'").get() as any;
  assert.equal(tear.gpt_model, 'gpt-5.6-terra');  // deliberate pairing preserved
  assert.equal(tear.updated_at, 2000);
  db.close();
});

// Every data migration carries the seed of the version it belongs to, so on a virgin install the
// historical repairs FIGHT the current seed: v7's inlined 2026-08-01 pairings hand
// mechanical-apply back at spark@low on the second open, silently reverting the 2026-08-10
// operator decision that put spark at xhigh. A DB with no duels and no outcomes has no history
// to repair — it is born current.
test('a virgin install is stamped current and keeps the seed efforts across opens', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);              // schema only — but born current (duel-163 F5):
  // the stamp lands BEFORE the entry point seeds, closing the first-use gap where a seeded,
  // version-0 DB that recorded work sent the next open through the whole historical ladder
  assert.equal((pre.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  seedMatrix(pre, 1);
  pre.close();

  const db = openDb(path);               // the open that used to run v1–v8 over a fresh DB
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  const efforts = db.prepare(`SELECT task_kind, gpt_effort FROM matrix
    WHERE task_kind IN ('implementation-build','mechanical-apply') ORDER BY task_kind`)
    .all() as any[];
  assert.deepEqual(efforts.map(r => [r.task_kind, r.gpt_effort]),
    [['implementation-build', 'xhigh'], ['mechanical-apply', 'xhigh']]);
  // and no migration claimed authorship of work it did not do
  assert.equal((db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, 0);
  db.close();
});

// duel-163 F5 (gpt side): the first-use gap. Before v2.10.10 the fresh stamp only landed on a
// SECOND open of a still-empty DB — so a first process that seeded and then routed/recorded
// anything left a version-0 DB with history, and the next open replayed v1–v9 over a database
// born from the current seed: v7 read the intentional 2026-08-10 pairings as divergence from
// its inlined 2026-08-01 seed and wrote false 'FLAGGED for the operator' changelog entries.
test('a fresh DB used before its second open never replays the ladder — no false flags', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const first = openDb(path);            // process 1: create, seed, and WORK immediately
  seedMatrix(first, 1);
  first.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('mechanical-apply', 2000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  first.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
    VALUES ('2026-08-10','mechanical-apply','gpt-5.3-codex-spark','PROMOTE','first-session',0)`);
  first.close();

  const db = openDb(path);               // process 2: history exists now — ladder must NOT run
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  const apply = db.prepare("SELECT * FROM matrix WHERE task_kind='mechanical-apply'").get() as any;
  assert.equal(apply.gpt_effort, 'xhigh');   // 2026-08-10 seed pairing intact, not v7's 'low'
  assert.equal(apply.updated_at, 1);         // window untouched — the duel stays current
  assert.equal((db.prepare(
    "SELECT consumed FROM outcomes WHERE evidence='first-session'").get() as any).consumed, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM matrix_changelog
    WHERE entry LIKE '%FLAGGED%' OR entry LIKE '%reconciled%'`).get() as any).c, 0);
  db.close();
});

// ——— v2.9.0: tokens never decide ———

// The token tiebreak is deleted (operator, 2026-08-10: quality, then time). Every row already
// judged on that channel holds a winner the surviving rule would not pick, and standings counts
// it for the life of the contest window — so the record is re-decided on the clock, and what the
// clock cannot separate becomes 'unresolved'.
test('v8 re-decides token-tiebreak duels on latency — all four pre-states, with replay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const duel = (winner: string | null, decidedBy: string, aMs: string, gMs: string,
    status = 'judged') => pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map,
      status, winner_vendor, decided_by, anth_tokens, gpt_tokens, anth_latency_ms, gpt_latency_ms)
    VALUES ('implementation', 2000, '[]', '{}', '${status}',
      ${winner === null ? 'NULL' : `'${winner}'`}, '${decidedBy}', 9000, 5000, ${aMs}, ${gMs})`);
  duel('openai', 'tokens', '100', '500');   // cheap-but-slow winner → flips to anthropic
  duel('openai', 'tokens', '900', '400');   // cheap AND fast → openai keeps it, on the clock now
  duel('openai', 'tokens', '300', '300');   // clocks tie → nothing left to decide on
  duel('openai', 'tokens', 'NULL', '400');  // one clock missing → same
  duel('anthropic', 'judges', '100', '900');  // another channel — untouched
  duel('openai', 'latency', '900', '100');    // already on the surviving channel — untouched
  pre.exec('PRAGMA user_version = 7'); // as if written by 2.8.3
  pre.close();

  const db = openDb(path); // v8 runs
  const after = (db.prepare(
    'SELECT status, winner_vendor, decided_by FROM duels ORDER BY id').all() as any[])
    .map(r => ({ ...r }));
  assert.deepEqual(after, [
    { status: 'judged', winner_vendor: 'anthropic', decided_by: 'latency' },
    { status: 'judged', winner_vendor: 'openai', decided_by: 'latency' },
    { status: 'unresolved', winner_vendor: null, decided_by: 'unresolved' },
    { status: 'unresolved', winner_vendor: null, decided_by: 'unresolved' },
    { status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges' },
    { status: 'judged', winner_vendor: 'openai', decided_by: 'latency' },
  ]);
  // no channel the engine can no longer produce survives anywhere in the log
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM duels WHERE decided_by='tokens'").get() as any).c, 0);
  // public surface: v9 re-filed the dead-spelling duels under the canonical kind on the same
  // open, and — duel-163 F2 — pushed the canon window past them: the flip is visible in the
  // RETIRED record, never in the live contest the operator scores.
  const impl = standings(db).find(k => k.kind === 'implementation-misc')!;
  assert.equal(impl.judged, 0);
  assert.equal(impl.retired.length, 1);
  const rec = impl.retired[0];
  assert.equal(rec.judged, 4);      // the unresolved pair leaves the judged count
  assert.equal(rec.anthWins, 2);    // one judged + one re-decided on the clock
  assert.equal(rec.gptWins, 2);
  assert.equal(rec.anthLatencyWins, 1);
  assert.equal(rec.gptLatencyWins, 2);
  // …and the margins the win counts cannot express, across the same migrated rows: the two
  // unresolved rows (clocks tied, one clock missing) are measured nowhere, the judge-decided row
  // nets without growing a margin, and the three clock wins carry their own sizes.
  assert.deepEqual(
    { aSaved: rec.anthLatencySavedMs, gSaved: rec.gptLatencySavedMs,
      aMed: rec.anthLatencyMedianMs, gMed: rec.gptLatencyMedianMs, net: rec.netLatencyMs },
    { aSaved: 400, gSaved: 1_300, aMed: 400, gMed: 650, net: -100 });
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE 'v8 migration re-decided 2 %'").get());
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  const logCount = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  db.close();

  // idempotent replay: a second open re-decides nothing and logs nothing
  const again = openDb(path);
  assert.deepEqual((again.prepare(
    'SELECT status, winner_vendor, decided_by FROM duels ORDER BY id').all() as any[])
    .map(r => ({ ...r })), after);
  const replayedRec = standings(again).find(k => k.kind === 'implementation-misc')!.retired[0];
  assert.deepEqual(
    { aSaved: replayedRec.anthLatencySavedMs, gSaved: replayedRec.gptLatencySavedMs,
      aMed: replayedRec.anthLatencyMedianMs, gMed: replayedRec.gptLatencyMedianMs,
      net: replayedRec.netLatencyMs },
    { aSaved: 400, gSaved: 1_300, aMed: 400, gMed: 650, net: -100 });
  assert.equal(
    (again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logCount);
  again.close();
});

// An install that never resolved a duel on tokens must come through silently — no changelog
// entry claiming a re-decision that did not happen.
test('v8 is silent on an install with no token-decided duels', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('implementation', 2000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 7');
  pre.close();
  const db = openDb(path);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM matrix_changelog WHERE entry LIKE 'v8 %'").get() as any).c, 0);
  // the fixture's dead-spelling duel had no matrix row — v9 re-files it anyway, with an author
  assert.equal((db.prepare(
    "SELECT task_kind FROM duels WHERE created_at=2000").get() as any).task_kind,
  'implementation-misc');
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%v9 migration re-filed%'").get());
  db.close();
});

// v2.9.6 shipped the parent renames seed-only — the duel-87 defect class a third time: on a
// pre-rename DB the old-named row keeps the whole residue history while seedMatrix births a
// fresh `-misc` clone beside it, and the population forks. v9 is the operator's 2026-08-10
// hand repair as a migration. Transition table: v8 pre-state (both fork shapes) → v9 →
// alias reads (v2.10.2, same task_kind field — composed per fix-wave rule 2) → replay.
test('v9 renames the split residue kinds — era spent, history re-filed, composed with the alias, with replay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // shape 1: 'implementation' as a v8 install holds it — old spelling, terra pairing, a
  // verdict, a duel, and unspent evidence
  pre.exec(`UPDATE matrix SET task_kind='implementation', gpt_model='gpt-5.6-terra',
    gpt_effort='high', decided=1, victor_vendor='openai', decided_mode='victory',
    spot_counter=4, updated_at=1000 WHERE task_kind='implementation-misc'`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('implementation', 2000, '[]', '{}', 'judged', 'openai', 'judges')`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
    VALUES ('2026-08-05','implementation','sonnet','FAIL','old-era',0)`);
  // shape 2: 'bulk-mechanical' already forked — the legacy row AND a seed-born misc clone
  // coexist, with a duel under the legacy name
  pre.exec(`INSERT INTO matrix(task_kind, anth_model, anth_effort, anth_lane, gpt_model,
    gpt_effort, provisional, decided, victor_vendor, decided_mode, spot_counter, union_mode,
    updated_at) VALUES ('bulk-mechanical','haiku','low','B','gpt-5.3-codex-spark','low',
    0, 0, NULL, NULL, 2, 0, 900)`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('bulk-mechanical', 3000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 8');
  pre.close();

  const db = openDb(path); // v9 runs
  // shape 1: renamed in place, re-stamped at the 2026-08-10 pairing, fresh window, verdict gone
  assert.equal(db.prepare("SELECT 1 FROM matrix WHERE task_kind='implementation'").get(), undefined);
  const misc = db.prepare(
    "SELECT * FROM matrix WHERE task_kind='implementation-misc'").get() as any;
  assert.equal(misc.anth_model, 'sonnet');
  assert.equal(misc.anth_effort, 'high');
  assert.equal(misc.gpt_model, 'gpt-6-astra'); // v9 stamps sol@high; v17 swaps it to astra
  assert.equal(misc.gpt_effort, 'high');
  assert.equal(misc.provisional, 0);
  assert.equal(misc.decided, 0);
  assert.equal(misc.victor_vendor, null);
  assert.equal(misc.decided_mode, null);
  assert.equal(misc.spot_counter, 0);
  assert.ok(misc.updated_at > 2000); // fresh window — the old era's duel retires from it
  // history re-files under the canonical name; the old era's unspent evidence is spent
  assert.equal((db.prepare(
    "SELECT task_kind FROM duels WHERE created_at=2000").get() as any).task_kind,
  'implementation-misc');
  const oldEra = db.prepare(
    "SELECT task_kind, consumed FROM outcomes WHERE evidence='old-era'").get() as any;
  assert.equal(oldEra.task_kind, 'implementation-misc');
  assert.equal(oldEra.consumed, 1);
  // shape 2: fork resolved — the legacy row drops, the clone keeps the live contest,
  // the legacy duel lands under it
  assert.equal(db.prepare("SELECT 1 FROM matrix WHERE task_kind='bulk-mechanical'").get(), undefined);
  assert.equal((db.prepare(
    "SELECT COUNT(*) c FROM matrix WHERE task_kind='bulk-mechanical-misc'").get() as any).c, 1);
  assert.equal((db.prepare(
    "SELECT task_kind FROM duels WHERE created_at=3000").get() as any).task_kind,
  'bulk-mechanical-misc');
  // duel-163 F2 (both reviewers): the clone's window (900) predates the legacy duel (3000), so
  // without the window guard that dead-pairing duel SCORES in the live contest the operator
  // reads. The guard pushes the window just past the re-filed history — public surface asserted
  // through standings, where current and retired actually separate.
  const bulk = db.prepare(
    "SELECT updated_at FROM matrix WHERE task_kind='bulk-mechanical-misc'").get() as any;
  assert.equal(bulk.updated_at, 3001);
  const st = standings(db).find(k => k.kind === 'bulk-mechanical-misc')!;
  assert.equal(st.judged, 0);                    // nothing in the current contest
  assert.equal(st.retired.length, 1);            // the moved duel retired with its era
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE '%pushed ''bulk-mechanical-misc'' contest window%'`).get());
  // both actions have an author
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE '%v9 migration renamed ''implementation''%'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE '%dropped the legacy ''bulk-mechanical''%'`).get());
  // composed with the v2.10.2 alias: the dead spelling resolves to the renamed row — no fork
  const viaAlias = getRow(db, 'implementation', misc.updated_at + 1);
  assert.equal(viaAlias.task_kind, 'implementation-misc');
  assert.equal(viaAlias.provisional, 0);
  const rows = (db.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c;
  const logs = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  db.close();

  // idempotent replay: a second open moves nothing
  const again = openDb(path);
  assert.equal((again.prepare(
    "SELECT updated_at FROM matrix WHERE task_kind='implementation-misc'").get() as any)
    .updated_at, misc.updated_at);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c, rows);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logs);
  again.close();
});

// duel-163 F3 (both reviewers, closed v2.10.8): one in-flight spot audit under each spelling is
// a LEGAL v8 state — idx_one_inflight_spot keys on the raw slug — and v9's bulk re-file merged
// them under one key: unique-index violation, migration rollback, user_version stuck at 8, and
// openDb returning the live v8 connection meant every open repeated the same deterministic
// failure while the alias kept splitting storage. Transition: v8 dual-audit pre-state → v9 →
// one seat survives (heal order), the rival becomes a paid record → replay.
test('v9 survives an in-flight spot audit under each spelling — demotes one, never wedges', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const now = Date.now();
  // the routed audit under the dead spelling: no landed evidence
  pre.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 60_000);
  // the awaiting audit under the canonical spelling: one landed side — the better seat
  pre.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status,
    anth_output, recorded_at) VALUES ('implementation-misc', ?, 1, '[]', '{}',
    'awaiting_judgment', 'landed report', ?)`).run(now - 30_000, now - 20_000);
  pre.exec('PRAGMA user_version = 8');
  pre.close();

  const db = openDb(path); // v9 must land despite the would-be collision
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  const audits = (db.prepare(`SELECT task_kind, status, spot_check, demoted_audit FROM duels
    ORDER BY id`).all() as any[]).map(r => ({ ...r }));
  // both rows live under the canonical kind; the evidence-bearing awaiting audit kept the seat
  assert.deepEqual(audits, [
    { task_kind: 'implementation-misc', status: 'routed', spot_check: 0, demoted_audit: 1 },
    { task_kind: 'implementation-misc', status: 'awaiting_judgment', spot_check: 1,
      demoted_audit: 0 },
  ]);
  assert.ok(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE '%v9 migration demoted duel(s)%'").get());
  // the gate holds: a second in-flight audit for the merged kind is refused
  assert.throws(() => db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check,
    sides, label_map, status) VALUES ('implementation-misc', 100, 1, '[]', '{}', 'routed')`).run(),
  /UNIQUE/i);
  const logs = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  db.close();

  // idempotent replay: nothing left to demote, nothing re-logged
  const again = openDb(path);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logs);
  assert.equal((again.prepare(`SELECT COUNT(*) c FROM duels
    WHERE spot_check=1 AND status IN ('routed','awaiting_judgment')`).get() as any).c, 1);
  again.close();
});

// v10: the 2026-08-10 seed prescribed deep-review's sol side at 'max' on a claim codex-cli
// 0.147.0 refutes at launch ("Use one of: none, minimal, low, medium, high, xhigh"), so every
// live spawn ran clamped at xhigh. The relabel joins the row to what ran — a data fix, NOT a
// pairing change, so the contest window and unspent evidence must survive it. Transition:
// 2.12.4 state → v10 → replay → reintroduction refused at the one writer.
test('v10 relabels gpt max to xhigh — window kept, evidence unspent, composed with the setVendorModel refusal', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // the 2.12.4-era row: sol@max, mid-contest (window open at 1000, live unspent evidence)
  pre.exec(`UPDATE matrix SET gpt_effort='max', updated_at=1000 WHERE task_kind='deep-review'`);
  // anthropic 'max' is real (Claude-side top effort) — the gpt-scoped relabel must not touch it
  pre.exec(`UPDATE matrix SET anth_effort='max', updated_at=500 WHERE task_kind='debugging'`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
    VALUES ('2026-08-10','deep-review','gpt-6-astra','PASS','tenure-live',0)`);
  // enough history that the migrations actually run (a duel-less DB is stamped current)
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('default', 1786000000000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 9'); // as if written by 2.12.4
  pre.close();

  const db = openDb(path);
  const row = db.prepare("SELECT * FROM matrix WHERE task_kind='deep-review'").get() as any;
  assert.equal(row.gpt_effort, 'xhigh');
  assert.equal(row.updated_at, 1000);   // relabel, not re-pairing: the contest window stays
  const dbg = db.prepare("SELECT * FROM matrix WHERE task_kind='debugging'").get() as any;
  assert.equal(dbg.anth_effort, 'max'); // Claude-side max is legitimate and untouched
  assert.equal(dbg.updated_at, 500);
  assert.equal((db.prepare("SELECT consumed FROM outcomes WHERE task_kind='deep-review'")
    .get() as any).consumed, 0);        // same tenure — nothing spent
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM matrix WHERE gpt_effort='max'").get() as any).c, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM matrix_changelog
    WHERE entry LIKE 'v10 migration relabeled 1 matrix row%'`).get() as any).c, 1);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  const logCount = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  db.close();

  // idempotent replay: a second open finds no max row and logs nothing
  const again = openDb(path);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c,
    logCount);
  // composed with the writer guard: the operator path cannot reintroduce what v10 removed…
  assert.throws(() => setVendorModel(again, 'deep-review', 'openai', 'gpt-6-astra', 'max'),
    /codex-cli rejects/);
  assert.equal((again.prepare(
    "SELECT gpt_effort FROM matrix WHERE task_kind='deep-review'").get() as any)
    .gpt_effort, 'xhigh');
  // …while the anthropic side keeps its real top effort
  setVendorModel(again, 'debugging', 'anthropic', 'fable', 'max');
  assert.equal((again.prepare(
    "SELECT anth_effort FROM matrix WHERE task_kind='debugging'").get() as any)
    .anth_effort, 'max');
  again.close();
});

// duel-207 P1 (both sides): v2.13.3 seeded web-research as a union — seed-only, the duel-87
// class again. Any DB that ever routed the kind holds getRow's provisional default clone,
// which INSERT OR IGNORE can never repair: it kept routing web-research as a sonnet@medium
// judged duel while the seed and SKILL.md said union at opus@high. v11 is the live DB's hand
// repair as a migration. Table-driven over both era clone shapes; the residue (verdict, spot
// progress, unspent evidence) proves the wholesale re-stamp; the replay proves idempotence.
for (const [gpt, gptEffort] of [['gpt-5.6-sol', 'high'], ['gpt-5.6-terra', 'medium']]) {
  test(`v11 reconciles a collided web-research clone (vs ${gpt}@${gptEffort}) — with replay`, () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
    const pre = openDb(path);
    seedMatrix(pre, 1);
    // pre-state: a 2.13.2 install whose controller routed web-research before the seed row
    // existed — getRow's provisional clone of that era's default, carrying contest residue
    pre.exec(`UPDATE matrix SET anth_model='sonnet', anth_effort='medium', gpt_model='${gpt}',
      gpt_effort='${gptEffort}', provisional=1, decided=1, victor_vendor='openai',
      decided_mode='victory', spot_counter=4, union_mode=0, updated_at=1000
      WHERE task_kind='web-research'`);
    pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence) VALUES
      ('2026-08-05','web-research','sonnet','FAIL','logged under the collided pairing')`);
    pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
      decided_by) VALUES ('web-research', 2000, '[]', '{}', 'judged', 'openai', 'judges')`);
    pre.exec('PRAGMA user_version = 10'); // as if written by 2.13.2
    pre.close();

    const db = openDb(path); // v11 runs
    const row = db.prepare("SELECT * FROM matrix WHERE task_kind='web-research'").get() as any;
    assert.equal(row.anth_model, 'opus');
    assert.equal(row.anth_effort, 'high');
    assert.equal(row.anth_lane, 'B');
    assert.equal(row.gpt_model, 'gpt-6-astra'); // v11 stamps sol@high; v17 swaps it to astra
    assert.equal(row.gpt_effort, 'high');
    assert.equal(row.provisional, 0);
    assert.equal(row.union_mode, 1);
    assert.equal(row.decided, 0);
    assert.equal(row.victor_vendor, null);
    assert.equal(row.decided_mode, null);
    assert.equal(row.spot_counter, 0);
    assert.ok(row.updated_at > 2000); // fresh window: the clone-era duel retires from standings
    assert.equal((db.prepare(
      "SELECT consumed FROM outcomes WHERE task_kind='web-research'").get() as any).consumed, 1);
    assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
      WHERE entry LIKE 'v11 migration reconciled %web-research%'`).get());
    assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
    // public surface: the row IS what routeTask trusts, and the seed has nothing left to land
    assert.equal(seedMatrix(db), 0);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c, 14);
    const logCount = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
    const stamp = row.updated_at;
    db.close();

    // idempotent replay: a second open moves nothing
    const again = openDb(path);
    assert.equal((again.prepare(
      "SELECT updated_at FROM matrix WHERE task_kind='web-research'").get() as any)
      .updated_at, stamp);
    assert.equal(
      (again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logCount);
    again.close();
  });
}

// duel-105 doctrine leg: a web-research row whose pairing someone deliberately set (no
// provisional tell, non-clone pairing) is never stamped — flagged, window and state intact.
test('v11 leaves a deliberately re-paired web-research row alone and flags it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.exec(`UPDATE matrix SET anth_model='fable', anth_effort='xhigh', gpt_model='gpt-5.6-terra',
    gpt_effort='xhigh', provisional=0, union_mode=0, updated_at=1000
    WHERE task_kind='web-research'`); // terra: a sol row would be v17's to swap
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('default', 1786000000000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 10');
  pre.close();

  const db = openDb(path);
  const row = db.prepare("SELECT * FROM matrix WHERE task_kind='web-research'").get() as any;
  assert.equal(row.anth_model, 'fable');   // NOT stamped back to opus
  assert.equal(row.union_mode, 0);
  assert.equal(row.updated_at, 1000);      // window untouched
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE '%web-research%FLAGGED%'`).get());
  assert.equal(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE 'v11 migration reconciled%'`).get(), undefined);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  db.close();
});

// The hand-repaired live DB (and every fresh install): the row already holds the operator
// state, so v11 must pass without a word — no re-stamp, no flag, no changelog noise.
test('v11 is silent on a DB already holding the web-research operator state', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1); // the seed IS the operator state…
  // …at v11's era, when the gpt side was sol (v17 swaps it to astra afterwards; that later line
  // is v17's, not v11's — the assertions below exclude it by its own spelling)
  pre.exec("UPDATE matrix SET gpt_model='gpt-5.6-sol' WHERE gpt_model='gpt-6-astra'");
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('default', 1786000000000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  pre.exec('PRAGMA user_version = 10');
  pre.close();

  const db = openDb(path);
  const row = db.prepare("SELECT * FROM matrix WHERE task_kind='web-research'").get() as any;
  assert.equal(row.union_mode, 1);
  assert.equal(row.provisional, 0);   // v11 re-stamped nothing, flagged nothing
  assert.deepEqual(db.prepare(`SELECT entry FROM matrix_changelog
    WHERE entry LIKE '%web-research%' AND entry NOT LIKE '%gpt-6-astra%'`).all(), []);
  assert.equal(db.prepare(
    "SELECT 1 FROM matrix_changelog WHERE entry LIKE 'v11 migration%'").get(), undefined);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  db.close();
});

// duel-163 F1-anthropic (closed v2.10.9): the alias + one-shot v9 had no durable guard against
// the repo's own documented topology — a still-running pre-2.10.2 MCP server whose
// getRow('implementation') auto-creates a provisional clone under the dead slug AFTER v9 ran.
// v9 never re-runs; new-code readers alias past the row; the population forks permanently (the
// duel-87 shape, fourth recurrence). The fold runs at EVERY open. Transition: post-v9 state +
// old-writer fork → reopen → fold → alias surface → replay.
test('every open folds an old-writer dead-slug fork back into the canonical row', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.close();
  const mid = openDb(path); // virgin stamp — user_version 9, migrations exhausted
  assert.equal((mid.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  // the old-code writer: getRow('implementation') auto-creates a provisional default clone and
  // routes a duel plus an outcome under the dead slug
  mid.exec(`INSERT INTO matrix(task_kind, anth_model, anth_effort, anth_lane, gpt_model,
    gpt_effort, provisional, decided, victor_vendor, decided_mode, spot_counter, union_mode,
    updated_at) VALUES ('implementation','sonnet','medium','B','gpt-5.6-sol','high',
    1, 0, NULL, NULL, 0, 0, 5000)`);
  mid.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('implementation', 6000, '[]', '{}', 'judged', 'openai', 'judges')`);
  mid.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed)
    VALUES ('2026-08-10','implementation','gpt-5.6-sol','FAIL','forked-era',0)`);
  // and a zombie: the OTHER dead slug as a non-provisional row with no history at all
  mid.exec(`INSERT INTO matrix(task_kind, anth_model, anth_effort, anth_lane, gpt_model,
    gpt_effort, provisional, decided, victor_vendor, decided_mode, spot_counter, union_mode,
    updated_at) VALUES ('bulk-mechanical','haiku','low','B','gpt-5.3-codex-spark','xhigh',
    0, 0, NULL, NULL, 0, 0, 100)`);
  mid.close();

  const db = openDb(path); // migrate is a no-op at v9 — the FOLD does the work
  // fork folded: clone row gone, history under the canonical name, era spent, window guarded
  assert.equal(db.prepare("SELECT 1 FROM matrix WHERE task_kind='implementation'").get(), undefined);
  assert.equal((db.prepare(
    "SELECT task_kind FROM duels WHERE created_at=6000").get() as any).task_kind,
  'implementation-misc');
  const ev = db.prepare(
    "SELECT task_kind, consumed FROM outcomes WHERE evidence='forked-era'").get() as any;
  assert.equal(ev.task_kind, 'implementation-misc');
  assert.equal(ev.consumed, 1);
  assert.ok((db.prepare(
    "SELECT updated_at FROM matrix WHERE task_kind='implementation-misc'").get() as any)
    .updated_at >= 6001); // the forked duel retires from the live contest
  // zombie dropped
  assert.equal(db.prepare("SELECT 1 FROM matrix WHERE task_kind='bulk-mechanical'").get(), undefined);
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE '%dropped the provisional ''implementation'' clone%'`).get());
  assert.ok(db.prepare(`SELECT 1 FROM matrix_changelog
    WHERE entry LIKE '%dropped the zombie ''bulk-mechanical'' row%'`).get());
  // alias surface: the dead spelling resolves to the canonical row, no fresh fork
  assert.equal(getRow(db, 'implementation', Date.now()).task_kind, 'implementation-misc');
  const logs = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  const rows = (db.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c;
  db.close();

  // idempotent replay: no trace left, the fold's fast path logs and moves nothing
  const again = openDb(path);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logs);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix').get() as any).c, rows);
  again.close();
});

// The fold's other face: a NON-provisional row with history under the dead slug is someone's
// deliberate state — the operator doctrine says flag and move nothing, once, not per open.
test('the fold flags a ratified dead-slug row once and never touches it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  pre.close();
  const mid = openDb(path);
  mid.exec(`INSERT INTO matrix(task_kind, anth_model, anth_effort, anth_lane, gpt_model,
    gpt_effort, provisional, decided, victor_vendor, decided_mode, spot_counter, union_mode,
    updated_at) VALUES ('implementation','opus','high','B','gpt-5.6-sol','xhigh',
    0, 0, NULL, NULL, 0, 0, 5000)`);
  mid.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('implementation', 6000, '[]', '{}', 'judged', 'anthropic', 'judges')`);
  mid.close();

  const db = openDb(path);
  const row = db.prepare("SELECT * FROM matrix WHERE task_kind='implementation'").get() as any;
  assert.equal(row.anth_model, 'opus');       // untouched
  assert.equal((db.prepare(
    "SELECT task_kind FROM duels WHERE created_at=6000").get() as any).task_kind,
  'implementation');                          // history stays with the flagged row
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM matrix_changelog
    WHERE entry LIKE '%dead-slug fold%non-provisional%FLAGGED%'`).get() as any).c, 1);
  db.close();
  const again = openDb(path);                 // the flag is not re-logged per open
  assert.equal((again.prepare(`SELECT COUNT(*) c FROM matrix_changelog
    WHERE entry LIKE '%dead-slug fold%non-provisional%FLAGGED%'`).get() as any).c, 1);
  again.close();
});

// SQLite's double-quoted compatibility form is valid single-column DDL; the scanner blanked
// only single quotes, so the comma stayed in the residue and a valid future migration became
// a startup outage at every entry point (duel-70, found by BOTH sides).
test('ensureColumn accepts double-quoted defaults — and stray double quotes stay fatal', () => {
  const db = openDb(':memory:');
  ensureColumn(db, 'duels', 'extra_h TEXT DEFAULT "a,b"');
  ensureColumn(db, 'duels', 'extra_i TEXT DEFAULT "a--b"');
  const cols = (db.prepare("SELECT name FROM pragma_table_info('duels')").all() as any[])
    .map(r => r.name);
  for (const c of ['extra_h', 'extra_i']) assert.ok(cols.includes(c), c);
  assert.throws(() => ensureColumn(db, 'duels', 'x TEXT DEFAULT "a'), /invalid column/i);
  assert.throws(
    () => ensureColumn(db, 'duels', 'x TEXT DEFAULT "a"; DROP TABLE duels; --"'),
    /invalid column/i);
});

// The validator still THREW from inside openDb — the exact failure mode the scan rewrite was
// for (duel-70 anth F9). But "a skipped column is a bug for CI to find, not data loss" was
// only true when the column was already there: every column ensured at open is load-bearing
// in the same openDb — a skipped outcomes.consumed left migrate() throwing into a catch that
// blames a lock, and a skipped duels column surfaced as 'no such column' AFTER attestation,
// inside the write transaction (duel-71 anth F4). fatal:false is a proof of harmlessness, not
// a promise of availability: the skip must VERIFY the column exists before standing aside.
test('a validation failure is non-fatal only when the column already exists', () => {
  const db = openDb(':memory:');
  db.exec('ALTER TABLE duels ADD COLUMN extra_j INTEGER');
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { seen.push(a.join(' ')); };
  try {
    ensureColumn(db, 'duels', 'extra_j INTEGER; DROP TABLE duels', { fatal: false });
  } finally { console.error = orig; }
  assert.equal(seen.length, 1); // loud, and provably harmless — the column is present
  // a column the DB does NOT hold cannot be skipped into existence
  assert.throws(
    () => ensureColumn(db, 'duels', 'zzz INTEGER; DROP TABLE duels', { fatal: false }),
    /invalid column/i);
  const cols = (db.prepare("SELECT name FROM pragma_table_info('duels')").all() as any[])
    .map(r => r.name);
  assert.ok(!cols.includes('zzz'), 'the invalid column is never added');
  // a real storage error is not a validation bug — it throws regardless
  assert.throws(() => ensureColumn(db, 'nonexistent', 'x INTEGER', { fatal: false }),
    /no such table/);
});

// Three ledgers carried "the racing-writer half of the one-txn heal is unpinnable — sync
// node:sqlite cannot interleave in-process". The premise was wrong AND the first pin built on
// the correction never entered the heal: it raced the test's OWN transaction on a healthy DB,
// so a deferred-txn (or no-txn) mutant of the heal stayed green (duel-73, both sides — 4th
// ledger carrying this). This one drives the REAL heal: blocking duplicate audits force
// openDb through it, and the reentry hook fires inside the transaction before its first
// write, where only BEGIN IMMEDIATE already holds the lock.
test('a racing writer cannot insert while the heal transaction holds the write lock', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-race-')), 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  // a fresh duplicate pair blocks both index creates and forces the next open through the heal
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation', ?, 1, '[]', '{}', 'routed')`).run(now - 30_000);
  db.close();
  let raced = false;
  // Judged AFTER openDb returns: an assertion thrown INSIDE the hook is caught by openDb's
  // own heal handler and only escaped when the rival's successful insert happened to break
  // the fallback create too — the pin held conditionally (duel-74 opus rider on a13aee8).
  let rivalErr: string | null = null;
  const healed = openDb(path, { onHealTxnBegin: () => {
    raced = true;
    const rival = new DatabaseSync(path);
    rival.exec('PRAGMA busy_timeout=0');
    // the real hazard insert: a same-kind in-flight spot audit, inside the gate's predicate
    try {
      rival.prepare(`INSERT INTO duels(task_kind, created_at, spot_check,
        sides, label_map, status) VALUES ('implementation', 99, 1, '[]', '{}', 'routed')`).run();
    } catch (e) { rivalErr = (e as Error).message; }
    rival.close();
  } });
  assert.ok(raced, 'the open never entered the heal');
  assert.match(rivalErr ?? '(the rival insert SUCCEEDED)', /locked|busy/i,
    'the racing writer was not blocked by the heal transaction');
  // and the heal finished its job: full gate installed, a second in-flight audit refused
  // (v9 re-filed the surviving audit under the canonical kind on the same open)
  const idx = healed.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type='index' AND name='idx_one_inflight_spot'`).get() as any;
  assert.equal(idx.n, 1);
  assert.throws(() => healed.prepare(`INSERT INTO duels(task_kind, created_at, spot_check,
    sides, label_map, status) VALUES ('implementation-misc', 100, 1, '[]', '{}', 'routed')`).run(),
    /UNIQUE/i);
  healed.close();
});

// v2.13.28: letter-grade columns are additive and nullable — a legacy vote reads back NULL
// (no grades were given), never a synthesized grade.
test('grade columns land on a pre-2.13.28 judgments table and replay idempotently', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const duelId = Number(pre.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map,
    status) VALUES ('implementation-misc', 123, '[]', '{}', 'awaiting_judgment')`)
    .run().lastInsertRowid);
  pre.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at)
    VALUES (?, 'anthropic', 'X', 456)`).run(duelId);
  for (const column of ['grade_x', 'grade_y']) {
    if (tableColumns(pre, 'judgments').includes(column)) {
      pre.exec(`ALTER TABLE judgments DROP COLUMN ${column}`);
    }
  }
  pre.close();
  const db = openDb(path);
  const row: any = db.prepare('SELECT grade_x, grade_y FROM judgments WHERE duel_id=?')
    .get(duelId);
  assert.deepEqual({ ...row }, { grade_x: null, grade_y: null });
  db.close();
  const replay = openDb(path);
  assert.equal(tableColumns(replay, 'judgments').filter(c => c === 'grade_x').length, 1);
  replay.close();
});

test('serena-call columns land on pre-2.13.82 duels and judgments tables as NULL and replay idempotently', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const duelId = Number(pre.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map,
    status) VALUES ('implementation-misc', 123, '[]', '{}', 'awaiting_judgment')`)
    .run().lastInsertRowid);
  pre.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at)
    VALUES (?, 'anthropic', 'X', 456)`).run(duelId);
  for (const [table, columns] of [
    ['duels', ['anth_serena_calls', 'gpt_serena_calls']],
    ['judgments', ['judge_serena_calls']],
  ] as const) {
    const present = tableColumns(pre, table);
    for (const column of columns) {
      if (present.includes(column)) pre.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  pre.close();

  const db = openDb(path);
  const duel: any = db.prepare(
    'SELECT anth_serena_calls, gpt_serena_calls FROM duels WHERE id=?').get(duelId);
  assert.deepEqual({ ...duel }, { anth_serena_calls: null, gpt_serena_calls: null });
  const judgment: any = db.prepare(
    'SELECT judge_serena_calls FROM judgments WHERE duel_id=?').get(duelId);
  assert.deepEqual({ ...judgment }, { judge_serena_calls: null });
  db.close();

  const replay = openDb(path);
  for (const column of ['anth_serena_calls', 'gpt_serena_calls']) {
    assert.equal(tableColumns(replay, 'duels').filter(c => c === column).length, 1);
  }
  assert.equal(
    tableColumns(replay, 'judgments').filter(c => c === 'judge_serena_calls').length, 1);
  replay.close();
});

test('the path column lands on a pre-2.13.29 judgments table as NULL', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  const duelId = Number(pre.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map,
    status) VALUES ('implementation-misc', 123, '[]', '{}', 'awaiting_judgment')`)
    .run().lastInsertRowid);
  pre.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at)
    VALUES (?, 'anthropic', 'X', 456)`).run(duelId);
  if (tableColumns(pre, 'judgments').includes('path')) {
    pre.exec('ALTER TABLE judgments DROP COLUMN path');
  }
  pre.close();
  const db = openDb(path);
  const row: any = db.prepare('SELECT path FROM judgments WHERE duel_id=?').get(duelId);
  assert.deepEqual({ ...row }, { path: null });
  db.close();
});

// 2026-09-05 (operator): GPT-6-Astra replaces gpt-5.6-sol on every row. Transition over the row
// shapes a v16 install holds — a decided sol row with live evidence, sol rows at each effort, a
// spark row, a terra re-pair, a contestless row — then replay, then the public surface.
test('v17 swaps every sol row to astra at its own effort — window reset, sol evidence spent, other rows untouched, with replay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-db-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre, 1);
  // the v16 install: every non-spark, non-terra row carries sol (that era's seed)
  pre.exec("UPDATE matrix SET gpt_model='gpt-5.6-sol' WHERE gpt_model='gpt-6-astra'");
  // a decided sol row with spot progress and live evidence on both sides
  pre.exec(`UPDATE matrix SET decided=1, victor_vendor='openai', decided_mode='victory',
    spot_counter=3, updated_at=1000 WHERE task_kind='debugging'`);
  pre.exec(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, consumed) VALUES
    ('2026-09-01','debugging','gpt-5.6-sol','FAIL','sol-tenure',0),
    ('2026-09-01','debugging','fable','FAIL','anth-tenure',0),
    ('2026-09-01','default','gpt-5.6-sol','PROMOTE','sol-tenure-2',0)`);
  // an operator re-pair to terra and a contestless row: neither is a sol row
  pre.exec(`UPDATE matrix SET gpt_model='gpt-5.6-terra', gpt_effort='xhigh', updated_at=1500
    WHERE task_kind='implementation-misc'`);
  pre.exec(`UPDATE matrix SET gpt_model=NULL, gpt_effort=NULL, updated_at=1600
    WHERE task_kind='long-context'`);
  pre.exec(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, winner_vendor,
    decided_by) VALUES ('debugging', 2000, '[]', '{}', 'judged', 'openai', 'judges')`);
  pre.exec('PRAGMA user_version = 16');
  pre.close();

  const db = openDb(path); // v17 runs
  const row = (k: string): any => db.prepare('SELECT * FROM matrix WHERE task_kind=?').get(k);
  for (const [kind, effort] of [['debugging', 'xhigh'], ['default', 'high'],
    ['web-research', 'high'], ['second-opinion', 'xhigh'], ['deep-review', 'xhigh']]) {
    assert.equal(row(kind).gpt_model, 'gpt-6-astra', kind);
    assert.equal(row(kind).gpt_effort, effort, kind); // sol's effort is astra's
  }
  const dbg = row('debugging');
  assert.equal(dbg.decided, 0);                   // a never-contested pairing has no victor
  assert.equal(dbg.victor_vendor, null);
  assert.equal(dbg.decided_mode, null);
  assert.equal(dbg.spot_counter, 0);
  assert.ok(dbg.updated_at > 2000);               // the sol-era duel retires from the window
  assert.equal(row('deep-review').union_mode, 1); // union survives the swap
  assert.equal((db.prepare("SELECT COUNT(*) c FROM matrix WHERE gpt_model='gpt-5.6-sol'")
    .get() as any).c, 0);
  // sol's evidence dies with its tenure on every row; the anthropic side's does not
  const consumed = (ev: string): number => (db.prepare(
    'SELECT consumed FROM outcomes WHERE evidence=?').get(ev) as any).consumed;
  assert.equal(consumed('sol-tenure'), 1);
  assert.equal(consumed('sol-tenure-2'), 1);
  assert.equal(consumed('anth-tenure'), 0);
  // not sol rows: untouched, windows kept
  assert.equal(row('implementation-misc').gpt_model, 'gpt-5.6-terra');
  assert.equal(row('implementation-misc').updated_at, 1500);
  assert.equal(row('long-context').gpt_model, null);
  assert.equal(row('long-context').updated_at, 1600);
  assert.equal(row('transcription').gpt_model, 'gpt-5.3-codex-spark');
  assert.equal(row('transcription').gpt_effort, 'xhigh');
  // every swap has an author, one line per row
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM matrix_changelog
    WHERE entry LIKE '%gpt-5.6-sol@% → gpt-6-astra@%'`).get() as any).c,
  (db.prepare("SELECT COUNT(*) c FROM matrix WHERE gpt_model='gpt-6-astra'").get() as any).c);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, CURRENT_USER_VERSION);
  // public surface: standings reads the new contestant over an empty current contest
  const st = standings(db).find(k => k.kind === 'debugging')!;
  assert.equal(st.gptModel, 'gpt-6-astra');
  assert.equal(st.judged, 0);
  assert.equal(st.retired.length, 1);
  const logCount = (db.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c;
  const stamp = dbg.updated_at;
  db.close();

  // idempotent replay: nothing left to swap, nothing logged, window unmoved
  const again = openDb(path);
  assert.equal((again.prepare("SELECT updated_at FROM matrix WHERE task_kind='debugging'")
    .get() as any).updated_at, stamp);
  assert.equal((again.prepare('SELECT COUNT(*) c FROM matrix_changelog').get() as any).c, logCount);
  again.close();
});
