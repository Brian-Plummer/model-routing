import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Side } from '../src/types.js';

// No MR_CRED_B / MR_B_PROJECTS pins here on purpose: this suite exercises RESOLUTION, and those
// pins bypass it (poll.test.ts relies on the bypass; this file proves the un-pinned path).
const tmp = mkdtempSync(join(tmpdir(), 'mr-lanedirs-'));
// "live" env-default fixtures for the composed test in Task 2 — set BEFORE importing paths.js.
const live = join(tmp, 'live');
mkdirSync(join(live, 'aux-a'), { recursive: true });
mkdirSync(join(live, 'aux-b'), { recursive: true });
process.env.MR_MAIN_CONFIG = join(live, 'main.claude.json');
process.env.MR_AUX_A = join(live, 'aux-a');
process.env.MR_AUX_B = join(live, 'aux-b');
process.env.MR_CRED_A = join(live, 'credA.json');
process.env.MR_CODEX_SESSIONS = join(live, 'sessions');
mkdirSync(join(live, 'data'), { recursive: true });
process.env.MR_DATA_DIR = join(live, 'data');
process.env.MR_DB_PATH = join(live, 'data', 'mr.db');

const { offloadDir, courierUndeliverable } = await import('../src/paths.js');

const uuidJson = (uuid: string) => JSON.stringify({ oauthAccount: { accountUuid: uuid } });

interface Case {
  name: string; main: string | null;
  a: string | 'missing' | 'malformed'; b: string | 'missing' | 'malformed';
  want: 'a' | 'b' | RegExp;
}
const CASES: Case[] = [
  { name: 'main on A picks the b-dir', main: 'u-A', a: 'u-A', b: 'u-B', want: 'b' },
  { name: 'main on B picks the a-dir', main: 'u-B', a: 'u-A', b: 'u-B', want: 'a' },
  { name: 'all same account fails loud with login hint', main: 'u-A', a: 'u-A', b: 'u-A',
    want: /no aux config dir differs.*claude \/login/s },
  { name: 'unknown third account is ambiguous', main: 'u-C', a: 'u-A', b: 'u-B',
    want: /ambiguous offload/ },
  { name: 'missing main config fails loud', main: null, a: 'u-A', b: 'u-B', want: /main\.claude\.json/ },
  { name: 'malformed aux json is skipped, other still resolves', main: 'u-A', a: 'malformed', b: 'u-B', want: 'b' },
  { name: 'both aux unreadable fails naming the problem', main: 'u-A', a: 'missing', b: 'missing',
    want: /no aux config dir differs/ },
];

for (const [i, c] of CASES.entries()) {
  test(`offloadDir: ${c.name}`, () => {
    const root = join(tmp, `case${i}`);
    const mainPath = join(root, 'main.claude.json');
    const dirs = { a: join(root, 'aux-a'), b: join(root, 'aux-b') };
    mkdirSync(dirs.a, { recursive: true });
    mkdirSync(dirs.b, { recursive: true });
    if (c.main !== null) writeFileSync(mainPath, uuidJson(c.main));
    for (const k of ['a', 'b'] as const) {
      if (c[k] === 'missing') continue;
      writeFileSync(join(dirs[k], '.claude.json'), c[k] === 'malformed' ? '{not json' : uuidJson(c[k]));
    }
    const opts = { mainConfig: mainPath, auxDirs: [dirs.a, dirs.b] };
    if (c.want instanceof RegExp) assert.throws(() => offloadDir(opts), c.want);
    else assert.equal(offloadDir(opts), dirs[c.want]);
  });
}

test('MR_B_CONFIG_DIR pins the offload dir, resolution skipped entirely', () => {
  process.env.MR_B_CONFIG_DIR = '/pinned/dir';
  try {
    assert.equal(offloadDir({ mainConfig: '/nonexistent', auxDirs: [] }), '/pinned/dir');
  } finally { delete process.env.MR_B_CONFIG_DIR; }
});

// Transition pair for the trailing-slash canonicalization: the same slashed spelling that the
// courier-mirror rows above REFUSE comes out of the resolver canonical — from the pin AND from
// aux-dir resolution — so what route_task gates and forwards is always the deliverable string.
test('a slashed MR_B_CONFIG_DIR pin resolves canonical — gate and courier see the same string', () => {
  process.env.MR_B_CONFIG_DIR = '/home/u/.claude-b///';
  try {
    const dir = offloadDir({ mainConfig: '/nonexistent', auxDirs: [] });
    assert.equal(dir, '/home/u/.claude-b');
    assert.equal(courierUndeliverable(dir, '/home/u'), null);
  } finally { delete process.env.MR_B_CONFIG_DIR; }
});

