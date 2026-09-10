import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './paths.js';
import { expireStaleDuels, landedOf, sessionIdOf } from './duel.js';
import { KIND_ALIASES } from './matrix.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id INTEGER PRIMARY KEY,
  lane TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_lane ON quota_snapshots(lane, fetched_at DESC);
CREATE TABLE IF NOT EXISTS matrix (
  task_kind TEXT PRIMARY KEY,
  anth_model TEXT NOT NULL,
  anth_effort TEXT,
  anth_lane TEXT NOT NULL,
  gpt_model TEXT,
  gpt_effort TEXT,
  overflow_eligible INTEGER NOT NULL DEFAULT 1,
  provisional INTEGER NOT NULL DEFAULT 0,
  decided INTEGER NOT NULL DEFAULT 0,
  victor_vendor TEXT,
  decided_mode TEXT,
  spot_counter INTEGER NOT NULL DEFAULT 0,
  union_mode INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS duels (
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
  anth_serena_calls INTEGER, gpt_serena_calls INTEGER,
  anth_env TEXT, gpt_env TEXT,
  anth_gate TEXT, gpt_gate TEXT,
  anth_gate_detail TEXT, gpt_gate_detail TEXT,
  winner_vendor TEXT,
  decided_by TEXT,
  recorded_at INTEGER,
  outputs_at INTEGER,
  demoted_audit INTEGER NOT NULL DEFAULT 0,
  abandoned_at INTEGER,
  superseded_by INTEGER,
  death_recorded INTEGER NOT NULL DEFAULT 0,
  minted_by_version TEXT, recorded_by_version TEXT
);
CREATE TABLE IF NOT EXISTS judgments (
  id INTEGER PRIMARY KEY,
  duel_id INTEGER NOT NULL REFERENCES duels(id),
  judge_vendor TEXT NOT NULL,
  verdict TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  proof TEXT,
  rationale TEXT,
  judge_model_attested TEXT,
  judge_effort_attested TEXT,
  judge_serena_calls INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_judgment_vendor ON judgments(duel_id, judge_vendor);
-- One namespace for every proof-of-run ever spent: duel sides AND judge votes. The PRIMARY KEY
-- is the uniqueness guarantee — a SELECT-then-INSERT could not see a concurrent MCP process's
-- claim, and per-column indexes on duels would miss a side proof re-spent as a judge proof.
CREATE TABLE IF NOT EXISTS proof_claims (
  proof TEXT PRIMARY KEY,
  duel_id INTEGER NOT NULL,
  slot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- v2.13.23 / migration v16: one durable owner for every duel included by a session report.
-- The PRIMARY KEY arbitrates racing reporters; the losing session reads this row and excludes
-- the duel from every report tally and section. Sessionless windows never write here.
CREATE TABLE IF NOT EXISTS report_claims (
  duel_id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  role TEXT,
  consumed INTEGER NOT NULL DEFAULT 0,
  integrity INTEGER
);
CREATE TABLE IF NOT EXISTS matrix_changelog (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  entry TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// Engine-wide operator switches (e.g. auto_decide). A table, not a matrix column: these govern
// the whole engine, not one kind. SCHEMA runs on every open, so pre-existing DBs grow the
// table the first time this version touches them — additive, no user_version bump.
export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
  return row?.value ?? null;
}

export function setSetting(
  db: DatabaseSync, key: string, value: string, now: number = Date.now(),
): void {
  db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, value, now);
}

// Column adds are additive migrations re-run on every open, so "duplicate column" is the ONE
// failure this may absorb. The blind catch absorbed everything — a BUSY under a concurrent
// writer, a read-only open, a missing table — and returned a connection whose schema cannot
// execute the current version's writes: the next recordResults died on
// 'no such column: outputs_at' with no hint why (duel-65 sol S8). Trust the schema, not the
// error text: after a failed ALTER the column must actually be there, or the failure was real.
export function ensureColumn(db: DatabaseSync, table: string, columnDdl: string,
  opts: { fatal?: boolean } = {}): void {
  // Exported helper, table interpolated into SQL: validate at the boundary. Callers are all
  // literals today, but an identifier check costs one regex (duel-66 opus M10).
  // columnDdl is the parameter that actually carries free text — same boundary, BOTH
  // interpolations (duel-67 opus F6). Reject what is DANGEROUS (a `;` closing the statement,
  // a top-level `,` smuggling a second column, comment markers), not what is unusual: the
  // duel-67 charset threw on DEFAULT -1 / CHECK (x <> ''), and the duel-68 flat token scan
  // still threw on NUMERIC(10,2), DEFAULT 'a,b' and comment markers inside quoted data —
  // inside openDb, where the failure mode is "no entry point starts" (duel-68 opus F7;
  // duel-69 opus F5 / sol M5). Blank string literals first — BOTH quote forms: SQLite accepts
  // the double-quoted compatibility spelling in a column definition, and blanking only '…'
  // left a valid DEFAULT "a,b" fatally comma'd (duel-70, found by BOTH sides) — then judge
  // the residue: comment markers and `;` are fatal anywhere outside a literal, `,` only at
  // paren depth 0, and a stray quote of either kind or an unbalanced paren means the literal
  // scan itself cannot be trusted. Bracketed/backticked identifiers stay unmodelled: their
  // contents land in the residue, where the dangerous tokens are still fatal — fails closed.
  let verr: string | null = null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    verr = `ensureColumn: invalid table name "${table}"`;
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*(\s|$)/.test(columnDdl)) {
    verr = `ensureColumn: invalid column DDL "${columnDdl}"`;
  } else {
    const residue = columnDdl.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
    let depth = 0;
    let bad = /;|--|\/\*/.test(residue)
      || residue.replace(/''/g, '').includes("'")
      || residue.replace(/""/g, '').includes('"');
    for (const ch of residue) {
      if (ch === '(') depth++;
      else if (ch === ')') { if (--depth < 0) bad = true; }
      else if (ch === ',' && depth === 0) bad = true;
    }
    if (bad || depth !== 0) verr = `ensureColumn: invalid column DDL "${columnDdl}"`;
  }
  if (verr) {
    // A validator false-rejection must never be a startup outage (duel-70 anth F9) — but
    // "a skipped column is a bug for CI to find, not data loss" held only when the column was
    // already there: every column ensured at open is load-bearing in this same open, so a
    // genuinely missing one surfaced later as a migrate() stuck blaming a lock, or as
    // 'no such column' after attestation inside the write transaction (duel-71 anth F4).
    // fatal:false is a proof of HARMLESSNESS, not a promise of availability: the skip
    // verifies the column exists. Every install that ever ran a version whose validator
    // accepted the DDL skips clean. A column INTRODUCED by release N is absent on every
    // install upgrading to N — fresh and long-lived alike — so a validator bug in a new DDL
    // is a startup failure on every install of that release, not a CI-only signal. That is
    // the trade duel-71 anth F4 accepted: a diagnosable outage at open beats a load-bearing
    // column missing under a write transaction (duel-73 opus F4).
    if (opts.fatal === false) {
      const col = columnDdl.split(/\s+/, 1)[0];
      let has: unknown = null;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) {
        try { has = db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col); }
        catch { has = null; }
      }
      if (has) {
        console.error(`[model-routing] ${verr} — column skipped (already present)`);
        return;
      }
    }
    throw new Error(verr);
  }
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`); }
  catch (e) {
    const col = columnDdl.split(/\s+/, 1)[0];
    // The probe re-enters SQLite and can fail on the same lock/IO condition that failed the
    // ALTER — its error must not replace the real one (duel-66 opus M10; same shape as the
    // guarded ROLLBACKs in duel.ts).
    let has: unknown;
    try { has = db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col); }
    catch { throw e; }
    if (!has) throw e;
  }
}

export function openDb(path: string = DB_PATH,
  hooks?: { onHealTxnBegin?: () => void }): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  // ONE landed predicate for both languages: SQL's one-arg TRIM strips spaces only, so a side
  // stored '\n' was landed to a query and blank to landedOf — pendingDuels advertised it
  // reJudgeable, two single-use judge runs were burned, recordJudgment refused both
  // (duel-65 opus F4 / sol S9). Every connection comes through here, so every query can use it.
  db.function('landed', { deterministic: true }, (o: unknown) => (landedOf(o) ? 1 : 0));
  db.exec(SCHEMA);
  // additive migration for pre-2.2 DBs
  // fatal:false on every open-time call: a validator bug must cost a missing column and a
  // loud line, never every entry point (duel-70 anth F9).
  ensureColumn(db, 'matrix', 'decided_mode TEXT', { fatal: false });
  // additive migration for pre-2.3 DBs (proof-of-run columns)
  ensureColumn(db, 'duels', 'anth_proof TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'gpt_proof TEXT', { fatal: false });
  // additive migration for pre-2.4 DBs: judge attestation + spark shadow/canonical role
  ensureColumn(db, 'judgments', 'proof TEXT', { fatal: false });
  ensureColumn(db, 'outcomes', 'role TEXT', { fatal: false });
  ensureColumn(db, 'outcomes', 'consumed INTEGER NOT NULL DEFAULT 0', { fatal: false });
  // additive migration for pre-2.6 DBs: union mode. Stamped on the duel row as well as the
  // matrix row so a duel stays readable as what it was routed as, even after the kind's mode
  // changes later.
  ensureColumn(db, 'matrix', 'union_mode INTEGER NOT NULL DEFAULT 0', { fatal: false });
  ensureColumn(db, 'duels', 'union_mode INTEGER NOT NULL DEFAULT 0', { fatal: false });
  // additive migration for pre-2.6.4 DBs: the judging window's own clock. NULL on legacy rows —
  // the sweep falls back to created_at for those, which is exactly the old behavior.
  ensureColumn(db, 'duels', 'recorded_at INTEGER', { fatal: false });
  // additive migration for pre-2.6.7 DBs: the judge window's own IMMUTABLE clock. recorded_at
  // moves on every re-record (the sweep needs it to), so reviving an abandoned duel pushed the
  // judge window past runs that completed before the sweep (duel-64 opus #3). NULL on legacy
  // rows — the judge window falls back to recorded_at, then created_at.
  ensureColumn(db, 'duels', 'outputs_at INTEGER', { fatal: false });
  // additive migrations for pre-2.6.8 DBs. demoted_audit: a revived audit demoted to a plain
  // record is still a PAID audit — spot_check=0 satisfies the in-flight index, this keeps the
  // reopen scan able to count its verdict (duel-65 opus F5 / sol S7). abandoned_at: the sweep's
  // death stamp, the clock the dead-audit backoff runs from (duel-65 opus F3 / sol S5); NULL on
  // rows abandoned before it existed — those fall back to created_at, the old behavior.
  // DOCUMENTED RESIDUAL (duel-66 sol F4): an audit v2.6.7 itself demoted left no marker at all
  // (it only cleared spot_check), so no data migration can find those rows to backfill
  // demoted_audit=1 — their verdicts stay invisible to the reopen scan. Unrecoverable by
  // construction; the live DB was verified to hold zero demoted rows at the 2.6.8 migration,
  // so the exposure window here is any OTHER install that ran 2.6.7's demotion path.
  ensureColumn(db, 'duels', 'demoted_audit INTEGER NOT NULL DEFAULT 0', { fatal: false });
  ensureColumn(db, 'duels', 'abandoned_at INTEGER', { fatal: false });
  // additive migration for pre-2.6.12 DBs: which recording expired this sitter. The expiry is
  // terminal and the sweep can never name it afterwards, so the ids must be durably queryable —
  // the lost-response replay rebuilds its `superseded` return from this column (duel-69 sol M3).
  ensureColumn(db, 'duels', 'superseded_by INTEGER', { fatal: false });
  // additive migration for pre-2.6.14 DBs: the dead-replay marker. Two column-derived proxies
  // for "this death was already recorded" died in successive waves — `recorded_at != null`
  // (duel-70 anth F2) and then clock equality, which the v6 migration manufactured on exactly
  // the legacy rows it backfilled (duel-71 F1, found by BOTH sides). Only a death RECORD sets
  // this; the sweep never touches it, no migration synthesizes it, revival clears it. Default
  // 0 on legacy rows is the safe direction: a genuinely recorded death re-stamps once on its
  // next replay (bounded), where a manufactured 1 would hide the row forever.
  ensureColumn(db, 'duels', 'death_recorded INTEGER NOT NULL DEFAULT 0', { fatal: false });
  // Which VOCABULARY a vote was written in. Old 'X' meant "X is the better solution"; since
  // v2.11.0 it means "X is the only side that meets the bar" — the same string, a different
  // question, and no timestamp can separate them reliably across a mid-flight upgrade. Additive
  // and default 0, so every pre-existing row is correctly marked legacy without a backfill.
  ensureColumn(db, 'judgments', 'graded INTEGER NOT NULL DEFAULT 0', { fatal: false });
  // additive migration for pre-2.13 DBs: session-report detail. rationale = the judge's own
  // written reason, verbatim, blind X/Y terms; *_env = each side's environment note (the
  // unseen advantages: tools, MCP, network, sandbox, retries). All nullable — a legacy row
  // reads back NULL and the report prints an honest gap marker, never invented detail.
  ensureColumn(db, 'judgments', 'rationale TEXT', { fatal: false });
  // v2.13.28: the judge's letter grade per blind side (A+..F, scoring.GRADE_POINTS). Additive
  // and nullable — a legacy vote gave no grades and reads back NULL, which every GPA consumer
  // skips; nothing is ever backfilled.
  ensureColumn(db, 'judgments', 'grade_x TEXT', { fatal: false });
  ensureColumn(db, 'judgments', 'grade_y TEXT', { fatal: false });
  // v2.13.29: the judge's path recommendation ('X'|'Y'|'merge'). Nullable — a legacy vote
  // recommended nothing, and one recommendation alone never changes resolution.
  ensureColumn(db, 'judgments', 'path TEXT', { fatal: false });
  // v2.13.44: the judge's brief-defect flag — the quoted requirement text this vote found
  // ambiguous enough that the sides plausibly split along its readings. Observational, never
  // consulted by resolution: it makes contested-by-ambiguity distinguishable from
  // contested-by-quality in the ledger, and two votes quoting the same clause is a ready
  // lint corpus (duels 283/289: two of three contested rows traced to brief text, found
  // only by manual archaeology).
  ensureColumn(db, 'judgments', 'brief_defect TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'anth_env TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'gpt_env TEXT', { fatal: false });
  // v2.13.14: the deterministic build/test result per side. resolveVerdict has CONSUMED these
  // since v2.11.0, where the plan said the columns and the record_duel field "land in the next
  // commit"; they did not, so `a failed gate overrides any judge vote` was documented in SKILL
  // and in the resolver while gateOf() could only ever read undefined. NULL stays the honest
  // legacy value and means "not applicable", never a failure — every read-only kind and every
  // row recorded before this migration reads back NULL and the gate branch cannot fire.
  ensureColumn(db, 'duels', 'anth_gate TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'gpt_gate TEXT', { fatal: false });
  // v2.13.50: the gate's receipts — commands run + pass/fail counts. NULL is the honest legacy
  // value (rows recorded before the receipts requirement, and every gateless side); recordResults
  // refuses a NEW gate token without them (duel 298: 'pass' recorded over a tree that failed its
  // repo's own suite, and the bare token hid what the gate had covered).
  ensureColumn(db, 'duels', 'anth_gate_detail TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'gpt_gate_detail TEXT', { fatal: false });
  // v2.13.20 / migration v14: the model and effort stated by the proof artifact itself. NULL
  // is intentionally honest for legacy rows, lane A, synthetic artifacts and parse gaps.
  // These stay additive and nullable so an already-running v13 process can keep using its
  // named-column INSERTs after a peer upgrades the shared file.
  ensureColumn(db, 'duels', 'anth_model_attested TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'anth_effort_attested TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'gpt_model_attested TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'gpt_effort_attested TEXT', { fatal: false });
  ensureColumn(db, 'judgments', 'judge_model_attested TEXT', { fatal: false });
  ensureColumn(db, 'judgments', 'judge_effort_attested TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'anth_serena_calls INTEGER', { fatal: false });
  ensureColumn(db, 'duels', 'gpt_serena_calls INTEGER', { fatal: false });
  ensureColumn(db, 'judgments', 'judge_serena_calls INTEGER', { fatal: false });
  // v2.13.21 / migration v15: WHICH BUILD touched this row. A long-lived MCP server keeps
  // serving the dist/ it started with — a pre-2.13.2 one minted the float latencies the v12
  // migration had to repair — and "version" was a proxy for deployed behavior that no row ever
  // recorded. minted_by_version is written at the INSERT, recorded_by_version by the FIRST
  // recording; skew between them, or against the running server, is the stale-server signal.
  // NULL is pre-v15, never a failure, and both stay additive so a running v14 process can keep
  // using its named-column INSERTs after a peer upgrades the shared file.
  ensureColumn(db, 'duels', 'minted_by_version TEXT', { fatal: false });
  ensureColumn(db, 'duels', 'recorded_by_version TEXT', { fatal: false });
  // v2.13.64 / duel 391 M3: record_outcome's integrity flag was acted on in the reply and
  // dropped from the row. 1 = proven falsification, 0 = quality miss, NULL = recorded before
  // the column existed (unknown, never "not integrity").
  ensureColumn(db, 'outcomes', 'integrity INTEGER', { fatal: false });
  // One IN-FLIGHT spot audit per kind, enforced where the race actually is: two processes can
  // both pass the router's pendingSpotDuel SELECT before either inserts (duel-63 sol#4) — and
  // the 2.6.6 'routed'-only predicate still let a raced route insert a second audit while the
  // first sat in awaiting_judgment (duel-64 sol#2). Revival is never blocked: recordResults
  // demotes a revived audit to a plain record when a new audit is already in flight. Failure
  // to create is LOUD: the router treats this index as the real gate, and the silent catch
  // conflated "duplicates present" with BUSY and read-only opens (duel-64 opus #8).
  // CREATE first, DROP the narrower 2.6.6 index only after the create lands: dropping first
  // left the DB with no gate at all whenever the create failed — and it fails on exactly the
  // state the old index called legal, one routed + one awaiting_judgment audit of one kind
  // (duel-65 opus F1 / sol S6). While the new index is blocked, the old gate keeps guarding
  // the routed half and the next open retries.
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_inflight_spot ON duels(task_kind) " +
      "WHERE spot_check=1 AND status IN ('routed','awaiting_judgment')");
    try { db.exec('DROP INDEX IF EXISTS idx_one_routed_spot'); } catch { /* read-only */ }
  } catch (e) {
    // "Old gate kept if present" was doing load-bearing work in that sentence: a DB that
    // opened under 2.6.7 in the blocking state had already dropped the old gate and then
    // failed this create, so it sat with NO index at all — and the create kept failing on
    // the same rows, forever (duel-66 sol F1 / opus M7). The blocking state is DATA, and the
    // engine already owns both remedies (duel-67 opus F8 / sol F1): TTL-dead in-flight audits
    // are exactly what the sweep abandons, and a fresh duplicate is exactly what recordResults
    // demotes — the row with EVIDENCE keeps the audit identity, the rest become plain PAID
    // records (demoted_audit=1, the reopen scan still counts them). Evidence means landed(),
    // COUNTED, not conjoined: the duel-68 spelling ranked landed-AND-landed, so a row holding
    // ONE real output scored 0 — exactly like a fully blank row — and lost the seat to a newer
    // blank duplicate on the id tiebreak, recreating the harm one evidence-level down
    // (duel-69 opus F4 / sol F1, found by both reviewers). Two landed sides, then one, then
    // none; awaiting over routed, then newest, below it.
    // Normalize, retry once; the routed-only fallback gate is reserved for real storage errors
    // (BUSY, read-only), no longer a permanent parking spot.
    let gate: string;
    // The sweep's RETURNING ids exist because a silent sweep was itself a defect (C3), and
    // this sweep is unconditioned on kind — it can take an unrelated TTL-dead duel along with
    // the blocking pair, and the CLI's own sweep afterwards then returns [] (duel-68 opus F3).
    // The demotion is named for the same reason: it strips an audit of its identity,
    // permanently, on a read-intent open (duel-69 opus F10). Name both on the one surface
    // this path has.
    let swept: number[] = [];
    let demoted: number[] = [];
    // A failed heal used to be swallowed whole — stderr carried only the original index-create
    // error, and the exception saying WHY normalization failed was gone (duel-69 sol M6).
    let healErr: string | null = null;
    try {
      // ONE transaction, normalize through create: as three autocommit statements, a racing
      // route could insert a fresh audit between the demotion and the CREATE — the retry
      // failed again and parked on the routed-only fallback with the awaiting half unguarded
      // forever (duel-68 sol F2). BEGIN IMMEDIATE makes the concurrent writer wait out the
      // heal, and a mid-heal failure rolls the sweep back too, instead of committing its
      // collateral without the gate it was taken for.
      db.exec('BEGIN IMMEDIATE');
      try {
        // Test-only reentry point: sync node:sqlite gives a same-thread test no other moment
        // INSIDE this transaction to race a second connection against the lock. It fires
        // before the first write, where only BEGIN IMMEDIATE already holds the lock — so a
        // deferred-txn mutant is distinguishable (duel-73, both sides).
        hooks?.onHealTxnBegin?.();
        swept = expireStaleDuels(db);
        demoted = (db.prepare(`UPDATE duels SET spot_check=0, demoted_audit=1
          WHERE spot_check=1 AND status IN ('routed','awaiting_judgment')
            AND EXISTS (SELECT 1 FROM duels d2 WHERE d2.task_kind=duels.task_kind
              AND d2.spot_check=1 AND d2.id<>duels.id
              AND d2.status IN ('routed','awaiting_judgment')
              AND ((landed(d2.anth_output) + landed(d2.gpt_output))
                     > (landed(duels.anth_output) + landed(duels.gpt_output))
                OR ((landed(d2.anth_output) + landed(d2.gpt_output))
                     = (landed(duels.anth_output) + landed(duels.gpt_output))
                  AND ((d2.status='awaiting_judgment') > (duels.status='awaiting_judgment')
                    OR ((d2.status='awaiting_judgment') = (duels.status='awaiting_judgment')
                      AND d2.id > duels.id)))))
          RETURNING id`).all() as { id: number }[]).map(r => r.id);
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_inflight_spot ON duels(task_kind) " +
          "WHERE spot_check=1 AND status IN ('routed','awaiting_judgment')");
        db.exec('COMMIT');
      } catch (e2) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        swept = []; // the rollback undid the sweep — do not report collateral that unhappened
        demoted = [];
        throw e2;
      }
      try { db.exec('DROP INDEX IF EXISTS idx_one_routed_spot'); } catch { /* read-only */ }
      gate = 'normalized and created on retry';
    } catch (e2) {
      healErr = (e2 as Error).message;
      try {
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_routed_spot ON duels(task_kind) " +
          "WHERE spot_check=1 AND status='routed'");
        gate = 'routed-only fallback gate in place';
      } catch { gate = 'NO GATE — create also blocked'; }
    }
    const healLine = `[model-routing] idx_one_inflight_spot create failed (${gate}): ` +
      `${(e as Error).message}` +
      (swept.length ? `; swept duel(s) ${swept.join(', ')} → abandoned (revivable by id)` : '') +
      (demoted.length ? `; demoted duel(s) ${demoted.join(', ')} → plain paid record ` +
        '(a rival holds the audit seat)' : '') +
      (healErr ? `; heal failed: ${healErr}` : '');
    if (!gate.startsWith('NO GATE')) console.error(healLine);
    else {
      // writeSync, not console.*, for EVERY diagnostic on this branch: it ends in a throw
      // whose only human-facing handler (src/cli.ts open()) force-exits, and a queued console
      // write can be dropped by process.exit on async-pipe platforms (macOS) — the exact
      // delivery hazard c0470d2 moved the refusal line itself off, reopened one file over for
      // the diagnostics that explain it (duel-75 opus F3 / sol F2). writeSync drains before
      // the throw leaves this frame.
      writeSync(2, healLine + '\n');
      // Returning a writable connection with NO gate re-opened the duel-63 race for every
      // process holding one: the router's pendingSpotDuel SELECT is not atomic with
      // createDuel, and the unique index IS the cross-process gate (duel-71 sol F4). A
      // diagnosed-broken open refuses loudly. Data alone cannot reach this branch — the
      // demotion's total order leaves one survivor per kind, so a heal that RAN clears the
      // duplicates — which means the reachable causes are storage-level (BUSY past the
      // timeout, read-only open, IO/FULL), not rows an operator clears (duel-74 opus F4).
      // The in-flight audits are printed as best-effort context, guarded: the connection
      // itself may be the broken thing.
      try {
        const stuck = db.prepare(`SELECT id, task_kind, status FROM duels
          WHERE spot_check=1 AND status IN ('routed','awaiting_judgment') ORDER BY id`)
          .all() as { id: number; task_kind: string; status: string }[];
        if (stuck.length) {
          writeSync(2, '[model-routing] in-flight spot audit(s) at refusal: '
            + stuck.map(r => `#${r.id} ${r.task_kind} ${r.status}`).join(', ') + '\n');
        }
      } catch { /* nothing readable — the refusal below still fires */ }
      try { db.close(); } catch { /* diagnostics already printed */ }
      throw new Error('model-routing: no uniqueness gate could be installed — '
        + 'refusing an ungated writable open');
    }
  }
  migrate(db);
  foldDeadSlugHistory(db);
  return db;
}

