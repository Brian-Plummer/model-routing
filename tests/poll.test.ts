import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Env overrides MUST be set before importing paths-dependent modules
const tmp = mkdtempSync(join(tmpdir(), 'mr-poll-'));
process.env.MR_CRED_A = join(tmp, 'credA.json');
process.env.MR_CRED_B = join(tmp, 'credB.json');
process.env.MR_CODEX_SESSIONS = join(tmp, 'sessions');

const { openDb } = await import('../src/db.js');
const { pollAll, latestSnapshot, codexLaneOf, reauthNeeded, HEAD_BYTES } =
  await import('../src/quota/poll.js');

// Real rollouts name their model once, in the thread_settings_applied event near the head.
const settings = (model: string) => JSON.stringify({
  type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_settings: { model, model_provider_id: 'openai' } },
});

const cred = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-123' } });
writeFileSync(process.env.MR_CRED_A!, cred);
writeFileSync(process.env.MR_CRED_B!, cred);
mkdirSync(join(tmp, 'sessions/2026/07/23'), { recursive: true });
const CODEX_LINE = JSON.stringify({ payload: { info: { rate_limits: {
  limit_id: 'codex',
  primary: { used_percent: 7, window_minutes: 10080, resets_at: 1785270463 },
} } } });
writeFileSync(join(tmp, 'sessions/2026/07/23/rollout-x.jsonl'),
  settings('gpt-5.6-terra') + '\n' + CODEX_LINE + '\n');

const USAGE = JSON.stringify({
  five_hour: { utilization: 16, resets_at: '2026-07-24T01:59:59+00:00' },
  seven_day: { utilization: 3, resets_at: '2026-07-29T17:59:59+00:00' },
});

test('pollAll stores snapshots for A, B, codex with fake fetcher', async () => {
  const db = openDb(':memory:');
  const report = await pollAll(db, async (_url, token) => {
    assert.equal(token, 'tok-123');
    return USAGE;
  }, 999);
  assert.deepEqual(report.ok.sort(), ['A', 'B', 'codex']);
  assert.equal(latestSnapshot(db, 'A')!.windows.length, 2);
  assert.equal(latestSnapshot(db, 'codex')!.windows[0].utilization, 7);
  // spark is metered (duel 268): no spark rollout in the window is an honest per-lane outage,
  // not silence — the lane reads stale until spark itself runs again.
  assert.equal(latestSnapshot(db, 'spark'), null);
  assert.deepEqual(report.failed.map(f => f.lane), ['spark']);
});

test('codex snapshot is stamped with the session file mtime, not the poll clock', async () => {
  const db = openDb(':memory:');
  await pollAll(db, async () => USAGE, 999);
  const snap = latestSnapshot(db, 'codex')!;
  const mtime = statSync(join(tmp, 'sessions/2026/07/23/rollout-x.jsonl')).mtimeMs;
  assert.equal(snap.fetchedAt, mtime);
  assert.notEqual(snap.fetchedAt, 999); // re-stamping old data as fresh hid stale lanes forever
});

test('a spark rollout fills the spark snapshot and never the codex pool', async () => {
  const db = openDb(':memory:');
  // A spark rollout reports limit_id "codex" exactly like every other run — only the model says
  // which pool it billed. Classifying by model keeps its numbers OUT of the codex snapshot AND
  // (since duel 268 proved spark meters its own pool) IN a spark snapshot of its own.
  // Newest file here, so a lane-blind scan would have taken it as codex.
  const sparkLine = JSON.stringify({ payload: { info: { rate_limits: {
    limit_id: 'codex',
    primary: { used_percent: 42, window_minutes: 10080, resets_at: 1785270463 },
  } } } });
  const sparkPath = join(tmp, 'sessions/2026/07/23/rollout-spark.jsonl');
  writeFileSync(sparkPath, settings('gpt-5.3-codex-spark') + '\n' + sparkLine + '\n');
  const report = await pollAll(db, async () => USAGE, 999);
  assert.equal(latestSnapshot(db, 'codex')!.windows[0].utilization, 7); // not 42
  assert.equal(latestSnapshot(db, 'spark')!.windows[0].utilization, 42); // spark's own pool
  assert.equal(latestSnapshot(db, 'spark')!.lane, 'spark');
  assert.deepEqual(report.failed, []);
  assert.ok(report.ok.includes('spark'));
  utimesSync(sparkPath, new Date(1), new Date(1)); // leave it oldest for later tests
});

