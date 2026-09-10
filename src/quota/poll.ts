import {
  closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { writeFileAtomic } from '../atomic.js';
import type { Lane, LaneUsage } from '../types.js';
import {
  CODEX_SESSIONS, CRED_A, OAUTH_CLIENT_ID, OAUTH_TOKEN_URL, USAGE_URL, credB,
} from '../paths.js';
import { lastModelIn, parseAnthropicUsage, parseCodexRateLimits } from './parse.js';

export type Fetcher = (url: string, token: string) => Promise<string>;

// Newest-first candidates PER LANE when looking for codex-family rate_limits: a lane's scan
// stops at its first tail carrying rate_limits, or after this many of its own files. Per lane,
// not a global slice (duel 391 M11): one web-research union wrote six concurrent rollouts on
// one lane, and two such fan-outs pushed the other lane's newest sample past a global 12-file
// window — it read stale from an older file. The outer bound (4×) caps head reads on a
// directory that is nothing but one lane; each classification costs a 256 KiB head read.
export const CODEX_SCAN_LIMIT = 12;

export const httpFetch: Fetcher = async (url, token) => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`usage endpoint HTTP ${res.status}`);
  return res.text();
};

export type Refresher = (url: string, body: unknown) => Promise<string>;

export const httpRefresh: Refresher = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`oauth refresh HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
};

// Refresh a little before the wire expiry, not after: the token has to still be valid when the
// usage request lands, not when we read the file.
export const TOKEN_SKEW_MS = 60_000;

interface Oauth {
  accessToken?: string; refreshToken?: string;
  expiresAt?: number; refreshTokenExpiresAt?: number;
}
const oauthOf = (credPath: string): Oauth | null =>
  JSON.parse(readFileSync(credPath, 'utf8'))?.claudeAiOauth ?? null;
const isExpired = (o: Oauth, now: number): boolean =>
  typeof o.expiresAt === 'number' && o.expiresAt - now <= TOKEN_SKEW_MS;
const canRefresh = (o: Oauth, now: number): boolean => !!o.refreshToken
  && !(typeof o.refreshTokenExpiresAt === 'number' && o.refreshTokenExpiresAt <= now);

// The one state a human has to clear: token dead, refresh token dead too. Everything else the
// poller repairs itself, so this is the only auth condition worth its own line on the dashboard.
export function reauthNeeded(lane: Lane, now: number = Date.now()): boolean {
  try {
    // credB() can throw (unresolvable offload) — that needs the resolver's fix, not a /login,
    // so it must not light the RE-AUTH lamp.
    const credPath = lane === 'A' ? CRED_A : lane === 'B' ? credB() : null;
    if (credPath == null) return false;
    const o = oauthOf(credPath);
    return !!o && isExpired(o, now) && !canRefresh(o, now);
  } catch { return false; }
}

// A crashed poller must not lock the credential out of refreshing forever.
export const REFRESH_LOCK_TTL_MS = 60_000;

// Serialises refreshes of ONE credential file across processes. Without it, two sessions
// starting in the same second both read the same expired refresh token and both spend it: the
// loser gets a rotated-token error, and its write-back can land last and persist a refresh token
// the server has already retired. That is an interactive-re-login lockout, not a failed poll.
// A lockfile (open 'wx') rather than a mutex: the racing writers are separate processes.
function acquireRefreshLock(credPath: string, now: number): () => void {
  const lock = `${credPath}.mr-refresh.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      return () => { try { unlinkSync(lock); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let age = Infinity;
      try { age = now - statSync(lock).mtimeMs; } catch { /* vanished — retry the create */ }
      if (attempt === 0 && age > REFRESH_LOCK_TTL_MS) {
        try { unlinkSync(lock); } catch { /* another process beat us to it */ }
        continue;
      }
      throw new Error(`another process is refreshing ${credPath} — skipping this poll`);
    }
  }
  /* c8 ignore next */
  throw new Error(`could not acquire refresh lock for ${credPath}`);
}

