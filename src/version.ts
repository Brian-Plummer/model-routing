import { readFileSync } from 'node:fs';

// Single source of truth — a hard-coded string had drifted three releases behind plugin.json,
// so the initialize handshake advertised a version predating the attestation fixes.
// It lives in src/ rather than mcp/ because the MCP handshake is no longer its only consumer:
// every duel row now records the build that minted it and the build that first recorded it, so
// the router, the recorder and the pending surface all read this. The two relative paths are
// unchanged by the move — dist/src/version.js sits exactly as deep as dist/mcp/server.js did.
export function pluginVersion(): string {
  // '../../' when running the build (dist/src/version.js), '../' when run from source.
  for (const rel of ['../../.claude-plugin/plugin.json', '../.claude-plugin/plugin.json']) {
    try {
      return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).version as string;
    } catch { /* try next */ }
  }
  return '0.0.0';
}