test('a slashed aux dir resolves canonical too', () => {
  const root = join(tmp, 'slashed-aux');
  const dirs = { a: join(root, 'aux-a'), b: join(root, 'aux-b') };
  mkdirSync(dirs.a, { recursive: true });
  mkdirSync(dirs.b, { recursive: true });
  const mainPath = join(root, 'main.claude.json');
  writeFileSync(mainPath, uuidJson('u-A'));
  writeFileSync(join(dirs.a, '.claude.json'), uuidJson('u-A'));
  writeFileSync(join(dirs.b, '.claude.json'), uuidJson('u-B'));
  assert.equal(offloadDir({ mainConfig: mainPath, auxDirs: [dirs.a, dirs.b + '/'] }), dirs.b);
});

// ---- courier deliverability: the resolver↔forwarder shared path policy ----
// Mirror of the claude-b courier's ConfigDir allowlist (agents/claude-b.md): a dir that fails
// here resolves fine engine-side but dies on every spawn with CLAUDE-B-FAILED: bad ConfigDir.
const DELIVER: Array<[dir: string, ok: boolean, why: string]> = [
  ['/home/u/.claude-b', true, 'the default shape'],
  ['/home/u/.claude-a2', true, 'any letters/digits suffix'],
  ['/home/u/.claude-x_Y-2', true, 'underscore and dash in suffix'],
  ['/srv/claude-offload', false, 'parent is not $HOME'],
  ['/home/u/nested/.claude-b', false, 'parent must be EXACTLY $HOME'],
  ['/home/u/.claude', false, 'bare .claude is the main account, never the offload'],
  ['/home/u/.claude-b.bak', false, 'second dot in the leaf'],
  ["/home/u/.claude-b'x", false, 'quote character breaks the single-quoted wrapper'],
  ['.claude-b', false, 'relative path'],
  ['~/.claude-b', false, 'unexpandable under the wrapper\'s single quotes'],
  // The courier matches the header LITERALLY — dirname/basename tolerance here was the
  // divergence that let a slashed pin mint duels whose B sides all died on the spawn.
  // offloadDir canonicalizes the slash away before the gate, so a slashed PIN still delivers.
  ['/home/u/.claude-b/', false, 'trailing slash — same dir, spelling the courier refuses'],
  ['/home/u//.claude-b', false, 'doubled separator — spelling the courier refuses'],
];
for (const [dir, ok, why] of DELIVER) {
  test(`courierUndeliverable: ${dir} — ${why}`, () => {
    const res = courierUndeliverable(dir, '/home/u');
    if (ok) assert.equal(res, null);
    else assert.ok(res, `expected a refusal for ${dir}`);
  });
}

// ---- poller integration (uses the "live" env-default fixtures set up top) ----
const { openDb } = await import('../src/db.js');
const { pollAll, latestSnapshot, reauthNeeded } = await import('../src/quota/poll.js');

// The usage-payload fixture from the top of tests/poll.test.ts (the JSON body
// parseAnthropicUsage accepts), copied verbatim.
const usagePayload = JSON.stringify({
  five_hour: { utilization: 16, resets_at: '2026-07-24T01:59:59+00:00' },
  seven_day: { utilization: 3, resets_at: '2026-07-29T17:59:59+00:00' },
});

const liveMain = process.env.MR_MAIN_CONFIG!;
const auxA = process.env.MR_AUX_A!;
const auxB = process.env.MR_AUX_B!;