// Access tokens last hours; a lane that has not run since its expired can never refresh itself,
// and the router will not send it work while it reads `stale` — the deadlock that kept lane B
// dark from 2026-07-25T07:15Z.
// `mayRefresh` is false for lane A on purpose: those credentials belong to the Claude Code
// session running this code, which refreshes them itself. A second writer rotating that refresh
// token can log the user out of the account they are actively working in, and lane A never had
// the deadlock this exists to fix — an unused A is an A with no session, and a session refreshes
// on start. Only B has no owner.
// `force` refreshes a token this code believes is live, and exists because that belief can be
// wrong in two ways the expiry field cannot express: the token was revoked server-side, or it was
// issued with no expires_in and so has no expiry to test at all. Both read as "fine" here and 401
// at the usage endpoint, forever — the silent dark lane this whole path exists to prevent. Only
// pollAll sets it, and only after seeing that 401.
async function readToken(
  credPath: string, refresh: Refresher, now: number, mayRefresh: boolean, force = false,
): Promise<string> {
  const read = (): { cred: any; o: Oauth } => {
    const cred = JSON.parse(readFileSync(credPath, 'utf8'));
    const o: Oauth | undefined = cred?.claudeAiOauth;
    if (!o?.accessToken) throw new Error(`no accessToken in ${credPath}`);
    return { cred, o };
  };
  const first = read();
  if (!force && !isExpired(first.o, now)) return first.o.accessToken!;
  // A forced refresh has no expiry to quote — the token is rejected, not expired.
  const when = force ? 'was rejected by the usage endpoint'
    : `expired ${new Date(first.o.expiresAt!).toISOString()}`;
  if (!mayRefresh) {
    throw new Error(`oauth token in ${credPath} ${when} — this lane's credentials belong to the `
      + `Claude Code session that owns them and it refreshes them itself; the poller must not `
      + `rotate a live session's token. Start a session on that account, or re-auth with: `
      + `CLAUDE_CONFIG_DIR=${dirname(credPath)} claude /login`);
  }
  if (!canRefresh(first.o, now)) {
    throw new Error(`oauth token in ${credPath} ${when} and cannot be refreshed `
      + `(${first.o.refreshToken ? 'refresh token expired too' : 'no refreshToken'}) — re-auth with: `
      + `CLAUDE_CONFIG_DIR=${dirname(credPath)} claude /login`);
  }
  const release = acquireRefreshLock(credPath, now);
  try {
    // Re-read under the lock: whoever held it may have just refreshed between our read and our
    // acquire, and spending our stale copy of the refresh token would retire the one they wrote.
    // Under `force` the expiry says nothing, so the test is whether the token on disk is still
    // the one that just 401'd.
    // ponytail: the only uncovered line here — the window needs two real processes, and the
    // suite is single-process. Delete it and every test still passes.
    const { cred, o } = read();
    if (force ? o.accessToken !== first.o.accessToken : !isExpired(o, now)) return o.accessToken!;
    const body = JSON.parse(await refresh(OAUTH_TOKEN_URL, {
      grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: OAUTH_CLIENT_ID,
    }));
    if (!body?.access_token) throw new Error(`oauth refresh for ${credPath} returned no access_token`);
    o.accessToken = body.access_token;
    // The refresh token rotates on use, so persisting the new one is not bookkeeping: the OLD one
    // is already dead server-side the moment this call succeeds, and losing the new one locks the
    // account out until an interactive re-login. Written to disk BEFORE the token is used.
    if (body.refresh_token) o.refreshToken = body.refresh_token;
    // No expires_in means we do not know when this token dies — and keeping the OLD, already-past
    // expiry made isExpired stay true forever, so every poll burned another rotation. Dropping
    // the field says "unknown": the token is used until it 401s, which pollAll turns into a
    // forced refresh. No invented expiry stands in for the one the server did not send.
    if (typeof body.expires_in === 'number') o.expiresAt = now + body.expires_in * 1000;
    else delete o.expiresAt;
    // Atomic, because a torn write here is an unrecoverable lockout rather than a bad poll, and
    // 0600 because it holds live tokens.
    writeFileAtomic(credPath, JSON.stringify(cred, null, 2), 0o600);
    return o.accessToken!;
  } finally { release(); }
}

export function sessionFilesNewestFirst(root: string = CODEX_SESSIONS): Array<{ path: string; mtime: number }> {
  const candidates: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try { candidates.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* raced */ }
      }
    }
  };
  walk(root);
  return candidates.sort((a, b) => b.mtime - a.mtime);
}

export const HEAD_BYTES = 262_144;

