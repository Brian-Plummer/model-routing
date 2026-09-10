import { randomInt } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Lane, Side, Vendor } from './types.js';
import { GRADE_POINTS, PATH_TOKENS, resolveVerdict, type JudgeToken } from './scoring.js';
import { spendSpotAudit } from './matrix.js';
import { codexLaneOf } from './quota/poll.js';
import { A_PROJECTS, bProjects, canonDir, CODEX_SESSIONS } from './paths.js';
import { pluginVersion } from './version.js';

export interface SideResult {
  output: string | null; tokens: number | null; latencyMs: number | null; failed: boolean;
  proof?: string | null; // session id of the real run (B: headless session_id, codex: rollout id)
  // The side's unseen fighting conditions (tools/MCP, network, sandbox, respawns) — stored for
  // the session report's fairness section, never consulted by resolution.
  environment?: string | null;
  // The CONTROLLER's build/test result for this side's tree, after its one repair round. Unlike
  // `environment` this DOES decide: a failed gate overrides any judge vote (scoring.ts). Null
  // for read-only kinds and for any side with no gate to run — never a failure.
  gate?: 'pass' | 'fail' | null;
  // The gate's receipts: the commands run and their pass/fail counts. Required whenever `gate`
  // is non-null — duel 298's gates said 'pass' while one tree failed its repo's own suite, and
  // the bare token hid WHAT the gate had covered. Observational (resolution reads `gate` only);
  // the judge package ships it as ground truth about each tree.
  gateDetail?: string | null;
}
// A is optional and only consulted when a lane-A side VOLUNTEERS a proof — lane A needs none
// (the run happens in the controller's own session), but one that is offered must verify, or
// it gets ignored rather than claimed: an unverified string burned a single-use namespace
// entry forever (duel-62 I1 secondary).
// bError carries WHY B is null, and exists because `B: null` had two meanings that must not be
// confused: a caller (every test, the MCP surface's own opts) passing null means "attestation is
// off, skip it", while a null from the resolver means "I cannot tell which account is the offload
// one". Skipping on the second one made misconfiguration — the exact state offloadDir() exists to
// detect — LESS checked than health: a lane-B side recorded with no session file at all, and an
// anthropic judge voted with no proof (duel-184 fix round 1). Set by defaultProofRoots() only.
export interface ProofRoots {
  B: string | null; codex: string | null; A?: string | null; bError?: string;
}
export const defaultProofRoots = (): ProofRoots => {
  try { return { B: bProjects(), codex: CODEX_SESSIONS, A: A_PROJECTS }; }
  catch (e) {
    // Unresolvable offload → B proofs cannot verify. They are refused (see bUnresolved) rather
    // than verified against a dir that may belong to the MAIN account.
    // `||`, not `??`: bUnresolved gates on bError being truthy, so an EMPTY message (or a
    // falsy non-Error throw) would read as "B is fine" and restore the fail-open this whole
    // branch exists to close — `??` only catches null/undefined and would pass '' straight
    // through. Same guard as the route_task handler's bErr.
    return { B: null, bError: (e as Error)?.message || String(e) || 'unresolvable offload',
      codex: CODEX_SESSIONS, A: A_PROJECTS };
  }
};

// The one refusal both production paths share — a side recording and a judge vote alike. Returns
// an error string, or null when B is usable (or was disabled by the caller).
const bUnresolved = (roots: ProofRoots, what: string): string | null =>
  roots.B == null && roots.bError
    ? `${what} cannot be attested — the offload account is unresolvable: ${roots.bError}. ` +
      `Attestation is not skipped on a broken config: fix the aux login, or pin MR_B_CONFIG_DIR ` +
      `to the offload config dir, then re-record`
    : null;

// A real lane run leaves a session .jsonl on disk (B: the resolved offload dir's projects/, codex:
// ~/.codex/sessions). Evidence = a .jsonl under root modified at/after duel creation,
// with the claimed session id in its filename when a proof was given.
// File mtimes come from the kernel's coarse-grained clock, which can trail Date.now() by a
// few milliseconds, so a session file written right after the duel row can read as older.
// The allowance costs nothing: proof ids are mandatory and single-use, so a wider window
// cannot launder a second duel.
export const MTIME_SKEW_MS = 2_000;

// Session files are named after the run: B writes '<uuid>.jsonl', codex writes
// 'rollout-<timestamp>-<uuid>.jsonl'. Compare the canonical id by equality — substring
// matching accepted "rollout-2026-07-2", which is contained in every rollout written that
// day, and let two substrings of one filename pass as two distinct proofs.
const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}/i;
export function sessionIdOf(nameOrProof: string): string {
  const base = nameOrProof.replace(/^.*\//, '').replace(/\.jsonl$/i, '');
  return (base.match(SESSION_ID_RE)?.[0] ?? base).toLowerCase();
}

// A file's mtime is its LAST write, so it proves only that the session was still alive after
// `sinceMs` — not that it began there. A session started before the judging packet existed but
// still being appended to afterwards passed the window, and SKILL.md promised more than the
// check delivered (duel-64 opus #7 / sol #1). The session's own start is the first "timestamp"
// field in the file — B and codex both stamp one on every line. A file without a parseable one
// falls back to the mtime-only check: no false rejections on legacy or synthetic files. The
// rollout FILENAME timestamp is deliberately not used — codex writes it in LOCAL time while
// the line timestamps are UTC, and the offset would reject genuine judges.
// The head must be big enough to actually reach the first timestamp: at 4 KiB it missed it on
// real files — lane-B agent-*.jsonl put it at offsets 4707/6468 — so the check silently
// degraded to mtime-only on exactly the files it exists for (duel-65 opus F8 / sol S1).
// (Codex rollouts stamp their first "timestamp" at offset ~1; the earlier claim that
// base_instructions precedes it measured the wrong field — duel-66 opus M9.) 256 KiB covers
// lane B with two orders of magnitude to spare; a full head with no timestamp at all is
// logged ONCE per file — attestation re-reads the same path on every record/judgment call,
// and a long-lived MCP server's stderr does not need the repeat — because the silent
// fallback was the defect.
const START_HEAD_BYTES = 256 * 1024;
// Bound for extending the read when line 1 alone outgrows the head (duel-70 anth F1) — the
// largest live offender holds its first newline at ~845 KB; 4 MiB is generous headroom.
const FIRST_LINE_CAP_BYTES = 4 * 1024 * 1024;
const startWarned = new Set<string>();
// Which stamps in the head may vote is a LANE property (duel-68 opus F4):
// - 'line1' (codex): only line 1 describes this session — a rollout's first "timestamp" is
//   the session_meta ENVELOPE write time, up to +104s after the real start in
//   payload.timestamp on the SAME line (duel-66 opus I5), so line 1 takes the minimum of its
//   own two stamps; but a byte-wide minimum read a forked/resumed rollout's ANCESTOR
//   session_meta — embedded in 29 of 173 live rollouts, up to 8m41s early — as this session's
//   start, false-rejecting genuine post-packet judges and sides (duel-67 opus F1). Deeper
//   timestamps belong to whatever the session resumed; they never vote.
// - 'earliest' (lane B): 212 of 225 live files DO carry a line-1 timestamp, but the head
//   lines are not timestamp-ordered — 83 of 225 hold an earlier stamp deeper in the head, by
//   up to 1.658s — so the line-1 rule re-admitted the pre-packet slack duel-65 S10 removed.
//   No fork-replay mechanism exists on lane B: the minimum over the head is the session's
//   earliest evidence, and correct. But the minimum is per-LINE, never a raw byte-wide regex:
//   only the fields the lane itself stamps (rec.timestamp / rec.payload.timestamp) may vote —
//   a "timestamp" key nested inside a tool result's DATA backdated the whole session and
//   false-rejected a genuine post-packet run, whose proof id is single-use (duel-69 opus F1).
export type StartMode = 'line1' | 'earliest';
// The two fields the lane's own logger stamps on a record — nothing nested deeper may vote.
function lineRec(line: string): unknown | null {
  try { return JSON.parse(line); } catch { return null; /* not JSON (or truncated) */ }
}
function recStampMs(rec: any): number {
  let min = Infinity;
  for (const c of [rec?.timestamp, rec?.payload?.timestamp]) {
    const t = typeof c === 'string' ? Date.parse(c) : NaN;
    if (Number.isFinite(t) && t < min) min = t;
  }
  return min;
}
function lineStampMs(line: string): number {
  return recStampMs(lineRec(line));
}
function sessionStartMs(path: string, mode: StartMode = 'line1'): number | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(START_HEAD_BYTES);
    const n = readSync(fd, buf, 0, START_HEAD_BYTES, 0);
    let raw = buf.subarray(0, n);
    let truncated = n === START_HEAD_BYTES;
    if (truncated && !raw.includes(0x0a)) {
      // A first record LARGER than the whole head left no newline to split on: lines became a
      // single truncated fragment, pop() emptied the array, and the start silently degraded to
      // mtime — measured on 12 of 227 live lane-B files, the lane carrying both the anthropic
      // side and the anthropic judge (duel-70 anth F1). Extend the read to line 1's own
      // newline, bounded, and decode ONCE — a per-chunk decode could tear a multi-byte char at
      // the boundary and unparse the very record this read exists to recover. The extension
      // also widens 'earliest' mode's vote window to every line it recovers — deliberate:
      // measured identical to the line-1 minimum on all 12 live offenders (duel-71 anth F8).
      // Bounded by the FILE, not only the cap: the fixed-size alloc zero-filled and copied
      // ~8 MB per attestation call for any file this branch touches (duel-71 anth F8 rider).
      const { size } = fstatSync(fd);
      const extra = Buffer.alloc(Math.max(0, Math.min(FIRST_LINE_CAP_BYTES, size) - n));
      const m = extra.length ? readSync(fd, extra, 0, extra.length, n) : 0;
      raw = Buffer.concat([raw, extra.subarray(0, m)]);
      truncated = raw.length === FIRST_LINE_CAP_BYTES;
    }
    if (truncated) {
      // A complete record can END exactly at the read — its delimiter one byte past it, or
      // the file itself ending there. "Full read" alone cannot tell that from a record the
      // read cut mid-line, and popping the finished record silently degraded freshness to the
      // mtime-only ACCEPT at the read's own declared bound (duel-71 sol F2; hasRunEvidence
      // passes on a null start by design). The same shape exists at BOTH boundaries — the
      // 4 MiB cap and the 256 KiB head (duel-73 opus F8) — so the sentinel keys on the read's
      // own end offset, whichever bound produced it. Truncation needs affirmative evidence
      // that the record CONTINUES: anything other than EOF or a line delimiter right past it.
      const sentinel = Buffer.alloc(2);
      const k = readSync(fd, sentinel, 0, 2, raw.length);
      if (k === 0 || sentinel[0] === 0x0a
          || (sentinel[0] === 0x0d && (k === 1 || sentinel[1] === 0x0a))) truncated = false;
    }
    const lines = raw.toString('utf8').split('\n');
    // A full read means the head is truncated mid-line — the tail fragment must not vote as
    // if it were a record (its stamps may be cut, its JSON never parses anyway).
    if (truncated) lines.pop();
    let earliest = Infinity;
    if (mode === 'earliest') {
      for (const line of lines) {
        const t = lineStampMs(line);
        if (t < earliest) earliest = t;
      }
    } else {
      earliest = lineStampMs(lines[0] ?? '');
      if (earliest === Infinity) {
        // Fallback for a line 1 the parse cannot serve — bounded to the next TWO complete
        // lines, each contributing its own envelope/payload minimum exactly as line 1 does.
        // The 2.6.11 spelling took the first parseable REGEX match anywhere in the head, which
        // was wrong in both directions: the session_meta ENVELOPE stamp (up to +104s late)
        // re-admitted a pre-packet session whose real start sat in payload.timestamp on the
        // same line (duel-69 sol M1), and a forked rollout's ANCESTOR meta deeper in the head
        // could false-reject a genuine run — duel-67 opus F1 through the fallback door
        // (duel-69 opus F6). The bound alone only MOVED that hazard: an ancestor meta on line
        // 2 or 3 voted exactly as before (duel-70 anth F6). A fallback record carrying another
        // session's id is foreign by construction and never votes, at any line. Past the
        // bound the check degrades to mtime, loudly, below.
        const own = sessionIdOf(path);
        for (const line of lines.slice(1, 3)) {
          const rec = lineRec(line) as any;
          if (rec === null) continue;
          // ALL id fields, not the first non-nullish: one non-authoritative id masked a
          // conflicting sibling in either direction — a wrapper carrying this rollout's id in
          // payload.id beside a FOREIGN session_id voted its ancestor stamp, and a generic
          // string in payload.id (not a session id at all — sessionIdOf returns such input
          // whole) skipped the genuine record that carried it (duel-71 sol F3). Only a
          // session-SHAPED id can speak for the record, and every one that does must agree
          // with the file. This is a TRADE, not a strict improvement: a record whose only ids
          // are generic now votes where it was skipped before — right for the genuine record
          // that motivated it, wrong for a replayed ancestor carrying no session-shaped id,
          // whose early stamp would false-reject a genuine judge on the one path where a
          // rejection burns a single-use proof. Measured empty on 32/32 live id-bearing
          // line-2/3 records today (duel-73 opus F5).
          const ids = [rec?.payload?.id, rec?.payload?.session_id,
            rec?.session_id, rec?.sessionId]
            .filter((x): x is string => typeof x === 'string' && SESSION_ID_RE.test(x));
          if (ids.some(rid => sessionIdOf(rid) !== own)) continue;
          const t = recStampMs(rec);
          if (t !== Infinity) { earliest = t; break; }
        }
      }
    }
    if (earliest === Infinity) {
      // Loud on EVERY degrade, not only a full head: a small file with a corrupt line 1 fell
      // back to mtime with no trace, and the silent fallback is the defect whatever the file
      // size (duel-70 sol P3). Still once per file — attestation re-reads the same path on
      // every record and judgment call.
      if (!startWarned.has(path)) {
        startWarned.add(path);
        console.error(`[model-routing] no usable session-start timestamp in ${path} — ` +
          'freshness degrades to mtime for this file');
      }
      return null;
    }
    return earliest;
  } catch { return null; } finally { closeSync(fd); }
}

