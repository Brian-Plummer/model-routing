import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Env pins before src imports — paths.ts reads env at module load (repo test convention).
const tmp = mkdtempSync(join(tmpdir(), 'mr-report-'));
process.env.MR_DATA_DIR = tmp;
process.env.MR_REPORTS_DIR = join(tmp, 'reports');
process.env.MR_MAIN_CONFIG = '/nonexistent-mr-main.claude.json';

const { openDb } = await import('../src/db.js');
const { seedMatrix } = await import('../src/matrix.js');
const { recordJudgment, recordResults } = await import('../src/duel.js');
const { buildSessionReport, writeSessionReport, sessionWindowStart, resolveOpenCmd, maybeOpen } =
  await import('../src/report.js');
const { getSetting, setSetting } = await import('../src/db.js');

const NOW = Date.now();
const NO_ATTEST = { A: null, B: null, codex: null } as const;

// Direct row mint: the recording paths are exercised where they are the subject; everywhere
// else a crafted row keeps each scenario exact and independent.
function mintDuel(db: InstanceType<typeof DatabaseSync>, over: Record<string, unknown> = {}): number {
  const base: Record<string, unknown> = {
    task_kind: 'implementation-misc', created_at: NOW - 600_000, spot_check: 0, mutating: 0,
    union_mode: 0,
    sides: JSON.stringify([
      { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
      { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' },
    ]),
    label_map: JSON.stringify({ X: 'anthropic', Y: 'openai' }),
    status: 'awaiting_judgment',
    anth_output: 'anth solution', gpt_output: 'gpt solution',
    anth_tokens: 9000, gpt_tokens: 8000,
    anth_latency_ms: 340_000, gpt_latency_ms: 512_000,
    outputs_at: NOW - 300_000, recorded_at: NOW - 300_000,
    ...over,
  };
  const cols = Object.keys(base);
  db.prepare(`INSERT INTO duels(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(k => base[k] as never));
  return Number((db.prepare('SELECT MAX(id) m FROM duels').get() as { m: number }).m);
}

function fresh(): InstanceType<typeof DatabaseSync> {
  const db = openDb(':memory:');
  seedMatrix(db);
  return db;
}

test('recordJudgment stores rationale verbatim; replay leaves it untouched', () => {
  const db = fresh();
  const id = mintDuel(db);
  recordJudgment(db, id, 'anthropic', 'X', NOW, {
    proof: null, roots: NO_ATTEST, rationale: 'X compiles and covers the edge case; Y drops the retry loop.',
  });
  const r1 = db.prepare('SELECT rationale FROM judgments WHERE duel_id=? AND judge_vendor=?')
    .get(id, 'anthropic') as { rationale: string };
  assert.equal(r1.rationale, 'X compiles and covers the edge case; Y drops the retry loop.');
  const res = recordJudgment(db, id, 'openai', 'X', NOW, {
    proof: null, roots: NO_ATTEST, rationale: 'Y misses the spec requirement on NULL input.',
  });
  assert.equal(res.status, 'judged');
  // Replay after resolution: stored verdict returns, no vote inserted, rationales untouched.
  const replay = recordJudgment(db, id, 'openai', 'Y', NOW, { proof: null, roots: NO_ATTEST });
  assert.equal(replay.status, 'judged');
  const rows = db.prepare('SELECT rationale FROM judgments WHERE duel_id=? ORDER BY id').all(id) as
    { rationale: string | null }[];
  assert.equal(rows.length, 2);
  assert.match(rows[1].rationale!, /NULL input/);
});

// v2.13.44: the judge's brief-defect flag — the quoted requirement text a vote traced a
// split to. Stored beside the vote, rendered in the report, never consulted by resolution.
test('recordJudgment stores brief_defect and the report renders it', () => {
  const db = fresh();
  const id = mintDuel(db);
  recordJudgment(db, id, 'anthropic', 'X', NOW - 120_000, {
    proof: null, roots: NO_ATTEST, rationale: 'X reads the absent family; Y reads JS null.',
    briefDefect: 'a non-null maturity_date that does not match the ISO pattern throws',
  });
  recordJudgment(db, id, 'openai', 'Y', NOW - 60_000, { proof: null, roots: NO_ATTEST });
  const row = db.prepare('SELECT brief_defect FROM judgments WHERE duel_id=? AND judge_vendor=?')
    .get(id, 'anthropic') as { brief_defect: string };
  assert.equal(row.brief_defect,
    'a non-null maturity_date that does not match the ISO pattern throws');
  const md = buildSessionReport(db, W)!;
  assert.match(md, /brief defect flagged: "a non-null maturity_date/);
});

test('recordJudgment without rationale stores NULL (legacy-compatible)', () => {
  const db = fresh();
  const id = mintDuel(db);
  recordJudgment(db, id, 'anthropic', 'both', NOW, { proof: null, roots: NO_ATTEST });
  const r = db.prepare('SELECT rationale FROM judgments WHERE duel_id=?').get(id) as
    { rationale: string | null };
  assert.equal(r.rationale, null);
});

test('recordResults stores per-side environment; landed side keeps its stored note', () => {
  const db = fresh();
  const id = mintDuel(db, { status: 'routed', anth_output: null, gpt_output: null,
    anth_tokens: null, gpt_tokens: null, anth_latency_ms: null, gpt_latency_ms: null,
    outputs_at: null, recorded_at: null });
  recordResults(db, id, {
    anthropic: { output: 'anth out', tokens: 9000, latencyMs: 1000, failed: false, proof: null,
      environment: 'headless Claude Code, 2 MCP servers, 0 respawns' },
    openai: { output: 'gpt out', tokens: 8000, latencyMs: 2000, failed: false, proof: null,
      environment: 'codex CLI, network off, 1 respawn' },
  }, { roots: NO_ATTEST });
  const r = db.prepare('SELECT anth_env, gpt_env FROM duels WHERE id=?').get(id) as
    { anth_env: string; gpt_env: string };
  assert.equal(r.anth_env, 'headless Claude Code, 2 MCP servers, 0 respawns');
  assert.equal(r.gpt_env, 'codex CLI, network off, 1 respawn');
  // A landed side keeps what it recorded — a later record cannot rewrite its env note,
  // the same keep() rule every other side field follows.
  recordResults(db, id, {
    anthropic: { output: 'anth out', tokens: 9000, latencyMs: 1000, failed: false, proof: null,
      environment: 'REWRITTEN' },
    openai: { output: 'gpt out', tokens: 8000, latencyMs: 2000, failed: false, proof: null },
  }, { roots: NO_ATTEST });
  const r2 = db.prepare('SELECT anth_env, gpt_env FROM duels WHERE id=?').get(id) as
    { anth_env: string; gpt_env: string };
  assert.equal(r2.anth_env, 'headless Claude Code, 2 MCP servers, 0 respawns');
  assert.equal(r2.gpt_env, 'codex CLI, network off, 1 respawn');
});

test('a blank-side repair records only that side\'s environment', () => {
  const db = fresh();
  const id = mintDuel(db, { status: 'awaiting_judgment', gpt_output: null,
    gpt_tokens: null, gpt_latency_ms: null });
  recordResults(db, id, {
    anthropic: { output: null, tokens: null, latencyMs: null, failed: true, proof: null,
      environment: 'must not land — failed side' },
    openai: { output: 'recovered gpt out', tokens: 8000, latencyMs: 2000, failed: false,
      proof: null, environment: 'codex CLI, recovered rollout' },
  }, { roots: NO_ATTEST });
  const r = db.prepare('SELECT anth_env, gpt_env FROM duels WHERE id=?').get(id) as
    { anth_env: string | null; gpt_env: string };
  // The anth side here is LANDED (mintDuel stores 'anth solution'), so the landed leg of the
  // rule preserves the stored NULL — a failed record can never rewrite a side the row already
  // holds. The genuinely-failed side is the next test; this one never exercised it.
  assert.equal(r.anth_env, null);
  assert.equal(r.gpt_env, 'codex CLI, recovered rollout');
});

test('a failed side records why it died, and never overwrites', () => {
  const db = fresh();
  // Duel 212's shape: nothing landed on either side, the controller voided the round and
  // passed a written reason per side. Under keep() both reasons hit prev=NULL and the operator
  // was told only "both sides dead".
  const id = mintDuel(db, { status: 'routed', anth_output: null, gpt_output: null,
    anth_tokens: null, gpt_tokens: null, anth_latency_ms: null, gpt_latency_ms: null });
  recordResults(db, id, {
    anthropic: { output: null, tokens: 367_307, latencyMs: 1_950_000, failed: true, proof: null,
      environment: 'VOID: brief mandated .parquet, venv had no pyarrow; re-duelled as 213' },
    openai: { output: null, tokens: 12_000, latencyMs: 270_000, failed: true, proof: null,
      environment: 'VOID: side stopped BLOCKED-SCOPE at 4.5 min, claim verified controller-side' },
  }, { roots: NO_ATTEST });
  const r = db.prepare(
    'SELECT anth_env, gpt_env, anth_tokens, gpt_tokens, anth_latency_ms, status FROM duels '
    + 'WHERE id=?').get(id) as Record<string, unknown>;
  assert.equal(r.status, 'abandoned');
  assert.match(String(r.anth_env), /^VOID: brief mandated \.parquet/);
  assert.match(String(r.gpt_env), /^VOID: side stopped BLOCKED-SCOPE/);
  assert.equal(r.anth_tokens, 367_307); // voided spend is attributable, not lost
  assert.equal(r.gpt_tokens, 12_000);
  assert.equal(r.anth_latency_ms, 1_950_000);

  // Fill-only: a second failed record cannot rewrite the reason the row already carries.
  recordResults(db, id, {
    anthropic: { output: null, tokens: 1, latencyMs: 1, failed: true, proof: null,
      environment: 'MUST NOT LAND' },
    openai: { output: null, tokens: 1, latencyMs: 1, failed: true, proof: null,
      environment: 'MUST NOT LAND' },
  }, { roots: NO_ATTEST });
  const r2 = db.prepare('SELECT anth_env, anth_tokens FROM duels WHERE id=?').get(id) as
    Record<string, unknown>;
  assert.match(String(r2.anth_env), /^VOID: brief mandated \.parquet/);
  assert.equal(r2.anth_tokens, 367_307);
});

test('openDb adds rationale and env columns to a pre-2.13 DB', () => {
  const path = join(tmp, 'pre213.db');
  const raw = new DatabaseSync(path);
  // Minimal pre-2.13 shapes: judgments without rationale, duels without env columns.
  raw.exec(`CREATE TABLE judgments (id INTEGER PRIMARY KEY, duel_id INTEGER NOT NULL,
    judge_vendor TEXT NOT NULL, verdict TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE duels (id INTEGER PRIMARY KEY, task_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL, spot_check INTEGER NOT NULL DEFAULT 0,
    sides TEXT NOT NULL, label_map TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'routed');`);
  raw.close();
  const db = openDb(path);
  for (const [table, col] of [
    ['judgments', 'rationale'], ['duels', 'anth_env'], ['duels', 'gpt_env'],
  ] as const) {
    assert.ok(
      db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col),
      `${table}.${col} missing after open`);
  }
});

function judged(db: InstanceType<typeof DatabaseSync>, over: Record<string, unknown>,
  votes: [string, string, (string | null)?, (string | null)?]): number {
  const id = mintDuel(db, over);
  const [v1, v2, r1, r2] = votes;
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, proof, graded, rationale)
    VALUES (?,?,?,?,NULL,1,?), (?,?,?,?,NULL,1,?)`)
    .run(id, 'anthropic', v1, NOW - 120_000, r1 ?? null, id, 'openai', v2, NOW - 60_000, r2 ?? null);
  return id;
}
const W = { fromMs: NOW - 3_600_000, toMs: NOW + 1, sessionId: 'f5143f76-6223-48a5' };

test('report: quality win prints decisive fact, both rationales, env asymmetry (composed)', () => {
  const db = fresh();
  judged(db, {
    status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges',
    anth_env: 'headless Claude Code, 2 MCP servers', gpt_env: 'codex CLI, network off',
  }, ['X', 'X', 'Y drops the retry loop.', 'Y misses the NULL-input case.']);
  const md = buildSessionReport(db, W)!;
  assert.match(md, /Quality win for anthropic/);
  assert.match(md, /Y drops the retry loop\./);           // rationale verbatim
  assert.match(md, /Y misses the NULL-input case\./);
  assert.match(md, /failed Y \(openai\)/);                // decisive fact, label decoded
  assert.match(md, /asymmetry — review/);                 // env notes differ
  assert.match(md, /codex CLI, network off/);             // both notes printed
  assert.match(md, /quality wins.*anthropic 1/i);         // header tally
});

test('report: latency win states margin; judges passed both', () => {
  const db = fresh();
  judged(db, { status: 'judged', winner_vendor: 'anthropic', decided_by: 'latency' },
    ['both', 'both', 'Both handle the edge cases.', 'Both are complete.']);
  const md = buildSessionReport(db, W)!;
  assert.match(md, /Both sides met the quality bar; the clock decided/);
  assert.match(md, /5m 40s vs 8m 32s/);   // 340_000 vs 512_000
  assert.match(md, /anthropic 34% faster/); // (512-340)/512 = 33.6 → 34
});

test('report: both_failed, contested, unresolved, union, walkover all render', () => {
  const db = fresh();
  judged(db, { status: 'unresolved', winner_vendor: null, decided_by: 'both_failed' },
    ['neither', 'neither', null, null]);
  judged(db, { status: 'unresolved', winner_vendor: null, decided_by: 'contested' },
    ['X', 'Y', 'X is complete.', 'Y is complete.']);
  judged(db, { status: 'unresolved', winner_vendor: null, decided_by: 'unresolved' },
    ['both', 'both', null, null]);
  mintDuel(db, { status: 'union', union_mode: 1, decided_by: 'union' });
  mintDuel(db, { status: 'walkover', winner_vendor: 'openai', decided_by: 'walkover',
    anth_output: null, anth_tokens: null, anth_latency_ms: null });
  // duel 391 M16: a voided round and a merged ship each had no case — the void rendered as
  // "abandoned — decided_by=superseded", and neither reached the head's category list; a
  // union side holding blank error text counted as landed by truthiness.
  mintDuel(db, { status: 'abandoned', winner_vendor: null, decided_by: 'superseded',
    superseded_by: 999, death_recorded: 1, anth_output: null, gpt_output: null });
  mintDuel(db, { status: 'judged', winner_vendor: null, decided_by: 'merge' });
  mintDuel(db, { status: 'union', union_mode: 1, decided_by: 'union', gpt_output: '  \n' });
  // A legacy preference vote must read as a preference, never as a bar claim.
  const legacy = mintDuel(db, { status: 'judged', winner_vendor: 'openai', decided_by: 'latency' });
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded)
    VALUES (?,?,?,?,0), (?,?,?,?,0)`)
    .run(legacy, 'anthropic', 'X', NOW - 120_000, legacy, 'openai', 'Y', NOW - 60_000);
  const md = buildSessionReport(db, W)!;
  assert.match(md, /preferred X \(anthropic\) — pre-v2\.11 preference vote/);
  assert.match(md, /preferred Y \(openai\) — pre-v2\.11 preference vote/);
  assert.match(md, /Nothing met the bar/);
  assert.match(md, /Judges failed different sides/);
  assert.match(md, /clock could not separate/);
  assert.match(md, /Union run — merge shipped, no contest/);
  assert.match(md, /Walkover/);
  assert.match(md, /rationale not recorded/);    // NULL rationale → gap marker
  assert.match(md, /Voided — the controller discarded this round on purpose.*re-duelled as #999/);
  assert.match(md, /Merged ship/);
  assert.match(md, /Sides landed: anthropic\n/);
  assert.match(md, /other outcomes: .*merge 1.*superseded 1/);
  assert.match(md, /duels: 9/);
});

test('report: fairness verdict variants', () => {
  const db = fresh();
  const both = (a: string | null, g: string | null) =>
    judged(db, { status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges',
      anth_env: a, gpt_env: g }, ['X', 'X', 'r', 'r']);
  both(null, null); both('same toolset', 'same toolset'); both('note', null);
  const md = buildSessionReport(db, W)!;
  assert.match(md, /fair fight \(no recorded asymmetry\)/);
  assert.match(md, /fair fight \(recorded envs match\)/);
  assert.match(md, /incomplete env record — openai side unrecorded/);
});

test('report: idle time and judging span derive from the row clocks', () => {
  const db = fresh();
  // Row clocks: created NOW-600s, outputs NOW-300s, votes NOW-120s/NOW-60s. Latencies chosen
  // below the 300s execution span so idle is a real positive number.
  judged(db, { anth_latency_ms: 100_000, gpt_latency_ms: 120_000,
    status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges' }, ['X', 'X', 'r', 'r']);
  const md = buildSessionReport(db, W)!;
  assert.match(md, /execution span 5m 0s/);      // 600s-300s
  assert.match(md, /idle 3m 0s/);                // 300s - 120s
  assert.match(md, /judging span 4m 0s/);        // last vote (NOW-60s) - outputs_at (NOW-300s)
});

test('report window excludes out-of-window duels; empty window builds nothing', () => {
  const db = fresh();
  mintDuel(db, { created_at: NOW - 7_200_000 }); // before the window
  assert.equal(buildSessionReport(db, W), null);
  assert.equal(writeSessionReport(db, W), null);
});

test('report claims transition: first session owns, rival excludes, owner replay is identical', () => {
  const db = fresh();
  const duelId = judged(db,
    { status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges' },
    ['X', 'X', 'winner', 'winner']);
  const firstWindow = { ...W, sessionId: '11111111-first-session' };
  const rivalWindow = { ...W, sessionId: '22222222-rival-session' };

  const transitions = [
    { name: 'first claim', window: firstWindow, included: true, excludedBy: null },
    { name: 'different session', window: rivalWindow, included: false,
      excludedBy: firstWindow.sessionId.slice(0, 8) },
    { name: 'same-session replay', window: firstWindow, included: true, excludedBy: null },
  ] as const;
  let firstReport: string | null = null;
  let firstClaim: Record<string, unknown> | null = null;
  for (const transition of transitions) {
    const path = writeSessionReport(db, transition.window)!;
    const md = readFileSync(path, 'utf8');
    assert.equal(md.includes(`## Duel #${duelId}`), transition.included, transition.name);
    assert.match(md, transition.included
      ? /duels: 1[\s\S]*quality wins \(judges\): anthropic 1, openai 0/
      : /duels: 0[\s\S]*quality wins \(judges\): anthropic 0, openai 0/);
    if (transition.excludedBy) {
      assert.match(md, new RegExp(
        `excluded: 1 duel\\(s\\) claimed by session ${transition.excludedBy} report\\(s\\)`));
    } else {
      assert.doesNotMatch(md, /excluded:/);
    }

    const claims = db.prepare(
      'SELECT duel_id, session_id, claimed_at FROM report_claims ORDER BY duel_id').all() as
      Record<string, unknown>[];
    assert.equal(claims.length, 1, transition.name);
    assert.equal(claims[0].session_id, firstWindow.sessionId, transition.name);
    if (transition.name === 'first claim') {
      firstReport = md;
      firstClaim = { ...claims[0] };
    }
    if (transition.name === 'same-session replay') {
      assert.equal(md, firstReport, 'same session regenerates byte-identically');
      assert.deepEqual({ ...claims[0] }, firstClaim, 'INSERT OR IGNORE preserves claimed_at');
    }
  }
});

test('in-flight duels never reach a report: unrendered, unclaimed, reportable once closed', () => {
  const db = fresh();
  const closed = judged(db, { status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges' },
    ['X', 'X', 'winner', 'winner']);
  const routed = mintDuel(db, { status: 'routed', anth_output: null, gpt_output: null,
    outputs_at: null, recorded_at: null, anth_tokens: null, gpt_tokens: null,
    anth_latency_ms: null, gpt_latency_ms: null });
  const awaiting = mintDuel(db); // base status: awaiting_judgment

  const first = readFileSync(
    writeSessionReport(db, { ...W, sessionId: 'aaaa1111-minting-session' })!, 'utf8');
  assert.match(first, new RegExp(`## Duel #${closed} `));
  assert.doesNotMatch(first, new RegExp(`## Duel #${routed} `));
  assert.doesNotMatch(first, new RegExp(`## Duel #${awaiting} `));
  assert.match(first, /duels: 1\b/);
  assert.doesNotMatch(first, /routed|awaiting_judgment/);
  const claims = db.prepare('SELECT duel_id FROM report_claims ORDER BY duel_id')
    .all() as { duel_id: number }[];
  assert.deepEqual(claims.map(c => c.duel_id), [closed], 'in-flight rows are never claimed');

  // Transition: the awaiting row closes after its minting session's report ran. The recovery
  // surface (a window replay) reports and claims it — no stale claim from the close blocks it.
  db.prepare(
    "UPDATE duels SET status='judged', winner_vendor='openai', decided_by='judges' WHERE id=?")
    .run(awaiting);
  const replay = readFileSync(
    writeSessionReport(db, { ...W, sessionId: 'bbbb2222-replay-window' })!, 'utf8');
  assert.match(replay, new RegExp(`## Duel #${awaiting} `));
  assert.doesNotMatch(replay, new RegExp(`## Duel #${routed} `));
  assert.match(replay, /excluded: 1 duel\(s\) claimed by session aaaa1111/);

  // A window holding only in-flight rows builds nothing at all.
  const only = fresh();
  mintDuel(only, { status: 'routed' });
  mintDuel(only);
  assert.equal(buildSessionReport(only, W), null);
  assert.equal(writeSessionReport(only, W), null);
});

test('sessionless report leaves claims untouched and warns about overlapping sessions', () => {
  const db = fresh();
  const duelId = mintDuel(db, { status: 'unresolved', decided_by: 'unresolved' });
  const md = buildSessionReport(db, { fromMs: W.fromMs, toMs: W.toMs })!;
  assert.match(md, new RegExp(`## Duel #${duelId}`));
  assert.match(md, /caveat: sessionless window; overlapping-session double-counting is possible/);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM report_claims').get() as { c: number }).c, 0);
});

test('v16 migration adds report claims; legacy report works; replay and fresh DB land at the current version', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-report-v16-')), 'mr.db');
  const pre = openDb(path);
  seedMatrix(pre);
  const duelId = mintDuel(pre, { status: 'unresolved', decided_by: 'unresolved' });
  pre.exec('DROP TABLE IF EXISTS report_claims; PRAGMA user_version = 15');
  pre.close();

  const upgraded = openDb(path);
  assert.equal((upgraded.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version, 17);
  const columns = upgraded.prepare(
    "SELECT name, type, \"notnull\" AS required, pk "
      + "FROM pragma_table_info('report_claims') ORDER BY cid",
  ).all().map(row => ({ ...row }));
  assert.deepEqual(columns, [
    { name: 'duel_id', type: 'INTEGER', required: 0, pk: 1 },
    { name: 'session_id', type: 'TEXT', required: 1, pk: 0 },
    { name: 'claimed_at', type: 'INTEGER', required: 1, pk: 0 },
  ]);
  const legacyWindow = { ...W, sessionId: '16161616-legacy-session' };
  const first = readFileSync(writeSessionReport(upgraded, legacyWindow)!, 'utf8');
  assert.match(first, new RegExp(`## Duel #${duelId}`));
  const claim = upgraded.prepare(
    'SELECT duel_id, session_id, claimed_at FROM report_claims WHERE duel_id=?').get(duelId);
  upgraded.close();

  const replay = openDb(path);
  assert.equal((replay.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version, 17);
  assert.equal(readFileSync(writeSessionReport(replay, legacyWindow)!, 'utf8'), first);
  assert.deepEqual({ ...replay.prepare(
    'SELECT duel_id, session_id, claimed_at FROM report_claims WHERE duel_id=?').get(duelId) },
  { ...claim });
  replay.close();

  const freshDb = openDb(':memory:');
  assert.equal((freshDb.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version, 17);
  assert.ok(freshDb.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_claims'").get());
  freshDb.close();
});

test('file-backed two-connection report race gives one session the shared duel', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mr-report-race-')), 'mr.db');
  const setup = openDb(path);
  seedMatrix(setup);
  const duelId = judged(setup,
    { status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges' },
    ['X', 'X', 'winner', 'winner']);
  setup.close();

  const outer = openDb(path);
  const inner = openDb(path);
  const outerWindow = { ...W, sessionId: 'aaaaaaaa-outer-session' };
  const innerWindow = { ...W, sessionId: 'bbbbbbbb-inner-session' };
  let innerPath: string | null = null;
  const outerPath = writeSessionReport(outer, outerWindow, {
    // Outer has completed the stale SELECT; inner now claims and reads ownership before outer's
    // INSERT OR IGNORE. Two real connections exercise the SELECT-then-INSERT race deterministically.
    onCandidatesRead() { innerPath = writeSessionReport(inner, innerWindow); },
  });

  assert.ok(outerPath);
  assert.ok(innerPath);
  const reports = [
    { sessionId: outerWindow.sessionId, md: readFileSync(outerPath, 'utf8') },
    { sessionId: innerWindow.sessionId, md: readFileSync(innerPath, 'utf8') },
  ];
  const included = reports.filter(r => r.md!.includes(`## Duel #${duelId}`));
  const excluded = reports.filter(r => !r.md!.includes(`## Duel #${duelId}`));
  assert.equal(included.length, 1, 'exactly one racing report counts the duel');
  assert.equal(excluded.length, 1, 'exactly one racing report excludes the duel');
  assert.match(included[0].md!, /duels: 1[\s\S]*quality wins \(judges\): anthropic 1, openai 0/);
  assert.match(excluded[0].md!, /duels: 0[\s\S]*quality wins \(judges\): anthropic 0, openai 0/);
  assert.match(excluded[0].md!, new RegExp(
    `excluded: 1 duel\\(s\\) claimed by session ${included[0].sessionId.slice(0, 8)} report\\(s\\)`));
  const owner = outer.prepare('SELECT session_id FROM report_claims WHERE duel_id=?')
    .get(duelId) as { session_id: string };
  assert.equal(owner.session_id, included[0].sessionId);
  outer.close();
  inner.close();
});

test('report claim rolls back when the report write fails, so a rival can still count it', () => {
  const db = fresh();
  const duelId = judged(db,
    { status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges' },
    ['X', 'X', 'winner', 'winner']);
  const preview = buildSessionReport(db, { ...W, sessionId: 'preview-only-session' })!;
  assert.match(preview, new RegExp(`## Duel #${duelId}`));
  assert.equal((db.prepare('SELECT COUNT(*) c FROM report_claims').get() as { c: number }).c, 0,
    'building Markdown without writing a report must not make a claim durable');
  const reportsDir = process.env.MR_REPORTS_DIR!;
  mkdirSync(reportsDir, { recursive: true });
  chmodSync(reportsDir, 0o500);
  try {
    assert.throws(
      () => writeSessionReport(db, { ...W, sessionId: 'ffffffff-failed-writer' }),
      /EACCES|permission denied/i,
    );
  } finally {
    chmodSync(reportsDir, 0o700);
  }

  assert.equal((db.prepare('SELECT COUNT(*) c FROM report_claims').get() as { c: number }).c, 0,
    'a failed file write must leave no durable claim');
  const rivalPath = writeSessionReport(db, { ...W, sessionId: 'eeeeeeee-rival-writer' })!;
  assert.match(readFileSync(rivalPath, 'utf8'), new RegExp(`## Duel #${duelId}`));
  assert.equal((db.prepare('SELECT session_id FROM report_claims WHERE duel_id=?')
    .get(duelId) as { session_id: string }).session_id, 'eeeeeeee-rival-writer');
});

test('writeSessionReport writes dated, session-stamped file under REPORTS_DIR', () => {
  const db = fresh();
  judged(db, { status: 'judged', winner_vendor: 'anthropic', decided_by: 'judges' },
    ['X', 'X', 'r', 'r']);
  const path = writeSessionReport(db, W)!;
  assert.match(path, /reports\/\d{4}-\d{2}-\d{2}-f5143f76\.md$/);
  assert.match(readFileSync(path, 'utf8'), /Quality win for anthropic/);
});

test('sessionWindowStart reads the first transcript timestamp', () => {
  const t = join(tmp, 'transcript.jsonl');
  writeFileSync(t, '{"type":"summary"}\n'
    + `{"type":"user","timestamp":"${new Date(NOW - 1000).toISOString()}"}\n`);
  assert.equal(sessionWindowStart(t), Date.parse(new Date(NOW - 1000).toISOString()));
  assert.equal(sessionWindowStart('/nonexistent/transcript.jsonl'), null);
});

test('resolveOpenCmd: explicit setting wins; auto prefers idea, falls back to xdg-open', () => {
  assert.equal(resolveOpenCmd('code', () => true), 'code');
  assert.equal(resolveOpenCmd('auto', c => c === 'idea'), 'idea');
  assert.equal(resolveOpenCmd(null, () => false), 'xdg-open');
});

test('maybeOpen: default on spawns detached; off suppresses; spawn failure is contained', () => {
  const db = fresh();
  const calls: unknown[][] = [];
  const spawnFn = ((...a: unknown[]) => { calls.push(a); return { unref() {}, on() {} }; }) as never;
  assert.equal(maybeOpen(db, '/tmp/r.md', { spawnFn, has: c => c === 'idea' }), true);
  assert.deepEqual(calls[0], ['idea', ['/tmp/r.md'], { detached: true, stdio: 'ignore' }]);
  setSetting(db, 'report_autopop', 'off');
  assert.equal(maybeOpen(db, '/tmp/r.md', { spawnFn }), false);
  assert.equal(calls.length, 1);
  setSetting(db, 'report_autopop', 'on');
  const boom = (() => { throw new Error('ENOENT'); }) as never;
  assert.equal(maybeOpen(db, '/tmp/r.md', { spawnFn: boom, has: () => false }), false);
});

// CLI end-to-end, repo cli.test.ts style: real process, file-backed DB via env pins.
const cliTmp = mkdtempSync(join(tmpdir(), 'mr-report-cli-'));
const cliEnv = { ...process.env, MR_DATA_DIR: cliTmp, MR_DB_PATH: join(cliTmp, 'mr.db'),
  MR_REPORTS_DIR: join(cliTmp, 'reports') };
const cli = (...a: string[]) =>
  execFileSync('node', ['dist/src/cli.js', ...a], { env: cliEnv, encoding: 'utf8' });

test('cli report: toggle persists; --window writes and prints the file; empty window says so', () => {
  cli('seed');
  assert.match(cli('report', 'auto', 'off'), /report auto-open off/);
  assert.match(cli('report', 'open-cmd', 'code'), /report open command: code/);
  const db = openDb(join(cliTmp, 'mr.db'));
  assert.equal(getSetting(db, 'report_autopop'), 'off');
  const id = mintDuel(db, { status: 'judged', winner_vendor: 'openai', decided_by: 'judges' });
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded, rationale)
    VALUES (?,?,?,?,1,?)`).run(id, 'anthropic', 'Y', NOW, 'X breaks the build.');
  const out = cli('report', '--window', `${NOW - 3_600_000},${NOW + 1}`, 'cafe0123-session');
  assert.match(out, /reports\/\d{4}-\d{2}-\d{2}-cafe0123\.md/);
  assert.match(cli('report', '--window', '1,2'), /no duels in window/);
});

test('cli report --session-end: reads hook JSON, writes report, always exits 0', () => {
  const transcript = join(cliTmp, 'transcript.jsonl');
  writeFileSync(transcript,
    `{"type":"user","timestamp":"${new Date(NOW - 3_500_000).toISOString()}"}\n`);
  const res = spawnSync('node', ['dist/src/cli.js', 'report', '--session-end'], {
    env: cliEnv, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'f00dfeed-4444', transcript_path: transcript }),
  });
  assert.equal(res.status, 0);
  const expected = join(cliTmp, 'reports',
    `${new Date(NOW - 3_500_000).toISOString().slice(0, 10)}-f00dfeed.md`);
  assert.ok(existsSync(expected), `expected ${expected}; stderr: ${res.stderr}`);
  // autopop is 'off' (set above) — nothing spawned, and the hook printed the path on stdout.
  assert.match(res.stdout, /session duel report/);
  // Garbage stdin still exits 0 with one stderr line — a report failure must never block close.
  const bad = spawnSync('node', ['dist/src/cli.js', 'report', '--session-end'],
    { env: cliEnv, encoding: 'utf8', input: 'not json' });
  assert.equal(bad.status, 0);
  assert.match(bad.stderr, /report failed|report skipped/);
});

// The one signal a stale long-lived server leaves in the record: the build that minted a row
// is not the build that recorded it. Silent when they agree, and silent for legacy NULLs —
// a report for a pre-v15 row is unchanged.
const SKEW_ROWS: Array<{ name: string; over: Record<string, unknown>; line: RegExp | null }> = [
  { name: 'minted and recorded by different builds',
    over: { minted_by_version: '2.13.19', recorded_by_version: '2.13.20' },
    line: /server skew: minted v2\.13\.19, recorded v2\.13\.20/ },
  { name: 'same build both ends',
    over: { minted_by_version: '2.13.20', recorded_by_version: '2.13.20' }, line: null },
  { name: 'mint unknown (legacy row, recorded by a v15 build)',
    over: { minted_by_version: null, recorded_by_version: '2.13.20' }, line: null },
  { name: 'never recorded',
    over: { minted_by_version: '2.13.19', recorded_by_version: null }, line: null },
  { name: 'fully legacy row', over: {}, line: null },
];

for (const row of SKEW_ROWS) {
  test(`report: server skew line — ${row.name}`, () => {
    const db = fresh();
    mintDuel(db, { status: 'unresolved', decided_by: 'unresolved', ...row.over });
    const md = buildSessionReport(db, W)!;
    if (row.line) assert.match(md, row.line);
    else assert.doesNotMatch(md, /server skew/);
  });
}

// v2.13.28: the session report prints each vote's letter grades with the blind labels decoded —
// the report is the durable per-date record the operator reads GPA trends from.
test('a judgment line renders its letter grades mapped to vendors', () => {
  const db = fresh();
  const id = mintDuel(db, { status: 'judged', winner_vendor: 'openai', decided_by: 'judges' });
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded,
    grade_x, grade_y) VALUES (?, 'openai', 'Y', ?, 1, 'A-', 'A+')`).run(id, NOW - 200_000);
  const md = buildSessionReport(db, W)!;
  assert.match(md, /grades: X \(anthropic\) A-, Y \(openai\) A\+/);
});

// v2.13.29: a merged ship reads as its own outcome — no fabricated winner line, and the vote's
// path recommendation prints beside its grades.
test('a merge resolution renders the merged-ship result and each vote path', () => {
  const db = fresh();
  const id = mintDuel(db, { status: 'judged', winner_vendor: null, decided_by: 'merge' });
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded, path)
    VALUES (?, 'anthropic', 'both', ?, 1, 'merge')`).run(id, NOW - 200_000);
  const md = buildSessionReport(db, W)!;
  assert.match(md, /Merged ship/);
  assert.match(md, /path: merge/);
});

// v2.13.84: the engine-attested serena counts (v2.13.82) reach the operator's report — the
// fairness section carries the sides', each vote carries its judge's. Rows recorded before the
// columns existed print nothing: NULL is "unknown", never zero.
test('report: attested serena counts print beside the env notes and the judge vote; legacy rows print nothing (duel 409)', () => {
  const db = fresh();
  judged(db, { status: 'judged', winner_vendor: 'openai', decided_by: 'judges', anth_serena_calls: 14 },
    ['X', 'X', 'Y quoted a command it did not run verbatim.', 'Y misses the pin.']);
  db.exec("UPDATE judgments SET judge_serena_calls=8 WHERE judge_vendor='anthropic'");
  const md = buildSessionReport(db, W)!;
  assert.match(md, /- serena calls \(attested\): anthropic 14, openai n\/a/);
  assert.match(md, /  - serena calls \(attested\): 8/);
  assert.equal((md.match(/serena calls \(attested\)/g) ?? []).length, 2); // the openai vote has none

  const legacy = fresh();
  judged(legacy, { status: 'judged', winner_vendor: 'openai', decided_by: 'judges' }, ['X', 'X', 'a', 'b']);
  assert.doesNotMatch(buildSessionReport(legacy, W)!, /serena calls/);
});