export function headFile(path: string, bytes = HEAD_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(bytes, fstatSync(fd).size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

// Which codex-family pool a rollout bills to. `rate_limits.limit_id` is "codex" for spark runs
// too, so the model is the only reliable discriminator; codex writes it in the
// `thread_settings_applied` / `turn_context` events near the head of the file. Unknown shape →
// null, and the caller skips the file rather than guessing (a wrong guess overwrites the other
// lane's pool). Nothing is inferred from loose text: a flat-regex fallback read `"model":"gpt-…"`
// out of any pasted config or quoted file in a user message and classified the run from it.
export function codexLaneOf(path: string): Lane | null {
  let model: string | undefined;
  try {
    model = lastModelIn(headFile(path));
    // A long session's `/model` switch lands past the head slice, and the rate_limits this file
    // is scanned for sit at the tail — i.e. after the switch. So the tail's own settings event
    // wins when there is one. A silent tail is not "unknown": every real rollout names its model
    // only near the head, so falling back to it keeps 91/91 live files classified rather than
    // dropping every long session out of the poll.
    // ponytail: a switch in the untouched middle is still invisible; stream the file if that bites.
    if (statSync(path).size > HEAD_BYTES) model = lastModelIn(tailFile(path)) ?? model;
  } catch { return null; }
  if (!model) return null;
  return model.includes('spark') ? 'spark' : 'codex';
}

export function tailFile(path: string, bytes = HEAD_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

export function storeSnapshot(db: DatabaseSync, usage: LaneUsage): void {
  db.prepare('INSERT INTO quota_snapshots(lane, fetched_at, payload) VALUES (?,?,?)')
    .run(usage.lane, usage.fetchedAt, JSON.stringify(usage));
}

export function latestSnapshot(db: DatabaseSync, lane: Lane): LaneUsage | null {
  const row = db.prepare(
    // id DESC breaks fetched_at ties deterministically — concurrent pollers writing the same
    // millisecond could otherwise flip a lane between open and closed at random.
    'SELECT payload FROM quota_snapshots WHERE lane=? ORDER BY fetched_at DESC, id DESC LIMIT 1',
  ).get(lane) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as LaneUsage : null;
}

export interface PollReport { ok: Lane[]; failed: Array<{ lane: Lane; error: string }> }

export async function pollAll(
  db: DatabaseSync, fetcher: Fetcher = httpFetch, now: number = Date.now(),
  refresh: Refresher = httpRefresh,
): Promise<PollReport> {
  const report: PollReport = { ok: [], failed: [] };
  const anthropic: Array<[Lane, () => string]> = [['A', () => CRED_A], ['B', credB]];
  for (const [lane, credPathOf] of anthropic) {
    try {
      const credPath = credPathOf();
      // Lane A is read-only here — see readToken: A's credentials have a live owner.
      const mayRefresh = lane === 'B';
      const token = (force: boolean) => readToken(credPath, refresh, now, mayRefresh, force);
      let body: string;
      try { body = await fetcher(USAGE_URL, await token(false)); }
      catch (e) {
        // A 401 means the token we believed live is dead — revoked, or issued with no expires_in
        // so there is no expiry that could have told us. Without this one retry the lane 401s on
        // every poll forever and reports plain `stale`, with reauthNeeded false because the
        // credential still looks fine on disk: exactly the silent outage the refresh path exists
        // to end, reached through a different door.
        if (!mayRefresh || !/\b401\b/.test(String(e))) throw e;
        body = await fetcher(USAGE_URL, await token(true));
      }
      storeSnapshot(db, parseAnthropicUsage(body, lane, now));
      report.ok.push(lane);
    } catch (e) { report.failed.push({ lane, error: String(e) }); }
  }
  // Newest BILLED rollout per codex-family lane wins. Spark is metered too — its own
  // model-specific pool (duel 268 died on usage_limit_exceeded while the engine, still on the
  // 2026-07-25 "unmetered" assumption, reported the lane open) — so one scan samples BOTH
  // lanes. Classification stays by model, never `limit_id`: a spark tail reports
  // `limit_id: "codex"` too, and reading it blind would overwrite the codex snapshot
  // with spark's pool.
  try {
    const files = sessionFilesNewestFirst();
    if (files.length === 0) throw new Error('no codex session files');
    const missing = new Set<Lane>(['codex', 'spark']);
    const tried: Partial<Record<Lane, number>> = {};
    for (const f of files.slice(0, CODEX_SCAN_LIMIT * 4)) {
      if (missing.size === 0) break;
      const fileLane = codexLaneOf(f.path);
      if (fileLane === null || !missing.has(fileLane)) continue;
      if ((tried[fileLane] = (tried[fileLane] ?? 0) + 1) > CODEX_SCAN_LIMIT) continue;
      // fetchedAt comes from the file's mtime, not the clock: re-stamping old data as fresh
      // let a stale 'closed' reading survive forever, locking the lane out of routing and so
      // preventing the newer run that would have cleared it.
      const rows = parseCodexRateLimits(tailFile(f.path), f.mtime, fileLane);
      if (rows.length === 0) continue; // rollout with no rate_limits at all — keep looking
      for (const u of rows) storeSnapshot(db, u);
      missing.delete(fileLane);
      report.ok.push(fileLane);
    }
    for (const l of missing) {
      report.failed.push({ lane: l, error: `no ${l} rate_limits in scanned session tails` });
    }
  } catch (e) {
    for (const l of ['codex', 'spark'] as Lane[]) report.failed.push({ lane: l, error: String(e) });
  }
  return report;
}