test('codexLaneOf reads the model, and a rollout with no model is skipped', async () => {
  assert.equal(codexLaneOf(join(tmp, 'sessions/2026/07/23/rollout-x.jsonl')), 'codex');
  assert.equal(codexLaneOf(join(tmp, 'sessions/2026/07/23/rollout-spark.jsonl')), 'spark');
  const mystery = join(tmp, 'sessions/2026/07/23/rollout-nomodel.jsonl');
  const otherPool = JSON.stringify({ payload: { info: { rate_limits: {
    limit_id: 'codex',
    primary: { used_percent: 99, window_minutes: 10080, resets_at: 1785270463 },
  } } } });
  writeFileSync(mystery, otherPool + '\n'); // newest file, but its pool is unattributable
  try {
    assert.equal(codexLaneOf(mystery), null);
    const db = openDb(':memory:');
    await pollAll(db, async () => USAGE, 999);
    assert.equal(latestSnapshot(db, 'codex')!.windows[0].utilization, 7); // not 99
  } finally { rmSync(mystery); }
});

test('an unparseable line never classifies the lane by its text', async () => {
  // A line the head slice cut in half, or any shape neither settings branch knows, carrying a
  // model id somewhere in it. The old flat-regex fallback scanned the whole 256 KiB head as
  // text and classified the run from the first match — so a quoted config or a truncated event
  // could write codex's pool into the spark snapshot. Unknown shape → skip the file.
  const mangled = join(tmp, 'sessions/2026/07/23/rollout-cut.jsonl');
  writeFileSync(mangled,
    '{"type":"event_msg","payload":{"type":"turn_aborted","cfg":{"model":"gpt-5.3-codex-spark"'
    + '\n' + CODEX_LINE + '\n');
  try {
    assert.equal(codexLaneOf(mangled), null);
  } finally { rmSync(mangled); }
});

test('a mid-session /model switch is read from the last settings event', async () => {
  const switched = join(tmp, 'sessions/2026/07/23/rollout-switch.jsonl');
  // starts on terra, switches to spark an hour in — the tail rate_limits bill spark's pool
  writeFileSync(switched,
    settings('gpt-5.6-terra') + '\n' + settings('gpt-5.3-codex-spark') + '\n' + CODEX_LINE + '\n');
  try {
    assert.equal(codexLaneOf(switched), 'spark');
  } finally { rmSync(switched); }
});

test('a scan window with no codex rollout is reported as a codex outage', async () => {
  // every rollout in the window is spark (it shadows every haiku-tier route, so it produces
  // the most files): codex is never refreshed and used to go stale with an empty failed list
  const codexPath = join(tmp, 'sessions/2026/07/23/rollout-x.jsonl');
  const saved = readFileSync(codexPath, 'utf8');
  const mtime = statSync(codexPath).mtimeMs / 1000;
  rmSync(codexPath);
  try {
    const db = openDb(':memory:');
    const report = await pollAll(db, async () => USAGE, 999);
    assert.deepEqual(report.ok.sort(), ['A', 'B', 'spark']);
    assert.deepEqual(report.failed.map(f => f.lane), ['codex']);
  } finally {
    writeFileSync(codexPath, saved);
    utimesSync(codexPath, new Date(mtime * 1000), new Date(mtime * 1000));
  }
});

test('one lane failing does not abort the others', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const report = await pollAll(db, async () => {
    if (++calls === 1) throw new Error('401');
    return USAGE;
  }, 999);
  assert.ok(report.failed.some(f => f.lane === 'A'));
  assert.ok(report.ok.includes('B'));
});

test('a model switch past the head slice is read from the tail, not the stale head', () => {
  // An interactive session that ran long enough to push its `/model` switch beyond the head
  // slice still bills the NEW model's pool at the tail, which is the part being parsed.
  const big = join(tmp, 'sessions/2026/07/23/rollout-switch.jsonl');
  const filler = Array.from({ length: 3000 }, (_, i) => JSON.stringify(
    { type: 'event_msg', payload: { type: 'agent_message', text: 'x'.repeat(120), i } })).join('\n');
  writeFileSync(big, [settings('gpt-5.6-terra'), filler, settings('gpt-5.3-codex-spark'),
    CODEX_LINE].join('\n'));
  try {
    assert.equal(codexLaneOf(big), 'spark');
  } finally { rmSync(big); }
});

