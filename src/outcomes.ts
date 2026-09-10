import type { DatabaseSync } from 'node:sqlite';
import type { Vendor } from './types.js';
import { SPARK_EFFORT, SPARK_MODEL } from './types.js';
import { canonicalKind, getRow } from './matrix.js';
import { type ProofRoots } from './duel.js';

export const RULE_THRESHOLD = 2;
export const ANTH_LADDER = ['haiku', 'sonnet', 'opus', 'fable'];
// luna retired by the operator 2026-07-25 ("no more use of luna for anything") after haiku beat
// it 2-0 unanimously on bulk-mechanical. Its tier seat goes to spark, which is why the haiku
// peer below is spark and the gpt ladder now starts at terra.
export const GPT_LADDER = ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'];
// Spark is off-ladder (unique speed/pool properties). It HOLDS the haiku tier seat by the seed;
// it never takes ladder steps and, since the earn-in shadow was retired (operator, 2026-07-25),
// it never earns a row it was not seeded onto either. Since v2.10.1 it cannot LOSE a row on its
// own either: a FAIL streak or integrity FAIL flags the operator, who decides eviction,
// re-pairing, or contestless. Tier peers are gone with the automatism — cross-tier pairings are
// operator-set and fine ("we are finding that cross tier duels are more needed than expected").
export { SPARK_MODEL, SPARK_EFFORT };

// Model ids may carry a context-window suffix (the seed routes 'fable[1m]' for long-context).
// Rosters are keyed on the bare tier; the suffix stays on the stored model id.
const SUFFIX_RE = /(\[[^\]]*\])$/;
export const baseModel = (m: string): string => m.replace(SUFFIX_RE, '');

export interface OutcomeInput {
  date: string; taskKind: string; model: string;
  kind: 'FAIL' | 'PROMOTE'; evidence: string;
  // Proven falsification/fabrication (falsified truth-gate, fabricated verification claim) —
  // not a quality miss. ONE such FAIL flags the operator immediately; nothing auto-evicts (v2.10.1).
  integrity?: boolean;
  proof?: string | null; // spark run's session id — mandatory for admissible spark outcomes
}
export interface OutcomeResult { applied: string | null; reason?: string }

// record_outcome used to be the one matrix-moving tool with no attestation: two PROMOTE calls
// handed spark a row's gpt slot outright, with no spark run needing to have existed. That path
// is GONE — the earn-in shadow was retired 2026-07-25 (operator) and applySpark now refuses any
// outcome for a row spark does not already hold, which is strictly stronger than attesting it.
// Ladder FAIL/PROMOTE outcomes stay unattested by design: they record the controller's own
// observation of a run it already made, not a claim that a separate lane ran.

