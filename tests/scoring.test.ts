import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVerdict, passingSides } from '../src/scoring.js';

const MAP = { X: 'anthropic', Y: 'openai' } as const;
// anth is the FASTER side by default (100 vs 200) so a wrong fall-through to the clock is visible.
const m = (anthTokens: number, gptTokens: number, anthLatencyMs = 100, gptLatencyMs = 200) =>
  ({ anthTokens, gptTokens, anthLatencyMs, gptLatencyMs });

test('passingSides decodes every token, including the legacy tie spelling', () => {
  assert.deepEqual([...passingSides('X')], ['X']);
  assert.deepEqual([...passingSides('Y')], ['Y']);
  assert.deepEqual([...passingSides('both')].sort(), ['X', 'Y']);
  assert.deepEqual([...passingSides('neither')], []);
  // 'tie' is the pre-v2.11.0 preference spelling; it asserted no side failed, so it reads as 'both'.
  assert.deepEqual([...passingSides('tie')].sort(), ['X', 'Y']);
  // an unrecognized token clears nobody — an unreadable grade is not a pass
  assert.deepEqual([...passingSides('garbage')], []);
});

test('exactly one side passes → that side wins on quality, clock ignored', () => {
  // Y is the SLOWER side and still wins: quality is not negotiable against time.
  assert.deepEqual(resolveVerdict(['Y', 'Y'], MAP, m(9_000, 9_000, 100, 200)),
    { winner: 'openai', decidedBy: 'judges' });
  assert.deepEqual(resolveVerdict(['X', 'X'], MAP, m(9_000, 9_000, 300, 200)),
    { winner: 'anthropic', decidedBy: 'judges' });
});

test('both sides pass → the FASTER side wins, and only here may the clock decide', () => {
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP, m(9_000, 9_000, 100, 200)),
    { winner: 'anthropic', decidedBy: 'latency' });
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP, m(9_000, 9_000, 300, 200)),
    { winner: 'openai', decidedBy: 'latency' });
});

test('legacy tie/tie rows still resolve on the clock', () => {
  assert.deepEqual(resolveVerdict(['tie', 'tie'], MAP, m(9_000, 9_000, 500, 400)),
    { winner: 'openai', decidedBy: 'latency' });
});

test('both judges say neither → both_failed, NOT a latency win', () => {
  // This is the case the old engine could not express at all: it had no token for it.
  assert.deepEqual(resolveVerdict(['neither', 'neither'], MAP, m(9_000, 9_000, 100, 200)),
    { winner: null, decidedBy: 'both_failed' });
});

test('judges point at different sides → contested, nothing proven, no clock', () => {
  // The 2026-08-10 measurement: 19 of 82 judged duels split like this and EVERY ONE was handed
  // to the stopwatch. A side one judge failed is not a proven-perfect side.
  assert.deepEqual(resolveVerdict(['X', 'Y'], MAP, m(9_000, 9_000, 100, 200)),
    { winner: null, decidedBy: 'contested' });
  assert.deepEqual(resolveVerdict(['Y', 'X'], MAP, m(9_000, 9_000, 300, 200)),
    { winner: null, decidedBy: 'contested' });
});

test('one judge clears a side the other fails → the intersection, so that side does not pass', () => {
  // j1 says both pass, j2 says only X passes: X survives (nobody failed it), Y does not.
  assert.deepEqual(resolveVerdict(['both', 'X'], MAP, m(9_000, 9_000, 300, 200)),
    { winner: 'anthropic', decidedBy: 'judges' });
  // j1 says only X passes, j2 says neither: nothing survives, and they disagree → contested.
  assert.deepEqual(resolveVerdict(['X', 'neither'], MAP, m(9_000, 9_000, 100, 200)),
    { winner: null, decidedBy: 'contested' });
});