test('resolver failure surfaces as a lane-B poll failure; lane A unaffected', async () => {
  const db = openDb();
  writeFileSync(process.env.MR_CRED_A!, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-main' } }));
  // all three configs on the same account: unresolvable
  writeFileSync(liveMain, uuidJson('u-same'));
  writeFileSync(join(auxA, '.claude.json'), uuidJson('u-same'));
  writeFileSync(join(auxB, '.claude.json'), uuidJson('u-same'));
  const report = await pollAll(db, async () => usagePayload, Date.now(),
    async () => { throw new Error('no refresh in this test'); });
  assert.ok(report.ok.includes('A'));
  const b = report.failed.find(f => f.lane === 'B');
  assert.match(b!.error, /no aux config dir differs/);
  assert.equal(reauthNeeded('B'), false); // unresolvable ≠ reauth
});

test('composed: poller follows a main-account flip between polls (rule-2 composed scenario)', async () => {
  const db = openDb();
  writeFileSync(process.env.MR_CRED_A!, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-main' } }));
  writeFileSync(join(auxA, '.claude.json'), uuidJson('u-A'));
  writeFileSync(join(auxA, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-a' } }));
  writeFileSync(join(auxB, '.claude.json'), uuidJson('u-B'));
  writeFileSync(join(auxB, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-b' } }));
  const seen: string[] = [];
  const fetcher = async (_url: string, token: string) => { seen.push(token); return usagePayload; };
  const noRefresh = async () => { throw new Error('no refresh in this test'); };

  const t = Date.now();
  writeFileSync(liveMain, uuidJson('u-A'));           // main on A → offload is aux-b
  await pollAll(db, fetcher, t, noRefresh);
  writeFileSync(liveMain, uuidJson('u-B'));           // flip → offload is aux-a
  await pollAll(db, fetcher, t + 1, noRefresh);

  assert.deepEqual(seen, ['tok-main', 'tok-b', 'tok-main', 'tok-a']);
  // BOTH offload snapshots landed under the same POSITIONAL lane B — the old bare
  // latestSnapshot() truthiness check proved only that at least one did (the "comment
  // overstates assertion" anti-pattern). Count and stamps, not existence.
  assert.deepEqual(
    db.prepare("SELECT fetched_at FROM quota_snapshots WHERE lane='B' ORDER BY fetched_at")
      .all().map((r: any) => r.fetched_at),
    [t, t + 1]);
  assert.ok(latestSnapshot(db, 'B'));
});

const { defaultProofRoots, createDuel, recordResults, recordJudgment } =
  await import('../src/duel.js');

test('proof roots follow the resolved offload dir, null when unresolvable', () => {
  writeFileSync(liveMain, uuidJson('u-A'));
  writeFileSync(join(auxA, '.claude.json'), uuidJson('u-A'));
  writeFileSync(join(auxB, '.claude.json'), uuidJson('u-B'));
  assert.equal(defaultProofRoots().B, join(auxB, 'projects'));
  writeFileSync(join(auxB, '.claude.json'), uuidJson('u-A')); // now nothing differs
  assert.equal(defaultProofRoots().B, null);
});

// ---- an unresolvable offload must REFUSE, not skip (fix round 1) ----
// B:null used to mean one thing — "the caller turned attestation off" — and the resolver
// started producing the same null for "I cannot tell which account is the offload one".
// Misconfiguration then recorded lane-B work with no session file at all: less checking in the
// broken state than in the healthy one.
const SIDES: [Side, Side] = [
  { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
  { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
];
const out = (output: string) => ({ output, tokens: 500, latencyMs: 50, failed: false });
// all three configs on one account → offloadDir() throws → defaultProofRoots().B is null
const unresolvable = () => {
  writeFileSync(liveMain, uuidJson('u-same'));
  writeFileSync(join(auxA, '.claude.json'), uuidJson('u-same'));
  writeFileSync(join(auxB, '.claude.json'), uuidJson('u-same'));
};
const routed = () => {
  const db = openDb(':memory:');
  return { db, id: createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, 1) };
};
const CALLER_OFF = { roots: { B: null, codex: null } };

test('unresolvable offload refuses a proofless lane-B side, naming the resolver failure', () => {
  unresolvable();
  const { db, id } = routed();
  assert.throws(
    () => recordResults(db, id, { anthropic: out('anth out'), openai: out('gpt out') }),
    /unresolvable.*no aux config dir differs/s);
});

test('unresolvable offload refuses an unproofed anthropic judge vote', () => {
  unresolvable();
  const { db, id } = routed();
  // land both sides through the caller hatch, so the row reaches awaiting_judgment
  recordResults(db, id, { anthropic: out('anth out'), openai: out('gpt out') }, CALLER_OFF);
  assert.throws(() => recordJudgment(db, id, 'anthropic', 'X', 2),
    /unresolvable.*no aux config dir differs/s);
});

// Composed (rule 2): both fixes read the SAME field, so the caller's null and the resolver's
// null must stay distinguishable in one scenario — same broken configs, roots passed by the
// caller, attestation still skipped end to end.
test('composed: caller-passed B:null still disables attestation under the same broken configs', () => {
  unresolvable();
  const { db, id } = routed();
  const res = recordResults(db, id, { anthropic: out('anth out'), openai: out('gpt out') }, CALLER_OFF);
  assert.equal(res.status, 'awaiting_judgment');
  assert.deepEqual(recordJudgment(db, id, 'anthropic', 'X', 2, CALLER_OFF),
    { status: 'awaiting_judgment' });
});
