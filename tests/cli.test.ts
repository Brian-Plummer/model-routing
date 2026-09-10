import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the main config to a nonexistent file so offloadDir() deterministically throws in this
// suite regardless of what real ~/.claude-a / ~/.claude-b exist on the machine running it.
// Before the src imports (dynamic, mcp.test.ts's style) — paths.ts reads MAIN_CONFIG once,
// at module load, and a static import would evaluate it before this line ever runs.
process.env.MR_MAIN_CONFIG = '/nonexistent-mr-main.claude.json';
const { openDb } = await import('../src/db.js');
const { seedMatrix } = await import('../src/matrix.js');
const { calibrationLedger, findNestedCodexLaunch, readBoundedTextFile, serenaLedger } = await import('../src/cli.js');

const tmp = mkdtempSync(join(tmpdir(), 'mr-cli-'));
const env = { ...process.env, MR_DB_PATH: join(tmp, 'mr.db'), MR_DATA_DIR: tmp };
const cli = (...args: string[]) =>
  execFileSync('node', ['dist/src/cli.js', ...args], { env, encoding: 'utf8' });

test('bounded CLI reads accept a regular file and refuse symlinks, directories, and oversize files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-cli-read-'));
  const regular = join(dir, 'brief.md');
  const linked = join(dir, 'linked.md');
  const nested = join(dir, 'nested');
  writeFileSync(regular, 'brief bytes');
  symlinkSync(regular, linked);
  mkdirSync(nested);

  assert.equal(readBoundedTextFile(regular, 20), 'brief bytes');
  assert.throws(() => readBoundedTextFile(linked, 20), /symlink/i);
  assert.throws(() => readBoundedTextFile(nested, 20), /not a regular file/i);
  assert.throws(() => readBoundedTextFile(regular, 4), /cap 4/i);
});

test('nested codex launch matcher ignores prose and fences, but returns a real launch line', () => {
  const rows: Array<{ name: string; prompt: string; line: string | null }> = [
    { name: 'prose mention', prompt: 'Document how codex exec is governed.\n', line: null },
    { name: 'inline prose', prompt: 'Never type `codex exec` by hand.\n', line: null },
    { name: 'fenced launch example',
      prompt: '```sh\ncodex exec "example"\n```\nProceed with review.\n', line: null },
    { name: 'direct launch', prompt: '  codex exec "nested"\n', line: 'codex exec "nested"' },
    { name: 'nohup launch', prompt: 'nohup codex exec -C /work "nested" &\n',
      line: 'nohup codex exec -C /work "nested" &' },
  ];
  for (const row of rows) {
    assert.equal(findNestedCodexLaunch(row.prompt), row.line, row.name);
  }
});

test('seed then matrix renders table; idempotent', () => {
  assert.match(cli('seed'), /seeded 14 rows/);
  assert.match(cli('seed'), /seeded 0 rows/);
  assert.match(cli('matrix'), /\| implementation-misc \|/);
});