test('a failed build gate overrides a judge PASS — tests are ground truth', () => {
  // Both judges cleared both sides, but anthropic's worktree does not build.
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP,
    { ...m(9_000, 9_000, 100, 200), anthGate: 'fail', gptGate: 'pass' }),
    { winner: 'openai', decidedBy: 'judges' });
  // Both gates failed: agreed quality failure regardless of what the judges said.
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP,
    { ...m(9_000, 9_000, 100, 200), anthGate: 'fail', gptGate: 'fail' }),
    { winner: null, decidedBy: 'both_failed' });
  // Gates pass, judges fail: the gate is a floor, not a ceiling — it cannot rescue a side.
  assert.deepEqual(resolveVerdict(['neither', 'neither'], MAP,
    { ...m(9_000, 9_000, 100, 200), anthGate: 'pass', gptGate: 'pass' }),
    { winner: null, decidedBy: 'both_failed' });
  // Absent gates (null / undefined) are "not applicable", never a failure.
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP,
    { ...m(9_000, 9_000, 100, 200), anthGate: null, gptGate: null }),
    { winner: 'anthropic', decidedBy: 'latency' });
});

// The label has to name the subsystem that actually failed. Reading it off token equality alone
// called a double BUILD failure 'contested' whenever the judges happened to split — an operator
// diagnostic pointing at the judges for a compile error they had nothing to do with (duel-174 F5).
test('both gates failed is both_failed however the judges voted — not contested', () => {
  const bothGatesFail = { ...m(9_000, 9_000, 100, 200),
    anthGate: 'fail' as const, gptGate: 'fail' as const };
  // split tokens: the pre-fix rule returned 'contested' for every one of these
  for (const tokens of [['both', 'X'], ['X', 'Y'], ['X', 'neither'], ['both', 'neither']] as const) {
    assert.deepEqual(resolveVerdict([tokens[0], tokens[1]], MAP, bothGatesFail),
      { winner: null, decidedBy: 'both_failed' }, `tokens ${tokens.join('/')}`);
  }
  // ONE failed gate is not the same claim: X is out on its gate and Y is out because a judge
  // failed it, and the judges did clear different sides — that IS a judging dispute.
  assert.deepEqual(resolveVerdict(['X', 'Y'], MAP,
    { ...m(9_000, 9_000, 100, 200), anthGate: 'fail', gptGate: 'pass' }),
    { winner: null, decidedBy: 'contested' });
  // and with no gates recorded at all the split still reads as contested (the v2.11.0 default —
  // nothing writes gates yet, so this is the shape production actually produces)
  assert.deepEqual(resolveVerdict(['both', 'X'], { X: 'anthropic', Y: 'openai' },
    m(9_000, 9_000, 100, 200)),
    { winner: 'anthropic', decidedBy: 'judges' });
});

test('both pass but the clock cannot separate them → unresolved, and both are still correct', () => {
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP, m(9_000, 9_000, 200, 200)),
    { winner: null, decidedBy: 'unresolved' });
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP,
    { anthTokens: 9_000, gptTokens: 9_000, anthLatencyMs: null, gptLatencyMs: 200 }),
    { winner: null, decidedBy: 'unresolved' });
});

test('an implausible token count disqualifies the clock even when both sides passed', () => {
  // A two-digit token count is a truncated or mis-reported run; its clock means nothing.
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP, m(250, 300_000, 50, 40_000)),
    { winner: null, decidedBy: 'unresolved' });
  // unknown (null) tokens are not evidence of a bad run — the clock still decides
  assert.deepEqual(resolveVerdict(['both', 'both'], MAP,
    { anthTokens: null, gptTokens: null, anthLatencyMs: 300, gptLatencyMs: 200 }).decidedBy,
    'latency');
});

test('flipped label map resolves correctly, gates included', () => {
  assert.equal(resolveVerdict(['X', 'X'], { X: 'openai', Y: 'anthropic' }, m(9_000, 9_000)).winner,
    'openai');
  // gates are keyed by VENDOR, labels by position: with the map flipped, gptGate gates label X
  assert.deepEqual(resolveVerdict(['both', 'both'], { X: 'openai', Y: 'anthropic' },
    { ...m(9_000, 9_000, 100, 200), gptGate: 'fail' }),
    { winner: 'anthropic', decidedBy: 'judges' });
});
