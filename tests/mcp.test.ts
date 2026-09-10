import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, utimesSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Lane, WindowUsage } from '../src/types.js';

process.env.MR_DATA_DIR = mkdtempSync(join(tmpdir(), 'mr-mcp-'));
// Pin the offload dir: route_task now resolves it up front, and this suite must not depend on
// the real $HOME's account layout. Per-file on purpose — lanedirs.test.ts exercises the
// un-pinned resolver and would break under a suite-wide pin. The pin must be DELIVERABLE
// ($HOME/.claude-<suffix>, the courier allowlist route_task now enforces) or lane B closes on
// it — and it is only ever compared as a string, so the dir is never created or touched
// (mcp-undeliverable.test.ts owns the refused-pin case).
// The pin carries a trailing slash ON PURPOSE: the resolver must canonicalize it away before
// the gate and the ConfigDir forward, so every route_task in this suite proves the slashed
// spelling still DELIVERS — b_config_dir asserts compare against the canonical string below.
process.env.MR_B_CONFIG_DIR = join(homedir(), '.claude-mcptest') + '/';
const B_DIR_CANON = join(homedir(), '.claude-mcptest');
const { openDb } = await import('../src/db.js');
const { seedMatrix } = await import('../src/matrix.js');
const { storeSnapshot } = await import('../src/quota/poll.js');
const { getDuel, FACT_CHECK_OFFER } = await import('../src/duel.js');
const { createServer } = await import('../mcp/server.js');

const B_ID = '6d15b6ee-23c1-48a2-b51c-1836bf431724';
const C_ID = '019f959a-1ac1-7bf3-a0d5-c30f463dde69';
const J_B_ID = 'd93815ca-0219-4dd7-9b21-1836bf431724';
const J_C_ID = '019f95bb-2cd2-8ac4-b1e6-d41f574eef70';

// Real proof roots, so the server's rejection path is exercised through the tool surface.
function attestedRoots() {
  const base = mkdtempSync(join(tmpdir(), 'mr-mcp-roots-'));
  const B = join(base, 'b'); const codex = join(base, 'c');
  mkdirSync(B, { recursive: true }); mkdirSync(codex, { recursive: true });
  return { B, codex };
}

// A duel records only from a linted brief: write the brief with the .sha256 sidecar a passing
// `mrctl brief-lint` run leaves beside it, in sha256sum's own `<hash>  <name>` spelling.
function bless(briefPath: string, text: string) {
  writeFileSync(briefPath, text);
  writeFileSync(`${briefPath}.sha256`,
    `${createHash('sha256').update(text).digest('hex')}  ${basename(briefPath)}\n`);
}

function scratchPair(duelId: number, anthropic: string, openai: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  const aPath = join(dir, `duel${duelId}-anthropic.md`);
  const gPath = join(dir, `duel${duelId}-openai.md`);
  writeFileSync(aPath, anthropic); writeFileSync(gPath, openai);
  bless(join(dir, `duel${duelId}-brief.md`), 'TASK: MCP fixture.\n');
  return { aPath, gPath };
}
// Session files must post-date the duel row, so they are written when the "run" finishes.
// The line carries a real start stamp: a '{}' fixture parses to no start at all, which silently
// took every server-surface test off the latency-floor path the gate actually runs (duel-163
// tail gap). Stamped at write time, the span is ~0, so the floor is live but never bites.
const attest = (roots: any, lane: 'B' | 'codex', id: string, startMs = Date.now()) =>
  writeFileSync(join(lane === 'B' ? roots.B : roots.codex,
    lane === 'B' ? `${id}.jsonl` : `rollout-${id}.jsonl`),
    `{"timestamp":"${new Date(startMs).toISOString()}"}\n`);

async function connected(proofRoots: any = { B: null, codex: null }) {
  const db = openDb(':memory:');
  seedMatrix(db);
  const now = Date.now();
  for (const lane of ['A', 'B', 'codex'] as const) {
    storeSnapshot(db, { lane, fetchedAt: now, windows: [
      { windowMinutes: 300, utilization: 10, resetsAt: now + 3_600_000 },
      { windowMinutes: 10080, utilization: 10, resetsAt: now + 302_400_000 },
    ] });
  }
  const server = createServer(db, { proofRoots });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    return JSON.parse(res.content[0].text);
  };
  // raw form: keeps isError/text so rejection paths can be asserted
  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: String(res.content?.[0]?.text ?? '') };
  };
  return { db, call, raw };
}

function toolByName(name: string): any {
  const server = createServer(openDb(':memory:')) as any;
  return server._registeredTools[name];
}

test('route_task returns duel decision over MCP', async () => {
  const { call } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  assert.equal(d.mode, 'duel');
  assert.equal(d.sides.length, 2);
});

// The forwarder's ConfigDir: header comes from this field and nowhere else, so its presence
// must cover every dispatch that reaches lane B — including the ones no SIDE reveals. The
// anthropic judge is protocol-fixed to lane B and skips route_task entirely, so a judgeable
// decision needs the dir even when both its sides routed elsewhere; without it the judge
// falls back to ~/.claude-b, and under a flipped main account its vote is proof-refused.
test('route_task carries b_config_dir for every decision that reaches lane B — side or judge', async () => {
  const { db, call } = await connected();
  const b = await call('route_task', { kind: 'implementation-misc' }); // seeded anth lane B
  assert.ok(b.sides.some((s: any) => s.lane === 'B'), `expected a lane-B side, got ${JSON.stringify(b.sides)}`);
  assert.equal(b.b_config_dir, B_DIR_CANON); // canonical, not the slashed pin spelling

  // No B side, but two judges are coming — one of them on lane B.
  const a = await call('route_task', { kind: 'architecture-design' }); // seeded anth lane A
  assert.equal(a.mode, 'duel');
  assert.ok(!a.sides.some((s: any) => s.lane === 'B'), `expected no lane-B side, got ${JSON.stringify(a.sides)}`);
  assert.equal(a.b_config_dir, B_DIR_CANON);

  // A single-mode decision with no B side touches lane B nowhere — no duel, so no judges.
  // Closing codex degrades the same kind to a lone lane-A side.
  const t = Date.now();
  storeSnapshot(db, { lane: 'codex', fetchedAt: t, windows: [
    { windowMinutes: 300, utilization: 99, resetsAt: t + 3_600_000 },
    { windowMinutes: 10080, utilization: 99, resetsAt: t + 302_400_000 },
  ] });
  const s = await call('route_task', { kind: 'architecture-design' });
  assert.equal(s.mode, 'single');
  assert.ok(!s.sides.some((x: any) => x.lane === 'B'), `expected no lane-B side, got ${JSON.stringify(s.sides)}`);
  assert.ok(!('b_config_dir' in s), `expected no b_config_dir key, got ${JSON.stringify(s)}`);
});

