import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropicUsage, parseCodexRateLimits } from '../src/quota/parse.js';
import { laneStatus } from '../src/quota/pace.js';

// Real shape observed 2026-07-23 (fields beyond these exist and must be ignored)
const ANTHROPIC_FIXTURE = JSON.stringify({
  five_hour: { utilization: 16.0, resets_at: '2026-07-24T01:59:59.971781+00:00' },
  seven_day: { utilization: 3.0, resets_at: '2026-07-29T17:59:59.971803+00:00' },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: null },
});

// Real shape observed 2026-07-23 in ~/.codex/sessions JSONL (resets_at epoch SECONDS)
const CODEX_LINE = JSON.stringify({
  type: 'event_msg',
  payload: { info: { rate_limits: {
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 12.5, window_minutes: 10080, resets_at: 1785270463 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    plan_type: 'prolite', rate_limit_reached_type: null,
  } } },
});

test('parseAnthropicUsage extracts both windows', () => {
  const u = parseAnthropicUsage(ANTHROPIC_FIXTURE, 'A', 1000);
  assert.equal(u.lane, 'A');
  assert.equal(u.windows.length, 2);
  const [fiveH, sevenD] = u.windows;
  assert.deepEqual(
    { m: fiveH.windowMinutes, u: fiveH.utilization },
    { m: 300, u: 16.0 });
  assert.equal(fiveH.resetsAt, Date.parse('2026-07-24T01:59:59.971781+00:00'));
  assert.deepEqual(
    { m: sevenD.windowMinutes, u: sevenD.utilization },
    { m: 10080, u: 3.0 });
});

test('parseAnthropicUsage throws when no windows present', () => {
  assert.throws(() => parseAnthropicUsage('{"five_hour":null}', 'B', 0));
});

test('parseCodexRateLimits takes the last snapshot in the tail, converts seconds→ms', () => {
  const older = CODEX_LINE.replace('12.5', '2.0');
  const tail = ['garbage not json', older, CODEX_LINE, '{"no":"rate limits here"}'].join('\n');
  const list = parseCodexRateLimits(tail, 500);
  assert.equal(list.length, 1);
  assert.equal(list[0].lane, 'codex');
  assert.equal(list[0].windows[0].utilization, 12.5);
  assert.equal(list[0].windows[0].resetsAt, 1785270463000);
});

test('a later 5h-only reading does not discard the weekly window from earlier in the tail', () => {
  // codex emits the weekly pool as `secondary`, and not on every event. Keeping only the last
  // line's windows dropped it, and the lane then reported no weekly utilization, pace or burn.
  const limits = (rl: object) => JSON.stringify({ payload: { info: { rate_limits: rl } } });
  const both = limits({
    limit_id: 'codex',
    primary: { used_percent: 4, window_minutes: 300, resets_at: 1785270463 },
    secondary: { used_percent: 88, window_minutes: 10080, resets_at: 1785270463 },
  });
  const fiveHOnly = limits({
    limit_id: 'codex',
    primary: { used_percent: 9, window_minutes: 300, resets_at: 1785270463 },
  });
  const [u] = parseCodexRateLimits([both, fiveHOnly].join('\n'), 500);
  assert.equal(u.windows.find(w => w.windowMinutes === 10080)!.utilization, 88);
  assert.equal(u.windows.find(w => w.windowMinutes === 300)!.utilization, 9); // newest 5h reading
});

// limit_id is "codex" in every rollout, spark runs included (verified against real rollouts
// 2026-07-24), so the lane can only come from the caller — keying on limit_id kept spark
// permanently stale and let a spark tail overwrite the codex pool.
test('lane comes from the caller, not limit_id', () => {
  const spark = CODEX_LINE.replace('12.5', '42');
  assert.equal(parseCodexRateLimits(spark, 0, 'spark')[0].lane, 'spark');
  assert.equal(parseCodexRateLimits(spark, 0)[0].lane, 'codex'); // default
});

test('no rate_limits in the tail → no snapshot at all', () => {
  assert.deepEqual(parseCodexRateLimits('{"just":"chatter"}', 0, 'spark'), []);
});

test('a model switch inside the tail discards the pre-switch pool readings', () => {
  // spark bills a separate weekly pool, so a weekly window read before a `/model` switch
  // describes the OTHER lane's usage. Only readings after the last settings event stand.
  const rl = (primary: any, secondary: any = null) => JSON.stringify({
    type: 'event_msg', payload: { info: { rate_limits: { limit_id: 'codex', primary, secondary } } },
  });
  const settings = (model: string) => JSON.stringify({
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model } },
  });
  const tail = [
    rl({ used_percent: 10, window_minutes: 300, resets_at: 1785270463 },
       { used_percent: 99, window_minutes: 10080, resets_at: 1785270463 }),
    settings('gpt-5.3-codex-spark'),
    rl({ used_percent: 5, window_minutes: 300, resets_at: 1785270463 }),
  ].join('\n');
  const [u] = parseCodexRateLimits(tail, 1000, 'spark');
  assert.deepEqual(u.windows.map(w => w.windowMinutes), [300]);
  assert.equal(u.windows[0].utilization, 5);
});

