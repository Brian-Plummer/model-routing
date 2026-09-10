import type { DatabaseSync } from 'node:sqlite';
import type { Vendor } from './types.js';
import { GRADE_POINTS, type LetterGrade } from './scoring.js';
import { pluginVersion } from './version.js';

// The margin fields (LatencyMargins) answer the question the win counts cannot: a clock win's
// COUNT is the same whether it saved a second or four minutes.
export interface KindStanding extends LatencyMargins {
  // All scores cover the CURRENT contest window only (duels since the row's last settings
  // change); earlier eras live in `retired` below, so each duel counts in exactly one place.
  kind: string; judged: number; anthWins: number; gptWins: number;
  // Wins broken out by decision channel: judge verdicts (quality) then latency tiebreaks (time).
  // anthWins/gptWins stay the final totals across both. There is no third channel — tokens
  // stopped deciding duels on 2026-08-10 (operator): a cheaper run never beats a faster one at
  // equal quality, and the v8 migration re-decided every row that had been judged on cost.
  anthJudgeWins: number; gptJudgeWins: number;
  anthLatencyWins: number; gptLatencyWins: number;
  walkovers: number;
  // Share of the window's readable-judge duels where the two judges agreed: for a duel with a
  // complete vote pair, both wrote the same grade token; for a pre-v2.11.0 judged row that
  // retained no votes, the old decided_by='judges' reading it was written under. null when the
  // window holds neither shape. It is NOT the share decided by any one channel — see the query
  // below for why decided_by stopped being a proxy for agreement at v2.11.0.
  judgeAgreementPct: number | null;
  anthModel: string | null; gptModel: string | null; // the matrix row's current pairing
  anthEffort: string | null; gptEffort: string | null;
  // v2.13.28: the GPA trend the win counts cannot carry — a formality loss and a garbage loss
  // both score 0 wins, but they grade A- and F. Split by GRADING judge because the two judges'
  // calibrations are known to differ; one blended number would hide exactly that bias. Same
  // window as every other counter; a legacy vote (NULL letters) is skipped, never counted as 0.
  gpa: GpaBlock;
  // v2.13.29: judged rows with decided_by='merge' — the ship was the composition of both
  // sides, credited to neither side's wins. Counted so the operator sees how often the best
  // answer was a merge rather than a pick.
  mergedShips: number;
  decided: boolean; victor: Vendor | null;
  decidedMode: 'victory' | 'split' | null;
  union: boolean;   // no contest: both sides run and the merge ships
  unionRuns: number;
  // Of unionRuns, the runs where only ONE side landed (the missing side died or hung): still
  // a run — the survivor's report shipped — but not the merged coverage the kind exists for.
  // Counted so 102 = 94 + 8 is read off the surface, not redone by hand (duel 391 M15).
  unionOneSided: number;
  // Judged duels from BEFORE the row's last settings change (model or effort swap bumps
  // updated_at), grouped by the pairing recorded on the duel itself. The record is kept
  // visible so a retired pairing's duels are remembered, not re-fought.
  retired: RetiredRecord[];
}

export interface GpaSide {
  overall: number | null; byAnthJudge: number | null; byGptJudge: number | null;
}
export interface GpaBlock { anth: GpaSide; gpt: GpaSide; gradedVotes: number }

export interface RetiredRecord extends LatencyMargins {
  anthModel: string | null; anthEffort: string | null;
  gptModel: string | null; gptEffort: string | null;
  judged: number; anthWins: number; gptWins: number;
  anthJudgeWins: number; gptJudgeWins: number;
  anthLatencyWins: number; gptLatencyWins: number;
  walkovers: number;
}

// The five margin numbers, reported on the current window and on every retired pairing.
export interface LatencyMargins {
  // Total time the side actually saved on the clock channel: the sum of its winning margins.
  // The COUNT of those wins (anthLatencyWins) cannot distinguish five one-second wins from one
  // four-minute win, and the operator declaring winners by hand needs both readings.
  anthLatencySavedMs: number; gptLatencySavedMs: number;
  // Median of the same margins, because a total alone cannot tell a habit from an outlier: a
  // large total beside a small median MAY be one duel carrying the number, or simply many similar
  // wins — the win count beside it separates the two. null (not 0) when the
  // side has no clock win at all — there is no margin to take a median of.
  anthLatencyMedianMs: number | null; gptLatencyMedianMs: number | null;
  // Signed across EVERY judged duel holding both clocks, whoever won and however: positive means
  // anthropic spent less wall-clock over the whole window. It disagrees with the saved totals
  // exactly where a side won on quality while being the slower one, which is the case worth
  // seeing. null when the group holds no such duel — nothing measured is not zero.
  netLatencyMs: number | null;
}

