#!/usr/bin/env node
import {
  accessSync, closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync,
  realpathSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { lintBrief } from './brieflint.js';
import { openDb, setSetting } from './db.js';
import { maybeOpen, sessionWindowStart, writeSessionReport } from './report.js';
import { HARD_PCT, SOFT_PCT, laneStatus } from './quota/pace.js';
import { latestSnapshot, pollAll, reauthNeeded } from './quota/poll.js';
import { expireStaleDuels, headOnSplit, subagentTranscripts } from './duel.js';
import { canonicalKind, logChange, renderMarkdown, seedMatrix, setUnionMode } from './matrix.js';
import { standings, pendingDuels } from './standings.js';
import { importScorecard } from './outcomes.js';
import { laneLabel, writeMatrixDoc } from './cli-lib.js';
import { buildBPackage, buildCodexLaunch } from './launch.js';
import { tokensOf } from './tokens.js';
import type { Lane } from './types.js';

const TEXT_INPUT_CAP = 2_000_000;
const TOKEN_ARTIFACT_CAP = 1_000_000_000;

// Caller-named CLI inputs use one descriptor from validation through read. O_NOFOLLOW makes the
// final-component symlink check atomic, O_NONBLOCK prevents a FIFO/device open from hanging, and
// the fixed allocation/read length keeps a concurrently growing regular file within the cap.
export function readBoundedTextFile(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('is a symlink');
    }
    throw new Error(`is unreadable — ${e instanceof Error ? e.message : e}`);
  }
  try {
    let st;
    try { st = fstatSync(fd); } catch (e) {
      throw new Error(`is unreadable — ${e instanceof Error ? e.message : e}`);
    }
    if (!st.isFile()) throw new Error('is not a regular file');
    if (st.size > maxBytes) throw new Error(`is ${st.size} bytes (cap ${maxBytes})`);
    const bytes = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readTokenArtifacts(
  paths: string[],
  warn: (warning: string) => void = warning => writeSync(2, `${warning}\n`),
): Array<{ path: string; text: string }> {
  // A parent's usage excludes its children; serena has followed them since v2.13.87,
  // and token accounting now does the same.
  const expandedPaths = paths.flatMap(path => [path, ...subagentTranscripts(path)]);
  return expandedPaths.map(path => {
    try {
      return { path, text: readBoundedTextFile(path, TOKEN_ARTIFACT_CAP) };
    } catch (e) {
      const warning = `[model-routing] tokens cannot read ${path}: ${(e as Error).message}`
        .replace(/[\r\n]+/g, ' ');
      warn(warning);
      return { path, text: '' };
    }
  });
}

export function findNestedCodexLaunch(prompt: string): string | null {
  let fence: '`' | '~' | null = null;
  for (const line of prompt.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      const kind = marker[1][0] as '`' | '~';
      if (fence === null) fence = kind;
      else if (fence === kind) fence = null;
      continue;
    }
    if (fence === null && /^\s*(?:nohup\s+)?codex\s+exec\b/.test(line)) return line.trim();
  }
  return null;
}

export function serenaLedger(db: DatabaseSync): string[] {
  const rows = db.prepare(
    `SELECT d.id, d.task_kind, d.status, d.winner_vendor, d.decided_by,
            d.anth_serena_calls, d.gpt_serena_calls
       FROM duels d
      WHERE d.anth_serena_calls IS NOT NULL OR d.gpt_serena_calls IS NOT NULL
         OR EXISTS (SELECT 1 FROM judgments j
                    WHERE j.duel_id=d.id AND j.judge_serena_calls IS NOT NULL)
      ORDER BY d.id`,
  ).all() as Array<{
    id: number;
    task_kind: string;
    status: string;
    winner_vendor: string | null;
    decided_by: string | null;
    anth_serena_calls: number | null;
    gpt_serena_calls: number | null;
  }>;
  if (!rows.length) return ['no attested serena counts yet'];

  const judgments = db.prepare(
    `SELECT judge_vendor, judge_serena_calls FROM judgments
      WHERE duel_id=? AND judge_vendor IN ('anthropic','openai')`,
  );
  const lines = rows.map(row => {
    // Bind a JS number: SQL-side concatenation would render an integer id as "1.0".
    const votes = judgments.all(Number(row.id)) as Array<{
      judge_vendor: string;
      judge_serena_calls: number | null;
    }>;
    const judgeCount = (vendor: string): number | 'n/a' =>
      votes.find(vote => vote.judge_vendor === vendor)?.judge_serena_calls ?? 'n/a';
    const outcome = (row.winner_vendor ?? row.status)
      + (row.decided_by !== null ? `/${row.decided_by}` : '');
    return `#${row.id} ${row.task_kind} — ${outcome} — sides: `
      + `anthropic ${row.anth_serena_calls ?? 'n/a'}, openai ${row.gpt_serena_calls ?? 'n/a'} — `
      + `judges: anthropic ${judgeCount('anthropic')}, openai ${judgeCount('openai')}`;
  });
  const judged = rows.filter(row => row.status === 'judged' && row.anth_serena_calls !== null);
  const anthropicWins = judged.filter(row => row.winner_vendor === 'anthropic').length;
  const openaiWins = judged.filter(row => row.winner_vendor === 'openai').length;
  lines.push(`${rows.length} duel(s) with an attested serena count; `
    + `judged with an anthropic side count: ${judged.length} — `
    + `anthropic ${anthropicWins}, openai ${openaiWins}`);
  return lines;
}

