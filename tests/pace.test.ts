import test from 'node:test';
import assert from 'node:assert/strict';
import { pace, laneStatus, SOFT_PCT, HARD_PCT } from '../src/quota/pace.js';
import type { LaneUsage } from '../src/types.js';

const HOUR = 3_600_000;
const WEEK_MIN = 10080, WEEK_MS = WEEK_MIN * 60_000;
const NOW = 1_800_000_000_000;

const usage = (weeklyPct: number, msToReset: number, fiveHourPct?: number): LaneUsage => ({
  lane: 'A', fetchedAt: NOW,
  windows: [
    ...(fiveHourPct === undefined ? [] :
      [{ windowMinutes: 300, utilization: fiveHourPct, resetsAt: NOW + 2 * HOUR }]),
    { windowMinutes: WEEK_MIN, utilization: weeklyPct, resetsAt: NOW + msToReset },
  ],
});

test('pace: half window elapsed, 25% used → -25', () => {
  const p = pace({ windowMinutes: WEEK_MIN, utilization: 25, resetsAt: NOW + WEEK_MS / 2 }, NOW);
  assert.equal(Math.round(p), -25);
});

test('open lane below all thresholds', () => {
  const s = laneStatus(usage(30, WEEK_MS / 2, 10), NOW);
  assert.equal(s.state, 'open');
  assert.equal(s.weeklyUtilization, 30);
});

test('soft when 5h window at 80', () => {
  assert.equal(laneStatus(usage(30, WEEK_MS / 2, SOFT_PCT), NOW).state, 'soft');
});

test('codex-style weekly-only lane goes soft on weekly 80', () => {
  assert.equal(laneStatus(usage(85, WEEK_MS / 2), NOW).state, 'soft');
});

test('burn: <24h to weekly reset and under 80', () => {
  assert.equal(laneStatus(usage(50, 23 * HOUR, 10), NOW).state, 'burn');
});

test('no burn when already ≥80 near reset — soft instead', () => {
  assert.equal(laneStatus(usage(85, 23 * HOUR, 10), NOW).state, 'soft');
});

test('closed at weekly 95 even near reset', () => {
  assert.equal(laneStatus(usage(95, 23 * HOUR, 10), NOW).state, 'closed');
});

test('closed when 5h window hits 95, even with low weekly utilization', () => {
  assert.equal(laneStatus(usage(30, WEEK_MS / 2, HARD_PCT), NOW).state, 'closed');
});

test('a payload with only a 5h window reports no weekly figures and never burns', () => {
  const fiveHourOnly: LaneUsage = { lane: 'codex', fetchedAt: NOW, windows: [
    { windowMinutes: 300, utilization: 12, resetsAt: NOW + 2 * HOUR },
  ] };
  const s = laneStatus(fiveHourOnly, NOW);
  // relabelling the 5h window as the weekly reported 5h numbers as weekly and, since a 5h
  // window always resets inside 24h, pinned the lane to 'burn' forever
  assert.equal(s.state, 'open');
  assert.equal(s.weeklyUtilization, null);
  assert.equal(s.weeklyPace, null);
  assert.equal(s.resetsAt, null);
  // thresholds still apply to the short window alone
  assert.equal(laneStatus({ ...fiveHourOnly, windows: [
    { windowMinutes: 300, utilization: SOFT_PCT, resetsAt: NOW + 2 * HOUR }] }, NOW).state, 'soft');
  assert.equal(laneStatus({ ...fiveHourOnly, windows: [
    { windowMinutes: 300, utilization: HARD_PCT, resetsAt: NOW + 2 * HOUR }] }, NOW).state, 'closed');
});

test('stale when snapshot older than 6h or missing', () => {
  const old = { ...usage(10, WEEK_MS / 2), fetchedAt: NOW - 7 * HOUR };
  assert.equal(laneStatus(old, NOW).state, 'stale');
  assert.equal(laneStatus(null, NOW, 'codex').state, 'stale');
  assert.equal(laneStatus(null, NOW, 'codex').lane, 'codex');
});

