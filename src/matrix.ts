import type { DatabaseSync } from 'node:sqlite';
import type { Effort, Lane, Vendor } from './types.js';
import { SPARK_MODEL } from './types.js';

export interface MatrixRow {
  task_kind: string;
  anth_model: string;
  anth_effort: Effort | null;
  anth_lane: Lane;
  gpt_model: string | null;
  gpt_effort: Effort | null;
  overflow_eligible: number;
  provisional: number;
  decided: number;
  victor_vendor: Vendor | null;
  decided_mode: 'victory' | 'split' | null;
  spot_counter: number;
  union_mode: number;
  updated_at: number;
}

const r = (
  task_kind: string, anth_model: string, anth_effort: Effort | null, anth_lane: Lane,
  gpt_model: string | null, gpt_effort: Effort | null,
  overflow_eligible = 1, provisional = 0, union_mode = 0,
): MatrixRow => ({
  task_kind, anth_model, anth_effort, anth_lane, gpt_model, gpt_effort,
  overflow_eligible, provisional, decided: 0, victor_vendor: null, decided_mode: null,
  spot_counter: 0, union_mode,
  updated_at: 0, // unused placeholder — seedMatrix stamps the real insert time itself
});

// v1 matrix (SKILL.md 2026-07-20 + 2026-07-23 changelog), both vendors' contenders per kind.
// 2026-07-25 (operator): deep-review is union — measured complementary, not comparable. luna
// retired outright, so both haiku-tier rows contend against spark.
// 2026-09-05 (operator): gpt-6-astra takes every seat gpt-5.6-sol held, at sol's effort — the
// v17 migration carries the swap to existing installs (seedMatrix is INSERT OR IGNORE). Comments
// below that say "sol" describe the decision at its date; the row now reads astra.
export const SEED: MatrixRow[] = [
  r('architecture-design', 'fable', 'xhigh', 'A', 'gpt-6-astra', 'xhigh'),
  // 2026-08-10 (operator): deep-review's union runs fable against sol at the top of both
  // ladders on the kind whose whole point is finding what the other side missed. Sol's top is
  // xhigh, not max — codex-cli rejects max (v2.12.5; the seed briefly said max and every launch
  // was clamped). Lane stays B: lane A writes no attestable artifact, and a union side ships
  // unjudged (v2.7.3).
  r('deep-review',         'fable', 'xhigh', 'B', 'gpt-6-astra', 'xhigh', 1, 0, 1),
  r('debugging',           'fable', 'xhigh', 'A', 'gpt-6-astra', 'xhigh'),
  // 2026-08-10 (operator): second-opinion is UNION, on deep-review's criterion. Its two
  // split-judge duels (138, 143) each carried the winner's headline finding nowhere in the
  // loser's report — opus reproduces against live data, sol enumerates what the diff leaves
  // unclosed. Picking one discards real findings, so both run and the merge ships.
  r('second-opinion',      'opus',  'high',  'B', 'gpt-6-astra', 'xhigh', 1, 0, 1),
  // 2026-08-13 (operator): web-research is UNION, on deep-review's criterion — duel 203
  // both_failed with DISJOINT fatal gaps (each side's miss was the other's strength; the
  // merge was a complete answer). sonnet@medium was underpowered for multi-source research:
  // raised to opus@high, sol stays high. Both sides fan out (see SKILL union protocol).
  r('web-research',        'opus',  'high',  'B', 'gpt-6-astra', 'high', 1, 0, 1),
  // 2026-08-10 (operator): 'implementation' is renamed implementation-misc, matching the
  // bulk-mechanical-misc spelling — the parent row is the ambiguous-case residue of the
  // 2026-08-01 split, and its name should say so. Its gpt side leaves terra for sol@high.
  r('implementation-misc', 'sonnet', 'high', 'B', 'gpt-6-astra', 'high'),
  // 2026-08-10 (operator): spark duels at xhigh on its three kinds — its low-effort record
  // retired with the change. bulk-mechanical is renamed bulk-mechanical-misc: its pre-split
  // duels were retroactively re-filed under mechanical-apply/mechanical-sweep and the row
  // keeps only the truly-misc residue.
  r('transcription',       'haiku', 'medium', 'B', SPARK_MODEL, 'xhigh', 1, 1),
  r('bulk-mechanical-misc', 'haiku', 'low', 'B', SPARK_MODEL, 'xhigh'),
  // 2026-08-01 (operator): bulk-mechanical and implementation were mixed populations that could
  // never settle — judges decided sweeps for haiku while applies tied off to spark on cost, and
  // anth swept builds while teardowns stayed open. Each splits into two kinds; the parent row
  // stays as the fallback for ambiguous tasks. Boundary tests: apply = edit list GIVEN, sweep =
  // edit list DISCOVERED; build = ADD/CHANGE behavior, teardown = REMOVE it wholesale.
  // Fresh contests by design — no parent evidence carries over. The parents keep their
  // pre-split efforts (implementation@high vs the children's @medium) deliberately: what
  // still lands there is the ambiguous/mixed residue, and cheapening the fallback was not
  // part of the split decision.
  r('mechanical-apply',        'haiku', 'low', 'B', SPARK_MODEL, 'xhigh'),
  // 2026-08-10 (operator): mechanical-sweep goes back to spark, at xhigh, with haiku raised to
  // medium — the 2026-08-03 auto-revert to terra (2× spark FAIL at low effort, duels 97/103)
  // is overridden deliberately: the failures were low-effort work, and the operator wants the
  // pairing re-run at the efforts the kind actually needs.
  r('mechanical-sweep',        'haiku', 'medium', 'B', SPARK_MODEL, 'xhigh'),
  // 2026-08-10 (operator): implementation-build set to opus@high vs sol@xhigh — sonnet's 2×
  // integrity FAIL and terra losing 15-2 at medium on the same day. The seed kept the split's
  // sonnet@medium vs terra@medium until 2026-09-05 (v2.14.1), lagging the live row by four weeks;
  // it now reads the operator pairing, astra having taken sol's seat.
  r('implementation-build',    'opus', 'high', 'B', 'gpt-6-astra', 'xhigh'),
  // 2026-08-10 (operator): every row that ran gpt-5.6-terra@medium moves to gpt-5.6-sol@high —
  // terra@medium is retired as a contender. The anthropic side is untouched, so these pairings
  // are cross-tier on purpose, the same way haiku-vs-terra is.
  r('implementation-teardown', 'sonnet', 'medium', 'B', 'gpt-6-astra', 'high'),
  r('long-context',        'fable[1m]', 'high', 'A', 'gpt-6-astra', 'high', 0),
  r('default',             'sonnet', 'medium', 'B', 'gpt-6-astra', 'high'),
];

