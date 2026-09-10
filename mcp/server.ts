#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
// Moved to src/ at v2.13.21: the handshake is no longer its only consumer — the mint, the
// first recording and the pending surface all stamp or compare the running build. Re-exported
// here because it was this module's public surface first.
import { pluginVersion } from '../src/version.js';
import { routeTask } from '../src/router.js';
import { getDuel, landedOf, recordResults, recordJudgment, type ProofRoots } from '../src/duel.js';
import { LETTER_GRADES, type LetterGrade } from '../src/scoring.js';
import { recordOutcome } from '../src/outcomes.js';
import { standings, pendingDuels } from '../src/standings.js';
import { HARD_PCT, SOFT_PCT, laneStatus } from '../src/quota/pace.js';
import { latestSnapshot, pollAll, reauthNeeded } from '../src/quota/poll.js';
import { seedMatrix } from '../src/matrix.js';
import { courierUndeliverable, offloadDir } from '../src/paths.js';
import type { Lane } from '../src/types.js';

export { pluginVersion };

const REFRESH_MS = 600_000;
const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
const sideResult = {
  output: z.string().nullable().optional(), output_path: z.string().optional(),
  tokens: z.number().nullable(),
  latency_ms: z.number().nullable(), failed: z.boolean(),
  proof: z.string().nullable().optional(),
  environment: z.string().nullable().optional(),
  gate: z.enum(['pass', 'fail']).nullable().optional(),
  gate_detail: z.string().nullable().optional(),
};

// Both artifact reads in outputOf go through here. Open the final component with O_NOFOLLOW,
// inspect that SAME descriptor with fstat, enforce the cap, then read that descriptor and close
// it in finally. O_NONBLOCK keeps a caller-named FIFO/device from hanging before fstat refuses it.
// Residual, stated: a symlink in a PARENT directory still resolves — no containment root exists.
const MAX_ARTIFACT_BYTES = 2_000_000; // reports run ~50KB; 40x headroom still refuses a log

function readArtifact(vendor: string, what: string, p: string,
    opts: { missingNull?: boolean } = {}): string | null {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`${vendor}: ${what} is a symlink — pass the resolved real path`);
    }
    if (opts.missingNull) return null;
    throw new Error(`${vendor}: ${what} unreadable — ${e instanceof Error ? e.message : e}`);
  }
  try {
    let st;
    try { st = fstatSync(fd); } catch (e) {
      if (opts.missingNull) return null;
      throw new Error(`${vendor}: ${what} unreadable — ${e instanceof Error ? e.message : e}`);
    }
    if (!st.isFile()) throw new Error(`${vendor}: ${what} is not a regular file`);
    if (st.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`${vendor}: ${what} is ${st.size} bytes (cap ${MAX_ARTIFACT_BYTES}) — `
        + `that is not a duel report`);
    }
    try { return readFileSync(fd, 'utf8'); } catch (e) {
      if (opts.missingNull) return null;
      throw new Error(`${vendor}: ${what} unreadable — ${e instanceof Error ? e.message : e}`);
    }
  } finally {
    closeSync(fd);
  }
}