// One-shot data migrations, gated by user_version so they do not re-scan (and re-take a write
// lock on) the shared WAL DB at every mrctl run, SessionStart hook fire and MCP server start.
const USER_VERSION = 17;
function migrate(db: DatabaseSync): void {
  let at = (db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0;
  if (at >= USER_VERSION) return;
  // The sweep below asks "does the matrix still route this model?", so an unseeded matrix
  // answers "no" for every row and consumes all of them, irreversibly. Defer instead of
  // guarding the statement: user_version stays 0, so the next open after seeding runs it.
  if (!db.prepare('SELECT 1 FROM matrix LIMIT 1').get()) {
    // duel-163 F5: the bare defer left a first-use gap. Entry points seed AFTER openDb, so a
    // first process that seeded and then routed/recorded anything left a version-0 DB with
    // history — and the NEXT open ran the whole historical ladder over a database born from
    // the current seed: v7's inlined 2026-08-01 pairings read the intentional 2026-08-10 ones
    // as divergence and wrote false operator flags. A DB this binary just created (no matrix,
    // no history) is born current — stamp it NOW, before the entry point seeds, so no
    // observer ever sees seeded-but-unstamped. An empty matrix WITH history is not this case
    // (hand-surgery residue): keep the old defer for it.
    if (!db.prepare('SELECT 1 FROM duels LIMIT 1').get()
        && !db.prepare('SELECT 1 FROM outcomes LIMIT 1').get()) {
      try { db.exec(`PRAGMA user_version = ${USER_VERSION}`); }
      catch (e) { console.error(`[model-routing] fresh stamp deferred: ${(e as Error).message}`); }
    }
    return;
  }
  // A DB with no duels and no outcomes holds nothing any of these migrations can repair — they
  // rewrite contest history this install does not have. Running them anyway is NOT harmless:
  // each carries the seed of the version it belongs to, and v7's inlined 2026-08-01 pairings
  // overwrote the CURRENT seed on a virgin install (seeded implementation-build at terra@max,
  // second open handed it back at medium — and mechanical-apply's spark@xhigh the same way).
  // A fresh install is born current: stamp it and skip the lot.
  // (`provisional` is not part of the test — the seed itself ships a provisional row.)
  if (!db.prepare('SELECT 1 FROM duels LIMIT 1').get()
      && !db.prepare('SELECT 1 FROM outcomes LIMIT 1').get()) {
    at = USER_VERSION; // every `at <` block below is a no-op; the stamp still lands
  }
  try {
    // One transaction: a crash between the backfill and the version bump would otherwise leave
    // a half-migrated DB that only re-runs because both halves happen to be idempotent.
    db.exec('BEGIN IMMEDIATE');
    if (at < 1) {
      backfillProofClaims(db);
      // Evidence 2.4.0 logged before its admissibility guard is still sitting unspent, which is
      // the very defect the reordered insert closes: one fresh FAIL on a model whose row once
      // rejected an outcome would read as a 2× streak. Spark shadow rows are exempt — they are
      // admissible while spark is NOT the row's contender (that is what shadowing means).
      db.exec(`UPDATE outcomes SET consumed=1
               WHERE consumed=0 AND COALESCE(role,'') <> 'shadow'
                 AND NOT EXISTS (SELECT 1 FROM matrix m WHERE m.task_kind = outcomes.task_kind
                                  AND (m.anth_model = outcomes.model OR m.gpt_model = outcomes.model))`);
    }
    if (at < 2) retireLunaAndSeedUnion(db);
    if (at < 3) repairPreSwapWindows(db);
    // setVendorModel now spends the outgoing model's evidence at eviction time (duel-62 sol#1);
    // rows evicted BEFORE that rule existed still carry unspent cross-era evidence, and one of
    // them already combined with a fresh FAIL into the bogus 2026-07-29 'implementation'
    // terra→sol shift. Same shape as the v1 sweep: evidence for a model its row no longer
    // routes cannot start or extend any streak.
    if (at < 4) {
      const res = db.prepare(`UPDATE outcomes SET consumed=1
               WHERE consumed=0
                 AND NOT EXISTS (SELECT 1 FROM matrix m WHERE m.task_kind = outcomes.task_kind
                                  AND (m.anth_model = outcomes.model OR m.gpt_model = outcomes.model))`).run();
      // Logged like every other data migration: an operator who later asks why a streak reset
      // to one must find an author, not bare consumed=1 rows.
      if (Number(res.changes)) {
        db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
          new Date().toISOString().slice(0, 10),
          `v4 migration spent ${res.changes} cross-era outcome row(s): evidence for a model its `
          + 'row no longer routes cannot start or extend a streak (streaks die with the tenure)');
      }
    }
    // v2.6.11 gave a non-union double failure the 'abandoned' spelling for NEW records only:
    // rows already stored as null-winner walkovers with nothing landed stayed unlisted by
    // pendingDuels, non-revivable (recordResults short-circuits on 'walkover') — yet counted
    // dead by the router's backoff. The two-subsystem disagreement the fix closed stayed true
    // for every legacy row (duel-69 opus F7). landed() is registered on this connection before
    // migrate runs; the death stamp falls back through the row's own clocks, oldest-true first.
    if (at < 5) {
      const res = db.prepare(`UPDATE duels SET status='abandoned', decided_by='abandoned',
          abandoned_at=COALESCE(abandoned_at, recorded_at, created_at)
        WHERE status='walkover' AND winner_vendor IS NULL
          AND NOT landed(anth_output) AND NOT landed(gpt_output)`).run();
      if (Number(res.changes)) {
        db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
          new Date().toISOString().slice(0, 10),
          `v5 migration rewrote ${res.changes} legacy double-failure walkover row(s) to `
          + "'abandoned': death-stamped, listed while fresh, revivable by id — the spelling "
          + 'every subsystem now agrees on');
      }
    }
    // v5 repaired only the rows it CONVERTED: a pre-2.6.8 row already stored 'abandoned' kept
    // its NULL death stamp (recordResults' replay detection then propagated the NULL and the
    // row left every recovery surface at its next death record), and a sweep stamp older than
    // the row's own recorded death kept hiding a fresh corpse from the pending window
    // (duel-70 anth F2/F8 + sol P2). Every abandoned row's death now reads from its LATEST
    // clock — the same per-row MAX router.ts and pendingDuels use. Idempotent; superseded
    // sitters are untouched by construction (their abandoned_at is already their only clock).
    // (v5's status rewrite also moved its rows out of standings' `walkovers` count — that
    // historical figure shrank by the converted rows, by design; noted here because the v5
    // changelog did not say so.)
    if (at < 6) {
      const res = db.prepare(`UPDATE duels
          SET abandoned_at = MAX(COALESCE(abandoned_at,0), COALESCE(recorded_at,0), created_at)
        WHERE status='abandoned'
          AND MAX(COALESCE(abandoned_at,0), COALESCE(recorded_at,0), created_at)
              <> COALESCE(abandoned_at, 0)`).run();
      if (Number(res.changes)) {
        db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
          new Date().toISOString().slice(0, 10),
          `v6 migration re-stamped ${res.changes} abandoned row(s) at their latest clock: a `
          + 'NULL or stale death stamp was hiding a recorded death from every recovery surface');
      }
    }
    if (at < 7) reconcileSplitKinds(db);
    if (at < 8) reresolveTokenDecidedDuels(db);
    if (at < 9) renameSplitResidueKinds(db);
    // The 2026-08-10 seed put deep-review's sol side at 'max' on a claim ("verified accepted on
    // codex-cli 0.147.0") that never reproduced: the CLI rejects max ("Use one of: none,
    // minimal, low, medium, high, xhigh", hit live 2026-08-10 and again 2026-08-11), so every
    // launch was clamped to xhigh by the standing operator rule. This is a RELABEL, not a
    // pairing change: the models stay, the duels already ran at xhigh, so updated_at — the
    // contest window standings scores by — deliberately does NOT move and no evidence is spent.
    // Scoped to the gpt side: spark tops out at xhigh too, and anthropic 'max' is real.
    if (at < 10) {
      const res = db.prepare(
        `UPDATE matrix SET gpt_effort='xhigh' WHERE gpt_effort='max'`).run();
      if (Number(res.changes)) {
        db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
          new Date().toISOString().slice(0, 10),
          `v10 migration relabeled ${res.changes} matrix row(s) from gpt_effort 'max' to `
          + "'xhigh': codex-cli rejects max, so every launch already ran clamped at xhigh — "
          + 'the row now says what runs; window and evidence untouched');
      }
    }
    if (at < 11) reconcileWebResearchUnion(db);
    // v2.13.2 rounds every latency at the write, but the live rows it repaired got a one-off
    // manual UPDATE (duel-207 P3): every other copy — the pre-repair backups the ops note says
    // to keep, restores — still holds fractional REALs in the INTEGER clock columns. This is
    // that UPDATE as a migration. Value normalization only: winners, windows and evidence are
    // untouched, and a row already integral is a no-op.
    if (at < 12) {
      const res = db.prepare(`UPDATE duels SET
          anth_latency_ms = CAST(ROUND(anth_latency_ms) AS INTEGER),
          gpt_latency_ms  = CAST(ROUND(gpt_latency_ms)  AS INTEGER)
        WHERE (anth_latency_ms IS NOT NULL
               AND anth_latency_ms <> CAST(anth_latency_ms AS INTEGER))
           OR (gpt_latency_ms IS NOT NULL
               AND gpt_latency_ms <> CAST(gpt_latency_ms AS INTEGER))`).run();
      if (Number(res.changes)) {
        db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
          new Date().toISOString().slice(0, 10),
          `v12 migration rounded fractional latency on ${res.changes} duel row(s) to integer `
          + 'ms: the clock column is integer since v2.13.2, but the live repair was a one-off '
          + 'UPDATE no backup or restore ever received — values only, winners and windows '
          + 'untouched');
      }
    }
    // v12 coarsened decision-grade clocks, and rounding is not injective (duel-209 F1): a
    // latency-decided row whose two clocks now read EQUAL asserts a win the resolver calls a
    // tie. The fractional clocks that proved the win are gone, so the honest state is the
    // tie's own — every no-winner spelling lands on status 'unresolved' (see recordJudgment).
    // Judge-decided rows and unequal rounded clocks are untouched.
    if (at < 13) {
      const res = db.prepare(`UPDATE duels SET
          status='unresolved', winner_vendor=NULL, decided_by='unresolved'
        WHERE status='judged' AND decided_by='latency'
          AND anth_latency_ms IS NOT NULL AND anth_latency_ms = gpt_latency_ms`).run();
      if (Number(res.changes)) {
        db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
          new Date().toISOString().slice(0, 10),
          `v13 migration reconciled ${res.changes} latency-decided duel row(s) whose v12-rounded `
          + 'clocks tie: the win the fractional clocks proved is unprovable from the stored '
          + "record, so the row takes the tie's own spelling — status 'unresolved', no winner; "
          + 'judge-decided rows and unequal clocks untouched');
      }
    }
    if (at < 17) replaceSolWithAstra(db);
    db.exec(`PRAGMA user_version = ${USER_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    // Another process holds the write lock, or the DB is read-only: leave user_version alone
    // so the next open retries. Never take the caller down with it.
    try { db.exec('ROLLBACK'); } catch { /* BEGIN itself failed — nothing open */ }
    console.error(`[model-routing] migration deferred: ${(e as Error).message}`);
  }
}

// v2.6 changed WHICH MODELS RUN, and seedMatrix could not deliver any of it: it is INSERT OR
// IGNORE, so on every existing install deep-review stayed a duel (the headline feature simply
// never switched on) and both haiku-tier rows kept routing gpt-5.6-luna — a model the release
// declares "never routed, never a peer, never a fallback", and which record_outcome can no longer
// demote because it is off the ladder. A schema-only migration shipped a release whose entire
// content was data. Peers are inlined rather than imported from matrix.ts/outcomes.ts: a
// migration must keep doing what it did at the version it belongs to, even after those tables
// change again.
const LUNA = 'gpt-5.6-luna';
function retireLunaAndSeedUnion(db: DatabaseSync): void {
  const log = db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)');
  const today = new Date().toISOString().slice(0, 10);

  const union = db.prepare(
    "UPDATE matrix SET union_mode=1, decided=0, victor_vendor=NULL, decided_mode=NULL, "
    + "spot_counter=0, updated_at=? WHERE task_kind='deep-review' AND union_mode=0").run(Date.now());
  if (Number(union.changes)) {
    log.run(today, "'deep-review' switched to union mode — both vendors run, the merge ships, "
      + 'no judges (measured complementary, not comparable); any prior verdict cleared');
  }

  // Same tier map the seed uses. A luna row's anthropic side is what decides its replacement, so
  // a row demoted since v2.1 gets the peer it should have now, not the one it had then.
  const peer = (anth: string): [string, string | null] => {
    const base = anth.replace(/\[[^\]]*\]$/, '');
    if (base === 'haiku') return ['gpt-5.3-codex-spark', 'low']; // spark holds the haiku seat now
    if (base === 'sonnet') return ['gpt-5.6-terra', null];       // null = keep the row's effort
    return ['gpt-5.6-sol', null];
  };
  const rows = db.prepare(
    'SELECT task_kind, anth_model, gpt_effort FROM matrix WHERE gpt_model=?').all(LUNA) as any[];
  // updated_at IS the contest window (standings scores duels created_at >= updated_at;
  // older ones retire): swapping a contestant without moving it credits the retired
  // pairing's duels to the new one.
  const set = db.prepare('UPDATE matrix SET gpt_model=?, gpt_effort=?, decided=0, '
    + 'victor_vendor=NULL, decided_mode=NULL, spot_counter=0, updated_at=? WHERE task_kind=?');
  for (const r of rows) {
    const [model, effort] = peer(r.anth_model);
    set.run(model, effort ?? r.gpt_effort, Date.now(), r.task_kind);
    log.run(today, `'${r.task_kind}': openai ${LUNA} → ${model} (luna retired) — contest reset`);
  }

  // The earn-in shadow is gone with it. Unspent shadow evidence would otherwise outlive the
  // mechanism that produced it: on a row spark now holds by seed, an old shadow FAIL sitting
  // unspent is one loss away from reading as a 2× canonical streak if the role scoping ever
  // loosens. Spend it — the thing it was evidence FOR no longer exists.
  db.exec("UPDATE outcomes SET consumed=1 WHERE consumed=0 AND role='shadow'");
  db.exec(`UPDATE outcomes SET consumed=1 WHERE consumed=0 AND model='${LUNA}'`);
}

// 2026-09-05 (operator): GPT-6-Astra replaces gpt-5.6-sol as the openai contestant on every row
// sol held, at the row's own effort — spark rows and the luna backup seat are untouched. Same
// class as the v2 luna retirement: seedMatrix is INSERT OR IGNORE, so a contestant change reaches
// an existing install only as a data migration. The window moves with the contestant (updated_at
// IS the contest window — a swap that leaves it credits sol's duels to astra) and sol's unspent
// evidence dies with its tenure, the setVendorModel rule inlined here so this migration keeps
// doing what it did at the version it belongs to. `provisional` is untouched: a fleet-wide swap is
// not a per-row ratification. Rows with no gpt contender (gpt_model NULL) are not sol rows.
const SOL = 'gpt-5.6-sol';
const ASTRA = 'gpt-6-astra';
function replaceSolWithAstra(db: DatabaseSync): void {
  const log = db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)');
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(
    'SELECT task_kind, gpt_effort FROM matrix WHERE gpt_model=? ORDER BY task_kind').all(SOL) as any[];
  const set = db.prepare(`UPDATE matrix SET gpt_model=?, decided=0, victor_vendor=NULL,
    decided_mode=NULL, spot_counter=0, updated_at=? WHERE task_kind=?`);
  const now = Date.now();
  for (const r of rows) {
    set.run(ASTRA, now, r.task_kind);
    log.run(today, `'${r.task_kind}': openai ${SOL}@${r.gpt_effort} → ${ASTRA}@${r.gpt_effort} `
      + '(GPT-6-Astra replaces sol on every row, operator 2026-09-05) — contest reset');
  }
  // Every sol row is gone, so every unspent sol outcome is cross-era evidence (the v4 rule).
  db.prepare('UPDATE outcomes SET consumed=1 WHERE consumed=0 AND model=?').run(SOL);
}

// The v2 row rewrites swapped a contestant without moving updated_at, so on every install v2
// visited, duels fought against retired luna still sat inside the new pairing's victory window.
// Data-driven repair: push the window just past the last luna-contested duel, but only on rows
// whose window still contains one — a DB migrating straight to v3 is fixed at the source above.
function repairPreSwapWindows(db: DatabaseSync): void {
  const res = db.prepare(`UPDATE matrix SET updated_at = 1 + (
      SELECT MAX(d.created_at) FROM duels d
      WHERE d.task_kind = matrix.task_kind AND d.sides LIKE '%${LUNA}%')
    WHERE EXISTS (SELECT 1 FROM duels d WHERE d.task_kind = matrix.task_kind
      AND d.sides LIKE '%${LUNA}%' AND d.created_at >= matrix.updated_at)`).run();
  if (Number(res.changes)) {
    db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
      new Date().toISOString().slice(0, 10),
      `contest window repaired on ${res.changes} row(s): duels against retired ${LUNA} were `
      + 'still inside the victory window (the v2 swap left updated_at behind)');
  }
}

// v2.7.0 split bulk-mechanical and implementation into four child kinds — and shipped it
// data-only: seedMatrix is INSERT OR IGNORE (the v2.6 defect class above), so a row already
// sitting under a child's name — getRow auto-creates any unknown slug as a provisional clone
// of `default`, which for the implementation children even matches the seeded pairing, leaving
// `provisional` as the only tell — kept its wrong state forever, and nothing moved the parents'
// contest windows although the split narrowed their population to the ambiguous residue
// (duel-87, both sides). Seeds are inlined per this file's rule: a migration keeps doing what
// it did at the version it belongs to, even after SEED changes again.
// Since v2.13.9 seeding re-stamps an untouched clone itself — default-era AND tier-born
// shapes since v2.13.11, any other provisional divergence FLAGGED instead of skipped — so
// this class needs no new per-kind migration; the ones that already exist stay, for the
// databases stamped below their version. Only a seed change that must override a RATIFIED
// row still migrates.
const SPLIT_EPOCH = 1785590186000; // 2026-08-01T13:16:26Z — the v2.7.0 split commit
function reconcileSplitKinds(db: DatabaseSync): void {
  const log = db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)');
  const today = new Date().toISOString().slice(0, 10);

  // Children: reconcile to the 2026-08-01 seed. Fresh contests by design, so re-stamping a
  // collided row loses nothing the split wants kept; a row already at seed is left alone.
  // ONLY provisional rows are re-stamped (duel-105 P1, closed v2.10.4): the collision this
  // repairs is getRow's auto-created clone, and provisional=1 is its tell. A child row that
  // diverges WITHOUT the tell was placed deliberately — re-stamping it resurrected whatever
  // the seed named (an evicted spark, an overridden pairing) over an operator decision. The
  // engine flags it and moves nothing, the v2.10.x doctrine.
  const seed: Array<[string, string, string, string]> = [
    ['mechanical-apply', 'haiku', 'gpt-5.3-codex-spark', 'low'],
    ['mechanical-sweep', 'haiku', 'gpt-5.3-codex-spark', 'low'],
    ['implementation-build', 'sonnet', 'gpt-5.6-terra', 'medium'],
    ['implementation-teardown', 'sonnet', 'gpt-5.6-terra', 'medium'],
  ];
  const DIVERGES = `(anth_model<>? OR COALESCE(anth_effort,'')<>?
      OR COALESCE(gpt_model,'')<>? OR COALESCE(gpt_effort,'')<>? OR provisional<>0
      OR decided<>0 OR union_mode<>0 OR spot_counter<>0)`;
  // The tell alone is not enough (duel-163 F1, both reviewers): setVendorModel cleared the
  // verdict and window on a re-pairing but not `provisional` until v2.10.6, so a pre-v7 copy can
  // hold a row that was BORN a clone and then deliberately re-paired — still carrying the tell.
  // The clone's PAIRING is the second tell: getRow copied the era default row, sonnet@medium vs
  // gpt-5.6-terra@medium (inlined per this file's rule — the current default has since moved to
  // sol@high). Only a row with both tells is an untouched auto-clone; a provisional row at any
  // other pairing shows pairing work and is flagged, never stamped.
  // ponytail: a deliberate re-pairing TO exactly sonnet/terra@medium stays indistinguishable
  // from the clone — no stored bit separates them; accepted, the flag doctrine cannot see it
  // either.
  const CLONE_SHAPE = `(anth_model='sonnet' AND COALESCE(anth_effort,'')='medium'
      AND COALESCE(gpt_model,'')='gpt-5.6-terra' AND COALESCE(gpt_effort,'')='medium')`;
  const fix = db.prepare(`UPDATE matrix SET anth_model=?, anth_effort=?, anth_lane='B',
      gpt_model=?, gpt_effort=?, provisional=0, overflow_eligible=1, decided=0,
      victor_vendor=NULL, decided_mode=NULL, spot_counter=0, union_mode=0, updated_at=?
    WHERE task_kind=? AND provisional=1 AND ${CLONE_SHAPE} AND ${DIVERGES}`);
  const flag = db.prepare(`SELECT anth_model, anth_effort, gpt_model, gpt_effort FROM matrix
    WHERE task_kind=? AND NOT (provisional=1 AND ${CLONE_SHAPE}) AND ${DIVERGES}`);
  for (const [kind, anth, gpt, effort] of seed) {
    const r = fix.run(anth, effort, gpt, effort, Date.now(), kind,
      anth, effort, gpt, effort);
    if (Number(r.changes)) {
      log.run(today, `'${kind}' reconciled to its 2026-08-01 seed (${anth}@${effort} vs `
        + `${gpt}@${effort}) — a pre-existing row (getRow's provisional default clone) had `
        + 'pinned the wrong state; fresh contest restored');
      // Evidence accrued under the collided pairing cannot start or extend a streak in the
      // fresh contest — same rule as the v1/v4 sweeps.
      db.prepare('UPDATE outcomes SET consumed=1 WHERE consumed=0 AND task_kind=?').run(kind);
      continue;
    }
    const d = flag.get(kind, anth, effort, gpt, effort) as any;
    if (d) {
      log.run(today, `'${kind}' diverges from its 2026-08-01 seed (holds `
        + `${d.anth_model}@${d.anth_effort ?? '-'} vs ${d.gpt_model ?? '—'}@${d.gpt_effort ?? '-'}) `
        + 'but is not an untouched auto-clone (no provisional tell, or a pairing the clone '
        + 'never held) — left untouched, FLAGGED for the operator (v2.10.6: the split '
        + 'reconcile re-stamps only auto-created clones; a deliberate pairing is never '
        + 'overwritten)');
    }
  }

  // Parents: narrowed to the ambiguous residue, so the pre-split record is a mixed population
  // that cannot settle the kind that remains — repairPreSwapWindows' rule, population edition.
  // The window lands just past the last pre-split duel (post-split residue duels stay in), and
  // a standing verdict clears unconditionally: at this version none can rest on post-split
  // evidence (auto-decide frozen 2026-07-31), and a reopened contest is re-winnable while a
  // tainted verdict mis-routes forever.
  const parents = db.prepare(`UPDATE matrix SET decided=0, victor_vendor=NULL,
      decided_mode=NULL, spot_counter=0,
      updated_at = COALESCE((SELECT 1 + MAX(d.created_at) FROM duels d
        WHERE d.task_kind = matrix.task_kind AND d.created_at < ${SPLIT_EPOCH}), updated_at)
    WHERE task_kind IN ('bulk-mechanical', 'implementation')
      AND (decided <> 0 OR EXISTS (SELECT 1 FROM duels d WHERE d.task_kind = matrix.task_kind
        AND d.created_at < ${SPLIT_EPOCH} AND d.created_at >= matrix.updated_at))`).run();
  if (Number(parents.changes)) {
    log.run(today, `${parents.changes} parent row(s) restarted as ambiguous-case fallbacks `
      + '(2026-08-01 split): the pre-split mixed-population record left the victory window, '
      + 'and any standing verdict cleared — it cannot settle the narrowed kind');
    // Unspent parent evidence is pre-split by construction here (the freeze predates the
    // split); it belonged to the mixed population and cannot seed a streak in the residue.
    db.exec(`UPDATE outcomes SET consumed=1 WHERE consumed=0
             AND task_kind IN ('bulk-mechanical', 'implementation')`);
  }
}