const INSERT = `INSERT OR IGNORE INTO matrix
  (task_kind, anth_model, anth_effort, anth_lane, gpt_model, gpt_effort,
   overflow_eligible, provisional, decided, victor_vendor, spot_counter, union_mode, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

// Tier peers for a brand-new kind. SKILL.md says new kinds "pair by the anthropic tier
// chosen"; without this the engine could only ever clone the default sonnet/terra row.
// `gptEffort` overrides the shared tier effort on the gpt side only; omitted = both sides match.
const TIER_SEED: Record<string, { anth: string; gpt: string; effort: Effort; gptEffort?: Effort }> = {
  haiku: { anth: 'haiku', gpt: SPARK_MODEL, effort: 'low' },
  // 2026-08-10 (operator): the sonnet tier peers with sol@high, like every row that moved off
  // terra@medium that day — otherwise a `tier: sonnet` kind is born at the retired pairing.
  // The effort is per-side here: sonnet stays at its tier effort, sol takes high.
  sonnet: { anth: 'sonnet', gpt: 'gpt-6-astra', effort: 'medium', gptEffort: 'high' },
  opus: { anth: 'opus', gpt: 'gpt-6-astra', effort: 'high' },
  fable: { anth: 'fable', gpt: 'gpt-6-astra', effort: 'xhigh' },
};
export const TIERS = Object.keys(TIER_SEED);

// A row born as getRow's auto-clone is not a decision about the kind — it is the ABSENCE of one,
// and `INSERT OR IGNORE` let it swallow the seed forever: web-research shipped its operator union
// pairing seed-only, so every DB that had ever routed the kind kept running it as a sonnet@medium
// judged duel (duel-207 P1). That was the SEVENTH instance of the class, each one repaired one
// kind at a time by its own numbered migration (v6/v7/v9/v11). Seeding now RE-STAMPS the untouched
// clone, so a seed change reaches existing DBs by itself and the next new kind needs no migration.
// The tells are v7's, for v7's reason (duel-163 F1): pre-v2.10.6 `setVendorModel` re-paired rows
// without clearing `provisional`, so the flag ALONE would stamp over deliberate pairing work — the
// row must also still carry a default-era pairing, the shape a clone is copied from. A ratified
// row is never touched; a seed change that must override an operator decision still needs its own
// migration. Re-stamping clears the verdict and spends the evidence accrued under the collided
// pairing, the v1/v4/v7 sweep rule — the re-paired contest starts fresh.
// A provisional SEED-kind row that matches NO clone shape (a pre-v2.10.6 re-pair, or an era this
// file no longer lists) is FLAGGED in the changelog and left alone (v2.13.11) — the class's last
// silent leg was the skip nobody announced (duel-209 F1).
// ponytail: the CURRENT default and tier tuples are derived, so a default re-pair or a new tier
// is covered by construction; append the RETIRED default tuple here when `default` moves eras.
const DEFAULT_SEED = SEED.find((s) => s.task_kind === 'default')!;
const CLONE_SHAPES: (string | null)[][] = [
  [DEFAULT_SEED.anth_model, DEFAULT_SEED.anth_effort,
    DEFAULT_SEED.gpt_model, DEFAULT_SEED.gpt_effort],   // the default row, current era
  ['sonnet', 'medium', 'gpt-5.6-sol', 'high'],          // the default era 2026-08-10 → 2026-09-05
  ['sonnet', 'medium', 'gpt-5.6-terra', 'medium'],      // the default era before 2026-08-10
  // getRow's tier-born clones (route_task {tier}) are "routed before seeded" all the same —
  // duel-209 F1: the re-stamp used to match only default-era shapes and silently skipped these.
  ...Object.values(TIER_SEED).map((t) => [t.anth, t.effort, t.gpt, t.gptEffort ?? t.effort]),
];
const REPAIR = `UPDATE matrix SET
    anth_model=?, anth_effort=?, anth_lane=?, gpt_model=?, gpt_effort=?, overflow_eligible=?,
    provisional=?, decided=0, victor_vendor=NULL, decided_mode=NULL, spot_counter=0,
    union_mode=?, updated_at=?
  WHERE task_kind=? AND provisional=1 AND (${CLONE_SHAPES.map(() =>
    `(anth_model=? AND COALESCE(anth_effort,'')=? AND COALESCE(gpt_model,'')=? `
    + `AND COALESCE(gpt_effort,'')=?)`).join(' OR ')})`;
const SHAPE_ARGS = CLONE_SHAPES.flat().map((v) => v ?? '');

export function seedMatrix(db: DatabaseSync, now: number = Date.now()): number {
  let inserted = 0;
  const stmt = db.prepare(INSERT);
  const repair = db.prepare(REPAIR);
  const spend = db.prepare('UPDATE outcomes SET consumed=1 WHERE consumed=0 AND task_kind=?');
  // One transaction: the REPAIR's first statement clears `provisional`, so a death between it
  // and the spend/log would leave a partial repair NO replay can finish (the predicate no
  // longer matches) — and a changelog line claiming a spend that never landed (duel-209 F2).
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of SEED) {
      const fixed = repair.run(s.anth_model, s.anth_effort, s.anth_lane, s.gpt_model, s.gpt_effort,
        s.overflow_eligible, s.provisional, s.union_mode, now, s.task_kind, ...SHAPE_ARGS);
      if (Number(fixed.changes)) {
        logChange(db, `seed re-stamped '${s.task_kind}' over getRow's untouched provisional clone `
          + `(${s.anth_model}@${s.anth_effort ?? '-'} (${s.anth_lane}) vs `
          + `${s.gpt_model ?? '—'}@${s.gpt_effort ?? '-'}${s.union_mode ? ', union' : ''}): the kind `
          + 'was routed before it was seeded, so the clone held the default pairing — verdict '
          + 'cleared, evidence spent, fresh window');
        spend.run(s.task_kind);
      }
      const res = stmt.run(s.task_kind, s.anth_model, s.anth_effort, s.anth_lane,
        s.gpt_model, s.gpt_effort, s.overflow_eligible, s.provisional,
        s.decided, s.victor_vendor, s.spot_counter, s.union_mode, now);
      inserted += Number(res.changes);
      // duel-209 F1 flag leg: a pre-existing provisional row the repair could not match is the
      // one shape left that can swallow a seed silently. Announce it — never stamp over it.
      // The entry text is deterministic, so the same divergence flags once; a NEW pairing on
      // the same kind writes a new line.
      if (!Number(fixed.changes) && !Number(res.changes)) {
        const row = db.prepare('SELECT * FROM matrix WHERE task_kind=?')
          .get(s.task_kind) as unknown as MatrixRow;
        const differs = row.anth_model !== s.anth_model
          || (row.anth_effort ?? '') !== (s.anth_effort ?? '')
          || row.anth_lane !== s.anth_lane
          || (row.gpt_model ?? '') !== (s.gpt_model ?? '')
          || (row.gpt_effort ?? '') !== (s.gpt_effort ?? '')
          || row.union_mode !== s.union_mode;
        if (row.provisional && differs) {
          const entry = `seed FLAGGED '${s.task_kind}': provisional row `
            + `(${row.anth_model}@${row.anth_effort ?? '-'} (${row.anth_lane}) vs `
            + `${row.gpt_model ?? '—'}@${row.gpt_effort ?? '-'}) diverges from the seed and `
            + 'matches no clone shape — left untouched, the operator decides';
          if (!db.prepare('SELECT 1 FROM matrix_changelog WHERE entry=?').get(entry)) {
            logChange(db, entry);
          }
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN itself failed — nothing open */ }
    throw e;
  }
  return inserted;
}