test('full contested duel round-trip over MCP is excluded from standings', async () => {
  const { db, call } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  const { aPath, gPath } = scratchPair(d.duelId, 'a', 'b');
  // v2.11.0: split grades are contested; the clock may not fabricate a standings winner.
  const rec = await call('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 3000, latency_ms: 900, failed: false,
      gate: 'pass', gate_detail: 'node tests/t.js 10/0' },
    openai: { output_path: gPath, tokens: 5000, latency_ms: 60, failed: false,
      gate: 'pass', gate_detail: 'node tests/t.js 10/0' } });
  assert.equal(rec.status, 'awaiting_judgment');
  // v2.13.50: the snake_case MCP field lands in the per-side receipts columns.
  assert.equal(getDuel(db, d.duelId).anth_gate_detail, 'node tests/t.js 10/0');
  assert.equal(getDuel(db, d.duelId).gpt_gate_detail, 'node tests/t.js 10/0');
  await call('record_judgment', { duel_id: d.duelId, judge_vendor: 'anthropic', verdict: 'X' });
  const fin = await call('record_judgment', { duel_id: d.duelId, judge_vendor: 'openai', verdict: 'Y' });
  // v2.13.49: the head-on fact-check offer rides the MCP reply too, not only the direct call.
  assert.deepEqual(fin,
    { status: 'unresolved', taskKind: 'implementation-misc', decidedBy: 'contested',
      factCheck: FACT_CHECK_OFFER });
  assert.equal(getDuel(db, d.duelId).winner_vendor, null);
  const s = await call('standings');
  assert.equal(s.kinds.find((k: any) => k.kind === 'implementation-misc').judged, 0);
});

// The old `full duel round-trip over MCP updates standings` was CONVERTED into the contested
// case above, so no MCP test proved a RESOLVED duel reaches the public surface at all — the
// successful path survived only in direct-call duel.test.ts (duel-174 F4). This is the addition,
// not a swap: the contested test stays, and this one pins the other half.
test('a passing duel round-trip over MCP is judged on the clock and increments standings', async () => {
  const { db, call } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  const { aPath, gPath } = scratchPair(d.duelId, 'a', 'b');
  const rec = await call('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 3000, latency_ms: 900, failed: false },
    openai: { output_path: gPath, tokens: 5000, latency_ms: 60, failed: false } });
  assert.equal(rec.status, 'awaiting_judgment');
  assert.deepEqual(await call('record_judgment',
    { duel_id: d.duelId, judge_vendor: 'anthropic', verdict: 'both' }),
    { status: 'awaiting_judgment' });
  // both sides met the bar, so — and ONLY so — the clock decides, and openai is the faster one
  const fin = await call('record_judgment',
    { duel_id: d.duelId, judge_vendor: 'openai', verdict: 'both' });
  assert.deepEqual(fin, { status: 'judged', winner: 'openai', decidedBy: 'latency',
    taskKind: 'implementation-misc' });
  // the stored row says the same thing the response did
  const row = getDuel(db, d.duelId);
  assert.deepEqual({ status: row.status, winner: row.winner_vendor, by: row.decided_by },
    { status: 'judged', winner: 'openai', by: 'latency' });
  // …and it reaches standings: counted once, on the time channel. Two identical grades IS judge
  // agreement even though the clock is what separated the sides.
  const s = (await call('standings')).kinds.find((k: any) => k.kind === 'implementation-misc');
  assert.deepEqual(
    { judged: s.judged, gptWins: s.gptWins, gl: s.gptLatencyWins, gj: s.gptJudgeWins,
      pct: s.judgeAgreementPct },
    { judged: 1, gptWins: 1, gl: 1, gj: 0, pct: 100 });
  // …and the margin reaches the MCP surface with it: the win was 840ms wide, and that is the
  // whole wall-clock difference the window measured.
  assert.deepEqual(
    { saved: s.gptLatencySavedMs, med: s.gptLatencyMedianMs, aSaved: s.anthLatencySavedMs,
      aMed: s.anthLatencyMedianMs, net: s.netLatencyMs },
    { saved: 840, med: 840, aSaved: 0, aMed: null, net: -840 });
});

test('quota_status returns four lanes', async () => {
  const { call } = await connected();
  const q = await call('quota_status');
  assert.deepEqual(q.map((l: any) => l.lane).sort(), ['A', 'B', 'codex', 'spark']);
});

test('record_outcome flags the streak at threshold and never shifts', async () => {
  const { call } = await connected();
  const o = { date: '2026-07-23', task_kind: 'implementation-misc', model: 'sonnet',
    kind: 'FAIL', evidence: 'test' };
  assert.equal((await call('record_outcome', o)).applied, null);
  const r = await call('record_outcome', o);
  assert.equal(r.applied, null);
  assert.match(r.reason, /FLAGGED/);
});

test('record_outcome says why nothing was applied instead of a bare null', async () => {
  const { call } = await connected();
  const r = await call('record_outcome', { date: '2026-07-23', task_kind: 'long-context',
    model: 'claude-sonnet-5', kind: 'FAIL', evidence: 'mistyped model id' });
  assert.equal(r.applied, null);
  assert.match(r.reason, /not on either ladder/);
});