// `accept` lets a caller demand more of the file than "it exists and is recent" — record_outcome
// uses it to require that a spark proof names a file that is actually a SPARK rollout, since
// every codex-family run writes into the same directory. `requireStart: false` drops the
// session-start check for the one caller whose session legitimately predates the window — the
// controller's own lane-A session, which by definition started before the duel it records.
// One session id can name more than one file under a root — an archived or backed-up copy beside
// the live rollout — and readdirSync's order is filesystem-dependent, so both scans below picked
// an arbitrary member of that set, independently. The attesting scan could then accept one file
// while the measuring scan floored the claim against a DIFFERENT file's span (duel-163 P3). Sorted
// once, here: the two scans see the same order, so they agree on which file speaks for the run.
function rolloutNames(root: string): string[] | null {
  try { return (readdirSync(root, { recursive: true }) as string[]).sort(); } catch { return null; }
}

// The one selection rule: the file that speaks for a run is the first in sorted order passing
// every test. Sorting alone did not make the two scans agree (duel-163 F8) — the measuring scan
// carried no session-start check of its own, so an archived copy sharing the id, stale start and
// fresh mtime, could sort first, be skipped by the attesting scan, and still floor the claim the
// live rollout supported. Both scans call THIS, so the file that attests a side is the file that
// measures it. The parsed start rides along: the measuring caller needs the value this filter
// already read, and a second 256KiB head parse per recorded side bought nothing.
function* runFiles(
  root: string, sinceMs: number, proof: string | null | undefined,
  accept: ((path: string) => boolean) | undefined,
  opts: { requireStart?: boolean; startMode?: StartMode },
): Generator<{ path: string; mtime: number; started: number | null }> {
  const names = rolloutNames(root);
  if (names === null) return;
  const want = proof ? sessionIdOf(proof) : null;
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    if (want && sessionIdOf(n) !== want) continue;
    const path = join(root, n);
    let mtime: number;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (mtime < sinceMs - MTIME_SKEW_MS) continue;
    // `accept` runs before the head parse: both are filters on the same conjunction, so the order
    // cannot change which files pass, but a file the lane check rejects should not cost a 256KiB
    // read or emit this module's "no usable session-start timestamp" warning about a file that
    // was never going to speak for the run.
    if (accept && !accept(path)) continue;
    // requireStart off is the controller's own lane-A session, which by definition predates the
    // duel — no start check, and no parse to pay for it.
    const started = opts.requireStart === false ? null : sessionStartMs(path, opts.startMode);
    // No MTIME_SKEW_MS here: the parsed start is the lane's own millisecond-precision log
    // line, not a coarse kernel mtime — the allowance let a session started 1500ms before
    // the packet existed claim the judge slot (duel-65 sol S10). A file with no parseable
    // start still passes: legacy and synthetic files attest on mtime alone (duel-71 sol F2).
    if (started !== null && started < sinceMs) continue;
    yield { path, mtime, started };
  }
}

// Lazily: the boolean stops at the first passer, so a scan with no proof to match on does not
// parse every head in the root.
function pickRunFile(
  root: string, sinceMs: number, proof: string | null | undefined,
  accept: ((path: string) => boolean) | undefined,
  opts: { requireStart?: boolean; startMode?: StartMode },
): { path: string; mtime: number; started: number | null } | null {
  return runFiles(root, sinceMs, proof, accept, opts).next().value ?? null;
}

export function hasRunEvidence(
  root: string, sinceMs: number, proof?: string | null,
  accept?: (path: string) => boolean,
  opts: { requireStart?: boolean; startMode?: StartMode } = {},
): boolean {
  return pickRunFile(root, sinceMs, proof, accept, opts) !== null;
}

interface ProofIdentity {
  model: string | null;
  effort: string | null;
  serenaCalls: number | null;
}

// A lane-B side that fans out (Agent tool) writes each sub-agent's transcript beside its own
// session file — <dir>/<session>/subagents/agent-*.jsonl — and their serena calls are the side's
// calls: duel 257's B side ran six, and the parent alone attests a fraction of what the side did.
// Model and effort stay the PARENT's: a sub-agent may run another model by design, and that is
// not the side misreporting its identity.
export function subagentTranscripts(path: string): string[] {
  const dir = path.replace(/\.jsonl$/, '');
  if (dir === path) return [];
  const sub = join(dir, 'subagents');
  try {
    return readdirSync(sub).filter(f => f.endsWith('.jsonl')).sort().map(f => join(sub, f));
  } catch { return []; }
}
const serenaCallsOf = (content: any[]): number => content.filter((b: any) =>
  b?.type === 'tool_use' && typeof b?.name === 'string' && b.name.startsWith('mcp__serena')).length;

// Identity is independent of the bounded session-start parse above. Read the selected proof
// artifact line by line, tolerate junk/truncation, and accept only records owned by the harness
// itself — never recursively search pasted payloads. Later parseable values win independently.
function proofIdentity(path: string, family: Vendor): ProofIdentity {
  const found: ProofIdentity = { model: null, effort: null, serenaCalls: null };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return found; }
  for (const line of text.split(/\r?\n/)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (family === 'anthropic') {
      if (o?.type !== 'assistant') continue;
      if (typeof o?.message?.model === 'string') found.model = o.message.model;
      if (typeof o?.effort === 'string') found.effort = o.effort;
      if (Array.isArray(o?.message?.content)) {
        found.serenaCalls = (found.serenaCalls ?? 0) + serenaCallsOf(o.message.content);
      }
      continue;
    }
    if (o?.type === 'turn_context') {
      if (typeof o?.payload?.model === 'string') found.model = o.payload.model;
      if (typeof o?.payload?.effort === 'string') found.effort = o.payload.effort;
    } else if (o?.type === 'event_msg' && o?.payload?.type === 'thread_settings_applied') {
      // Codex also emits this model-only settings record on launch/model switches. It is the
      // existing lane discriminator and remains valid when a synthetic/older rollout has no
      // turn_context; effort stays NULL unless its own pinned field is present.
      if (typeof o?.payload?.thread_settings?.model === 'string') {
        found.model = o.payload.thread_settings.model;
      }
    }
  }
  if (family === 'anthropic') {
    for (const sub of subagentTranscripts(path)) {
      let t: string;
      try { t = readFileSync(sub, 'utf8'); } catch { continue; }
      for (const line of t.split(/\r?\n/)) {
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (o?.type !== 'assistant' || !Array.isArray(o?.message?.content)) continue;
        found.serenaCalls = (found.serenaCalls ?? 0) + serenaCallsOf(o.message.content);
      }
    }
  }
  return found;
}

const CLAUDE_MODEL_PREFIX: Record<string, string> = {
  haiku: 'claude-haiku', sonnet: 'claude-sonnet', opus: 'claude-opus', fable: 'claude-fable',
};
const modelMatches = (side: Side, attested: string): boolean => {
  const prefix = CLAUDE_MODEL_PREFIX[side.model];
  return prefix !== undefined ? attested.startsWith(prefix) : attested === side.model;
};

// The artifact's own duration: session start stamp (the lane's millisecond log line, the same
// parse the freshness check trusts) to last write (mtime). Floors a side's latency claim —
// v2.7.4 capped claims at the row's age (no over-claim), but since v2.9.0 the clock DECIDES a
// duel after quality, so the incentive flipped to UNDER-claiming, and nothing checked that
// direction. The session file is the value the side doesn't control: a run whose artifact
// spans N ms cannot have taken materially less. Null when the file is missing or carries no
// parseable start (legacy/synthetic files) — the gate skips rather than misfires, the same
// policy as the freshness fallback.
function spanOf(
  f: { mtime: number; started: number | null }, sinceMs: number, nowMs: number,
): number | null {
  if (f.started === null || f.started > f.mtime) return null;
  const span = f.mtime - f.started;
  // The row's age bounds a measured artifact exactly as it bounds a claimed number (v2.7.4): a
  // side spawns only after the duel row exists, so a file spanning longer than the row has lived
  // is contradicting itself — a corrected clock, a restored copy, an mtime from the future. The
  // same number passed as a claim is refused as impossible, but measured it was stored as fact
  // and decided the duel on the clock channel, and the floor built on it refused honest claims
  // (duel-166, found independently by both vendors). Skip, never clamp: clamping mints a
  // measurement out of an artifact the engine has just called untrustworthy. Same 60s slack and
  // the same `now`-sanity guard as the claim cap.
  if (nowMs >= sinceMs && span > nowMs - sinceMs + 60_000) return null;
  return span;
}

// "Landed" is THE predicate for a stored side, shared by every reader: non-null AND non-blank.
// A blank stored output (a pre-2.6.1 row holding a hung lane's error text that trims to
// nothing) is not a report anyone must preserve, judge, or vote against — it is a side still
// missing (duel-63 opus #7; unified across replay, revival and repair by duel-64 opus #2 / sol #4).
// Exported for db.ts, which registers it as the SQL function landed() so queries and JS apply
// the SAME test: SQLite's one-arg TRIM strips spaces only, and the divergence let a '\n' side
// read as landed in SQL while blank here (duel-65 opus F4 / sol S9).
export function landedOf(o: unknown): o is string {
  return typeof o === 'string' && o.trim() !== '';
}

// v2.13.49: the fact-check round (v2.13.48) was SKILL prose the controller had to remember at
// exactly the moment a contested resolution lands — duel 298's round was never offered. A
// HEAD-ON split (verdicts X and Y: each judge cleared the side the other failed) is usually one
// checkable factual claim, so the resolving reply — and its lost-reply replay — carries the
// offer. Engine-side text only; the round itself stays operator-triggered and its answers stay
// out of record_judgment (one vote per vendor stands).
export const FACT_CHECK_OFFER = 'HEAD-ON split — before discarding the outputs, offer the '
  + 'operator one fact-check round: hand each judge ONLY the other\'s disputed factual claims '
  + 'plus the probe artifacts (no grades, no re-vote), ask confirm/refute per claim; the '
  + 'answers go to the operator\'s record, never into record_judgment';
// Head-on means EXACTLY {X, Y}: neither-vs-X is a judge failing both sides (nothing to
// fact-check), and an X-vs-Y pair under two failed gates resolves both_failed, not contested,
// so every caller gates on decided_by='contested' as well.
export const headOnSplit = (a: string, b: string): boolean =>
  (a === 'X' && b === 'Y') || (a === 'Y' && b === 'X');

// The pre-2.6.11 double-failure spelling: 'walkover', NULL winner, nothing landed. Still
// writable post-migration by an already-running old MCP process. Every JS reader shares THIS
// predicate (the two standings queries carry its SQL twin) — four independent spellings of
// one shape is how recordJudgment stayed behind when the other three moved (duel-74 opus F5).
export function isLegacyDead(
  row: { status: string; winner_vendor: unknown; anth_output: unknown; gpt_output: unknown },
): boolean {
  return row.status === 'walkover' && row.winner_vendor == null
    && !landedOf(row.anth_output) && !landedOf(row.gpt_output);
}

// Guards against simulated lanes (2026-07-23 incident: teammates on account A cosplaying
// as claude-b/codex sides). Returns an error string, or null when the side is legitimate.
// A proof must be specific enough to identify one run. Session ids are uuid/ulid-shaped;
// a short or generic string ("jsonl", "session") would match half the directory.
export const PROOF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{15,}$/;

// Every codex-family lane writes into ONE sessions directory, so an id-and-mtime match proves
// only that SOME codex run happened — which lane it was is in the rollout, and this path never
// looked. record_outcome has demanded the rollout's own lane since 2.5.7; the duel path did not,
// and v2.6 made it spark's PRIMARY evaluation path by seeding spark on both haiku-tier rows.
// Asymmetric on purpose: spark must be POSITIVELY identified, while an unclassifiable rollout
// still attests a codex side — a null classification is a parse gap, not evidence of spark.
function laneAccept(lane: Lane): ((p: string) => boolean) | undefined {
  if (lane === 'spark') return p => codexLaneOf(p) === 'spark';
  if (lane === 'codex') return p => codexLaneOf(p) !== 'spark';
  return undefined;
}