// A task-kind is a routing bucket, not a task description. Free prose used to be accepted
// verbatim, which permanently pinned one-off rows like 'live-API probe (FMP endpoints)' into
// the matrix, each starting a contest that could never reach the 8-duel threshold.
export const KIND_RE = /^[a-z][a-z0-9-]{2,40}$/;

export function assertKind(kind: string): void {
  if (!KIND_RE.test(kind)) {
    throw new Error(
      `invalid task kind '${kind}' — kinds are slugs matching ${KIND_RE.source} ` +
      `(e.g. deep-review, mechanical-apply). Classify the task, do not pass its description.`);
  }
}

// The 2026-08-10 renames (operator): the split parents became `-misc`, and the old spellings
// must stay readable forever — a reader recognizes both forms (the duel-75 tombstone rule).
// Without this, getRow auto-created a provisional default clone under the dead spelling and
// forked the residue row's population (the duel-87 shape, third recurrence). Aliased, not
// refused: the `-misc` row IS the old kind, renamed.
export const KIND_ALIASES: Record<string, string> = {
  'bulk-mechanical': 'bulk-mechanical-misc',
  'implementation': 'implementation-misc',
};
export const canonicalKind = (kind: string): string => KIND_ALIASES[kind] ?? kind;

export function getRow(
  db: DatabaseSync, kind: string, now: number = Date.now(), notes?: string[], tier?: string,
): MatrixRow {
  kind = canonicalKind(kind);
  const found = db.prepare('SELECT * FROM matrix WHERE task_kind=?').get(kind) as MatrixRow | undefined;
  if (found) return found;
  assertKind(kind); // only gate row *creation* — pre-existing rows still resolve
  const def = db.prepare("SELECT * FROM matrix WHERE task_kind='default'").get() as MatrixRow | undefined;
  if (!def) throw new Error('matrix not seeded (no default row)');
  if (tier && !TIER_SEED[tier]) {
    throw new Error(`unknown tier '${tier}' — expected one of ${TIERS.join(', ')}`);
  }
  const t = tier ? TIER_SEED[tier] : null;
  const fresh: MatrixRow = { ...def, task_kind: kind, provisional: 1, decided: 0,
    victor_vendor: null, decided_mode: null, spot_counter: 0, union_mode: 0, updated_at: now,
    ...(t ? { anth_model: t.anth, anth_effort: t.effort, gpt_model: t.gpt,
      gpt_effort: t.gptEffort ?? t.effort } : {}) };
  const res = db.prepare(INSERT).run(fresh.task_kind, fresh.anth_model, fresh.anth_effort,
    fresh.anth_lane, fresh.gpt_model, fresh.gpt_effort, fresh.overflow_eligible, 1, 0, null, 0,
    // A brand-new kind is never born union: union is an operator decision about a specific kind,
    // and inheriting it from the default template would silently double-run unrelated new kinds.
    0, now);
  // INSERT OR IGNORE can lose a race to a concurrent process creating the same kind (possibly
  // from a different tier). The loser used to return — and route from — its own local seed,
  // logging a creation that never happened; the duel it then created named contestants the
  // persisted matrix row does not hold (duel-62 sol#10). What the DB holds is the answer.
  if (Number(res.changes) === 0) {
    const won = db.prepare('SELECT * FROM matrix WHERE task_kind=?').get(kind) as MatrixRow | undefined;
    // Unreachable for a lost race (the winner's row is committed and visible; a locked DB
    // raises SQLITE_BUSY instead of reporting zero changes) — but a future INSERT the seed
    // template cannot satisfy would land here, and a cast would turn that into routeTask
    // dereferencing undefined with no diagnostic.
    if (!won) throw new Error(`matrix row '${kind}' was neither created nor found`);
    return won;
  }
  const from = tier ? `${tier} tier` : 'default template';
  logChange(db, `new task-kind '${kind}' added provisionally from ${from}`);
  notes?.push(`new task-kind '${kind}' — provisional row created from ${from}`);
  return fresh;
}