// The ledger's copy of a report used to be the controller RE-TYPING it into this call, and a
// retype drifts silently: duel 206 stored a paraphrase of the codex side (smart quotes
// flattened, a docs URL dropped, four fixes reworded) while the scratch file matched the
// rollout byte for byte. output_path makes the FILE the transport — the bytes on disk are the
// bytes stored — and pinning the name it must carry turns SKILL's scratch-persistence rule
// into an invariant: a side recorded this way cannot exist without its artifact on disk.
// Absolute only: the server's cwd is wherever the MCP host started it, never the controller's
// (duel 206's scratch lived in a different repo than the running server).
function outputOf(duelId: number, vendor: 'anthropic' | 'openai', r: any): string | null {
  const p = r.output_path;
  if (p == null) {
    if (r.output != null && !r.failed) {
      throw new Error(`${vendor}: inline output is the retype-drift channel v2.13.7 closed — `
        + `persist the report and pass output_path (inline text is legal only on a `
        + `failed: true side)`);
    }
    return r.output ?? null;
  }
  if (r.output != null) throw new Error(`${vendor}: pass output OR output_path, never both`);
  if (!isAbsolute(p)) throw new Error(`${vendor}: output_path must be absolute, got '${p}'`);
  const want = `duel${duelId}-${vendor}.md`;
  if (basename(p) !== want) {
    throw new Error(`${vendor}: output_path must be named '${want}' (SKILL scratch convention), `
      + `got '${basename(p)}'`);
  }
  const text = readArtifact(vendor, 'output_path', p)!; // no missingNull: never null here
  if (!text.trim()) throw new Error(`${vendor}: output_path is empty — persist the report first`);
  // The brief lives beside the reports or it does not survive at all. For a review duel it is
  // never a file to begin with — it exists only as prompt text inside the two spawn calls — so
  // "persist the brief" silently meant "author a file nobody scheduled", and duels 206 and 208
  // both shipped without one while 207, minted the same hour, wrote its own. Habit does not
  // hold a rule; the scratch dir that carries a report must carry the brief that produced it.
  const brief = join(dirname(p), `duel${duelId}-brief.md`);
  // A missing/unreadable brief falls through to the "no brief" error below; a symlinked,
  // non-regular or oversize one is a hygiene refusal in its own right.
  const briefText = readArtifact(vendor, 'brief', brief, { missingNull: true }) ?? '';
  if (!briefText.trim()) {
    throw new Error(`${vendor}: no brief beside the report — write the brief the sides were `
      + `spawned from to '${brief}' before recording`);
  }
  // The comparison SKILL's blessed-copy step ran by hand is now the record gate's own refusal:
  // a duel records only from a linted brief, and only from the exact bytes lint blessed. Both
  // ends hash the utf8-decoded text, so the digest matches what `mrctl brief-lint` wrote.
  const sidecar = readArtifact(vendor, 'brief sidecar', `${brief}.sha256`, { missingNull: true });
  if (sidecar == null) {
    throw new Error(`${vendor}: no .sha256 sidecar beside the brief — a duel records only from `
      + `a linted brief; a passing 'mrctl brief-lint' run writes '${brief}.sha256' (copy the `
      + `sidecar along if the brief moved dirs)`);
  }
  if (!sidecar.trim().toLowerCase()
    .startsWith(createHash('sha256').update(briefText).digest('hex'))) {
    throw new Error(`${vendor}: brief does not match its .sha256 sidecar — the brief changed `
      + `after linting; re-run 'mrctl brief-lint' on the final text and re-spawn from it`);
  }
  return text;
}

const toSide = (duelId: number, vendor: 'anthropic' | 'openai', r: any, stored: unknown) =>
  ({ output: landedOf(stored) ? stored : outputOf(duelId, vendor, r),
    tokens: r.tokens, latencyMs: r.latency_ms,
    failed: r.failed, proof: r.proof ?? null, environment: r.environment ?? null,
    gate: r.gate ?? null, gateDetail: r.gate_detail ?? null });

