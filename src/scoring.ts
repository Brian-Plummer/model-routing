import type { Vendor } from './types.js';

// Tokens no longer decide anything (operator, 2026-08-10): quality first, then time. A cheaper
// run must never beat a faster one at equal quality, so the token channel is gone — token counts
// are still recorded, and still DISQUALIFY a duel below the floor:
// any real lane run reports thousands of tokens (the prompt alone does); a two-digit count means
// a truncated or mis-reported run, and a lane that produced nothing is also the fast one, so its
// latency cannot be trusted either. 2000 is under the smallest genuine count observed in the live
// DB (5084) and well over any truncated run. This gates ONE duel's tiebreak only.
export const TOKEN_MIN_PLAUSIBLE = 2_000;

// The judge grades each solution against an ABSOLUTE bar and no longer states a preference.
// A preference cannot say "neither of these is shippable", so the engine used to answer that
// question with a stopwatch: 21 of the first 82 judged duels (26%) were decided on latency,
// every one of them a duel where the quality signal was ABSENT — split judges (19) or a double
// tie (2). That is the stated priority exactly inverted. Four tokens, one per grade combination.
export type JudgeToken = 'X' | 'Y' | 'both' | 'neither';

// v2.13.28: beside the pass/fail verdict each judge GRADES both sides like a teacher — the
// verdict decides, the grade remembers. Win/loss erased exactly the story the operator asked
// for: a side failed on a formality and a side that shipped garbage both scored 0, so a
// 17-duel streak could not be told apart from a run of near-ties (duels 250/252). Grades are
// observational: resolveVerdict never reads them, and the operator reads the GPA trend in
// `standings`. Standard 4.3 scale; the order of this literal is the canonical A+→F listing
// the MCP schema and SKILL template both quote.
export const GRADE_POINTS = {
  'A+': 4.3, 'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7,
  'C+': 2.3, 'C': 2.0, 'C-': 1.7, 'D+': 1.3, 'D': 1.0, 'D-': 0.7, 'F': 0,
} as const;
export type LetterGrade = keyof typeof GRADE_POINTS;
export const LETTER_GRADES = Object.keys(GRADE_POINTS) as LetterGrade[];

// Sides a judge token clears. 'tie' is the pre-v2.11.0 preference spelling, never written again
// but still read: it asserted that neither side was worse, i.e. neither failed, so it decodes to
// both. An unrecognized token clears nobody — an unreadable grade is not a pass.
export function passingSides(token: string): Set<'X' | 'Y'> {
  switch (token) {
    case 'X': return new Set(['X']);
    case 'Y': return new Set(['Y']);
    case 'both': case 'tie': return new Set(['X', 'Y']);
    default: return new Set();
  }
}

export interface DuelMetrics {
  anthTokens: number | null;
  gptTokens: number | null;
  anthLatencyMs: number | null;
  gptLatencyMs: number | null;
  // Deterministic build/test result per side. CONSUMED here as of v2.11.0, WRITTEN as of
  // v2.13.14 — the record_duel field, the duels columns and the recordJudgment plumbing were
  // promised for "the next commit" of the v2.11.0 plan and did not arrive, so for three
  // releases this branch could only ever read undefined while SKILL told the operator that a
  // failed gate overrides any judge vote. null/undefined = not applicable (read-only kinds,
  // any side with no gate to run, and every row recorded before the migration), never a
  // failure.
  anthGate?: 'pass' | 'fail' | null;
  gptGate?: 'pass' | 'fail' | null;
}

// v2.13.29: a judge may RECOMMEND a path beside its verdict — pick a side, or direct the
// controller to compose both. Advisory except in the one shape resolveVerdict reads below.
export const PATH_TOKENS = ['X', 'Y', 'merge'] as const;
export type PathToken = typeof PATH_TOKENS[number];

export interface Verdict {
  winner: Vendor | null;
  // 'both_failed'  — every judge agreed nothing met the bar (or both gates failed)
  // 'contested'    — the judges cleared different sides, so no side is proven; also no winner
  // 'unresolved'   — both sides passed but the clock could not separate them (both are correct)
  // 'merge'        — both sides passed AND both judges directed a composition: a terminal
  //                  judged outcome with no winner to credit (the ship is the merge)
  decidedBy: 'judges' | 'latency' | 'unresolved' | 'both_failed' | 'contested' | 'merge';
}