// One judged duel that stored BOTH clocks. Callers filter the window; this file decides what the
// numbers mean.
export interface MarginRow {
  decidedBy: string | null; winner: string | null; anth: number; gpt: number;
}

const sumOf = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// Even counts take the mean of the two middle margins; either way the result is rounded to whole
// milliseconds. The columns are declared INTEGER but SQLite is dynamically typed, and rows
// written before v2.13.2's integer normalization (or restored from a pre-v12 backup) can hold
// REALs, so a raw median can arrive fractional — and half a millisecond is not a measurement.
function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

// Sums and medians come out of ONE pass on purpose. SQLite has no median aggregate, so summing in
// SQL and taking medians in JS would leave two readers of one rule, free to drift apart about
// which rows they cover.
export function latencyMargins(rows: MarginRow[]): LatencyMargins {
  const anthWon: number[] = [], gptWon: number[] = [];
  let net = 0;
  for (const r of rows) {
    net += r.gpt - r.anth;
    // Only the clock channel has a margin to report: on a judge-decided duel the loser's clock is
    // explicitly irrelevant (scoring.ts decides it before latency is consulted at all), so its
    // difference is nobody's saving. It still nets — that is what netLatencyMs is for.
    if (r.decidedBy !== 'latency') continue;
    // The margin is the loser's time minus the winner's, positive by construction on a row the
    // clock decided.
    if (r.winner === 'anthropic') anthWon.push(r.gpt - r.anth);
    else if (r.winner === 'openai') gptWon.push(r.anth - r.gpt);
  }
  return {
    anthLatencySavedMs: Math.round(sumOf(anthWon)), gptLatencySavedMs: Math.round(sumOf(gptWon)),
    anthLatencyMedianMs: medianOf(anthWon), gptLatencyMedianMs: medianOf(gptWon),
    netLatencyMs: rows.length ? Math.round(net) : null,
  };
}