// The engine records duels and judgments but never analysed them: the 2026-09-05 retrospective on
// gpt-5.6-sol was hand SQL over both tables, and gpt-6-astra's era is due the same cuts once its
// duels accrue. Read-only, one contestant era per call, shaped like serenaLedger above.
export function calibrationLedger(db: DatabaseSync, gptModel: string): string[] {
  const VENDORS = ['anthropic', 'openai'];
  // Highest first, so a grade's index IS its rank and "higher" is the smaller index.
  const GRADES = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];
  type Row = {
    id: number;
    sides: string;
    label_map: string;
    status: string;
    decided_by: string | null;
    winner_vendor: string | null;
    anth_latency_ms: number | null;
    gpt_latency_ms: number | null;
    anth_env: string | null;
    gpt_env: string | null;
  };
  type Vote = {
    judge_vendor: string;
    verdict: string;
    grade_x: string | null;
    grade_y: string | null;
    brief_defect: string | null;
  };

  const rows = db.prepare(
    `SELECT id, sides, label_map, status, decided_by, winner_vendor,
            anth_latency_ms, gpt_latency_ms, anth_env, gpt_env
       FROM duels
      ORDER BY id`,
  ).all() as Row[];
  // Era membership is the openai side's model inside the sides JSON. That column has held
  // hand-written and legacy shapes, so a parse throw, a non-array, and an array with no openai
  // element all put the row OUTSIDE every era rather than silently into this one.
  const era = rows.filter(row => {
    let sides: unknown;
    try { sides = JSON.parse(row.sides); } catch { return false; }
    return Array.isArray(sides) && sides.some((side: unknown) =>
      typeof side === 'object' && side !== null
      && (side as { vendor?: unknown }).vendor === 'openai'
      && (side as { model?: unknown }).model === gptModel);
  });
  if (!era.length) return [`no duels against ${gptModel} yet`];

  const judgments = db.prepare(
    `SELECT judge_vendor, verdict, grade_x, grade_y, brief_defect FROM judgments
      WHERE duel_id=? AND judge_vendor IN ('anthropic','openai')`,
  );
  // Bind a JS number: SQL-side concatenation would render an integer id as "1.0".
  const votes = new Map<Row, Vote[]>(
    era.map(row => [row, judgments.all(Number(row.id)) as Vote[]]));
  const voteBy = (row: Row, vendor: string): Vote | undefined =>
    (votes.get(row) ?? []).find(vote => vote.judge_vendor === vendor);
  const castBy = (vendor: string): Array<[Row, Vote]> => era.flatMap(row => {
    const vote = voteBy(row, vendor);
    return vote ? [[row, vote] as [Row, Vote]] : [];
  });

  // A label is worth only the vendor it resolves to: a `{}` map, an unknown spelling or a parse
  // throw leaves it unresolved, which costs the row its picks and its graded votes.
  const labelsOf = (row: Row): Record<string, unknown> => {
    let map: unknown;
    try { map = JSON.parse(row.label_map); } catch { return {}; }
    return typeof map === 'object' && map !== null ? map as Record<string, unknown> : {};
  };
  const resolved = (row: Row, label: string): string | undefined => {
    const vendor = labelsOf(row)[label];
    return typeof vendor === 'string' && VENDORS.includes(vendor) ? vendor : undefined;
  };
  const pick = (row: Row, vote: Vote): string | undefined =>
    vote.verdict === 'X' || vote.verdict === 'Y' ? resolved(row, vote.verdict) : undefined;

  const STATUSES = ['judged', 'unresolved', 'walkover', 'union', 'abandoned'];
  const lines = [`era ${gptModel}: ${era.length} duel(s) — `
    + STATUSES.map(s => `${s} ${era.filter(row => row.status === s).length}`).join(', ')
    + `, other ${era.filter(row => !STATUSES.includes(row.status)).length}`];

  const wins = era.filter(row => row.status === 'judged'
    && row.winner_vendor !== null && VENDORS.includes(row.winner_vendor));
  const how = (row: Row): string =>
    row.decided_by === 'judges' ? 'judges' : row.decided_by === 'latency' ? 'latency' : 'other';
  const winsBy = (vendor: string, way: string): number =>
    wins.filter(row => row.winner_vendor === vendor && how(row) === way).length;
  lines.push('judged wins: '
    + VENDORS.map(v => `${v} ${wins.filter(row => row.winner_vendor === v).length}`).join(', ')
    + ' — ' + ['judges', 'latency', 'other'].map(way =>
      `by ${way} ${winsBy('anthropic', way)}/${winsBy('openai', way)}`).join(', '));

  // The retrospective's sole-decider share: the winner's own judge picked it while the other
  // judge voted `both`. Anything that is neither unanimous nor one of the two sole-decider
  // shapes falls to `other` — a `tie`, a missing vote, an unresolvable label.
  const shapeOf = (row: Row, winner: string): string => {
    const own = voteBy(row, winner);
    const opp = voteBy(row, winner === 'anthropic' ? 'openai' : 'anthropic');
    if (!own || !opp) return 'other';
    if (pick(row, own) === winner && pick(row, opp) === winner) return 'unanimous';
    if (pick(row, own) === winner && opp.verdict === 'both') return 'own-judge-alone';
    if (pick(row, opp) === winner && own.verdict === 'both') return 'other-judge-alone';
    return 'other';
  };
  const SHAPES = ['unanimous', 'own-judge-alone', 'other-judge-alone', 'other'];
  const decided = wins.filter(row => how(row) === 'judges');
  lines.push('judges-decided wins: ' + VENDORS.map(vendor =>
    `${vendor} ${winsBy(vendor, 'judges')} — ` + SHAPES.map(shape =>
      `${shape} ${decided.filter(row =>
        row.winner_vendor === vendor && shapeOf(row, vendor) === shape).length}`).join(', '),
  ).join('; '));

  for (const vendor of VENDORS) {
    const cast = castBy(vendor);
    const count = (test: (row: Row, vote: Vote) => boolean): number =>
      cast.filter(([row, vote]) => test(row, vote)).length;
    const both = count((_row, vote) => vote.verdict === 'both');
    const neither = count((_row, vote) => vote.verdict === 'neither');
    const passes = VENDORS.map(target => count((row, vote) => pick(row, vote) === target));
    // `other` is the remainder: `both`, `neither` and the two picks are mutually exclusive, so a
    // `tie`, an unknown token and an X/Y whose label never resolved are exactly what is left.
    lines.push(`votes ${vendor} judge: ${cast.length} — both ${both}, `
      + VENDORS.map((target, i) => `passes ${target} ${passes[i]}`).join(', ')
      + `, neither ${neither}, `
      + `other ${cast.length - both - neither - passes[0] - passes[1]}`);
  }

  const bothVoted = era.filter(row => voteBy(row, 'anthropic') && voteBy(row, 'openai'));
  const agreed = bothVoted.filter(row =>
    voteBy(row, 'anthropic')?.verdict === voteBy(row, 'openai')?.verdict).length;
  lines.push(bothVoted.length
    ? `judge agreement: ${Math.round(100 * agreed / bothVoted.length)}% `
      + `of ${bothVoted.length} duel(s) with both votes`
    : 'judge agreement: n/a (no duel with both votes)');

  // A NULL brief_defect is no flag; only a non-empty string is one.
  lines.push('brief-defect flags: ' + VENDORS.map(vendor =>
    `${vendor} judge ${castBy(vendor).filter(([, vote]) =>
      typeof vote.brief_defect === 'string' && vote.brief_defect !== '').length}`).join(', '));

  // A vote grades own-vs-other only when both grades are on the scale AND the two labels name
  // two DIFFERENT vendors, one of them the judge's own — otherwise "own" has no referent.
  const graded = (row: Row, vote: Vote): { own: string; other: string } | undefined => {
    const gx = vote.grade_x;
    const gy = vote.grade_y;
    if (gx === null || gy === null || !GRADES.includes(gx) || !GRADES.includes(gy)) return undefined;
    const vx = resolved(row, 'X');
    const vy = resolved(row, 'Y');
    if (vx === undefined || vy === undefined || vx === vy) return undefined;
    if (vote.judge_vendor === vx) return { own: gx, other: gy };
    if (vote.judge_vendor === vy) return { own: gy, other: gx };
    return undefined;
  };
  lines.push('own-vendor grading: ' + VENDORS.map(vendor => {
    const marks = castBy(vendor).flatMap(([row, vote]) => {
      const mark = graded(row, vote);
      return mark ? [mark] : [];
    });
    const higher = marks.filter(m => GRADES.indexOf(m.own) < GRADES.indexOf(m.other)).length;
    const equal = marks.filter(m => m.own === m.other).length;
    return `${vendor} judge higher ${higher}, equal ${equal}, `
      + `lower ${marks.length - higher - equal} of ${marks.length} graded vote(s)`;
  }).join('; '));

  const ratios = era.flatMap(row => {
    const anth = row.anth_latency_ms;
    const gpt = row.gpt_latency_ms;
    return row.status === 'judged' && typeof anth === 'number' && anth > 0
      && typeof gpt === 'number' && gpt > 0 ? [anth / gpt] : [];
  }).sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  lines.push(ratios.length
    ? `latency ratio anthropic:openai: median ${median.toFixed(2)} `
      + `over ${ratios.length} judged duel(s)`
    : 'latency ratio anthropic:openai: n/a (no judged duel with both clocks)');

  // Live env strings read "0 sub-agents", "no sub-agents", "fanned out 2 sub-agent rollouts",
  // "5 parallel subagents", "sub-agents: 0". The word boundaries are what keep "subagent_tokens"
  // and "sub_agent_activity" — which carry no count — out of the fanned/solo split.
  const fanOut = (env: string | null): string => {
    if (env === null) return 'unknown';
    if (/\bno sub-?agents?\b/i.test(env)) return 'solo';
    const m = /(\d+)(?:\s+\w+){0,2}\s+sub-?agents?\b/i.exec(env)
      ?? /sub-?agents?:\s*(\d+)/i.exec(env);
    if (!m) return 'unknown';
    return Number(m[1]) > 0 ? 'fanned' : 'solo';
  };
  const CLASSES = ['fanned', 'solo', 'unknown'];
  const envOf: Record<string, (row: Row) => string | null> = {
    anthropic: row => row.anth_env,
    openai: row => row.gpt_env,
  };
  lines.push('fan-out: ' + VENDORS.map(vendor => `${vendor} ` + CLASSES.map(cls =>
    `${cls} ${era.filter(row => fanOut(envOf[vendor](row)) === cls).length}`).join(', '),
  ).join('; '));

  return lines;
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
const [cmd, ...rest] = argv;
const flags = new Set(rest.filter(a => a.startsWith('--')));
const args = rest.filter(a => !a.startsWith('--'));
// The SessionStart hook runs this. An unreadable/corrupt DB used to dump a node stack trace
// straight into the session context; one line and a clean exit is all that belongs there.
function open(): { db: DatabaseSync; seeded: number } {
  try {
    const db = openDb();
    return { db, seeded: seedMatrix(db) }; // idempotent — a fresh DB never throws 'not seeded'
  } catch (e) {
    // writeSync, not console.*: process.exit right after a console write can drop the line on
    // platforms where pipe writes are asynchronous (macOS) — restoring exactly the invisible
    // refusal this block exists to prevent (duel-74 opus F3). writeSync drains before return.
    writeSync(2, `[model-routing] engine unavailable: ${(e as Error).message}\n`);
    // The SessionStart hook reads ONLY stdout — a refusal on stderr alone left the session
    // indistinguishable from a healthy one with an empty dashboard: no lane lines, no pending
    // ids, no sweep (duel-73 opus F2). The one path that runs every session carries the reason.
    // matrix.md is named conditionally: every writer of that file needs an open DB first, so
    // on a fresh install the fallback that always exists is SKILL.md's seed (duel-74 opus F2).
    if (cmd === 'quota') {
      writeSync(1, `[model-routing] engine unavailable: ${(e as Error).message} — routing falls `
        + 'back to matrix.md if an earlier session wrote one, else to the SKILL.md seed '
        + 'pairings, until the DB opens\n');
    }
    // Exit 0 only on the hook path, where a non-zero status turns a dead DB into a session
    // error banner. A scripted `import-scorecard`/`matrix --render` must still see a failure.
    // The SessionEnd hook path gets the same courtesy: a dead DB must never turn a closing
    // session into an error banner.
    process.exit(cmd === 'quota' || (cmd === 'report' && flags.has('--session-end')) ? 0 : 1);
  }
}
// Brief linting, launch assembly, and artifact token counting are filesystem checks, so none may
// depend on opening or seeding the routing database. Every other command follows the eager path.
const engine = cmd === 'brief-lint' || cmd === 'launch' || cmd === 'tokens' ? null : open();
const db = engine?.db as DatabaseSync;
const seeded = engine?.seeded ?? 0;
const LANES: Lane[] = ['A', 'B', 'codex', 'spark'];

