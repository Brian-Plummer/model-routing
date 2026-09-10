import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The migration state this whole feature exists for: the main session is logged into the SAME
// account every aux dir holds (no ~/.claude-a yet), so offloadDir() throws and lane B must
// close loudly instead of silently billing the main account twice.
//
// Its own FILE because the fixture IS the environment: `src/paths.ts` reads MAIN_CONFIG and
// AUX_DIRS once at module load, and tests/mcp.test.ts pins MR_B_CONFIG_DIR for its whole suite
// — that pin is an early return in offloadDir(), so the resolver could never fail there. Env
// pins first, src imports after, per that file's dynamic-import style.
const home = mkdtempSync(join(tmpdir(), 'mr-unres-'));
const SAME_ACCOUNT = '11111111-2222-3333-4444-555555555555';
const conf = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.claude.json');
  writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: SAME_ACCOUNT } }));
  return path;
};
process.env.MR_DATA_DIR = mkdtempSync(join(tmpdir(), 'mr-unres-data-'));
process.env.MR_MAIN_CONFIG = conf(join(home, 'main'));
process.env.MR_AUX_A = join(home, 'aux-a'); conf(process.env.MR_AUX_A);
process.env.MR_AUX_B = join(home, 'aux-b'); conf(process.env.MR_AUX_B);
// No MR_B_CONFIG_DIR: the point is that the resolver actually runs and actually fails.
delete process.env.MR_B_CONFIG_DIR;

const { openDb } = await import('../src/db.js');
const { seedMatrix } = await import('../src/matrix.js');
const { storeSnapshot } = await import('../src/quota/poll.js');
const { createServer } = await import('../mcp/server.js');

// Minimal copy of tests/mcp.test.ts's connected(): duplicated on purpose — importing it would
// drag that file's suite-wide MR_B_CONFIG_DIR pin in with it, which is the one thing this
// suite must not have.
async function connected() {
  const db = openDb(':memory:');
  seedMatrix(db);
  const now = Date.now();
  // Every lane's quota is healthy — so a closed lane B here can only come from the resolver.
  for (const lane of ['A', 'B', 'codex'] as const) {
    storeSnapshot(db, { lane, fetchedAt: now, windows: [
      { windowMinutes: 300, utilization: 10, resetsAt: now + 3_600_000 },
      { windowMinutes: 10080, utilization: 10, resetsAt: now + 302_400_000 },
    ] });
  }
  const server = createServer(db, { proofRoots: { B: null, codex: null } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    return JSON.parse(res.content[0].text);
  };
}

test('route_task on an unresolvable offload closes lane B, says why, and ships no dir', async () => {
  const call = await connected();
  // implementation-misc homes its anthropic side on lane B and duels codex — with a healthy
  // quota everywhere, this is a duel on lane B unless the RESOLVER stops it.
  const d = await call('route_task', { kind: 'implementation-misc' });
  assert.ok(!d.sides.some((s: any) => s.lane === 'B'),
    `lane B must not route on an unresolvable offload, got ${JSON.stringify(d.sides)}`);
  // Not a duel either: the anthropic judge is lane-B fixed, so a duel routed now is
  // unjudgeable from creation.
  assert.equal(d.mode, 'single');
  // The reason must reach the caller — a silently downgraded route is the failure mode the
  // loud stop replaced.
  assert.match(d.notes.join(' | '), /no aux config dir differs/);
  // Nothing to hand a courier: no B side, no judges, and no dir that could be trusted.
  assert.ok(!('b_config_dir' in d), `expected no b_config_dir key, got ${JSON.stringify(d)}`);
});
