import type { DatabaseSync } from 'node:sqlite';
import { accessSync, constants, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { REPORTS_DIR } from './paths.js';
import { getSetting } from './db.js';
import { passingSides } from './scoring.js';
import { landedOf } from './duel.js';
import type { Vendor } from './types.js';

export interface ReportWindow { fromMs: number; toMs: number; sessionId?: string | null }

interface ReportHooks {
  // Test seam for the file-backed two-connection race: pause after the window SELECT so a
  // competing report can claim before this connection attempts its INSERT OR IGNORE.
  onCandidatesRead?: () => void;
}

const VENDORS: Vendor[] = ['anthropic', 'openai'];

// Structural baseline for the fairness section: what each lane can reach beyond the model
// itself. The recorded per-side env notes refine this; model/effort are the duel's essence
// and are never judged here.
const LANE_CAPS: Record<string, string> = {
  A: "main-session Agent spawn — full Claude Code toolset + the session's MCP servers",
  B: 'headless Claude Code on the offload account — full toolset + MCP of its config dir',
  codex: 'codex CLI — its own tool sandbox, no Claude-side MCP servers',
  spark: 'codex CLI (spark runner) — same sandbox as the codex lane',
};

const RATIONALE_GAP = '(rationale not recorded — pre-v2.13 vote or controller skipped it)';

const fmt = (ms: number | null | undefined): string => {
  if (ms == null || ms < 0) return 'n/a';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

// Relative margin against the SLOWER clock: "34% faster" = the winner spent 34% less time
// than the loser's total.
const marginPct = (a: number, b: number): number =>
  Math.round((Math.abs(a - b) / Math.max(a, b)) * 100);

interface JRow {
  judge_vendor: Vendor; verdict: string; rationale: string | null;
  proof: string | null; created_at: number; graded: number;
  grade_x: string | null; grade_y: string | null; path: string | null;
  brief_defect: string | null; judge_serena_calls: number | null;
}

function gradeText(verdict: string, labelMap: Record<string, Vendor>, graded: number): string {
  // A legacy vote answered "which is better", not "what meets the bar" — the same token, a
  // different question; decoding it in bar language would fabricate a quality claim.
  if (!graded) {
    return (verdict === 'X' || verdict === 'Y')
      ? `preferred ${verdict} (${labelMap[verdict]}) — pre-v2.11 preference vote`
      : `pre-v2.11 preference vote '${verdict}'`;
  }
  switch (verdict) {
    case 'both': case 'tie': return 'both sides met the bar';
    case 'neither': return 'neither side met the bar';
    case 'X': case 'Y': {
      const other = verdict === 'X' ? 'Y' : 'X';
      return `only ${verdict} (${labelMap[verdict]}) met the bar — failed ${other} (${labelMap[other]})`;
    }
    default: return `unrecognized grade '${verdict}'`;
  }
}

// The one plain-language line stating WHY the result is what it is, per decided_by.
function resultLines(d: Record<string, unknown>, js: JRow[],
  labelMap: Record<string, Vendor>): string[] {
  const out: string[] = [];
  const aL = d.anth_latency_ms as number | null;
  const gL = d.gpt_latency_ms as number | null;
  switch (d.decided_by) {
    case 'judges': {
      out.push(`**Quality win for ${d.winner_vendor}.**`);
      const loserLabel = labelMap.X === d.winner_vendor ? 'Y' : 'X';
      const failers = js.filter(j => !passingSides(j.verdict).has(loserLabel as 'X' | 'Y'))
        .map(j => `${j.judge_vendor} judge`);
      out.push(`Decisive fact: ${failers.join(' and ') || 'the stored grades'} failed `
        + `${loserLabel} (${labelMap[loserLabel]}); a side passes only when NEITHER judge fails it.`);
      break;
    }
    case 'latency':
      out.push('**Both sides met the quality bar; the clock decided:** '
        + `${fmt(aL)} vs ${fmt(gL)} — ${d.winner_vendor} ${marginPct(aL!, gL!)}% faster.`);
      break;
    case 'both_failed':
      out.push('**Nothing met the bar** — both sides failed (judges agreed, or both '
        + 'build/test gates failed). Discard both; the task was re-run or re-dueled.');
      break;
    case 'contested':
      out.push('**Judges failed different sides** — proves nothing about either side; '
        + 'a signal about the JUDGES.');
      break;
    case 'unresolved':
      out.push('**Both correct; clock could not separate them** (tie, missing clock, or '
        + 'token floor). Either may ship.');
      break;
    case 'merge':
      out.push('**Merged ship — both sides met the bar and both judges directed a '
        + 'composition.** No winner is credited; the controller\'s merged artifact must pass '
        + 'the deciding gate before it ships.');
      break;
    case 'union':
      // landedOf, not truthiness: a side holding blank error text is not a landed report.
      out.push('**Union run — merge shipped, no contest.** Sides landed: '
        + VENDORS.filter(v => landedOf(d[v === 'anthropic' ? 'anth_output' : 'gpt_output'])).join(', '));
      break;
    case 'walkover':
      out.push(`**Walkover — ${d.winner_vendor} shipped unjudged**: the other side failed or hung.`);
      break;
    case 'superseded':
      // A void is a deliberate discard (a brief defect that reached both sides, duel 212),
      // not two hung lanes — and the engine refuses its revival since v2.13.66.
      out.push('**Voided — the controller discarded this round on purpose** (a defect that '
        + `reached both sides), re-duelled as #${d.superseded_by ?? '?'}; never revive it. `
        + 'The reason is in the env notes under Fairness.');
      break;
    case 'abandoned':
      // "both sides dead" is the shape, not the reason, and it reads as two hung lanes even
      // when the controller deliberately voided a sound round (duel 212). The reason lives in
      // the per-side env notes, which a failed side can now actually store.
      out.push('**Abandoned** — no side landed; row is death-stamped, revivable by id. '
        + 'Read the recorded env notes under Fairness for WHY before reviving it.');
      break;
    default:
      out.push(`Status: ${d.status} — ${d.status === 'routed'
        ? 'routed, no results recorded yet' : `decided_by=${d.decided_by ?? 'n/a'}`}.`);
  }
  return out;
}

function fairnessLines(d: Record<string, unknown>): string[] {
  const sides = JSON.parse(d.sides as string) as
    { vendor: string; lane: string; model: string; effort: string | null }[];
  const out = sides.map(s =>
    `- ${s.vendor} baseline (lane ${s.lane}): ${LANE_CAPS[s.lane] ?? 'unknown lane'}`);
  const a = (d.anth_env as string | null)?.trim() || null;
  const g = (d.gpt_env as string | null)?.trim() || null;
  if (a) out.push(`- anthropic recorded env: ${a}`);
  if (g) out.push(`- openai recorded env: ${g}`);
  // v2.13.84: the engine-attested serena counts (v2.13.82, duel 409) — the number the operator's
  // serena-for-codex rule ("if it changes results, give it to codex") is read against, so it
  // belongs beside the env notes rather than inside them. Rows recorded before the column print
  // nothing: NULL is "unknown", never zero.
  const sa = (d.anth_serena_calls as number | null | undefined) ?? null;
  const sg = (d.gpt_serena_calls as number | null | undefined) ?? null;
  if (sa != null || sg != null) {
    out.push(`- serena calls (attested): anthropic ${sa ?? 'n/a'}, openai ${sg ?? 'n/a'}`);
  }
  if (!a && !g) out.push('- verdict: fair fight (no recorded asymmetry)');
  else if (!a || !g) {
    out.push(`- verdict: incomplete env record — ${!a ? 'anthropic' : 'openai'} side unrecorded`);
  } else if (a === g) out.push('- verdict: fair fight (recorded envs match)');
  else out.push('- verdict: asymmetry — review the two env notes above');
  return out;
}

// ponytail: cwd-relative scratch links; the hook runs in the session's project dir, which is
// where the controller writes .review-scratch. A duel recorded from another cwd just gets
// no links.
function scratchLinks(id: number): string[] {
  try {
    return readdirSync('.review-scratch').filter(f => f.startsWith(`duel${id}-`))
      .map(f => join('.review-scratch', f)).sort();
  } catch { return []; }
}

function buildSessionReportInternal(
  db: DatabaseSync, w: ReportWindow, hooks: ReportHooks,
  persist?: (markdown: string) => void,
): string | null {
  // Reports record outcomes: an in-flight row (the stale-sweep's non-terminal pair) is invisible
  // to every report surface and never claimed, so the report that sees it is the one built after
  // it closes — a session-close claim of a live duel buried its results forever (duels 251, 258).
  const candidates = db.prepare(
    "SELECT * FROM duels WHERE created_at BETWEEN ? AND ? "
    + "AND status NOT IN ('routed','awaiting_judgment') ORDER BY id",
  ).all(w.fromMs, w.toMs) as Record<string, unknown>[];
  if (!candidates.length) return null;

  hooks.onCandidatesRead?.();
  let duels = candidates;
  const excludedBySession = new Map<string, number>();
  let claimTransactionOpen = false;
  try {
    if (w.sessionId) {
      const insertClaim = db.prepare(
        'INSERT OR IGNORE INTO report_claims(duel_id, session_id, claimed_at) VALUES (?,?,?)');
      const claimOwner = db.prepare(
        'SELECT session_id FROM report_claims WHERE duel_id=?');
      const included: Record<string, unknown>[] = [];
      // Serialize each report's claim pass. The PRIMARY KEY chooses the first writer; after a
      // racing writer commits, the loser enters, its insert is ignored, and this same transaction
      // reads the immutable winner before deciding whether the duel can reach any report surface.
      // The transaction stays open through the file write: preview-only builds roll it back, and
      // a real report commits only after persist() has returned successfully.
      db.exec('BEGIN IMMEDIATE');
      claimTransactionOpen = true;
      const claimedAt = Date.now();
      for (const duel of candidates) {
        insertClaim.run(duel.id as number, w.sessionId, claimedAt);
        const owner = claimOwner.get(duel.id as number) as { session_id: string } | undefined;
        if (!owner) throw new Error(`report claim missing after insert for duel ${duel.id}`);
        if (owner.session_id === w.sessionId) included.push(duel);
        else excludedBySession.set(owner.session_id,
          (excludedBySession.get(owner.session_id) ?? 0) + 1);
      }
      duels = included;
    }
    const judgeRows = (id: unknown): JRow[] => db.prepare(
      'SELECT judge_vendor, verdict, rationale, proof, created_at, graded, grade_x, grade_y, '
      + 'path, brief_defect, judge_serena_calls FROM judgments WHERE duel_id=? ORDER BY id')
      .all(id as number) as unknown as JRow[];

  const tally = { quality: { anthropic: 0, openai: 0 }, latency: { anthropic: 0, openai: 0 } };
  const counts: Record<string, number> = {};
  const wall = { anthropic: 0, openai: 0 };
  const margins: number[] = [];
  let idleTotal = 0;
  const blocks: string[] = [];

  for (const d of duels) {
    const js = judgeRows(d.id);
    const labelMap = JSON.parse(d.label_map as string) as Record<string, Vendor>;
    const key = (d.decided_by as string | null) ?? (d.status as string);
    counts[key] = (counts[key] ?? 0) + 1;
    if (d.decided_by === 'judges') tally.quality[d.winner_vendor as Vendor]++;
    if (d.decided_by === 'latency') tally.latency[d.winner_vendor as Vendor]++;
    const aL = d.anth_latency_ms as number | null;
    const gL = d.gpt_latency_ms as number | null;
    if (aL != null) wall.anthropic += aL;
    if (gL != null) wall.openai += gL;
    if (aL != null && gL != null) margins.push(marginPct(aL, gL));

    const created = d.created_at as number;
    const outputsAt = d.outputs_at as number | null;
    const execSpan = outputsAt != null ? outputsAt - created : null;
    const maxLat = Math.max(aL ?? 0, gL ?? 0);
    const idle = execSpan != null && maxLat > 0 ? Math.max(0, execSpan - maxLat) : null;
    const lastVote = js.length ? Math.max(...js.map(j => j.created_at)) : null;
    // recorded_at is record_duel's clock and predates judging; the votes' own timestamps are
    // the only observable judging clock (judge latencies are not stored).
    const judgeSpan = lastVote != null && outputsAt != null
      ? Math.max(0, lastVote - outputsAt) : null;
    if (idle != null) idleTotal += idle;
    if (judgeSpan != null) idleTotal += judgeSpan;

    const sides = JSON.parse(d.sides as string) as
      { vendor: string; lane: string; model: string; effort: string | null }[];
    const flagBits = [d.union_mode ? 'union' : 'duel',
      d.spot_check ? 'spot-check' : null, d.mutating ? 'mutating' : null].filter(Boolean);
    const lines: string[] = [];
    lines.push(`## Duel #${d.id} — ${d.task_kind} (${flagBits.join(', ')}; status: ${d.status})`);
    lines.push('');
    lines.push(...sides.map(s =>
      `- ${s.vendor}: ${s.model}${s.effort ? '@' + s.effort : ''} on lane ${s.lane}`));
    // Printed only when the row itself proves the server changed under it: a long-lived MCP
    // process serves whatever dist/ it started with, and a pre-2.13.2 one minted the float
    // latencies v12 had to repair. Silent when the two builds agree and silent for a pre-v15
    // NULL, so a legacy row's report is unchanged.
    const minted = d.minted_by_version as string | null;
    const recorded = d.recorded_by_version as string | null;
    if (minted && recorded && minted !== recorded) {
      lines.push(`- server skew: minted v${minted}, recorded v${recorded}`);
    }
    lines.push('');
    lines.push(...resultLines(d, js, labelMap));
    if (js.length) {
      lines.push('', '**Judgments:**');
      for (const j of js) {
        lines.push(`- ${j.judge_vendor} judge: ${gradeText(j.verdict, labelMap, j.graded)}`
          + `${j.proof ? ` (proof ${j.proof})` : ''}`);
        // v2.13.28: letters beside the verdict — the durable per-date record GPA trends are
        // read from. A vote without letters prints nothing: no grades were given.
        if (j.grade_x != null && j.grade_y != null) {
          lines.push(`  - grades: X (${labelMap.X}) ${j.grade_x}, Y (${labelMap.Y}) ${j.grade_y}`);
        }
        // v2.13.29: the vote's path recommendation — advisory unless both votes said 'merge'.
        if (j.path != null) lines.push(`  - path: ${j.path}`);
        // v2.13.84: the judge's own attested serena count — a zero on a code duel is the
        // calibration signal SKILL tells the controller to note beside the vote.
        if (j.judge_serena_calls != null) {
          lines.push(`  - serena calls (attested): ${j.judge_serena_calls}`);
        }
        // v2.13.44: the vote's brief-defect flag — the quoted clause the judge traced a split
        // to. A contested row carrying one is a brief problem, not a model problem.
        if (j.brief_defect != null) lines.push(`  - brief defect flagged: "${j.brief_defect}"`);
        lines.push(`  - rationale: ${j.rationale ?? RATIONALE_GAP}`);
      }
    }
    lines.push('', '**Timing:**');
    const pend = (v: string | null) => v ?? 'n/a (pending)';
    lines.push(`- wall clock: anthropic ${fmt(aL)}, openai ${fmt(gL)}`
      + (aL != null && gL != null
        ? ` — ${aL === gL ? 'tied' : `${aL < gL ? 'anthropic' : 'openai'} ${marginPct(aL, gL)}% faster`}`
        : ''));
    lines.push(`- tokens: anthropic ${d.anth_tokens ?? 'n/a'}, openai ${d.gpt_tokens ?? 'n/a'}`);
    lines.push(`- execution span ${pend(execSpan != null ? fmt(execSpan) : null)}, `
      + `idle ${pend(idle != null ? fmt(idle) : null)}, `
      + `judging span ${pend(judgeSpan != null ? fmt(judgeSpan) : null)}`);
    lines.push('', '**Fairness:**');
    lines.push(...fairnessLines(d));
    const links = scratchLinks(d.id as number);
    if (links.length) lines.push('', '**Artifacts:** ' + links.join(', '));
    blocks.push(lines.join('\n'));
  }

  const avgMargin = margins.length
    ? Math.round(margins.reduce((s, m) => s + m, 0) / margins.length) : null;
  const notices = w.sessionId
    ? [...excludedBySession.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([sessionId, count]) =>
        `excluded: ${count} duel(s) claimed by session ${sessionId.slice(0, 8)} report(s)`)
    : ['caveat: sessionless window; overlapping-session double-counting is possible'];
  const head = [
    `# Session duel report — ${new Date(w.fromMs).toISOString().slice(0, 10)}`
      + (w.sessionId ? ` (session ${w.sessionId.slice(0, 8)})` : ''),
    '',
    `Window: ${new Date(w.fromMs).toISOString()} → ${new Date(w.toMs).toISOString()} | duels: ${duels.length}`,
    ...notices,
    '',
    `- quality wins (judges): anthropic ${tally.quality.anthropic}, openai ${tally.quality.openai}`,
    `- latency wins (both passed, clock decided): anthropic ${tally.latency.anthropic}, openai ${tally.latency.openai}`,
    '- other outcomes: ' + (['both_failed', 'contested', 'unresolved', 'merge', 'walkover',
      'union', 'superseded', 'abandoned']
      .filter(k => counts[k]).map(k => `${k} ${counts[k]}`).join(', ') || 'none'),
    `- recorded wall clock: anthropic ${fmt(wall.anthropic)}, openai ${fmt(wall.openai)}`
      + (avgMargin != null ? ` | average per-duel latency margin ${avgMargin}%` : ''),
    `- idle overhead (spawn/controller gaps + judging spans): ${fmt(idleTotal)}`,
    '',
  ];
    const markdown = head.join('\n') + '\n' + blocks.join('\n\n') + '\n';
    persist?.(markdown);
    if (claimTransactionOpen) {
      db.exec(persist ? 'COMMIT' : 'ROLLBACK');
      claimTransactionOpen = false;
    }
    return markdown;
  } catch (e) {
    if (claimTransactionOpen) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original build/write failure */ }
    }
    throw e;
  }
}