test('an expired window is not current data — it neither closes the lane nor reports a figure', () => {
  // A tail whose newest rate_limits line carries only the 5h pool keeps the weekly reading from
  // earlier in the file. If that weekly has since reset, reporting it locks the lane out of
  // routing on usage that no longer exists.
  const s = laneStatus({ lane: 'codex', fetchedAt: NOW, windows: [
    { windowMinutes: WEEK_MIN, utilization: 96, resetsAt: NOW - HOUR },
    { windowMinutes: 300, utilization: 3, resetsAt: NOW + HOUR },
  ] }, NOW, 'codex');
  assert.equal(s.state, 'open');
  assert.equal(s.weeklyUtilization, null);
  assert.equal(s.shortUtilization, 3);
});

test('a nearly-exhausted 5h pool is soft, never burn — burn makes a lane preferred', () => {
  // The burn test reads only the weekly window, so with `burn` evaluated first a lane at 92% of
  // its 5h pool came back `burn` whenever the weekly sat under SOFT_PCT and reset within a day.
  // burn is a *preference* signal (router biases toward it and still duels into it), so the
  // router pulled work onto the lane that was about to 429.
  const s = laneStatus(usage(50, 23 * HOUR, 92), NOW, 'A');
  assert.equal(s.state, 'soft');
  assert.equal(s.shortUtilization, 92);
  // with both pools clear, the same near-reset weekly is still a genuine burn signal
  assert.equal(laneStatus(usage(50, 23 * HOUR, 5), NOW, 'A').state, 'burn');
  // and a hard-capped 5h pool still closes the lane outright
  assert.equal(laneStatus(usage(50, 23 * HOUR, HARD_PCT), NOW, 'A').state, 'closed');
});

test('spark is metered like every other lane — duel 268 died on its real pool', () => {
  // The 2026-07-25 "unmetered" decision is retired: GPT-5.3-Codex-Spark bills its own
  // model-specific pool now (limit_name "GPT-5.3-Codex-Spark", weekly window), and duel 268
  // hit usage_limit_exceeded mid-task while this function reported the lane open.
  const table: Array<[LaneUsage | null, string, string]> = [
    [{ ...usage(99, WEEK_MS / 2), lane: 'spark' }, 'closed', 'hot pool gates the lane'],
    [null, 'stale', 'no reading is unknown, not open'],
    [{ ...usage(0, WEEK_MS), lane: 'spark', fetchedAt: NOW - 30 * HOUR }, 'stale',
      'aged low-utilization reading expires like any lane'],
  ];
  for (const [u, want, why] of table) {
    assert.equal(laneStatus(u, NOW, 'spark').state, want, why);
  }
});

test('a hard-capped reading holds the lane closed until its own reset, even past STALE_MS', () => {
  // Utilization is monotonic within a window: a ≥HARD_PCT reading stays ≥HARD_PCT until the
  // window resets, however old the reading is. Spark depends on this — it reports a pool only
  // from its own rollouts and a closed spark cannot run, so without it the lane cycled
  // stale → routed → died-at-spawn every STALE_MS (duel 268's shape, walkovers 269-272).
  const aged: LaneUsage = {
    ...usage(100, 26 * HOUR), lane: 'spark', fetchedAt: NOW - 30 * HOUR,
  };
  const st = laneStatus(aged, NOW, 'spark');
  assert.equal(st.state, 'closed');
  assert.equal(st.weeklyUtilization, 100);
  assert.equal(st.resetsAt, NOW + 26 * HOUR); // CLOSED-until surfaces the retry time
  // once the capped window itself has reset, the reading describes usage that no longer exists
  const expired: LaneUsage = {
    lane: 'spark', fetchedAt: NOW - 30 * HOUR,
    windows: [{ windowMinutes: WEEK_MIN, utilization: 100, resetsAt: NOW - HOUR }],
  };
  assert.equal(laneStatus(expired, NOW, 'spark').state, 'stale');
});

test('an untouched pool reports no reset time either — not the one parse.ts invented', () => {
  // parse.ts fabricates resetsAt for a window that has not started (the API sends none), and
  // flags it synthetic so pace() is withheld. The date is exactly as made-up as the pace, and
  // laneStatus was still handing it out: `mrctl` refuses to print it, but quota_status showed
  // the controller a lane-B reset date of fetchedAt + 7d as if it had been measured.
  const untouched: LaneUsage = {
    lane: 'B', fetchedAt: NOW,
    windows: [{ windowMinutes: WEEK_MIN, utilization: 0, resetsAt: NOW + WEEK_MS, synthetic: true }],
  };
  const st = laneStatus(untouched, NOW, 'B');
  assert.equal(st.state, 'open');
  assert.equal(st.weeklyUtilization, 0); // the one figure that IS a reading
  assert.equal(st.weeklyPace, null);
  assert.equal(st.resetsAt, null);
  // A real reading of the same shape still reports its date.
  assert.equal(laneStatus(usage(0, WEEK_MS), NOW, 'B').resetsAt, NOW + WEEK_MS);
});