test('a long rollout with a silent tail is classified from its head, not dropped', () => {
  // The rate_limits this scan wants sit at the tail, so the tail's own settings event wins when
  // there is one. But a silent tail is not "unknown": every real rollout names its model only
  // near the head, so a null-on-silent-tail rule would unclassify every long session and drop
  // it out of the poll entirely.
  const dir = mkdtempSync(join(tmpdir(), 'mr-longtail-'));
  const p = join(dir, 'rollout-2026-07-25-11111111-2222-3333-4444-555555555555.jsonl');
  const filler = JSON.stringify({ payload: { type: 'message', text: 'z'.repeat(500) } });
  writeFileSync(p, settings('gpt-5.6-sol') + '\n' + Array(2000).fill(filler).join('\n') + '\n');
  assert.ok(statSync(p).size > HEAD_BYTES);
  assert.equal(codexLaneOf(p), 'codex');
});

// --- oauth refresh -------------------------------------------------------------------------
// Lane B went dark for ~10h on 2026-07-25: its access token expired, and because a lane that
// reads `stale` gets no work routed to it, nothing ever ran to refresh the token. Deadlock.
const HOUR = 3_600_000;
const withOauth = (o: object) => JSON.stringify({ claudeAiOauth: o });
const restoreB = () => writeFileSync(process.env.MR_CRED_B!, cred);

test('an expired access token is refreshed and the rotated pair written back atomically', async () => {
  const now = 1_000_000_000_000;
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'dead', refreshToken: 'refresh-old', expiresAt: now - HOUR,
    refreshTokenExpiresAt: now + 30 * 24 * HOUR, subscriptionType: 'max',
  }), { mode: 0o600 });
  try {
    const db = openDb(':memory:');
    const seen: string[] = [];
    let refreshBody: any = null;
    const report = await pollAll(db, async (_u, token) => { seen.push(token); return USAGE; }, now,
      async (_url, body) => {
        refreshBody = body;
        return JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh-new', expires_in: 28800 });
      });
    assert.deepEqual(report.failed.filter(f => f.lane === 'A' || f.lane === 'B'), []);
    assert.deepEqual(seen, ['tok-123', 'fresh']); // A untouched, B refreshed before the usage call
    assert.equal(refreshBody.grant_type, 'refresh_token');
    assert.equal(refreshBody.refresh_token, 'refresh-old');
    const after = JSON.parse(readFileSync(process.env.MR_CRED_B!, 'utf8')).claudeAiOauth;
    // Rotation persisted: the old refresh token is dead server-side, so dropping it would lock
    // the account out until an interactive re-login.
    assert.equal(after.refreshToken, 'refresh-new');
    assert.equal(after.accessToken, 'fresh');
    assert.equal(after.expiresAt, now + 28_800_000);
    assert.equal(after.subscriptionType, 'max'); // untouched fields survive the rewrite
    assert.equal(statSync(process.env.MR_CRED_B!).mode & 0o777, 0o600);
    assert.equal(reauthNeeded('B', now), false);
  } finally { restoreB(); }
});

test('a dead refresh token fails the lane loudly and flags re-auth instead of reading as stale', async () => {
  const now = 1_000_000_000_000;
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'dead', refreshToken: 'also-dead', expiresAt: now - HOUR,
    refreshTokenExpiresAt: now - HOUR,
  }), { mode: 0o600 });
  try {
    const db = openDb(':memory:');
    const report = await pollAll(db, async () => USAGE, now, async () => {
      throw new Error('refresh must not be attempted with a dead refresh token');
    });
    const b = report.failed.find(f => f.lane === 'B')!;
    assert.match(b.error, /cannot be refreshed \(refresh token expired too\)/);
    assert.match(b.error, /claude \/login/);
    assert.equal(reauthNeeded('B', now), true);
    assert.equal(reauthNeeded('A', now), false); // A's credential has no expiry at all
    // The file is never touched on a failed refresh.
    assert.equal(JSON.parse(readFileSync(process.env.MR_CRED_B!, 'utf8')).claudeAiOauth.accessToken, 'dead');
  } finally { restoreB(); }
});