// Read-only: this used to call getRow, which INSERTs a provisional row for an unknown kind —
// a dashboard query could create matrix rows as a side effect.
//
// The kind list is the UNION of the matrix and the duel log, not `FROM duels` alone. Driving it
// from duels dropped every kind that has never been duelled, so `mrctl status` counted only the
// contested rows as open contests — a freshly seeded install reported "open contests: 0" with
// nine of them, and the never-duelled rows could never appear. The union side still covers an orphan duel whose matrix row
// was deleted, so no history goes missing either.
export function standings(db: DatabaseSync): KindStanding[] {
  // Every aggregate is scoped to the CURRENT contest window (created_at >= the matrix row's
  // updated_at): a settings change retires the older duels into `retired` below, so each duel
  // counts in exactly one row of the one-table view. A kind with no matrix row has no window
  // (COALESCE 0) and keeps its whole history.
  const rows = db.prepare(`SELECT k.task_kind AS task_kind,
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)), 0) AS judged,
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.winner_vendor='anthropic'), 0) AS anthWins,
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.winner_vendor='openai'), 0) AS gptWins,
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.decided_by='judges' AND d.winner_vendor='anthropic'), 0) AS anthJudgeWins,
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.decided_by='judges' AND d.winner_vendor='openai'), 0) AS gptJudgeWins,
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.decided_by='latency' AND d.winner_vendor='anthropic'), 0) AS anthLatencyWins,
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.decided_by='latency' AND d.winner_vendor='openai'), 0) AS gptLatencyWins,
      -- v2.13.29: merged ships — judged, no winner, the composition shipped
      COALESCE(SUM(d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.decided_by='merge'), 0) AS mergedShips,
      -- Judge agreement is read off the VOTES, never off decided_by. Since v2.11.0 the decision
      -- channel no longer implies agreement: 'both'+'both' IS the judges agreeing and it resolves
      -- on the CLOCK, while 'both'+'X' is the judges disagreeing and it resolves
      -- decided_by='judges' — and every contested row leaves the 'judged' bucket entirely, so the
      -- old decided_by='judges' / judged ratio excluded exactly the disagreements it claimed to
      -- measure and could report 100% on a kind whose judges never agree (duel-174 F3).
      -- (No backticks in here: this comment lives inside a JS template literal, and one would
      -- close the string mid-query.)
      -- Two populations, read by two rules, because the DB holds two kinds of row and neither
      -- rule is correct for both:
      --   * a COMPLETE vote pair (two stored judgments) is read from the TOKENS — agreement is
      --     both judges writing the same grade. This is the v2.11.0 meaning and the only one any
      --     row written from here on will have. Legacy pairs agree on their own spelling
      --     ('tie'+'tie'). recordJudgment refuses to CREATE a mixed pair, but one can still exist:
      --     a pre-v2.11.0 process racing a graded write can leave one behind (that is the race
      --     the duel-174 F1 test builds deliberately). Token equality reads such a pair too — it
      --     compares spellings, and two different vocabularies never spell the same token, so a
      --     mixed pair counts as disagreement. That is the honest answer: nobody knows whether
      --     those two judges agreed, because they were not asked the same question.
      --   * a judged row with NO stored votes is pre-v2.11.0 residue. Its votes were never
      --     retained, so the tokens cannot be consulted — but on exactly those rows decided_by
      --     DID encode preference agreement ('judges' = the two preferences matched, 'latency' =
      --     they did not, which is what made the old ratio meaningful then). So the old reading
      --     is still the correct reading OF THAT ROW and it keeps it. Recomputing them purely
      --     from tokens would silently erase every pre-upgrade duel from the ratio instead.
      -- A one-vote row is in neither population: half a pair has no agreement to report.
      COALESCE(SUM(d.created_at >= COALESCE(m.updated_at, 0) AND (
        (SELECT COUNT(*) FROM judgments j WHERE j.duel_id=d.id)=2
        OR (d.status='judged'
            AND (SELECT COUNT(*) FROM judgments j WHERE j.duel_id=d.id)=0))), 0)
        AS agreementDuels,
      COALESCE(SUM(d.created_at >= COALESCE(m.updated_at, 0) AND (
        ((SELECT COUNT(*) FROM judgments j WHERE j.duel_id=d.id)=2
         AND (SELECT COUNT(DISTINCT j.verdict) FROM judgments j WHERE j.duel_id=d.id)=1)
        OR (d.status='judged' AND d.decided_by='judges'
            AND (SELECT COUNT(*) FROM judgments j WHERE j.duel_id=d.id)=0))), 0)
        AS agreed,
      -- a legacy-dead row (pre-2.6.11 spelling: NULL winner, nothing landed) is 'abandoned'
      -- on the pending surface; it is not a walkover here either (duel-73 opus F7)
      COALESCE(SUM(d.status='walkover' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND NOT (d.winner_vendor IS NULL
        AND NOT landed(d.anth_output) AND NOT landed(d.gpt_output))), 0) AS walkovers,
      -- a union row with nothing landed shipped nothing — it is pending, not a run
      -- (duel-74 opus F1); a one-sided union IS a run (the survivor's report shipped)
      -- and is ALSO pending until its missing side is recovered or the listing ages out.
      -- Union volume never retires: a union kind has no contest for a settings change to reset.
      COALESCE(SUM(d.status='union'
        AND (landed(d.anth_output) OR landed(d.gpt_output))), 0) AS unionRuns,
      COALESCE(SUM(d.status='union'
        AND (landed(d.anth_output) OR landed(d.gpt_output))
        AND NOT (landed(d.anth_output) AND landed(d.gpt_output))), 0) AS unionOneSided,
      m.decided AS decided, m.victor_vendor AS victor, m.decided_mode AS decidedMode,
      m.union_mode AS unionMode, m.anth_model AS anthModel, m.gpt_model AS gptModel,
      m.anth_effort AS anthEffort, m.gpt_effort AS gptEffort
    FROM (SELECT task_kind FROM matrix UNION SELECT task_kind FROM duels) k
    LEFT JOIN duels d ON d.task_kind = k.task_kind
    LEFT JOIN matrix m ON m.task_kind = k.task_kind
    GROUP BY k.task_kind ORDER BY k.task_kind`).all() as any[];
  // Retired = decided before the matrix row's updated_at. The pairing comes from the duel's own
  // sides JSON, not the matrix row — the row already moved on; the duel remembers what ran.
  const retiredRows = db.prepare(`SELECT d.task_kind AS kind, d.sides, d.status,
      d.winner_vendor AS winner, d.decided_by AS decidedBy,
      d.anth_latency_ms AS anth, d.gpt_latency_ms AS gpt
      FROM duels d JOIN matrix m ON m.task_kind = d.task_kind
      WHERE d.created_at < m.updated_at
        AND (d.status='judged' OR (d.status='walkover' AND NOT (d.winner_vendor IS NULL
          AND NOT landed(d.anth_output) AND NOT landed(d.gpt_output))))
      ORDER BY d.id`).all() as any[];
  const retired = new Map<string, Map<string, RetiredRecord>>();
  // Margins are collected under the SAME kind+pairing key the records are grouped by, then filled
  // in one pass below — the record's own duels, never the kind's. Joining the two halves with a
  // space is unambiguous because a task kind is a validated lowercase slug that cannot contain
  // one, so the first space in the composite key is always the kind boundary.
  const retiredMargins = new Map<string, MarginRow[]>();
  for (const d of retiredRows) {
    let anth: { model: string; effort: string | null } | undefined;
    let gpt: { model: string; effort: string | null } | undefined;
    try {
      const sides = JSON.parse(d.sides) as Array<{ vendor: string; model: string; effort: string | null }>;
      anth = sides.find(s => s.vendor === 'anthropic');
      gpt = sides.find(s => s.vendor === 'openai');
    } catch { /* corrupt sides — grouped as the unknown pairing below */ }
    const key = `${anth?.model ?? '?'}@${anth?.effort ?? '-'}|${gpt?.model ?? '?'}@${gpt?.effort ?? '-'}`;
    const byKind = retired.get(d.kind) ?? new Map<string, RetiredRecord>();
    const rec = byKind.get(key) ?? {
      anthModel: anth?.model ?? null, anthEffort: anth?.effort ?? null,
      gptModel: gpt?.model ?? null, gptEffort: gpt?.effort ?? null,
      judged: 0, anthWins: 0, gptWins: 0,
      anthJudgeWins: 0, gptJudgeWins: 0, anthLatencyWins: 0, gptLatencyWins: 0, walkovers: 0,
      anthLatencySavedMs: 0, gptLatencySavedMs: 0,
      anthLatencyMedianMs: null, gptLatencyMedianMs: null, netLatencyMs: null,
    };
    if (d.status === 'walkover') rec.walkovers++;
    else {
      rec.judged++;
      const side = d.winner === 'anthropic' ? 'anth' : d.winner === 'openai' ? 'gpt' : null;
      if (side) {
        rec[`${side}Wins`]++;
        if (d.decidedBy === 'judges') rec[`${side}JudgeWins`]++;
        else if (d.decidedBy === 'latency') rec[`${side}LatencyWins`]++;
      }
    }
    // Walkovers ran no contest and a row missing a clock cannot be measured — same two
    // exclusions the current window applies, so the two halves of the view read one rule.
    if (d.status === 'judged' && d.anth !== null && d.gpt !== null) {
      const mk = `${d.kind} ${key}`;
      const list = retiredMargins.get(mk) ?? [];
      list.push({ decidedBy: d.decidedBy, winner: d.winner, anth: d.anth, gpt: d.gpt });
      retiredMargins.set(mk, list);
    }
    byKind.set(key, rec);
    retired.set(d.kind, byKind);
  }
  for (const [kind, byKind] of retired) {
    for (const [key, rec] of byKind) {
      Object.assign(rec, latencyMargins(retiredMargins.get(`${kind} ${key}`) ?? []));
    }
  }
  // Margins ride the same window rule as every counter in the query above (created_at >= the
  // matrix row's updated_at), and only rows that stored BOTH clocks can be measured at all — a
  // half-measured duel would otherwise net as if the missing side took zero time.
  const marginRows = db.prepare(`SELECT d.task_kind AS kind, d.decided_by AS decidedBy,
      d.winner_vendor AS winner, d.anth_latency_ms AS anth, d.gpt_latency_ms AS gpt
      FROM duels d LEFT JOIN matrix m ON m.task_kind = d.task_kind
      WHERE d.status='judged' AND d.created_at >= COALESCE(m.updated_at, 0)
        AND d.anth_latency_ms IS NOT NULL AND d.gpt_latency_ms IS NOT NULL`)
    .all() as any[]; // node:sqlite hands back Record<string, SQLOutputValue> — same cast the
                     // two queries above use, and the shape is MarginRow & { kind }.
  const marginsByKind = new Map<string, MarginRow[]>();
  for (const r of marginRows) {
    const list = marginsByKind.get(r.kind) ?? [];
    list.push(r);
    marginsByKind.set(r.kind, list);
  }
  // GPA. Letters live on the votes keyed by blind label, so each vote decodes through its own
  // duel's label_map — X is not a vendor, it is whoever X was that day. Aggregated in JS: the
  // decode + per-judge split would be four correlated subqueries in SQL, and this table is tiny.
  const gradeRows = db.prepare(`SELECT d.task_kind AS kind, d.label_map AS labelMap,
      j.judge_vendor AS judge, j.grade_x AS gx, j.grade_y AS gy
      FROM judgments j JOIN duels d ON d.id = j.duel_id
      LEFT JOIN matrix m ON m.task_kind = d.task_kind
      WHERE j.grade_x IS NOT NULL AND j.grade_y IS NOT NULL
        AND d.created_at >= COALESCE(m.updated_at, 0)`).all() as any[];
  const gpaByKind = new Map<string, { anth: Record<string, number[]>; gpt: Record<string, number[]>; votes: number }>();
  for (const g of gradeRows) {
    let labelMap: Record<string, Vendor>;
    try { labelMap = JSON.parse(g.labelMap); } catch { continue; } // corrupt row grades nobody
    const acc = gpaByKind.get(g.kind) ?? { anth: {}, gpt: {}, votes: 0 };
    acc.votes++;
    for (const [label, grade] of [['X', g.gx], ['Y', g.gy]] as const) {
      const points = GRADE_POINTS[grade as LetterGrade];
      const side = labelMap[label] === 'anthropic' ? acc.anth
        : labelMap[label] === 'openai' ? acc.gpt : null;
      if (points === undefined || side === null) continue; // unreadable letter or label
      (side[g.judge] ??= []).push(points);
      (side.overall ??= []).push(points);
    }
    gpaByKind.set(g.kind, acc);
  }
  const avg = (list: number[] | undefined): number | null =>
    list?.length ? Math.round(100 * list.reduce((a, b) => a + b, 0) / list.length) / 100 : null;
  const gpaOf = (kind: string): GpaBlock => {
    const acc = gpaByKind.get(kind);
    const side = (s: Record<string, number[]> | undefined): GpaSide => ({
      overall: avg(s?.overall), byAnthJudge: avg(s?.anthropic), byGptJudge: avg(s?.openai),
    });
    return { anth: side(acc?.anth), gpt: side(acc?.gpt), gradedVotes: acc?.votes ?? 0 };
  };
  return rows.map(r => ({
    kind: r.task_kind, judged: r.judged, anthWins: r.anthWins, gptWins: r.gptWins,
    anthJudgeWins: r.anthJudgeWins, gptJudgeWins: r.gptJudgeWins,
    anthLatencyWins: r.anthLatencyWins, gptLatencyWins: r.gptLatencyWins,
    ...latencyMargins(marginsByKind.get(r.task_kind) ?? []),
    walkovers: r.walkovers,
    // null = the window holds no duel whose judges can be read at all, so there is nothing to
    // report — not 0% agreement.
    judgeAgreementPct: r.agreementDuels
      ? Math.round(100 * r.agreed / r.agreementDuels) : null,
    anthModel: r.anthModel ?? null, gptModel: r.gptModel ?? null,
    anthEffort: r.anthEffort ?? null, gptEffort: r.gptEffort ?? null,
    gpa: gpaOf(r.task_kind),
    mergedShips: r.mergedShips,
    decided: !!r.decided, victor: r.victor ?? null, decidedMode: r.decidedMode ?? null,
    union: !!r.unionMode, unionRuns: r.unionRuns, unionOneSided: r.unionOneSided,
    retired: [...(retired.get(r.task_kind)?.values() ?? [])],
  }));
}