// v2.9.0 deleted the token tiebreak (operator, 2026-08-10: a cheaper run must never beat a
// faster one at equal quality). Rows already judged on that channel hold a winner the surviving
// rule would not pick, and standings counts them for the life of their contest window — here the
// score IS the product, so the record is re-decided on the channel that still exists rather than
// left as a permanent residue of a rule the engine no longer applies. The tiebreak is inlined per
// this file's rule: faster side wins; no clock, or a tied one, leaves nothing to decide on.
// The plausibility floor is not re-applied — it already ran ahead of the token channel, so no
// row below it can carry decided_by='tokens'.
function reresolveTokenDecidedDuels(db: DatabaseSync): void {
  const clock = db.prepare(`UPDATE duels
      SET winner_vendor = CASE WHEN anth_latency_ms < gpt_latency_ms THEN 'anthropic'
                               ELSE 'openai' END,
          decided_by = 'latency'
    WHERE decided_by='tokens'
      AND anth_latency_ms IS NOT NULL AND gpt_latency_ms IS NOT NULL
      AND anth_latency_ms <> gpt_latency_ms`).run();
  // Whatever the clock cannot separate has no channel left: judges split, tokens deleted, times
  // missing or identical. 'unresolved' is what recordJudgment writes for exactly that state.
  const dead = db.prepare(`UPDATE duels SET status='unresolved', winner_vendor=NULL,
      decided_by='unresolved' WHERE decided_by='tokens'`).run();
  if (Number(clock.changes) || Number(dead.changes)) {
    db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(
      new Date().toISOString().slice(0, 10),
      `v8 migration re-decided ${clock.changes} token-tiebreak duel(s) on latency and left `
      + `${dead.changes} unresolved (no usable clock): tokens no longer decide a duel — quality, `
      + 'then time (operator, 2026-08-10). Some historical winners flip with it, by design');
  }
}