test('a token still inside the skew window is used as-is — no refresh call', async () => {
  const now = 1_000_000_000_000;
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'still-good', refreshToken: 'r', expiresAt: now + 10 * 60_000,
  }), { mode: 0o600 });
  try {
    const db = openDb(':memory:');
    const seen: string[] = [];
    await pollAll(db, async (_u, t) => { seen.push(t); return USAGE; }, now,
      async () => { throw new Error('refreshed a live token'); });
    assert.deepEqual(seen, ['tok-123', 'still-good']);
  } finally { restoreB(); }
});

test('lane A is never refreshed — its credentials have a live owner', async () => {
  const now = 1_000_000_000_000;
  const credA = readFileSync(process.env.MR_CRED_A!, 'utf8');
  // A's token is expired and perfectly refreshable. The poller must still refuse: this file
  // belongs to the Claude Code session running this code, which rotates it itself, and a second
  // writer spending that refresh token logs the user out of the account they are working in.
  writeFileSync(process.env.MR_CRED_A!, withOauth({
    accessToken: 'stale-A', refreshToken: 'refresh-A', expiresAt: now - HOUR,
    refreshTokenExpiresAt: now + 30 * 24 * HOUR,
  }), { mode: 0o600 });
  try {
    const db = openDb(':memory:');
    const report = await pollAll(db, async () => USAGE, now,
      async () => { throw new Error('lane A must not be refreshed'); });
    const a = report.failed.find(f => f.lane === 'A')!;
    assert.match(a.error, /belong to the Claude Code session/);
    assert.match(a.error, /claude \/login/);
    // Untouched: same refresh token, same access token, no rotation spent.
    const after = JSON.parse(readFileSync(process.env.MR_CRED_A!, 'utf8')).claudeAiOauth;
    assert.equal(after.refreshToken, 'refresh-A');
    assert.equal(after.accessToken, 'stale-A');
  } finally { writeFileSync(process.env.MR_CRED_A!, credA); }
});

test('a concurrent refresh holds the lock, and the loser re-reads instead of double-spending', async () => {
  const now = 1_000_000_000_000;
  const lock = `${process.env.MR_CRED_B!}.mr-refresh.lock`;
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'dead', refreshToken: 'refresh-old', expiresAt: now - HOUR,
    refreshTokenExpiresAt: now + 30 * 24 * HOUR,
  }), { mode: 0o600 });
  try {
    // Another poller is mid-refresh: it holds the lock and has not written back yet.
    writeFileSync(lock, '');
    const db = openDb(':memory:');
    const blocked = await pollAll(db, async () => USAGE, now,
      async () => { throw new Error('spent refresh-old while another process held it'); });
    assert.match(blocked.failed.find(f => f.lane === 'B')!.error, /another process is refreshing/);
    // That other poller now finishes and writes the rotated pair.
    writeFileSync(process.env.MR_CRED_B!, withOauth({
      accessToken: 'fresh', refreshToken: 'refresh-new', expiresAt: now + 8 * HOUR,
      refreshTokenExpiresAt: now + 30 * 24 * HOUR,
    }), { mode: 0o600 });
    rmSync(lock);
    const seen: string[] = [];
    const ok = await pollAll(db, async (_u, t) => { seen.push(t); return USAGE; }, now,
      async () => { throw new Error('refreshed again after the winner already did'); });
    assert.deepEqual(ok.failed.filter(f => f.lane === 'B'), []);
    assert.deepEqual(seen, ['tok-123', 'fresh']);
  } finally { rmSync(lock, { force: true }); restoreB(); }
});