test('matrix --render writes fallback doc', () => {
  cli('seed');
  cli('matrix', '--render');
  assert.match(readFileSync(join(tmp, 'matrix.md'), 'utf8'), /# Routing Matrix/);
});

test('quota --summary prints one prefixed line without network (all stale)', () => {
  const out = cli('quota', '--summary');
  assert.match(out, /^\[model-routing quota\] /);
  assert.match(out, /A: stale/);
});

test('import-scorecard reports counts', () => {
  cli('seed');
  const f = join(tmp, 'sc.md');
  writeFileSync(f, '2026-07-21 | task-review | claude-b:sonnet | FAIL(harness) ×2 | output lost\n');
  assert.match(cli('import-scorecard', f), /imported 1, skipped 0/);
});

test('standings emits JSON with kinds and pending keys', () => {
  cli('seed');
  const parsed = JSON.parse(cli('standings'));
  assert.ok('kinds' in parsed && 'pending' in parsed);
});

test('serenaLedger lists every duel with an attested serena count and sums the judged ones (duel 414)', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mr-serena-')), 'mr.db'));
  seedMatrix(db);
  assert.deepEqual(serenaLedger(db), ['no attested serena counts yet']);
  const duel = db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status,
    winner_vendor, decided_by, anth_serena_calls, gpt_serena_calls) VALUES (?,1,'[]','{}',?,?,?,?,?)`);
  const id = (...a: unknown[]) => Number(duel.run(...(a as [string, string, string | null,
    string | null, number | null, number | null])).lastInsertRowid);
  const i1 = id('implementation-build', 'judged', 'anthropic', 'latency', 2, null);
  const i2 = id('deep-review', 'union', null, 'union', 16, null);
  const i3 = id('implementation-build', 'judged', 'openai', 'judges', 12, null);
  const i4 = id('default', 'judged', 'openai', 'judges', null, null);
  const i5 = id('default', 'judged', 'anthropic', 'latency', null, null);
  const i6 = id('implementation-build', 'awaiting_judgment', null, null, 3, null);
  const vote = db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded,
    judge_serena_calls) VALUES (?,?,'both',1,1,?)`);
  vote.run(i1, 'anthropic', 6); vote.run(i1, 'openai', null); vote.run(i3, 'anthropic', 3);
  vote.run(i4, 'anthropic', 4); vote.run(i5, 'anthropic', null);
  assert.deepEqual(serenaLedger(db), [
    `#${i1} implementation-build — anthropic/latency — sides: anthropic 2, openai n/a — judges: anthropic 6, openai n/a`,
    `#${i2} deep-review — union/union — sides: anthropic 16, openai n/a — judges: anthropic n/a, openai n/a`,
    `#${i3} implementation-build — openai/judges — sides: anthropic 12, openai n/a — judges: anthropic 3, openai n/a`,
    `#${i4} default — openai/judges — sides: anthropic n/a, openai n/a — judges: anthropic 4, openai n/a`,
    `#${i6} implementation-build — awaiting_judgment — sides: anthropic 3, openai n/a — judges: anthropic n/a, openai n/a`,
    '5 duel(s) with an attested serena count; judged with an anthropic side count: 2 — anthropic 1, openai 1',
  ]);
});