test('long-context streaks flag despite the [1m] model suffix', async () => {
  const { call } = await connected();
  const o = { date: '2026-07-23', task_kind: 'long-context', model: 'fable[1m]',
    kind: 'PROMOTE', evidence: 'aced it' };
  assert.equal((await call('record_outcome', o)).applied, null);
  const r = await call('record_outcome', o);
  assert.equal(r.applied, null);
  assert.match(r.reason, /fable\[1m\]/); // suffixed id classified and reported verbatim
  assert.match(r.reason, /FLAGGED/);
});

test('with attestation on, the server rejects an unproven duel and accepts a proven one', async () => {
  const roots = attestedRoots();
  const { call, raw } = await connected(roots);
  const d = await call('route_task', { kind: 'implementation-misc' });
  const { aPath, gPath } = scratchPair(d.duelId, 'a', 'b');
  attest(roots, 'B', B_ID); attest(roots, 'codex', C_ID);

  const noProof = await raw('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 100, latency_ms: 50, failed: false },
    openai: { output_path: gPath, tokens: 500, latency_ms: 60, failed: false } });
  assert.ok(noProof.isError);
  assert.match(noProof.text, /no usable proof/);

  const zeroTokens = await raw('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 0, latency_ms: 50, failed: false, proof: B_ID },
    openai: { output_path: gPath, tokens: 500, latency_ms: 60, failed: false, proof: C_ID } });
  assert.ok(zeroTokens.isError);
  assert.match(zeroTokens.text, /tokens=0/);

  const good = await call('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 100, latency_ms: 50, failed: false, proof: B_ID },
    openai: { output_path: gPath, tokens: 500, latency_ms: 60, failed: false, proof: C_ID } });
  assert.equal(good.status, 'awaiting_judgment');

  // judges are attested too — a vote with no proof cannot decide a duel
  const badVote = await raw('record_judgment',
    { duel_id: d.duelId, judge_vendor: 'anthropic', verdict: 'X' });
  assert.ok(badVote.isError);
  assert.match(badVote.text, /no usable proof/);

  attest(roots, 'B', J_B_ID); attest(roots, 'codex', J_C_ID);
  await call('record_judgment',
    { duel_id: d.duelId, judge_vendor: 'anthropic', verdict: 'X', proof: J_B_ID });
  const fin = await call('record_judgment',
    { duel_id: d.duelId, judge_vendor: 'openai', verdict: 'X', proof: J_C_ID });
  assert.equal(fin.status, 'judged');
});


test('a duel side is attested by its OWN codex-family lane, through the tool surface', async () => {
  const roots = attestedRoots();
  const { call, raw } = await connected(roots);
  const settings = (model: string) => JSON.stringify({ type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model, model_provider_id: 'openai' } } });
  const spark = 'gpt-5.3-codex-spark';
  // mechanical-apply seeds haiku vs spark, so the openai side routes the spark LANE.
  const routed = await call('route_task', { kind: 'mechanical-apply' });
  assert.equal(routed.sides[1].lane, 'spark');
  const { aPath, gPath } = scratchPair(routed.duelId, 'haiku findings', 'findings');

  // A codex-lane rollout is a real, recent file under the same root — every codex-family lane
  // writes into one directory, so identity and freshness alone say nothing about which lane ran.
  const codexId = '019f95cc-1111-0000-0000-000000000001';
  writeFileSync(join(roots.codex, `rollout-${codexId}.jsonl`), settings('gpt-5.6-sol') + '\n');
  const side = (proof: string) => ({ output_path: gPath, tokens: 900, latency_ms: 100,
    failed: false, proof });
  const bId = '019f95cc-3333-0000-0000-000000000003';
  attest(roots, 'B', bId);
  const anthropic = { output_path: aPath, tokens: 500, latency_ms: 90,
    failed: false, proof: bId };
  const wrongLane = await raw('record_duel', { duel_id: routed.duelId,
    anthropic, openai: side(codexId) });
  assert.ok(wrongLane.isError);
  assert.match(wrongLane.text, /unattested spark-lane side/);

  // …and spark's own rollout attests it.
  const sparkId = '019f95cc-2222-0000-0000-000000000002';
  writeFileSync(join(roots.codex, `rollout-${sparkId}.jsonl`), settings(spark) + '\n');
  const ok = await call('record_duel', { duel_id: routed.duelId, anthropic, openai: side(sparkId) });
  assert.equal(ok.status, 'awaiting_judgment');
});

// The floor and its null derivation were only ever exercised in-process; at the tool surface the
// artifacts were '{}' stubs with no parseable start, so the whole gate no-opped there.
test('the latency floor and its null derivation run at the tool surface', async () => {
  const roots = attestedRoots();
  const { db, call, raw } = await connected(roots);
  const t0 = Date.now();
  const d = await call('route_task', { kind: 'implementation-misc' });
  // A 10-minute artifact is only possible on a row that has existed for 10 minutes, so the duel
  // is backdated to one routed 15 minutes ago. Stamping the span onto a seconds-old row instead
  // measured a latency the claim path refuses outright (duel-166) — that shape is its own test
  // below, and it must not be the fixture the floor's happy path rides on.
  db.prepare('UPDATE duels SET created_at = ? WHERE id = ?').run(t0 - 900_000, d.duelId);
  const bId = '019f95dd-4444-0000-0000-000000000004';
  const cId = '019f95dd-5555-0000-0000-000000000005';
  const { aPath, gPath } = scratchPair(d.duelId, 'a', 'b');
  attest(roots, 'codex', cId);
  // the B artifact starts 10s after routing and is still being written 10 minutes later
  attest(roots, 'B', bId, t0 - 890_000);
  const end = (t0 - 290_000) / 1000;
  utimesSync(join(roots.B, `${bId}.jsonl`), end, end);

  const body = (latency_ms: number | null) => ({ duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 100, latency_ms, failed: false, proof: bId },
    openai: { output_path: gPath, tokens: 500, latency_ms: 60, failed: false, proof: cId } });
  const under = await raw('record_duel', body(1_000));
  assert.ok(under.isError);
  assert.match(under.text, /impossible: its own session file spans/);
  // …and re-sending null does not dodge the clock channel: the span becomes the measurement
  const good = await call('record_duel', body(null));
  assert.equal(good.status, 'awaiting_judgment');
  const derived = getDuel(db, d.duelId).anth_latency_ms as number;
  assert.ok(Math.abs(derived - 600_000) < 1_000, `derived ${derived}`);
});