export const PENDING_ABANDONED_WINDOW_MS = 7 * 24 * 3_600_000;

export interface PendingDuel {
  // 'union' = a union row still missing a side (or all-blank): closed to judges, open to
  // record_duel on the same id — the recovery SKILL.md union step 7 documents (duel-74 opus F1).
  id: number; kind: string; status: 'routed' | 'awaiting_judgment' | 'abandoned' | 'union';
  union: boolean; createdAt: number; reJudgeable: boolean;
  // Non-null = this row is a displaced sitter's TOMBSTONE, dead because duel #supersededBy
  // SUCCEEDED. The consumer rule (revive-or-leave-alone, never record-both-failed) is only
  // followable if the listing says which rows it governs (duel-74 sol F1).
  supersededBy: number | null;
  // The column is only HALF the marker. `superseded_by` was added for pre-2.6.12 DBs with no
  // backfill, so a displacement stamped by a pre-2.6.12 writer — or expired during 2.6.9–2.6.11
  // — carries only the `decided_by='superseded'` spelling. The router's lastDead already tests
  // both markers for exactly this reason; a pending surface keying on the column alone left the
  // legacy class unmarked, so the generic both-failed recovery rewrote the tombstone and
  // re-armed the dying-audit backoff (duel-75 opus F1). `displaced` is the disjunction;
  // `supersededBy` still names the recording duel when a current writer could stamp it.
  displaced: boolean;
  // A displaced row died because a RIVAL audit succeeded, so "revive it if its lanes really
  // ran" is right for it. A VOIDED row is the opposite case wearing the same tombstone: its
  // lanes did run, and the controller threw the round away on purpose (duel 212 — a brief
  // defect that reached both sides, re-duelled as 213). Reviving one scores a round that was
  // deliberately discarded, for work a later duel already shipped, so the two need telling
  // apart on the surface the operator acts from. The discriminator is death_recorded: only a
  // controller's own death RECORD sets it; the displacement UPDATE never does.
  voided: boolean;
  // Present ONLY when this row was minted by a build other than the one answering right now —
  // the "a stale server minted this" signal a long-lived MCP process otherwise leaves nowhere.
  // Absent on clean rows and on pre-v15 rows (NULL mint), so existing consumers keep the shape
  // they already parse.
  versions?: string;
  // Union rows only: the side(s) whose report never landed. deathRecorded = its failure was
  // recorded with a reason (a spawn 429, a gate failure) — nothing to recover; false = nothing
  // was recorded, so a rollout or session file may still exist on its lane. Without it every
  // one-sided union read "recoverable" for seven days, spawn deaths included (duel 391 M14).
  missing?: Array<{ vendor: Vendor; deathRecorded: boolean }>;
}