// Single statement: two MCP processes sharing the WAL DB used to interleave UPDATE/SELECT and
// both read the same post-increment value (duplicate spot duel) or skip a slot entirely.
// Every public kind-taking mutator canonicalizes at entry (duel-163 F4): getRow aliased the
// dead slugs but the mutators queried the raw key, so `mrctl union implementation on` exited
// 'no matrix row' while route_task and record_outcome with the same slug hit the -misc row —
// one user-visible kind, two identities depending on which surface received it.
export function bumpSpotCounter(db: DatabaseSync, kind: string): number {
  const row = db.prepare(
    'UPDATE matrix SET spot_counter = spot_counter + 1 WHERE task_kind=? RETURNING spot_counter',
  ).get(canonicalKind(kind)) as any;
  return row.spot_counter as number;
}

// Owned here rather than by the router: the spend below must subtract exactly one interval,
// and matrix.ts cannot import router.ts (router imports matrix).
export const SPOT_INTERVAL = 10;

// Spend ONE audit interval, never the whole balance. The counter keeps climbing while an audit
// is in flight (pendingSpotDuel blocks a duplicate for up to DUEL_TTL_MS), and zeroing it on
// record forgave every route taken in that window — forty routes could yield one audit instead
// of four (duel-63 opus #3). Subtracting keeps the documented 1-in-10 rate: leftover debt
// re-fires the next audit as soon as the recorded one clears the pending gate.
export function spendSpotAudit(db: DatabaseSync, kind: string): void {
  db.prepare('UPDATE matrix SET spot_counter = MAX(spot_counter - ?, 0) WHERE task_kind=?')
    .run(SPOT_INTERVAL, canonicalKind(kind));
}