test('calibrationLedger cuts one contestant era by judge behaviour, wins, latency and fan-out (duel 419)', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'mr-calibration-')), 'mr.db'));
  seedMatrix(db);
  assert.deepEqual(calibrationLedger(db, 'gpt-6-astra'), ['no duels against gpt-6-astra yet']);
  const sides = (gpt: string) => JSON.stringify([
    { vendor: 'anthropic', lane: 'B', model: 'opus', effort: 'high' },
    { vendor: 'openai', lane: 'codex', model: gpt, effort: 'xhigh' },
  ]);
  const A = sides('gpt-6-astra');
  const LM1 = '{"X":"anthropic","Y":"openai"}';
  const LM2 = '{"X":"openai","Y":"anthropic"}';
  const insert = db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    winner_vendor, anth_latency_ms, gpt_latency_ms, anth_env, gpt_env)
    VALUES ('implementation-build', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const duel = (sidesJson: string, labelMap: string, status: string, decidedBy: string | null,
    winner: string | null, anthMs: number | null, gptMs: number | null, anthEnv: string | null,
    gptEnv: string | null): number => Number(insert.run(sidesJson, labelMap, status, decidedBy,
    winner, anthMs, gptMs, anthEnv, gptEnv).lastInsertRowid);
  const vote = db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded,
    grade_x, grade_y, brief_defect) VALUES (?, ?, ?, 1, 1, ?, ?, ?)`);
  const v = (id: number, judge: string, verdict: string, gx: string | null = null,
    gy: string | null = null, defect: string | null = null) => vote.run(id, judge, verdict, gx, gy, defect);
  const r1 = duel(A, LM1, 'judged', 'judges', 'anthropic', 100, 200, '0 sub-agents', '2 sub-agent rollouts');
  v(r1, 'anthropic', 'X', 'A', 'B'); v(r1, 'openai', 'X', 'A-', 'B+');
  const r2 = duel(A, LM2, 'judged', 'judges', 'openai', 300, 100, null, '0 sub-agents');
  v(r2, 'anthropic', 'both', 'A', 'A'); v(r2, 'openai', 'X', 'A', 'C', 'clause one');
  const r3 = duel(A, LM1, 'judged', 'judges', 'anthropic', 150, 150, '3 sub-agents', '1 sub-agent rollout');
  v(r3, 'anthropic', 'both', 'B+', 'B'); v(r3, 'openai', 'X', 'A', 'B-');
  const r4 = duel(A, LM1, 'judged', 'latency', 'openai', 400, 100, 'no count here', null);
  v(r4, 'anthropic', 'both', 'A', 'A'); v(r4, 'openai', 'both', 'A-', 'A-');
  const r5 = duel(A, LM2, 'unresolved', 'contested', null, 100, 100, '0 sub-agents', '0 sub-agents');
  v(r5, 'anthropic', 'Y', 'C', 'A'); v(r5, 'openai', 'X', 'A', 'D', 'clause two');
  duel(A, LM1, 'walkover', 'walkover', 'openai', null, 100, null, null);
  const r7 = duel(A, LM1, 'judged', 'judges', 'anthropic', 120, 240, '1 sub-agent', '0 sub-agents');
  v(r7, 'anthropic', 'X', 'A+', 'F'); v(r7, 'openai', 'tie');
  const r8 = duel(A, LM1, 'judged', 'tokens', 'openai', 500, 250, '0 sub-agents', '4 sub-agent rollouts');
  v(r8, 'anthropic', 'both'); v(r8, 'openai', 'both', 'B', 'B');
  const r9 = duel(A, LM1, 'unresolved', 'both_failed', null, 100, 100, null, null);
  v(r9, 'anthropic', 'neither', 'D', 'D'); v(r9, 'openai', 'neither', 'F', 'D');
  const r10 = duel(A, '{}', 'judged', 'latency', 'anthropic', 90, 180, null, null);
  v(r10, 'anthropic', 'X', 'A', 'A'); v(r10, 'openai', 'Y', 'A', 'A');
  duel(A, LM1, 'union', 'union', null, 100, 50, '0 sub-agents', '0 sub-agents');
  duel(A, LM1, 'abandoned', 'abandoned', null, null, null, null, null);
  duel(A, LM1, 'routed', null, null, null, null, null, null);
  const r14 = duel(sides('gpt-5.6-sol'), LM1, 'judged', 'judges', 'openai', 100, 100, '0 sub-agents', '0 sub-agents');
  v(r14, 'anthropic', 'Y', 'B', 'A'); v(r14, 'openai', 'Y', 'B', 'A');
  const r15 = duel('[]', LM1, 'judged', 'judges', 'anthropic', 100, 100, null, null);
  v(r15, 'anthropic', 'X', 'A', 'B');
  const r16 = duel('oops', LM1, 'judged', 'judges', 'anthropic', 100, 100, null, null);
  v(r16, 'anthropic', 'X', 'A', 'B');
  assert.deepEqual(calibrationLedger(db, 'gpt-6-astra'), [
    'era gpt-6-astra: 13 duel(s) — judged 7, unresolved 2, walkover 1, union 1, abandoned 1, other 1',
    'judged wins: anthropic 4, openai 3 — by judges 3/1, by latency 1/1, by other 0/1',
    'judges-decided wins: anthropic 3 — unanimous 1, own-judge-alone 0, other-judge-alone 1, other 1; '
      + 'openai 1 — unanimous 0, own-judge-alone 1, other-judge-alone 0, other 0',
    'votes anthropic judge: 9 — both 4, passes anthropic 3, passes openai 0, neither 1, other 1',
    'votes openai judge: 9 — both 2, passes anthropic 2, passes openai 2, neither 1, other 2',
    'judge agreement: 44% of 9 duel(s) with both votes',
    'brief-defect flags: anthropic judge 0, openai judge 2',
    'own-vendor grading: anthropic judge higher 4, equal 3, lower 0 of 7 graded vote(s); '
      + 'openai judge higher 3, equal 2, lower 2 of 7 graded vote(s)',
    'latency ratio anthropic:openai: median 1.00 over 7 judged duel(s)',
    'fan-out: anthropic fanned 2, solo 4, unknown 7; openai fanned 3, solo 4, unknown 6',
  ]);
  assert.deepEqual(calibrationLedger(db, 'gpt-5.6-sol').slice(0, 2), [
    'era gpt-5.6-sol: 1 duel(s) — judged 1, unresolved 0, walkover 0, union 0, abandoned 0, other 0',
    'judged wins: anthropic 0, openai 1 — by judges 0/1, by latency 0/0, by other 0/0',
  ]);
  // The CLI surface on the shared seeded DB (no duels yet): default literal, then an explicit era.
  assert.equal(cli('calibration'), 'no duels against gpt-6-astra yet\n');
  assert.equal(cli('calibration', 'gpt-5.6-sol'), 'no duels against gpt-5.6-sol yet\n');
});

test('union on/off flips the row, and an already-set state changes nothing', () => {
  cli('seed');
  const rows = () => JSON.parse(cli('standings')).kinds as any[];
  const kind = (k: string) => rows().find(r => r.kind === k);

  assert.equal(kind('deep-review').union, true); // seeded union
  assert.match(cli('union', 'deep-review', 'off'), /deep-review: union off/);
  assert.equal(kind('deep-review').union, false);
  assert.match(cli('union', 'deep-review', 'off'), /already union off — unchanged/);
  assert.match(cli('union', 'deep-review', 'on'), /deep-review: union on/);
  assert.equal(kind('deep-review').union, true);
  assert.match(cli('matrix'), /n\/a \(union\)/);

  // A typo'd kind must fail loudly rather than report a flip nothing received.
  assert.throws(() => cli('union', 'no-such-kind', 'on'), /Command failed/);
  assert.throws(() => cli('union', 'deep-review'), /Command failed/); // missing on|off

  // duel-163 F4: the dead slugs are aliases on EVERY public surface, the operator CLI included
  // — 'mrctl union implementation on' used to exit 'no matrix row' while route_task and
  // record_outcome with the same slug hit the -misc row. Output names the row that changed.
  assert.match(cli('union', 'implementation', 'on'), /implementation-misc: union on/);
  assert.equal(kind('implementation-misc').union, true);
  assert.equal(kind('implementation'), undefined); // no legacy row forked into existence
  assert.match(cli('union', 'bulk-mechanical', 'on'), /bulk-mechanical-misc: union on/);
  assert.match(cli('union', 'implementation-misc', 'off'), /implementation-misc: union off/);
});

test('the SessionStart hook path keeps the offline fallback doc current', () => {
  // SKILL.md tells the controller to fall back to matrix.md when the engine is unreachable, but
  // it was written only by `matrix --render` and the MCP mutation handlers — so on a fresh
  // install it never existed, and the only things that created it were the unreachable paths.
  const fresh = mkdtempSync(join(tmpdir(), 'mr-hook-'));
  const hookEnv = { ...process.env, MR_DB_PATH: join(fresh, 'mr.db'), MR_DATA_DIR: fresh };
  execFileSync('node', ['dist/src/cli.js', 'quota', '--summary'], { env: hookEnv, encoding: 'utf8' });
  assert.match(readFileSync(join(fresh, 'matrix.md'), 'utf8'), /# Routing Matrix/);
});

test('the SessionStart hook puts sweep ids and pending duels on stdout, where session context can see them', () => {
  // A duel id used to exist in exactly one place: the route_task response in a transcript that
  // may be compacted or gone. The hook's stderr never enters session context — stdout does.
  const fresh = mkdtempSync(join(tmpdir(), 'mr-pend-'));
  const env2 = { ...process.env, MR_DB_PATH: join(fresh, 'mr.db'), MR_DATA_DIR: fresh };
  execFileSync('node', ['dist/src/cli.js', 'seed'], { env: env2 });
  const db = openDb(join(fresh, 'mr.db'));
  const now = Date.now();
  const ins = (kind: string, status: string, createdAt: number, outputs: boolean) =>
    db.prepare(
      `INSERT INTO duels(task_kind, created_at, sides, label_map, status, anth_output, gpt_output)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(kind, createdAt, '[]', '{}', status, outputs ? 'a' : null, outputs ? 'g' : null);
  ins('deep-review', 'routed', now - 7 * 3_600_000, false);          // expired — sweep fodder
  ins('implementation-misc', 'awaiting_judgment', now - 3_600_000, true); // in flight
  ins('bulk-mechanical', 'abandoned', now - 24 * 3_600_000, true);   // swept earlier, re-judgeable
  // a displaced sitter's tombstone — the listing must say so, or the consumer rule
  // (revive-or-leave-alone) is unfollowable in the next session (duel-74 sol F1)
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    superseded_by, abandoned_at) VALUES ('transcription', ?, '[]', '{}', 'abandoned',
    'superseded', 2, ?)`).run(now - 3_600_000, now - 3_600_000);
  // a tombstone stamped by a pre-2.6.12 writer: the spelling but no column — the marker must
  // still print, with no recording duel id to name (duel-75 opus F1)
  db.prepare(`INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
    abandoned_at) VALUES ('second-opinion', ?, '[]', '{}', 'abandoned',
    'superseded', ?)`).run(now - 3_600_000, now - 3_600_000);
  db.close();
  const out = execFileSync('node', ['dist/src/cli.js', 'quota', '--summary'],
    { env: env2, encoding: 'utf8' });
  assert.match(out, /expired duel\(s\) 1 → abandoned/);
  assert.match(out, /pending duels: /);
  assert.match(out, /#2 implementation-misc awaiting_judgment/);
  // the dead-slug fold (v2.10.9) canonicalizes stored history at open, so the listing names
  // the -misc spelling even though the row was inserted under the old one
  assert.match(out, /#3 bulk-mechanical-misc abandoned \(re-judgeable\)/);
  assert.match(out, /#1 deep-review abandoned/); // the row the sweep just closed is itself listed
  assert.match(out, /#4 transcription abandoned \(displaced by #2\)/);
  assert.match(out, /#5 second-opinion abandoned \(displaced\)/);
  // mrctl status carries the same list for a human
  const st = execFileSync('node', ['dist/src/cli.js', 'status'], { env: env2, encoding: 'utf8' });
  assert.match(st, /pending duels: /);
});

test('an engine-unavailable refusal reaches the hook stdout, not only stderr', () => {
  // openDb's NO-GATE refusal (and any other open-time throw) used to land on stderr with
  // exit 0 on the quota path — in session context that is indistinguishable from a healthy
  // session with an empty dashboard: no lane lines, no pending ids, no sweep
  // (duel-73 opus F2). The hook reads ONLY stdout.
  const fresh = mkdtempSync(join(tmpdir(), 'mr-nogate-'));
  writeFileSync(join(fresh, 'mr.db'), 'not a database');
  const env3 = { ...process.env, MR_DB_PATH: join(fresh, 'mr.db'), MR_DATA_DIR: fresh };
  const out = execFileSync('node', ['dist/src/cli.js', 'quota', '--summary'],
    { env: env3, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // exit 0 on the hook path — execFileSync would throw otherwise
  assert.match(out, /engine unavailable/);
  assert.match(out, /matrix\.md/);
  // The message must not promise a file that never exists on the install class where this
  // refusal fires: every matrix.md writer needs an open DB first, and a fresh install has
  // none (duel-74 opus F2). The controller's always-present fallback is SKILL.md's seed.
  assert.match(out, /if an earlier session wrote one/);
  assert.match(out, /SKILL\.md/);
});

// The NO-GATE refusal's diagnostics (heal-failure line, in-flight audit ids) used to leave
// through console.error on a path whose only handler force-exits — the exact drop hazard
// c0470d2 fixed for the refusal line itself, restored one file over on async-pipe platforms
// (macOS; duel-75 opus F3 / sol F2). They leave via writeSync now, and this test consumes
// them where the operator does: the child process's actual stderr pipe, through the exit.
test('NO-GATE refusal diagnostics survive the hook exit on the real pipe', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'mr-nogate-diag-'));
  const path = join(fresh, 'mr.db');
  const db = openDb(path); seedMatrix(db, 1);
  db.exec('DROP INDEX IF EXISTS idx_one_inflight_spot');
  db.exec('DROP INDEX IF EXISTS idx_one_routed_spot');
  const now = Date.now();
  // a TTL-dead bystander the heal's sweep takes — and the rollback gives back…
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('transcription', 1, 0, '[]', '{}', 'routed')`).run();
  // …a FRESH duplicate audit pair that blocks both index creates…
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation-misc', ?, 1, '[]', '{}', 'routed')`).run(now - 60_000);
  db.prepare(`INSERT INTO duels(task_kind, created_at, spot_check, sides, label_map, status)
    VALUES ('implementation-misc', ?, 1, '[]', '{}', 'routed')`).run(now - 30_000);
  // …and a fault that kills the demotion mid-heal (same class as db.test.ts's atomic-heal pin)
  db.exec(`CREATE TRIGGER heal_fault BEFORE UPDATE OF demoted_audit ON duels
    BEGIN SELECT RAISE(ABORT, 'injected heal fault'); END`);
  db.close();
  const res = spawnSync('node', ['dist/src/cli.js', 'quota', '--summary'],
    { env: { ...process.env, MR_DB_PATH: path, MR_DATA_DIR: fresh }, encoding: 'utf8' });
  assert.equal(res.status, 0); // hook path: a refusal, not a session error banner
  assert.match(res.stdout, /engine unavailable/); // the hook reads ONLY stdout
  assert.match(res.stderr, /idx_one_inflight_spot create failed \(NO GATE/);
  assert.match(res.stderr, /heal failed: injected heal fault/); // duel-69 sol M6, same line
  assert.match(res.stderr, /in-flight spot audit\(s\) at refusal: .*implementation-misc routed/);
  // and stderr does not claim the sweep the rollback undid
  assert.ok(!/swept duel/.test(res.stderr),
    `expected no swept-duel claim, got: ${res.stderr}`);
});