// consumed=1 on insert keeps inadmissible evidence in the audit log without letting it count:
// a FAIL against a model the row no longer routes used to land unspent, so the next real FAIL
// found a two-long streak waiting and shifted the matrix while logging "2× consecutive".
function insert(db: DatabaseSync, o: OutcomeInput, role: string | null, consumed = 0): void {
  db.prepare(
    `INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed, integrity)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(o.date, o.taskKind, o.model, o.kind, o.evidence, role, consumed, o.integrity ? 1 : 0);
}

// Consecutive-streak semantics over UNSPENT evidence. A lifetime COUNT(*) never expired the
// outcomes it had already acted on, so after the first shift one further outcome moved the
// matrix; consuming the evidence on use makes each shift cost a fresh streak.
function streak(db: DatabaseSync, taskKind: string, model: string, kind: string, n: number): boolean {
  const last = (db.prepare(
    'SELECT kind FROM outcomes WHERE task_kind=? AND model=? AND consumed=0 ORDER BY id DESC LIMIT ?',
  ).all(taskKind, model, n) as any[]).map(r => r.kind);
  return last.length === n && last.every(k => k === kind);
}

// One transaction for the whole decision: the admissibility check, the evidence insert, the
// streak read and the matrix write are a single unit. Two MCP processes recording outcomes
// concurrently could otherwise interleave — one reads "row still routes sonnet", the other
// shifts the row and consumes the evidence, and the first lands an unspent stale FAIL.
export function recordOutcome(
  db: DatabaseSync, o: OutcomeInput, now: number = Date.now(),
  _opts: { roots?: ProofRoots } = {},
): OutcomeResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = applyOutcome(db, o, now);
    db.exec('COMMIT');
    return r;
    // Guarded like duel.ts / db.ts: an already-auto-rolled-back transaction makes a bare
    // ROLLBACK throw, and that error would replace the real one the caller must see.
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

function applyOutcome(db: DatabaseSync, o: OutcomeInput, now: number): OutcomeResult {
  // Evidence and streaks key on task_kind directly, not through getRow — an aliased old
  // spelling must not fork the ledger the row resolution just refused to fork.
  o = { ...o, taskKind: canonicalKind(o.taskKind) };
  if (o.model === SPARK_MODEL) return applySpark(db, o, now);

  const row = getRow(db, o.taskKind, now);
  const base = baseModel(o.model);
  const vendor: Vendor | null = ANTH_LADDER.includes(base) ? 'anthropic'
    : GPT_LADDER.includes(base) ? 'openai' : null;
  if (!vendor) {
    // v2.13.45: role='backup', not a discard. A non-ladder model is usually a backup seat
    // (luna on codex while spark's window is closed) whose real performance the operator
    // needs when analyzing the pairing — duel 284's ground-truth winner was refused here
    // with nowhere queryable to land. Still spent (consumed=1): backup seats never streak.
    insert(db, o, 'backup', 1);
    return { applied: null, reason: `model '${o.model}' is not on either ladder — logged as a `
      + `backup-seat observation (role='backup', spent, never streaks)` };
  }
  const current = vendor === 'anthropic' ? row.anth_model : row.gpt_model;
  if (current !== o.model) {
    insert(db, o, null, 1);
    return { applied: null, reason: `'${o.taskKind}' no longer routes ${o.model} (current: ${current})` };
  }
  insert(db, o, null);
  // `integrity` does NOT lower the threshold: the streak measures capability, and a
  // fabricating sonnet is not evidence that opus is needed. The flag still lands in the
  // evidence row; only spark — whose seat is held, not laddered — treats one specially.
  if (!streak(db, o.taskKind, o.model, o.kind, RULE_THRESHOLD)) {
    return { applied: null, reason: `needs ${RULE_THRESHOLD} consecutive ${o.kind} outcomes` };
  }

  // v2.10.0 (operator, 2026-08-10): the engine never moves the matrix. A reached streak is
  // FLAGGED, not acted on — the operator reads the flag and re-pairs via setVendorModel, which
  // spends the evidence. Until then the streak stays unspent, so every further consistent
  // outcome re-raises the flag instead of letting it expire silently. The ladder-step and
  // tier-repair automatism that lived here is retired — same class as v2.8.0's deleted contest
  // auto-decision: the engine records, the operator decides.
  return { applied: null, reason: `${RULE_THRESHOLD}× consecutive ${o.kind} for ${o.model} on `
    + `'${o.taskKind}' — FLAGGED for the operator; the engine no longer shifts the matrix` };
}

// While spark is canonical, 2 straight FAILs raise the operator flag. Still scoped to
// role='canonical' even though the shadow is gone: pre-2.6.1 databases carry unspent role='shadow'
// FAILs, and counting those would flag a seeded spark row on its first real loss.
function sparkStreak(db: DatabaseSync, kind: string, role: string, outcome: string, n: number): boolean {
  const last = (db.prepare(
    'SELECT kind FROM outcomes WHERE task_kind=? AND model=? AND role=? AND consumed=0 ORDER BY id DESC LIMIT ?',
  ).all(kind, SPARK_MODEL, role, n) as any[]).map(r => r.kind);
  return last.length === n && last.every(k => k === outcome);
}

function applySpark(db: DatabaseSync, o: OutcomeInput, now: number): OutcomeResult {
  const row = getRow(db, o.taskKind, now);

  // The earn-in shadow was RETIRED 2026-07-25 (operator: "we don't need a spark shadow anymore
  // since spark is duelling with haiku for bulk-mechanical; union work is deep analysis with
  // frontier models, spark should never be involved"). So spark holds exactly the rows it is
  // seeded onto, and an outcome for a row it does not hold has nothing to move: logged spent so
  // it can never combine with a later one, and refused loudly rather than banked. This replaces
  // the proof-of-run attestation that used to guard the PROMOTE path — refusing the write
  // outright is strictly stronger than proving a run happened before allowing it.
  if (row.gpt_model !== SPARK_MODEL) {
    insert(db, o, null, 1);
    return { applied: null, reason: `'${o.taskKind}' does not route ${SPARK_MODEL} `
      + `(current: ${row.gpt_model ?? 'none'}) — spark's earn-in shadow was retired, so it can no `
      + `longer take a row it was not seeded onto; logged, not counted` };
  }

  // Unspent in BOTH directions: a canonical PROMOTE written consumed=1 was invisible to
  // sparkStreak, so FAIL–PROMOTE–FAIL reverted the row while logging "2× consecutive".
  insert(db, o, 'canonical');
  if (o.kind === 'PROMOTE') {
    return { applied: null, reason: `spark already holds '${o.taskKind}' — PROMOTE logged, nothing to shift` };
  }
  // Falsification is not a quality miss the streak should average out (duel 97: spark zeroed a
  // residual truth-gate by renaming archive references to nonexistent paths). One proven
  // integrity FAIL used to evict immediately; since v2.10.1 NOTHING auto-evicts — the flag is
  // raised at maximum volume on the FIRST one instead, and the operator decides eviction,
  // re-pairing, or contestless ("I will determine when its time for a task to go contestless
  // and when it should be dueled and by who" — operator, 2026-08-10). The evidence stays
  // unspent, so the flag re-raises on every replay until an operator swap spends it.
  if (o.integrity) {
    return { applied: null, reason: `PROVEN integrity FAIL while ${SPARK_MODEL} holds `
      + `'${o.taskKind}' — OPERATOR REVIEW REQUIRED; the engine no longer auto-evicts` };
  }
  if (!sparkStreak(db, o.taskKind, 'canonical', 'FAIL', RULE_THRESHOLD)) {
    return { applied: null, reason: `needs ${RULE_THRESHOLD} consecutive canonical FAILs` };
  }
  return { applied: null, reason: `${RULE_THRESHOLD}× consecutive canonical FAILs for `
    + `${SPARK_MODEL} on '${o.taskKind}' — FLAGGED for the operator; the engine no longer `
    + `auto-evicts spark` };
}