export function createServer(db: DatabaseSync, opts: { proofRoots?: ProofRoots } = {}): McpServer {
  const server = new McpServer({ name: 'model-routing', version: pluginVersion() });

  server.registerTool('route_task',
    { description: 'Route a subagent task: duel both vendors, union both vendors (run both, ship '
        + 'the MERGE, no judges), or single model, quota-aware. '
        + 'kind must be a lowercase slug; tier (haiku|sonnet|opus|fable) seeds a brand-new '
        + 'kind at that tier instead of cloning the default row. '
        + 'Response carries b_config_dir on any decision with a lane-B side, and on every '
        + 'duel/union: a duel needs it for the lane-B-fixed anthropic judge, a union because '
        + 'its anthropic side may itself be lane B (a union is never judged). Pass it as the '
        + 'ConfigDir: header line to EVERY claude-b courier it covers, judges included.',
      inputSchema: z.object({ kind: z.string(), mutating: z.boolean().optional(),
        tier: z.enum(['haiku', 'sonnet', 'opus', 'fable']).optional() }) },
    async ({ kind, mutating, tier }) => {
      const a = latestSnapshot(db, 'A');
      if (!a || Date.now() - a.fetchedAt > REFRESH_MS) {
        try { await pollAll(db); } catch { /* stale routing beats blocked routing */ }
      }
      // Resolve the offload dir up front: failure closes lane B for this route (never a silent
      // same-account dispatch); success rides along so the controller can hand the forwarder
      // its CLAUDE_CONFIG_DIR via the ConfigDir: courier header.
      let bDir: string | null = null; let bErr: string | undefined;
      // `|| 'unknown error'`: bBlocked is read as a boolean by routeTask, so a falsy non-Error
      // throw (`throw ''`, `throw 0`) would stringify to '' and fail OPEN — routing lane B on
      // an unresolved dir, the one outcome this block exists to prevent.
      try {
        bDir = offloadDir();
        // Resolved but undeliverable (pin outside $HOME/.claude-*): the forwarder's ConfigDir
        // allowlist refuses it on every spawn, so close lane B at routing time instead of
        // minting duels whose B sides and judges all die on CLAUDE-B-FAILED: bad ConfigDir.
        const bad = courierUndeliverable(bDir);
        if (bad) {
          bErr = `resolved offload dir is not courier-deliverable (${bad}) — re-pin `
            + `MR_B_CONFIG_DIR/MR_AUX_* to an absolute $HOME/.claude-<suffix> path`;
          bDir = null;
        }
      } catch (e) { bErr = String(e) || 'unknown error'; }
      const d = routeTask(db, { kind, mutating, tier }, Date.now(), { bBlocked: bErr });
      // Judges are protocol-fixed to lanes B and codex and never call route_task, so a DUEL
      // needs the offload dir even when neither side routed to B (an anth-lane-A duel:
      // architecture-design, debugging). Without it the courier falls back to ~/.claude-b,
      // and under a flipped main account the judge's vote is proof-refused against
      // bProjects(). A union is never judged — it rides along so that every multi-side
      // decision carries the dir uniformly, and because its anthropic side may be lane B
      // anyway. Single-mode with no B side reaches lane B nowhere: no field at all.
      const reachesB = d.mode === 'duel' || d.mode === 'union' || d.sides.some(s => s.lane === 'B');
      return json(reachesB ? { ...d, b_config_dir: bDir } : d);
    });

  server.registerTool('record_duel',
    { description: 'Record both sides\' outputs/metrics (proof = the real run\'s session id, '
        + 'mandatory for B/codex/spark sides); rejects unattested or reused proofs; '
        + 'model is attested from the proof artifact and a mismatch refuses the recording; '
        + 'effort is attested and mismatches are flagged in effort_mismatch, never refused. '
        + 'returns blinded judging packet, walkover, or — for a union run — the list of sides '
        + 'that landed (merge those; one failed side still closes the row). latency_ms is '
        + 'bounded both ways: a claim above the duel row\'s own age is refused, and on the '
        + 'FIRST recording a claim >60s below the side\'s attested session-artifact span is '
        + 'refused too — pass the measured wall-clock or null (null on a first recording is '
        + 'auto-measured from the artifact span; revivals, late union fills, and blank-side '
        + 'repairs of an already-recorded row skip the floor and keep null — a pre-record '
        + 'gate-repair round is NOT one of these: its side still records fresh, so a null is '
        + 'auto-measured, repair included when the resume extended the same artifact; an '
        + 'artifact spanning longer than the duel row has existed '
        + 'measures nothing, and on a first recording a proof naming more than one session '
        + 'file is refused by name — delete the stray copy and re-record). Both sides failed '
        + '(union or not) → status "abandoned": nothing to ship, the row is death-stamped, '
        + 'stays on the pending list, and is revivable by id. A "superseded" key lists older '
        + 'in-flight audits this recording displaced — they died because this audit SUCCEEDED; '
        + 'revive one by id if its lanes really ran, otherwise leave it alone. '
        + 'Pass superseded_by = the re-duel\'s id to VOID a round — legal only alongside both '
        + 'sides failed:true. It tombstones the row so no later session revives a round you '
        + 'threw away on purpose: a brief defect that reaches BOTH sides is the case this '
        + 'exists for (a judge is structurally blind to that class, so voiding is correct), '
        + 'and without the tombstone the row reads "abandoned, revivable by id" for a week. '
        + 'Each side may carry environment = one line naming its unseen fighting conditions '
        + '(tools/MCP available, network, sandbox, respawn count) — stored for the operator\'s '
        + 'session report, and now stored for a failed side too when the row holds none: that '
        + 'is where a voided round records WHY. Each side may also carry gate = the '
        + 'CONTROLLER\'s build/test result for its tree ("pass"/"fail", null for read-only '
        + 'kinds) — unlike environment this DECIDES: a failed gate overrides any judge vote. '
        + 'A non-null gate REQUIRES gate_detail = its receipts, the commands run and their '
        + 'pass/fail counts, the target repo\'s FULL existing suite included — a bare token is '
        + 'refused (duel 298: gate said pass while one tree failed its repo\'s own suite). '
        + 'Every attested Claude-lane side also stores serena_calls — the number of mcp__serena* tool calls in its session file (null when the artifact holds no tool-bearing turn, and always null for the codex family) — and the reply carries serena_calls per vendor. '
        + 'A landed (non-failed) side MUST pass output_path (an ABSOLUTE path to the persisted '
        + 'scratch file, which must be named duel<duel_id>-anthropic.md / '
        + 'duel<duel_id>-openai.md). Inline output on a failed:true side is accepted, but the '
        + 'engine stores that failed side\'s output as NULL — put WHY in environment, which a '
        + 'failed side does persist. Never pass both output spellings. With output_path the ledger stores the '
        + 'artifact\'s exact bytes; inline text is retyped and drifts from the file it came '
        + 'from (duel 206). An output_path side '
        + 'also needs duel<duel_id>-brief.md, non-empty, in that same dir — write the brief the '
        + 'sides were spawned from before recording — plus the .sha256 sidecar a passing '
        + '\'mrctl brief-lint\' run writes beside it; a brief whose bytes no longer hash to '
        + 'that sidecar is refused (lint the FINAL text and spawn from those exact bytes). '
        + 'Replaying an already-recorded duel (or '
        + 'filling a union\'s missing side) does not require the consumed side\'s scratch files '
        + 'to still exist — a landed side answers from the ledger.',
      inputSchema: z.object({ duel_id: z.number(),
        anthropic: z.object(sideResult), openai: z.object(sideResult),
        superseded_by: z.number().optional() }) },
    async ({ duel_id, anthropic, openai, superseded_by }) => {
      let duel: any;
      try { duel = getDuel(db, duel_id); } catch (e) {
        // Unknown ids still flow through recordResults so its public error remains authoritative.
        if (!(e instanceof Error) || e.message !== `no duel ${duel_id}`) throw e;
      }
      // A landed side's output never comes from disk again — scratch is consumable after recording.
      const r = recordResults(db, duel_id,
        { anthropic: toSide(duel_id, 'anthropic', anthropic, duel?.anth_output),
          openai: toSide(duel_id, 'openai', openai, duel?.gpt_output) },
        { roots: opts.proofRoots, supersededBy: superseded_by ?? null });
      return json(r);
    });

  server.registerTool('record_judgment',
    { description: 'Record one blind judge GRADE with the judge run\'s session id as proof. The '
        + 'judge grades each solution against an absolute bar (correct, complete, in-scope) — it '
        + 'does NOT state a preference: "both" = both pass, "X"/"Y" = only that side passes, '
        + '"neither" = neither passes. A side passes only when NEITHER judge failed it. The '
        + 'second grade resolves the duel: one passer wins on quality; two passers go to the '
        + 'clock (fastest correct answer wins); no passer resolves "unresolved" with decided_by '
        + '"both_failed" (the judges agreed nothing met the bar, OR both sides failed their '
        + 'build/test gate, whatever the judges said) or "contested" (the judges failed '
        + 'different sides, so no side is proven) — in '
        + 'both cases discard BOTH outputs, tell the operator, and re-run. A HEAD-ON contested '
        + 'split (verdicts X and Y) additionally returns factCheck = the fact-check-round offer '
        + 'to surface to the operator BEFORE discarding; replays of the resolved row return it '
        + 'too. decided_by '
        + '"unresolved" means both sides passed and the clock could not separate them: either '
        + 'may ship. Vocabularies are never MIXED: a duel already holding a pre-v2.11.0 '
        + 'preference vote refuses a graded vote — re-judge both sides rather than combining '
        + 'them, and the refusal costs nothing because it fires before the proof is claimed. A '
        + 'duel holding a COMPLETE pre-v2.11.0 pair is not mixed and still resolves, so a '
        + 'crash-stranded legacy duel stays recoverable. '
        + 'The judge\'s serena call count is attested from its session file the same way and returned as judge_serena_calls. '
        + 'Pass rationale = the judge\'s written reason, verbatim, blind X/Y terms only — it is '
        + 'stored for the operator\'s session report and never influences resolution. '
        + 'Pass brief_defect = the QUOTED brief clause (verbatim, blind-safe) when the judge '
        + 'finds a requirement that admits two readings and the sides split along them — '
        + 'observational, it marks contested-by-ambiguity for the operator and feeds the next '
        + 'lint class; omit it when the brief text is not the cause',
      inputSchema: z.object({ duel_id: z.number(),
        judge_vendor: z.enum(['anthropic', 'openai']),
        verdict: z.enum(['X', 'Y', 'both', 'neither']),
        // v2.13.28: the judge's letter grade per blind side. Observational — stored for the
        // operator's GPA trend, never consulted by resolution. Both-or-neither (engine-enforced).
        grade_x: z.enum(LETTER_GRADES as [LetterGrade, ...LetterGrade[]]).optional(),
        grade_y: z.enum(LETTER_GRADES as [LetterGrade, ...LetterGrade[]]).optional(),
        // v2.13.29: the judge's path recommendation. Advisory — EXCEPT when both judges say
        // 'merge' and both sides passed (gates included): the duel then resolves decided_by
        // 'merge', winner null, a terminal judged row whose ship is the controller's
        // composition of both diffs (which must pass the deciding gate before it ships).
        path: z.enum(['X', 'Y', 'merge']).optional(),
        proof: z.string().nullable().optional(),
        rationale: z.string().nullable().optional(),
        // v2.13.44: the judge's brief-defect flag — quoted requirement text whose two readings
        // the sides split along. Observational; never consulted by resolution.
        brief_defect: z.string().nullable().optional() }) },
    async ({ duel_id, judge_vendor, verdict, grade_x, grade_y, path, proof, rationale,
      brief_defect }) => {
      const r = recordJudgment(db, duel_id, judge_vendor, verdict, Date.now(),
        { proof: proof ?? null, rationale: rationale ?? null,
          gradeX: grade_x ?? null, gradeY: grade_y ?? null, path: path ?? null,
          briefDefect: brief_defect ?? null,
          roots: opts.proofRoots });
      return json(r);
    });

  server.registerTool('record_outcome',
    { description: 'Log a FAIL or PROMOTE outcome (scorecard successor). A ≥2 streak on a ladder '
        + 'model is FLAGGED in the reply and shifts nothing — the engine never moves the matrix '
        + '(operator-only re-pairing, 2026-08-10); surface the flag to the operator. '
        + 'Outcomes need no proof: they record your own observation of a run you already made. '
        + 'Spark can no longer be handed a row it was not seeded onto (earn-in retired), so an '
        + 'outcome for a kind spark does not route is logged and refused. '
        + 'integrity:true marks a PROVEN falsification/fabrication (falsified truth-gate, '
        + 'fabricated verification claim): while spark holds the row, one such FAIL raises an '
        + 'immediate OPERATOR REVIEW flag (no 2-streak); nothing is ever auto-evicted',
      inputSchema: z.object({ date: z.string(), task_kind: z.string(), model: z.string(),
        kind: z.enum(['FAIL', 'PROMOTE']), evidence: z.string(),
        integrity: z.boolean().optional(),
        proof: z.string().nullable().optional() }) },
    async (o) => {
      const r = recordOutcome(db, { date: o.date, taskKind: o.task_kind, model: o.model,
        kind: o.kind, evidence: o.evidence, integrity: o.integrity ?? false,
        proof: o.proof ?? null },
        Date.now(), { roots: opts.proofRoots });
      // r.applied is permanently null since v2.10.1 — outcomes flag, only the operator moves
      // the matrix (and the operator's own tools rewrite the fallback doc).
      return json(r);
    });

  server.registerTool('quota_status',
    { description: 'Per-lane utilization, pace, reset time, state, and every live model-scoped '
        + 'pool (modelPools)', inputSchema: z.object({}) },
    async () => {
      const now = Date.now();
      const lanes: Lane[] = ['A', 'B', 'codex', 'spark'];
      // `stale` alone cannot distinguish "nobody polled" from "the oauth login is dead and every
      // poll since has 401'd". The second needs a human, so it rides along here as well as on
      // the SessionStart dashboard.
      return json(lanes.map(l => {
        const u = latestSnapshot(db, l);
        // laneStatus answers for ONE model: called with none it reports the ACCOUNT view alone,
        // and on 2026-09-02 that had this tool calling lane B `open` at 7% weekly while the fable
        // pool on the same lane sat at 100% (duel 391 M7). The SessionStart hook line already
        // reads the windows directly for exactly this reason — so does this, rather than paying
        // a laneStatus pass per model to re-derive the same account figures each time.
        const modelPools = (u?.windows ?? []).filter(w => w.model && w.resetsAt > now).map(w => ({
          model: w.model!, utilization: w.utilization, resetsAt: w.resetsAt,
          state: w.utilization >= HARD_PCT ? 'closed'
            : w.utilization >= SOFT_PCT ? 'soft' : 'open',
        }));
        // Additive: the account-level `state` stays the account's own reading — a closed pool
        // here must not close the lane for the models that still have headroom.
        return { ...laneStatus(u, now, l), reauthNeeded: reauthNeeded(l, now), modelPools };
      }));
    });

  server.registerTool('standings',
    { description: 'Duel standings per task-kind (current model+effort pairing; wins split '
        + 'by decision channel: judges (quality) then latency (time) — tokens decide nothing; '
        + 'plus gpa: each side\'s letter-grade average (overall and split by grading judge, '
        + '4.3 scale) over the window\'s graded votes — the quality trend the win counts '
        + 'cannot carry; plus mergedShips: judged duels resolved decided_by merge (both '
        + 'judges directed a composition — shipped, credited to neither side); '
        + 'the latency channel also reports how much time each win saved — total and median ms '
        + 'per side, plus netLatencyMs across every judged duel that stored both clocks) '
        + '+ pending/revivable duels '
        + '(routed, awaiting_judgment, recently abandoned, union missing a side — act on '
        + 'these by id; a true `displaced` marks a displaced tombstone — supersededBy names '
        + 'the recording duel when a current writer could stamp it, null for pre-2.6.12 '
        + 'deaths: revive it only if its lanes really ran, never record a double failure '
        + 'against it. A true `voided` is the same tombstone with the OPPOSITE rule: the '
        + 'controller threw that round away on purpose and re-duelled it, so NEVER revive it '
        + 'however well its lanes ran)',
      inputSchema: z.object({}) },
    async () => json({ kinds: standings(db), pending: pendingDuels(db) }));

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const db = openDb();
  seedMatrix(db); // idempotent — a fresh DB never throws 'matrix not seeded'
  const server = createServer(db);
  await server.connect(new StdioServerTransport());
}
