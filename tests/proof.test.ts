import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createDuel, recordResults, recordJudgment, hasRunEvidence, expireStaleDuels } from '../src/duel.js';
import { pluginVersion } from '../src/version.js';
import type { Side } from '../src/types.js';

const SIDES: [Side, Side] = [
  { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
  { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
];
// Real session ids are uuid-shaped; PROOF_RE rejects anything short or generic.
const B_ID = '6d15b6ee-23c1-48a2-b51c-1836bf431724';
const C_ID = '019f959a-1ac1-7bf3-a0d5-c30f463dde69';
const ok = (tokens: number, proof: string) =>
  ({ output: 'out', tokens, latencyMs: 100, failed: false, proof });
const FAILED = { output: null, tokens: null, latencyMs: null, failed: true };

// Roots with one fresh session file each, like a real lane run leaves behind.
function freshRoots() {
  const base = mkdtempSync(join(tmpdir(), 'mr-proof-'));
  const B = join(base, 'b-projects'); const codex = join(base, 'codex-sessions');
  mkdirSync(join(B, 'proj'), { recursive: true });
  mkdirSync(join(codex, '2026/07/24'), { recursive: true });
  writeFileSync(join(B, 'proj', `${B_ID}.jsonl`), '{}');
  writeFileSync(join(codex, '2026/07/24', `rollout-2026-07-24T15-28-52-${C_ID}.jsonl`), '{}');
  return { B, codex };
}

const assistantAttestation = (model: string, effort: string) => [
  'not json',
  JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4' }, effort: 'low' }),
  JSON.stringify({ type: 'assistant', message: { model }, effort }),
  '',
].join('\n');

const turnContextAttestation = (model: string, effort: string) => [
  '{junk',
  JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'medium' } }),
  JSON.stringify({ type: 'turn_context', payload: { model, effort } }),
  '',
].join('\n');

const writeBIdentity = (roots: ReturnType<typeof freshRoots>, proof: string,
  model: string, effort: string) =>
  writeFileSync(join(roots.B, 'proj', `${proof}.jsonl`), assistantAttestation(model, effort));