test('a lock left behind by a crashed poller is broken after its TTL, not obeyed forever', async () => {
  const now = 1_000_000_000_000;
  const lock = `${process.env.MR_CRED_B!}.mr-refresh.lock`;
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'dead', refreshToken: 'refresh-old', expiresAt: now - HOUR,
    refreshTokenExpiresAt: now + 30 * 24 * HOUR,
  }), { mode: 0o600 });
  try {
    writeFileSync(lock, '');
    utimesSync(lock, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000)); // 10 min stale
    const db = openDb(':memory:');
    const report = await pollAll(db, async () => USAGE, now, async () =>
      JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh-new', expires_in: 28800 }));
    assert.deepEqual(report.failed.filter(f => f.lane === 'B'), []);
    assert.equal(
      JSON.parse(readFileSync(process.env.MR_CRED_B!, 'utf8')).claudeAiOauth.accessToken, 'fresh');
    assert.equal(existsSync(lock), false); // released, not leaked
  } finally { rmSync(lock, { force: true }); restoreB(); }
});

test('a refresh response with no expires_in drops the old expiry instead of refreshing forever', async () => {
  const now = 1_000_000_000_000;
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'dead', refreshToken: 'refresh-old', expiresAt: now - HOUR,
    refreshTokenExpiresAt: now + 30 * 24 * HOUR,
  }), { mode: 0o600 });
  try {
    const db = openDb(':memory:');
    let refreshes = 0;
    const refresh = async () => {
      refreshes++;
      return JSON.stringify({ access_token: `fresh-${refreshes}`, refresh_token: `rt-${refreshes}` });
    };
    await pollAll(db, async () => USAGE, now, refresh);
    // Keeping the old, already-past expiresAt made isExpired stay true, so every later poll
    // burned another rotation of the refresh token — the exact double-spend the lock guards.
    assert.equal('expiresAt' in JSON.parse(readFileSync(process.env.MR_CRED_B!, 'utf8')).claudeAiOauth,
      false);
    const seen: string[] = [];
    await pollAll(db, async (_u, t) => { seen.push(t); return USAGE; }, now + 60_000, refresh);
    assert.equal(refreshes, 1); // second poll used the token as-is
    assert.deepEqual(seen, ['tok-123', 'fresh-1']);
  } finally { restoreB(); }
});

test('writeFileAtomic never writes through a leftover temp file', async () => {
  const { writeFileAtomic } = await import('../src/atomic.js');
  const target = join(tmp, 'atomic-target');
  writeFileAtomic(target, 'first', 0o600);
  assert.equal(readFileSync(target, 'utf8'), 'first');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  // A killed run leaves temps behind; a recycled pid must not write into one (writeFileSync
  // into an existing path keeps THAT file's mode). Unique suffix + 'wx' means the name is never
  // reused, so the leftover is inert.
  writeFileSync(`${target}.mr-${process.pid}-deadbeef`, 'leftover', { mode: 0o666 });
  writeFileAtomic(target, 'second', 0o600);
  assert.equal(readFileSync(target, 'utf8'), 'second');
  assert.equal(statSync(target).mode & 0o777, 0o600);
  // Exactly the one temp we planted: every write renames its own away, so a reader never finds
  // a half-written sibling and nothing accumulates in a directory holding credentials.
  assert.deepEqual(readdirSync(tmp).filter(n => n.startsWith('atomic-target.mr-')),
    [`atomic-target.mr-${process.pid}-deadbeef`]);
});

test('a 401 on a token we believed live forces one refresh, not a lane dark forever', async () => {
  const now = 1_000_000_000_000;
  // The shape this exists for: a refresh that returned no expires_in. readToken deletes the
  // field rather than inventing one, so isExpired is false forever — the token is used until it
  // 401s, and before this there was nothing that reacted to the 401. Every poll failed, the
  // credential still looked healthy on disk (reauthNeeded false), and the dashboard said only
  // `stale`: lane B dark again, silently.
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'revoked', refreshToken: 'refresh-old',
    refreshTokenExpiresAt: now + 30 * 24 * HOUR,
  }), { mode: 0o600 });
  try {
    const db = openDb(':memory:');
    const seen: string[] = [];
    let refreshes = 0;
    const report = await pollAll(db, async (_u, token) => {
      seen.push(token);
      if (token === 'revoked') throw new Error('usage endpoint HTTP 401');
      return USAGE;
    }, now, async () => {
      refreshes++;
      return JSON.stringify({ access_token: 'fresh', refresh_token: 'refresh-new', expires_in: 28800 });
    });
    assert.equal(reauthNeeded('B', now), false); // never looked broken — that was the problem
    assert.ok(report.ok.includes('B'));
    assert.deepEqual(seen, ['tok-123', 'revoked', 'fresh']); // one retry, with the new token
    assert.equal(refreshes, 1);
    assert.equal(JSON.parse(readFileSync(process.env.MR_CRED_B!, 'utf8'))
      .claudeAiOauth.refreshToken, 'refresh-new');
  } finally { restoreB(); }
});