// The row's age bounds a MEASURED artifact exactly as it bounds a claimed number. A file spanning
// longer than its duel has existed is contradicting itself, and the engine refuses to read a clock
// off it in either direction — it neither mints the impossible measurement (which would decide the
// duel on the clock channel) nor floors an honest claim against it.
test('an artifact spanning longer than the duel has existed measures nothing', async () => {
  const roots = attestedRoots();
  const { db, call } = await connected(roots);
  // both rows first: a proof is single-use, and every artifact must post-date the row it attests
  const d1 = await call('route_task', { kind: 'implementation-misc' });
  const d2 = await call('route_task', { kind: 'implementation-misc' });
  const t0 = Date.now();
  const ids = (n: string) => ({ b: `019f95dd-6666-0000-0000-00000000000${n}`,
    c: `019f95dd-7777-0000-0000-00000000000${n}` });
  const plant = (n: string) => {
    const { b, c } = ids(n);
    attest(roots, 'codex', c);
    // artifact still being written 10 minutes into the future, on a seconds-old duel
    attest(roots, 'B', b, t0 + 5_000);
    const end = (t0 + 605_000) / 1000;
    utimesSync(join(roots.B, `${b}.jsonl`), end, end);
  };
  const body = (duel_id: number, n: string, latency_ms: number | null) => {
    const { aPath, gPath } = scratchPair(duel_id, 'a', 'b');
    return { duel_id,
      anthropic: { output_path: aPath, tokens: 100, latency_ms, failed: false, proof: ids(n).b },
      openai: { output_path: gPath, tokens: 500, latency_ms: 60, failed: false, proof: ids(n).c } };
  };

  // nothing is minted: the null stays null rather than persisting ten impossible minutes
  plant('1');
  assert.equal((await call('record_duel', body(d1.duelId, '1', null))).status, 'awaiting_judgment');
  assert.equal(getDuel(db, d1.duelId).anth_latency_ms, null);

  // and the same span refuses nothing: an honest small claim records instead of being called
  // impossible by an artifact that is itself impossible
  plant('2');
  assert.equal((await call('record_duel', body(d2.duelId, '2', 1_000))).status, 'awaiting_judgment');
  assert.equal(getDuel(db, d2.duelId).anth_latency_ms, 1_000);
});

test('quota_status meters spark like every lane and flags a lane needing re-auth', async () => {
  // Spark is metered (duel 268): with no rollout-derived snapshot the lane is unknown, not
  // open — the "unmetered, never gated" contract died with the usage_limit_exceeded incident.
  const { call } = await connected();
  const lanes = await call('quota_status');
  const spark = lanes.find((l: any) => l.lane === 'spark');
  assert.equal(spark.state, 'stale');
  assert.equal(spark.weeklyUtilization, null);
  assert.equal(spark.resetsAt, null);
  assert.equal(lanes.every((l: any) => 'reauthNeeded' in l), true);
});

// The account view is not the whole lane. laneStatus called with no model reports the account
// windows alone, so on 2026-09-02 this tool called lane B `open` at 7% weekly while the fable
// pool on that same lane sat at 100% and every fable dispatch to it 429'd (duel 391 M7). The
// SessionStart hook line has printed the live pools beside the weekly all along; the MCP caller
// got no such data. Now every live model-tagged window rides along, in snapshot order.
test('quota_status lists every live model-scoped pool per lane (duel 407)', async () => {
  const { db, call } = await connected();
  const now = Date.now();
  // The same account pair connected() seeds: the pools must ride ALONGSIDE these, never replace
  // them, and a newer snapshot has to carry them or the lane reads stale for unrelated reasons.
  const account = (): WindowUsage[] => [
    { windowMinutes: 300, utilization: 10, resetsAt: now + 3_600_000 },
    { windowMinutes: 10080, utilization: 10, resetsAt: now + 302_400_000 },
  ];
  const F = now + 26 * 3_600_000;      // a live reset, comfortably ahead of the handler's clock
  const PAST = now - 3_600_000;        // a window that has already reset — no longer live data
  const rows: Array<{ label: string; lane: Lane; windows?: WindowUsage[]; fetchedAt?: number;
    want: Array<{ model: string; utilization: number; resetsAt: number; state: string }> }> = [
    { label: 'a hard-capped pool reports closed', lane: 'B', fetchedAt: now + 1_000,
      windows: [...account(), { windowMinutes: 10080, utilization: 100, resetsAt: F, model: 'fable' }],
      want: [{ model: 'fable', utilization: 100, resetsAt: F, state: 'closed' }] },
    { label: 'two pools, each with its own state, in snapshot order', lane: 'A',
      fetchedAt: now + 1_000,
      windows: [...account(),
        { windowMinutes: 10080, utilization: 85, resetsAt: F, model: 'fable' },
        { windowMinutes: 10080, utilization: 12, resetsAt: F, model: 'opus' }],
      want: [{ model: 'fable', utilization: 85, resetsAt: F, state: 'soft' },
        { model: 'opus', utilization: 12, resetsAt: F, state: 'open' }] },
    // An expired pool describes usage that no longer exists — laneStatus drops such a window and
    // so must this list, or a long-reset pool would report closed forever after it reopened.
    { label: 'an expired pool is not reported', lane: 'A', fetchedAt: now + 2_000,
      windows: [...account(), { windowMinutes: 10080, utilization: 100, resetsAt: PAST, model: 'fable' }],
      want: [] },
    { label: 'an account-only snapshot reports no pools', lane: 'codex', want: [] },
    { label: 'a lane with no snapshot at all reports no pools', lane: 'spark', want: [] },
  ];
  for (const r of rows) {
    if (r.windows) storeSnapshot(db, { lane: r.lane, fetchedAt: r.fetchedAt!, windows: r.windows });
    const lanes = await call('quota_status');
    const lane = lanes.find((l: any) => l.lane === r.lane);
    assert.deepEqual(lane.modelPools, r.want, r.label);
    // The field is additive: nothing the controller already reads may drop off the lane object.
    assert.equal(lanes.every((l: any) => 'reauthNeeded' in l), true, r.label);
  }
  // A pool at 100% closes the lane for THAT model only. The account-level state is a separate
  // reading and must not move — a caller that sees `closed` here would stop routing work the
  // lane can still take, which is the mirror image of the blindness this field fixes.
  const b = (await call('quota_status')).find((l: any) => l.lane === 'B');
  assert.equal(b.state, 'open');
  assert.deepEqual(b.modelPools, [{ model: 'fable', utilization: 100, resetsAt: F, state: 'closed' }]);
});