// Every non-terminal or recently-lost duel, with the two things a later session needs to act:
// the id (recordResults/recordJudgment take nothing else) and the kind. Until now a duel id
// existed in exactly one place — the route_task response in a transcript that may be compacted
// or ended — so swept work was unreachable in practice even though the engine would still
// accept it. Abandoned rows age out of the LIST after a week (the row itself is untouched and
// still revivable by id): without a horizon the surface grows into noise nobody reads, which is
// this same defect through a different door. The horizon runs from the row's DEATH
// (abandoned_at, falling back to created_at for rows from before the stamp existed): aging by
// birth hid a long-dormant duel from the list at the very sweep that killed it — an 8-day-idle
// install swept a day-zero row and every pending surface omitted it immediately (duel-66 sol F6).
export function pendingDuels(db: DatabaseSync, now: number = Date.now()): PendingDuel[] {
  // landed() is openDb's SQL registration of duel.ts's landedOf — the ONE blank-side
  // predicate. The SQL spelled here before (one-arg TRIM) strips spaces only, so a '\n' side
  // was advertised reJudgeable and the judge runs spawned for it burned their single-use ids
  // against recordJudgment's refusal (duel-65 opus F4 / sol S9).
  // The abandoned horizon takes the row's LATEST clock, mirroring the router's lastDead: aging
  // by abandoned_at alone let a stale sweep stamp hide a row whose death was RECORDED a minute
  // ago — fresh corpse, invisible immediately (duel-70 sol P2). And the OLD double-failure
  // spelling — 'walkover', NULL winner, nothing landed — is still writable post-migration by
  // an already-running pre-2.6.11 process, so the pending surface recognizes the shape too:
  // revivable in principle but findable never is not a recovery surface. A union row missing
  // a side is the same story on the one status none of these branches covered (duel-74 opus
  // F1): SKILL.md union step 7 prescribes recording the recovered side on the SAME id, and
  // this listing is the only place that id survives the routing transcript.
  const rows = db.prepare(
    `SELECT id, task_kind, status, union_mode, created_at, superseded_by, decided_by,
            death_recorded, minted_by_version, anth_env, gpt_env,
            landed(anth_output) AS anthStored, landed(gpt_output) AS gptStored,
            (landed(anth_output) AND landed(gpt_output)) AS bothStored
     FROM duels
     WHERE status IN ('routed','awaiting_judgment')
        OR (status='abandoned'
            AND MAX(COALESCE(abandoned_at,0), COALESCE(recorded_at,0), created_at) >= ?)
        OR (status='walkover' AND winner_vendor IS NULL
            AND NOT landed(anth_output) AND NOT landed(gpt_output)
            AND MAX(COALESCE(recorded_at,0), created_at) >= ?)
        OR (status='union' AND NOT (landed(anth_output) AND landed(gpt_output))
            AND MAX(COALESCE(recorded_at,0), created_at) >= ?)
     ORDER BY id`,
  ).all(now - PENDING_ABANDONED_WINDOW_MS, now - PENDING_ABANDONED_WINDOW_MS,
        now - PENDING_ABANDONED_WINDOW_MS) as any[];
  const running = pluginVersion();
  return rows.map(r => ({
    // The legacy-dead shape is normalized at the recovery boundary: its raw status spells
    // 'walkover', a word every other surface uses for a SUCCESSFUL one-sided duel — and one
    // the declared PendingDuel type never admitted, hidden from tsc by this cast (duel-71,
    // found by BOTH sides). Its pending semantics are 'abandoned': dead, revivable by id.
    id: r.id, kind: r.task_kind,
    status: (r.status === 'walkover' ? 'abandoned' : r.status) as PendingDuel['status'],
    union: !!r.union_mode,
    createdAt: r.created_at,
    // recordJudgment's own revival test: abandoned + both outputs LANDED (non-blank — a blank
    // side is not judgeable, duel-64 sol #4) + not a union.
    reJudgeable: r.status === 'abandoned' && !r.union_mode && !!r.bothStored,
    supersededBy: r.superseded_by ?? null,
    // Both tombstone spellings — the column (current writers) OR decided_by='superseded'
    // (pre-2.6.12 writers, no column in their code; no backfill by design). See PendingDuel.
    displaced: r.superseded_by != null || r.decided_by === 'superseded',
    // See PendingDuel.voided: same tombstone, opposite revival rule, told apart by the marker
    // only a death RECORD writes.
    voided: (r.superseded_by != null || r.decided_by === 'superseded') && !!r.death_recorded,
    // The live half of the skew signal: this row was minted by a build the process answering
    // now is not running. Compared against pluginVersion() rather than the row's own recorded
    // stamp because THIS surface is what an operator acts from while the duel is still open —
    // a stale server that is still minting is the thing worth catching. Key omitted otherwise
    // (clean row, or pre-v15 NULL mint), so no consumer sees a new field on a healthy row.
    ...(r.minted_by_version != null && r.minted_by_version !== running
      ? { versions: `minted v${r.minted_by_version}, server v${running}` } : {}),
    ...(r.status === 'union' ? { missing: ([
      ['anthropic', r.anthStored, r.anth_env], ['openai', r.gptStored, r.gpt_env],
    ] as Array<[Vendor, number, string | null]>)
      .filter(([, stored]) => !stored)
      .map(([vendor, , env]) => ({ vendor, deathRecorded: env != null })) } : {}),
  }));
}