// One line, ids + kinds + status: the whole point is that this reaches session context (via the
// hook's stdout) and a human (via `mrctl status`), so a swept or in-flight duel is reachable by
// id in the NEXT session, not just in the transcript turn that routed it.
function pendingLine(now: number): string | null {
  const p = pendingDuels(db, now);
  if (!p.length) return null;
  // A pre-2.6.12 writer stamps the tombstone spelling but not the column, so the displaced
  // marker must print even when no recording duel id is known (duel-75 opus F1). A VOID wears
  // that same tombstone and carries the OPPOSITE revival rule, so it says so in words — this
  // line is where an operator decides whether to revive a dead row (duel 212).
  const mark = (r: ReturnType<typeof pendingDuels>[number]): string =>
    r.voided ? ` (VOIDED${r.supersededBy != null ? `, re-duelled as #${r.supersededBy}` : ''} `
      + '— never revive)'
      : r.supersededBy != null ? ` (displaced by #${r.supersededBy})`
        : r.displaced ? ' (displaced)' : '';
  // A one-sided union names its missing side: a recorded death has nothing to recover, an
  // unrecorded one may still have a rollout on its lane (duel 391 M14).
  const missing = (r: ReturnType<typeof pendingDuels>[number]): string =>
    r.missing?.length ? ' — ' + r.missing.map(m => `${m.vendor} missing`
      + (m.deathRecorded ? ' (death recorded, nothing to recover)'
        : ' (nothing recorded — check its lane for a rollout)')).join(', ') : '';
  return '[model-routing] pending duels: ' + p.map(r =>
    `#${r.id} ${r.kind} ${r.status}${r.reJudgeable ? ' (re-judgeable)' : ''}${mark(r)}${missing(r)}`,
  ).join(', ');
}