test('the MCP handshake advertises the real plugin version, not a hard-coded one', async () => {
  const { pluginVersion } = await import('../mcp/server.js');
  assert.match(pluginVersion(), /^\d+\.\d+\.\d+$/);
  assert.notEqual(pluginVersion(), '0.0.0'); // 0.0.0 means the lookup fell through
});

test('standings over MCP lists pending duels, so ids survive the transcript', async () => {
  const { call } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  const s = await call('standings');
  const p = s.pending.find((r: any) => r.id === d.duelId);
  assert.equal(p.kind, 'implementation-misc');
  assert.equal(p.status, 'routed');
});

// A non-union double failure returns 'abandoned' since 2.6.11: nothing to ship, the row is
// death-stamped and revivable by id.
test('a double failure records abandoned over MCP', async () => {
  const { call } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  const r = await call('record_duel', { duel_id: d.duelId,
    anthropic: { output: null, tokens: null, latency_ms: null, failed: true },
    openai: { output: null, tokens: null, latency_ms: null, failed: true } });
  assert.equal(r.status, 'abandoned');
});

test('record_judgment accepts the four grade tokens and rejects the retired ones', async () => {
  const tool = toolByName('record_judgment');
  const shape = tool.inputSchema.shape.verdict;
  assert.deepEqual(shape.options, ['X', 'Y', 'both', 'neither']);
  assert.throws(() => shape.parse('tie'));
  assert.throws(() => shape.parse('draw'));
});

// Rule-2 composed test for v2.12.3 (scrubIdentity reads the env pins) + v2.12.4 (route_task
// gates the resolved offload dir through the courier allowlist): both fixes act on the SAME
// state — the MR_B_CONFIG_DIR pin — in one scenario, so neither can cancel the other unseen.
// The feared cancellations: a gate that false-refuses the deliverable pin degrades the route
// to single, and the duel whose packet the scrub protects is never minted at all (the scrub
// leg then "passes" vacuously); a scrub that skips deliverable/$HOME pins — v2.12.3 was only
// ever proven on /srv pins — leaks into the blind packet exactly the dir the gate just judged.
// The suite pin's trailing slash rides along on purpose: the gate judges the CANONICAL
// spelling, and the scrub canonicalizes its pins the same way (v2.12.8), so both a leaked
// session path (canonical dir + '/projects/…') and a bare-dir echo of the canonical dir
// must scrub under the slashed pin's rule.
test('composed: the deliverable pin both routes lane B through the gate and is scrubbed from the packet', async () => {
  const { call } = await connected();
  // Gate leg (v2.12.4): the pin resolves, passes the courier allowlist, and lane B actually
  // routes — a duel with a lane-B side, carrying the canonical dir for the courier headers.
  const d = await call('route_task', { kind: 'implementation-misc' });
  assert.equal(d.mode, 'duel');
  assert.ok(d.sides.some((s: any) => s.lane === 'B'),
    `expected a lane-B side, got ${JSON.stringify(d.sides)}`);
  assert.equal(d.b_config_dir, B_DIR_CANON);
  // Scrub leg (v2.12.3): both sides leak the session path a B child really writes — the SAME
  // dir the gate just shipped, in its canonical spelling. Only the env-pin rule can catch it:
  // the literal .claude-[ab] rule does not match `.claude-mcptest`.
  const anth = `report at ${B_DIR_CANON}/projects/-h/${B_ID}.jsonl done`
    + `; spawned with CLAUDE_CONFIG_DIR=${B_DIR_CANON}`;
  const gpt = `saw ${B_DIR_CANON}/projects/-h/peer.jsonl too`;
  const { aPath, gPath } = scratchPair(d.duelId, anth, gpt);
  const rec = await call('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 3000, latency_ms: 900, failed: false },
    openai: { output_path: gPath, tokens: 5000, latency_ms: 60, failed: false } });
  assert.equal(rec.status, 'awaiting_judgment');
  for (const label of ['X', 'Y'] as const) {
    assert.ok(!rec.packet[label].includes('.claude-mcptest'),
      `${label} leaks the pinned offload dir: ${rec.packet[label]}`);
    assert.match(rec.packet[label], /<path>/);
  }
});

