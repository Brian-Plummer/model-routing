export type TokenReport = {
  output: number | null;
  input: number | null;
  cached: number | null;
  basis: string;
  sources: { path: string; kind: 'rollout' | 'envelope' | 'session' | 'unknown'; output: number | null }[];
};

type Kind = TokenReport['sources'][number]['kind'];
type Counts = { output: number | null; input: number | null; cached: number | null };
type Classified = Counts & { kind: Kind };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const countOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function envelopeOf(text: string): Classified | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || !isObject(parsed.usage)) return null;
    return {
      kind: 'envelope',
      output: countOf(parsed.usage.output_tokens),
      input: countOf(parsed.usage.input_tokens),
      cached: countOf(parsed.usage.cache_read_input_tokens),
    };
  } catch {
    return null;
  }
}

function rolloutOf(text: string): Classified | null {
  let last: Record<string, unknown> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed) || !isObject(parsed.payload) || !isObject(parsed.payload.info)) continue;
      const usage = parsed.payload.info.total_token_usage;
      if (isObject(usage)) last = usage;
    } catch {
      // A malformed line does not erase a valid cumulative event elsewhere in the artifact.
    }
  }
  if (last === null) return null;
  return {
    kind: 'rollout',
    output: countOf(last.output_tokens),
    input: countOf(last.input_tokens),
    cached: countOf(last.cached_input_tokens),
  };
}

// Lane-B (headless Claude Code) session files: JSONL lines carrying message.usage. One API
// response writes one line per content block, all with the same message.id and usage — and a
// stream update can rewrite an id's usage on a later line — so dedupe by id, last wins, then
// sum. A naive sum double-counted a real artifact 128k vs its true (envelope-verified) 67.6k.
function sessionOf(text: string): Classified | null {
  const byId = new Map<string, Record<string, unknown>>();
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    line++;
    if (!raw.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed) || !isObject(parsed.message)) continue;
      const usage = parsed.message.usage;
      if (!isObject(usage)) continue;
      const id = typeof parsed.message.id === 'string' ? parsed.message.id : `line:${line}`;
      byId.set(id, usage);
    } catch {
      // A malformed line does not erase valid usage elsewhere in the artifact.
    }
  }
  if (byId.size === 0) return null;
  const usages = [...byId.values()];
  const total = (key: string) => sum(usages.map(usage => countOf(usage[key])));
  return {
    kind: 'session',
    output: total('output_tokens'),
    input: total('input_tokens'),
    cached: total('cache_read_input_tokens'),
  };
}

function classify(text: string): Classified {
  return envelopeOf(text) ?? rolloutOf(text) ?? sessionOf(text) ?? {
    kind: 'unknown', output: null, input: null, cached: null,
  };
}

function sum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

export function tokensOf(files: { path: string; text: string }[]): TokenReport {
  const classified = files.map(file => ({ path: file.path, ...classify(file.text) }));
  const contributed = classified.filter(file =>
    file.output !== null || file.input !== null || file.cached !== null);
  const rolloutCount = contributed.filter(file => file.kind === 'rollout').length;
  const envelopeCount = contributed.filter(file => file.kind === 'envelope').length;
  const sessionCount = contributed.filter(file => file.kind === 'session').length;
  const basis = [
    rolloutCount ? `rollout last total_token_usage x${rolloutCount}` : null,
    envelopeCount ? `envelope usage x${envelopeCount}` : null,
    sessionCount ? `session usage x${sessionCount}` : null,
  ].filter((part): part is string => part !== null).join(' + ') || 'unknown';

  return {
    output: sum(classified.map(file => file.output)),
    input: sum(classified.map(file => file.input)),
    cached: sum(classified.map(file => file.cached)),
    basis,
    sources: classified.map(file => ({ path: file.path, kind: file.kind, output: file.output })),
  };
}