// `measured` is how the one observation leaves this function: the fresh null-latency path stores
// the span it derives, and re-walking the root to find it again is exactly the gap F3 closes.
function attestationError(
  side: Side, r: SideResult, createdAt: number, roots: ProofRoots, now: number,
  floorApplies = true, measured?: { span: number | null; artifact: string | null },
): string | null {
  if (r.failed) return null;
  if (!Number.isFinite(r.tokens) || (r.tokens as number) <= 0) {
    return `${side.vendor} side reports tokens=${r.tokens} — real lane runs report a positive ` +
      `token count; if the lane did not run, record failed:true instead`;
  }
  if (r.latencyMs != null && (!Number.isFinite(r.latencyMs) || r.latencyMs <= 0)) {
    return `${side.vendor} side reports latency_ms=${r.latencyMs} — pass a positive wall-clock ` +
      `duration or null`;
  }
  // A side spawns only after the duel row exists, so its wall-clock can never exceed the row's
  // own age. Duel 146 recorded gpt latency_ms=4700000 inside a 31-minute-old duel whose rollout
  // attests 25 minutes — a controller-estimated round number entered during a messy recovery,
  // and the "78-minute codex run" it invented drove a whole degradation narrative (08-10).
  // Positive/finite alone lets any estimate through; the row's age is the one bound the engine
  // can enforce. 60s slack covers measurement fuzz, not estimates. A clock that puts `now`
  // before the row's creation proves nothing about the side — skip, don't misfire.
  if (r.latencyMs != null && now >= createdAt && r.latencyMs > now - createdAt + 60_000) {
    return `${side.vendor} side reports latency_ms=${r.latencyMs} — impossible: the duel is only ` +
      `${now - createdAt}ms old and sides spawn after routing. Pass the run's measured ` +
      `wall-clock duration or null, never an estimate`;
  }
  if (!r.output || !r.output.trim()) {
    return `${side.vendor} side has no output — a side that produced nothing is a failure; ` +
      `record failed:true instead`;
  }
  // Lane A runs in the controller's own session: no proof is required, and none can be wrong
  // enough to refuse the record — the co-recorded partner side may be fully attested and ready
  // to land, and blocking it over a decorative field helps nobody (duel-63 opus #4). Whether a
  // volunteered lane-A proof is USED (claimed + stored) is decided by verifiedLaneAProof at
  // record time; unverifiable ones are simply ignored.
  if (side.lane === 'A') return null;
  if (side.lane === 'B') {
    const unresolved = bUnresolved(roots, `${side.vendor} side (B lane)`);
    if (unresolved) return unresolved;
  }
  const root = side.lane === 'B' ? roots.B : roots.codex;
  // Null from HERE is the caller's own switch (tests, and the MCP surface's explicit roots) —
  // nothing to attest against. A resolver-null never reaches this line: bUnresolved refused above.
  if (root == null) return null;
  const agent = side.lane === 'B' ? 'model-routing:claude-b' : 'codex:codex-rescue';
  // Proof is mandatory: without it the check degraded to "did anything at all run on this
  // account since the duel row was created", which any unrelated concurrent run satisfied.
  if (!r.proof || !PROOF_RE.test(r.proof)) {
    return `${side.lane}-lane side has no usable proof — pass the run's session id ` +
      `(B: session_id from the headless JSON envelope; codex: the rollout/session id). ` +
      `Spawn the side via Agent subagent_type ${agent}; if the lane failed, record failed:true`;
  }
  const startMode: StartMode = side.lane === 'B' ? 'earliest' : 'line1';
  const accept = laneAccept(side.lane);
  const unattested =
    `unattested ${side.lane}-lane side: no ${side.lane}-lane session file under ${root} ` +
    `since duel creation matching proof "${r.proof}"` +
    ` — spawn the side via Agent subagent_type ${agent} (never teammates/local models); ` +
    `a rollout from a different codex-family lane does not attest this one. ` +
    `If the lane failed, record failed:true`;
  // ONE observation per side on the fresh path. Attestation, the one-file check and the clock all
  // read the same materialized walk, because the divergence this whole line of fixes has been
  // chasing was reachable again through the GAP between two walks, however identically they
  // filtered (duel-166 F3, both vendors): a copy landing mid-record could attest through the first
  // scan and be measured by the second. Revivals keep the lazy boolean — they never measure, and
  // their root may hold copies the fresh path would refuse.
  let span: number | null = null;
  if (!floorApplies) {
    const claimant = pickRunFile(root, createdAt, r.proof, accept, { startMode });
    if (claimant === null) return unattested;
    if (measured) measured.artifact = claimant.path;
    return null;
  }
  const claimants = [...runFiles(root, createdAt, r.proof, accept, { startMode })];
  if (claimants.length === 0) return unattested;
  // A proof id is single-use, so exactly one file under the root should answer to it. More than
  // one FRESH claimant is an anomaly the engine must not resolve on its own, because the side that
  // wrote them picks the answer. Taking the first sorted name let a side plant `<its-id>-0.jsonl`
  // — sessionIdOf reads the id from anywhere in the basename, and '-' sorts before '.' — spanning
  // ~0ms, and record a 20-minute run as one second: silent, deterministic, and worth the duel on
  // the clock channel (duel-166 fable-B F1, sol-max F2; the spanless-copy variant masks the live
  // file the same way). Taking the LONGEST span instead would close the cheat but refuse honest
  // claims whenever a benign copy inflated the set. So the engine refuses and names the files:
  // loud, actionable, and self-defeating to game — planting a decoy kills your own record.
  // Fresh recordings only; a revived row's root may legitimately have collected copies since.
  if (claimants.length > 1) {
    return `${side.lane}-lane proof "${r.proof}" names ${claimants.length} session files under ` +
      `${root} (${claimants.map(c => c.path.replace(/^.*\//, '')).join(', ')}) — one run writes ` +
      `one file, so the engine cannot tell which one measures this side's clock. Remove the ` +
      `stray copies and re-record, or record failed:true`;
  }
  if (measured) measured.artifact = claimants[0].path;
  span = spanOf(claimants[0], createdAt, now);
  if (measured) measured.span = span;
  // The other direction of the row-age cap above: the clock decides duels since v2.9.0, so an
  // under-claimed latency wins them. The attested session file's own span is the floor; the
  // same 60s slack covers stamp/mtime fuzz, not estimates.
  // floorApplies only on the FRESH path (duel-163 F4-anthropic): mtime moves whenever a session
  // is resumed or appended, so on the revival/repair/late-fill flows SKILL.md itself prescribes,
  // the span outgrows the true run and the floor would refuse the honest measured claim —
  // coercing either an inflated number (side unfairly loses the clock channel) or a null (duel
  // drifts unresolved). The recording caller passes floorApplies=false for those rows, which
  // returned above without ever measuring.
  if (span !== null && r.latencyMs != null && r.latencyMs + 60_000 < span) {
    return `${side.vendor} side reports latency_ms=${r.latencyMs} — impossible: its own ` +
      `session file spans ${span}ms from its start stamp to its last write, so the run ` +
      `cannot have taken less. Pass the run's measured wall-clock duration or null, ` +
      `never an estimate`;
  }
  return null;
}

// One real run must not launder many duels: a resumed session file keeps getting a fresh
// mtime, so without this a single genuine run could attest every duel recorded after it.
// The claim is an INSERT under the caller's write transaction, not a SELECT before it —
// concurrent MCP server processes share the DB, and one namespace covers sides and judges
// alike (a side's own session id used to sail through as that duel's judge proof).
// duelId 0 means "not a duel" — a namespace slot for non-duel claims. Nothing mints those any
// more (record_outcome stopped requiring proofs when spark lost the ability to take a row it
// was not seeded onto), but legacy outcome claims still occupy it and still block reuse.
export function claimProof(
  db: DatabaseSync, duelId: number, slot: string, proof: string, now: number,
): void {
  // Claims are keyed on the CANONICAL id, not the caller's spelling: '<uuid>' and
  // 'rollout-<ts>-<uuid>.jsonl' attest the same file, so storing raw strings would let one
  // run be spent twice under two spellings.
  const canon = sessionIdOf(proof);
  const res = db.prepare(
    'INSERT OR IGNORE INTO proof_claims(proof, duel_id, slot, created_at) VALUES (?,?,?,?)',
  ).run(canon, duelId, slot, now);
  const inserted = Number(res.changes) === 1;
  const claimed = inserted
    ? null
    : db.prepare('SELECT duel_id, slot FROM proof_claims WHERE proof=?').get(canon) as any;
  const owner = claimed ?? legacyProofOwner(db, canon);
  if (!owner) return;
  // Same-slot replay is a no-op for duels and judges: re-recording duel N's anthropic side is
  // the same fact, and recordResults/recordJudgment are deliberately replay-safe. Outcomes
  // (duelId 0) get no such pass — an outcome has no identity to be idempotent on, so two
  // PROMOTEs for one kind sharing a proof would let a single spark run earn the row, which is
  // the whole thing this attestation exists to stop.
  // EXCEPT a judge claim whose vote a packet-changing repair deleted: that run saw the OLD
  // packet, its proof stays spent, and re-sending it is not a replay — the repaired packet
  // needs a fresh judge run (duel-65 sol S4). Side slots keep the unconditional pass: a
  // repaired side's re-record IS the same fact.
  if (duelId !== 0 && owner.duel_id === duelId && owner.slot === slot) {
    const jv = owner.slot.startsWith('judge:') ? owner.slot.slice('judge:'.length) : null;
    if (!jv || db.prepare('SELECT 1 FROM judgments WHERE duel_id=? AND judge_vendor=?')
      .get(duelId, jv)) return;
  }
  // Refused — and if OUR insert just landed (a fresh claim losing to a pre-2.5 legacy owner),
  // remove it before throwing: a caller that survives this throw (the lane-A ignore path)
  // would otherwise commit a claims row attributing the proof to a duel that stores no such
  // proof (duel-65 opus F9a).
  if (inserted) db.prepare('DELETE FROM proof_claims WHERE proof=?').run(canon);
  const where = owner.duel_id === 0 ? `an outcome (${owner.slot})`
    : `duel ${owner.duel_id} (${owner.slot})`;
  throw new Error(`proof "${proof}" was already used to attest ${where} — each side, each judge ` +
    `and each spark outcome needs its own run; if this lane did not run here, record ` +
    `failed:true (duel) or do not record the outcome`);
}

// proof_claims only sees writes from a process running this code. A pre-2.5 MCP server on the
// same DB (sessions keep their server until restart) still writes proofs straight into duels /
// judgments, so those columns are checked too — the claims table alone would leave the whole
// mixed-version window unguarded. ponytail: full scan of two small tables; index or drop the
// scan if `duels` ever gets large enough for it to show up.
function legacyProofOwner(
  db: DatabaseSync, canon: string,
): { duel_id: number; slot: string } | null {
  const duels = db.prepare(
    'SELECT id, anth_proof, gpt_proof FROM duels WHERE anth_proof IS NOT NULL OR gpt_proof IS NOT NULL',
  ).all() as any[];
  for (const d of duels) {
    if (d.anth_proof && sessionIdOf(d.anth_proof) === canon) return { duel_id: d.id, slot: 'anthropic' };
    if (d.gpt_proof && sessionIdOf(d.gpt_proof) === canon) return { duel_id: d.id, slot: 'openai' };
  }
  const votes = db.prepare(
    'SELECT duel_id, judge_vendor, proof FROM judgments WHERE proof IS NOT NULL',
  ).all() as any[];
  for (const j of votes) {
    if (sessionIdOf(j.proof) === canon) return { duel_id: j.duel_id, slot: `judge:${j.judge_vendor}` };
  }
  return null;
}
export interface JudgingPacket { duelId: number; taskKind: string; X: string; Y: string }