// Duel 206: the ledger's copy of the codex report was a RETYPE — smart quotes flattened, a docs
// URL dropped, four fixes reworded — while `.review-scratch/duel206-openai.md` matched the
// rollout byte for byte. output_path removes the retype (the file is the transport) and the
// pinned filename makes SKILL's scratch-persistence rule structural for a side's first recording.
test('record_duel takes each report from its scratch file byte for byte, and pins the filename', async () => {
  const { db, call, raw } = await connected();
  const d = await call('route_task', { kind: 'deep-review' }); // union: no judges to stage
  assert.equal(d.mode, 'union');
  const dir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  // Exactly the shapes the duel-206 retype mangled: curly quotes, a URL, a two-backtick span.
  const anth = '# Report\n\n- **[CRITICAL]** flush treats the JSON error as “not ingested”\n'
    + '  see https://code.claude.com/docs/en/hooks#sessionend-input and ``[[concepts/a]]``\n';
  const gpt = '# Other report\n\n- ‘fine’\n';
  const aPath = join(dir, `duel${d.duelId}-anthropic.md`);
  const gPath = join(dir, `duel${d.duelId}-openai.md`);
  writeFileSync(aPath, anth); writeFileSync(gPath, gpt);
  bless(join(dir, `duel${d.duelId}-brief.md`), 'TASK: review the thing.\n');
  const emptyDir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  writeFileSync(join(emptyDir, `duel${d.duelId}-anthropic.md`), '   \n');
  const goneDir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  // v2.13.17 artifact hygiene: outputOf was a bare readFileSync, so any local file wearing the
  // pinned name — or reachable through a symlink wearing it — was slurped into the ledger whole.
  // All fixtures are pure node:fs: one lane's sandbox cannot spawn subprocesses at all.
  const linkDir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  writeFileSync(join(linkDir, 'elsewhere.md'), '# a real file, elsewhere\n');
  symlinkSync(join(linkDir, 'elsewhere.md'), join(linkDir, `duel${d.duelId}-anthropic.md`));
  const dirDir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  mkdirSync(join(dirDir, `duel${d.duelId}-anthropic.md`));
  const bigDir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  writeFileSync(join(bigDir, `duel${d.duelId}-anthropic.md`), 'x'.repeat(2_000_001));

  const side = (o: Record<string, unknown>) => ({ tokens: 100, latency_ms: null, failed: false, ...o });
  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ['both spellings at once', { output: 'retyped', output_path: aPath }, /never both/],
    ['a relative path', { output_path: `duel${d.duelId}-anthropic.md` }, /must be absolute/],
    ['a file named anything else', { output_path: join(dir, 'notes.md') }, /must be named/],
    ['the rival side\'s file', { output_path: gPath }, /must be named/],
    ['a file nobody wrote', { output_path: join(goneDir, `duel${d.duelId}-anthropic.md`) }, /unreadable/],
    ['an empty file', { output_path: join(emptyDir, `duel${d.duelId}-anthropic.md`) }, /empty/],
    ['a symlink wearing the name', { output_path: join(linkDir, `duel${d.duelId}-anthropic.md`) }, /symlink/],
    ['a directory wearing the name', { output_path: join(dirDir, `duel${d.duelId}-anthropic.md`) }, /not a regular file/],
    ['a report past the size cap', { output_path: join(bigDir, `duel${d.duelId}-anthropic.md`) }, /cap/],
  ];
  for (const [why, anthSide, msg] of refusals) {
    const r = await raw('record_duel', { duel_id: d.duelId,
      anthropic: side(anthSide), openai: side({ output_path: gPath }) });
    assert.ok(r.isError, `${why} should be refused, got ${r.text}`);
    assert.match(r.text, msg, why);
    assert.equal(getDuel(db, d.duelId).status, 'routed', `${why} must not record`);
  }

  const rec = await call('record_duel', { duel_id: d.duelId,
    anthropic: side({ output_path: aPath }), openai: side({ output_path: gPath }) });
  assert.equal(rec.status, 'union');
  assert.deepEqual(rec.sidesRecorded.sort(), ['anthropic', 'openai']);
  // The point of the whole change: stored === the artifact, not a paraphrase of it.
  assert.equal(getDuel(db, d.duelId).anth_output, anth);
  assert.equal(getDuel(db, d.duelId).gpt_output, gpt);

  // Union step 7 replay: a landed side is immutable, so re-recording from the same paths (or
  // from an edited file) leaves the stored bytes alone rather than silently re-writing them.
  writeFileSync(aPath, anth + '\n(edited after recording)\n');
  const again = await call('record_duel', { duel_id: d.duelId,
    anthropic: side({ output_path: aPath }), openai: side({ output_path: gPath }) });
  assert.equal(again.status, 'union');
  assert.equal(getDuel(db, d.duelId).anth_output, anth);
});

test('record_duel artifact resolution follows landed state', async t => {
  const side = (output_path: string) =>
    ({ output_path, tokens: 100, latency_ms: null, failed: false });
  const rows: { name: string; run: () => Promise<void> }[] = [
    {
      name: 'full replay uses both landed ledger outputs after scratch cleanup',
      run: async () => {
        const { db, call } = await connected();
        const d = await call('route_task', { kind: 'deep-review' });
        const paths = scratchPair(d.duelId, 'landed anthropic', 'landed openai');
        const body = { duel_id: d.duelId,
          anthropic: side(paths.aPath), openai: side(paths.gPath) };
        const first = await call('record_duel', body);
        const stored = getDuel(db, d.duelId);
        rmSync(dirname(paths.aPath), { recursive: true });

        const replay = await call('record_duel', body);
        const after = getDuel(db, d.duelId);
        // The response matches the first engine answer, and neither stored report changes.
        assert.deepEqual(replay, first);
        assert.equal(after.anth_output, stored.anth_output);
        assert.equal(after.gpt_output, stored.gpt_output);
      },
    },
    {
      name: 'late union fill resolves only the missing side after landed scratch cleanup',
      run: async () => {
        const { db, call } = await connected();
        const d = await call('route_task', { kind: 'deep-review' });
        const firstPaths = scratchPair(d.duelId, 'original anthropic', 'unused openai');
        const first = await call('record_duel', { duel_id: d.duelId,
          anthropic: side(firstPaths.aPath),
          openai: { output: 'lane failed', tokens: null, latency_ms: null, failed: true } });
        assert.deepEqual(first.sidesRecorded, ['anthropic']);
        const storedAnthropic = getDuel(db, d.duelId).anth_output;
        rmSync(dirname(firstPaths.aPath), { recursive: true });
        const freshPaths = scratchPair(d.duelId, 'unused replacement', 'fresh openai');

        const fill = await call('record_duel', { duel_id: d.duelId,
          anthropic: side(firstPaths.aPath), openai: side(freshPaths.gPath) });
        const after = getDuel(db, d.duelId);
        // The missing side lands, while the already-landed side retains its original bytes.
        assert.deepEqual(fill.sidesRecorded.sort(), ['anthropic', 'openai']);
        assert.equal(after.anth_output, storedAnthropic);
        assert.equal(after.gpt_output, 'fresh openai');
      },
    },
    {
      name: 'missing output_path is refused for a side that has not landed',
      run: async () => {
        const { db, call, raw } = await connected();
        const d = await call('route_task', { kind: 'deep-review' });
        const paths = scratchPair(d.duelId, 'missing anthropic', 'present openai');
        unlinkSync(paths.aPath);

        const refused = await raw('record_duel', { duel_id: d.duelId,
          anthropic: side(paths.aPath), openai: side(paths.gPath) });
        // A fresh missing report is unreadable and leaves both ledger outputs empty.
        assert.ok(refused.isError);
        assert.match(refused.text, /unreadable/);
        assert.equal(getDuel(db, d.duelId).anth_output, null);
        assert.equal(getDuel(db, d.duelId).gpt_output, null);
      },
    },
    {
      name: 'symlinked output_path is refused for a side that has not landed',
      run: async () => {
        const { db, call, raw } = await connected();
        const d = await call('route_task', { kind: 'deep-review' });
        const paths = scratchPair(d.duelId, 'linked anthropic', 'present openai');
        const realPath = join(dirname(paths.aPath), 'elsewhere.md');
        unlinkSync(paths.aPath);
        writeFileSync(realPath, 'linked anthropic');
        symlinkSync(realPath, paths.aPath);

        const refused = await raw('record_duel', { duel_id: d.duelId,
          anthropic: side(paths.aPath), openai: side(paths.gPath) });
        // A fresh symlinked report is rejected and leaves both ledger outputs empty.
        assert.ok(refused.isError);
        assert.match(refused.text, /symlink/);
        assert.equal(getDuel(db, d.duelId).anth_output, null);
        assert.equal(getDuel(db, d.duelId).gpt_output, null);
      },
    },
  ];

  for (const row of rows) await t.test(row.name, row.run);
});