function laneLine(lane: Lane, now: number): string {
  const label = laneLabel(lane);
  const u = latestSnapshot(db, lane);
  const s = laneStatus(u, now, lane);
  // 'stale' covered two very different lanes: one nobody has polled, and one whose oauth token
  // died and whose every poll since has 401'd. Only the second needs a human, and it stayed
  // invisible for the ~10h lane B spent dark.
  if (s.state === 'stale') return `${label}: stale${reauthNeeded(lane, now) ? ' — RE-AUTH NEEDED' : ''}`;
  // A payload can carry only a short window: print the number the state was actually derived
  // from rather than nothing — this line is the whole dashboard on the SessionStart hook.
  if (s.weeklyUtilization === null) {
    const short = s.shortUtilization === null ? '' : `${s.shortUtilization.toFixed(0)}% 5h, `;
    return `${label}: ${short}no weekly window — ${s.state.toUpperCase()}`;
  }
  // A model-scoped pool (fable) closes the lane for that model while the account windows read
  // open (duel 391 M7): each live pool prints beside the weekly with its own state, or this
  // line says OPEN over a pool at 100% — the exact blindness behind rows 311-380.
  const pools = (u?.windows ?? []).filter(w => w.model && w.resetsAt > now).map(w =>
    `${w.model} ${w.utilization.toFixed(0)}%${w.utilization >= HARD_PCT ? ', closed'
      : w.utilization >= SOFT_PCT ? ', soft' : ''}`);
  const wk = `${s.weeklyUtilization!.toFixed(0)}% wk${pools.length ? ` (${pools.join('; ')})` : ''}`;
  const p = s.weeklyPace;
  // An untouched pool reports no reset time, so both the pace and the reset date would be values
  // this code made up. Say the pool is untouched instead of printing invented numbers.
  if (p === null) {
    return `${label}: ${wk}, untouched pool (no reset reported) — ${s.state.toUpperCase()}`;
  }
  const reset = new Date(s.resetsAt!).toUTCString().slice(0, 16);
  return `${label}: ${wk}, pace ${p >= 0 ? '+' : ''}${p.toFixed(0)}, `
    + `resets ${reset} — ${s.state.toUpperCase()}`;
}

