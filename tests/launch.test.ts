import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildBPackage, buildCodexLaunch } from '../src/launch.js';

const homeConfig = join(homedir(), '.claude-duel246');

const codexBase = {
  model: 'gpt-6-astra',
  effort: 'xhigh' as const,
  cwd: '/work/duel246',
  promptFile: '/work/duel246/brief.md',
  logFile: '/work/duel246/codex.log',
};

const goldenRows: Array<{
  name: string;
  actual: () => string;
  expected: string;
}> = [
  {
    // --skip-git-repo-check on every codex launch (v2.13.89): duel 412's judge dir was not a git
    // repository and codex exec died at launch with no rollout.
    name: 'codex workspace-write default',
    actual: () => buildCodexLaunch(codexBase).command,
    expected: 'nohup codex exec -C /work/duel246 -s workspace-write --skip-git-repo-check -m gpt-6-astra '
      + '-c model_reasoning_effort=xhigh "$(cat /work/duel246/brief.md)" '
      + '> /work/duel246/codex.log 2>&1 &',
  },
  {
    name: 'codex read-only explicit',
    actual: () => buildCodexLaunch({
      ...codexBase,
      model: 'gpt-5.3-codex-spark',
      effort: 'high',
      sandbox: 'read-only',
    }).command,
    expected: 'nohup codex exec -C /work/duel246 -s read-only --skip-git-repo-check -m gpt-5.3-codex-spark '
      + '-c model_reasoning_effort=high "$(cat /work/duel246/brief.md)" '
      + '> /work/duel246/codex.log 2>&1 &',
  },
  {
    // luna is the spark-closed backup (operator, 2026-08-20) — launch must emit it, or the
    // route's substituted side dies at the launcher while the duel row already exists.
    name: 'codex luna backup',
    actual: () => buildCodexLaunch({
      ...codexBase,
      model: 'gpt-5.6-luna',
      effort: 'high',
    }).command,
    expected: 'nohup codex exec -C /work/duel246 -s workspace-write --skip-git-repo-check -m gpt-5.6-luna '
      + '-c model_reasoning_effort=high "$(cat /work/duel246/brief.md)" '
      + '> /work/duel246/codex.log 2>&1 &',
  },
  {
    name: 'B minimal package',
    actual: () => buildBPackage({ model: 'haiku', task: 'Summarize the packet.' }).package,
    expected: 'Model: haiku.\n\nSummarize the packet.',
  },
  {
    name: 'B full-header package',
    actual: () => buildBPackage({
      model: 'opus',
      task: 'Implement the scoped change.',
      workdir: '/work/duel246',
      configDir: homeConfig,
      effort: 'xhigh',
    }).package,
    expected: `Model: opus.\nWorkdir: /work/duel246.\nConfigDir: ${homeConfig}.\n`
      + 'Effort: xhigh.\n\nImplement the scoped change.',
  },
  {
    // duel 391 M18: --read-only used to stop at the launcher; the forwarder inferred the
    // permission mode and the read-only grant from TASK prose. The header carries it now.
    name: 'B read-only package carries the Mode header, no launcher grant',
    actual: () => buildBPackage({
      model: 'fable',
      task: 'Review the supplied diff.',
      readOnly: true,
    }).package,
    expected: 'Model: fable.\nMode: read-only.\n\nReview the supplied diff.',
  },
];

for (const row of goldenRows) {
  test(`launch golden: ${row.name}`, () => assert.equal(row.actual(), row.expected));
}

// sol retired as a contestant 2026-09-05 but stays launchable: re-runs and operator re-pairs.
test('launch accepts the retired gpt-5.6-sol', () => {
  assert.doesNotThrow(() => buildCodexLaunch({ ...codexBase, model: 'gpt-5.6-sol' }));
});