test('a non-401 failure is not retried, and lane A is never force-refreshed', async () => {
  const now = 1_000_000_000_000;
  writeFileSync(process.env.MR_CRED_B!, withOauth({
    accessToken: 'live', refreshToken: 'r', refreshTokenExpiresAt: now + 30 * 24 * HOUR,
  }), { mode: 0o600 });
  const credA = readFileSync(process.env.MR_CRED_A!, 'utf8');
  try {
    const db = openDb(':memory:');
    let calls = 0;
    // A 500 is the endpoint's problem, not the token's: retrying it spends a rotation for
    // nothing. And A's 401 must not rotate a live session's refresh token — the whole reason
    // lane A is read-only here.
    const report = await pollAll(db, async () => {
      calls++; throw new Error('usage endpoint HTTP 500');
    }, now, async () => { throw new Error('refreshed on a non-401'); });
    assert.equal(calls, 2); // one per lane, no retries
    assert.match(report.failed.find(f => f.lane === 'B')!.error, /HTTP 500/);

    // Now everything 401s. B is given no refresh token so it bows out before the refresher,
    // leaving a refresher that throws on ANY call as proof lane A never reached it.
    writeFileSync(process.env.MR_CRED_B!, withOauth({ accessToken: 'live' }), { mode: 0o600 });
    const a401 = await pollAll(db, async () => { throw new Error('usage endpoint HTTP 401'); },
      now, async () => { throw new Error('lane A must never be refreshed, forced or not'); });
    assert.match(a401.failed.find(f => f.lane === 'A')!.error, /HTTP 401/);
    assert.match(a401.failed.find(f => f.lane === 'B')!.error, /no refreshToken/);
    assert.equal(readFileSync(process.env.MR_CRED_A!, 'utf8'), credA); // untouched
  } finally { restoreB(); writeFileSync(process.env.MR_CRED_A!, credA); }
});

test('a fan-out on one lane cannot push the other lane\'s newest sample past the scan window (duel 391 M11)', async () => {
  // 2026-09-01: one web-research union wrote six concurrent rollouts; two such fan-outs push a
  // lane's newest sample past a GLOBAL 12-file window, and that lane reads stale from an older
  // file (or fails outright). Both orderings: spark flooding codex, codex flooding spark.
  const rateLine = (pct: number) => JSON.stringify({ payload: { info: { rate_limits: {
    limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: 1785270463 },
  } } } });
  const dir = join(tmp, 'sessions/2026/09/01');
  mkdirSync(dir, { recursive: true });
  const made: string[] = [];
  const write = (name: string, model: string, pct: number, mtimeMs: number) => {
    const p = join(dir, name);
    writeFileSync(p, settings(model) + '\n' + rateLine(pct) + '\n');
    utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
    made.push(p);
  };
  const base = 1_900_000_000_000; // newer than every other fixture in the directory
  const SPARK = 'gpt-5.3-codex-spark', CODEX = 'gpt-5.6-terra';
  try {
    for (const [flood, lone] of [[SPARK, CODEX], [CODEX, SPARK]]) {
      for (const p of made.splice(0)) rmSync(p);
      write('rollout-lone.jsonl', lone, 33, base);
      for (let i = 0; i < 13; i++) write(`rollout-flood-${i}.jsonl`, flood, 55, base + 1000 + i);
      const db = openDb(':memory:');
      const report = await pollAll(db, async () => USAGE, 999);
      assert.deepEqual(report.failed, [], `flood ${flood}`);
      const loneLane = lone === SPARK ? 'spark' : 'codex';
      const floodLane = lone === SPARK ? 'codex' : 'spark';
      assert.equal(latestSnapshot(db, loneLane)!.windows[0].utilization, 33, `${loneLane} lone sample`);
      assert.equal(latestSnapshot(db, floodLane)!.windows[0].utilization, 55, `${floodLane} flood sample`);
    }
  } finally { for (const p of made) rmSync(p, { force: true }); }
});