const writeCodexIdentity = (roots: ReturnType<typeof freshRoots>, proof: string,
  model: string, effort: string) =>
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${proof}.jsonl`),
    turnContextAttestation(model, effort));

const newDuel = (db: any, at = 1) =>
  createDuel(db, 'implementation-misc', SIDES, { mutating: false, spotCheck: false }, at);

test('serena calls are attested from the proof artifact (duel 409)', () => {
  const writeBSerenaFixture = (roots: ReturnType<typeof freshRoots>,
    contentArrays: any[][], extraRawLines: string[] = []) => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5' }, effort: 'high' }),
      ...contentArrays.map(content => JSON.stringify({
        type: 'assistant', message: { model: 'claude-sonnet-5', content },
      })),
      ...extraRawLines,
    ];
    writeFileSync(join(roots.B, 'proj', B_ID + '.jsonl'), lines.join('\n') + '\n');
  };
  const codexProof = '019f959a-4090-7bf3-a0d5-c30f463dd409';
  const rows: Array<{
    name: string;
    setup: (roots: ReturnType<typeof freshRoots>) => Parameters<typeof recordResults>[2];
    expected: object;
    stored: { anth_serena_calls: number | null; gpt_serena_calls: number | null };
    replay?: boolean;
  }> = [
    {
      name: 'counts tool_use blocks across turns and both server prefixes, never mentions',
      setup: roots => {
        writeBSerenaFixture(roots, [
          [{ type: 'tool_use', name: 'mcp__serena__get_symbols_overview', input: {} },
            { type: 'tool_use', name: 'Bash', input: {} }],
          [{ type: 'text', text: 'ran mcp__serena__find_symbol' },
            { type: 'tool_use', name: 'mcp__serena-lsp__find_referencing_symbols', input: {} }],
        ], [JSON.stringify({ type: 'user', message: { content: [
          { type: 'tool_result', content: '"name":"mcp__serena__find_symbol"' },
        ] } })]);
        return { anthropic: ok(500, B_ID), openai: FAILED };
      },
      expected: { status: 'walkover', winner: 'anthropic', serena_calls: { anthropic: 2 } },
      stored: { anth_serena_calls: 2, gpt_serena_calls: null },
    },
    {
      name: 'a tool-bearing session with no serena call attests 0, not null',
      setup: roots => {
        writeBSerenaFixture(roots,
          [[{ type: 'tool_use', name: 'Bash', input: {} }]]);
        return { anthropic: ok(500, B_ID), openai: FAILED };
      },
      expected: { status: 'walkover', winner: 'anthropic', serena_calls: { anthropic: 0 } },
      stored: { anth_serena_calls: 0, gpt_serena_calls: null },
    },
    {
      name: 'sub-agent transcripts beside the session count toward the side; model stays the parent\'s (duel 257: six on B)',
      setup: roots => {
        writeBSerenaFixture(roots, [[{ type: 'tool_use', name: 'Bash', input: {} }]]);
        const sub = join(roots.B, 'proj', B_ID, 'subagents');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'agent-a1.jsonl'), JSON.stringify({ type: 'assistant', message: {
          model: 'claude-haiku-4-5', content: [
            { type: 'tool_use', name: 'mcp__serena__find_symbol', input: {} },
            { type: 'tool_use', name: 'mcp__serena-lsp__find_referencing_symbols', input: {} }] } }) + '\n');
        writeFileSync(join(sub, 'agent-a2.jsonl'), JSON.stringify({ type: 'assistant', message: {
          model: 'claude-haiku-4-5', content: [{ type: 'tool_use', name: 'Read', input: {} }] } }) + '\n');
        writeFileSync(join(sub, 'notes.txt'), 'not a transcript\n');
        return { anthropic: ok(500, B_ID), openai: FAILED };
      },
      expected: { status: 'walkover', winner: 'anthropic', serena_calls: { anthropic: 2 } },
      stored: { anth_serena_calls: 2, gpt_serena_calls: null },
    },
    {
      name: 'a parent with no tool-bearing turn still attests its sub-agents\' calls',
      setup: roots => {
        writeBIdentity(roots, B_ID, 'claude-sonnet-5', 'high');
        const sub = join(roots.B, 'proj', B_ID, 'subagents');
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, 'agent-a1.jsonl'), JSON.stringify({ type: 'assistant', message: {
          model: 'claude-sonnet-5', content: [{ type: 'tool_use', name: 'mcp__serena__get_symbols_overview', input: {} }] } }) + '\n');
        return { anthropic: ok(500, B_ID), openai: FAILED };
      },
      expected: { status: 'walkover', winner: 'anthropic', serena_calls: { anthropic: 1 } },
      stored: { anth_serena_calls: 1, gpt_serena_calls: null },
    },
    {
      name: 'an artifact with no tool-bearing turn attests null and the reply carries no key',
      setup: roots => {
        writeBIdentity(roots, B_ID, 'claude-sonnet-5', 'high');
        return { anthropic: ok(500, B_ID), openai: FAILED };
      },
      expected: { status: 'walkover', winner: 'anthropic' },
      stored: { anth_serena_calls: null, gpt_serena_calls: null },
    },
    {
      name: 'a codex-family artifact attests null',
      setup: roots => {
        writeCodexIdentity(roots, codexProof, 'gpt-5.6-terra', 'high');
        return { anthropic: FAILED, openai: ok(900, codexProof) };
      },
      expected: { status: 'walkover', winner: 'openai' },
      stored: { anth_serena_calls: null, gpt_serena_calls: null },
    },
    {
      name: 'replay derives from the row, never the artifact',
      setup: roots => {
        writeBSerenaFixture(roots, [
          [{ type: 'tool_use', name: 'mcp__serena__get_symbols_overview', input: {} },
            { type: 'tool_use', name: 'Bash', input: {} }],
          [{ type: 'text', text: 'ran mcp__serena__find_symbol' },
            { type: 'tool_use', name: 'mcp__serena-lsp__find_referencing_symbols', input: {} }],
        ], [JSON.stringify({ type: 'user', message: { content: [
          { type: 'tool_result', content: '"name":"mcp__serena__find_symbol"' },
        ] } })]);
        return { anthropic: ok(500, B_ID), openai: FAILED };
      },
      expected: { status: 'walkover', winner: 'anthropic', serena_calls: { anthropic: 2 } },
      stored: { anth_serena_calls: 2, gpt_serena_calls: null },
      replay: true,
    },
  ];

  for (const row of rows) {
    const db = openDb(':memory:');
    const roots = freshRoots();
    const results = row.setup(roots);
    const id = newDuel(db);
    const reply = recordResults(db, id, results, { roots });
    assert.deepEqual(reply, row.expected, row.name);
    const stored: any = db.prepare(
      'SELECT anth_serena_calls, gpt_serena_calls FROM duels WHERE id=?').get(id);
    assert.deepEqual({ ...stored }, row.stored, row.name);

    if (row.replay) {
      writeBSerenaFixture(roots, []);
      assert.deepEqual(recordResults(db, id, results, { roots }), reply, row.name);
      const replayed: any = db.prepare(
        'SELECT anth_serena_calls FROM duels WHERE id=?').get(id);
      assert.equal(replayed.anth_serena_calls, 2, row.name);
    }
    db.close();
  }
});

test('judge serena calls are attested from the judge artifact (duel 409)', () => {
  const roots = freshRoots();
  const db = openDb(':memory:');
  const id = newDuel(db);
  recordResults(db, id,
    { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });

  const anthropicProof = 'f1e2d3c4-b5a6-4789-9012-3456789ab409';
  writeFileSync(join(roots.B, 'proj', anthropicProof + '.jsonl'), [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' }, effort: 'xhigh' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [
      { type: 'tool_use', name: 'mcp__serena__find_symbol', input: {} },
    ] } }),
  ].join('\n') + '\n');
  assert.deepEqual(
    recordJudgment(db, id, 'anthropic', 'X', 2, { proof: anthropicProof, roots }),
    { status: 'awaiting_judgment', judge_serena_calls: 1 });
  const anthropicStored: any = db.prepare(`SELECT judge_serena_calls FROM judgments
    WHERE duel_id=? AND judge_vendor='anthropic'`).get(id);
  assert.equal(anthropicStored.judge_serena_calls, 1);

  const openaiProof = '019f959a-4091-7bf3-a0d5-c30f463dd409';
  writeCodexIdentity(roots, openaiProof, 'gpt-5.6-sol', 'xhigh');
  const reply = recordJudgment(db, id, 'openai', 'X', 3, { proof: openaiProof, roots });
  assert.equal('judge_serena_calls' in reply, false);
  const openaiStored: any = db.prepare(`SELECT judge_serena_calls FROM judgments
    WHERE duel_id=? AND judge_vendor='openai'`).get(id);
  assert.equal(openaiStored.judge_serena_calls, null);
  db.close();
});

const MATCHING_IDENTITY_ROWS: Array<{
  name: string; side: Side; proof: string; attestedModel: string; attestedEffort: string;
}> = [
  { name: 'lane B sonnet prefix',
    side: { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'high' },
    proof: B_ID, attestedModel: 'claude-sonnet-5', attestedEffort: 'high' },
  { name: 'codex exact slug',
    side: { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
    proof: '019f959a-6666-7bf3-a0d5-c30f463dd006',
    attestedModel: 'gpt-5.6-sol', attestedEffort: 'xhigh' },
  { name: 'spark exact slug',
    side: { vendor: 'openai', lane: 'spark', model: 'gpt-5.3-codex-spark', effort: 'low' },
    proof: '019f959a-7777-7bf3-a0d5-c30f463dd007',
    attestedModel: 'gpt-5.3-codex-spark', attestedEffort: 'low' },
];

for (const row of MATCHING_IDENTITY_ROWS) {
  test(`matching proof identity lands and replays without reopening: ${row.name}`, () => {
    const db = openDb(':memory:');
    const roots = freshRoots();
    const anthropic: Side = row.side.vendor === 'anthropic' ? row.side
      : { vendor: 'anthropic', lane: 'A', model: 'opus', effort: 'high' };
    const openai: Side = row.side.vendor === 'openai' ? row.side : SIDES[1];
    const sides: [Side, Side] = [anthropic, openai];
    if (row.side.vendor === 'anthropic') {
      writeBIdentity(roots, row.proof, row.attestedModel, row.attestedEffort);
    } else {
      writeCodexIdentity(roots, row.proof, row.attestedModel, row.attestedEffort);
    }
    const id = createDuel(db, 'identity-table', sides,
      { mutating: false, spotCheck: false }, 1);
    const results = row.side.vendor === 'anthropic'
      ? { anthropic: ok(500, row.proof), openai: FAILED }
      : { anthropic: FAILED, openai: ok(500, row.proof) };

    const first: any = recordResults(db, id, results, { roots });

    assert.deepEqual(first, { status: 'walkover', winner: row.side.vendor });
    const stored: any = db.prepare('SELECT * FROM duels WHERE id=?').get(id);
    const stem = row.side.vendor === 'anthropic' ? 'anth' : 'gpt';
    assert.equal(stored[`${stem}_model_attested`], row.attestedModel);
    assert.equal(stored[`${stem}_effort_attested`], row.attestedEffort);

    // Landed-side replay is ledger-derived even after the source artifact becomes contradictory.
    if (row.side.vendor === 'anthropic') {
      writeBIdentity(roots, row.proof, 'claude-opus-4-1', row.attestedEffort);
    } else {
      writeCodexIdentity(roots, row.proof, 'gpt-0-wrong', row.attestedEffort);
    }
    assert.deepEqual(recordResults(db, id, results, { roots }), first);
  });
}

test('a first-recording lane-B model mismatch refuses and names expected and attested', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  writeBIdentity(roots, B_ID, 'claude-sonnet-5', 'high');
  const sides: [Side, Side] = [
    { vendor: 'anthropic', lane: 'B', model: 'opus', effort: 'high' },
    SIDES[1],
  ];
  const id = createDuel(db, 'implementation-misc', sides,
    { mutating: false, spotCheck: false }, 1);

  assert.throws(() => recordResults(db, id,
    { anthropic: ok(500, B_ID), openai: FAILED }, { roots }),
  /expected model "opus".*attested "claude-sonnet-5"/);
  assert.equal((db.prepare('SELECT status FROM duels WHERE id=?').get(id) as any).status, 'routed');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM proof_claims').get() as any).c, 0);
});

test('effort mismatch lands, stores telemetry, flags the reply, and replays without re-attesting', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  writeBIdentity(roots, B_ID, 'claude-sonnet-5', 'high');
  const sides: [Side, Side] = [
    { vendor: 'anthropic', lane: 'B', model: 'sonnet', effort: 'medium' },
    SIDES[1],
  ];
  const id = createDuel(db, 'implementation-misc', sides,
    { mutating: false, spotCheck: false }, 1);

  const first: any = recordResults(db, id,
    { anthropic: ok(500, B_ID), openai: FAILED }, { roots });

  assert.deepEqual(first,
    { status: 'walkover', winner: 'anthropic', effort_mismatch: ['anthropic'] });
  const row: any = db.prepare(
    'SELECT anth_model_attested, anth_effort_attested FROM duels WHERE id=?').get(id);
  assert.deepEqual({ ...row },
    { anth_model_attested: 'claude-sonnet-5', anth_effort_attested: 'high' });

  // A landed-side replay derives telemetry from the row; the now-wrong artifact is never opened.
  writeBIdentity(roots, B_ID, 'claude-opus-4-1', 'medium');
  const replay: any = recordResults(db, id,
    { anthropic: ok(500, B_ID), openai: FAILED }, { roots });
  assert.deepEqual(replay, first);
});

test('both sides attested by their own fresh session files → awaiting_judgment', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const id = newDuel(db);
  const res: any = recordResults(db, id,
    { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });
  assert.equal(res.status, 'awaiting_judgment');
  assert.equal('effort_mismatch' in res, false);
  const row: any = db.prepare(`SELECT anth_proof, gpt_proof, anth_model_attested,
    anth_effort_attested, gpt_model_attested, gpt_effort_attested FROM duels WHERE id=?`).get(id);
  assert.equal(row.anth_proof, B_ID);
  assert.equal(row.gpt_proof, C_ID);
  assert.deepEqual([
    row.anth_model_attested, row.anth_effort_attested,
    row.gpt_model_attested, row.gpt_effort_attested,
  ], [null, null, null, null]);
});

test('proof is mandatory for B/codex sides — an unrelated fresh run must not attest', () => {
  const db = openDb(':memory:');
  const roots = freshRoots(); // files exist and are fresh, but belong to some other run
  const id = newDuel(db);
  assert.throws(
    () => recordResults(db, id,
      { anthropic: { output: 'a', tokens: 500, latencyMs: 1, failed: false },
        openai: ok(900, C_ID) }, { roots }),
    /B-lane side has no usable proof/);
  assert.equal((db.prepare('SELECT status FROM duels WHERE id=?').get(id) as any).status, 'routed');
});

test('a short or generic proof string is not a session id', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  for (const bogus of ['jsonl', 'session', 'b-1111']) {
    const id = newDuel(db);
    assert.throws(() => recordResults(db, id,
      { anthropic: ok(500, bogus), openai: ok(900, C_ID) }, { roots }),
      /no usable proof/);
  }
});

test('proof id must match the session filename', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const id = newDuel(db);
  assert.throws(
    () => recordResults(db, id,
      { anthropic: ok(500, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), openai: ok(900, C_ID) },
      { roots }),
    /unattested B-lane side/s);
});

test('one session id cannot attest two duels', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const first = newDuel(db);
  recordResults(db, first, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });

  const second = newDuel(db);
  assert.throws(
    () => recordResults(db, second, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots }),
    /already used to attest duel/);
});

test('no session file since duel creation → unattested, duel stays routed and re-recordable', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  // duel "created" an hour in the future — every existing file is too old
  const id = newDuel(db, Date.now() + 3_600_000);
  assert.throws(
    () => recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots }),
    /unattested B-lane side/);
  assert.equal((db.prepare('SELECT status FROM duels WHERE id=?').get(id) as any).status, 'routed');
});

test('missing root dir → unattested', () => {
  const db = openDb(':memory:');
  const id = newDuel(db);
  assert.throws(
    () => recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) },
      { roots: { B: '/nonexistent-mr-test', codex: '/nonexistent-mr-test' } }),
    /unattested B-lane side/);
});

test('implausible metrics are rejected for a non-failed side', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const bad = (over: object) =>
    ({ output: 'a', tokens: 500, latencyMs: 100, failed: false, proof: B_ID, ...over });
  const cases: Array<[object, RegExp]> = [
    [{ tokens: null }, /tokens=null/],
    [{ tokens: 0 }, /tokens=0/],          // 0 used to pass, then won the token tiebreak outright
    [{ tokens: -5 }, /tokens=-5/],
    [{ latencyMs: 0 }, /latency_ms=0/],
    [{ latencyMs: -1 }, /latency_ms=-1/],
    [{ output: '' }, /has no output/],
    [{ output: '   ' }, /has no output/],
  ];
  for (const [over, re] of cases) {
    const id = newDuel(db);
    assert.throws(() => recordResults(db, id,
      { anthropic: bad(over), openai: ok(900, C_ID) }, { roots }), re);
  }
});

test('failed side needs no attestation — walkover for attested survivor', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const id = newDuel(db);
  const res = recordResults(db, id, { anthropic: FAILED, openai: ok(900, C_ID) }, { roots });
  assert.deepEqual(res, { status: 'walkover', winner: 'openai' });
});

test('lane A side needs no external attestation', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const aSides: [Side, Side] = [
    { vendor: 'anthropic', lane: 'A', model: 'haiku', effort: 'low' },
    { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-terra', effort: 'low' },
  ];
  const id = createDuel(db, 'bulk-mechanical', aSides, { mutating: false, spotCheck: false }, 1);
  const res = recordResults(db, id,
    { anthropic: { output: 'a', tokens: 500, latencyMs: 1, failed: false }, openai: ok(900, C_ID) },
    { roots });
  assert.equal(res.status, 'awaiting_judgment');
});

test('recording twice is idempotent — the same packet comes back, not an error', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const id = newDuel(db);
  const first = recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });
  const again = recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });
  assert.deepEqual(again, first);
});

test('a filename fragment is not a proof — canonical ids match by equality', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  // 17 chars, so it clears PROOF_RE, and it is a substring of every rollout written that day
  const id = newDuel(db);
  assert.throws(() => recordResults(db, id,
    { anthropic: ok(500, B_ID), openai: ok(900, 'rollout-2026-07-2') }, { roots }),
    /unattested codex-lane side/);
  // the full filename still resolves to the same canonical id as the bare session id
  const id2 = newDuel(db);
  const res = recordResults(db, id2, { anthropic: ok(500, B_ID),
    openai: ok(900, `rollout-2026-07-24T15-28-52-${C_ID}.jsonl`) }, { roots });
  assert.equal(res.status, 'awaiting_judgment');
});

test('a judge vote cannot reuse a side proof, and a spent judge proof cannot attest a side', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const J_ID = 'f1e2d3c4-b5a6-4789-9012-3456789abcde';
  writeFileSync(join(roots.B, 'proj', `${J_ID}.jsonl`), '{}');

  const id = newDuel(db);
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });
  // the anthropic side's own session id is not evidence that a judge ran
  assert.throws(() => recordJudgment(db, id, 'anthropic', 'X', 5, { proof: B_ID, roots }),
    /already used to attest duel/);
  assert.equal(recordJudgment(db, id, 'anthropic', 'X', 5, { proof: J_ID, roots }).status,
    'awaiting_judgment');
  // …and that judge run is now spent too: it cannot come back as a duel side
  const next = newDuel(db);
  assert.throws(() => recordResults(db, next,
    { anthropic: ok(500, J_ID), openai: ok(900, C_ID) }, { roots }),
    /already used to attest duel/);
});

test('a rejected record leaves no half-claimed proof behind', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const B2 = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
  writeFileSync(join(roots.B, 'proj', `${B2}.jsonl`), '{}');
  const first = newDuel(db);
  recordResults(db, first, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });

  // second duel: the anthropic claim succeeds, then the openai claim collides INSIDE the
  // transaction — the rollback must take the anthropic claim with it
  const second = newDuel(db);
  assert.throws(() => recordResults(db, second,
    { anthropic: ok(500, B2), openai: ok(900, C_ID) }, { roots }), /already used to attest/);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM proof_claims').get() as any).c, 2);
  assert.equal(db.prepare('SELECT 1 FROM proof_claims WHERE proof=?').get(B2), undefined);
  assert.equal((db.prepare('SELECT status FROM duels WHERE id=?').get(second) as any).status, 'routed');
  // …and the fresh run can still be recorded once its partner is a real second run
  const cx2 = '019f9700-1111-7222-8333-444455556666';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-2026-07-24T16-00-00-${cx2}.jsonl`), '{}');
  assert.equal(recordResults(db, second, { anthropic: ok(500, B2), openai: ok(900, cx2) },
    { roots }).status, 'awaiting_judgment');
});