// Duel-414 reports named model tiers and harness agent types under SUB-AGENTS, revealing lanes.
// Scope this additional scrub to complete SUB-AGENTS sections: the repository's ordinary prose,
// diffs, matrix rows and lane recipes legitimately name models and vendors, and judges must see
// that content unchanged.
function scrubSubAgentSection(s: string): string {
  let inSubAgentSection = false;
  return s.split('\n').map((line) => {
    const isHeading = /^[ \t]*#{1,6}[ \t]+\S/.test(line)
      || /^[ \t]*[A-Z][A-Z0-9-]*(?:[ \t]+[A-Z][A-Z0-9-]*)*:?[ \t]*$/.test(line)
      || /^[ \t]*\*\*[^*\n]+\*\*:?[ \t]*$/.test(line);
    if (isHeading) {
      if (/^[ \t]*(?:#{1,6}[ \t]+|\*\*)?sub-?agents?\b/i.test(line)) {
        inSubAgentSection = true;
      } else if (inSubAgentSection) {
        inSubAgentSection = false;
      }
    }
    return inSubAgentSection
      ? line.replace(
        /\b(?:opus|sonnet|haiku|fable|sol|astra|spark|luna|terra|chatgpt|anthropic|openai|general-purpose|(?:gpt|claude|codex)(?:-[\w.-]+)?)\b/gi,
        '<redacted>',
      )
      : line;
  }).join('\n');
}

// Strip obvious vendor self-identification from a blind judging packet. Conservative by
// design: it must not touch legitimate mentions of claude/codex/gpt in code under review.
export function scrubIdentity(s: string): string {
  // The offload dir can be pinned anywhere (MR_B_CONFIG_DIR=/srv/whatever), and the aux dirs
  // themselves can be renamed (MR_AUX_A/MR_AUX_B) — the literal .claude-[ab] rule below cannot
  // see those spellings, so the packet would carry a path only the B side could have written,
  // which is the whole lane tell. Read per call, never cached: pins are the operator's env, not
  // the build's. No resolver call: scrubbing BOTH aux dirs (a superset of the one that resolved)
  // beats guessing which is the offload, and cannot throw on a broken login.
  // Every env that can re-spell a lane root: config-dir pin, both aux dirs, and the three
  // direct root pins. Defaults stay with the literal rules; a pinned spelling is scrubbed here.
  const { MR_B_CONFIG_DIR, MR_AUX_A, MR_AUX_B, MR_B_PROJECTS, MR_A_PROJECTS, MR_CODEX_SESSIONS }
    = process.env;
  let pinned = s;
  // Longest pin first: applied in declaration order, a pin that is a PREFIX of another
  // ('/srv/lane' vs '/srv/lane@b') ran first and ate the shared prefix up to a character its
  // tail class refuses, leaving '<path>@b/…' — a mangled spelling the longer pin's own rule no
  // longer matches, so the lane tell survived in the blind packet (duel-201 sol P2).
  // Canonical BEFORE the sort: a verbatim slashed pin ('/srv/lane/') demanded its trailing
  // slash at the match site, so a child echoing the BARE dir sailed through the packet — and
  // verbatim lengths would let trailing slashes outrank a longer pin and resurrect the mangle.
  // Same canonDir as the resolver: the scrubbed spelling IS the gated/forwarded spelling.
  for (const pin of [MR_B_CONFIG_DIR, MR_AUX_A, MR_AUX_B, MR_B_PROJECTS, MR_A_PROJECTS,
    MR_CODEX_SESSIONS].filter((p): p is string => !!p).map(canonDir)
    .sort((a, b) => b.length - a.length)) {
    pinned = pinned.replace(
      new RegExp(`${pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w/.-]*`, 'gi'), '<path>');
  }
  // Duel 414 exposed model and agent-type lane tells in the SUB-AGENTS section alone.
  pinned = scrubSubAgentSection(pinned);
  return pinned
    // Leading [\s>+-]* so the trailer is still caught inside a diff hunk or a quoted block —
    // mutating duels return diffs, where every added line carries a '+'.
    .replace(/^[\s>+-]*Co-Authored-By:.*(claude|codex|openai|anthropic).*$/gim, '')
    .replace(/\b(as|I am|I'm)\s+(Claude|Codex|ChatGPT|an AI (assistant|model) (made|built|developed) by (Anthropic|OpenAI))\b/gi, '')
    // \W* absorbs the markdown link bracket in "Generated with [Claude Code](…)".
    .replace(/(Generated with|Powered by)\s+\W*(Claude|Codex|ChatGPT)[^\n]*/gi, '')
    // Lane tells that have no legitimate reason to appear in a solution: session paths and
    // raw envelope fragments. Deliberately narrow — prose about claude/codex/gpt survives,
    // because a review of this repo must be able to discuss them.
    // With OR without a trailing path: the bare dir ('$HOME/.claude-b', the courier's
    // 'ConfigDir: …/.claude-b.' echo) is the same tell (duel-391 M2).
    .replace(/[~\w/.-]*\.claude-[ab]\b[\w/.-]*/gi, '<path>')
    // ANY .codex/ path, not just sessions/: the codex home has a dozen subdirs (memories, log,
    // shell_snapshots, …) and a /home/…/.codex/memories/ path survived the sessions-only rule
    // into a blinded packet (duel-326 class). Unlike .claude/, .codex/ never appears as an
    // in-project config dir, so a path under it is always a lane tell. Paths only — tool names
    // stay controller-side (a rg→grep rewrite once manufactured a false integrity finding).
    .replace(/[~\w/.-]*\.codex\/[\w/.-]*/gi, '<path>')
    // Lane A's home is just as much a tell, and it is REACHABLE: pickAnthropicLane shifts a
    // B-homed kind to A whenever B is soft or stale, so the anthropic side routinely runs on A.
    // Scrubbing only B and codex left one solution carrying a live ~/.claude/projects path while
    // the other showed '<path>' — the judge could read the lane straight off the packet.
    // Named subdirectories only, not a bare `.claude/`: prose about `.claude/settings.json` has
    // to survive, because reviewing this repo means discussing it.
    .replace(/[~\w/.-]*\.claude\/(projects|todos|shell-snapshots|worktrees)[\w/.-]*/gi, '<path>')
    // The SKILL names the side worktrees `duel<id>-w1/-w2` and the judge dirs
    // `duel<id>-judging-*`, so a report quoting its own sha256sum line (both duel-409 reports did)
    // carries a path the codex judge's sandbox can list. Any path-shaped token holding one.
    .replace(/[~\w/.-]*\bduel\d+-(w\d+|judging-\w+)\b[\w/.-]*/gi, '<path>')
    // First-person lane self-identification ("serena was not exposed on this Codex lane" —
    // duel 409's X, in its own DEVIATIONS). The third person ("the codex lane") is spared on
    // purpose: a review of this repo has to be able to name the lanes.
    .replace(/\b(this|my|our) (codex|claude|anthropic|openai|gpt) lane\b/gi, 'this lane')
    // Serena is mandatory on the Claude lanes (operator, 2026-09-03) and the method-naming line
    // makes a side name the tools it ran — so mcp__serena* (both lane-A servers: `serena` and
    // `serena-lsp`) / jet_brains_* / the word serena in a report name the anthropic side as
    // surely as a path does. Bare LSP spellings (find_symbol) stay: generic identifiers, and a
    // review of this repo may quote them.
    .replace(/\bmcp__serena[\w-]*|\bjet_brains_\w+|\bserena\b/gi, '<redacted>')
    // The fan-out line every brief carries since v2.13.86 names the MECHANISM per lane ("the
    // Agent tool on a Claude lane, sub-agent rollouts on codex") and asks for a count — and a
    // side that names its count names its mechanism with it, so "the Agent tool" is the
    // anthropic side and a "sub-agent rollout" or the codex `spawn_agent` family is the openai
    // side, as surely as a path is. Bounded on both ends, so the vocabulary both lanes share
    // survives: the bare words rollout / sub-agent / agent (this repo names rollouts
    // constantly, and the fan-out line asks for a sub-agent COUNT) and any longer identifier
    // holding one (`subagent_type`, `agent(prompt, {model})`, a transcript basename agent-1).
    // `sub-agent tool names` is the judge template's own REDACTIONS phrase, not the mechanism:
    // the lookbehind spares an `agent tool` that follows a hyphen (duel 415: the phrase, quoted
    // in the task and both diffs, reached the judges as `sub-<redacted> names`).
    .replace(
      /\b(?:(?<![\w-])(?:agent|task)\s+tool|(?:sub-?agent|child)\s+rollouts?|spawn_agent|wait_agent|list_agents|interrupt_agent)\b/gi,
      '<redacted>')
    // Artifact names and proof values (duel-391 M1/M2): the engine's own mandated report
    // basename, a bare codex rollout filename and a bare uuid/ulid session id each name the
    // lane as surely as a path does. Rollout before uuid, or the id inside the filename is
    // rewritten first and the filename rule no longer matches. Anchored so a sha or an
    // identifier never matches; the judge template names these tokens as harness redactions.
    .replace(/\bduel(\d+)-(anthropic|openai)\b/gi, 'duel$1-<redacted>')
    .replace(/\brollout-\d{4}-\d\d-\d\d[\w-]*(\.jsonl)?/gi, '<redacted>')
    .replace(new RegExp(`\\b(?:${SESSION_ID_RE.source})\\b`, 'gi'), '<redacted>')
    .replace(/"(session_id|rollout_id)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .replace(/^OpenAI Codex v[\d.]+.*$/gim, '');
}

export function createDuel(
  db: DatabaseSync, kind: string, sides: [Side, Side],
  opts: { mutating: boolean; spotCheck: boolean; unionMode?: boolean }, now: number = Date.now(),
): number {
  const flip = randomInt(2) === 1;
  // A union row still gets a label map: it costs nothing, and it keeps every row in this table
  // shaped the same for the readers (standings, the matrix doc) that scan it.
  const labelMap: Record<string, Vendor> = flip
    ? { X: 'openai', Y: 'anthropic' } : { X: 'anthropic', Y: 'openai' };
  // The mint stamp goes on the INSERT itself — this statement IS the mint, and it is the only
  // one. Stamping in routeTask instead would leave every other caller writing NULL, and NULL
  // means "minted before v15": a lie the stale-server signal cannot afford.
  const res = db.prepare(
    `INSERT INTO duels(task_kind, created_at, spot_check, mutating, union_mode, sides, label_map,
       minted_by_version)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(kind, now, opts.spotCheck ? 1 : 0, opts.mutating ? 1 : 0, opts.unionMode ? 1 : 0,
    JSON.stringify(sides), JSON.stringify(labelMap), pluginVersion());
  return Number(res.lastInsertRowid);
}

// A duel row is created before either lane runs, and nothing ever closed it when a lane failed
// to come back: rows 26, 27 and 29 sat in 'routed' for up to 14h (duel 29's codex side burned
// 80 minutes and wrote no rollout at all). Recording a walkover instead would be a result nobody
// can attest, so the sweep records the only verifiable fact — the duel produced nothing.
// 'abandoned' is inert to standings, which count 'judged' and 'walkover' only.
// 6h matches STALE_MS: past that, a lane that has not written a session file is not running.
// BOTH stall states are swept. A controller can also die between recording results and collecting
// the votes, and sweeping only 'routed' left that row open forever — the same defect, on the
// other half of the state machine.
export const DUEL_TTL_MS = 6 * 3_600_000;

export function expireStaleDuels(db: DatabaseSync, now: number = Date.now()): number[] {
  // Two clocks, one per half of the state machine. 'routed' ages from route time — nothing else
  // exists. 'awaiting_judgment' ages from when the results landed: created_at has already been
  // running for the whole duration of both lane runs, so measuring the judging window from it
  // gave the judges whatever happened to be left of 6h — for a duel whose sides ran 6h+, zero.
  // COALESCE covers pre-2.6.4 rows recorded before the column existed.
  // RETURNING keeps this one statement: a SELECT-then-UPDATE could abandon a row a concurrent
  // recordResults had just moved on — and the ids are the fix for the sweep being silent (C3).
  // abandoned_at is the row's DEATH stamp — the router's dead-audit backoff runs from it.
  // Clocking that backoff from created_at was arithmetically dead code for swept audits: a
  // sweep only fires 6h after routing, always past the 1h backoff (duel-65 opus F3 / sol S5).
  return (db.prepare(
    "UPDATE duels SET status='abandoned', decided_by='abandoned', abandoned_at=? " +
    "WHERE (status='routed' AND created_at < ?) " +
    "OR (status='awaiting_judgment' AND COALESCE(recorded_at, created_at) < ?) " +
    'RETURNING id',
  ).all(now, now - DUEL_TTL_MS, now - DUEL_TTL_MS) as { id: number }[]).map(r => r.id);
}

export function getDuel(db: DatabaseSync, duelId: number): any {
  const row = db.prepare('SELECT * FROM duels WHERE id=?').get(duelId);
  if (!row) throw new Error(`no duel ${duelId}`);
  return row;
}

export interface UnionResult {
  status: 'union' | 'abandoned'; // 'abandoned' when BOTH lanes hung — nothing to ship
  sidesRecorded: Vendor[];   // which lanes actually delivered — merge exactly these
  failed: Vendor[];          // hung/failed lanes; the merge is short their coverage
}

type EffortTelemetry = {
  effort_mismatch?: Vendor[];
  serena_calls?: Partial<Record<Vendor, number>>;
};

// Replies are replay-safe telemetry too: reconstruct from the persisted truth instead of
// reopening a landed side's artifact. NULL means there was nothing extractable, never mismatch.
function withEffortTelemetry<T extends object>(duel: any, reply: T): T & EffortTelemetry {
  const sides = JSON.parse(duel.sides) as Side[];
  const mismatch = sides.flatMap(side => {
    const attested = side.vendor === 'anthropic'
      ? duel.anth_effort_attested : duel.gpt_effort_attested;
    return attested != null && attested !== side.effort ? [side.vendor] : [];
  });
  const serenaCalls: Partial<Record<Vendor, number>> = {};
  if (duel.anth_serena_calls !== null) serenaCalls.anthropic = duel.anth_serena_calls;
  if (duel.gpt_serena_calls !== null) serenaCalls.openai = duel.gpt_serena_calls;
  return { ...reply,
    ...(mismatch.length ? { effort_mismatch: mismatch } : {}),
    ...(Object.keys(serenaCalls).length ? { serena_calls: serenaCalls } : {}),
  };
}

export function recordResults(
  db: DatabaseSync, duelId: number,
  results: { anthropic: SideResult; openai: SideResult },
  // supersededBy: the id of the re-duel that replaces a round the CONTROLLER voided. Only legal
  // on a double failure, because a void IS a double failure — the controller declaring both
  // sides unusable. It exists because the protocol had no way to say "this round was killed on
  // purpose": duel 212 was voided over a brief defect that reached both sides, re-run as 213,
  // and then sat on the pending surface for a week reading `abandoned, revivable by id` with no
  // stored reason, while SKILL tells a later session to revive exactly that shape.
  opts: { roots?: ProofRoots; now?: number; supersededBy?: number | null } = {},
): ({ status: 'awaiting_judgment'; packet: JudgingPacket; superseded?: number[] }
  | { status: 'walkover'; winner: Vendor | null }
  | UnionResult) & EffortTelemetry {
  const duel = getDuel(db, duelId);
  const { anthropic: a, openai: g } = results;
  // Idempotent retry: if the response was lost after the status flipped, rebuild the same
  // packet from what was stored instead of throwing and leaving the controller with two
  // outputs it can no longer get judged. Replay ONLY when both sides actually landed — an
  // awaiting row with a blank side (pre-2.6.1 legacy) is repairable, not replayable, and the
  // old unconditional replay was the reason such a row could never be fixed (duel-64 sol #4).
  if (duel.status === 'awaiting_judgment'
      && landedOf(duel.anth_output) && landedOf(duel.gpt_output)) {
    // The sitter expiry is terminal and the sweep can never name it afterwards, so its ids
    // must survive a lost response: the first recording wrote superseded_by, and the replay —
    // the one path retries actually take — reconstructs the same fact from it instead of going
    // silent (duel-69 sol M3). ponytail: full scan of a small table; index if duels ever grows.
    // Only rows STILL dead: superseded_by is written at expiry but outlives a revival, and a
    // replay that reads it unfiltered reports a live awaiting_judgment sitter — holding two
    // attested outputs that need judges — as a terminal transition the caller should stop
    // looking for (duel-70, found by BOTH sides). Revival also clears the column below.
    // "Still dead" is status alone: a sitter whose double failure was later RECORDED respells
    // decided_by to 'abandoned', and filtering on 'superseded' dropped it from this list while
    // its tombstone sat readerless (duel-71 opus F2). Dead is dead, however it is spelled.
    const superseded = (db.prepare(`SELECT id FROM duels WHERE superseded_by=?
        AND status='abandoned' ORDER BY id`)
      .all(duelId) as { id: number }[]).map(r => r.id);
    return withEffortTelemetry(duel, { status: 'awaiting_judgment', packet: packetOf(duel),
      ...(superseded.length ? { superseded } : {}) });
  }
  // The OLD double-failure spelling — 'walkover', NULL winner, nothing landed — can still be
  // WRITTEN after the v5/v6 rewrites by an already-running pre-2.6.11 process (the ops doc
  // promises exactly that topology: an old MCP server keeps its code until its session
  // restarts). A one-shot migration cannot help a row born after it ran, so readers recognize
  // the shape: it falls through to the abandoned paths — revivable, death-recordable — instead
  // of short-circuiting as a real walkover (duel-70 sol P2). A real walkover stays immutable.
  const legacyDead = isLegacyDead(duel);
  if (duel.status === 'walkover' && !legacyDead) {
    return withEffortTelemetry(duel,
      { status: 'walkover', winner: duel.winner_vendor ?? null });
  }
  // A union closed one-sided is the ONE closed state that must stay open to new evidence: a hung
  // lane's run is regularly recovered from its rollout afterwards (that is the documented codex
  // recipe), and under duel semantics there was nowhere to put it. Replay only when the caller is
  // offering nothing the row is still missing — otherwise fall through and fill the empty side in.
  // Replay only when the row actually HOLDS something: an all-blank legacy row whose status is
  // 'union' (never swept, so the abandoned-path landedOf fix below never ran) short-circuited
  // here — missing() is false for a failed caller side — and returned {status:'union',
  // sidesRecorded:[]}, the same empty merge shipped as success that S3 closed for abandoned
  // rows (duel-66 opus I4). A row with nothing landed falls through and is re-evaluated.
  if (duel.status === 'union'
      && (landedOf(duel.anth_output) || landedOf(duel.gpt_output))) {
    const missing = (stored: unknown, r: SideResult) => !landedOf(stored) && !r.failed;
    if (!missing(duel.anth_output, a) && !missing(duel.gpt_output, g)) {
      return withEffortTelemetry(duel, unionResultOf(duel));
    }
  }
  // 'abandoned' is revivable, and must be: the sweep is a wall-clock guess about lanes that never
  // came back, and it is wrong whenever a controller was merely interrupted. Refusing the record
  // destroyed the work outright — a re-routed duel gets a NEWER created_at, so hasRunEvidence
  // then rejects the session files the lanes had already written, and there was no un-abandon
  // path. Reviving is safe: the attestation window is this row's own created_at, which the sweep
  // does not move, and proofs are single-use, so a stale row cannot launder anything.
  // 'awaiting_judgment' reaches here only with a blank side (the landed-both replay returned
  // above) — that row is repairable, not immutable.
  if (duel.status !== 'routed' && duel.status !== 'abandoned' && duel.status !== 'union'
      && duel.status !== 'awaiting_judgment' && !legacyDead) {
    throw new Error(`duel ${duelId} already has results`);
  }

  const roots = opts.roots ?? defaultProofRoots();
  const now = opts.now ?? Date.now();
  // A side that already LANDED (stored a non-blank output) is immutable: a second record can
  // only FILL a missing side, never replace one. Re-recording used to rewrite the whole row —
  // one call with a side marked failed turned a swept duel holding two attested outputs into a
  // walkover, and a union recovery passing both sides real overwrote the landed report the row
  // existed to preserve, silently, under any judge vote already cast on the old text
  // (duel-62 I5 / sol#2). A landed side's payload is ignored entirely: not attested (there is
  // nothing new to attest) and never claimed (claiming a fresh id for an ignored payload would
  // burn it).
  const aLanded = landedOf(duel.anth_output);
  const gLanded = landedOf(duel.gpt_output);
  // v2.13.50: a gate token is recordable only WITH its receipts. Landed sides are exempt (their
  // stored gate answers replays and fill() keeps it regardless), so pre-receipt rows stay
  // repairable and replayable. Pure and pre-claim: a refused call writes nothing, spends nothing.
  for (const [r, landed] of [[a, aLanded], [g, gLanded]] as [SideResult, boolean][]) {
    if (!landed && r.gate != null && !r.gateDetail?.trim()) {
      throw new Error('a bare gate token is unauditable — pass gate_detail naming the commands '
        + "run and their pass/fail counts (e.g. 'node tests/foundations.js 128/0; node "
        + "tests/fetchers.js 51/0'), the target repo's FULL existing suite included: duel 298 "
        + "recorded gate 'pass' while one tree failed its repo's own suite, and nobody could "
        + 'see what the gate had covered');
    }
  }
  const sides = JSON.parse(duel.sides) as Side[];
  // The clock column is integer ms (duel 205 landed anth_latency_ms=800061.316894531), and
  // every bound must hold for the value that is STORED, not the caller's fractional claim:
  // 0.4 used to pass the positivity gate and land as 0 — an absolute clock-channel win — and
  // a claim at the floor boundary could pass validation, then round below what the artifact
  // attests (duel-207 P2, both sides). Round claims once HERE, before validation, so the
  // gates, the floor and the write all see the same integer. NaN/Infinity survive Math.round
  // and are refused by the gates as before.
  for (const r of [a, g]) if (r.latencyMs != null) r.latencyMs = Math.round(r.latencyMs);
  // The span floor binds only the fresh first recording: any other status here is a revival,
  // repair, or late union fill, where the artifact's mtime has legitimately moved on
  // (duel-163 F4-anthropic — the recovery flows must stay able to record the truth).
  const freshRecord = duel.status === 'routed';
  const measured = new Map<Vendor, number | null>();
  const artifacts = new Map<Vendor, string>();
  for (const side of sides) {
    const landed = side.vendor === 'anthropic' ? aLanded : gLanded;
    if (landed) continue;
    const r = side.vendor === 'anthropic' ? a : g;
    const seen = { span: null as number | null, artifact: null as string | null };
    const err = attestationError(side, r, duel.created_at, roots, now, freshRecord, seen);
    if (err) throw new Error(err); // duel stays 'routed' — re-record after running the lane for real
    measured.set(side.vendor, seen.span);
    if (seen.artifact !== null) artifacts.set(side.vendor, seen.artifact);
  }
  // Model identity is a refusal only while this side is first landing. Missing values are the
  // legacy-compatible NULL path; effort is telemetry regardless of whether it matches.
  const identities = new Map<Vendor, ProofIdentity>();
  for (const side of sides) {
    const landed = side.vendor === 'anthropic' ? aLanded : gLanded;
    const r = side.vendor === 'anthropic' ? a : g;
    const artifact = artifacts.get(side.vendor);
    if (landed || r.failed || artifact === undefined) continue;
    const identity = proofIdentity(artifact, side.vendor);
    identities.set(side.vendor, identity);
    if (identity.model !== null && !modelMatches(side, identity.model)) {
      throw new Error(`${side.vendor} side expected model "${side.model}" but proof artifact `
        + `attested "${identity.model}" — refusing the first recording of this side`);
    }
  }
  // duel-163 F9: with the floor refusing under-claims, re-sending NULL became the dodge — the
  // clock channel then cannot separate the sides and the duel drifts 'unresolved', so the
  // under-claim incentive returned one door over. On the fresh path a missing claim is instead
  // MEASURED: the attested artifact's own span, the number the side cannot game. Revivals keep
  // their null — their span is inflated by the moved mtime (see freshRecord above), and an
  // absent honest measurement stays absent.
  // The span comes from the attestation walk above — the file that attested this side IS the file
  // that measures it, with no second look at a root that may have changed in between.
  if (freshRecord) {
    for (const side of sides) {
      if (side.lane === 'A') continue; // the controller's own run — no artifact-derived clock
      const landed = side.vendor === 'anthropic' ? aLanded : gLanded;
      const r = side.vendor === 'anthropic' ? a : g;
      if (landed || r.failed || r.latencyMs != null || !r.proof) continue;
      const span = measured.get(side.vendor) ?? null;
      // Rounded here, not at the write: a sub-ms span must not round to a stored 0, the
      // absolute clock win the positivity gate exists to refuse — it stays null instead.
      const ms = span === null ? null : Math.round(span);
      if (ms !== null && ms > 0) r.latencyMs = ms;
    }
  }

  // A proof is claimed only when the payload it attests is actually being stored, and only when
  // it VERIFIED. Lane A needs no proof (the run is in-session — designed hole, duel-62 I1), so
  // a volunteered one is used when it names a real session file under the A root and silently
  // ignored otherwise: claiming it blind burned a single-use namespace entry, and refusing the
  // record over it blocked the attested partner side (duel-63 opus #4).
  const verifiedLaneAProof = (r: SideResult): boolean => {
    const aRoot = roots.A ?? null;
    // requireStart off: the controller's session predates the duel it records by definition,
    // so the session-start check would reject every genuine lane-A proof.
    return aRoot != null && !!r.proof && PROOF_RE.test(r.proof)
      && hasRunEvidence(aRoot, duel.created_at, r.proof, undefined, { requireStart: false });
  };
  const claimable = (side: Side, r: SideResult): boolean =>
    !r.failed && !!r.proof && (side.lane !== 'A' || verifiedLaneAProof(r));
  const sideOf = (v: Vendor): Side => sides.find(s => s.vendor === v)!;
  // Claim intents are computed BEFORE the write lock (duel-64 opus #6): verifiedLaneAProof
  // walks the A projects tree recursively, and with busy_timeout=5000 a scan that outlives the
  // timeout turns every concurrent writer into SQLITE_BUSY instead of a queued wait. Everything
  // it reads (roots, proofs, created_at) is immutable across the lock; only the landed
  // recomputation below needs the fresh read.
  const aClaimIntent = claimable(sideOf('anthropic'), a);
  const gClaimIntent = claimable(sideOf('openai'), g);
  // One session id cannot attest two lanes — but only proofs that are actually going to be
  // USED can collide. A lane-A proof the record is ignoring anyway (unverifiable, or a pasted
  // copy of the partner's id) must not block the attested partner side (duel-64 sol #5).
  if (!aLanded && !gLanded && aClaimIntent && gClaimIntent
      && sessionIdOf(a.proof!) === sessionIdOf(g.proof!)) {
    throw new Error(`both sides claim proof "${a.proof}" — one session id cannot attest two lanes`);
  }

  // A union has no winner to declare, so one hung lane is not a walkover — it is a merge short
  // one side's coverage, which is still the deliverable. This is the duel-37 case: D7's codex
  // side hung, the opus report was used, and under duel semantics the row had nowhere to go but
  // 'routed' → swept to 'abandoned', losing an attested run. Only a double failure has nothing
  // to record, and that lands in 'abandoned' directly rather than sitting open for the sweep.
  // A failed side never overwrites what the row already holds. On a fresh row that stores NULL —
  // a side that produced nothing has no output, and storing its error text made `landed` below
  // read a hung lane as a delivered report.
  const keep = <T>(landed: boolean, r: SideResult, fresh: T, prev: T): T =>
    landed || r.failed ? prev : fresh;

  // Output and proof are ATTESTATION — a side that produced nothing has neither, so `keep`
  // is right to drop them. Tokens, the clock and `environment` are the opposite: they are the
  // only surviving record of what a dead round cost and WHY the controller called it dead,
  // and dropping them silently is how duel 212 lost both of its void explanations. That
  // recording named lane B's session, codex's rollout, the missing pyarrow and the 213
  // re-duel; all of it hit prev=NULL, `record_duel` returned success with no warning, and the
  // one sentence the operator got was the session report's "Abandoned — both sides dead",
  // which is false. The 367k output tokens lane B burned before the void stayed unattributable
  // for the same reason. Fill-only, never overwrite: a failed record still cannot rewrite a
  // value the row already holds, which is the invariant `keep` exists to protect.
  const fill = <T>(landed: boolean, r: SideResult, fresh: T, prev: T): T =>
    landed ? prev : r.failed ? prev ?? fresh : fresh;

  // One transaction, the status guard is in the UPDATE, and everything derived from the row is
  // RECOMPUTED under the write lock from a fresh read: the pre-lock snapshot goes stale across
  // the attestation filesystem scan, and a stale landed=false let a concurrent union recording
  // null out the side its rival had just stored — with the spent proof claim surviving the
  // vanished report (duel-63 sol#3). The pre-lock snapshot still drives the replay guards and
  // attestation above; both are conservative on stale data.
  // Read before the write lock, like every other filesystem touch here (duel-64 opus #6).
  const build = pluginVersion();
  let isUnion = false;
  let walkover = false;
  let bothDead = false;
  let superseded: number[] = [];
  let winner: Vendor | null = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = getDuel(db, duelId);
    const aLandedNow = landedOf(cur.anth_output);
    const gLandedNow = landedOf(cur.gpt_output);
    const anthOut = keep(aLandedNow, a, a.output, cur.anth_output as string | null);
    const gptOut = keep(gLandedNow, g, g.output, cur.gpt_output as string | null);
    // Effective failure: a landed side cannot retro-fail — `failed:true` for it is the
    // documented way to say "keep what you have" when completing a one-sided row.
    const aFailed = !aLandedNow && a.failed;
    const gFailed = !gLandedNow && g.failed;
    isUnion = !!cur.union_mode;
    // The landed predicate, not `=== null`: a legacy union whose stored sides are blank error
    // text, retried with both sides failed, read as "something to ship" and returned
    // {status:'union', sidesRecorded:[]} — an empty merge presented as success (duel-65 sol S3).
    // A double failure is the SAME death under either mode (duel-68 opus F6): the non-union
    // spelling — 'walkover' with a NULL winner and abandoned_at nulled — sat on no recovery
    // surface and was non-revivable, while the router's lastDead counted exactly those rows as
    // dead audits; two subsystems disagreed about whether the death happened. Both modes now
    // land 'abandoned': death-stamped, listed while fresh, revivable if the lanes really ran.
    const bothFailed = !landedOf(anthOut) && !landedOf(gptOut);
    bothDead = bothFailed;
    // A VOIDED round — its death RECORDED under a superseded_by marker (or the legacy
    // decided_by='superseded' spelling) — is never revived: the controller threw it away on
    // purpose and its re-duel already shipped (212 → 213). The tombstone used to be a listing
    // marker only: any record that left the row alive cleared it (duel 391 M8). A DISPLACED
    // row (the link written by a rival audit's success, no death record) stays revivable, and
    // a double-failure replay against a void is the dead-replay no-op below.
    const isVoided = !!cur.death_recorded
      && (cur.superseded_by != null || cur.decided_by === 'superseded');
    if (isVoided && !bothFailed) {
      throw new Error(`duel ${duelId} was voided`
        + (cur.superseded_by != null ? ` (superseded by duel ${cur.superseded_by})` : '')
        + ' — a voided round is never revived; record against the re-duel instead');
    }
    // A double-failure record against a row already dead AND already recorded adds no
    // evidence — it is a replay, and it must not move the clocks: 'abandoned' is revivable by
    // design, so each re-send rewrote abandoned_at AND recorded_at, and the router's backoff
    // runs from the LATEST stamp — a controller retrying a lost response pushed the next audit
    // an hour out every time, indefinitely (duel-69 opus F8 / sol M4). A row the SWEEP
    // abandoned but nobody ever recorded-as-dead is NOT a replay: that record is the
    // controller's own statement of the death, and it stamps now (the duel-67 opus F2 design,
    // kept). Two proxies for "already recorded dead" have died here: `recorded_at != null`
    // (duel-70 anth F2 — true for every legacy row) and then clock EQUALITY, which v6
    // manufactured on exactly the legacy shapes it backfilled — the two fixes of one wave
    // composing back into the bug (duel-71 F1, found by BOTH sides). The discriminator is now
    // a persisted marker only a death RECORD writes: the sweep never sets it, no migration
    // synthesizes it, and any record that leaves the row alive clears it. A pre-2.6.14 row
    // whose death WAS recorded carries no marker yet — its next replayed record re-stamps the
    // clocks once (one bounded backoff extension), then marks; permanent invisibility was the
    // alternative.
    const deadReplay = bothFailed && cur.status === 'abandoned' && !!cur.death_recorded;
    // The build that FIRST wrote results on this row — never the one that touched it last, so
    // the stamp stays comparable with the mint. "First" is a state question, not a clock one:
    // a row is unrecorded while it is still 'routed' or merely SWEPT ('abandoned' with nothing
    // landed and no death record — the sweep is not a recording). Every other shape has been
    // recorded already: a landed side, a recorded death, a walkover, a union, an awaiting row.
    // Those keep whatever they hold — including the pre-v15 NULL, which is the honest value for
    // a first recording this build did not make. recorded_at is deliberately NOT the test: it
    // is NULL on every row predating 2.6.4 (duel-65 opus F6, the same trap).
    const neverRecorded = (cur.status === 'routed' || cur.status === 'abandoned')
      && !cur.death_recorded && !aLandedNow && !gLandedNow;
    const recordedBy = (cur.recorded_by_version as string | null) ?? (neverRecorded ? build : null);
    // Loud, not ignored: a void marker on a row that is NOT dying would silently do nothing,
    // and the caller would believe it had tombstoned a round it had not.
    const voidedBy = opts.supersededBy ?? null;
    if (voidedBy != null) {
      if (!bothFailed) {
        throw new Error(`superseded_by names a VOIDED round — record both sides failed:true, `
          + `or drop it: duel ${duelId} has a side that landed`);
      }
      if (voidedBy === duelId) throw new Error(`duel ${duelId} cannot supersede itself`);
      if (!db.prepare('SELECT 1 FROM duels WHERE id=?').get(voidedBy)) {
        throw new Error(`superseded_by=${voidedBy} is not a duel id — mint the re-duel first`);
      }
    }
    const status = bothFailed ? 'abandoned'
      : isUnion ? 'union'
      : (aFailed || gFailed) ? 'walkover' : 'awaiting_judgment';
    walkover = status === 'walkover';
    winner = walkover ? (aFailed ? 'openai' : 'anthropic') : null;
    // 'superseded' is the existing tombstone spelling every consumer already understands: the
    // router's dying-audit backoff skips it (router.ts — a controller-caused death is not an
    // audit that keeps failing) and the pending surfaces render it `displaced`, where SKILL
    // says leave it alone. A void is exactly that shape, so it reuses it rather than inventing
    // a fourth word for dead.
    const decidedBy = bothFailed ? (voidedBy != null ? 'superseded' : 'abandoned')
      : isUnion ? 'union' : walkover ? 'walkover' : null;
    let aClaim = !aLandedNow && aClaimIntent;
    const gClaim = !gLandedNow && gClaimIntent;

    // A lane-A proof can never fail the record: the controller's session id is constant across
    // every duel it records in one session, so the second record re-volunteers an id that is
    // genuine, verified — and already claimed by the previous duel. Ignore it like the
    // unverifiable case instead of letting claimProof abort the transaction and discard the
    // attested partner side (duel-64 opus #4).
    if (aClaim) {
      try { claimProof(db, duelId, 'anthropic', a.proof!, now); }
      catch (e) {
        // Only the double-spend refusal is ignorable for lane A. The catch used to be
        // unconditional, reclassifying a real storage failure (FULL, BUSY, schema) as
        // "decorative lane-A proof" and committing the record claimless (duel-65 opus F9b).
        if (sideOf('anthropic').lane !== 'A' || !/already used to attest/.test(String(e))) throw e;
        aClaim = false;
      }
    }
    if (gClaim) claimProof(db, duelId, 'openai', g.proof!, now);

    // A record that CHANGES the packet voids votes cast on the old one: nothing else deletes
    // them, and resolveVerdict would happily combine a stale vote — cast against a blank
    // rival — with a fresh one into a 'judges' verdict that feeds the standings record
    // (duel-64 opus #2). Proof claims stay spent: those judge runs really happened.
    const packetChanged = anthOut !== cur.anth_output || gptOut !== cur.gpt_output;
    if (packetChanged) {
      // Tombstone the votes' proofs into proof_claims BEFORE deleting them: a pre-2.5 writer
      // stores a judge proof ONLY in judgments.proof, and deleting that row erased the sole
      // record of the spend — legacyProofOwner then found nothing and the pre-repair judge run
      // could re-vote on a packet it never saw (duel-66 opus M8 / sol F5). INSERT OR IGNORE:
      // post-2.5 votes already hold their claim, and "the claim outlives the vote" becomes
      // true by construction instead of by history.
      const votes = db.prepare(
        'SELECT judge_vendor, proof FROM judgments WHERE duel_id=? AND proof IS NOT NULL',
      ).all(duelId) as any[];
      for (const j of votes) {
        db.prepare('INSERT OR IGNORE INTO proof_claims(proof, duel_id, slot, created_at) VALUES (?,?,?,?)')
          .run(sessionIdOf(j.proof), duelId, `judge:${j.judge_vendor}`, now);
      }
      db.prepare('DELETE FROM judgments WHERE duel_id=?').run(duelId);
    }
    // The same reasoning covers the SIDE proof columns: keep() replaces a blank side's stored
    // proof (the pre-2.6.1 repair path), and a pre-2.5 writer recorded that spend nowhere
    // else — once overwritten, legacyProofOwner finds nothing and the id becomes re-spendable
    // (duel-67 opus F4). Tombstone before the UPDATE replaces them; INSERT OR IGNORE leaves
    // post-2.5 claims untouched.
    if (cur.anth_proof && !aLandedNow && !a.failed) {
      db.prepare('INSERT OR IGNORE INTO proof_claims(proof, duel_id, slot, created_at) VALUES (?,?,?,?)')
        .run(sessionIdOf(cur.anth_proof), duelId, 'anthropic', now);
    }
    if (cur.gpt_proof && !gLandedNow && !g.failed) {
      db.prepare('INSERT OR IGNORE INTO proof_claims(proof, duel_id, slot, created_at) VALUES (?,?,?,?)')
        .run(sessionIdOf(cur.gpt_proof), duelId, 'openai', now);
    }
    // A revived audit whose kind ALREADY has an audit in flight cannot rejoin as a second
    // one — idx_one_inflight_spot would (rightly) refuse the UPDATE and destroy the recorded
    // work. It lands as a plain record instead: the invariant holds, the outputs survive, and
    // the in-flight audit keeps the debt (duel-64 sol #2). The predicate must answer the
    // INDEX's question — is ANY other audit in flight (id<>) — because the index is symmetric:
    // the 2.6.8 `id>` ordering left an audit conflicting with an OLDER in-flight row
    // undemoted, and the UPDATE below then hit the unique index on every retry, permanently —
    // two swept audits revived in ascending id order could never store the second's attested
    // runs (duel-66 opus I1). duel-65 opus F10's concern — a stale un-run sitter demoting the
    // audit that actually RAN — is kept as a PREFERENCE instead of the whole test: a routed
    // conflictor already past the sweep TTL is expired here exactly as the sweep would have
    // (it ran nothing; abandoned_at stamps its death for the router's backoff), so the
    // recording audit keeps its identity. The demoted row keeps its audit history in
    // demoted_audit — spot_check=0 satisfies the in-flight index, but the row is still a PAID
    // audit whose verdict the reopen scan must count (duel-65 opus F5 / sol S7).
    // The sitter dies 'superseded', not 'abandoned': it matched the router's dead-audit
    // predicate exactly, so the SUCCESSFUL audit that displaced it armed the 1h dying-audit
    // backoff — and the operator note blaming dying audits — on its own kind (duel-67 opus
    // F7). A displacement is evidence of a crashed controller, not of audits that keep dying,
    // and the router's lastDead ignores it.
    // RETURNING: the expiry flips the held id to a TERMINAL state, which the sweep can never
    // name afterwards — without surfacing the ids here the operator learned of the change only
    // by re-querying pending rows (duel-68 sol F3, the silent-expiry half duel-67 left open).
    if (cur.spot_check && status === 'awaiting_judgment') {
      // superseded_by makes the terminal flip durably queryable — the replay path above
      // rebuilds its `superseded` return from it (duel-69 sol M3).
      superseded = (db.prepare(
        `UPDATE duels SET status='abandoned', decided_by='superseded', abandoned_at=?,
             superseded_by=?
           WHERE task_kind=? AND spot_check=1 AND status='routed' AND created_at < ? AND id<>?
           RETURNING id`)
        .all(now, duelId, cur.task_kind, now - DUEL_TTL_MS, duelId) as { id: number }[]).map(r => r.id);
    }
    const demoted = !!cur.spot_check && status === 'awaiting_judgment'
      && !!db.prepare(`SELECT 1 FROM duels WHERE task_kind=? AND spot_check=1
           AND status IN ('routed','awaiting_judgment') AND id<>? LIMIT 1`)
        .get(cur.task_kind, duelId);
    const res = db.prepare(
      `UPDATE duels SET anth_output=?, gpt_output=?, anth_tokens=?, gpt_tokens=?,
       anth_latency_ms=?, gpt_latency_ms=?, anth_proof=?, gpt_proof=?, anth_env=?, gpt_env=?,
       anth_model_attested=?, anth_effort_attested=?, anth_serena_calls=?,
       gpt_model_attested=?, gpt_effort_attested=?, gpt_serena_calls=?, anth_gate=?, gpt_gate=?,
       anth_gate_detail=?, gpt_gate_detail=?,
       status=?, winner_vendor=?, decided_by=?, recorded_at=?, outputs_at=?, spot_check=?,
       demoted_audit=?, abandoned_at=?, superseded_by=?, death_recorded=?,
       recorded_by_version=?
       WHERE id=? AND (status IN ('routed','abandoned','union','awaiting_judgment')
         OR (status='walkover' AND winner_vendor IS NULL
             AND NOT landed(anth_output) AND NOT landed(gpt_output)))`,
    ).run(anthOut, gptOut,
      fill(aLandedNow, a, a.tokens, cur.anth_tokens), fill(gLandedNow, g, g.tokens, cur.gpt_tokens),
      fill(aLandedNow, a, a.latencyMs, cur.anth_latency_ms),
      fill(gLandedNow, g, g.latencyMs, cur.gpt_latency_ms),
      // A failed side's proof is not attestation and is never claimed, so storing it would
      // leave a proof column the claim rules disagree about — and the next process start
      // would backfill it as spent, burning a session id that never attested anything.
      // Same for an unclaimable (unverified lane-A) proof: stored columns feed the
      // legacyProofOwner scan, so storing one would spend it through the back door.
      keep(aLandedNow, a, aClaim ? a.proof ?? null : null, cur.anth_proof),
      keep(gLandedNow, g, gClaim ? g.proof ?? null : null, cur.gpt_proof),
      fill(aLandedNow, a, a.environment ?? null, cur.anth_env),
      fill(gLandedNow, g, g.environment ?? null, cur.gpt_env),
      keep(aLandedNow, a, identities.get('anthropic')?.model ?? null,
        cur.anth_model_attested),
      keep(aLandedNow, a, identities.get('anthropic')?.effort ?? null,
        cur.anth_effort_attested),
      keep(aLandedNow, a, identities.get('anthropic')?.serenaCalls ?? null,
        cur.anth_serena_calls),
      keep(gLandedNow, g, identities.get('openai')?.model ?? null,
        cur.gpt_model_attested),
      keep(gLandedNow, g, identities.get('openai')?.effort ?? null,
        cur.gpt_effort_attested),
      keep(gLandedNow, g, identities.get('openai')?.serenaCalls ?? null,
        cur.gpt_serena_calls),
      fill(aLandedNow, a, a.gate ?? null, cur.anth_gate),
      fill(gLandedNow, g, g.gate ?? null, cur.gpt_gate),
      fill(aLandedNow, a, a.gateDetail ?? null, cur.anth_gate_detail),
      fill(gLandedNow, g, g.gateDetail ?? null, cur.gpt_gate_detail),
      // recorded_at is the sweep's clock and moves on every record; outputs_at is the JUDGE
      // window's clock and moves only when the packet's content actually changes — a revival
      // that changes nothing keeps it, so judge runs completed before the sweep still record
      // (duel-64 opus #3), while a repair resets it so pre-repair runs cannot vote on a packet
      // they never saw. The unchanged-packet fallback mirrors the READER's chain — ALL of it
      // (outputs_at ?? recorded_at ?? created_at): the 2.6.8 spelling terminated on `now`, so
      // a pre-2.6.4 row (BOTH clock columns NULL) still had its judge window stamped with the
      // revival time, the F2 defect alive one migration generation further back (duel-66 opus
      // I2 / sol F2). `now` is never a correct fallback here — an unchanged packet's outputs
      // did not become newer. abandoned_at is cleared by this UPDATE: any record makes the row
      // not-dead, and a stale death stamp would feed the router's backoff clock (duel-66 M6) —
      // EXCEPT the record whose own outcome IS the death: a union double failure stamps `now`,
      // or pendingDuels' death horizon falls back to birth and the freshly-dead row vanishes
      // from every recovery surface the moment it dies (duel-67 opus F2 / sol F3).
      status, winner, decidedBy, deadReplay ? cur.recorded_at : now,
      packetChanged ? now : (cur.outputs_at ?? cur.recorded_at ?? cur.created_at),
      demoted ? 0 : cur.spot_check, demoted ? 1 : (cur.demoted_audit ?? 0),
      status !== 'abandoned' ? null : deadReplay ? cur.abandoned_at : now,
      // superseded_by follows the same rule as abandoned_at: any record that leaves the row
      // ALIVE clears the tombstone — a revived sitter is not a terminal transition, and the
      // stale link made the recording duel's replay claim it was (duel-70, BOTH sides). A row
      // staying dead keeps whatever it holds.
      status !== 'abandoned' ? null : (voidedBy ?? cur.superseded_by ?? null),
      // The dead-replay marker: set by exactly this statement when the record's own outcome IS
      // the death, cleared by any record that leaves the row alive. The sweep never touches it.
      bothFailed ? 1 : 0, recordedBy, duelId);
    if (Number(res.changes) === 0) throw new Error(`duel ${duelId} was recorded concurrently`);
    // The audit slot is spent when the audit RUNS, not when it is routed: resetting the spot
    // counter at route time let a spot duel that died unexecuted buy the incumbent another ten
    // free routes (duel-62 I4/S7). Recording is the execution evidence — but only a record that
    // CARRIES evidence: a double-failure call reads no session file and claims no proof, so
    // letting it spend the slot was the unfalsifiable incumbent through the other door
    // (duel-63 opus #2). A null-winner walkover leaves the debt standing and, being terminal,
    // clears the pending gate — the audit re-fires after the router's backoff. And the slot is
    // spent by the FIRST recording only: re-recording a revived audit's unchanged results
    // subtracted a second interval, forgiving up to ten routes of real debt (duel-64 sol #3).
    // "First recording" = no side had landed yet — NOT `recorded_at == null`, a column that is
    // NULL on every row predating 2.6.4, where the revival re-spent the slot anyway
    // (duel-65 opus F6). A demoted row spends nothing — the in-flight audit owns the debt now.
    if (cur.spot_check && !demoted && !aLandedNow && !gLandedNow
        && (status === 'awaiting_judgment' || winner !== null)) {
      spendSpotAudit(db, cur.task_kind);
    }
    db.exec('COMMIT');
    // SQLite auto-rolls-back on some failures (SQLITE_FULL, certain BUSY/COMMIT paths). An
    // unguarded ROLLBACK then throws "cannot rollback - no transaction is active" and that
    // replaces `e` — the caller loses the double-spend / concurrent-record message it needs to
    // act on. Same guard db.ts's migrate() already uses.
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }

  const stored = getDuel(db, duelId);
  // A non-union double failure returns the union shape too: status 'abandoned', nothing to
  // ship, both sides in `failed` — the row is on the pending surface and revivable by id.
  if (isUnion || bothDead) return withEffortTelemetry(stored, unionResultOf(stored));
  if (walkover) return withEffortTelemetry(stored, { status: 'walkover', winner });
  return withEffortTelemetry(stored,
    { status: 'awaiting_judgment', packet: packetOf(stored),
      ...(superseded.length ? { superseded } : {}) });
}

// Derived from the stored outputs, not from the caller's payload, so the replay path and the
// first-write path answer identically. A failed side stores NULL (see `keep` above), so this
// cannot read a hung lane's interim text as a delivered report. The status comes off the row for
// the same reason: a double failure is stored 'abandoned', and hardcoding 'union' told the
// controller to ship a merge of nothing while `unionRuns` counted no such run.
function unionResultOf(duel: any): UnionResult {
  const sidesRecorded: Vendor[] = [];
  const failed: Vendor[] = [];
  (landedOf(duel.anth_output) ? sidesRecorded : failed).push('anthropic');
  (landedOf(duel.gpt_output) ? sidesRecorded : failed).push('openai');
  return { status: duel.status === 'abandoned' ? 'abandoned' : 'union', sidesRecorded, failed };
}

function packetOf(duel: any): JudgingPacket {
  const labelMap = JSON.parse(duel.label_map) as Record<string, Vendor>;
  const outputs: Record<Vendor, string> = {
    anthropic: duel.anth_output ?? '', openai: duel.gpt_output ?? '',
  };
  return { duelId: duel.id, taskKind: duel.task_kind,
    X: scrubIdentity(outputs[labelMap.X]), Y: scrubIdentity(outputs[labelMap.Y]) };
}

// Judges run as real lane spawns (anthropic judge on B, gpt judge on codex), so their votes
// are attested exactly like duel sides. Without this, the votes that actually decide every
// duel were pure self-report while the sides they judged were not.
export function recordJudgment(
  db: DatabaseSync, duelId: number, judgeVendor: Vendor,
  verdict: JudgeToken, now: number = Date.now(),
  // onBeforeWriteLock fires immediately before BEGIN IMMEDIATE and exists for one thing: a
  // racing-writer test needs an interleave point, and synchronous node:sqlite offers no other
  // way to commit a rival's vote in the window the vocabulary guard has to close. Same hook
  // shape (and same reason) as openDb's onHealTxnBegin. Production never passes it.
  opts: { proof?: string | null; roots?: ProofRoots; rationale?: string | null;
    gradeX?: string | null; gradeY?: string | null; path?: string | null;
    briefDefect?: string | null;
    onBeforeWriteLock?: () => void } = {},
  // winner is null exactly when decidedBy is 'merge': a terminal judged row whose ship is the
  // controller's composition of both sides.
): ({ status: 'awaiting_judgment' }
  | { status: 'judged'; winner: Vendor | null; decidedBy: string; taskKind: string }
  | { status: 'unresolved'; taskKind: string; decidedBy: string; factCheck?: string })
  & { judge_serena_calls?: number } {
  // v2.13.28: letter grades ride beside the verdict, observational only — resolveVerdict never
  // reads them. Validated first and pure: a refused grade writes nothing and spends nothing.
  // Both-or-neither because a single graded side has no comparable meaning in one duel's GPA.
  const gradeX = opts.gradeX ?? null;
  const gradeY = opts.gradeY ?? null;
  if ((gradeX === null) !== (gradeY === null)) {
    throw new Error('grades cover both sides or neither — pass grade_x AND grade_y');
  }
  for (const g of [gradeX, gradeY]) {
    if (g !== null && !(g in GRADE_POINTS)) {
      throw new Error(`'${g}' is not a letter grade — use one of ${Object.keys(GRADE_POINTS).join(' ')}`);
    }
  }
  const path = opts.path ?? null;
  if (path !== null && !(PATH_TOKENS as readonly string[]).includes(path)) {
    throw new Error(`'${path}' is not a path — use one of ${PATH_TOKENS.join(' ')}`);
  }
  const duel = getDuel(db, duelId);
  // Replay-safe like recordResults: a lost response after the resolving vote used to throw
  // here forever, hiding the stored resolution from the caller.
  // These paths record nothing — they read back the stored resolution — so they deliberately
  // run before the attestation block: there is no new vote to attest.
  if (duel.status === 'judged') {
    return { status: 'judged', winner: duel.winner_vendor as Vendor,
      decidedBy: duel.decided_by as string, taskKind: duel.task_kind };
  }
  if (duel.status === 'unresolved') {
    // The reason is the actionable half: 'both_failed' means re-run the task, 'unresolved' means
    // both sides were correct and either may ship. A bare status told the caller neither.
    // The fact-check offer replays too: the lost-reply retry IS the call whose offer would
    // otherwise vanish with the response.
    const decidedBy = (duel.decided_by as string) ?? 'unresolved';
    const ret: { status: 'unresolved'; taskKind: string; decidedBy: string; factCheck?: string } =
      { status: 'unresolved', taskKind: duel.task_kind, decidedBy };
    if (decidedBy === 'contested') {
      const vs = db.prepare(
        'SELECT verdict FROM judgments WHERE duel_id=? ORDER BY id').all(duelId) as any[];
      if (vs.length >= 2 && headOnSplit(vs[0].verdict, vs[1].verdict)) {
        ret.factCheck = FACT_CHECK_OFFER;
      }
    }
    return ret;
  }
  // A union is not judged, ever. Silently accepting votes here would let a union kind accumulate
  // 'judged' rows — a contest record for a kind that deliberately has no contest.
  if (duel.union_mode) {
    throw new Error(`duel ${duelId} is a union run for '${duel.task_kind}' — union kinds ship the ` +
      `merge of both outputs and are never judged; do not spawn judges, merge the reports instead`);
  }
  // Revivable for the same reason recordResults revives one: the sweep is a wall-clock guess, and
  // a late judge is not a wrong judge. An abandoned row is judgeable exactly when it still holds
  // both attested outputs; created_at is untouched by the sweep, so the judge's own attestation
  // window is unchanged.
  // The legacy-dead shape falls through too: it is dead like an abandoned row, and both land
  // on the blank-side repair message below — 'not awaiting judgment' is the diagnosis that
  // sends an operator to re-route, destroying the attestation window (duel-74 opus F5).
  if (duel.status !== 'awaiting_judgment' && duel.status !== 'abandoned' && !isLegacyDead(duel)) {
    throw new Error(`duel ${duelId} not awaiting judgment`);
  }
  // A vote is cast against BOTH stored outputs, and recordResults' landed predicate applies
  // here too: a blank side (a pre-2.6.1 hung lane's error text) is not a rival, it is a side
  // still missing. A "verdict" against it would be fabricated — and it would feed the
  // standings record as a quality signal (duel-64 opus #2 / sol #4). Abandoned rows get
  // this message too, not 'not awaiting judgment': the fix for both is the same record_duel
  // repair, and the wrong rejection sent the operator to re-route instead (duel-65 opus F4).
  if (!(landedOf(duel.anth_output) && landedOf(duel.gpt_output))) {
    throw new Error(`duel ${duelId} has a blank stored side — a judge cannot vote against an `
      + 'empty rival; repair the blank side via record_duel first');
  }

  const roots = opts.roots ?? defaultProofRoots();
  // The anthropic judge runs on lane B, so an unresolvable offload refuses its vote for the same
  // reason it refuses a B side: the `root != null` guard below is the caller's skip switch, and
  // a broken config must not borrow it.
  if (judgeVendor === 'anthropic') {
    const unresolved = bUnresolved(roots, 'anthropic judge');
    if (unresolved) throw new Error(unresolved);
  }
  const root = judgeVendor === 'anthropic' ? roots.B : roots.codex;
  let judgeIdentity: ProofIdentity = { model: null, effort: null, serenaCalls: null };
  if (root != null) {
    const agent = judgeVendor === 'anthropic' ? 'model-routing:claude-b' : 'codex:codex-rescue';
    if (!opts.proof || !PROOF_RE.test(opts.proof)) {
      throw new Error(`${judgeVendor} judge has no usable proof — pass the judge run's session id; ` +
        `spawn the judge via Agent subagent_type ${agent}, never in-session`);
    }
    // Judge proofs are lane-matched like side proofs: the protocol fixes the gpt judge at
    // gpt-5.6-sol ON THE CODEX LANE, and every codex-family run writes into the same directory, so
    // identity + freshness alone let a spark rollout cast the codex judge's vote (duel-62
    // I2/S4). Same asymmetry as sides: spark must be positively identified, an unclassifiable
    // rollout still attests codex. The anthropic judge's lane check IS its root — only lane B
    // writes under the offload dir's projects/. Known bounded hole: codexLaneOf reads head+tail only,
    // so a >512KiB rollout whose /model switch sits entirely in the middle classifies by its
    // head (duel-63 sol#6) — accepted; judge runs are one-shot and small, and a full-file scan
    // per attestation is unbounded I/O.
    const accept = judgeVendor === 'openai' ? laneAccept('codex') : undefined;
    // The window is the OUTPUTS clock, not the routing clock: a judge vote is about the packet,
    // so its run must postdate the outputs it voted on. Freshness from created_at accepted any
    // session that merely postdated routing — started before the sides finished, it could not
    // have seen the packet, yet its id claimed the judge slot (duel-63 sol#1). And recorded_at
    // moves on every re-record (the sweep needs it to), so reviving an abandoned row pushed the
    // window past judge runs that completed before the sweep, losing them outright (duel-64
    // opus #3). outputs_at moves only when the packet's content changes; legacy rows fall back
    // to recorded_at, then created_at — the old behavior.
    const sinceMs = (duel.outputs_at ?? duel.recorded_at ?? duel.created_at) as number;
    const artifact = pickRunFile(root, sinceMs, opts.proof, accept,
      { startMode: judgeVendor === 'anthropic' ? 'earliest' : 'line1' });
    if (artifact === null) {
      throw new Error(`unattested ${judgeVendor} judge: no ${judgeVendor === 'openai'
        ? 'codex-lane ' : ''}session file under ${root} since the duel's results were recorded ` +
        `matching proof "${opts.proof}" — spawn the judge via Agent subagent_type ${agent}`);
    }
    judgeIdentity = proofIdentity(artifact.path, judgeVendor);
  }

  // The resolving vote and the resolution it triggers commit as ONE transaction: committing
  // the second vote first left a window where a process death stranded two spent judge proofs
  // on an 'awaiting_judgment' row, which the sweep then abandoned with no reconciliation pass
  // to find it (duel-62 sol#5). resolveVerdict is pure, so it can run under the write lock.
  opts.onBeforeWriteLock?.();
  db.exec('BEGIN IMMEDIATE');
  let rows: any[];
  let v: ReturnType<typeof resolveVerdict> | null = null;
  try {
    // The vocabulary guard reads INSIDE the write lock, like recordResults recomputes landedOf
    // from a fresh read rather than trusting its pre-lock snapshot (duel-63 sol#3). Read outside,
    // it was a check-then-insert: an already-running pre-v2.11.0 MCP server — the ops doc
    // promises exactly that topology, "an old MCP server keeps its code until its session
    // restarts" — could commit its default-graded=0 vote in the window between the count and
    // BEGIN IMMEDIATE, and this process would then resolve a legacy preference token together
    // with an absolute grade and persist a fabricated result (duel-174 F1).
    //
    // WHICH combinations are refused, and why they differ. The two vocabularies answer different
    // questions with overlapping tokens ('X' meant "X is better", now "X is the only side that
    // meets the bar"), so a MIXED pair is silently meaningless rather than loudly wrong:
    //   - any legacy vote already paired with a graded one → refuse (already mixed, and only the
    //     race above can produce it);
    //   - a legacy vote present and this call would add the graded second vote → refuse, because
    //     the pair it forms would be mixed (duel #167's shape);
    //   - a COMPLETE all-legacy pair → resolve. Nothing is mixed: both votes speak one
    //     vocabulary and passingSides reads it ('tie' → both sides cleared, legacy 'X'/'Y' → that
    //     side cleared). The blanket refusal stranded exactly this state — a pre-upgrade crash
    //     between the second legacy INSERT and the duel UPDATE leaves a losslessly resolvable
    //     duel whose two judge proofs are already spent, so refusing it cost two fresh judge runs
    //     for votes the DB already held (duel-174 F2). The incoming vote is discarded by the
    //     unique index here (both vendors have voted), so no graded row joins the legacy pair.
    // Refusing before claimProof keeps a rejected call free: the caller's session id is not
    // spent, and the ROLLBACK below un-claims it even if that ever changes.
    const votes = db.prepare(
      'SELECT judge_vendor, graded FROM judgments WHERE duel_id=?').all(duelId) as any[];
    const legacyVotes = votes.filter(r => !r.graded).length;
    if (legacyVotes && !(legacyVotes === votes.length && votes.length >= 2)) {
      throw new Error(`duel ${duelId} holds a pre-v2.11.0 preference vote ('better than', not `
        + `'meets the bar') — the vocabularies cannot be mixed; delete the stored vote(s) and `
        + `re-judge BOTH sides with the absolute-grade template, or leave the row unjudged`);
    }
    // A judge vote is attested exactly like a duel side, from the same spent-proof namespace:
    // re-passing a side's session id (or another duel's judge run) is not a second real run.
    // Every attested proof is spent, including one whose verdict the unique index discards: a
    // re-spawned judge is still a real run that happened for THIS duel, and leaving its id
    // unclaimed left a fresh, reusable proof lying around. Re-sending the same id is a no-op —
    // claimProof returns when the existing claim is this duel and this slot AND its vote still
    // stands. The claim runs BEFORE the insert: with the vote already in place, a spent judge
    // proof whose verdict a repair had deleted looked exactly like that no-op replay, and the
    // old run re-voted on a packet it never saw (duel-65 sol S4).
    if (opts.proof) claimProof(db, duelId, `judge:${judgeVendor}`, opts.proof, now);
    // A duplicate insert must NOT short-circuit: if a crash landed between the second insert
    // and the status update, the retry is the only thing that can still resolve the duel.
    db.prepare(
      `INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, graded, rationale,
         judge_model_attested, judge_serena_calls, judge_effort_attested,
         grade_x, grade_y, path, brief_defect)
       VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?)
       ON CONFLICT(duel_id, judge_vendor) DO NOTHING`,
    // The rationale goes through the SAME scrub as the packet it answers. SKILL's leak rule
    // ("a rationale naming a vendor, lane or model breaks the blind — drop it") was prose with
    // nothing behind it: 211 complied by controller discipline alone. The scrub is the half a
    // machine can do without judgement — session paths, offload dirs, rollout ids, model
    // self-identification — and it has no false positives. The SEMANTIC half stays with the
    // controller on purpose: duels on THIS repo are about routing between vendors, so a
    // rationale that says "X handles the codex lane correctly" is on-topic, not a leak, and a
    // blanket refusal would delete honest reasoning. A leak is also evidence the judge was not
    // blind, so the rule drops the rationale and TELLS the operator rather than silently
    // erasing what happened.
    ).run(duelId, judgeVendor, verdict, now, opts.proof ?? null,
      opts.rationale != null ? scrubIdentity(opts.rationale) : null,
      judgeIdentity.model, judgeIdentity.serenaCalls, judgeIdentity.effort, gradeX, gradeY, path,
      // v2.13.44: quoted brief text the judge found split-inducingly ambiguous. Same scrub
      // as the rationale — it is judge-authored prose and rides the same blind.
      opts.briefDefect != null ? scrubIdentity(opts.briefDefect) : null);
    rows = db.prepare(
      'SELECT judge_vendor, verdict, path FROM judgments WHERE duel_id=? ORDER BY id',
    ).all(duelId) as any[];
    if (rows.length >= 2) {
      v = resolveVerdict([rows[0].verdict, rows[1].verdict], JSON.parse(duel.label_map), {
        anthTokens: duel.anth_tokens, gptTokens: duel.gpt_tokens,
        anthLatencyMs: duel.anth_latency_ms, gptLatencyMs: duel.gpt_latency_ms,
        // The leg v2.11.0's plan left unwired: without these two the resolver's gate branch
        // read undefined on every production row, so SKILL's "a failed gate overrides any
        // judge vote" was prose with dead code behind it.
        anthGate: duel.anth_gate, gptGate: duel.gpt_gate,
      }, [rows[0].path ?? null, rows[1].path ?? null]);
      if (v.decidedBy === 'merge') {
        // Terminal and judged, not unresolved: nothing is discarded and nothing re-runs — the
        // ship is the controller's composition, and no side is credited a win for it.
        db.prepare(
          "UPDATE duels SET status='judged', winner_vendor=NULL, decided_by='merge' WHERE id=?",
        ).run(duelId);
      } else if (v.winner === null) {
        // Every OTHER no-winner spelling lands on status 'unresolved' and is told apart by
        // decided_by: one status keeps every consumer (pendingDuels, standings, the CLI, the
        // recovery docs) on one branch, and the reason is what the operator acts on.
        db.prepare(
          "UPDATE duels SET status='unresolved', winner_vendor=NULL, decided_by=? WHERE id=?",
        ).run(v.decidedBy, duelId);
      } else {
        db.prepare("UPDATE duels SET status='judged', winner_vendor=?, decided_by=? WHERE id=?")
          .run(v.winner, v.decidedBy, duelId);
      }
    }
    db.exec('COMMIT');
    // SQLite auto-rolls-back on some failures (SQLITE_FULL, certain BUSY/COMMIT paths). An
    // unguarded ROLLBACK then throws "cannot rollback - no transaction is active" and that
    // replaces `e` — the caller loses the double-spend / concurrent-record message it needs to
    // act on. Same guard db.ts's migrate() already uses.
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }

  const judgeSerena = judgeIdentity.serenaCalls === null
    ? {} : { judge_serena_calls: judgeIdentity.serenaCalls };
  if (rows.length < 2 || v === null) return { status: 'awaiting_judgment', ...judgeSerena };
  if (v.decidedBy === 'merge') {
    return { status: 'judged', winner: null, decidedBy: 'merge', taskKind: duel.task_kind,
      ...judgeSerena };
  }
  if (v.winner === null) {
    const ret: { status: 'unresolved'; taskKind: string; decidedBy: string; factCheck?: string } =
      { status: 'unresolved', taskKind: duel.task_kind, decidedBy: v.decidedBy };
    if (v.decidedBy === 'contested' && headOnSplit(rows[0].verdict, rows[1].verdict)) {
      ret.factCheck = FACT_CHECK_OFFER;
    }
    return { ...ret, ...judgeSerena };
  }
  return { status: 'judged', winner: v.winner, decidedBy: v.decidedBy, taskKind: duel.task_kind,
    ...judgeSerena };
}
