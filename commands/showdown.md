---
description: Showdown standings — duel scores per task-kind and the models dueling each
allowed-tools: Bash
---

Run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js" standings` and present ONE
standings table: per kind, the pairing dueling it (`anthModel@anthEffort` vs
`gptModel@gptEffort`), judged duels, then the win record broken into its two decision channels —
quality (`anthJudgeWins`–`gptJudgeWins`, judge verdicts) and time (`anthLatencyWins`–
`gptLatencyWins`) — the time each side saved on the clock channel
(`anthLatencySavedMs`–`gptLatencySavedMs`, with `anthLatencyMedianMs`/`gptLatencyMedianMs` in the
same cell, rendered in whatever unit reads cleanly: `4m02s (med 1s)`), the window's net
wall-clock difference across the duels that were measured (`netLatencyMs`, signed, positive =
anthropic spent less overall), the final verdict (`anthWins`–`gptWins`, the total across both
channels), walkovers, judge-agreement %, the GPA trend (`gpa`: each side's mean grade overall
and split by grading judge — render as `3.5 (A 3.2 / G 3.8)` per side, over `gradedVotes` votes;
a formality loss and a garbage loss both score 0 wins but grade A- and F, and the two judges'
calibrations differ, which the split shows), merged ships (`mergedShips`: judged duels whose ship
was the composition of both sides, credited to neither), and a rightmost **comments** column.

A clock win's COUNT and its SIZE are different facts: five one-second wins and one four-minute
win are the same 5–1 record. Report both as given and never merge them into a score. A total far
above its own median MAY mean one duel carried it — check the win count before saying so, since
many similar wins produce the same shape. Either way it belongs in the comments column, as an
observation about that row, never as a projected winner. `netLatencyMs` covers every judged duel
that stored BOTH clocks, including the ones decided on quality — a judged duel missing either
clock is counted in `judged` and measured nowhere, so it can point the opposite way from the
saved totals when a side wins on quality while being slower; that disagreement is information,
not an error. The savings are per kind and stay per kind — a minute of deep-review is not a
minute of bulk-search. Never sum them across kinds, never rank kinds by time saved.

Tokens are NOT a channel and never decide a duel (operator, 2026-08-10): quality first, then
time. A cheaper run never beats a faster one at equal quality. Never add a token column, never
report token counts as a score.

The comments column is yours to write: one short factual note per row, drawn from that row's own
numbers and the DB — an era that just changed and why, a judge-agreement figure low enough that
the kind's duels are mostly ending with nothing proven, a sample too small to read anything
into (judged ≤ 2), a
walkover-heavy record, a pending duel on the kind, a channel split worth the operator's eye.
Leave the cell empty when the row says nothing notable. Never put a recommendation, a projected
winner, or a cross-kind comparison there.

The main row covers only the CURRENT contest window (duels since the row's last settings
change). Each entry in the kind's `retired` array is an earlier era — insert it as its own row
directly beneath the kind's main row, same columns, clearly marked retired (kind cell like
`↳ retired`), with the old pairing it actually ran. Every duel appears in exactly one row;
retired records exist so old duels are remembered, not re-fought.

There is no automatic decision and no cross-kind ranking: victory/split thresholds and elo
are deleted from the engine. It only tracks scores; the operator analyzes them and declares
winners. Never rank kinds against a threshold, project a winner, or compare models across
kinds — just report the per-kind scores.

A kind with `union: true` has NO contest: both vendors run every time and the merge ships.
Report those separately as `union kinds`, with `unionRuns` as their volume and `unionOneSided`
beside it — runs where only one side landed shipped one report, not the merged coverage.

Since v2.11.0 the judges grade each side against an absolute bar ("does this meet it?") instead
of stating a preference, and a side passes only when NEITHER judge failed it. That gives four
decision channels, and `decidedBy` on a duel says which one ran:

- `judges` — exactly one side met the bar. Quality decided it outright; the clock was not consulted.
- `latency` — BOTH sides met the bar and the faster one won. This is the only channel the clock
  may decide, and it is not a fall-through from a missing quality signal. The margin of each such
  win is summed into the winner's `*LatencySavedMs` and its median reported beside it.
- `unresolved` — both met the bar and the clock could not separate them (equal or unknown
  latency, or a token count too low to trust). No winner; either side may ship.
- `both_failed` / `contested` — nothing met the bar, so the duel is terminal with NO winner and
  the row is `status='unresolved'`, excluded from `judged` and from every win counter.
  `both_failed` = the judges agreed nothing passed (or both build gates failed); `contested` =
  the judges cleared different sides, which proves nothing about either and is a signal about the
  JUDGES. A run of contested rows on one kind is worth the operator's eye.

`judgeAgreementPct` is the share of the window's duels where the two judges agreed. It is read
from the VOTES, not from the decision channel: a `latency` duel is one both judges passed, i.e.
agreement, and a `judges` duel can come from a split, so `decidedBy` stopped being a proxy for
agreement at v2.11.0. A duel counts when both judges' votes are stored (they agreed if the two
grade tokens match); a pre-v2.11.0 judged duel that retained no votes keeps the older
`decidedBy='judges'` reading it was written under, since back then that channel did mean the two
preferences matched. It is `null` when the window holds neither shape — "nothing to report", not
0%. A low value means the judges disagree often on that kind — report it as-is. Judges are fixed
at opus@xhigh / gpt-6-astra@xhigh by the protocol.