test('one run cannot be spent twice under two spellings of its id', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const B2 = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
  writeFileSync(join(roots.B, 'proj', `${B2}.jsonl`), '{}');
  const first = newDuel(db);
  recordResults(db, first, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });
  // same codex run, spelled as the full rollout filename
  const second = newDuel(db);
  assert.throws(() => recordResults(db, second, { anthropic: ok(500, B2),
    openai: ok(900, `rollout-2026-07-24T15-28-52-${C_ID}.jsonl`) }, { roots }),
    /already used to attest duel/);
});

test('a re-spawned judge spends its session id even when its verdict is discarded', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const J1 = 'f1e2d3c4-b5a6-4789-9012-3456789abcde';
  const J2 = 'c0ffee00-1234-4abc-8def-567890abcdef';
  for (const j of [J1, J2]) writeFileSync(join(roots.B, 'proj', `${j}.jsonl`), '{}');
  const id = newDuel(db);
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });
  recordJudgment(db, id, 'anthropic', 'X', 5, { proof: J1, roots });
  // the response was lost; the controller re-spawns the judge, which runs under a NEW id. The
  // unique index drops the duplicate verdict, but that run really happened for this duel — an
  // unclaimed J2 was a fresh id free to attest some *other* duel later.
  recordJudgment(db, id, 'anthropic', 'X', 6, { proof: J2, roots });
  const owner: any = db.prepare('SELECT duel_id, slot FROM proof_claims WHERE proof=?').get(J2);
  assert.deepEqual({ duel_id: owner?.duel_id, slot: owner?.slot },
    { duel_id: id, slot: 'judge:anthropic' });
  // …and a plain retry of the SAME run is still a no-op, not a double-spend error
  recordJudgment(db, id, 'anthropic', 'X', 7, { proof: J1, roots });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM proof_claims').get() as any).c, 4);
});

test('a failed side does not spend the proof it reports', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const id = newDuel(db);
  // codex hung; the controller still reports the rollout id it found for forensics
  recordResults(db, id, { anthropic: ok(500, B_ID),
    openai: { output: null, tokens: null, latencyMs: null, failed: true, proof: C_ID } },
    { roots });
  assert.equal((db.prepare('SELECT gpt_proof FROM duels WHERE id=?').get(id) as any).gpt_proof, null);
  // that run can still attest a later duel, and a process restart cannot backfill it as spent
  const next = newDuel(db);
  assert.equal(recordResults(db, next,
    { anthropic: FAILED, openai: ok(900, C_ID) }, { roots }).status, 'walkover');
});