switch (cmd) {
  case 'launch': {
    const lane = rest[0];
    const usage = (): never => {
      const line = lane === 'codex'
        ? 'usage: mrctl launch codex --model <m> --effort <e> --cwd <dir> '
          + '--prompt-file <f> --log <f> [--sandbox <s>]'
        : lane === 'b'
          ? 'usage: mrctl launch b --model <tier> --task-file <f> [--workdir <dir>] '
            + '[--configdir <dir>] [--effort <e>] [--read-only]'
          : 'usage: mrctl launch <codex|b> [flags]';
      writeSync(2, `${line}\n`);
      process.exit(2);
    };
    const refuse = (message: string): never => {
      writeSync(2, `${message.replace(/[\r\n]+/g, ' ')}\n`);
      process.exit(1);
    };
    if (lane !== 'codex' && lane !== 'b') usage();

    const allowedValues = lane === 'codex'
      ? new Set(['--model', '--effort', '--cwd', '--prompt-file', '--log', '--sandbox'])
      : new Set(['--model', '--task-file', '--workdir', '--configdir', '--effort']);
    const values = new Map<string, string>();
    let readOnly = false;
    for (let i = 1; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === '--read-only') {
        if (lane !== 'b' || readOnly) usage();
        readOnly = true;
        continue;
      }
      if (!allowedValues.has(flag) || values.has(flag)) usage();
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) usage();
      values.set(flag, value);
    }

    if (lane === 'codex') {
      const model = values.get('--model') ?? usage();
      const effort = values.get('--effort') ?? usage();
      const cwd = values.get('--cwd') ?? usage();
      const promptFile = values.get('--prompt-file') ?? usage();
      const logFile = values.get('--log') ?? usage();
      const sandbox = values.get('--sandbox');
      if (sandbox !== undefined && sandbox !== 'workspace-write' && sandbox !== 'read-only') usage();

      const command = (() => {
        try {
          return buildCodexLaunch({
            model,
            effort: effort as Parameters<typeof buildCodexLaunch>[0]['effort'],
            cwd,
            promptFile,
            logFile,
            sandbox: sandbox as Parameters<typeof buildCodexLaunch>[0]['sandbox'],
          }).command;
        } catch (e) {
          return refuse((e as Error).message);
        }
      })();
      try {
        if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
        accessSync(cwd, constants.W_OK);
      } catch {
        refuse(`cwd must exist and be a writable directory: ${cwd}`);
      }
      const prompt = (() => {
        try {
          return readBoundedTextFile(promptFile, TEXT_INPUT_CAP);
        } catch (e) {
          return refuse(`prompt file ${promptFile} ${(e as Error).message}`);
        }
      })();
      if (prompt.length === 0) refuse(`prompt file must be non-empty: ${promptFile}`);
      const nestedLaunch = findNestedCodexLaunch(prompt);
      if (nestedLaunch) refuse(`prompt file contains nested codex launch line: ${nestedLaunch}`);
      writeSync(1, `${command}\n`);
      break;
    }

    const model = values.get('--model') ?? usage();
    const taskFile = values.get('--task-file') ?? usage();
    const workdir = values.get('--workdir');
    const configDir = values.get('--configdir');
    const effort = values.get('--effort');
    const task = (() => {
      try {
        return readBoundedTextFile(taskFile, TEXT_INPUT_CAP);
      } catch (e) {
        return refuse(`task file ${taskFile} ${(e as Error).message}`);
      }
    })();
    if (task.length === 0) refuse(`task file must be non-empty: ${taskFile}`);
    const packageText = (() => {
      try {
        return buildBPackage({
          model: model as Parameters<typeof buildBPackage>[0]['model'],
          task,
          workdir,
          configDir,
          effort: effort as Parameters<typeof buildBPackage>[0]['effort'],
          readOnly,
        }).package;
      } catch (e) {
        return refuse((e as Error).message);
      }
    })();
    if (workdir !== undefined) {
      try {
        if (!statSync(workdir).isDirectory()) throw new Error('not a directory');
      } catch {
        refuse(`workdir must exist and be a directory: ${workdir}`);
      }
    }
    writeSync(1, packageText);
    break;
  }
  case 'brief-lint': {
    const usage = (detail?: string): never => {
      writeSync(2, `usage: mrctl brief-lint <brief.md> [--root <dir>]${detail ? ` — ${detail}` : ''}\n`);
      process.exit(2);
    };
    const briefPath = rest[0];
    let root = process.cwd();
    if (!briefPath || briefPath.startsWith('--')) usage();
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] !== '--root' || !rest[i + 1] || rest[i + 1].startsWith('--')) usage();
      root = rest[++i];
    }

    const briefText = (() => {
      try {
        return readBoundedTextFile(briefPath, TEXT_INPUT_CAP);
      } catch (e) {
        writeSync(2, `[model-routing] brief-lint cannot read ${briefPath}: `
          + `${(e as Error).message.replace(/[\r\n]+/g, ' ')}\n`);
        process.exit(1);
      }
    })();
    const result = lintBrief(briefText, { root });
    for (const finding of result.findings) writeSync(1, `${finding}\n`);
    if (result.findings.some(finding => !finding.startsWith('warn: '))) process.exit(1);

    const sum = `${result.sha256}  ${basename(briefPath)}`;
    try {
      writeFileSync(`${briefPath}.sha256`, `${sum}\n`);
    } catch (e) {
      writeSync(2, `[model-routing] brief-lint cannot write ${briefPath}.sha256: ${(e as Error).message}\n`);
      process.exit(1);
    }
    console.log(`sha256 ${result.sha256}  ${briefPath}`);
    break;
  }
  case 'tokens': {
    if (rest.length === 0) {
      writeSync(2, 'usage: mrctl tokens <artifact>...\n');
      process.exit(2);
    }
    const files = readTokenArtifacts(rest);
    console.log(JSON.stringify(tokensOf(files), null, 2));
    break;
  }
  case 'quota': {
    if (flags.has('--refresh')) {
      const report = await pollAll(db);
      for (const f of report.failed) console.error(`[model-routing] poll ${f.lane} failed: ${f.error}`);
    }
    // The SessionStart hook is this branch, so it is the one path guaranteed to run every
    // session — which makes it the only place the offline fallback doc can be kept current.
    // matrix.md was written solely by `matrix --render` and the three MCP mutation handlers, so
    // on a fresh install it never existed at all: SKILL.md tells the controller to fall back to
    // it when the engine is unreachable, and the only things that created it were engine paths
    // that are unreachable by then. Cheap: one ~1 KB write per session.
    try { writeMatrixDoc(db); } catch { /* read-only data dir — the dashboard still prints */ }
    // Same reasoning as the doc write: this is the one path that runs every session, so it is
    // where abandoned duel rows get closed out.
    try {
      const swept = expireStaleDuels(db);
      // stdout, not stderr: only the hook's stdout enters session context, and a sweep that
      // named no ids was invisible exactly where the ids were still actionable.
      if (swept.length) {
        console.log(`[model-routing] expired duel(s) ${swept.join(', ')} → abandoned (revivable by id)`);
      }
    } catch { /* another writer holds the lock — next session sweeps */ }
    const now = Date.now();
    const lines = LANES.map(l => laneLine(l, now));
    if (flags.has('--summary')) console.log('[model-routing quota] ' + lines.join(' | '));
    else console.log(lines.join('\n'));
    const pending = pendingLine(now);
    if (pending) console.log(pending);
    break;
  }
  case 'status': {
    const now = Date.now();
    console.log(LANES.map(l => laneLine(l, now)).join('\n'));
    // A union kind is not an undecided contest — it is a kind with no contest at all, and it can
    // never decide. Counting it as open left it in the open-contest count permanently.
    const s = standings(db);
    console.log(`open contests: ${s.filter(k => !k.decided && !k.union).length}`);
    const union = s.filter(k => k.union);
    if (union.length) {
      console.log(`union kinds (no contest): ${union.map(k => `${k.kind} (${k.unionRuns} run${k.unionRuns === 1 ? '' : 's'})`).join(', ')}`);
    }
    const pending = pendingLine(now);
    if (pending) console.log(pending);
    break;
  }
  // v2.13.46: contested rows are terminal and SILENT — they leave the pending line at
  // resolution and accumulate with no surface asking whether the ground-truth pass ever ran
  // (duels 283/284/289 sat invisible until the operator asked). One line per row: age, whether
  // any outcome row references the duel (the resolution lever), and any judge brief-defect
  // flag (the cause marker). The outcome match is a substring heuristic ("…uel <id>…"), loose
  // on purpose: evidence is free prose and a false "recorded" is rarer than a false "NO".
  case 'contested': {
    const rows = db.prepare(
      `SELECT id, task_kind, created_at, decided_by FROM duels
       WHERE status='unresolved' AND decided_by IN ('contested','both_failed')
       ORDER BY id`).all() as any[];
    if (!rows.length) { console.log('no contested duels'); break; }
    const now = Date.now();
    for (const r of rows) {
      // Patterns built JS-side: node:sqlite binds a JS number as REAL, so SQL-side
      // concatenation renders the id as "1.0" and the pattern can never match.
      const outcome = db.prepare(
        'SELECT COUNT(*) c FROM outcomes WHERE evidence LIKE ? OR evidence LIKE ?')
        .get(`%uel ${r.id}%`, `%uel${r.id}%`) as any;
      const defects = db.prepare(
        'SELECT COUNT(*) c FROM judgments WHERE duel_id=? AND brief_defect IS NOT NULL')
        .get(r.id) as any;
      const days = Math.floor((now - (r.created_at as number)) / 86_400_000);
      // v2.13.49: a head-on contested row is usually one checkable factual claim — say the
      // fact-check round applies right where the backlog is read, not only in the (long-gone)
      // record_judgment reply.
      const vs = db.prepare(
        'SELECT verdict FROM judgments WHERE duel_id=? ORDER BY id').all(r.id) as any[];
      const headOn = r.decided_by === 'contested' && vs.length >= 2
        && headOnSplit(vs[0].verdict, vs[1].verdict);
      console.log(`#${r.id} ${r.task_kind} — ${r.decided_by}, ${days}d old — `
        + (outcome.c ? 'outcome recorded' : 'NO outcome row — ground-truth pass not done')
        + (defects.c ? ` — brief defect flagged by ${defects.c} vote(s)` : '')
        + (headOn ? ' — HEAD-ON split: fact-check round applies' : ''));
    }
    break;
  }
  case 'serena':
    console.log(serenaLedger(db).join('\n'));
    break;
  case 'calibration':
    console.log(calibrationLedger(db, args[0] ?? 'gpt-6-astra').join('\n'));
    break;
  case 'union': {
    const [kind, state] = args;
    if (!kind || (state !== 'on' && state !== 'off')) {
      console.error('usage: mrctl union <task-kind> <on|off>'); process.exit(2);
    }
    // Canonical everywhere the operator can read it back: setUnionMode aliases the dead slugs
    // itself (duel-163 F4), and the changelog/output must name the row that actually changed.
    const canon = canonicalKind(kind);
    const r = setUnionMode(db, canon, state === 'on');
    if (r === 'missing') { console.error(`no matrix row for '${canon}'`); process.exit(1); }
    // Not an error, but not success either: the row was already in that state, so nothing was
    // written — and saying "union off" would imply this command had just done something.
    if (r === 'unchanged') { console.log(`${canon}: already union ${state} — unchanged`); break; }
    logChange(db, `'${canon}' union mode ${state} (operator)`);
    writeMatrixDoc(db);
    console.log(`${canon}: union ${state}`);
    break;
  }
  case 'matrix': {
    if (flags.has('--render')) console.error(`wrote ${writeMatrixDoc(db)}`);
    console.log(renderMarkdown(db));
    break;
  }
  case 'standings':
    console.log(JSON.stringify(
      { kinds: standings(db), pending: pendingDuels(db) }, null, 2));
    break;
  case 'seed':
    console.log(`seeded ${seeded} rows`);
    break;
  case 'import-scorecard': {
    if (!args[0]) { console.error('usage: mrctl import-scorecard <path>'); process.exit(2); }
    const r = importScorecard(db, readFileSync(args[0], 'utf8'));
    console.log(`imported ${r.imported}, skipped ${r.skipped}`);
    break;
  }
  case 'report': {
    const sub = args[0];
    if (sub === 'auto') {
      if (args[1] !== 'on' && args[1] !== 'off') {
        console.error('usage: mrctl report auto <on|off>'); process.exit(2);
      }
      setSetting(db, 'report_autopop', args[1]);
      console.log(`report auto-open ${args[1]}`);
      break;
    }
    if (sub === 'open-cmd') {
      if (!args[1]) { console.error('usage: mrctl report open-cmd <cmd|auto>'); process.exit(2); }
      setSetting(db, 'report_open_cmd', args[1]);
      console.log(`report open command: ${args[1]}`);
      break;
    }
    if (flags.has('--session-end')) {
      // The SessionEnd hook. Reports must never block a closing session: every failure is one
      // stderr line and exit 0 (the surrounding switch falls through to a normal exit).
      try {
        const hook = JSON.parse(readFileSync(0, 'utf8'));
        const from = sessionWindowStart(hook.transcript_path);
        if (from == null) {
          writeSync(2, '[model-routing] report skipped: transcript unreadable\n'); break;
        }
        const path = writeSessionReport(db,
          { fromMs: from, toMs: Date.now(), sessionId: hook.session_id ?? null });
        if (path) {
          console.log(`[model-routing] session duel report: ${path}`);
          maybeOpen(db, path);
        }
      } catch (e) {
        writeSync(2, `[model-routing] report failed: ${(e as Error).message}\n`);
      }
      break;
    }
    if (flags.has('--window')) {
      const [range, sid] = args;
      const [f, t] = (range ?? '').split(',').map(Number);
      if (!Number.isFinite(f) || !Number.isFinite(t)) {
        console.error('usage: mrctl report --window <fromMs,toMs> [session-id]'); process.exit(2);
      }
      const path = writeSessionReport(db, { fromMs: f, toMs: t, sessionId: sid ?? null });
      console.log(path ?? 'no duels in window — no report written');
      break;
    }
    console.error('usage: mrctl report <--session-end | --window <fromMs,toMs> [session-id] '
      + '| auto <on|off> | open-cmd <cmd|auto>>');
    process.exit(2);
  }
  default:
    console.error('usage: mrctl <launch|brief-lint|tokens|quota|status|contested|serena|calibration|matrix|standings|seed|union|import-scorecard|report> [flags]');
    process.exit(2);
}
}

let invokedAsMain = false;
try {
  invokedAsMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
} catch { /* an import with no executable path is not a CLI invocation */ }
if (invokedAsMain) await main();