const refusalRows: Array<{
  name: string;
  build: () => unknown;
  message: RegExp;
}> = [
  {
    name: 'codex effort max',
    build: () => buildCodexLaunch({ ...codexBase, effort: 'max' as any }),
    message: /codex effort.*max/i,
  },
  {
    name: 'codex effort ultra',
    build: () => buildCodexLaunch({ ...codexBase, effort: 'ultra' as any }),
    message: /codex effort.*ultra/i,
  },
  {
    name: 'unknown codex model slug',
    build: () => buildCodexLaunch({ ...codexBase, model: 'gpt-5.6-slo' }),
    message: /codex model.*gpt-5\.6-slo/i,
  },
  {
    name: 'invalid codex sandbox',
    build: () => buildCodexLaunch({ ...codexBase, sandbox: 'danger-full-access' as any }),
    message: /sandbox.*workspace-write.*read-only/i,
  },
  {
    name: 'relative cwd',
    build: () => buildCodexLaunch({ ...codexBase, cwd: 'work/duel246' }),
    message: /cwd.*absolute/i,
  },
  {
    name: 'relative prompt file',
    build: () => buildCodexLaunch({ ...codexBase, promptFile: 'brief.md' }),
    message: /promptFile.*absolute/i,
  },
  {
    name: 'relative log file',
    build: () => buildCodexLaunch({ ...codexBase, logFile: 'codex.log' }),
    message: /logFile.*absolute/i,
  },
  {
    name: 'quoted codex path',
    build: () => buildCodexLaunch({ ...codexBase, promptFile: "/work/duel'246/brief.md" }),
    message: /promptFile.*quote/i,
  },
  {
    name: 'whitespace codex path',
    build: () => buildCodexLaunch({ ...codexBase, logFile: '/work/duel246/codex run.log' }),
    message: /logFile.*whitespace/i,
  },
  ...[
    ['semicolon', '/work/duel246/codex.log;id'],
    ['pipe', '/work/duel246/codex.log|id'],
    ['command substitution', '/work/duel246/$(id).log'],
    ['backtick', '/work/duel246/`id`.log'],
    ['redirect', '/work/duel246/>owned.log'],
  ].map(([name, logFile]) => ({
    name: `shell-active codex log path: ${name}`,
    build: () => buildCodexLaunch({ ...codexBase, logFile }),
    message: /logFile.*shell-active character class/i,
  })),
  {
    name: 'unknown B tier',
    build: () => buildBPackage({ model: 'grand' as any, task: 'Review.' }),
    message: /B model.*grand/i,
  },
  {
    name: 'invalid B effort',
    build: () => buildBPackage({ model: 'sonnet', effort: 'ultra' as any, task: 'Review.' }),
    message: /B effort.*ultra/i,
  },
  {
    name: 'relative B workdir',
    build: () => buildBPackage({ model: 'sonnet', workdir: 'work/duel246', task: 'Review.' }),
    message: /workdir.*absolute/i,
  },
  {
    name: 'quoted B workdir',
    build: () => buildBPackage({ model: 'sonnet', workdir: '/work/duel"246', task: 'Review.' }),
    message: /workdir.*quote/i,
  },
  {
    name: 'relative B configDir',
    build: () => buildBPackage({ model: 'sonnet', configDir: '.claude-b', task: 'Review.' }),
    message: /configDir.*absolute/i,
  },
  {
    name: 'quoted B configDir',
    build: () => buildBPackage({
      model: 'sonnet', configDir: `${homeConfig}'x`, task: 'Review.',
    }),
    message: /configDir.*quote/i,
  },
  {
    name: 'bad configDir parent',
    build: () => buildBPackage({
      model: 'sonnet', configDir: join(homedir(), 'nested', '.claude-b'), task: 'Review.',
    }),
    message: /configDir parent.*home/i,
  },
  {
    name: 'bad configDir leaf',
    build: () => buildBPackage({
      model: 'sonnet', configDir: join(homedir(), '.claude-b.bak'), task: 'Review.',
    }),
    message: /configDir leaf.*\.claude-/i,
  },
  {
    name: 'CLAUDE_B_TASK delimiter line',
    build: () => buildBPackage({ model: 'fable', task: 'Review this:\nCLAUDE_B_TASK\nSafely.' }),
    message: /forwarder.*suffixed delimiter/i,
  },
  {
    name: 'read-only courier test-gate line',
    build: () => buildBPackage({
      model: 'fable', task: 'You CANNOT run build/test/commit.', readOnly: true,
    }),
    message: /read-only.*CANNOT run build\/test/i,
  },
  {
    name: 'header-shaped first task line',
    build: () => buildBPackage({ model: 'fable', task: 'Effort: high.\nReview this.' }),
    message: /first line.*header/i,
  },
  {
    name: 'Mode-shaped first task line',
    build: () => buildBPackage({ model: 'fable', task: 'Mode: read-only.\nReview this.' }),
    message: /first line.*header/i,
  },
];

for (const row of refusalRows) {
  test(`launch refusal: ${row.name}`, () => assert.throws(row.build, row.message));
}