test('a proof written by a pre-2.5 process still blocks reuse', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  // an older MCP server recorded this duel: proofs in `duels`, nothing in `proof_claims`
  const old = newDuel(db);
  db.prepare("UPDATE duels SET status='judged', anth_proof=?, gpt_proof=? WHERE id=?")
    .run(B_ID, C_ID, old);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM proof_claims').get() as any).c, 0);
  const next = newDuel(db);
  assert.throws(() => recordResults(db, next,
    { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots }),
    /already used to attest duel/);
});

test('hasRunEvidence: non-jsonl files never count', () => {
  const base = mkdtempSync(join(tmpdir(), 'mr-proof-'));
  writeFileSync(join(base, 'note.txt'), 'x');
  assert.equal(hasRunEvidence(base, 1), false);
});

// Every codex-family lane writes into ONE sessions directory, so an id-and-mtime match proves
// only that SOME codex run happened. record_outcome has demanded the rollout's own lane since
// 2.5.7; this path did not — and v2.6 made it spark's primary evaluation path by seeding spark
// as the contender on both haiku-tier rows.
const SPARK_SIDES: [Side, Side] = [
  { vendor: 'anthropic', lane: 'B', model: 'haiku', effort: 'low' },
  { vendor: 'openai', lane: 'spark', model: 'gpt-5.3-codex-spark', effort: 'low' },
];
const settings = (model: string) => JSON.stringify({ type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_settings: { model, model_provider_id: 'openai' } } });

test('a codex-lane rollout does not attest a spark-lane side, and vice versa', () => {
  const roots = freshRoots();
  const codexOnly = '019f959a-1111-7bf3-a0d5-c30f463dd001';
  const sparkOnly = '019f959a-2222-7bf3-a0d5-c30f463dd002';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${codexOnly}.jsonl`), settings('gpt-5.6-sol') + '\n');
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sparkOnly}.jsonl`), settings('gpt-5.3-codex-spark') + '\n');

  const db = openDb(':memory:');
  const spark = () => createDuel(db, 'bulk-mechanical', SPARK_SIDES, { mutating: false, spotCheck: false }, 1);
  assert.throws(() => recordResults(db, spark(),
    { anthropic: ok(500, B_ID), openai: ok(500, codexOnly) }, { roots }),
    /unattested spark-lane side/);
  // …the same call with spark's own rollout goes through, so this is a lane check and not a
  // blanket rejection of the id.
  assert.equal(recordResults(db, spark(),
    { anthropic: ok(500, B_ID), openai: ok(500, sparkOnly) }, { roots }).status, 'awaiting_judgment');

  // The reverse direction too: a spark run must not attest the codex lane.
  assert.throws(() => recordResults(db, newDuel(db),
    { anthropic: ok(500, B_ID), openai: ok(500, sparkOnly) }, { roots }),
    /unattested codex-lane side/);
});

// Judge proofs are lane-matched like side proofs (duel-62 I2/S4): the protocol's gpt judge is
// terra ON THE CODEX LANE, and spark writes into the same directory.
test('a spark rollout cannot cast the codex judge vote', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-3333-7bf3-a0d5-c30f463dd003';
  const judgeSpark = '019f959a-4444-7bf3-a0d5-c30f463dd004';
  const judgeCx = '019f959a-5555-7bf3-a0d5-c30f463dd005';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), settings('gpt-5.6-terra') + '\n');
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${judgeSpark}.jsonl`), settings('gpt-5.3-codex-spark') + '\n');
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${judgeCx}.jsonl`), settings('gpt-5.6-terra') + '\n');
  const db = openDb(':memory:');
  const id = newDuel(db);
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) }, { roots });
  assert.throws(() => recordJudgment(db, id, 'openai', 'X', 2, { proof: judgeSpark, roots }),
    /unattested openai judge: no codex-lane session file/);
  // the refusal happened before anything was written — the spark id was not claimed either
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM judgments').get() as any).c, 0);
  // …and the same vote with a codex-lane run goes through: a lane check, not a blanket refusal
  assert.equal(recordJudgment(db, id, 'openai', 'X', 2, { proof: judgeCx, roots }).status,
    'awaiting_judgment');
  const stored: any = db.prepare(`SELECT judge_model_attested, judge_effort_attested
    FROM judgments WHERE duel_id=? AND judge_vendor='openai'`).get(id);
  assert.deepEqual({ ...stored },
    { judge_model_attested: 'gpt-5.6-terra', judge_effort_attested: null });
});

test('judge proof identity is stored without comparing it to a protocol expectation', () => {
  const roots = freshRoots();
  const judge = 'f1e2d3c4-b5a6-4789-9012-3456789abcde';
  writeBIdentity(roots, judge, 'claude-opus-4-1', 'xhigh');
  const db = openDb(':memory:');
  const id = newDuel(db);
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, C_ID) }, { roots });

  assert.equal(recordJudgment(db, id, 'anthropic', 'X', 2, { proof: judge, roots }).status,
    'awaiting_judgment');
  const stored: any = db.prepare(`SELECT judge_model_attested, judge_effort_attested
    FROM judgments WHERE duel_id=? AND judge_vendor='anthropic'`).get(id);
  assert.deepEqual({ ...stored },
    { judge_model_attested: 'claude-opus-4-1', judge_effort_attested: 'xhigh' });
});

// Lane A needs no proof — the run happens in the controller's own session. But a proof that IS
// volunteered must verify before it may be claimed: recordResults used to claim any RE-shaped
// string blind, permanently burning that entry in the single-use namespace (duel-62 I1).
const A_SIDES: [Side, Side] = [
  { vendor: 'anthropic', lane: 'A', model: 'opus', effort: 'high' },
  { vendor: 'openai', lane: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' },
];

test('a volunteered lane-A proof is verified, or refused — never claimed blind', () => {
  const roots = freshRoots();
  const aRoot = join(mkdtempSync(join(tmpdir(), 'mr-a-')), 'projects');
  mkdirSync(join(aRoot, 'proj'), { recursive: true });
  const A_ID = 'aaaa1111-2222-4333-8444-555566667777';
  writeFileSync(join(aRoot, 'proj', `${A_ID}.jsonl`), '{}');
  const withA = { ...roots, A: aRoot };
  const db = openDb(':memory:');
  const mk = () => createDuel(db, 'second-opinion', A_SIDES, { mutating: false, spotCheck: false }, 1);

  // RE-shaped junk: the record LANDS (the attested partner side must not be blocked by a
  // decorative field — duel-63 opus #4), but the junk is ignored: neither stored nor claimed
  const id1 = mk();
  const r1 = recordResults(db, id1,
    { anthropic: ok(500, 'ffffffff-0000-4000-8000-000000000000'), openai: ok(900, C_ID) },
    { roots: withA });
  assert.equal(r1.status, 'awaiting_judgment');
  const junkRow: any = db.prepare('SELECT anth_proof FROM duels WHERE id=?').get(id1);
  assert.equal(junkRow.anth_proof, null);
  assert.equal((db.prepare(
    "SELECT COUNT(*) AS c FROM proof_claims WHERE slot='anthropic'").get() as any).c, 0);

  // a real A session file: verified, stored, claimed (fresh codex id — C_ID was spent above)
  const cxFresh = '019f959a-6666-7bf3-a0d5-c30f463dd006';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${cxFresh}.jsonl`), '{}');
  const id2 = mk();
  recordResults(db, id2, { anthropic: ok(500, A_ID), openai: ok(900, cxFresh) }, { roots: withA });
  const row: any = db.prepare('SELECT anth_proof FROM duels WHERE id=?').get(id2);
  assert.equal(row.anth_proof, A_ID);
  assert.ok(db.prepare('SELECT 1 FROM proof_claims WHERE proof=?').get(A_ID.toLowerCase()));

  // no A root configured (pre-2.6.5 caller shape): the proof is ignored — accepted, but
  // neither stored nor claimed, so an unverifiable string cannot spend the namespace
  const db2 = openDb(':memory:');
  const id3 = createDuel(db2, 'second-opinion', A_SIDES, { mutating: false, spotCheck: false }, 1);
  recordResults(db2, id3,
    { anthropic: ok(500, 'eeeeeeee-0000-4000-8000-000000000000'), openai: ok(900, C_ID) },
    { roots });
  const row3: any = db2.prepare('SELECT anth_proof FROM duels WHERE id=?').get(id3);
  assert.equal(row3.anth_proof, null);
  assert.equal((db2.prepare("SELECT COUNT(*) AS c FROM proof_claims WHERE slot='anthropic'").get() as any).c, 0);
});

// The judge window is the RESULTS clock (duel-63 sol#1): a vote is about the packet, so the
// judge's run must postdate the outputs it voted on — a session started after routing but
// before the sides finished cannot have seen the packet, and its id must not claim the slot.
test('a judge run that predates the recorded results cannot vote', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7777-7bf3-a0d5-c30f463dd007';
  const earlyJudge = '019f959a-8888-7bf3-a0d5-c30f463dd008';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${earlyJudge}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db); // created_at = 1
  // results recorded far in the future: every session file on disk now predates recorded_at
  const future = Date.now() + 3_600_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: future });
  assert.throws(() => recordJudgment(db, id, 'openai', 'X', future, { proof: earlyJudge, roots }),
    /since the duel's results were recorded/);
  // a judge run that postdates the results is accepted (fresh mtime ≥ recorded_at − skew)
  const lateJudge = '019f959a-9999-7bf3-a0d5-c30f463dd009';
  const lateFile = join(roots.codex, '2026/07/24', `rollout-${lateJudge}.jsonl`);
  writeFileSync(lateFile, '{}');
  utimesSync(lateFile, new Date(future + 5_000), new Date(future + 5_000));
  assert.equal(recordJudgment(db, id, 'openai', 'X', future + 5_000, { proof: lateJudge, roots }).status,
    'awaiting_judgment');
});

// ——— duel-64 ledger ———

// The judge window is enforced on the session's own START, not file mtime: mtime is the last
// write, so a session started before the packet existed but still appended to afterwards
// claimed the judge slot (duel-64 opus #7 / sol #1). The start comes from the file's first
// "timestamp" field; a file without one falls back to the mtime-only check.
test('a session that STARTED before the results were recorded cannot judge, fresh mtime or not', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-9999-7bf3-a0d5-c30f463dd009';
  const oldJudge = '019f959a-aaaa-7bf3-a0d5-c30f463dd00a';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000; // results landed a minute ago
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // judge session STARTED an hour before the record (first-line timestamp), appended after
  const started = new Date(recordedAt - 3_600_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${oldJudge}.jsonl`),
    `{"timestamp":"${started}","type":"session_meta"}\n{"appended":"later"}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: oldJudge, roots }),
    /since the duel's results were recorded/);
  // …and a session whose first line postdates the record still votes
  const freshJudge = '019f959a-bbbb-7bf3-a0d5-c30f463dd00b';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${freshJudge}.jsonl`),
    `{"timestamp":"${new Date(recordedAt + 5_000).toISOString()}","type":"session_meta"}\n`);
  assert.equal(
    recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: freshJudge, roots }).status,
    'awaiting_judgment');
});

