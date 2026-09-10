import type { Lane, LaneUsage, WindowUsage } from '../types.js';

export function parseAnthropicUsage(json: string, lane: Lane, fetchedAt: number): LaneUsage {
  const raw = JSON.parse(json);
  const windows: WindowUsage[] = [];
  const keys: Array<[string, number]> = [['five_hour', 300], ['seven_day', 10080]];
  for (const [key, windowMinutes] of keys) {
    const w = raw[key];
    if (!w || typeof w.utilization !== 'number') continue;
    if (typeof w.resets_at === 'string') {
      windows.push({ windowMinutes, utilization: w.utilization, resetsAt: Date.parse(w.resets_at) });
    } else if (w.resets_at == null && w.utilization === 0) {
      // An untouched pool reports no reset time, because no window is running yet. Dropping it
      // made a zero-usage account parse to "no windows at all" — which surfaces as `stale`, the
      // one state the router will not send work to. Lane B hit exactly that after its weekly
      // pool reset: fully open, and unable to get used because it looked unknown.
      // A window that has not started resets at most a full window out, which is what the burn
      // test wants; guarded on utilization===0 so a real reading is never invented.
      // Flagged synthetic, because that assumed reset time is not a fact: pace() would read it as
      // "0% used, 0% elapsed" = pace 0, and an untouched lane then lost every pace comparison to
      // one that is merely on schedule. A number we made up must not price the lane.
      windows.push({
        windowMinutes, utilization: 0, resetsAt: fetchedAt + windowMinutes * 60_000,
        synthetic: true,
      });
    }
  }
  // Model-scoped pools travel only in `limits[]` (kind weekly_scoped, scope.model.display_name);
  // every `seven_day_<model>` key reads null on both accounts (2026-09-02). Seven fable-B sides
  // died at spawn on a pool the account windows never showed (duel 391 M7). No synthetic reset
  // here: a scoped entry without one carries no closure, and closure is all this window is for.
  for (const l of Array.isArray(raw.limits) ? raw.limits : []) {
    const name = l?.scope?.model?.display_name;
    if (l?.group !== 'weekly' || typeof name !== 'string' || typeof l.percent !== 'number'
        || typeof l.resets_at !== 'string') continue;
    windows.push({ windowMinutes: 10080, utilization: l.percent, resetsAt: Date.parse(l.resets_at),
      model: name.toLowerCase() });
  }
  if (windows.length === 0) throw new Error(`no usage windows in payload for lane ${lane}`);
  return { lane, fetchedAt, windows };
}

// The model a settings line names, or undefined for every other line. Both shapes occur in real
// rollouts: `thread_settings_applied` carries it nested, `turn_context` carries it flat.
export function modelOf(line: string): string | undefined {
  if (!line.includes('"model"')) return undefined;
  let o: any;
  try { o = JSON.parse(line); } catch { return undefined; } // truncated edge line of a slice
  const p = o?.payload ?? {};
  const m = p.thread_settings?.model ?? p.model;
  return typeof m === 'string' && m.startsWith('gpt-') ? m : undefined;
}

// Last settings event in the slice wins: `/model` mid-session emits another one.
export function lastModelIn(slice: string): string | undefined {
  let model: string | undefined;
  for (const line of slice.split('\n')) model = modelOf(line) ?? model;
  return model;
}

const asWindow = (w: any): WindowUsage | null =>
  w && typeof w.used_percent === 'number' && w.window_minutes && w.resets_at
    ? { windowMinutes: w.window_minutes, utilization: w.used_percent, resetsAt: w.resets_at * 1000 }
    : null;

// The lane comes from the caller (poll.ts reads the rollout's model), never from `limit_id`:
// every codex-family rollout reports limit_id "codex", spark runs included, so keying on it
// left spark permanently stale AND let a spark tail overwrite the codex snapshot with spark's
// pool. Returns [] when the tail carries no rate_limits at all.
export function parseCodexRateLimits(
  jsonlTail: string, fetchedAt: number, lane: Lane = 'codex',
): LaneUsage[] {
  // Newest reading of EACH window size, not the last line's set. A final event carrying only
  // the 5h pool used to discard a weekly reading present earlier in the same tail, and the
  // lane then reports no weekly figures at all — no utilization, no pace, no burn signal.
  const latest = new Map<number, WindowUsage>();
  let current: string | undefined;
  for (const line of jsonlTail.split('\n')) {
    // A `/model` switch invalidates every pool reading before it: the new model may bill a
    // different weekly pool (spark's is separate), so carrying a pre-switch window forward
    // attributes one lane's usage to the other. Readings after the LAST switch stand — but
    // only a CHANGE of model is a switch: every turn_context re-states the model, and clearing
    // on each one discarded same-model readings whenever the tail ended in a new turn, leaving
    // the rollout with no snapshot and the poller falling back to an older session's usage
    // (duel-62 sol#9).
    const m = modelOf(line);
    if (m) {
      // Readings that precede the first model sighting in the slice have unknown provenance —
      // the same caution as a real switch applies to them.
      if (m !== current && (current !== undefined || latest.size > 0)) latest.clear();
      current = m;
      continue;
    }
    if (!line.includes('"rate_limits"')) continue;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { continue; }
    const rl = findRateLimits(obj);
    // Both windows: codex reports the 5h pool as `primary` and the weekly as `secondary`.
    // Keeping only `primary` let a 96%-used weekly pool be reported as a 10%-used "weekly".
    for (const w of [asWindow(rl?.primary), asWindow(rl?.secondary)]) {
      if (w) latest.set(w.windowMinutes, w);
    }
  }
  return latest.size ? [{ lane, fetchedAt, windows: [...latest.values()] }] : [];
}

function findRateLimits(node: any): any {
  if (node == null || typeof node !== 'object') return null;
  if (node.rate_limits) return node.rate_limits;
  for (const v of Object.values(node)) {
    const hit = findRateLimits(v);
    if (hit) return hit;
  }
  return null;
}
