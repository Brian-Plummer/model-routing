import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
// gpt-5.6-luna is here ONLY as the spark-closed backup (operator, 2026-08-20) — router.ts
// substitutes it when spark's pool is exhausted, and the launcher must not refuse the side.
// sol stays launchable after its 2026-09-05 retirement: a re-run or an operator re-pair may name it.
const CODEX_MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.3-codex-spark', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
const B_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

type Effort = typeof EFFORTS[number];
type BModel = typeof B_MODELS[number];

export interface CodexLaunchOptions {
  model: string;
  effort: Effort;
  cwd: string;
  promptFile: string;
  logFile: string;
  sandbox?: 'workspace-write' | 'read-only';
}

export interface BPackageOptions {
  model: BModel;
  task: string;
  workdir?: string;
  configDir?: string;
  effort?: Effort;
  readOnly?: boolean;
}

const includes = <T extends string>(values: readonly T[], value: string): value is T =>
  values.includes(value as T);
const shown = (value: unknown): string => JSON.stringify(value) ?? String(value);

function validateCodexPath(label: 'cwd' | 'promptFile' | 'logFile', value: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  if (!/^\/[A-Za-z0-9/._-]+$/.test(value)) {
    const bad = value.match(/[^A-Za-z0-9/._-]/)?.[0] ?? '';
    if (/\s/.test(bad)) {
      throw new Error(`${label} contains the whitespace character class; `
        + 'expected an absolute path matching ^/[A-Za-z0-9/._-]+$');
    }
    if (/[;&|<>$(){}[\]*?~#!`'"]/.test(bad)) {
      throw new Error(`${label} contains the shell-active character class (including quotes); `
        + 'expected an absolute path matching ^/[A-Za-z0-9/._-]+$');
    }
    throw new Error(`${label} contains a character outside the strict path allowlist; `
      + 'expected an absolute path matching ^/[A-Za-z0-9/._-]+$');
  }
}

export function buildCodexLaunch(opts: CodexLaunchOptions): { command: string } {
  if (!includes(EFFORTS, opts.effort)) {
    throw new Error(`invalid Codex effort ${shown(opts.effort)}; expected ${EFFORTS.join('|')}`);
  }
  if (!includes(CODEX_MODELS, opts.model)) {
    throw new Error(`invalid Codex model ${shown(opts.model)}; expected ${CODEX_MODELS.join('|')}`);
  }
  if (opts.sandbox !== undefined
    && opts.sandbox !== 'workspace-write' && opts.sandbox !== 'read-only') {
    throw new Error(`invalid sandbox ${shown(opts.sandbox)}; expected workspace-write|read-only`);
  }
  validateCodexPath('cwd', opts.cwd);
  validateCodexPath('promptFile', opts.promptFile);
  validateCodexPath('logFile', opts.logFile);

  const sandbox = opts.sandbox ?? 'workspace-write';
  return {
    // --skip-git-repo-check: codex exec refuses a cwd that is not inside a git repository ("Not
    // inside a trusted directory") and writes no rollout — duel 412's judge dir died at launch
    // on exactly that. Every launch cwd is a controller-made directory (a worktree or a judge
    // dir), so the trust check only adds a death shape.
    command: `nohup codex exec -C ${opts.cwd} -s ${sandbox} --skip-git-repo-check -m ${opts.model} `
      + `-c model_reasoning_effort=${opts.effort} "$(cat ${opts.promptFile})" `
      + `> ${opts.logFile} 2>&1 &`,
  };
}

function validateBPath(label: 'workdir' | 'configDir', value: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  if (/['"]/.test(value)) throw new Error(`${label} must not contain quote characters`);
}

export function buildBPackage(opts: BPackageOptions): { package: string } {
  if (!includes(B_MODELS, opts.model)) {
    throw new Error(`invalid B model ${shown(opts.model)}; expected ${B_MODELS.join('|')}`);
  }
  if (opts.effort !== undefined && !includes(EFFORTS, opts.effort)) {
    throw new Error(`invalid B effort ${shown(opts.effort)}; expected ${EFFORTS.join('|')}`);
  }
  if (opts.workdir !== undefined) validateBPath('workdir', opts.workdir);
  if (opts.configDir !== undefined) {
    validateBPath('configDir', opts.configDir);
    const lastSlash = opts.configDir.lastIndexOf('/');
    const parent = opts.configDir.slice(0, lastSlash) || '/';
    if (parent !== homedir()) {
      throw new Error('configDir parent must be the home directory');
    }
    const leaf = opts.configDir.slice(lastSlash + 1);
    if (!/^\.claude-[A-Za-z0-9_-]+$/.test(leaf)) {
      throw new Error('configDir leaf must match .claude-[A-Za-z0-9_-]+');
    }
  }
  if (opts.task.split(/\r?\n/).includes('CLAUDE_B_TASK')) {
    throw new Error('task contains a line exactly CLAUDE_B_TASK; '
      + 'the forwarder will need a suffixed delimiter');
  }
  if (opts.readOnly === true && opts.task.includes('CANNOT run build/test')) {
    throw new Error('read-only task must not contain "CANNOT run build/test"');
  }
  if (/^(Model|Workdir|ConfigDir|Effort|Mode):/.test(opts.task)) {
    throw new Error('task first line must not be header-shaped');
  }

  const headers = [`Model: ${opts.model}.`];
  if (opts.workdir !== undefined) headers.push(`Workdir: ${opts.workdir}.`);
  if (opts.configDir !== undefined) headers.push(`ConfigDir: ${opts.configDir}.`);
  if (opts.effort !== undefined) headers.push(`Effort: ${opts.effort}.`);
  // --read-only used to stop here; the forwarder inferred the permission mode and the
  // read-only grant from TASK prose (duel 391 M18). The header says it outright.
  if (opts.readOnly === true) headers.push('Mode: read-only.');
  return { package: `${headers.join('\n')}\n\n${opts.task}` };
}