// Reviving a swept duel must not move the judge window: recorded_at is the sweep's clock and
// keeps moving, but the packet's outputs did not change, so judge runs completed before the
// sweep stay recordable (duel-64 opus #3).
test('reviving a swept duel keeps the original judge window — completed judge runs still record', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-eeee-7bf3-a0d5-c30f463dd00e';
  const lateJudge = '019f959a-ffff-7bf3-a0d5-c30f463dd00f';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const t1 = Date.now();
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) }, { roots, now: t1 });
  // the judge ran right after the record (file mtime ≈ t1)…
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${lateJudge}.jsonl`), '{}');
  // …but the controller died; the sweep abandons the row and the controller revives it unchanged
  const t2 = t1 + 7 * 3_600_000;
  expireStaleDuels(db, t2);
  const revived = recordResults(db, id,
    { anthropic: FAILED, openai: FAILED }, { roots, now: t2 });
  assert.equal(revived.status, 'awaiting_judgment');
  // the outputs clock survived the revival — the completed judge run is still in the window
  assert.equal((db.prepare('SELECT outputs_at FROM duels WHERE id=?').get(id) as any).outputs_at, t1);
  assert.equal(recordJudgment(db, id, 'openai', 'X', t2, { proof: lateJudge, roots }).status,
    'awaiting_judgment');
});

// Lane A is the controller's own session, and its id is constant for the whole controller
// session — so the second duel recorded in one session volunteers the same (entirely genuine)
// id. A lane-A proof must never be able to fail a record (duel-64 opus #4).
test('the controller session id, re-volunteered on a second duel, never blocks the record', () => {
  const roots = freshRoots();
  const aRoot = join(mkdtempSync(join(tmpdir(), 'mr-a2-')), 'projects');
  mkdirSync(join(aRoot, 'proj'), { recursive: true });
  const CTRL = 'cccc1111-2222-4333-8444-555566667777';
  writeFileSync(join(aRoot, 'proj', `${CTRL}.jsonl`), '{}');
  const withA = { ...roots, A: aRoot };
  const db = openDb(':memory:');
  const mk = () => createDuel(db, 'second-opinion', A_SIDES, { mutating: false, spotCheck: false }, 1);
  const id1 = mk();
  recordResults(db, id1, { anthropic: ok(500, CTRL), openai: ok(900, C_ID) }, { roots: withA });
  // same controller session, next duel: the id is verified but already spent — ignored, not fatal
  const cx2 = '019f959a-cccc-7bf3-a0d5-c30f463dd00c';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${cx2}.jsonl`), '{}');
  const id2 = mk();
  const r2 = recordResults(db, id2,
    { anthropic: ok(500, CTRL), openai: ok(900, cx2) }, { roots: withA });
  assert.equal(r2.status, 'awaiting_judgment');
  const row: any = db.prepare('SELECT anth_proof, gpt_output FROM duels WHERE id=?').get(id2);
  assert.equal(row.anth_proof, null); // the spent id is not re-claimed, just ignored
  assert.equal(row.gpt_output, 'out'); // the attested partner side landed
  const claim: any = db.prepare('SELECT duel_id FROM proof_claims WHERE proof=?').get(CTRL);
  assert.equal(claim.duel_id, id1); // the claim still belongs to duel 1
});

// The cross-side equality throw fired for a lane-A proof the record was otherwise going to
// ignore: a controller pasting the codex partner's id into the decorative lane-A field blocked
// the attested codex report (duel-64 sol #5).
test("the codex partner's id pasted into the lane-A field does not kill the record", () => {
  const roots = freshRoots(); // no A root: the lane-A proof is unclaimable and must be ignored
  const db = openDb(':memory:');
  const id = createDuel(db, 'second-opinion', A_SIDES, { mutating: false, spotCheck: false }, 1);
  const cx = '019f959a-dddd-7bf3-a0d5-c30f463dd00d';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${cx}.jsonl`), '{}');
  const r = recordResults(db, id, { anthropic: ok(500, cx), openai: ok(900, cx) }, { roots });
  assert.equal(r.status, 'awaiting_judgment');
  const row: any = db.prepare('SELECT anth_proof, gpt_proof FROM duels WHERE id=?').get(id);
  assert.equal(row.anth_proof, null);
  assert.equal(row.gpt_proof, cx);
});

// ——— duel-65 ledger ———

// The outputs_at WRITER's fallback omitted recorded_at (the reader has it): a pre-2.6.7 row —
// outputs_at NULL, recorded_at set — revived unchanged stamped outputs_at = revival time, and
// the judge window jumped forward by the whole sweep interval: the exact defect the column was
// added to kill, alive on every migrated row (duel-65 opus F2 / sol S2).
test('reviving a pre-2.6.7 row (outputs_at NULL) keeps recorded_at as the judge window', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-1234-7bf3-a0d5-c30f463dd010';
  const lateJudge = '019f959a-2345-7bf3-a0d5-c30f463dd011';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const t1 = Date.now();
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) }, { roots, now: t1 });
  db.prepare('UPDATE duels SET outputs_at=NULL WHERE id=?').run(id); // migrated legacy shape
  // the judge ran right after the record; the controller died; sweep; unchanged revival
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${lateJudge}.jsonl`), '{}');
  const t2 = t1 + 7 * 3_600_000;
  expireStaleDuels(db, t2);
  recordResults(db, id, { anthropic: FAILED, openai: FAILED }, { roots, now: t2 });
  assert.equal((db.prepare('SELECT outputs_at FROM duels WHERE id=?').get(id) as any).outputs_at, t1);
  assert.equal(recordJudgment(db, id, 'openai', 'X', t2, { proof: lateJudge, roots }).status,
    'awaiting_judgment');
});

// ——— duel-66 ledger ———

// The 2.6.8 writer fallback added recorded_at but still terminated on `now` where the reader
// terminates on created_at: a pre-2.6.4 row — BOTH clock columns NULL — revived unchanged had
// its judge window stamped with the revival time, the F2 defect one migration generation
// further back (duel-66 opus I2 / sol F2).
test('reviving a pre-2.6.4 row (both clock columns NULL) keeps created_at as the judge window', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-abcd-7bf3-a0d5-c30f463dd019';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const t0 = Date.now() - 8 * 3_600_000;
  const id = newDuel(db, t0);
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: t0 + 1_000 });
  // pre-2.6.4 shape: recorded before either clock column existed
  db.prepare('UPDATE duels SET outputs_at=NULL, recorded_at=NULL WHERE id=?').run(id);
  const t2 = t0 + 7 * 3_600_000;
  expireStaleDuels(db, t2);
  recordResults(db, id, { anthropic: FAILED, openai: FAILED }, { roots, now: t2 });
  assert.equal(
    (db.prepare('SELECT outputs_at FROM duels WHERE id=?').get(id) as any).outputs_at, t0);
});