// Composed rule-2 test for v2.13.7 (the file is the transport) + v2.13.8 (the brief sits beside
// it): both act on the SAME state — the scratch dir named by output_path — so neither can pass
// while cancelling the other. The feared cancellations: a brief check that reads the wrong dir
// refuses every honest recording (and the byte-fidelity leg then never runs at all), or a
// transport that resolves the report before the brief is looked for, which is exactly how
// duels 206 and 208 recorded reports whose briefs never became files.
test('composed: a report recorded from its scratch file is stored verbatim AND needs its brief there', async () => {
  const { db, call, raw } = await connected();
  const d = await call('route_task', { kind: 'deep-review' });
  const dir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  const anth = '# A\n\n- ships “as written”\n'; const gpt = '# B\n\n- ditto\n';
  const aPath = join(dir, `duel${d.duelId}-anthropic.md`);
  const gPath = join(dir, `duel${d.duelId}-openai.md`);
  const briefPath = join(dir, `duel${d.duelId}-brief.md`);
  writeFileSync(aPath, anth); writeFileSync(gPath, gpt);
  const side = (p: string) => ({ output_path: p, tokens: 100, latency_ms: null, failed: false });
  const body = { duel_id: d.duelId, anthropic: side(aPath), openai: side(gPath) };

  // Reports on disk, no brief: duel 206's shape exactly — refused, and nothing recorded.
  const noBrief = await raw('record_duel', body);
  assert.ok(noBrief.isError);
  assert.match(noBrief.text, /no brief beside the report/);
  assert.match(noBrief.text, new RegExp(`duel${d.duelId}-brief\\.md`));
  assert.equal(getDuel(db, d.duelId).status, 'routed');

  // A brief that exists but says nothing is not a brief.
  writeFileSync(briefPath, '\n  \n');
  const blankBrief = await raw('record_duel', body);
  assert.ok(blankBrief.isError);
  assert.match(blankBrief.text, /no brief beside the report/);

  // Brief hygiene rides the same read: a symlinked brief used to be followed silently and
  // SATISFY the gate — it is now refused outright, and so is a brief past the artifact cap.
  unlinkSync(briefPath);
  writeFileSync(join(dir, 'elsewhere-brief.md'), 'TASK: linked.\n');
  symlinkSync(join(dir, 'elsewhere-brief.md'), briefPath);
  const linkedBrief = await raw('record_duel', body);
  assert.ok(linkedBrief.isError);
  assert.match(linkedBrief.text, /symlink/);
  unlinkSync(briefPath);
  writeFileSync(briefPath, 'x'.repeat(2_000_001));
  const bigBrief = await raw('record_duel', body);
  assert.ok(bigBrief.isError);
  assert.match(bigBrief.text, /cap/);

  // v2.13.40 legs ride the same state: the brief now also needs the .sha256 sidecar a passing
  // brief-lint run writes. Real brief, no sidecar — lint never blessed these bytes.
  writeFileSync(briefPath, 'TASK: deep review of the pipeline. Read-only.\n');
  const noSidecar = await raw('record_duel', body);
  assert.ok(noSidecar.isError);
  assert.match(noSidecar.text, /no \.sha256 sidecar/);
  assert.equal(getDuel(db, d.duelId).status, 'routed');

  // Stale sidecar: the brief changed after linting, so the blessed-copy equivalence is gone.
  writeFileSync(`${briefPath}.sha256`,
    `${createHash('sha256').update('an earlier draft\n').digest('hex')}  ${basename(briefPath)}\n`);
  const stale = await raw('record_duel', body);
  assert.ok(stale.isError);
  assert.match(stale.text, /does not match its \.sha256 sidecar/);

  // Brief blessed where the reports live: the recording lands, and the stored text is still the
  // artifact's own bytes — the v2.13.7 leg, re-proven behind the v2.13.8 and v2.13.40 gates.
  bless(briefPath, 'TASK: deep review of the pipeline. Read-only.\n');
  const rec = await call('record_duel', body);
  assert.equal(rec.status, 'union');
  assert.equal(getDuel(db, d.duelId).anth_output, anth);
  assert.equal(getDuel(db, d.duelId).gpt_output, gpt);
});