// v2.9.6 renamed the split parents ('bulk-mechanical' → 'bulk-mechanical-misc',
// 'implementation' → 'implementation-misc') and shipped it seed-only — the duel-87 defect class
// a third time: on any DB predating the rename, the old-named row keeps the whole residue
// history while seedMatrix births a fresh `-misc` clone beside it, and the population forks.
// The live DB was repaired by hand (operator, 2026-08-10); v9 is that surgery as a migration,
// for every other copy (backups, restores). The renamed state is inlined per this file's rule:
// the row lands at its 2026-08-10 operator pairing with a fresh window — "the terra era retires
// with its duels". matrix.ts aliases the old spellings at row resolution (v2.10.2), so after
// this runs, both names read as one kind everywhere.
function renameSplitResidueKinds(db: DatabaseSync): void {
  const today = new Date().toISOString().slice(0, 10);
  const pairs: Array<[old: string, canon: string, anth: string, anthEffort: string,
    gpt: string, gptEffort: string]> = [
    ['bulk-mechanical', 'bulk-mechanical-misc', 'haiku', 'low', 'gpt-5.3-codex-spark', 'xhigh'],
    ['implementation', 'implementation-misc', 'sonnet', 'high', 'gpt-5.6-sol', 'high'],
  ];
  for (const [old, canon, anth, anthEffort, gpt, gptEffort] of pairs) {
    const hadRow = !!db.prepare('SELECT 1 FROM matrix WHERE task_kind=?').get(old);
    // The old name's era retires with the rename: unspent evidence under it cannot seed a
    // streak in the renamed contest (the v1/v4/v7 sweep rule).
    db.prepare('UPDATE outcomes SET consumed=1 WHERE consumed=0 AND task_kind=?').run(old);
    // Captured BEFORE the re-file: the newest duel the dead era fought. Whenever the canonical
    // row keeps its window (drop branch, or no old row at all), that window must move past the
    // re-filed history — standings scopes the current contest by created_at >= updated_at
    // alone, so a legacy-pairing duel newer than the canon stamp would score inside the live
    // contest the operator reads (duel-163 F2, both reviewers; repairPreSwapWindows' rule).
    const lastOld = (db.prepare('SELECT MAX(created_at) m FROM duels WHERE task_kind=?')
      .get(old) as any)?.m as number | null;
    demoteRivalAudits(db, old, canon, 'v9 migration', today);
    // History re-files under the canonical name, as the operator's hand repair did —
    // unconditionally, matrix row or not: standings groups duels by task_kind, and a row left
    // under the dead spelling would sit outside every surface the alias covers.
    const o = db.prepare('UPDATE outcomes SET task_kind=? WHERE task_kind=?').run(canon, old);
    const d = db.prepare('UPDATE duels SET task_kind=? WHERE task_kind=?').run(canon, old);
    let windowKept = false;
    if (!hadRow) {
      if (Number(o.changes) || Number(d.changes)) {
        db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(today,
          `v9 migration re-filed ${d.changes} duel(s) and ${o.changes} outcome row(s) from `
          + `'${old}' under '${canon}': history under the dead spelling had no matrix row left`);
      }
      windowKept = true; // a canon row, if one exists, was not re-stamped by this branch
    } else if (db.prepare('SELECT 1 FROM matrix WHERE task_kind=?').get(canon)) {
      // A `-misc` row already sits beside the fork (a seed insert on some post-rename open):
      // the live contest is there, and the old row's matrix state is the dead era's.
      db.prepare('DELETE FROM matrix WHERE task_kind=?').run(old);
      db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(today,
        `v9 migration dropped the legacy '${old}' row: its history re-filed under '${canon}', `
        + 'which already carries the live contest (the 2026-08-10 rename shipped seed-only)');
      windowKept = true;
    } else {
      db.prepare(`UPDATE matrix SET task_kind=?, anth_model=?, anth_effort=?, anth_lane='B',
          gpt_model=?, gpt_effort=?, overflow_eligible=1, provisional=0, decided=0,
          victor_vendor=NULL, decided_mode=NULL, spot_counter=0, union_mode=0, updated_at=?
        WHERE task_kind=?`).run(canon, anth, anthEffort, gpt, gptEffort, Date.now(), old);
      db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(today,
        `v9 migration renamed '${old}' to '${canon}' at its 2026-08-10 pairing `
        + `(${anth}@${anthEffort} vs ${gpt}@${gptEffort}), fresh window: the rename shipped `
        + 'seed-only and this copy never received the operator repair');
    }
    if (windowKept) bumpWindowPast(db, old, canon, lastOld, 'v9 migration', today);
  }
}

