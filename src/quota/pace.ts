import type { Lane, LaneStatus, LaneUsage, WindowUsage } from '../types.js';

const HOUR = 3_600_000;
export const SOFT_PCT = 80;
export const HARD_PCT = 95;
export const BURN_WINDOW_MS = 24 * HOUR;
export const STALE_MS = 6 * HOUR;

export function pace(w: WindowUsage, now: number): number {
  const windowMs = w.windowMinutes * 60_000;
  const elapsedPct = (1 - (w.resetsAt - now) / windowMs) * 100;
  return w.utilization - Math.min(Math.max(elapsedPct, 0), 100);
}

// `model` asks for that model's own pool on top of the account windows: a hard-capped scoped
// pool closes the lane for that model (and a soft one vetoes duelling into it) while the
// account view stays open for every other model. Scoped windows never stand in for the
// account weekly (duel 391 M7). '[1m]' is a context size, not a pool.
export function laneStatus(
  u: LaneUsage | null, now: number, lane?: Lane, model?: string,
): LaneStatus {
  // Spark is metered like every other lane. The 2026-07-25 "unmetered" special-case is retired:
  // GPT-5.3-Codex-Spark bills its own model-specific pool now (weekly window, limit_name
  // "GPT-5.3-Codex-Spark"), and duel 268 died mid-task on usage_limit_exceeded while this
  // function reported the lane open — walkovers 269-272 followed on a lane that was closed.
  const stale = (l: Lane): LaneStatus => ({ lane: l, state: 'stale',
    weeklyUtilization: null, weeklyPace: null, resetsAt: null, shortUtilization: null });
  if (!u) return stale(lane ?? 'A');
  // No fallback to "whatever window we have": relabelling a 5h window as the weekly reported
  // 5h numbers as weekly and, because a 5h window always resets within 24h, pinned the lane to
  // `burn` forever. A payload with no weekly window simply has no weekly figures to report.
  // A window past its own reset describes usage that no longer exists. The parser keeps the
  // newest reading of EACH window size, so a tail whose last rate_limits line carries only the
  // 5h pool hands us a weekly reading from earlier in the session — which may since have reset.
  // Reporting it closed a lane on a pool sitting at ~0%, and only the burn branch checked.
  const live = u.windows.filter(w => w.resetsAt > now);
  const weekly = live.find(w => !w.model && w.windowMinutes >= 10080) ?? null;
  const short = live.find(w => !w.model && w.windowMinutes < 10080) ?? null;
  const pool = model ? live.find(w => w.model === model.replace(/\[.*$/, '').toLowerCase()) ?? null : null;
  // STALE_MS bounds how far a utilization ESTIMATE can be trusted forward — but a hard-capped
  // window is not an estimate. Utilization is monotonic within a window, so a ≥HARD_PCT reading
  // stays ≥HARD_PCT until the window's own reset, however old the reading is. Spark depends on
  // this: it reports a pool only from its own rollouts, and a closed spark cannot run to refresh
  // the reading — aging the closure out at STALE_MS cycled the lane
  // stale → routed → died-at-spawn every 6h.
  const over = (pct: number): boolean => [weekly, short, pool].some(w => w && w.utilization >= pct);
  const hardCapped = over(HARD_PCT);
  // The same monotonicity holds a SOFT reading: an 80-94% window cannot have lapsed before its
  // own reset, and aging it into `stale` (every field null) made the lane duelable again — the
  // exact veto `soft` exists to apply (duel 391 M5).
  if (!over(SOFT_PCT) && now - u.fetchedAt > STALE_MS) return stale(u.lane);
  if (!weekly && !short) return stale(u.lane);
  let state: LaneStatus['state'] = 'open';
  if (hardCapped) state = 'closed';
  // `soft` is tested BEFORE `burn`, and that order is the whole point: burn makes a lane
  // *preferred* (router.ts biases toward it and still duels into it), so any pool at or above
  // the soft line has to veto it. The burn test reads only the weekly window, so with the old
  // order a lane at 92% of its 5h pool — weekly under 80% and resetting within a day — came
  // back `burn`, and the router pulled work off a fully open lane onto the one about to 429.
  else if (over(SOFT_PCT)) state = 'soft';
  // resetsAt is already known to be ahead (expired windows are dropped above): an expired one
  // satisfies "< 24h to reset" by a negative margin, turning obsolete usage into a burn signal.
  // No utilization test needed here — the soft branch above already claimed every lane at or
  // over SOFT_PCT on either pool, so anything reaching this line has headroom on both.
  else if (weekly && weekly.resetsAt - now < BURN_WINDOW_MS) state = 'burn';
  return { lane: u.lane, state, weeklyUtilization: weekly?.utilization ?? null,
    // Neither figure is reported off an invented reset time — see parse.ts. Null means "unknown",
    // which the router treats as no signal; the fabricated pace it used to report was 0, and a
    // lane on schedule paces negative, so an untouched pool lost every comparison and shed its
    // work onto a busier lane. resetsAt goes with it: cli.ts already refuses to print a date
    // nobody measured, and quota_status was handing that same made-up date to the controller.
    weeklyPace: weekly && !weekly.synthetic ? pace(weekly, now) : null,
    // A pool closure surfaces the POOL's reset as the retry time — that is when the lane reopens.
    resetsAt: pool && pool.utilization >= HARD_PCT ? pool.resetsAt
      : weekly && !weekly.synthetic ? weekly.resetsAt : null,
    shortUtilization: short?.utilization ?? null,
    ...(pool ? { modelPool: { model: pool.model!, utilization: pool.utilization, resetsAt: pool.resetsAt } } : {}) };
}