test('an untouched pool parses as fully open, not as a missing window', () => {
  // Real lane B payload, 2026-07-25, right after its weekly pool reset: 0% and no resets_at.
  const u = parseAnthropicUsage(JSON.stringify({
    five_hour: { utilization: 0.0, resets_at: null, limit_dollars: null },
    seven_day: { utilization: 0.0, resets_at: null, limit_dollars: null },
  }), 'B', 1_000_000);
  assert.equal(u.windows.length, 2);
  assert.deepEqual(u.windows.map(w => w.utilization), [0, 0]);
  // Reset a full window out — the window has not started.
  assert.deepEqual(u.windows.map(w => w.resetsAt - 1_000_000), [300 * 60_000, 10080 * 60_000]);
  assert.deepEqual(u.windows.map(w => w.synthetic), [true, true]); // invented, and says so
  // The point of the whole thing: the lane reads OPEN, so the router will use it.
  const s = laneStatus(u, 1_000_000, 'B');
  assert.equal(s.state, 'open');
  // ...but no pace off an invented reset time. The 0 this used to report ("0% used, 0% elapsed")
  // beat every real lane's negative pace and steered work away from the untouched account.
  assert.equal(s.weeklyPace, null);
});

test('a null resets_at with real usage is still dropped — no reading is invented', () => {
  assert.throws(() => parseAnthropicUsage(JSON.stringify({
    five_hour: { utilization: 42, resets_at: null },
    seven_day: { utilization: 42, resets_at: null },
  }), 'B', 1_000_000), /no usage windows/);
});

test('a settings event re-stating the SAME model keeps accumulated readings', () => {
  // Every turn_context re-states the model. Clearing on each one meant a tail ending in a new
  // turn (reading, then turn_context, no token_count yet) parsed to NO snapshot, and the
  // poller fell back to an older session's lower usage (duel-62 sol#9).
  const rl = (primary: any, secondary: any = null) => JSON.stringify({
    type: 'event_msg', payload: { info: { rate_limits: { limit_id: 'codex', primary, secondary } } },
  });
  const settings = (model: string) => JSON.stringify({
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model } },
  });
  const tail = [
    settings('gpt-5.6-sol'),
    rl({ used_percent: 12, window_minutes: 300, resets_at: 1785270463 },
       { used_percent: 92, window_minutes: 10080, resets_at: 1785270463 }),
    settings('gpt-5.6-sol'), // new turn, same model — NOT a switch
  ].join('\n');
  const [u] = parseCodexRateLimits(tail, 1000);
  assert.ok(u, 'same-model settings event must not wipe the snapshot');
  assert.equal(u.windows.find(w => w.windowMinutes === 10080)!.utilization, 92);
  assert.equal(u.windows.find(w => w.windowMinutes === 300)!.utilization, 12);
});

test('parseAnthropicUsage: a model-scoped weekly limit becomes a model-tagged window (duel 391 M7)', () => {
  // Live shape observed 2026-09-02 on both accounts: `seven_day_<model>` keys are all null; the
  // fable pool travels ONLY in `limits[]` as kind weekly_scoped with scope.model.display_name.
  // Seven fable-B sides died at spawn on a 429 the account-wide windows (66-75%) never showed.
  const reset = '2026-09-05T04:59:59.872507+00:00';
  const limits = (extra: unknown[]) => JSON.stringify({
    five_hour: { utilization: 37, resets_at: '2026-09-02T18:59:59.872272+00:00' },
    seven_day: { utilization: 7, resets_at: '2026-09-05T04:59:59.872289+00:00' },
    seven_day_opus: null,
    limits: [
      { kind: 'session', group: 'session', percent: 37, resets_at: reset, scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 7, resets_at: reset, scope: null },
      ...extra,
    ],
  });
  const fable = { kind: 'weekly_scoped', group: 'weekly', percent: 100, resets_at: reset,
    scope: { model: { id: null, display_name: 'Fable' }, surface: null } };
  const rows: [string, string, Array<{ model: string; utilization: number; resetsAt: number }>][] = [
    ['current schema: scoped fable limit', limits([fable]),
      [{ model: 'fable', utilization: 100, resetsAt: Date.parse(reset) }]],
    ['previous schema: no limits array at all', ANTHROPIC_FIXTURE, []],
    ['legacy: scoped entry with no reset time is not a reading', limits([{ ...fable, resets_at: null }]), []],
    ['legacy: scoped entry without a percent', limits([{ ...fable, percent: null }]), []],
    ['unscoped and session entries never become model windows', limits([]), []],
  ];
  for (const [label, json, expected] of rows) {
    const u = parseAnthropicUsage(json, 'B', 1000);
    // the account windows are untouched by the scan
    assert.deepEqual(u.windows.filter(w => !w.model).map(w => w.windowMinutes), [300, 10080], label);
    assert.deepEqual(u.windows.filter(w => w.model).map(w =>
      ({ model: w.model!, utilization: w.utilization, resetsAt: w.resetsAt })), expected, label);
    for (const w of u.windows.filter(w => w.model)) assert.equal(w.windowMinutes, 10080, label);
  }
});