// v2.13.3 seeded web-research as a UNION at opus@high vs gpt-5.6-sol@high (operator,
// 2026-08-13: duel 203 both_failed on disjoint fatal gaps — the merge was the complete
// answer — and sonnet@medium was underpowered for multi-source research) — and shipped it
// seed-only, the duel-87 defect class again (duel-207 P1, both sides): seedMatrix is INSERT
// OR IGNORE, and any DB that ever routed web-research (duels 109/110/203) already holds
// getRow's provisional default clone, so the seed row never lands and the kind keeps routing
// as a sonnet@medium DUEL, judges and all. The live DB was repaired by hand (operator,
// 2026-08-13); v11 is that surgery as a migration, for every other copy (backups, restores).
// Shapes are inlined per this file's rule. Only the untouched auto-clone is re-stamped (v7
// doctrine, duel-105 P1): the provisional tell plus an era default pairing — sonnet@medium vs
// sol@high (the current default) or vs terra@medium (the pre-2026-08-10 one). Any other
// divergent row shows pairing work and is flagged, never overwritten.
function reconcileWebResearchUnion(db: DatabaseSync): void {
  const today = new Date().toISOString().slice(0, 10);
  const CLONE_SHAPE = `(anth_model='sonnet' AND COALESCE(anth_effort,'')='medium'
      AND ((COALESCE(gpt_model,'')='gpt-5.6-sol' AND COALESCE(gpt_effort,'')='high')
        OR (COALESCE(gpt_model,'')='gpt-5.6-terra' AND COALESCE(gpt_effort,'')='medium')))`;
  const fix = db.prepare(`UPDATE matrix SET anth_model='opus', anth_effort='high', anth_lane='B',
      gpt_model='gpt-5.6-sol', gpt_effort='high', overflow_eligible=1, provisional=0, decided=0,
      victor_vendor=NULL, decided_mode=NULL, spot_counter=0, union_mode=1, updated_at=?
    WHERE task_kind='web-research' AND provisional=1 AND ${CLONE_SHAPE}`).run(Date.now());
  if (Number(fix.changes)) {
    db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(today,
      "v11 migration reconciled 'web-research' to its 2026-08-13 operator state (opus@high (B) "
      + 'vs gpt-5.6-sol@high, union): a pre-existing row — getRow\'s provisional default '
      + 'clone — had pinned it as a sonnet@medium judged duel; union carries no verdict, '
      + 'fresh window');
    // Evidence accrued under the collided pairing cannot start or extend a streak in the
    // re-paired contest — the v1/v4/v7 sweep rule.
    db.exec("UPDATE outcomes SET consumed=1 WHERE consumed=0 AND task_kind='web-research'");
    return;
  }
  // A row already at the operator state (the hand-repaired live DB) or absent (the seed lands
  // it) stays silent. Anything else is deliberate pairing work — flag, never stamp.
  const d = db.prepare(`SELECT anth_model, anth_effort, gpt_model, gpt_effort FROM matrix
    WHERE task_kind='web-research' AND NOT (provisional=1 AND ${CLONE_SHAPE})
      AND NOT (anth_model='opus' AND COALESCE(anth_effort,'')='high' AND anth_lane='B'
        AND COALESCE(gpt_model,'')='gpt-5.6-sol' AND COALESCE(gpt_effort,'')='high'
        AND union_mode=1)`).get() as any;
  if (d) {
    db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(today,
      `'web-research' diverges from its 2026-08-13 seed (holds `
      + `${d.anth_model}@${d.anth_effort ?? '-'} vs ${d.gpt_model ?? '—'}@${d.gpt_effort ?? '-'}) `
      + 'but is not an untouched auto-clone — left untouched, FLAGGED for the operator '
      + '(v2.10.6 doctrine: only auto-created clones are re-stamped)');
  }
}