// A codex rollout's first "timestamp" is the session_meta ENVELOPE write time; the real start
// sits in payload.timestamp on the SAME line, measured up to +104s earlier on live rollouts.
// First-match parsing accepted a pre-packet judge whenever its envelope write landed
// post-packet — a bias ~50× the 2s skew the S10 fix removed (duel-66 opus I5). The check now
// takes the EARLIEST timestamp in the head.
test('a pre-packet session start hidden behind a later envelope timestamp is rejected', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-89ab-7bf3-a0d5-c30f463dd017';
  const envJudge = '019f959a-9abc-7bf3-a0d5-c30f463dd018';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // envelope stamped 15s after the record; the session's real start was 90s before it
  const envelope = new Date(recordedAt + 15_000).toISOString();
  const realStart = new Date(recordedAt - 90_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${envJudge}.jsonl`),
    `{"timestamp":"${envelope}","type":"session_meta","payload":{"timestamp":"${realStart}"}}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: envJudge, roots }),
    /since the duel's results were recorded/);
});

// The 256 KiB head boundary itself: a file whose head holds no timestamp at all degrades to
// the mtime-only check (logged once) — it must still attest on a fresh mtime rather than be
// rejected outright (duel-66 test-gap 6).
test('a head with no timestamp degrades to the mtime check, not to rejection', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-bcde-7bf3-a0d5-c30f463dd01a';
  const bigJudge = '019f959a-cdef-7bf3-a0d5-c30f463dd01b';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // first timestamp sits past the 256 KiB head; the file itself is fresh
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${bigJudge}.jsonl`),
    `{"instructions":"${'x'.repeat(300 * 1024)}"}\n` +
    `{"timestamp":"${new Date(recordedAt + 5_000).toISOString()}"}\n`);
  assert.equal(
    recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: bigJudge, roots }).status,
    'awaiting_judgment');
});

// sessionStartMs read only the head 4 KiB: real lane-B agent files and every codex rollout
// (session_meta embeds base_instructions) carry their first timestamp past 4096, so the START
// check silently fell back to mtime — reviving the pre-packet-session bypass it exists to
// close (duel-65 opus F8 / sol S1).
test('a session start past the first 4 KiB is still enforced', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-3456-7bf3-a0d5-c30f463dd012';
  const bigJudge = '019f959a-4567-7bf3-a0d5-c30f463dd013';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // ~8 KiB of instructions precede the first timestamp — the session started an hour before
  // the packet existed, then was appended to after (fresh mtime)
  const started = new Date(recordedAt - 3_600_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${bigJudge}.jsonl`),
    `{"instructions":"${'x'.repeat(8192)}","timestamp":"${started}"}\n{"appended":"later"}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: bigJudge, roots }),
    /since the duel's results were recorded/);
});

// A parsed session START is a millisecond-precision statement by the lane's own logger — it
// must not inherit the mtime comparison's 2s kernel-clock allowance: a judge that started
// 1500ms BEFORE the packet existed was accepted (duel-65 sol S10).
test('a parsed START inside the mtime skew window is still pre-packet — rejected', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-5678-7bf3-a0d5-c30f463dd014';
  const skewJudge = '019f959a-6789-7bf3-a0d5-c30f463dd015';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${skewJudge}.jsonl`),
    `{"timestamp":"${new Date(recordedAt - 1_500).toISOString()}","type":"session_meta"}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: skewJudge, roots }),
    /since the duel's results were recorded/);
  // a START exactly at the record is not pre-packet — still votes
  const atJudge = '019f959a-789a-7bf3-a0d5-c30f463dd016';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${atJudge}.jsonl`),
    `{"timestamp":"${new Date(recordedAt).toISOString()}","type":"session_meta"}\n`);
  assert.equal(
    recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: atJudge, roots }).status,
    'awaiting_judgment');
});

// ——— duel-67 ledger ———

// The byte-wide minimum read a forked/resumed codex rollout's ANCESTOR session_meta — embedded
// in the head of 29 of 173 live rollouts, up to 8m41s before their own start — as this
// session's start, and false-rejected genuine post-packet judges and sides (duel-67 opus F1).
// Only line 1 describes this session; deeper timestamps belong to whatever the session resumed.
test('an ancestor timestamp deeper in the head does not backdate the session start', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-def0-7bf3-a0d5-c30f463dd01c';
  const forkJudge = '019f959a-ef01-7bf3-a0d5-c30f463dd01d';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // the judge really starts 5s after the record (line 1's payload.timestamp), but the head
  // embeds the resumed ancestor's meta, stamped 8 minutes before the packet existed
  const envelope = new Date(recordedAt + 15_000).toISOString();
  const realStart = new Date(recordedAt + 5_000).toISOString();
  const ancestor = new Date(recordedAt - 8 * 60_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${forkJudge}.jsonl`),
    `{"timestamp":"${envelope}","type":"session_meta","payload":{"timestamp":"${realStart}"}}\n` +
    `{"type":"compacted_history","payload":{"session_meta":{"timestamp":"${ancestor}"}}}\n`);
  assert.equal(
    recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: forkJudge, roots }).status,
    'awaiting_judgment');
});

// The degrade warning is once per FILE: attestation re-reads the same path on every record and
// judgment call, and a long-lived MCP server's stderr does not need the repeat (duel-66 M9;
// pinned by duel-67 — sol F5).
test('the mtime-degrade warning fires once per file, not once per call', () => {
  const roots = freshRoots();
  const bigA = '019f959a-f012-7bf3-a0d5-c30f463dd01e';
  const bigB = '019f959a-0123-7bf3-a0d5-c30f463dd01f';
  const body = `{"instructions":"${'x'.repeat(300 * 1024)}"}\n`;
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${bigA}.jsonl`), body);
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${bigB}.jsonl`), body);
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { seen.push(a.join(' ')); };
  try {
    for (let i = 0; i < 3; i++) hasRunEvidence(roots.codex, Date.now() - 60_000, bigA);
    hasRunEvidence(roots.codex, Date.now() - 60_000, bigB);
  } finally { console.error = orig; }
  assert.equal(seen.filter(m => m.includes(bigA)).length, 1);
  assert.equal(seen.filter(m => m.includes(bigB)).length, 1);
});

// ——— duel-68 ledger ———

// Lane B's head lines are NOT timestamp-ordered — 83 of 225 live files carry a stamp earlier
// than line 1's, by up to 1.658s — so the line-1 rule re-admitted pre-packet slack on lane B,
// exceeding the 1500ms case duel-65 S10 was written for (duel-68 opus F4). No fork-replay
// mechanism exists on lane B, so the byte-wide minimum is correct there: the earliest stamp in
// the head is the session's earliest evidence. Codex keeps the line-1 rule — fork ancestors
// must not vote.
test('a lane-B judge whose earliest head stamp is pre-packet is rejected, line 1 or not', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-abcd-7bf3-a0d5-c30f463dd022';
  const bJudge = 'aaaa1111-2222-4333-8444-55556666dd23';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // line 1 postdates the record, but a deeper head line is 1.6s pre-packet — the session had
  // already begun when the packet landed (the real lane-B head shape: unordered)
  const line1 = new Date(recordedAt + 5_000).toISOString();
  const deeper = new Date(recordedAt - 1_600).toISOString();
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`),
    `{"type":"queue-operation","timestamp":"${line1}"}\n` +
    `{"type":"attachment","timestamp":"${deeper}"}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }),
    /since the duel's results were recorded/);
  // …and a lane-B judge whose EVERY head stamp postdates the record still votes
  const freshB = 'bbbb1111-2222-4333-8444-55556666dd24';
  writeFileSync(join(roots.B, 'proj', `${freshB}.jsonl`),
    `{"type":"queue-operation","timestamp":"${new Date(recordedAt + 5_000).toISOString()}"}\n` +
    `{"type":"attachment","timestamp":"${new Date(recordedAt + 4_000).toISOString()}"}\n`);
  assert.equal(
    recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: freshB, roots }).status,
    'awaiting_judgment');
});

// The line-1 fallback kept only the FIRST regex match where 2.6.9 kept every parseable one: an
// unparseable first "timestamp" value silently degraded the check to mtime-only — the
// once-per-file warning is gated on a full head, so it never fired — even with valid stamps a
// line later (duel-68 opus F5). The fallback takes the first PARSEABLE match.
test('an unparseable first timestamp does not blind the fallback to the parseable one behind it', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-abcd-7bf3-a0d5-c30f463dd025';
  const oddJudge = '019f959a-abcd-7bf3-a0d5-c30f463dd026';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // line 1 is not JSON (fallback path); the first "timestamp" value is garbage, the second is
  // a real pre-packet start
  const started = new Date(recordedAt - 3_600_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${oddJudge}.jsonl`),
    `garbage line with "timestamp":"not-a-date"\n` +
    `{"timestamp":"${started}","type":"session_meta"}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: oddJudge, roots }),
    /since the duel's results were recorded/);
});

// A repair that replaces a blank side also replaces its stored PROOF — and a pre-2.5 writer
// recorded that spend nowhere else. Once overwritten, legacyProofOwner finds nothing and the
// id becomes re-spendable — the double-spend the namespace exists to stop (duel-67 opus F4,
// the un-tombstoned sibling of duel-66's judge-proof fix).
test('repairing a blank side tombstones the proof it overwrites', () => {
  const roots = freshRoots();
  const oldP = '019f959a-aaaa-7bf3-a0d5-c30f463dd020';
  const newP = '019f959a-bbbb-7bf3-a0d5-c30f463dd021';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${newP}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  // pre-2.5 shape: the blank side's proof lives ONLY in the duels column — no claims row
  db.prepare(`UPDATE duels SET status='abandoned', anth_output='anth report', gpt_output='   ',
    gpt_proof=? WHERE id=?`).run(oldP, id);
  recordResults(db, id, { anthropic: FAILED, openai: ok(900, newP) },
    { roots, now: Date.now() });
  const claim = db.prepare('SELECT duel_id, slot FROM proof_claims WHERE proof=?')
    .get(oldP) as any;
  assert.ok(claim, 'the overwritten side proof must survive as a claim');
  assert.equal(claim.duel_id, id);
  assert.equal(claim.slot, 'openai');
});

// ——— duel-69 ledger ———

// Lane B's 'earliest' mode was a raw byte-wide regex: ANY `"timestamp"` key in the head voted,
// at any nesting depth — a tool result carrying an old record's timestamp backdated the whole
// session and false-rejected a genuine post-packet judge, whose proof id is single-use
// (duel-69 opus F1). The minimum is per-LINE now, over the two fields the lane itself stamps
// (rec.timestamp / rec.payload.timestamp) — a nested foreign key can never vote.
test('a nested foreign timestamp in a lane-B head does not backdate the session start', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-6900-7bf3-a0d5-c30f463dd030';
  const bJudge = 'cccc1111-2222-4333-8444-55556666dd31';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // every line the session stamped postdates the record; line 2 embeds a tool result whose
  // DATA contains an ancient timestamp at nesting depth 3
  const own1 = new Date(recordedAt + 5_000).toISOString();
  const own2 = new Date(recordedAt + 6_000).toISOString();
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`),
    `{"type":"queue-operation","timestamp":"${own1}"}\n` +
    `{"type":"tool-result","timestamp":"${own2}","toolUseResult":{"records":` +
    `[{"id":1,"timestamp":"2020-01-01T00:00:00.000Z"}]}}\n`);
  assert.equal(
    recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }).status,
    'awaiting_judgment');
});

