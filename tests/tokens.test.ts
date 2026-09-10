import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokensOf, type TokenReport } from '../src/tokens.js';
import { readTokenArtifacts } from '../src/cli.js';

const THREE_EVENT_ROLLOUT = [
  '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":1}}}}',
  '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":20,"cached_input_tokens":8,"output_tokens":2}}}}',
  '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":30,"cached_input_tokens":12,"output_tokens":3}}}}',
].join('\n');

const SUB_AGENT_ROLLOUT = [
  '{"type":"session_meta","payload":{"id":"child"}}',
  '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":70,"cached_input_tokens":20,"output_tokens":7}}}}',
].join('\n');

const ENVELOPE = `{
  "type": "result",
  "usage": {
    "input_tokens": 17,
    "cache_creation_input_tokens": 9995,
    "cache_read_input_tokens": 46224,
    "output_tokens": 339,
    "output_tokens_details": { "thinking_tokens": 187 },
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "standard"
  },
  "modelUsage": {
    "claude-haiku-4-5-20251001": {
      "inputTokens": 999999,
      "outputTokens": 999999,
      "cacheReadInputTokens": 999999,
      "cacheCreationInputTokens": 999999
    }
  }
}`;

const PARTIAL_ROLLOUT = [
  '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"cached_input_tokens":30,"output_tokens":4}}}}',
  '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":50,"output_tokens":5}}}}',
].join('\n');

// Lane-B (headless Claude Code) session file: one line per content block, so a single API
// response repeats the same message.id with identical usage; a stream update can rewrite an
// id's usage on a later line. Dedupe by id, last wins — a naive sum double-counts (128k vs
// the true 67.6k on duel 334's real artifact).
const SESSION_JSONL = [
  '{"type":"user","message":{"role":"user","content":"task"}}',
  '{"type":"assistant","message":{"id":"msg_01","role":"assistant","usage":{"input_tokens":5,"cache_read_input_tokens":100,"output_tokens":40}}}',
  '{"type":"assistant","message":{"id":"msg_01","role":"assistant","usage":{"input_tokens":5,"cache_read_input_tokens":100,"output_tokens":40}}}',
  '{"type":"assistant","message":{"id":"msg_02","role":"assistant","usage":{"input_tokens":1,"cache_read_input_tokens":200,"output_tokens":3}}}',
  '{"type":"assistant","message":{"id":"msg_02","role":"assistant","usage":{"input_tokens":1,"cache_read_input_tokens":200,"output_tokens":9}}}',
].join('\n');

type TokenCase = {
  name: string;
  files: { path: string; text: string }[];
  expected: TokenReport;
};