// History seeding from v1 scorecard.md — inserts rows only, never shifts the matrix.
export function importScorecard(
  db: DatabaseSync, text: string,
): { imported: number; skipped: number } {
  let imported = 0, skipped = 0;
  for (const line of text.split('\n')) {
    if (!/^\d{4}-\d{2}-\d{2} \|/.test(line)) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 5) { skipped++; continue; }
    const [date, rawKind, modelField, type, ...rest] = parts;
    // v1 scorecard lines predate the 2026-08-10 renames; history files under the canonical name.
    const taskKind = canonicalKind(rawKind);
    const kind = type.startsWith('FAIL') ? 'FAIL'
      : type.includes('PROMOTE') ? 'PROMOTE' : null;
    if (!kind) { skipped++; continue; }
    const anth = modelField.match(/haiku|sonnet|opus|fable/)?.[0];
    // luna is retired: a v1 scorecard line naming it would mint outcome rows for a model that is
    // on no ladder and in no matrix row — audit noise the dashboards read.
    // Keyed by the id's last segment (terra/sol/astra) so a scorecard line may name either the
    // full id or the short name; the family prefix is no longer uniform (gpt-5.6-… vs gpt-6-…).
    const gpt = GPT_LADDER.find((m) => modelField.includes(m.slice(m.lastIndexOf('-') + 1)));
    // A line naming both vendors cannot be attributed; defaulting to anthropic silently
    // charged mixed-vendor failures to the wrong side.
    if (anth && gpt) { skipped++; continue; }
    const model = anth ?? gpt ?? null;
    if (!model) { skipped++; continue; }
    try { getRow(db, taskKind); } catch { skipped++; continue; } // rejects non-slug kinds
    const evidence = rest.join(' | ');
    // Re-running an import used to duplicate every row, inflating the history the dashboards
    // read. The scorecard line itself is the identity.
    // Scoped to imported rows: live rows that legitimately repeat must not be collapsed.
    // Role-less rows count only when they are also SPENT, because ≤2.4 wrote imports with no role
    // at all and always consumed=1, while live evidence is born unspent — so the first re-import
    // after the upgrade, the exact case this guard exists for, is caught without swallowing the
    // live outcome that happens to read like a scorecard line. migrate() cannot backfill the role
    // itself; it has no way to tell the two apart retroactively either.
    // ponytail: SELECT-then-INSERT, so two import processes racing the same file can still
    // double-insert. A UNIQUE index is not the fix — live outcomes legitimately repeat.
    const dupe = db.prepare(
      "SELECT 1 FROM outcomes WHERE (role='import' OR (role IS NULL AND consumed=1)) "
      + 'AND date=? AND task_kind=? AND model=? AND kind=? AND evidence=?',
    ).get(date, taskKind, model, kind, evidence);
    if (dupe) { skipped++; continue; }
    // Imported rows are history, not live evidence: marking them spent keeps the documented
    // "never shifts the matrix" contract true for the first live outcome after an import too.
    insert(db, { date, taskKind, model, kind, evidence }, 'import', 1);
    imported++;
  }
  return { imported, skipped };
}