test('laneStatus: a hard-capped model pool closes the lane for THAT model only (duel 391 M7)', () => {
  // The account windows read open while the fable pool is exhausted — the shape behind seven
  // fable-B spawn deaths. The scoped window never stands in for the account weekly, and a
  // capped reading holds until the pool's own reset, exactly like the account windows.
  const withFable = (pct: number, fetchedAt = NOW): LaneUsage => ({
    ...usage(7, WEEK_MS / 2, 37), lane: 'B', fetchedAt,
    windows: [...usage(7, WEEK_MS / 2, 37).windows,
      { windowMinutes: WEEK_MIN, utilization: pct, resetsAt: NOW + 26 * HOUR, model: 'fable' }],
  });
  const rows: [string, LaneUsage, string | undefined, string, number | null][] = [
    ['no model asked: account view, open', withFable(100), undefined, 'open', 7],
    ['another model: open', withFable(100), 'opus', 'open', 7],
    ['fable at 100: closed', withFable(100), 'fable', 'closed', 7],
    ['fable[1m] bills the fable pool', withFable(100), 'fable[1m]', 'closed', 7],
    ['fable at 85: soft', withFable(85), 'fable', 'soft', 7],
    ['fable at 32: open', withFable(32), 'fable', 'open', 7],
    ['capped fable reading outlives STALE_MS', withFable(100, NOW - 30 * HOUR), 'fable', 'closed', 7],
    ['uncapped stale reading is stale', withFable(32, NOW - 30 * HOUR), 'fable', 'stale', null],
  ];
  for (const [label, u, model, state, weekly] of rows) {
    const st = laneStatus(u, NOW, 'B', model);
    assert.equal(st.state, state, label);
    assert.equal(st.weeklyUtilization, weekly, label);
  }
  // CLOSED-until surfaces the POOL's retry time, and the pool reading rides along for the note
  const closed = laneStatus(withFable(100), NOW, 'B', 'fable');
  assert.equal(closed.resetsAt, NOW + 26 * HOUR);
  assert.deepEqual(closed.modelPool, { model: 'fable', utilization: 100, resetsAt: NOW + 26 * HOUR });
  assert.equal(laneStatus(withFable(100), NOW, 'B').modelPool, undefined);
});

test('a live soft reading holds until its window resets, even past STALE_MS (duel 391 M5)', () => {
  // Utilization is monotonic within a live window — the hard-cap hold's own argument — so an
  // 80-94% reading cannot have lapsed before its reset. Aging it into `stale` (every field
  // null) made the lane duelable again, the exact veto `soft` exists to apply.
  const aged = (u: LaneUsage): LaneUsage => ({ ...u, fetchedAt: NOW - 30 * HOUR });
  const rows: [string, LaneUsage, string | undefined, string, number | null][] = [
    ['aged soft weekly holds', aged(usage(85, 26 * HOUR)), undefined, 'soft', 85],
    ['aged soft 5h window whose window has since reset is stale', aged({ ...usage(10, 26 * HOUR),
      windows: [{ windowMinutes: 300, utilization: 85, resetsAt: NOW - HOUR },
        ...usage(10, 26 * HOUR).windows] }), undefined, 'stale', null],
    ['aged open reading is stale', aged(usage(30, 26 * HOUR)), undefined, 'stale', null],
    ['composed with M7: aged soft model pool holds', aged({ ...usage(10, 26 * HOUR), lane: 'B',
      windows: [...usage(10, 26 * HOUR).windows,
        { windowMinutes: WEEK_MIN, utilization: 85, resetsAt: NOW + 26 * HOUR, model: 'fable' }] }),
    'fable', 'soft', 10],
  ];
  for (const [label, u, model, state, weekly] of rows) {
    const st = laneStatus(u, NOW, u.lane, model);
    assert.equal(st.state, state, label);
    assert.equal(st.weeklyUtilization, weekly, label);
  }
});