export function resolveVerdict(
  judgeVerdicts: [string, string],
  labelMap: Record<string, Vendor>,
  m: DuelMetrics,
  // The two votes' path recommendations, positionally aligned with judgeVerdicts. Optional and
  // NULL-tolerant: a legacy vote has no path, and one recommendation alone changes nothing.
  paths?: [string | null, string | null],
): Verdict {
  const [j1, j2] = judgeVerdicts;
  const p1 = passingSides(j1);
  const p2 = passingSides(j2);
  // Gates are keyed by vendor (that is how the duel row stores them); labels are positional.
  const gateOf = (label: 'X' | 'Y'): 'pass' | 'fail' | null =>
    (labelMap[label] === 'anthropic' ? m.anthGate : m.gptGate) ?? null;
  // A side passes only when NEITHER judge failed it — the INTERSECTION, not the union. Quality
  // failures are unacceptable, so a contested side is not a proven side. And a failed gate
  // overrides any vote: the build/test suite is ground truth about correctness and a judge's
  // reading of a diff is not, so no majority of opinions can pass a broken tree.
  const passed = (label: 'X' | 'Y'): boolean =>
    gateOf(label) !== 'fail' && p1.has(label) && p2.has(label);
  const passX = passed('X');
  const passY = passed('Y');

  // Both judges directed a merge and BOTH sides met the bar (gates included — ground truth
  // outranks two recommendations exactly as it outranks two votes): the best answer is the
  // composition, so nobody wins and nothing is discarded. Anything short of that agreement
  // falls through — one judge's merge wish is advisory, stored on its vote for the report.
  if (passX && passY && paths?.[0] === 'merge' && paths?.[1] === 'merge') {
    return { winner: null, decidedBy: 'merge' };
  }

  // Exactly one side met the bar. Quality decides outright — the loser's clock is irrelevant,
  // however fast it was.
  if (passX !== passY) {
    return { winner: labelMap[passX ? 'X' : 'Y'], decidedBy: 'judges' };
  }

  // Nothing met the bar. Terminal, no winner, and the stopwatch is NOT consulted — that
  // fall-through is the defect this release exists to remove. The two spellings are kept apart
  // because they mean different things to the operator: 'both_failed' is a measured quality
  // failure attributable to both models, while 'contested' is judges disagreeing about which
  // side is broken, which proves nothing about either and is a signal about the JUDGES.
  // ponytail: with two judges, disagreement is conservatively a failure. A third tiebreak judge
  // on a distinct vendor is the upgrade path if the contested rate proves to cost real wins.
  //
  // The label follows WHY each side failed, not token equality alone. When BOTH gates failed the
  // tree is broken on both sides and no judge token can turn that into a judging dispute:
  // reading it off `j1 === j2` returned 'contested' for a double build failure with split
  // grades, blaming the judges for a compile error they had nothing to do with and handing the
  // operator a diagnostic pointing at the wrong subsystem (duel-174 F5).
  if (!passX) {
    const bothGatesFailed = gateOf('X') === 'fail' && gateOf('Y') === 'fail';
    return { winner: null, decidedBy: bothGatesFailed || j1 === j2 ? 'both_failed' : 'contested' };
  }

  // Both sides met the bar. ONLY here may time decide: the goal is the fastest model that
  // gets a perfect answer, and both of these answers are perfect.
  // Below the token floor one side did not do the work, and its latency is meaningless for the
  // same reason (a run that produced nothing is also the fast one): falling through would hand
  // the duel to exactly the side being disqualified. A null token count is not that evidence —
  // unknown is not implausible — so it does not gate.
  if (m.anthTokens !== null && m.gptTokens !== null
      && Math.min(m.anthTokens, m.gptTokens) < TOKEN_MIN_PLAUSIBLE) {
    return { winner: null, decidedBy: 'unresolved' };
  }
  // A null latency means we have nothing left to decide on, and identical latency means the
  // clocks tie. Either way both sides are CORRECT and neither is faster: no winner is recorded,
  // and the caller may ship either one.
  if (m.anthLatencyMs === null || m.gptLatencyMs === null) {
    return { winner: null, decidedBy: 'unresolved' };
  }
  if (m.anthLatencyMs === m.gptLatencyMs) return { winner: null, decidedBy: 'unresolved' };

  return {
    winner: m.anthLatencyMs < m.gptLatencyMs ? 'anthropic' : 'openai',
    decidedBy: 'latency',
  };
}