// Non-failed reports must use the artifact transport; failed inline text remains a legal death
// note and does not prevent the surviving output_path side from closing the duel as a walkover.
test('non-failed inline output is refused while failed inline death notes still record', async () => {
  const { db, call, raw } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  const { gPath } = scratchPair(d.duelId, 'unused', 'landed b');
  const refused = await raw('record_duel', { duel_id: d.duelId,
    anthropic: { output: 'inline a', tokens: 100, latency_ms: null, failed: false },
    openai: { output_path: gPath, tokens: 100, latency_ms: null, failed: false } });
  assert.ok(refused.isError);
  assert.match(refused.text, /inline/);
  assert.match(refused.text, /output_path/);
  assert.equal(getDuel(db, d.duelId).status, 'routed');

  const rec = await call('record_duel', { duel_id: d.duelId,
    anthropic: { output: 'died: usage limit', tokens: null, latency_ms: null, failed: true },
    openai: { output_path: gPath, tokens: 100, latency_ms: null, failed: false } });
  assert.deepEqual(rec, { status: 'walkover', winner: 'openai' });
});

// Composed rule-2 test for v2.13.17 (artifact hygiene) + v2.13.18 (inline refusal) + v2.13.19
// (ledger short-circuit): all three act on the SAME state — outputOf's resolution of one side's
// artifacts — so any pair could cancel: a hygiene refusal firing on a landed side would break
// replay, and a ledger short-circuit firing early would skip the refusals a fresh side still
// owes. One duel walks every leg in order, and the last leg proves the short-circuit does not
// reopen the closed channels.
test('composed: hygiene, inline refusal and ledger short-circuit hold across one duel lifecycle', async () => {
  const { db, call, raw } = await connected();
  const d = await call('route_task', { kind: 'deep-review' });
  const sideOf = (p: string) => ({ output_path: p, tokens: 100, latency_ms: null, failed: false });
  const { aPath, gPath } = scratchPair(d.duelId, '# A final\n', '# B final\n');

  // v2.13.17 leg: while nothing has landed, a symlink wearing the pinned name is refused.
  const real = join(dirname(aPath), 'elsewhere.md');
  writeFileSync(real, '# A final\n');
  unlinkSync(aPath); symlinkSync(real, aPath);
  const sym = await raw('record_duel', { duel_id: d.duelId,
    anthropic: sideOf(aPath), openai: sideOf(gPath) });
  assert.ok(sym.isError); assert.match(sym.text, /symlink/);

  // v2.13.18 leg: inline non-failed text refused on the same fresh row.
  const inl = await raw('record_duel', { duel_id: d.duelId,
    anthropic: { output: '# A final\n', tokens: 100, latency_ms: null, failed: false },
    openai: sideOf(gPath) });
  assert.ok(inl.isError); assert.match(inl.text, /inline/);
  assert.equal(getDuel(db, d.duelId).status, 'routed'); // two refusals recorded nothing

  // Honest recording lands once the report is a regular file again.
  unlinkSync(aPath); writeFileSync(aPath, '# A final\n');
  const rec = await call('record_duel', { duel_id: d.duelId,
    anthropic: sideOf(aPath), openai: sideOf(gPath) });
  assert.equal(rec.status, 'union');

  // v2.13.19 leg: scratch consumed and cleaned; the identical call answers from the ledger.
  rmSync(dirname(aPath), { recursive: true, force: true });
  const replay = await call('record_duel', { duel_id: d.duelId,
    anthropic: sideOf(aPath), openai: sideOf(gPath) });
  assert.equal(replay.status, 'union');
  assert.equal(getDuel(db, d.duelId).anth_output, '# A final\n');

  // The short-circuit must not reopen 17/18: a landed side pointed at a symlink reads NOTHING —
  // the stored bytes stay the fact, and no hygiene error fires because no file is touched.
  const linkDir = mkdtempSync(join(tmpdir(), 'mr-scratch-'));
  writeFileSync(join(linkDir, 'other.md'), 'attacker bytes\n');
  symlinkSync(join(linkDir, 'other.md'), join(linkDir, `duel${d.duelId}-anthropic.md`));
  const replay2 = await call('record_duel', { duel_id: d.duelId,
    anthropic: sideOf(join(linkDir, `duel${d.duelId}-anthropic.md`)), openai: sideOf(gPath) });
  assert.equal(replay2.status, 'union');
  assert.equal(getDuel(db, d.duelId).anth_output, '# A final\n'); // not 'attacker bytes'
});

// v2.13.28: the MCP surface forwards letter grades to the engine — a schema that accepted them
// but a handler that dropped them would kill the GPA channel silently.
test('record_judgment stores letter grades passed over MCP', async () => {
  const { db, call } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  const { aPath, gPath } = scratchPair(d.duelId, 'a', 'b');
  await call('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 3000, latency_ms: 900, failed: false },
    openai: { output_path: gPath, tokens: 5000, latency_ms: 60, failed: false } });
  await call('record_judgment', { duel_id: d.duelId, judge_vendor: 'anthropic',
    verdict: 'both', grade_x: 'A', grade_y: 'C+',
    brief_defect: 'clone the row shape those use' });
  const row = db.prepare('SELECT grade_x, grade_y, brief_defect FROM judgments WHERE duel_id=?')
    .get(d.duelId) as any;
  assert.deepEqual({ x: row.grade_x, y: row.grade_y }, { x: 'A', y: 'C+' });
  // v2.13.44: the brief-defect flag rides the same tool call.
  assert.equal(row.brief_defect, 'clone the row shape those use');
});

// v2.13.29: the MCP surface forwards the judge's path recommendation; two merge-directed
// passing votes resolve decided_by 'merge' with no winner over the wire.
test('record_judgment path=merge from both judges resolves a merged ship over MCP', async () => {
  const { db, call } = await connected();
  const d = await call('route_task', { kind: 'implementation-misc' });
  const { aPath, gPath } = scratchPair(d.duelId, 'a', 'b');
  await call('record_duel', { duel_id: d.duelId,
    anthropic: { output_path: aPath, tokens: 3000, latency_ms: 900, failed: false },
    openai: { output_path: gPath, tokens: 5000, latency_ms: 60, failed: false } });
  await call('record_judgment', { duel_id: d.duelId, judge_vendor: 'anthropic',
    verdict: 'both', path: 'merge' });
  const fin = await call('record_judgment', { duel_id: d.duelId, judge_vendor: 'openai',
    verdict: 'both', path: 'merge' });
  assert.deepEqual(fin, { status: 'judged', winner: null, decidedBy: 'merge',
    taskKind: 'implementation-misc' });
});