export function setDecided(
  db: DatabaseSync, kind: string, victor: Vendor | null, now: number = Date.now(),
  mode: 'victory' | 'split' | null = null,
): void {
  db.prepare('UPDATE matrix SET decided=?, victor_vendor=?, decided_mode=?, updated_at=? WHERE task_kind=?')
    .run(victor ? 1 : 0, victor, victor ? (mode ?? 'victory') : null, now, canonicalKind(kind));
}

// Swapping either contestant creates a pairing that has never been contested, so the old
// decision must not carry over — otherwise the router serves the new model single on the
// previous model's victory, and stale spot progress rides along with it.
// The outgoing model's unspent outcome evidence dies with its era, HERE, in the one function
// every contestant swap routes through: streaks are "consecutive" only within one tenure, and
// evidence that survived an eviction later combined with a fresh outcome into a bogus 2×
// streak — production outcomes 6+14, six days and a pairing change apart, shifted
// 'implementation' terra→sol exactly that way (duel-62 sol#1).
export function setVendorModel(
  db: DatabaseSync, kind: string, vendor: Vendor, model: string,
  effort: Effort | null, now: number = Date.now(),
): void {
  kind = canonicalKind(kind);
  // codex-cli rejects 'max' ("Use one of: none, minimal, low, medium, high, xhigh") and spark
  // tops out at xhigh, so an openai row prescribing it is unlaunchable — every spawn would be
  // clamped and surface a HARD-RULE deviation. Refuse at the one function every pairing change
  // routes through, instead of relabeling it again in a future migration (v10 did it once).
  if (vendor === 'openai' && effort === 'max') {
    throw new Error(`gpt side cannot run at 'max': codex-cli rejects it, spark tops out at `
      + `'xhigh'. Use 'xhigh'.`);
  }
  const col = vendor === 'anthropic' ? 'anth_model' : 'gpt_model';
  const prev = (db.prepare(
    `SELECT ${col} AS m FROM matrix WHERE task_kind=?`).get(kind) as any)?.m as string | undefined;
  const cols = vendor === 'anthropic' ? 'anth_model=?, anth_effort=?' : 'gpt_model=?, gpt_effort=?';
  // provisional=0: a pairing change RATIFIES the row. `provisional` means "born as getRow's
  // auto-clone, never looked at" — it is the v7 reconcile's license to overwrite. A row whose
  // pairing someone deliberately set is no longer that thing, and leaving the tell in place let
  // v7 stamp the 2026-08-01 seed over an operator decision (duel-163 F1, both reviewers).
  db.prepare(
    `UPDATE matrix SET ${cols}, provisional=0, decided=0, victor_vendor=NULL, decided_mode=NULL,
     spot_counter=0, updated_at=? WHERE task_kind=?`,
  ).run(model, effort, now, kind);
  if (prev && prev !== model) {
    db.prepare('UPDATE outcomes SET consumed=1 WHERE task_kind=? AND model=? AND consumed=0')
      .run(kind, prev);
  }
}