test('laneLabel decorates lane B with the resolved dir basename, unresolved marker on throw', async () => {
  const { laneLabel } = await import('../src/cli-lib.js');
  process.env.MR_B_CONFIG_DIR = '/home/x/.claude-a';
  // '.claude-a', dot included — basename() of the dir, which is what the operator greps for.
  try { assert.equal(laneLabel('B'), 'B[.claude-a]'); }
  finally { delete process.env.MR_B_CONFIG_DIR; }
  // no pin + nonexistent MR_MAIN_CONFIG → resolution throws:
  assert.equal(laneLabel('B'), 'B[unresolved]');
  assert.equal(laneLabel('A'), 'A');
});

// v2.13.46: contested rows are terminal and silent — the backlog needs a surface (283/284/289
// sat invisible until the operator asked for an investigation).
test('mrctl contested lists the backlog with outcome and brief-defect markers', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'mr-contested-'));
  const env2 = { ...process.env, MR_DB_PATH: join(fresh, 'mr.db'), MR_DATA_DIR: fresh };
  execFileSync('node', ['dist/src/cli.js', 'seed'], { env: env2 });
  const db = openDb(join(fresh, 'mr.db'));
  const now = Date.now();
  const ins = (kind: string, decidedBy: string) => db.prepare(
    `INSERT INTO duels(task_kind, created_at, sides, label_map, status, decided_by,
       anth_output, gpt_output)
     VALUES (?,?, '[]', '{}', 'unresolved', ?, 'a', 'g')`)
    .run(kind, now - 2 * 86_400_000, decidedBy);
  ins('implementation-build', 'contested');
  ins('transcription', 'both_failed');
  db.prepare(`INSERT INTO outcomes(date, task_kind, model, kind, evidence, role, consumed)
    VALUES ('2026-08-20','implementation-build','gpt-5.6-sol','FAIL',
      'Duel 1: F3 regression proven on the real payload', NULL, 0)`).run();
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded,
    brief_defect) VALUES (1, 'anthropic', 'X', ?, 1, 'a non-null maturity_date throws')`)
    .run(now);
  // v2.13.49: duel 1's votes form a HEAD-ON split (X vs Y) — the backlog line says the
  // fact-check round applies; duel 2 has no such votes and stays unmarked.
  db.prepare(`INSERT INTO judgments(duel_id, judge_vendor, verdict, created_at, graded)
    VALUES (1, 'openai', 'Y', ?, 1)`).run(now);
  db.close();
  const out = execFileSync('node', ['dist/src/cli.js', 'contested'],
    { env: env2, encoding: 'utf8' });
  assert.match(out,
    /#1 implementation-build — contested, 2d old — outcome recorded — brief defect flagged by 1 vote\(s\) — HEAD-ON split: fact-check round applies/);
  assert.match(out, /#2 transcription — both_failed, 2d old — NO outcome row/);
  assert.doesNotMatch(out, /#2 .*HEAD-ON/);
});

test('the hook quota line prints each model-scoped pool beside the account weekly (duel-391 P3)', async () => {
  // The account windows read 7% while the fable pool sat at 100% (rows 311-380): the line the
  // operator reads at session start said OPEN and nothing else. Every model-tagged window the
  // parser stored is printed beside the weekly figure, with its own closed/soft state.
  const { storeSnapshot } = await import('../src/quota/poll.js');
  const H = 3_600_000;
  const rows: Array<{ name: string; fable: number; expect: RegExp }> = [
    { name: 'open pool', fable: 32, expect: /B[^:|]*: 7% wk \(fable 32%\), pace/ },
    { name: 'soft pool', fable: 85, expect: /B[^:|]*: 7% wk \(fable 85%, soft\), pace/ },
    { name: 'hard-capped pool', fable: 100, expect: /B[^:|]*: 7% wk \(fable 100%, closed\), pace/ },
  ];
  for (const r of rows) {
    const fresh = mkdtempSync(join(tmpdir(), 'mr-pool-'));
    const env3 = { ...process.env, MR_DB_PATH: join(fresh, 'mr.db'), MR_DATA_DIR: fresh };
    const db = openDb(join(fresh, 'mr.db'));
    const now = Date.now();
    storeSnapshot(db, { lane: 'B', fetchedAt: now, windows: [
      { windowMinutes: 300, utilization: 10, resetsAt: now + 2 * H },
      { windowMinutes: 10080, utilization: 7, resetsAt: now + 100 * H },
      { windowMinutes: 10080, utilization: r.fable, resetsAt: now + 26 * H, model: 'fable' },
    ] });
    // lane A carries no pool window: nothing is printed for it
    storeSnapshot(db, { lane: 'A', fetchedAt: now, windows: [
      { windowMinutes: 10080, utilization: 3, resetsAt: now + 100 * H },
    ] });
    db.close();
    const out = execFileSync('node', ['dist/src/cli.js', 'quota', '--summary'],
      { env: env3, encoding: 'utf8' });
    assert.match(out, r.expect, `${r.name}: ${out}`);
    assert.match(out, /A: 3% wk, pace/, `${r.name}: ${out}`);
  }
});