// The line-1 fallback took the first parseable REGEX match — the session_meta ENVELOPE stamp,
// written up to +104s after the real start sitting in payload.timestamp on the same line. A
// session that began 90s before the packet existed re-entered through the fallback door
// whenever line 1 could not be parsed (duel-69 sol M1). The fallback parses the next complete
// LINES and takes each line's own envelope/payload minimum, exactly as line 1 does.
test('the line-1 fallback takes the fallback line\'s own envelope/payload minimum', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-6900-7bf3-a0d5-c30f463dd032';
  const oddJudge = '019f959a-6900-7bf3-a0d5-c30f463dd033';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // line 1 is garbage; line 2's envelope stamp postdates the packet, but its payload stamp —
  // the session's real start — is 90s BEFORE it
  const envelope = new Date(recordedAt + 15_000).toISOString();
  const realStart = new Date(recordedAt - 90_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${oddJudge}.jsonl`),
    `garbage first line\n` +
    `{"timestamp":"${envelope}","type":"session_meta","payload":{"timestamp":"${realStart}"}}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: oddJudge, roots }),
    /since the duel's results were recorded/);
});

// The fallback's other door: scanning the WHOLE head for the first parseable match let a
// forked rollout's ANCESTOR session_meta — arbitrarily deep in the head — vote whenever line 1
// was unparseable, which is duel-67 opus F1 re-admitted (duel-69 opus F6). The fallback is
// bounded to the next two complete lines; past them the check degrades to mtime, loudly.
test('an ancestor stamp beyond the fallback bound cannot hijack an unparseable line 1', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-6900-7bf3-a0d5-c30f463dd034';
  const forkJudge = '019f959a-6900-7bf3-a0d5-c30f463dd035';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // line 1 garbage, lines 2-3 carry no stamp, line 4 is a resumed ancestor's meta from
  // an hour before the packet — outside the bound, it must not vote (mtime is fresh)
  const ancestor = new Date(recordedAt - 3_600_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${forkJudge}.jsonl`),
    `garbage first line\n` +
    `{"type":"turn_context"}\n` +
    `{"type":"event_msg"}\n` +
    `{"type":"session_meta","timestamp":"${ancestor}"}\n`);
  assert.equal(
    recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: forkJudge, roots }).status,
    'awaiting_judgment');
});

// ——— duel-70 ledger ———

// A lane-B session whose FIRST record is one line larger than the whole head: the head held no
// newline, the per-line split produced a single truncated fragment, pop() emptied the array,
// and sessionStartMs returned null — freshness silently degraded to the mtime check on exactly
// the shape deep-review packets produce (measured: 12 of 227 live lane-B files). A pre-packet
// session re-entered through the degrade, on the lane carrying both the anthropic side and the
// anthropic judge (duel-70 anth F1). The read now extends to line 1's own newline first.
test('a lane-B first record larger than the head still yields its session start', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd040';
  const bJudge = 'dddd1111-2222-4333-8444-55556666dd41';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // line 1 is a single ~400 KiB record whose own top-level stamp says the session started 90s
  // BEFORE the packet existed; the file's mtime is fresh
  const started = new Date(recordedAt - 90_000).toISOString();
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`),
    `{"type":"queue-operation","timestamp":"${started}","content":"${'x'.repeat(400 * 1024)}"}\n` +
    `{"type":"turn","timestamp":"${new Date(recordedAt + 5_000).toISOString()}"}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }),
    /since the duel's results were recorded/);
});

// The mirror image: the giant first record belongs to a GENUINE post-packet session — the
// extended read must not false-reject what the old head-bounded read happened to accept.
test('a genuine post-packet session with a giant first record still attests', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd042';
  const bJudge = 'dddd1111-2222-4333-8444-55556666dd43';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`),
    `{"type":"queue-operation","timestamp":"${new Date(recordedAt + 5_000).toISOString()}",` +
    `"content":"${'x'.repeat(400 * 1024)}"}\n`);
  assert.equal(
    recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }).status,
    'awaiting_judgment');
});

// The bounded line-1 fallback admitted a forked rollout's ANCESTOR session_meta whenever it
// sat on line 2 or 3 — the bound moved the hazard, it did not remove it (duel-70 anth F6). A
// fallback record carrying another session's id is foreign by construction and never votes.
test('an ancestor meta on line 2 cannot false-reject the genuine judge behind a bad line 1', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd044';
  const forkJudge = '019f959a-7000-7bf3-a0d5-c30f463dd045';
  const ancestorId = '019f0000-0000-7000-8000-000000000001';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  // line 1 unparseable; line 2 is the resumed ANCESTOR's meta (8 minutes pre-packet, its own
  // id); line 3 is this session's first real record, 5s post-packet
  const ancestor = new Date(recordedAt - 8 * 60_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${forkJudge}.jsonl`),
    `garbage first line\n` +
    `{"type":"session_meta","timestamp":"${ancestor}","payload":{"id":"${ancestorId}",` +
    `"timestamp":"${ancestor}"}}\n` +
    `{"type":"turn_context","timestamp":"${new Date(recordedAt + 5_000).toISOString()}"}\n`);
  assert.equal(
    recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: forkJudge, roots }).status,
    'awaiting_judgment');
});

// The degrade-to-mtime warning was gated on an exactly-full head, so a small file with no
// usable stamp degraded SILENTLY — the silent fallback is the defect, whatever the file size
// (duel-70 sol P3). The warning fires whenever the parse yields nothing, once per file.
test('a small file with no usable stamp degrades loudly, not silently', () => {
  const roots = freshRoots();
  const small = '019f959a-7000-7bf3-a0d5-c30f463dd046';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${small}.jsonl`), 'garbage\n');
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { seen.push(a.join(' ')); };
  try {
    hasRunEvidence(roots.codex, Date.now() - 60_000, small);
    hasRunEvidence(roots.codex, Date.now() - 60_000, small);
  } finally { console.error = orig; }
  assert.equal(seen.filter(m => m.includes(small)).length, 1);
});