// duel-163 F3 (both reviewers): one in-flight spot audit under EACH spelling is legal while the
// slugs differ — idx_one_inflight_spot keys on the raw slug — but a re-file merges them under
// one key and violates the gate (in v9, that rolled the whole migration back and wedged the DB
// at v8 on every open). Demote all but one FIRST, by the openDb heal's total order: most landed
// evidence, then awaiting over routed, then newest id. A demoted audit stays a plain PAID
// record (demoted_audit=1), exactly like the heal's.
function demoteRivalAudits(
  db: DatabaseSync, old: string, canon: string, author: string, today: string,
): void {
  const demoted = (db.prepare(`UPDATE duels SET spot_check=0, demoted_audit=1
      WHERE spot_check=1 AND status IN ('routed','awaiting_judgment') AND task_kind IN (?,?)
        AND EXISTS (SELECT 1 FROM duels d2 WHERE d2.task_kind IN (?,?)
          AND d2.spot_check=1 AND d2.id<>duels.id
          AND d2.status IN ('routed','awaiting_judgment')
          AND ((landed(d2.anth_output) + landed(d2.gpt_output))
                 > (landed(duels.anth_output) + landed(duels.gpt_output))
            OR ((landed(d2.anth_output) + landed(d2.gpt_output))
                 = (landed(duels.anth_output) + landed(duels.gpt_output))
              AND ((d2.status='awaiting_judgment') > (duels.status='awaiting_judgment')
                OR ((d2.status='awaiting_judgment') = (duels.status='awaiting_judgment')
                  AND d2.id > duels.id)))))
      RETURNING id`).all(old, canon, old, canon) as { id: number }[]).map(r => r.id);
  if (demoted.length) {
    db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(today,
      `${author} demoted duel(s) ${demoted.join(', ')} → plain paid record: the `
      + `'${old}'→'${canon}' re-file admits one in-flight spot audit, and a rival under the `
      + 'other spelling holds the seat');
  }
}