// A builder is a preview: it may temporarily claim rows to render the exact winner/exclusion
// view, but no claim becomes durable until writeSessionReport persists those bytes.
export function buildSessionReport(
  db: DatabaseSync, w: ReportWindow, hooks: ReportHooks = {},
): string | null {
  return buildSessionReportInternal(db, w, hooks);
}

export function writeSessionReport(
  db: DatabaseSync, w: ReportWindow, hooks: ReportHooks = {},
): string | null {
  const name = `${new Date(w.fromMs).toISOString().slice(0, 10)}-`
    + `${w.sessionId ? w.sessionId.slice(0, 8) : `window-${w.fromMs}`}.md`;
  const path = join(REPORTS_DIR, name);
  const md = buildSessionReportInternal(db, w, hooks, markdown => {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(path, markdown);
  });
  return md == null ? null : path;
}

const hasCmd = (c: string): boolean => (process.env.PATH ?? '').split(':').some(d => {
  try { accessSync(join(d, c), constants.X_OK); return true; } catch { return false; }
});

export function resolveOpenCmd(setting: string | null, has: (c: string) => boolean = hasCmd): string {
  if (setting && setting !== 'auto') return setting;
  return has('idea') ? 'idea' : 'xdg-open';
}

// The pop-up. Reports are always written; ONLY this is toggled (report_autopop, absent = on).
// Detached + ignored stdio so the editor survives the dying terminal that ran the hook.
export function maybeOpen(db: DatabaseSync, path: string,
  deps: { spawnFn?: typeof spawn; has?: (c: string) => boolean } = {}): boolean {
  if ((getSetting(db, 'report_autopop') ?? 'on') === 'off') return false;
  const cmd = resolveOpenCmd(getSetting(db, 'report_open_cmd'), deps.has);
  try {
    const child = (deps.spawnFn ?? spawn)(cmd, [path], { detached: true, stdio: 'ignore' });
    // Async spawn errors (ENOENT) surface as an 'error' event; unhandled it kills the process.
    (child as { on?: (e: string, f: () => void) => void }).on?.('error', () => {});
    (child as { unref?: () => void }).unref?.();
    return true;
  } catch {
    console.error(`[model-routing] report open failed: ${cmd}`);
    return false;
  }
}

// First "timestamp" in the transcript JSONL = session start. ponytail: reads the whole file
// for one regex hit; slice to a head-read if multi-MB transcripts ever measure slow here.
export function sessionWindowStart(transcriptPath: string): number | null {
  let text: string;
  try { text = readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const m = text.match(/"timestamp"\s*:\s*"([^"]+)"/);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}
