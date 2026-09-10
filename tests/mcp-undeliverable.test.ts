import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The misconfiguration mcp-unresolved.test.ts cannot reach: the resolver SUCCEEDS (the pin is
// an early return), but the resolved dir is one the claude-b courier's ConfigDir allowlist
// refuses — a tmp path here, /srv/claude-offload in the field. Before the deliverability gate,
// route_task shipped it, and every B side and every duel judge died on
// CLAUDE-B-FAILED: bad ConfigDir, after the duel row was already minted.
//
// Its own FILE — but not because the pin is load-time: MR_B_CONFIG_DIR is read per
// offloadDir() call, not at src/paths.js load. mcp.test.ts pins a DELIVERABLE dir as a
// suite-wide invariant (every route_task there proves the slashed spelling delivers), so the
// refused pin lives in its own process. MR_DATA_DIR above genuinely IS read at module load,
// hence the pins-before-dynamic-imports order this file shares with mcp-unresolved.test.ts.
process.env.MR_DATA_DIR = mkdtempSync(join(tmpdir(), 'mr-undeliv-data-'));
process.env.MR_B_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mr-undeliv-pin-'));

const { openDb } = await import('../src/db.js');
const { seedMatrix } = await import('../src/matrix.js');
const { storeSnapshot } = await import('../src/quota/poll.js');
const { createServer } = await import('../mcp/server.js');

// Minimal copy of tests/mcp.test.ts's connected(), duplicated for the same fixture-isolation
// reason as in mcp-unresolved.test.ts.
async function connected() {
  const db = openDb(':memory:');
  seedMatrix(db);
  const now = Date.now();
  // Every lane's quota is healthy — a closed lane B here can only come from the gate.
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

test('route_task on an undeliverable offload pin closes lane B, says why, ships no dir', async () => {
  const call = await connected();
  // implementation-misc homes its anthropic side on lane B and duels codex — with healthy
  // quota everywhere, this is a duel on lane B unless the deliverability gate stops it.
  const d = await call('route_task', { kind: 'implementation-misc' });
  assert.ok(!d.sides.some((s: any) => s.lane === 'B'),
    `lane B must not route on an undeliverable pin, got ${JSON.stringify(d.sides)}`);
  // Not a duel either: the anthropic judge is lane-B fixed and equally undeliverable.
  assert.equal(d.mode, 'single');
  // The reason must name the policy and the fix, not just fail.
  assert.match(d.notes.join(' | '), /not courier-deliverable/);
  assert.ok(!('b_config_dir' in d), `expected no b_config_dir key, got ${JSON.stringify(d)}`);
});