// duel-163 F2 (both reviewers): standings scopes the current contest by created_at >=
// updated_at alone, so re-filed dead-slug history newer than the canon stamp would score
// inside the live contest the operator reads. The window lands just past the newest re-filed
// duel (repairPreSwapWindows' rule) whenever the canon row kept its window.
function bumpWindowPast(
  db: DatabaseSync, old: string, canon: string, lastOld: number | null,
  author: string, today: string,
): void {
  if (lastOld == null) return;
  const bump = db.prepare(
    'UPDATE matrix SET updated_at=? WHERE task_kind=? AND updated_at<=?')
    .run(lastOld + 1, canon, lastOld);
  if (Number(bump.changes)) {
    db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)').run(today,
      `${author} pushed '${canon}' contest window past its re-filed '${old}' history: `
      + 'duels fought under the dead pairing retire instead of scoring in the live contest');
  }
}

// duel-163 F1-anthropic (closed v2.10.9): the v2.10.2 alias plus a ONE-SHOT v9 left the fork
// reopenable forever by the repo's own documented topology — a still-running pre-2.10.2 MCP
// server keeps writing into the shared WAL DB, and its getRow('implementation') auto-creates a
// provisional clone under the dead slug AFTER v9 already ran; v9 never re-runs, new-code
// readers alias past the row, and the population forks permanently (the duel-87 shape, fourth
// recurrence). This is the v9 sweep made durable: every open folds any dead-slug trace back
// into the canonical row. The no-trace fast path is one indexed lookup plus two scans of small
// tables per alias pair.
// ponytail: duels/outcomes probes are full scans; index task_kind if either table grows large.
export function foldDeadSlugHistory(db: DatabaseSync): void {
  for (const [old, canon] of Object.entries(KIND_ALIASES)) {
    let seen: unknown;
    try {
      seen = db.prepare('SELECT 1 FROM matrix WHERE task_kind=?').get(old)
        || db.prepare('SELECT 1 FROM duels WHERE task_kind=? LIMIT 1').get(old)
        || db.prepare('SELECT 1 FROM outcomes WHERE task_kind=? LIMIT 1').get(old);
    } catch { return; } // unreadable schema — migrations have louder diagnostics for that
    if (!seen) continue;
    const today = new Date().toISOString().slice(0, 10);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const log = db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)');
        const row = db.prepare(
          'SELECT provisional FROM matrix WHERE task_kind=?').get(old) as any;
        const hasHistory = !!(db.prepare(
          'SELECT 1 FROM duels WHERE task_kind=? LIMIT 1').get(old)
          || db.prepare('SELECT 1 FROM outcomes WHERE task_kind=? LIMIT 1').get(old));
        if (row && !row.provisional && hasHistory) {
          // A ratified (non-provisional) row under the dead slug is someone's deliberate state
          // — the operator doctrine: flag, move nothing. Logged once, not per open.
          if (!db.prepare('SELECT 1 FROM matrix_changelog WHERE entry LIKE ?')
            .get(`dead-slug fold: '${old}' holds a non-provisional row%`)) {
            log.run(today, `dead-slug fold: '${old}' holds a non-provisional row with history `
              + `— left untouched, FLAGGED for the operator (alias reads already route to `
              + `'${canon}')`);
          }
          db.exec('COMMIT');
          continue;
        }
        if (row) {
          db.prepare('DELETE FROM matrix WHERE task_kind=?').run(old);
          log.run(today, row.provisional
            ? `dead-slug fold: dropped the provisional '${old}' clone an old-code writer `
              + `re-created after the rename — its history re-files under '${canon}'`
            : `dead-slug fold: dropped the zombie '${old}' row (no history — seed-era residue `
              + 'the zero-history stamp skipped past)');
        }
        if (hasHistory) {
          demoteRivalAudits(db, old, canon, 'dead-slug fold', today);
          // The era rule (v1/v4/v7/v9 sweeps): evidence from the dead slug's population cannot
          // seed a streak in the canonical contest.
          db.prepare('UPDATE outcomes SET consumed=1 WHERE consumed=0 AND task_kind=?').run(old);
          const lastOld = (db.prepare('SELECT MAX(created_at) m FROM duels WHERE task_kind=?')
            .get(old) as any)?.m as number | null;
          const o = db.prepare('UPDATE outcomes SET task_kind=? WHERE task_kind=?').run(canon, old);
          const d = db.prepare('UPDATE duels SET task_kind=? WHERE task_kind=?').run(canon, old);
          log.run(today, `dead-slug fold re-filed ${d.changes} duel(s) and ${o.changes} outcome `
            + `row(s) from '${old}' under '${canon}'`);
          bumpWindowPast(db, old, canon, lastOld, 'dead-slug fold', today);
        }
        db.exec('COMMIT');
      } catch (e2) {
        try { db.exec('ROLLBACK'); } catch { /* BEGIN itself failed */ }
        throw e2;
      }
    } catch (e) {
      // Another writer holds the lock, or the open is read-only: the trace survives, so the
      // next open retries — same deferral contract as migrate().
      console.error(`[model-routing] dead-slug fold deferred: ${(e as Error).message}`);
    }
  }
}

// Proofs already spent must not be re-spendable after the upgrade. Claims are keyed on the
// canonical session id, which SQL cannot derive, so the backfill runs in JS.
function backfillProofClaims(db: DatabaseSync): void {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO proof_claims(proof, duel_id, slot, created_at) VALUES (?,?,?,?)');
  const sides = db.prepare(
    'SELECT id, created_at, anth_proof, gpt_proof FROM duels WHERE anth_proof IS NOT NULL OR gpt_proof IS NOT NULL',
  ).all() as any[];
  for (const d of sides) {
    if (d.anth_proof) ins.run(sessionIdOf(d.anth_proof), d.id, 'anthropic', d.created_at);
    if (d.gpt_proof) ins.run(sessionIdOf(d.gpt_proof), d.id, 'openai', d.created_at);
  }
  const votes = db.prepare(
    'SELECT duel_id, judge_vendor, proof, created_at FROM judgments WHERE proof IS NOT NULL',
  ).all() as any[];
  for (const j of votes) {
    ins.run(sessionIdOf(j.proof), j.duel_id, `judge:${j.judge_vendor}`, j.created_at);
  }
}
