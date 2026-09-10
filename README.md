# model-routing

A Claude Code plugin that routes every subagent spawn through a cross-vendor showdown engine.

Before a session spawns a subagent it calls `route_task`. A per-task-kind matrix names a Claude side and an OpenAI side, quota pacing says which lanes are open, and the reply says exactly what to spawn: one model at one effort, or a duel of both. Duels are recorded with proof-of-run (real session ids, matched against each lane's own session files), graded blind by two attested judges, and scored per kind. The engine keeps the score; the operator moves the matrix.

Developed privately from 2026-07-23. Public history begins at this commit, at version 2.14.2.

## What it does

- **Route.** `route_task {kind, mutating}` looks up the matrix row for the kind (architecture-design, deep-review, debugging, second-opinion, web-research, implementation-build, implementation-teardown, transcription, mechanical-apply, mechanical-sweep, long-context; a new slug is added provisionally), reads each lane's state, and returns the lane, model and effort to spawn at. The skill makes spawning at any other effort a protocol violation.
- **Duel.** When both sides are open, the same brief runs on both vendors. `record_duel` stores both outputs and metrics and refuses a side without proof: a session id that exists under that lane's own session directory, newer than the duel, never used for any other slot.
- **Judge.** Two judges, one per vendor, grade each side against an absolute bar (correct, complete, in scope) from a blind packet with vendor tells scrubbed. `record_judgment` needs the judge run's own session id, and that session must have started after the packet existed.
- **Score.** Standings per kind: judge wins (quality) first, then latency wins (time); tokens decide nothing. A letter-grade average per side. No automatic promotion, demotion or re-pairing: the engine flags streaks and the operator re-pairs by hand.
- **Pace.** Per-lane utilization against the subscription window, pace sign, reset time, and a state: `open`, `soft`, `burn`, `closed`, `stale`. A closed lane is routed around. A stale lane means "start a session there".

## What the record shows

A snapshot of the private ledger, pulled 2026-09-10: 444 duels minted between 2026-07-24 and 2026-09-09 on one operator's repositories. 228 were judged (150 decided by the judges, 77 by latency, 1 by tokens), 138 ran as unions, 23 were walkovers, 33 stayed unresolved (25 contested, 7 both-failed, 1 open) and 22 were abandoned. The ledger is not published, so these are that one pull, not a live number. The dated incident notes behind each point are in [`skills/model-routing/SKILL.md`](skills/model-routing/SKILL.md).

**Two judges are not optional.** 261 duels received two blind judgments. The judges split on 106 of them (41%), and on 22 they named opposite winners. One judge would have settled every one of those with the same confidence as the rest. The seats also calibrate differently: the OpenAI judge failed both sides 29 times, the Anthropic judge 7; Anthropic grades cluster at A−, OpenAI grades at A and A+. So the engine stores a grade per judge and reports each side's average both ways ([judge template](skills/model-routing/SKILL.md#judge-template)).

**No frontier model dominates, so the matrix is per kind.** On implementation-build, opus (high) against gpt-5.6-sol (xhigh) over 114 judged duels: sol took the quality channel 51–19, opus took the time channel 29–14. On deep-review the same tier pair split nine duels almost evenly, with the judges themselves split or tied on most of them. Quality and speed went to different vendors, and different kinds went different ways. The seat is chosen per kind, and a streak is flagged for the operator rather than acted on ([kind discipline](skills/model-routing/SKILL.md#kind-discipline)).

**For review work, the union of both sides beats either winner.** The deep-review contest showed each side reliably finding severe defects the other missed: opus alone caught an outage reporting green and 5-minute bars treated as daily; sol alone caught cash flows booked as performance and a regime leaking backward through decades of backtests. Picking a winner threw findings away, so since 2026-07-25 deep-review runs both sides and ships the merge with no judge. 124 union runs since, plus 9 on second-opinion and 5 on web-research once they measured the same way. Eight of the deep-review unions shipped one-sided under quota exhaustion, and the ledger says which ([union protocol](skills/model-routing/SKILL.md#union-protocol-deep-review)).

**Weaker models earn bounded seats.** haiku against gpt-5.3-codex-spark on mechanical-apply: 10 judged, an identical 3.58 grade average, judge wins 3–2 to haiku, every latency win to spark. On transcription haiku leads 10–8 with a 3.38 to 3.20 grade average. gpt-5.6-luna was retired after haiku beat it 2–0 unanimously. The seat is the point: the haiku tier is seeded only on mechanical-apply, mechanical-sweep, bulk-mechanical-misc and transcription, behind judges and controller gates, and never joins a union or an implementation row. Cheap models go where a judge can tell whether they did the job.

**Attestation catches what reading cannot.** 23 FAIL outcomes stand against seven models. Among them: a judge vote cast with no run behind it, a reviewer claiming a test run that never happened, an implementer weakening a safety clamp to turn a fixture green, a side citing archive paths that did not exist. None was caught by taking a report at its word. A side without a matching session file, or with a proof already spent on another slot, is refused at `record_duel`, and the judges verify claims against the tree rather than the prose. 27 of 522 judgments flagged a defect in the brief itself, which is why the brief is graded along with the sides ([lane integrity](skills/model-routing/SKILL.md#lane-integrity-hard-rules), [harness parity](skills/model-routing/SKILL.md#harness-parity--what-a-duel-measures-operator-2026-08-10)).

| Kind | Pairing (Claude / OpenAI) | Judged | Judge wins | Latency wins | Grade avg |
|---|---|---|---|---|---|
| implementation-build | opus high / gpt-5.6-sol xhigh (retired) | 114 | 19 / 51 | 29 / 14 | — |
| implementation-build | opus high / gpt-6-astra xhigh | 3 | 0 / 1 | 2 / 0 | 3.75 / 3.90 |
| deep-review | opus xhigh / gpt-5.6-sol xhigh (retired) | 9 | 2 / 3 | 3 / 1 | — |
| transcription | haiku medium / gpt-5.3-codex-spark xhigh | 18 | 8 / 4 | 2 / 4 | 3.38 / 3.20 |
| mechanical-apply | haiku low / gpt-5.3-codex-spark xhigh | 10 | 3 / 2 | 0 / 5 | 3.58 / 3.58 |
| mechanical-sweep | haiku low / gpt-5.3-codex-spark low (retired) | 3 | 3 / 0 | 0 / 0 | — |

Wins are Claude / OpenAI. Grade averages (4.3 scale) are reported for current pairings only; `standings` prints the full table.

## Lanes

| Lane | What runs it | Default location |
|---|---|---|
| A | the Claude Code session itself | `~/.claude`, credentials at `~/.claude/.credentials.json` |
| B | headless Claude Code on a second subscription, dispatched by the bundled `claude-b` agent | `~/.claude-b` (the aux dirs are `~/.claude-a` and `~/.claude-b`; B is whichever is not the session's account) |
| codex | the Codex CLI, dispatched by the Codex plugin's `codex:codex-rescue` agent | `~/.codex/sessions` |
| spark | a metered Codex-family lane | the same session directory as codex |

Every location is an environment override (see Data and environment).

## Prerequisites

This engine was built around one operator's setup: two Claude subscriptions and the Codex CLI.

- Node 22.13 or newer (`node:sqlite` without a flag). The CLI runs with `--no-warnings`.
- Claude Code with plugin support.
- For lane B: a second Claude Code config directory (default `~/.claude-b`) logged into a second subscription.
- For the codex lane: the Codex CLI and its Claude Code plugin, which provides the `codex:codex-rescue` agent.

With none of the credential or session sources present, `seed` still writes the 14 matrix rows and `status` exits cleanly, reporting every lane as `stale` (`A: stale`, `B[unresolved]: stale`, `codex: stale`, `spark: stale`) with the open-contest count. A lane leaves `stale` once its credentials and session files exist and the poller has read them.

## Install

Clone, build, and add the clone as a marketplace. The plugin then serves live from the clone: a rebuild is picked up by the next session with no reinstall.

```sh
git clone https://github.com/Brian-Plummer/model-routing.git ~/model-routing
cd ~/model-routing && npm ci && npm run build
claude plugin marketplace add ~/model-routing
claude plugin install model-routing@brian-plummer
```

`dist/` is not committed; `npm run build` produces it. Installing straight from GitHub (`claude plugin marketplace add Brian-Plummer/model-routing`) also works, but the build step then has to run inside the installed plugin directory.

## Quick start

```sh
node --no-warnings dist/src/cli.js seed        # writes the 14 matrix rows
node --no-warnings dist/src/cli.js status      # lanes: utilization, pace, reset, state; open contests
node --no-warnings dist/src/cli.js standings   # per-kind duel scores
```

Inside a session: `/model-routing:routing-status` and `/model-routing:showdown`. The SessionStart hook prints one quota line per lane.

## Surface

**Slash commands**

| Command | Shows |
|---|---|
| `/model-routing:routing-status` | one line per lane (utilization, pace sign, reset day, state) and the open-contest count |
| `/model-routing:showdown` | one standings table per kind: pairing, judged duels, judge wins, latency wins, time saved |

**MCP tools** (server `model-routing`, stdio)

| Tool | Does |
|---|---|
| `route_task` | routes a subagent task: duel both vendors, union both vendors (run both, ship the merge, no judges), or a single model; quota-aware |
| `record_duel` | records both sides' outputs and metrics; proof = the real run's session id, mandatory for B/codex/spark sides; rejects unattested or reused proofs and a model that does not match the proof artifact |
| `record_judgment` | records one blind judge grade with the judge run's session id as proof; grades each side against an absolute bar, never a preference |
| `record_outcome` | logs a FAIL or PROMOTE outcome; a streak of two is flagged in the reply and moves nothing |
| `quota_status` | per-lane utilization, pace, reset time, state, and every live model-scoped pool |
| `standings` | duel standings per kind: current pairing, wins split by decision channel (judges, then latency), grade averages |

**CLI** (`node --no-warnings dist/src/cli.js <subcommand>`)

| Subcommand | Does |
|---|---|
| `launch <codex\|b> …` | starts a headless run on the codex or B lane with the routed model and effort |
| `brief-lint <brief.md>` | lints a duel brief against the protocol before it is minted |
| `tokens <artifact>…` | counts tokens in artifacts |
| `quota [--refresh] [--summary]` | polls the lane meters; `--refresh --summary` is the SessionStart hook line |
| `status` | the lane dashboard and open contests |
| `contested` | lists duels still open for judging or revival |
| `serena` | per-duel ledger of attested Serena tool calls |
| `calibration [<openai-model>]` | judge-calibration cuts for one contestant era |
| `matrix` | prints the routing matrix |
| `standings` | per-kind scores |
| `seed` | writes the matrix rows |
| `union <task-kind> <on\|off>` | toggles union mode for a kind |
| `import-scorecard <path>` | imports a legacy scorecard file |
| `report …` | session duel reports: `--session-end`, `--window <fromMs,toMs>`, `auto on|off`, `open-cmd <cmd|auto>` |

## Data and environment

| Variable | Default | Holds |
|---|---|---|
| `MR_DATA_DIR` | `~/.local/share/model-routing` | data directory |
| `MR_DB_PATH` | `<data dir>/mr.db` | the SQLite matrix and duel ledger (WAL mode) |
| `MR_REPORTS_DIR` | `<plugin root>/Session reports` | session duel reports |
| `MR_CRED_A` | `~/.claude/.credentials.json` | lane A credentials (read, never refreshed by the plugin) |
| `MR_MAIN_CONFIG` | `~/.claude.json` | the session account's config (account uuid) |
| `MR_AUX_A`, `MR_AUX_B` | `~/.claude-a`, `~/.claude-b` | the two aux config dirs; B resolves to the one whose account differs from the session's |
| `MR_B_CONFIG_DIR` | resolved from the aux dirs | pins lane B's config dir explicitly |
| `MR_CRED_B` | `<B config dir>/.credentials.json` | lane B credentials (refreshed under a lockfile) |
| `MR_A_PROJECTS`, `MR_B_PROJECTS` | `~/.claude/projects`, `<B config dir>/projects` | session files used as proof-of-run |
| `MR_CODEX_SESSIONS` | `~/.codex/sessions` | codex rollouts used as proof-of-run |
| `MR_OAUTH_TOKEN_URL`, `MR_OAUTH_CLIENT_ID` | Anthropic's OAuth endpoint and Claude Code's public client id | lane B token refresh |

Back up `mr.db` with SQLite, never `cp`: the database runs in WAL mode, so a plain copy takes only the checkpointed pages. Use `sqlite3 mr.db ".backup <dest>"` or `VACUUM INTO '<dest>'`, and check the copy's `duels` count before relying on it.

## Development

```sh
npm test        # tsc → dist/, then node --test over dist/tests (677 tests)
```

Engine changed? `npm run build`, bump the version in `.claude-plugin/plugin.json` (the authority) and `package.json` together, and restart any running MCP server processes: a session that is already open keeps the old server until it restarts, and rows minted by a stale build are flagged on the pending surface by their `minted_by_version`.

The routing protocol the engine enforces is `skills/model-routing/SKILL.md`. It is written as an operating manual, dated incident notes included; each rule's note is the reason the rule exists.

## Licence

MIT. Contact: https://github.com/Brian-Plummer