// Union is an operator decision about the KIND ("these two find different things, ship both"),
// not a contest state, so it survives ladder shifts and model swaps. Turning it on also clears
// any standing decision: a union kind has no victor, and leaving one behind would let the router
// serve single off a verdict the kind no longer runs.
// Three outcomes, not two: the write CLEARS the row's verdict and resets updated_at (so the
// 8-duel window restarts), and that must not happen on a row already in the requested state.
// `AND union_mode<>?` makes 'already off' a real no-op — without it, `union <kind> off` on a kind
// that was never union destroyed a decided contest and still reported success, because SQLite
// counts a row as changed when the WHERE matched, not when the values differ.
// Turning it ON is also a REPAIR — a union kind must carry no verdict — so it fires whenever one
// is present, even if the mode is already on. Turning it OFF must not: on a row that was already
// off, clearing is pure destruction (verdict gone, 8-duel window restarted) reported as success.
export type UnionModeResult = 'changed' | 'unchanged' | 'missing';
export function setUnionMode(
  db: DatabaseSync, kind: string, on: boolean, now: number = Date.now(),
): UnionModeResult {
  kind = canonicalKind(kind);
  const res = db.prepare(
    `UPDATE matrix SET union_mode=?, decided=0, victor_vendor=NULL, decided_mode=NULL,
     spot_counter=0, updated_at=? WHERE task_kind=? AND (union_mode<>? OR (?=1 AND decided<>0))`,
  ).run(on ? 1 : 0, now, kind, on ? 1 : 0, on ? 1 : 0);
  if (Number(res.changes) > 0) return 'changed';
  // Reached only when nothing was written, so the mutating path stays one guarded statement.
  return db.prepare('SELECT 1 FROM matrix WHERE task_kind=?').get(kind) ? 'unchanged' : 'missing';
}

export function logChange(db: DatabaseSync, entry: string, date?: string): void {
  db.prepare('INSERT INTO matrix_changelog(date, entry) VALUES (?,?)')
    .run(date ?? new Date().toISOString().slice(0, 10), entry);
}

export function renderMarkdown(db: DatabaseSync): string {
  const rows = db.prepare('SELECT * FROM matrix ORDER BY task_kind').all() as unknown as MatrixRow[];
  const log = db.prepare('SELECT date, entry FROM matrix_changelog ORDER BY id DESC LIMIT 20').all() as any[];
  const lines = [
    '# Routing Matrix (rendered by engine — static fallback when engine unreachable)', '',
    '| Task kind | Anthropic | GPT | Decided | Victor | Flags |',
    '|---|---|---|---|---|---|',
  ];
  for (const m of rows) {
    const flags = [m.provisional ? 'provisional' : '', m.overflow_eligible ? '' : 'no-overflow',
      m.decided_mode === 'split' ? 'split' : '', m.union_mode ? 'union' : '']
      .filter(Boolean).join(', ');
    lines.push(`| ${m.task_kind} | ${m.anth_model}@${m.anth_effort ?? '-'} (${m.anth_lane}) `
      + `| ${m.gpt_model ? `${m.gpt_model}@${m.gpt_effort ?? '-'}` : '—'} `
      + `| ${m.union_mode ? 'n/a (union)' : m.decided ? 'yes' : 'no'} | ${m.victor_vendor ?? '—'} | ${flags} |`);
  }
  lines.push('', '## Changelog (latest 20)', '');
  for (const l of log) lines.push(`- ${l.date}: ${l.entry}`);
  return lines.join('\n') + '\n';
}