// ——— duel-71 ledger ———

const CAP = 4 * 1024 * 1024; // FIRST_LINE_CAP_BYTES

// A complete first record whose JSON ends exactly at the 4 MiB cap — its newline one byte past
// the read — was popped unparsed: sessionStartMs returned null and freshness silently degraded
// to the mtime-only accept, an attestation bypass at the read's own declared bound (duel-71
// sol F2; hasRunEvidence passes on a null start by design). Truncation now needs affirmative
// evidence that the record CONTINUES past the cap; a delimiter or EOF right there means line 1
// is whole and votes.
function capLine(startedIso: string): string {
  const head = `{"type":"queue-operation","timestamp":"${startedIso}","content":"`;
  const tail = '"}';
  return head + 'x'.repeat(CAP - head.length - tail.length) + tail;
}
test('a pre-packet first record ending exactly at the cap still rejects the judge', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd046';
  const bJudge = 'dddd1111-2222-4333-8444-55556666dd47';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`),
    capLine(new Date(recordedAt - 90_000).toISOString()) + '\n' +
    `{"type":"turn","timestamp":"${new Date(recordedAt + 5_000).toISOString()}"}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }),
    /since the duel's results were recorded/);
});

// The EOF spelling of the same bound: the file ends at the cap with no trailing newline — a
// finished record, not a cut one.
test('a pre-packet cap-sized final record with no newline still rejects the judge', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd048';
  const bJudge = 'dddd1111-2222-4333-8444-55556666dd49';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`),
    capLine(new Date(recordedAt - 90_000).toISOString()));
  assert.throws(
    () => recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }),
    /since the duel's results were recorded/);
});

// The head-boundary twin of the cap sentinel: a complete record ending exactly at the 256 KiB
// head read was popped as a fragment, so its pre-packet stamp never voted and the minimum
// could only rise — the same false-accept one boundary down (duel-73 opus F8).
test('a pre-packet record ending exactly at the head read still rejects the judge', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd04c';
  const bJudge = 'dddd1111-2222-4333-8444-55556666dd4d';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  const first = `{"type":"turn","timestamp":"${new Date(recordedAt + 5_000).toISOString()}"}\n`;
  const head = `{"type":"queue-operation","timestamp":"${
    new Date(recordedAt - 90_000).toISOString()}","content":"`;
  const HEAD_BYTES = 256 * 1024;
  const last = head + 'x'.repeat(HEAD_BYTES - first.length - head.length - 2) + '"}';
  // exactly 256 KiB, complete final record, EOF at the boundary — no trailing newline
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`), first + last);
  assert.throws(
    () => recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }),
    /since the duel's results were recorded/);
});

// The no-false-reject guard for the same edge: a GENUINE post-packet session whose first
// record ends exactly at the cap keeps attesting — designed green on both sides of the fix
// (before via the mtime degrade, after via the recovered vote).
test('a genuine post-packet cap-sized first record still attests', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd04a';
  const bJudge = 'dddd1111-2222-4333-8444-55556666dd4b';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  writeFileSync(join(roots.B, 'proj', `${bJudge}.jsonl`),
    capLine(new Date(recordedAt + 5_000).toISOString()));
  assert.equal(
    recordJudgment(db, id, 'anthropic', 'X', Date.now(), { proof: bJudge, roots }).status,
    'awaiting_judgment');
});

// The fallback's foreign-session filter took the FIRST non-nullish id field and never looked
// at the rest — a replayed wrapper carrying the current rollout's id in payload.id beside a
// FOREIGN top-level session_id let the ancestor's pre-packet stamp vote, false-rejecting the
// genuine judge behind it (duel-71 sol F3). Every session-shaped id on the record must agree
// with the file.
test('a record pairing the file\'s own payload.id with a foreign session_id never votes', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd04c';
  const forkJudge = '019f959a-7000-7bf3-a0d5-c30f463dd04d';
  const ancestorId = '019f0000-0000-7000-8000-000000000002';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  const ancestor = new Date(recordedAt - 8 * 60_000).toISOString();
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${forkJudge}.jsonl`),
    `garbage first line\n` +
    `{"type":"session_meta","timestamp":"${ancestor}","session_id":"${ancestorId}",` +
    `"payload":{"id":"${forkJudge}","timestamp":"${ancestor}"}}\n` +
    `{"type":"turn_context","timestamp":"${new Date(recordedAt + 5_000).toISOString()}"}\n`);
  assert.equal(
    recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: forkJudge, roots }).status,
    'awaiting_judgment');
});

// The converse: a generic string in payload.id was read AS a session id — sessionIdOf returns
// non-session input whole, so "queue-op-42" ≠ the filename and the GENUINE record was skipped,
// its pre-packet stamp never voting and the session re-entering through the mtime degrade
// (duel-71 sol F3, second direction). Only a session-shaped id can disqualify a record.
test('a generic payload.id does not hide a genuine pre-packet record from the vote', () => {
  const roots = freshRoots();
  const sideCx = '019f959a-7000-7bf3-a0d5-c30f463dd04e';
  const cxJudge = '019f959a-7000-7bf3-a0d5-c30f463dd04f';
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${sideCx}.jsonl`), '{}');
  const db = openDb(':memory:');
  const id = newDuel(db);
  const recordedAt = Date.now() - 60_000;
  recordResults(db, id, { anthropic: ok(500, B_ID), openai: ok(900, sideCx) },
    { roots, now: recordedAt });
  writeFileSync(join(roots.codex, '2026/07/24', `rollout-${cxJudge}.jsonl`),
    `garbage first line\n` +
    `{"type":"queue-operation","timestamp":"${new Date(recordedAt - 90_000).toISOString()}",` +
    `"payload":{"id":"queue-op-42"}}\n`);
  assert.throws(
    () => recordJudgment(db, id, 'openai', 'X', Date.now(), { proof: cxJudge, roots }),
    /since the duel's results were recorded/);
});

// Rule-2 composition: v2.13.20's attestation columns and v15's build stamp are written by the
// SAME recordResults statement, one wave apart. One scenario proves they land together on the
// first recording and that the replay path — which answers from the ledger — moves neither.
test('composed: one first recording fills the attestation columns AND the build stamp; the replay moves neither', () => {
  const db = openDb(':memory:');
  const roots = freshRoots();
  const codexProof = '019f959a-8888-7bf3-a0d5-c30f463dd008';
  writeBIdentity(roots, B_ID, 'claude-sonnet-5', 'high');
  writeCodexIdentity(roots, codexProof, 'gpt-5.6-terra', 'high');
  const id = newDuel(db);
  const results = { anthropic: ok(500, B_ID), openai: ok(900, codexProof) };

  const first: any = recordResults(db, id, results, { roots });
  assert.equal(first.status, 'awaiting_judgment');
  const cols = `anth_model_attested, anth_effort_attested, gpt_model_attested,
    gpt_effort_attested, minted_by_version, recorded_by_version`;
  const after: any = db.prepare(`SELECT ${cols} FROM duels WHERE id=?`).get(id);
  assert.deepEqual({ ...after }, {
    anth_model_attested: 'claude-sonnet-5', anth_effort_attested: 'high',
    gpt_model_attested: 'gpt-5.6-terra', gpt_effort_attested: 'high',
    minted_by_version: pluginVersion(), recorded_by_version: pluginVersion(),
  });

  // Replay under a DIFFERENT (older) stamp and contradictory artifacts: an identical re-record
  // must rewrite neither family — the stamp names the build that FIRST recorded, not the last.
  db.prepare('UPDATE duels SET recorded_by_version=? WHERE id=?').run('2.13.19', id);
  writeBIdentity(roots, B_ID, 'claude-opus-4-1', 'xhigh');
  writeCodexIdentity(roots, codexProof, 'gpt-0-wrong', 'low');
  assert.deepEqual(recordResults(db, id, results, { roots }), first);
  const replayed: any = db.prepare(`SELECT ${cols} FROM duels WHERE id=?`).get(id);
  assert.deepEqual({ ...replayed }, { ...after, recorded_by_version: '2.13.19' });
});