const CASES: TokenCase[] = [
  {
    name: 'a rollout uses all three columns from the last cumulative event',
    files: [{ path: 'parent.jsonl', text: THREE_EVENT_ROLLOUT }],
    expected: {
      output: 3,
      input: 30,
      cached: 12,
      basis: 'rollout last total_token_usage x1',
      sources: [{ path: 'parent.jsonl', kind: 'rollout', output: 3 }],
    },
  },
  {
    name: 'two rollouts sum parent and sub-agent columns and name both in the basis',
    files: [
      { path: 'parent.jsonl', text: THREE_EVENT_ROLLOUT },
      { path: 'child.jsonl', text: SUB_AGENT_ROLLOUT },
    ],
    expected: {
      output: 10,
      input: 100,
      cached: 32,
      basis: 'rollout last total_token_usage x2',
      sources: [
        { path: 'parent.jsonl', kind: 'rollout', output: 3 },
        { path: 'child.jsonl', kind: 'rollout', output: 7 },
      ],
    },
  },
  {
    name: 'a lane-B envelope maps the authoritative top-level usage fields',
    files: [{ path: 'probe-effort.json', text: ENVELOPE }],
    expected: {
      output: 339,
      input: 17,
      cached: 46224,
      basis: 'envelope usage x1',
      sources: [{ path: 'probe-effort.json', kind: 'envelope', output: 339 }],
    },
  },
  {
    name: 'mixed rollout and envelope artifacts sum columns and name both kinds',
    files: [
      { path: 'parent.jsonl', text: THREE_EVENT_ROLLOUT },
      { path: 'probe-effort.json', text: ENVELOPE },
    ],
    expected: {
      output: 342,
      input: 47,
      cached: 46236,
      basis: 'rollout last total_token_usage x1 + envelope usage x1',
      sources: [
        { path: 'parent.jsonl', kind: 'rollout', output: 3 },
        { path: 'probe-effort.json', kind: 'envelope', output: 339 },
      ],
    },
  },
  ...[
    { name: 'junk', path: 'junk.txt', text: 'not json at all' },
    { name: 'empty text', path: 'gone.jsonl', text: '' },
    {
      name: 'lane-B session JSONL without a verified usage event',
      path: '152928ba-f7fc-42df-b02a-d5dc4eef76b9.jsonl',
      text: [
        '{"type":"user","message":{"role":"user","content":"task"}}',
        '{"type":"assistant","message":{"role":"assistant","content":"done"}}',
      ].join('\n'),
    },
  ].map(({ name, path, text }): TokenCase => ({
    name: `${name} is unknown and contributes no columns`,
    files: [{ path, text }],
    expected: {
      output: null,
      input: null,
      cached: null,
      basis: 'unknown',
      sources: [{ path, kind: 'unknown', output: null }],
    },
  })),
  {
    name: 'a lane-B session file dedupes usage by message.id, last line wins, and sums the rest',
    files: [{ path: 'b59253a0.jsonl', text: SESSION_JSONL }],
    expected: {
      output: 49,
      input: 6,
      cached: 300,
      basis: 'session usage x1',
      sources: [{ path: 'b59253a0.jsonl', kind: 'session', output: 49 }],
    },
  },
  {
    name: 'mixed rollout and session artifacts sum columns and name both kinds',
    files: [
      { path: 'parent.jsonl', text: THREE_EVENT_ROLLOUT },
      { path: 'b59253a0.jsonl', text: SESSION_JSONL },
    ],
    expected: {
      output: 52,
      input: 36,
      cached: 312,
      basis: 'rollout last total_token_usage x1 + session usage x1',
      sources: [
        { path: 'parent.jsonl', kind: 'rollout', output: 3 },
        { path: 'b59253a0.jsonl', kind: 'session', output: 49 },
      ],
    },
  },
  {
    name: 'a missing last-event field stays null while the other last-event fields survive',
    files: [{ path: 'partial.jsonl', text: PARTIAL_ROLLOUT }],
    expected: {
      output: 5,
      input: 50,
      cached: null,
      basis: 'rollout last total_token_usage x1',
      sources: [{ path: 'partial.jsonl', kind: 'rollout', output: 5 }],
    },
  },
];

for (const row of CASES) {
  test(row.name, () => assert.deepEqual(tokensOf(row.files), row.expected));
}

test('oversize token artifacts warn and degrade to the existing unknown row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-tokens-cap-'));
  const path = join(dir, 'huge.jsonl');
  writeFileSync(path, '');
  truncateSync(path, 1_000_000_001); // sparse, pure node:fs; no 1GB allocation in the fixture
  const warnings: string[] = [];
  const report = tokensOf(readTokenArtifacts([path], warning => warnings.push(warning)));

  assert.deepEqual(report, {
    output: null,
    input: null,
    cached: null,
    basis: 'unknown',
    sources: [{ path, kind: 'unknown', output: null }],
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tokens cannot read.*1000000001 bytes \(cap 1000000000\)/);
});

test("readTokenArtifacts adds a lane-B session's sub-agent transcripts beside their parent (duel 414)", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'mr-tokens-subagents-'));
  const parent = join(tmp, 'parent.jsonl');
  const subagents = join(tmp, 'parent', 'subagents');
  const agentA = join(subagents, 'agent-a.jsonl');
  const agentB = join(subagents, 'agent-b.jsonl');
  const solo = join(tmp, 'solo.jsonl');
  writeFileSync(parent, SESSION_JSONL);
  mkdirSync(subagents, { recursive: true });
  writeFileSync(agentB, SESSION_JSONL);
  writeFileSync(agentA, SESSION_JSONL);
  writeFileSync(join(subagents, 'agent-a.meta.json'), 'metadata');
  writeFileSync(solo, SESSION_JSONL);

  assert.deepEqual(readTokenArtifacts([parent, solo]).map(f => f.path),
    [parent, agentA, agentB, solo]);
  assert.deepEqual(tokensOf(readTokenArtifacts([parent])), {
    output: 147,
    input: 18,
    cached: 900,
    basis: 'session usage x3',
    sources: [
      { path: parent, kind: 'session', output: 49 },
      { path: agentA, kind: 'session', output: 49 },
      { path: agentB, kind: 'session', output: 49 },
    ],
  });
  assert.deepEqual(tokensOf(readTokenArtifacts([solo])).sources,
    [{ path: solo, kind: 'session', output: 49 }]);
});
