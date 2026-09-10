import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const env = process.env;
export const DATA_DIR = env.MR_DATA_DIR ?? join(homedir(), '.local/share/model-routing');
export const DB_PATH = env.MR_DB_PATH ?? join(DATA_DIR, 'mr.db');
// Reports accrue in the plugin repo itself (operator, 2026-08-11), not the data dir: this file
// runs as dist/src/paths.js, so the repo root is two levels up from here.
export const REPORTS_DIR = env.MR_REPORTS_DIR
  ?? fileURLToPath(new URL('../../Session reports', import.meta.url));
export const CRED_A = env.MR_CRED_A ?? join(homedir(), '.claude/.credentials.json');
export const CODEX_SESSIONS = env.MR_CODEX_SESSIONS ?? join(homedir(), '.codex/sessions');
export const A_PROJECTS = env.MR_A_PROJECTS ?? join(homedir(), '.claude/projects');
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Claude Code's OAuth client. A PKCE public client, so the id is not a secret — but it is a
// value we do not control, hence the env override: a rotation must not need a plugin release.
export const OAUTH_TOKEN_URL = env.MR_OAUTH_TOKEN_URL ?? 'https://console.anthropic.com/v1/oauth/token';
export const OAUTH_CLIENT_ID = env.MR_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Claude Code keeps the default profile's config json in $HOME itself, not inside ~/.claude/.
export const MAIN_CONFIG = env.MR_MAIN_CONFIG ?? join(homedir(), '.claude.json');
export const AUX_DIRS = [
  env.MR_AUX_A ?? join(homedir(), '.claude-a'),
  env.MR_AUX_B ?? join(homedir(), '.claude-b'),
];

const accountUuid = (configJson: string): string => {
  const u = JSON.parse(readFileSync(configJson, 'utf8'))?.oauthAccount?.accountUuid;
  if (typeof u !== 'string' || u === '') throw new Error(`no oauthAccount.accountUuid in ${configJson}`);
  return u;
};

// Trailing slashes die at the single resolution point: `$HOME/.claude-b/` names the same dir
// engine-side, but the courier matches its ConfigDir header LITERALLY and refuses the spelling
// — so an uncanonicalized pin would pass the gate and then kill every B side and judge on
// CLAUDE-B-FAILED, after the duel row was minted. Canonical out of the resolver means the
// value the gate judges IS the value the courier receives.
// Exported for scrubIdentity: the scrub canonicalizes its env pins the same way, so every
// spelling of a pinned root (slashed pin, bare-dir echo) matches one rule.
export const canonDir = (d: string): string => d.replace(/\/+$/, '') || '/';

// The offload dir is whichever aux config dir holds the account that is NOT the main session's.
// Resolved on every call — no cache, no symlink — so a stale choice cannot outlive a re-login.
// Fails loud rather than guessing: a wrong guess bills the main account twice, silently.
export function offloadDir(opts: { mainConfig?: string; auxDirs?: string[] } = {}): string {
  if (env.MR_B_CONFIG_DIR) return canonDir(env.MR_B_CONFIG_DIR);
  const mainConfig = opts.mainConfig ?? MAIN_CONFIG;
  const main = accountUuid(mainConfig);
  const differing: string[] = [];
  const errors: string[] = [];
  for (const dir of opts.auxDirs ?? AUX_DIRS) {
    try {
      if (accountUuid(join(dir, '.claude.json')) !== main) differing.push(dir);
    } catch (e) { errors.push(String(e)); }
  }
  if (differing.length === 1) return canonDir(differing[0]);
  if (differing.length === 0) {
    throw new Error(`no aux config dir differs from the main session's account (${mainConfig}) — `
      + `log an aux dir into the other account: CLAUDE_CONFIG_DIR=<dir> claude /login`
      + (errors.length ? ` [${errors.join('; ')}]` : ''));
  }
  throw new Error(`ambiguous offload: the main session's account matches neither `
    + `${differing.join(' nor ')} — refusing to guess which account to bill`);
}

// The claude-b courier's ConfigDir allowlist, mirrored (authority: agents/claude-b.md — no
// quote characters, absolute, parent EXACTLY $HOME, leaf `.claude-` + letters/digits/_/-).
// The courier hard-refuses anything else and never falls back, so a resolved dir outside this
// domain is unroutable: routing checks HERE, before minting duels whose B sides and judges can
// only die on CLAUDE-B-FAILED. offloadDir() itself stays permissive on purpose — quota polls
// and proof reads work on any pin; only the courier hop has this shape. Returns why, or null
// when deliverable. Keep in lockstep with the agent text: this predicate is the engine's copy
// of that allowlist, not a second policy — so it judges the STRING the way the courier judges
// the header. dirname/basename tolerated spellings the courier refuses (`$HOME/.claude-b/`
// passed here, died there); the check is now literal. A slashed pin still delivers because
// offloadDir canonicalizes before anything is gated or forwarded.
export const courierUndeliverable = (dir: string, home: string = homedir()): string | null => {
  if (/['"]/.test(dir)) return `quote character in ${dir}`;
  const leaf = dir.startsWith(home + '/') ? dir.slice(home.length + 1) : null;
  if (leaf === null || !/^\.claude-[A-Za-z0-9_-]+$/.test(leaf))
    return `${dir} is not an absolute $HOME/.claude-<suffix> path`;
  return null;
};

export const credB = (): string => env.MR_CRED_B ?? join(offloadDir(), '.credentials.json');
export const bProjects = (): string => env.MR_B_PROJECTS ?? join(offloadDir(), 'projects');
