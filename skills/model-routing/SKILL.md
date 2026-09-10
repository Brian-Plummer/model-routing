---
name: model-routing
description: Route every subagent through the showdown engine — call route_task before ANY subagent spawn, run duels per protocol, feed results back. Includes lane recipes for Claude A/B and Codex.
---

# Model Routing v2 — Showdown Protocol

**HARD RULE: spawn at exactly the effort `route_task` returns — never above it, never `ultra`
(the banned codex config default), any lane, any subagent.** `max` is Claude-side ONLY:
codex-cli 0.147.0 REJECTS it (`Use one of: none, minimal, low, medium, high, xhigh` — hit live
2026-08-10 and 2026-08-11; the earlier "verified accepted" claim never reproduced) and spark
tops out at `xhigh`. The matrix never prescribes gpt `max` (the v2.12.5 migration relabeled
every row that carried it — deep-review and decision-brief live — and `setVendorModel` refuses
it). If stale data ever returns gpt `max`, clamp to `xhigh` and surface the deviation loud.

## Lane integrity (HARD RULES)

- Lanes B/codex/spark spawn ONLY via the Agent tool with `subagent_type`
  (`model-routing:claude-b` / `codex:codex-rescue`) and WITHOUT the `name:` param
  (a named spawn takes the teammate path and the agent def never loads —
  2026-07-24 incident). NEVER as team teammates or via
  SendMessage — teammates do not load agent definitions, the `Model:` / `Use --model`
  first lines become inert text, and the work silently runs on the session account
  (2026-07-23 incident: 14 fake duels, sonnet cosplaying gpt-5.6-sol on account A).
- A lane that hangs, errors, or hits usage limits → record that side `failed: true`
  (walkover) and tell the user. NEVER simulate a lane with a local model or teammate —
  a simulated duel poisons the matrix.
- Proof-of-run: every non-failed B/codex/spark side MUST carry `proof` — the real run's
  session id (B: the headless envelope's `session_id`; codex: the rollout/session id).
  `record_duel` matches it against a session file under the offload dir's `projects/`
  (`b_config_dir` from `route_task`, default `~/.claude-b`) /
  `~/.codex/sessions` newer than the duel (canonical session id, exact match — a filename
  fragment is not a proof). Positive `tokens` and non-empty `output` are mandatory too.
  No proof = no record: if you cannot produce the session id, the lane did not really run —
  record `failed: true`.
- Judges are attested the same way: `record_judgment` takes the judge run's session id as
  `proof` and rejects a vote without one. Both judges must be real lane spawns, spawned AFTER
  `record_duel` returned the packet — the judge window opens when the packet's outputs landed
  (`outputs_at`, which survives a revival re-record), and the session's own START (its first
  logged timestamp) must postdate it: a session merely still running across the record does not
  qualify. A session file without a parseable timestamp falls back to the mtime freshness check.
  The gpt judge's proof must be a codex-lane rollout (spark's does not attest it). A duel with a
  BLANK stored side is not judgeable at all — repair the blank side via `record_duel` first;
  a repair that changes the packet voids any votes already cast on the old one.
- Sides and judges draw from ONE spent-proof namespace: every session id can attest exactly one
  slot, ever. Re-passing a side's id as that duel's judge proof, or last duel's judge id as this
  duel's side, is rejected — spawn the run, or record `failed: true`.
- A proof must name a rollout from the side's OWN lane. Every codex-family lane (codex and spark)
  writes into `~/.codex/sessions`, so identity and freshness alone prove only that *some* codex
  run happened: a `gpt-5.6-sol` rollout does not attest a spark side, and spark's does not attest
  a codex side. `record_outcome` needs no proof at all now — it records your own observation of a
  run you already made, and spark can no longer take a row it was not seeded onto. Ladder
  FAIL/PROMOTE outcomes need no proof either: they record your own observation of a run you
  already made, not a claim that a separate lane ran.

## Before every subagent spawn

Call MCP tool `route_task {kind, mutating}`. Kinds: architecture-design, deep-review,
debugging, second-opinion, web-research, implementation-build, implementation-teardown,
transcription, mechanical-apply, mechanical-sweep, long-context — plus `bulk-mechanical-misc` /
`implementation-misc`, kept ONLY as ambiguous-case fallbacks for their split subkinds — or any
new kind (engine adds it provisionally). `mutating: true` when the task edits files.

Two former kinds are SPLIT (operator, 2026-08-01) — classify into the subkind first, use the
residue row only when genuinely ambiguous. Both parents were renamed `-misc` (operator,
2026-08-10); the old slugs `bulk-mechanical` / `implementation` are ALIASED (engine ≥2.10.2):
passing one routes, records, and imports against the `-misc` residue row — no provisional fork.
Still prefer the canonical `-misc` names:
- `bulk-mechanical-misc` → `mechanical-apply` when the edit list is GIVEN (fix application,
  renames, one-liners, restores) vs `mechanical-sweep` when the edit list must be DISCOVERED
  (orphan removal, delete-all-X, update-every-caller). Misc row stays the ambiguous fallback.
- `implementation-misc` → `implementation-build` when the task ADDS/CHANGES behavior (new modules,
  surgical multi-file edits, rewires, hardening, rewrites) vs `implementation-teardown` when it
  REMOVES behavior wholesale (mass deletion, destructive migration, deletion-dominated diffs).
  Misc row stays the fallback for ambiguous/mixed tasks.
All four started fresh contests on 2026-08-01 — no parent evidence carried over.

A kind is a routing bucket, not a task description: it must be a lowercase slug
(`^[a-z][a-z0-9-]{2,40}$`, e.g. `schema-migration`). Passing prose like
`live-API probe (FMP endpoints)` is rejected — classify the task, don't describe it.

For a brand-new kind, pass `tier: haiku|sonnet|opus|fable` to seed its row at that tier
with the matching gpt peer. Without it the new row clones the default (sonnet@medium vs gpt-6-astra@high).

### Kind discipline

- Fixed duel pairings (tier peers): fable↔gpt-6-astra, opus↔gpt-6-astra,
  sonnet↔gpt-6-astra@high (terra@medium retired as a contender 2026-08-10),
  haiku↔gpt-5.3-codex-spark. New kinds pair by the anthropic tier chosen.
- gpt-5.6-sol is RETIRED as a contestant (operator, 2026-09-05): GPT-6-Astra took every seat
  sol held, at sol's effort, on every row — the v2.14.0 migration reset those contests (window
  and unspent sol evidence). Sol stays launchable (`mrctl launch` accepts it) for re-runs and
  operator re-pairs; the codex judge moved with it (see the judge protocol).
- gpt-5.6-luna is RETIRED (operator, 2026-07-25) after haiku beat it 2-0 unanimously on
  bulk-mechanical. It is off the gpt ladder and is never routed, never a peer, never a
  fallback. Spark holds the haiku tier seat instead, as a first-class duel contender.
  Spark's earn-in shadow is RETIRED with it: spark holds the haiku seat by the seed and duels
  haiku directly on `mechanical-apply`, `mechanical-sweep`, `bulk-mechanical-misc`, and
  `transcription`. It never side-cars a run, never joins
  a union (union work is deep analysis between frontier models), and can no longer take a row it
  was not seeded onto. It cannot LOSE one on its own any more either (v2.10.1, operator,
  2026-08-10): 2 straight canonical FAILs — or a single integrity FAIL — raise a flag in the
  `record_outcome` reply and move NOTHING. Surface the flag; the operator decides eviction,
  re-pairing, or contestless. The old auto-revert-to-terra is gone with the rest of the
  automatism. An operator swap still REOPENS the contest: a verdict cannot survive a
  contestant swap (the pairing that exists after it has never run), so the row goes back to
  duelling instead of serving the untested replacement single on the evicted model's win.

- `long-context` ONLY when a single agent must hold near-1M tokens in ONE context window
  (e.g. reasoning over a huge file/corpus loaded whole). Chunked or grep/jq sweeps over a
  big corpus are NOT long-context — classify by what each agent actually does
  (deep-review, mechanical-sweep, default).
- Fable is reserved for top-level orchestration and the most complex kinds
  (architecture-design, debugging, long-context, and deep-review's union side since
  2026-08-10). Never assign fable to fan-out workers.
- Fan-outs (Workflow / parallel agents): one route_task call covers only spawns of the
  SAME kind. Mixed kinds → one call per kind. Every worker gets the routed model/effort
  passed explicitly (agent opts or prompt contract) — never inherits the session model.

- `mode: "single"` → spawn the one side per its lane recipe. Done.
- `mode: "duel"` → run the duel protocol below.
- `mode: "union"` → run the union protocol below: both sides, no judges, ship the merge.
  Union kinds: `deep-review`, since 2026-08-10 `second-opinion`, and since 2026-08-13
  `web-research` — measured complementary, not comparable (each side's headline finding was
  absent from the other's report; duel 203 both_failed on disjoint fatal gaps).
- `mode: "blocked"` → STOP and tell the user which lanes are closed. Never work around a
  closed lane.

Lane states: `open` routes normally; `burn` means the weekly window resets within a day
with headroom left, so spend it; `soft` (≥80%) still runs single tasks but is not duelled
into; `closed` (≥95%) is unusable; `stale` means the quota data is missing or over 6h old —
still routable, but never preferred over a lane known to be open. A reading at or over 80%
never ages out: `soft` and `closed` hold until their own window resets, on every lane
(v2.13.65), and a model pool (`fable`) closes a lane for that model alone (v2.13.61).

Engine unreachable → tell the user, then fall back to `~/.local/share/model-routing/matrix.md`
if an earlier session wrote one. Every writer of that file needs an open DB first, so a fresh
or corrupt-from-first-contact install has none — there, route by the seed pairings below (the
engine's v1 matrix, `SEED` in `src/matrix.ts`, restated here because this file is the only
fallback that always exists):

| kind                    | anthropic (lane)   | gpt peer                  | mode  |
|-------------------------|--------------------|---------------------------|-------|
| architecture-design     | fable xhigh (A)    | gpt-6-astra xhigh         | duel  |
| deep-review             | fable xhigh (B)    | gpt-6-astra xhigh         | union |
| debugging               | fable xhigh (A)    | gpt-6-astra xhigh         | duel  |
| second-opinion          | opus high (B)      | gpt-6-astra xhigh         | union |
| web-research            | opus high (B)      | gpt-6-astra high          | union |
| implementation-misc     | sonnet high (B)    | gpt-6-astra high          | duel  |
| implementation-build    | opus high (B)      | gpt-6-astra xhigh         | duel  |
| implementation-teardown | sonnet medium (B)  | gpt-6-astra high          | duel  |
| transcription           | haiku medium (B)   | gpt-5.3-codex-spark xhigh | duel  |
| bulk-mechanical-misc    | haiku low (B)      | gpt-5.3-codex-spark xhigh | duel  |
| mechanical-apply        | haiku low (B)      | gpt-5.3-codex-spark xhigh | duel  |
| mechanical-sweep        | haiku medium (B)   | gpt-5.3-codex-spark xhigh | duel  |
| long-context            | fable[1m] high (A) | gpt-6-astra high          | duel  |
| default                 | sonnet medium (B)  | gpt-6-astra high          | duel  |

Usage-limit error from any lane at spawn time → surface to the user immediately and stop
routing to that lane this session. Model pools are metered separately from the account
windows (a "You've reached your Fable 5 limit" 429 at 7% weekly): the engine reads each
anthropic lane's model-scoped pool from the usage payload and closes the lane for that model
until the pool's own reset, saying so in `notes` ("lane B: fable pool 100% — closed until …").
A 429 on a lane the notes did not close means the snapshot predates the exhaustion — run
`mrctl quota --refresh` and route again before hand-shifting anything. A closed fable pool
never drops the side (operator standing order, 2026-09-03): the route moves it to the other
lane's fable, then to opus at the row's effort when both pools are shut — see the union
protocol; the same fallback serves the lane-A fable kinds, whose duel stays judgeable because
the router reads lane B for the opus judge, not for the fable side.

Spark is metered (its own model-specific pool — duel 268 died mid-task on
usage_limit_exceeded). When quota reads spark CLOSED, `route_task` substitutes the openai side
with **gpt-5.6-luna@high on lane codex** (operator standing order, 2026-08-20) and says so in
`notes` — launch that side exactly as any codex-lane side (`mrctl launch` accepts luna). The
matrix row is untouched; the seeded spark pairing returns when its window resets. Luna stays
retired everywhere else: backup seat only, no ladder, no scorecard import.

## Union protocol (deep-review)

Some kinds were measured and found COMPLEMENTARY, not comparable: each vendor reliably finds
real defects the other misses, so picking a winner throws away findings. Those kinds route
`union` — both sides run, both reports ship, nobody judges.

- **Fable-closed standing order (operator, 2026-09-03; supersedes the 2026-08-10 lane-A attestation
  invariant):** a union's anthropic side stays home on B for pace, soft and burn — lane A writes
  no attestable artifact, so A is never an optimization target. When B is CLOSED for the row's
  model (the fable pool, or the account), the engine shifts the side to lane A instead of
  degrading the union; when fable is closed on BOTH accounts it runs opus at the row's effort on
  B (or on A when the B account is closed too) and says so in `notes` ("fable closed on A and
  B — opus@xhigh backup on lane B (operator standing order, 2026-09-03)"). Record what ran: the
  side's `model`/`effort` from the route reply, an A-lane side with no proof and its effort as
  `session default`. Eight of deep-review's 109 unions shipped one-sided between 08-21 and
  08-29 on exactly the death this closes. Only when NO anthropic lane can run any model does a
  union degrade to single.

Evidence that set this (2026-07-25, 5 deep-review dimensions of one repo): every dimension had
material findings unique to each side. Opus alone caught a 23h CoinGlass outage reporting green,
stale P&L cards, and 5-minute bars treated as daily. gpt-5.6-sol alone caught cash-flows booked
as performance, a future regime leaking backward through decades of backtests, and a swallowed
insert dropping a filled order. The 9-duel contest was 4-5 with judges split or tied in 4 of 5 —
a coin flip that was discarding half the coverage every time.

1. Write `duel<id>-brief.md` FIRST, in the controller scratch, exactly as duel-protocol
   step 1 prescribes (pre-flight checks, hashed blessed copies) — the record gate refuses a
   report without the brief beside it (v2.13.8), and a union spawned before its brief exists
   ends in post-hoc retyping, the drift class the gate closes. THEN spawn BOTH sides in
   parallel, same as a duel (lane recipes, `mutating` worktree rules).
2. Call `record_duel {duel_id, anthropic: {...}, openai: {...}}` exactly as for a duel —
   proofs, tokens and outputs are attested identically. It returns
   `{status: "union", sidesRecorded, failed}`.
3. **Do NOT spawn judges.** `record_judgment` on a union row is rejected. There is no winner
   and no spot-check.
4. Ship the MERGE of the reports that landed: union of findings, de-duplicated where the two
   describe the same defect, each finding keeping the evidence of whichever side proved it.
   Conflicts between the reports are content to resolve, not a vote to hold.
   Persist each side's FULL report to `.review-scratch/duel<id>-anthropic.md` /
   `-openai.md` — beside the `duel<id>-brief.md` step 1 already wrote — and record it by
   ABSOLUTE `output_path`, never as inline text: the ledger keeps only what you pass it
   (duels 197–200 survive as ~1.4KB digests; 201's scratch files are what made its findings
   re-checkable), and text passed inline is retyped text (duel 206's stored codex report is a
   paraphrase of the artifact — curly quotes flattened, a docs URL dropped, four fixes
   reworded — while the scratch file matches the rollout byte for byte).
5. One side hung? `failed: true` for that side. The row still closes as `union` and the merge
   is the surviving report — say in your summary that coverage is one-sided. This is the
   duel-37 case (2026-07-25: D7's codex partner hung, the opus report shipped, and the row was
   left dangling to be swept `abandoned` because duel semantics had nowhere to put it).
   Both sides hung → the row records `abandoned`, and there is nothing to ship.
6. A closed lane on one side degrades a union to `single` and says so in `notes` — for the
   anthropic side only after the fable-closed standing order above found no lane for fable and
   none for opus. A `soft` lane does NOT: half a union is worse coverage, not a cheaper duel.
7. Recovered a hung lane's run afterwards (the rollout was there all along)? Call `record_duel`
   AGAIN on the same duel id with that side filled in — a union row stays open to the side it is
   still missing, and the side that already landed is preserved. A landed side is IMMUTABLE:
   the engine ignores whatever the second call passes for it (real payload or `failed: true`,
   both are safe) and only fills sides the row is missing, so a recovery can never overwrite
   the report it exists to save. Pass `failed: true` for the landed side by convention — it
   says what you mean.
   Both sides hung → the row records `abandoned` and the call returns `status: "abandoned"`, not a
   union: there is nothing to ship.

`web-research` unions (operator, 2026-08-13; duel 203) FAN OUT on BOTH sides, not just the
anthropic one: the anthropic side runs its lane's parallel search/verify/synthesize workers,
and the codex side fans concurrent rollouts the same way (per-angle searches plus a
synthesize rollout) and merges them before returning. A single-rollout codex run on a
web-research union is a recipe deviation — name it in that side's `environment`.

Turning union on or off is an OPERATOR decision about a kind, never an inference from results:
`node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js" union <task-kind> on|off`. A real flip
clears any standing verdict, because a union kind has no victor; a row already in that state
prints `already union <state> — unchanged` and is left alone, verdict intact.

Union kinds are read-only analysis. `mutating: true` on one has no defined way to reconcile two
independent diffs, so the engine routes it as a CONTEST instead (one winner's diff applies) and
says so in `notes` — run it as a duel, judges and all.

## Duel protocol

1. Write the brief to `.review-scratch/duel<id>-brief.md` BEFORE spawning, and spawn both
   sides FROM that file: build the Codex command with `mrctl launch codex` per the Codex call
   rules, passing `--cwd <worktree>` for a mutating side, `--sandbox workspace-write` for any
   side that must write a report, and the routed model/effort. The launcher emits those as
   `-C`/`-s` in the detached `codex exec "$(cat <abs path>)"` shape, with effort encoded as
   `-c model_reasoning_effort=<x>` plus `--skip-git-repo-check` (codex exec refuses a cwd
   outside a git repository and writes no rollout — duel 412's judge dir died at launch on it,
   v2.13.89); `mrctl launch b --task-file <abs path>` reads the same file and inlines its bytes
   after the courier header — lane B's `Workdir:` sandboxes reads, so the packet carries the
   brief, never a path to it. Persistence is then a byproduct of spawning
   instead of an afterthought, and both sides provably read the same bytes — a second
   hand-typed copy can diverge from the first with nobody the wiser. The file lives under the
   Workdir (a brief in the session scratchpad is unreachable from the codex sandbox — see the
   codex call rules). For a `mutating` duel the canonical brief is the CONTROLLER's copy, and
   each side gets a COPY inside its own worktree: lane B's `Workdir:` sandboxes READS as well
   as writes (Claude-B call rules), so a controller-scratch path is unreachable from B, and
   the stated alternative — inline it in the prompt — reintroduces the retyped-bytes
   divergence this rule exists to kill. Copy the file, never retype it, and before spawning
   `sha256sum` all three (canonical + both worktree copies) and record the digest in the
   brief-authoring note: a blessed copy is only equivalent while the hashes match, and duel
   211's two per-worktree briefs can never be compared now that its worktrees are gone.
   `record_duel` refuses an `output_path` side whose dir holds no brief (v2.13.8).
   (Duels 206 and 208 shipped without one: the rule was three words inside the union step,
   and for a review duel the brief had never been a file at all — it lived only as prompt
   text inside the two spawn calls, so "persist the brief" meant authoring a file nobody
   scheduled. 207, minted the same hour by another session, wrote one.)
   **Brief pre-flight, before minting — the brief is the ONE input both sides share, so a
   defect in it reaches both and a judge is structurally blind to it** (KB
   `brief-authoring-defects-reach-both-sides`; 210 and 212 are its 4th and 5th instances and
   the first two to destroy a whole duel — 210 contested with two green trees, 212 voided
   after ~367k output tokens, re-run as 213 for another ~368k). The checks, all mechanical:
   Run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/dist/src/cli.js" brief-lint <brief> --root <repo>`
   first — a brief that fails it does not mint; the sidecar `.sha256` it writes is the hash the
   blessed-copy step compares, and `record_duel` refuses any output_path recording whose brief
   is missing that sidecar or no longer hashes to it — lint the FINAL brief text and spawn
   from those exact bytes.
   - **Reconcile every verbatim quote against the brief's own allowlist AND against the file
     on disk.** A quoted plan requirement naming a file the allowlist omits is either an
     allowlist entry you forgot or out of scope this wave — say which, in the brief. Grep the
     named key/symbol before quoting it (duel 210 quoted plan-v2 Task 13 demanding a
     `manifest.yaml` assumption key that does not exist, in a file the brief never
     allowlisted; both sides handled it identically and correctly, the judges split on it,
     43 minutes and two green trees shipped nothing).
   - **Verify every environment precondition the brief depends on, or pin it.** Deliverable
     formats, toolchains, packages: check the venv, then write the pin into the brief (duel
     212 mandated `.parquet` with no pyarrow installed and forbade both a format fallback and
     a dependency add; codex stopped BLOCKED-SCOPE, lane B declared a runtime fallback and
     ran 32.5 min, and the round had to be voided because the defect reached both sides).
     A deliverable the destination lane's permission profile cannot PRODUCE is the same
     defect one layer down: file modes are denied on lane B, so an executable-bit
     requirement (`chmod 755`) moves to the brief's declared controller-side execution
     list before minting — left on the side, the denial converts into a quality
     conviction (duel 261: the missing 755 mode bit was the SINGLE reason both judges
     failed a side whose denial was disclosed and honest; duel 258 lost a grade notch
     the same way one day earlier).
   - **Every structural index pin declares its base.** "row 4 col0" is read 0-based by one
     party and 1-based by another, and the side has no network to re-derive the layout; one
     "all row/column indices are 0-based" line clears every pin in the brief (duel 283: the
     side anchored by content instead and disclosed, one judge convicted the anchor as a
     softened pin, the other graded it a formality, and the duel contested).
   - **A negated null-family gate enumerates its absent encodings, beside the negation.**
     "A non-null X throws" gates the COMPLEMENT of a family the brief never lists: one side
     reads JS null, the other the file's full absent set (null / "null" / "" / "*"), and the
     judges inherit the two readings and split head-on (duel 289 F3: the literal reading
     hard-threw on 13 real-payload rows carrying the string "null", reported "Deviations:
     None", and the duel contested X-vs-Y).
     The same duty binds a POSITIVE presence gate ("when X is present"), field by field: an
     enumeration scoped to one column family leaves the fields beside it with no absent set —
     duel 414's D2 enumerated the INTEGER counts' encodings and left the TEXT columns
     (decided_by, winner_vendor) to the bare word "present", one side read JS truthiness, and the
     duel's only conviction rode on an empty-string decided_by, an encoding no engine writer
     produces (ledger: 0 rows).
     Since v2.13.93 brief-lint refuses a [BAR] presence gate ("when X is present" and its absent /
     missing / null / empty / blank forms) that has no straight-quoted literal within 200
     characters on either side, and only warns when no data field precedes the gate.
   - **A clone directive pins its acceptance surface.** "Clone the row shape those use" hands
     the member list to each side's reading of the reference: duel 283 D4 got a full-clone
     from one side and six of eleven fields from the other (both judges convicted the short
     one), and duel 289 F1's "clone its shape where the API supports them" left
     `payload_sha` unstamped behind a false impossibility claim. Enumerate the members
     ("complete list: …") in the brief, or explicitly mark the unpinned part side-judgment
     with a "disclose" instruction — the lint blocks a [BAR] clone directive with neither.
   - **Every pinned external layout ships its probe artifact.** A brief that pins a layout
     was written FROM a controller probe — put the probe file itself (payload sample, real
     workbook) in the worktree as a read-only input, name it in the brief, and require the
     covering-assert fixtures to DERIVE from it, never from the brief's prose re-description.
     Duel 289: the side's fixture used JS null where the real payload carries the string
     "null", so its own suite was structurally blind to a hard-throw regression; duel 283's
     hand-built wrong-format fixture is the same class one layer up. List the same artifacts
     in the judge dispatch — the judge template's behavior-claim rule ("checked against the
     task's probe artifacts") has nothing to check against otherwise, and the judge who
     endorsed 289's regression had no artifact in reach.
   - **Every fail-mode clause pins its observable.** A failure-path requirement stated only
     in prose ("one CCP's failure marks that CCP errored without zeroing others") is
     split-bait: the sides implement the two readings and the judges inherit them. Each
     error/fail-closed clause appears in the brief's REQUIRED test list with a fixture and
     the expected observable outcome ("all configured sources 404 → returns
     `{status:'error', sources:[…]}`" or "→ throws") — then both sides build the same
     behavior and there is nothing left to contest. Watch especially for an invariant written
     for N members instantiated with N=1: duel 298's per-CCP clause was a multi-CCP invariant
     over a one-CCP config, the all-fail case had no pinned outcome, one side threw, the
     other returned status, and the flipped verdict rode entirely on that unpinned reading
     (the judge's BRIEF-DEFECT line quoted exactly this clause).
   - **The scope clause names its LEVEL** — file-level ("edit only these paths") or
     API-surface level ("add no public name") — because a bare "scope" clause is read both
     ways and the judges will split on it (duel 211: the brief's control was a file
     allowlist, one judge read it at API-surface level and failed the side that added a
     second public method inside an allowlisted file, attributing to "the brief" a sentence
     it does not contain).
   - **One authority per brief: reconcile multi-document requirements BEFORE minting.** A
     brief that cites two requirement documents (a plan and its binding spec) diffs them
     first and writes each divergence's resolution into the brief itself — "plan line N
     overridden: use <spec form>, per spec §X". Never ship a runtime precedence rule
     ("where they disagree, the spec wins") and never pair one with a `verbatim`
     deliverable contract: on every divergence those two clauses contradict, each side
     resolves the contradiction its own way, and the judges split along the same line.
     The implementer builds; it never adjudicates requirements (duel 258: the plan
     diverged from its binding spec in at least eight places; one side transcribed the
     plan verbatim and flagged nothing, the other reconciled and flagged the one
     unresolvable conflict exactly as the brief ordered — one judge convicted the flag,
     the other passed it, and 121k output tokens of green-gated work went contested).
   Every brief that carries a stop-and-report escape hatch also carries its boundary:
   "BLOCKED-SCOPE stops the build only when a DELIVERABLE cannot land inside the file
   allowlist. A requirement that is not a Deliverable and falls outside the allowlist goes in
   DEVIATIONS and the build continues." Without that line the hatch swallows the whole task
   on any brief defect, and the two sides pick opposite readings of when to fire it (210, 212).
   Spawn BOTH sides in parallel per lane recipes. `mutating` tasks: each side works in its
   own git worktree and returns a diff; read-only tasks run in place. Worktrees are named
   `duel<id>-w1` / `duel<id>-w2`, NEVER by vendor or lane: `scrubIdentity` scrubs the packet,
   not the filesystem, and the codex sandbox gates writes and network but not READS, so a
   `duel211-anth` directory is a lane tell any judge can list (duel 211: both judges ran with
   the vendor-named worktrees on disk; the packet even redacted the same path to `/WORKTREE`,
   so the controller knew the name leaks and left the directories readable anyway). Every mutating brief
   carries an explicit file allowlist plus the escape hatch: "Fixture/test impossible as
   specified → STOP and report IMPOSSIBLE-FIXTURE. Never adapt production code to a test.
   A test EXPECTATION that contradicts the brief's own verbatim implementation is NOT an
   impossible fixture — correct the expectation toward stated intent and flag the deviation;
   STOP only when no intent-preserving test-side change exists."
   (duel 78: haiku-B silently weakened the shared cutoffFor S108 clamp to force a broken
   fixture green — its own 16/16 gate was structurally blind to the unauthorized scope.
   duel 196: the brief's expected `B[claude-a]` contradicted its own `basename()` code, which
   yields `.claude-a` — both judges failed the side that stopped IMPOSSIBLE-FIXTURE on it and
   passed the side that corrected the expectation and flagged it.)
   A brief that adds, removes or renames a PUBLIC surface also carries the pin-sweep line:
   "Before reporting, grep the tests for assertions that pin the surface you changed
   (`sorted(`, `dir(`, `hasattr`, `__all__`, enumerated name lists) and read each hit's FULL
   body — update the pins this brief invalidates." (duel 202: both sides missed a public-set
   pin — one side's `sed` window ended three lines above the assertion, the other only ever
   saw the test's name in a def listing, and the name said "privacy" while the last assertion
   pinned the set.)
   A fix-round or re-review brief quotes each original finding VERBATIM — the reviewer
   grades the shipped fix against the pinned text, never against its own re-derivation of
   the finding (duel 198: sol re-derived its own F4 into an inverted reading and graded a
   technically-accurate fix NOT ADDRESSED).
   Every brief carries the method-naming line beside the NOT-RUN mandate, tagged [PROCESS]:
   "[PROCESS] Every verification claim names the command you actually ran, verbatim, plus the
   path of any artifact holding its output — or says how you compared instead ('read both
   listings'). Naming a method you did not invoke is a defect even when your conclusion is
   right." The tag is the operator's call (2026-09-03): the SPELLING of a quoted command is
   process — a lost `\|` escape, a trimmed absolute path, an abbreviated echo, a mislabelled
   method — whenever the transcript shows the check ran and returned what the report says
   (duel 409: the codex judge failed the opus side on report truth for exactly that slip;
   duel 208: fable's cross-check really ran, but the report called it "comm-verified" and no
   `comm` was ever invoked — the mislabel drew an integrity FAIL that had to be retracted).
   Report TRUTH stays [BAR] and is stated separately: "[BAR] A result reported for a command
   that never ran, or a check claimed that the transcript does not show, is a false report
   claim." The judge template's FALSE-claim rule is the instrument for that clause, never for
   the spelling one.
   Every brief carries the simple-command line: "Run each shell check as ONE simple command.
   A pipe, heredoc or redirect makes the line unmatchable against the permission grant and it
   is denied whole — `git diff a..b` is allowed, `git diff a..b | head` is not. Run the bare
   command and filter its output yourself." This is a fairness line, not a style one: lane B
   is gated by command SHAPE while the codex sandbox gates by filesystem and network and runs
   any shell string, so every compound form B reaches for is a check its opponent gets for
   free (duel 202: 4 denials on compound heredoc/patch forms; 205: a read-side python
   heredoc; 208: 3 pipelines, then an allowed simple retry that completed the same check).
   Residual: the read-only grant is NOT intrinsically read-only — its git verbs accept
   `--output=<file>` and sqlite accepts SQL `VACUUM INTO`, both writers. The child is FORBIDDEN
   to use either (automatic integrity FAIL), the controller may check the envelope's command
   list, and an OS-level read-only sandbox is the named upgrade path.
   Since 2026-09-04 the grant is not even the bound: both offload dirs' `settings.json` carry
   `defaultMode: auto` (the operator's `.claude-b` block, mirrored into `.claude-a`), and the
   auto-mode classifier approves headlessly tools the grant omits — duel 417's `Mode: read-only`
   B judge ran `rg`, `node -e`, `tar` and wrote its own verdict file with `permission_denials: []`.
   Read every lane-B transcript as a full-toolset run, never take an empty denial list for
   "read-only", and never let the header stand in for a sandbox (operator, 2026-09-04: auto
   stays — "the most tools to be successful").
   Every brief carries the fan-out line (operator, 2026-09-03), verbatim to BOTH sides:
   "[PROCESS] You may fan out sub-agents on distinct subtasks — the Agent tool on a Claude lane,
   sub-agent rollouts on codex — each running your own model and effort unless the task says
   otherwise; your report names the count (0 is a count)." Fan-out is a lane capability both
   sides have and the measured edge on implementation-build: codex fanned out in 48 of the 59
   duels with a known count and won 29–14 there against 3–7 solo, while lane B fanned out in 0
   of 113 because no brief invited it (the web-research union brief does, and duel 257's B side
   ran six). Parity is level-up, never strip (see Harness parity) — the line invites, it never
   mandates, and a side that stays solo owes nothing but the count.
   Every brief carries the serena line (operator mandate, 2026-09-03): "Navigate code with
   serena: on a lane that exposes it, open each source file with `get_symbols_overview` /
   `find_symbol` (or their `jet_brains_*` spellings) instead of reading it whole — where the
   server exposes `activate_project`, call it on your working directory first — and run every
   consumer sweep through `find_referencing_symbols`; Read is for non-code files and for a body
   serena cannot return. If a serena call errors, quote the error once in the report and carry
   on with grep and Read. [PROCESS] A code task whose transcript shows zero serena calls on a
   serena-equipped lane is a method defect. Serena's LSP backend reports `body_location` lines
   0-based: cite every line 1-based, as an editor shows it, or cite the symbol name instead."
   (duel 407: the side transcribed LSP lines unconverted and lost a grade notch on it.) A lane
   without serena (codex) navigates as before
   and says nothing about it. The controller verifies from the session file, never the report —
   and since v2.13.82 the engine does it on the read it already makes: `record_duel` attests each
   Claude-lane side's count from its proof artifact (`serena_calls` per vendor in the reply,
   `anth_serena_calls` / `gpt_serena_calls` on the row; NULL for lane A, the codex family and an
   artifact with no tool-bearing turn; 0 is a measurement) and `record_judgment` returns
   `judge_serena_calls`. The hand check `grep -c '"name":"mcp__serena' <session>.jsonl` stays for
   lane A (the subagent transcript) and for a pre-record look, and it over-counts a report that
   quotes its own tool names — the engine counts `tool_use` blocks. Measured 2026-09-03 before the mandate: lane B had called serena in 3 of 425 sessions and
   never once called `initial_instructions`, so the server's own "read the manual" nudge does
   nothing headless — only the brief reaches the side. Reach differs by lane (harness parity,
   below): lane B's server runs the LSP backend and follows any Workdir; lane A carries two —
   `serena` (JetBrains, session-root paths only; a worktree path gets `No file found for
   RelativePathMatcher`) and `serena-lsp` (LSP, no project at start: `activate_project
   <workdir>` first, then every tool including references follows that root).
   Every rule a brief carries is tagged where stated: `[BAR]` (verdict-affecting) or
   `[PROCESS]` (grade-affecting only). BAR is substance and integrity: wrong behavior, a
   missing Deliverable, an out-of-scope edit, a claimed result for a command never run.
   PROCESS is method: reading protocol, command shape, report formatting — the
   simple-command line above is PROCESS by construction (it exists as a lane-B permission
   workaround, not a quality bar). An untagged rule is BAR only when breaking it changes
   the shipped tree's behavior, completeness, scope, or the truth of the report; otherwise
   PROCESS. The tag is the judge-calibration instrument: without it one judge reads every
   brief rule as bar, and under the neither-judge-failed-it intersection the stricter
   judge decides every contest (since duel 249 one judge voted `both` 0/7 while the other
   voted it 3/7; duels 258 and 263 convicted trees their own grader marked A-/B+, on
   reading protocol and command shape).
   Every review brief carries the severity rubric, and each finding cites the clause it
   matches plus the three facts behind it — reachable on a supported path? silent or
   announced? blast radius (this machine / every copy, backup and restore / docs only):
   "P0 — data loss or a corrupted ledger. P1 — wrong behavior reaches a supported path with
   no error and no log. P2 — a consumer surface (docs, tool description, brief, comment)
   prescribes the wrong path, or wrong behavior is reachable but announces itself. P3 —
   invariant hygiene: no reachable wrong behavior. Grade by the clause your own three facts
   match, not by how sure you are of the finding." (duel 207: both sides described the same
   unreachable seed row in the same words — silent misroute on every copy but this one — and
   graded it P2 and P1. A union ships unjudged, so a self-graded severity is the only ranking
   the operator gets; the rubric is what makes two sides' grades comparable at all.)
2. Capture per side: full output (or diff), total tokens, wall-clock ms, failed?, proof.
   Persist the output to `.review-scratch/duel<id>-{anthropic,openai}.md` and pass its
   ABSOLUTE path as `output_path` — the engine stores the file's own bytes, where inline
   `output` is the controller retyping the report and drifts from it unseen (duel 206).
   MUTATING sides: also persist the full patch — `git -C <worktree> diff` into
   `.review-scratch/duel<id>-{anthropic,openai}.patch` — and APPEND it to that side's report
   file under a `## DIFF` heading before recording, so it reaches the packet through
   `output_path` and gets scrubbed with everything else. Two things break without it. The
   judges grade two self-written reports, so a defect is visible only when its author
   discloses one, and the disclosing side has now lost on its own disclosure twice (211, 213
   — see the judge template's DISCLOSURE clause); the allowlist check below is
   `--name-only`, so an undisclosed change INSIDE an allowlisted file is invisible to
   everyone. And the moment the worktrees are removed the graded claims are unre-checkable
   forever — 211's winner can never be re-audited (precedent for keeping the patch:
   `duel163/166/201-diff.patch`).
   The engine bounds `latency_ms` in BOTH directions: a claim above the duel row's own age is
   refused (v2.7.4, no over-claimed estimates), and on the FIRST recording a claim more than
   60s below the side's attested session-artifact span is refused too (v2.10.5, no
   under-claims — the clock decides duels after quality). Pass the measured wall-clock, or
   null: a null on a first recording is auto-measured from the artifact's own span
   (v2.10.12); revivals, late union fills, and blank-side repairs of an already-recorded
   row (the engine's own repair flow — filling a side a recorded row is missing) skip the
   floor and keep null, because a resumed artifact's mtime inflates the span past the true
   run. (A gate repair round is NOT one of these: it happens before the first recording —
   see the repair rule below.) An artifact spanning longer
   than the duel row has existed measures nothing at all (v2.10.16) — it contradicts itself,
   so it neither floors a claim nor becomes one.
   On a first recording a proof must name exactly ONE session file under its root: two fresh
   files answering to one proof are refused by name (v2.10.17), because whichever the engine
   picked, the side that wrote them chose the answer. If you hit that refusal, delete the stray
   copy — an archive, a backup, a `cp` of the live rollout — and re-record.
   Proofs come from artifacts the lane WROTE, never from ids the child prints in its result
   text (2026-07-31: haiku fix-round child fabricated a session_id inside its JSON; spark
   echoed the CONTROLLER's id) — B: the envelope's top-level `session_id`; codex/spark: the
   rollout FILENAME under `~/.codex/sessions` (newest, mtime inside the run window,
   lane-matching). Mutating duels: before recording, run `git diff --name-only` per side
   against the brief's allowlist — an out-of-scope file gets a controller fact-check note
   appended to that side's stored output, where the judges see it.
   Sweep briefs with a residual/zero truth-gate: the CONTROLLER re-runs the gate itself,
   and residual-zero only counts if every path-like reference the side rewrote resolves in
   `git ls-files` — a reference renamed to a nonexistent path is a gate FAIL and a
   `record_outcome {kind: FAIL, integrity: true}` (duel 97: spark zeroed the residual count
   by pointing archive references at paths that do not exist). Never let the contestant
   run its own gate.
   When a brief carries a build/test gate the fighters cannot run themselves (no
   venv/toolchain in the scratch worktrees), the controller runs that gate on each side's
   tree BEFORE spawning judges, and a red gate buys that side exactly ONE repair round:
   hand the side its own failure list verbatim, let it patch its worktree, re-run the gate
   once. Judges grade the FINAL tree; the controller fact-check note and the side's
   `environment` both name the repair round (it counts like a respawn). A repaired side's
   null `latency_ms` does NOT stay null: a repair precedes the first recording and the
   engine has no repair concept, so a null is auto-measured like any fresh record for an
   artifact-attested side (B/codex/spark — lane A has no artifact clock, so a repaired
   lane-A side passes its measured wall-clock as always, and an artifact with no parseable
   span also stays null) — the
   stored clock is the attested artifact's span, repair included when the resume extended
   the same artifact (duel 204: sol's `--resume-last` appended, the span carried the
   repair). Only if the repair wrote a SEPARATE artifact (proof span ends at the main run)
   pass the measured wall-clock to the final tree instead of null — otherwise the repair
   vanishes from the clock. The `environment` repair note is what lets a report reader
   discount the number. The gate is the target repo's FULL existing test suite plus the
   brief's own test list — never only the new deliverables' tests: duel 298's gate recorded
   `pass` on a tree that failed the repo's own suite (an enum-vocabulary regression the
   suite's r12 catches), one judge graded that tree A on top of the side's "tests green"
   claim, and the split went contested over a fact the gate should have settled before
   either judge opened the brief. Pass the FINAL result per side to `record_duel` as
   `gate: "pass"|"fail"` (null or omitted for a kind with no gate to run) WITH
   `gate_detail` = its receipts, the commands run and their pass/fail counts — the engine
   refuses a bare token (v2.13.50). Ship each side's gate transcript into the judge
   directories beside the probe artifacts (`gate-x.txt` / `gate-y.txt`, blind labels): tree
   state is controller-verified ground truth, and a judge must never carry a "passes tests"
   claim it cannot check — the codex judge is sandboxed to its own directory and
   structurally cannot run a suite in a worktree it cannot reach, which is exactly how
   298's evidence asymmetry happened. That field is what
   this protocol's "a failed gate overrides any judge vote" actually rides on: the resolver
   has consumed a gate since v2.11.0 but nothing WROTE one until v2.13.14, so for three
   releases the override was prose with dead code behind it and two judge votes could pass a
   red tree. Both sides get the same offer, one round each, a second
   red is final (duel 202: both sides missed one authorized 3-line pin update; the gate that
   would have told them was unrunnable in their worktrees, and `both_failed` voided an hour
   of paired work).
3. Call `record_duel {duel_id, anthropic: {...}, openai: {...}}` (each side includes
   `proof`). An "unattested side" error means the lane did not really run — fix the
   spawn (subagent_type, never teammates) or record that side `failed: true`; never
   fabricate metrics to satisfy the check.
   Each side also carries `environment`: one line naming that side's unseen fighting
   conditions — toolset/MCP servers available, network access, sandbox, worktree, and
   respawn/retry count. This feeds the session report's fairness section; model/effort are
   NOT environment (they are the duel itself). Record what the side actually had, not the
   lane's usual shape — a respawn, a denied tool or a gate repair round is exactly what this
   field is for.
   Before recording, diff the two sides' NOT RUN lists (B: the envelope's
   `permission_denials`; codex: the rollout): a check ONE side was refused and the other ran
   is an asymmetry in the fight, not a gap in the report — name it in the denied side's
   `environment` so the fairness section carries it, and fix the lane's grant before the next
   duel rather than after the next review (duel 207: fable's read-only live-DB probe was
   denied and sol's identical probe ran, so one side of a union had to file its live-state
   claims unverified while the other confirmed them).
   When the lane's token count is not billed-output (codex rollout totals
   count cached input re-reads), `environment` names the basis — duel 201 recorded
   2,488,083 sol tokens against 158,306 fable: a basis gap, not a 16× spend gap, and
   unreadable as fairness data until labeled.
   Two rules about WHICH number, because the clock is floored against its artifact and the
   token count is not — the engine checks only that it is positive (`duel.ts` attestation),
   so a wrong token count is stored as fact:
   Run `mrctl tokens <rollout(s)|envelope>` and record ITS numbers — a token count the tool
   cannot derive is stored as null, never retyped from a side's own claim.
   - Read the LAST `total_token_usage` event in the rollout, at record time. A snapshot taken
     mid-run is a different number and nothing catches the difference (duel 211 stored
     `gpt_tokens=46,519` against a final event of 47,170 out / 6,834,671 in / 6,608,896
     cached, written to disk 13.5 minutes before the row was recorded — the signature of an
     earlier snapshot, while the env line claimed the rollout total).
   - A codex side that FANS OUT spends across several rollouts and the parent's total excludes
     them. Grep the parent for `sub_agent_activity kind=started` — and, because codex-cli 0.153.0
     writes the link in each CHILD instead (its `session_meta` carries `thread_source:
     "subagent"` and `source.subagent.thread_spawn.parent_thread_id` = the parent's id; duel
     409's parent logged no sub_agent_activity line and had three such children), also read the
     first line of every rollout started within a minute after the parent that names your
     worktree. Either shape present means the extra
     rollouts are that side's OWN sub-agents on distinct subtasks — sum them, and name the
     count in `environment`. Absent means duplicate launches of the same task, which is the
     v2.10.17 two-files-one-proof refusal and a spawn to kill, not a spend to add. Duel 213
     recorded the first as the second — "THREE concurrent rollouts racing in one worktree,
     ~3x duplicated spend" against a parent logging three `sub_agent_activity` starts with
     distinct `agent_path`s, four rollouts in total, and a stored token count covering only
     the parent — so the session report's fairness section carried a false story about the
     winning side.
   - A lane-B side that FANS OUT (the Agent tool) writes each sub-agent's transcript beside its
     session file — `<projects dir>/<session id>/subagents/agent-*.jsonl` — and the parent's
     usage excludes them: duel 257's B parent alone read 98,878 output tokens against 387,623
     with its six children. Pass the parent to `mrctl tokens` — since v2.13.90 it adds every
     `.jsonl` in that directory itself, each child listed in `sources` — and name the count in
     `environment`. The engine adds their serena calls to the side's attested count on its own
     (v2.13.87); model and effort stay the parent's.
   - `walkover` response → use the survivor's output; done. Mutating duel: DISCARD the dead
     side's worktree (`git worktree remove --force`) — partial edits from a mid-flight death
     must never reach the tree (duel 94: dead B child left half-applied worktree edits).
   - `awaiting_judgment` → you get a blinded packet {X, Y}. Do NOT try to identify sides.
   - A `superseded: [ids]` key on the response means this recording DISPLACED older in-flight
     audits of the same kind: those rows died because THIS audit succeeded, not because their
     lanes kept failing — a displacement is never a dying-audit signal. If a superseded id's
     lanes really ran, revive it by id (`record_duel` with the real outputs); otherwise LEAVE
     IT ALONE — its pending-list entry is a tombstone, and recording a double failure against
     it adds nothing the engine does not already know.
   - Neither side produced a verifiable result (both lanes hung / no rollout written)?
     Call `record_duel` on the SAME duel id with BOTH sides `failed: true` — it lands the row
     `abandoned` (death-stamped, listed on the pending surfaces, revivable by id) and tells
     every subsystem the same thing. Never fabricate a walkover or outputs: a walkover needs
     a survivor whose output you actually have.
   - VOID THE ROUND — the sides ran fine and the BRIEF was broken. This is its own recipe
     because the both-failed one above ("both lanes hung / no rollout written") describes
     neither half of it, and duel 212 had to overload that recipe for want of anything else.
     A judge is structurally blind to a defect that reaches both sides, so voiding is the
     correct call and a walkover would be the wrong one — it scores a side for winning a
     broken environment. Three parts, all required: both sides `failed: true`, each side's
     `environment` carrying the reason and its real token spend (a failed side now stores
     both — v2.13.13), and `superseded_by: <re-duel id>` on the call, which tombstones the row
     so no later session revives a round you threw away. Mint the re-duel FIRST with the
     ambiguity pre-adjudicated in its brief (213 pinned pyarrow, forbade the fallback and
     forbade runtime probing), then void the old row pointing at it. Skipping the tombstone is
     what left 212 reading `abandoned, revivable by id` on the pending surface for a week,
     with both its reports still on disk, inviting a session to score a 3.8 KB blocked stub
     whose anth side never ran a gate. A duel you could not even record (controller
     dying) is caught by the SessionStart sweep, which marks any duel still `routed` 6h after
     routing, or still `awaiting_judgment` 6h after its results landed (`recorded_at` — the
     judging window is not eaten by the sides' own runtime), as `abandoned` too. The sweep
     names the ids on the hook's stdout, and every pending or recently-abandoned row stays
     listed (id + kind + status) in `mrctl status`, `mrctl standings`, and the `standings` MCP
     tool's `pending` field — act on those by id. A row still `routed` may belong to ANOTHER live session — one mr.db serves
     every repo (2026-09-03: #408 on this session's pending line was another repo's duel, both
     sides in flight) — so run `pgrep -fa "duel<id>"` and look for a growing session file under
     the offload dir's `projects/` before adopting it; mint your own otherwise. An abandoned row is still recordable later: if the lanes really
     ran and only the controller was interrupted, `record_duel` on the original duel id revives
     it. Do that rather than routing a new duel — a new row's attestation window post-dates the
     session files the lanes already wrote, so those runs could never be attested again.
     Two markers on that listing change what "act on it" means. A row marked
     `displaced by #N` — or bare `displaced`, when a pre-2.6.12 writer stamped the death
     and no recording duel id exists (`displaced`/`supersededBy` in the MCP fields) — is a
     TOMBSTONE: it died because a rival audit succeeded, not because its lanes kept
     failing — revive it by id only if its lanes really ran, otherwise leave it alone;
     never record a double failure against it.
     A row marked `VOIDED` (`voided` in the MCP fields) wears the same tombstone and carries
     the OPPOSITE rule: NEVER revive it, however well its lanes ran (since v2.13.66 the
     engine refuses: `record_duel` throws "was voided"). Its lanes running is
     precisely not the question — the controller threw that round away on purpose and
     re-duelled it, so a revival scores a discarded round against work the re-duel already
     shipped. The two are told apart by the marker only a controller's own death record
     writes, so the surfaces can print the right instruction.
     A row with status `union` is a union still missing a side (or holding none): record the
     recovered side on the SAME id per union step 7 — it is never judged.
4. Spawn TWO judges in parallel with the judge template below. Judges are fixed by this
   protocol — do NOT call `route_task` for them.
   Blind hygiene is a FILESYSTEM property, not just a packet one. The engine's only enforced
   name is the report's basename (`duel<id>-<vendor>.md`), so the side artifacts and the
   canonical brief live in the CONTROLLER's own scratch — never in the tree the judges are
   pointed at (duel 211 ran both judges with cwd `<repo>` while
   `duel211-{anthropic,openai}.md` sat in that tree's `.review-scratch/`). Judges are
   deliberately given the repo — the judge that verifies claims against it is the stronger
   instrument (duel 213: the anth judge spent 6.5 min and 38 Bash calls on the live
   manifest, the gpt judge 59s and zero tool calls) — so the fix is to remove the tells, not
   the access. `scrubIdentity` also redacts `duel<id>-w*` / `duel<id>-judging-*` paths and
   first-person lane self-identification ("on this Codex lane") since v2.13.83 and, since
   v2.13.88, the fan-out mechanism names each lane uses (`Agent tool` / `Task tool`,
   `sub-agent rollouts`, the codex `spawn_agent` family) — duel 409's packet carried both —
   and, since v2.13.91, the model, vendor and agent-type names inside a report's SUB-AGENTS
   section — duel 414's packet named "opus" and "general-purpose" there; the rest of the report
   and the diff are spared because this repo's own vocabulary is full of model names —
   but eyeball the judge task for tells before spawning: the third-person topic ("the codex
   lane") is spared on purpose. Residual, stated plainly rather than assumed away: lane B's
   `Workdir:` sandboxes reads, the codex sandbox does not, so for the gpt judge the blind is
   hygiene the protocol cannot prove after the fact. Because they are fixed at lanes B and
   codex, `route_task` refuses to create a duel while either judge lane is `closed` (it routes
   single with a `judge lane … closed` note instead) — a duel routed then would be unjudgeable
   from creation, which is how duels 46/49/53 were lost:
   - anthropic judge: claude-b, header `Model: opus.` + `Effort: xhigh.` +
     `ConfigDir: <b_config_dir>.` —
     the dir comes from THIS duel's own `route_task` response, which carries `b_config_dir`
     on every judgeable decision, including duels whose anthropic side routed lane A. A
     judge skips `route_task`, so nothing else hands it the offload dir: without the header
     it falls back to the default, and under a flipped main account its vote is
     proof-refused for being written outside the offload dir's `projects/`.
     Serena is mandatory for this judge too (operator, 2026-09-03: "judges should be
     mandated as well"): `record_judgment` attests the count from the judge's session
     file and returns it as `judge_serena_calls` (v2.13.82; the hand grep
     `grep -c '"name":"mcp__serena' <judge session>.jsonl` on the file under the offload dir's
     `projects/` stays as the pre-record look); a zero on a code duel is noted to the operator beside the
     vote — never a respawn, the vote stands and the count is a calibration signal (the
     judge that verifies against the tree is the stronger instrument, duel 213 above).
   - gpt judge: codex-rescue, first line `Use --model gpt-6-astra --effort xhigh.`
   - The gpt judge must be LAUNCHED from a writable directory (codex exec dies 'Read-only
     file system' otherwise) — the launch sets the sandbox root, a `cd` the prompt asks for
     does not (codex call rules) — and its prompt states: "a rollout under ~/.codex/sessions
     MUST exist; a vote without one is void." A judge reply in seconds with zero tool uses and no
     rollout is the wrapper cosplaying the vote (2026-07-31 incident) — `record_judgment`
     rejects it anyway; respawn once with the rollout mandate, don't debug.
5. `record_judgment {duel_id, judge_vendor, verdict, grade_x, grade_y, path, proof, rationale}`
   for each (verdict exactly `both`, `X`, `Y` or `neither`; `proof` = that judge run's session
   id; `path` = the judge's PATH line, verbatim). A side passes only when NEITHER judge
   failed it.
   `grade_x`/`grade_y` = the letters from the judge's GRADES line, verbatim (A+ through F).
   Mandatory on every new vote: the GPA trend is only as complete as its worst session. A
   judge reply missing its GRADES line gets ONE respawn with the template re-quoted; if the
   respawn still omits it, record the vote ungraded and note the gap to the operator —
   grades are observational and never worth a third judge run.
   `rationale` = the judge's written reason, passed VERBATIM from the judge's reply (the
   lines after its verdict token). Blind X/Y terms only — if a judge's rationale names a
   vendor, lane, or model, the blind is broken: drop the rationale (record the vote with
   `rationale: null`) and note the leak to the operator. Rationale never influences
   resolution; it exists for the operator's session report.
   `brief_defect` = the quoted clause from the judge's BRIEF-DEFECT line, verbatim, when
   the reply carries one (optional; most votes do not). It marks contested-by-ambiguity
   for the operator — a contested row whose votes quote the same clause is a brief
   problem, not a model problem, and the clause is the next lint class's corpus
   (duels 283/289: two of three contested rows traced to brief text, found only by
   manual archaeology). Never influences resolution.
6. Second grade resolves the duel:
   - `judged` / `judges` → exactly one side met the bar. Ship it, apply its diff for mutating
     tasks, discard the loser's worktree.
   - `judged` / `latency` → both met the bar and the faster one wins. Ship the winner.
   - `unresolved` / `unresolved` → both met the bar, the clock could not separate them. Both
     are correct: ship either, discard the other worktree, record no winner.
   - `unresolved` / `both_failed` → nothing met the bar: either the judges agreed on that, or
     both sides failed their build/test gate, which overrides any judge vote. Discard BOTH
     worktrees, tell the operator, re-run the task yourself or re-duel it. Never ship a side.
   - `unresolved` / `contested` → the judges failed different sides, so no side is proven.
     Same handling as `both_failed`, and it is also a signal about the JUDGES: report a run of
     contested rows to the operator. On a HEAD-ON split (verdicts X and Y, not X-vs-neither),
     offer the operator one fact-check round before the outputs are discarded: a head-on split
     is usually one checkable factual claim ("Y throws on the real payload: yes or no"). Hand
     each judge ONLY the other's disputed factual claims plus the probe artifacts — no grades,
     no re-vote — and ask confirm/refute per claim; the answers go to the operator's record,
     never into record_judgment (one vote per vendor stands). Operator-triggered, two short
     judge runs — record_judgment now returns the offer as `factCheck` on the resolving call
     and its replays, and `mrctl contested` marks the backlog rows (v2.13.49). Duel 289
     resolved exactly this way, manually: 13 string-"null" rows in the probe payload settled
     in minutes what two full rationales could not. When the fact-check (or the operator's own
     ground-truth pass) shows a verdict rested on a load-bearing claim its judge could not
     check and did not mark UNVERIFIED, that is a JUDGE conviction — classify it dispatch-first
     like any other, and say so in the resolution prose (duel 298: "satisfies the tests"
     graded A over a tree whose suite was failing; the judge could not run it and asserted it
     anyway).
   - `judged` / `merge` → both sides met the bar AND both judges' PATH lines said `merge`:
     the ship is the COMPOSITION, no side is credited a win. Controller merge procedure,
     every step mandatory:
     (a) Read both rationales for the per-side deliverable split the judges named. If the
         two splits contradict each other on any file, treat the merge as unexecutable —
         fall back to the `unresolved`/`unresolved` handling (both are correct, ship
         either), and note the contradiction in the session record.
     (b) Compose in a FRESH worktree off the same base commit — never in either side's
         worktree: start from one side's diff, graft the named pieces of the other.
     (c) Run the full deciding gate on the composition. Two individually green diffs can
         still cancel each other — this gate is the entire reason the merge outcome is
         allowed to exist. Gate red → ONE repair round (the composition's own defects only,
         never new scope); still red → discard the composition and fall back to
         `unresolved`/`unresolved` handling. Never ship an ungated merge.
     (d) Apply the gated composition for mutating tasks; discard both side worktrees.
     A single `merge` PATH (the other judge named a side or nothing) changes nothing: it is
     stored on the vote, printed in the report, and the duel resolves by the ordinary rules.
7. **No automatic decisions (operator, 2026-08-10 — machinery deleted).** The engine records
   duels, judgments and standings but never settles a contest: the former victory/split
   thresholds, the auto-reopen rule and the `auto-decide` toggle are deleted from the engine.
   Every kind duels indefinitely; the operator analyzes the tracked scores and declares
   winners manually. A manually decided row (matrix `decided=1`) still routes single with
   1-in-10 spot-check audits: the spot-check slot is spent when the audit's results are FIRST
   recorded, not when it is routed — an audit that dies un-run re-fires after a 1h backoff
   measured from its DEATH (the sweep's stamp or the failed record; repeatedly dying audits
   are an operator signal, surfaced in the route note), a revived audit never re-spends the
   slot, and only one spot duel is in flight per kind at a time (in-flight = routed or
   awaiting judgment; a revival that would create a second concurrent audit lands as a plain
   record instead — still a PAID audit, so its verdict stays in the record).

## Judge template

    You are GRADING two anonymous solutions to the same task. Do not guess which model
    wrote which. Ignore style, verbosity and elegance.
    Grade each solution INDEPENDENTLY against an absolute bar. This is not a comparison
    and there is no "better": a solution is not acceptable because the other one is worse.
      PASS = correct, complete, and touches nothing the task did not ask to touch.
      FAIL = any incorrectness, any missing requirement, or any out-of-scope change.
    Read those two words the way the TASK defines them, not the way you would:
      COMPLETE = every Deliverable the TASK lists. A requirement the task quotes but
      places OUTSIDE its own file allowlist is not a completeness defect when the
      solution flagged it — the task, not the solution, put it out of reach.
      SCOPE is judged at the level the TASK states — file paths, or public surface,
      whichever it names. Never fail a solution against a stricter level you inferred,
      and never attribute to the task a prohibition its text does not contain.
      DISCLOSURE is never itself the defect. Grade a disclosed deviation against the
      task exactly as if it had not been disclosed; an undisclosed change the diff
      reveals is an automatic FAIL. A solution must never score better for hiding work.
      REDACTIONS: the literal tokens `<path>` and `<redacted>` were substituted by the
      grading harness into BOTH solutions before you saw them (they replace filesystem
      paths, artifact names such as report basenames and rollout filenames, session
      ids, the names of symbol-navigation tools one lane carries, the names of the fan-out
      mechanism each lane uses — its sub-agent tool names and phrases — and the model, vendor
      and agent-type names inside a report's sub-agent list). They
      are never a solution's defect, never an abbreviated
      or hidden command, and never evidence of out-of-scope work — read through them.
    Both solutions may PASS. Both may FAIL. Say so.
    TASK: <task statement>
    SOLUTION X: <packet.X>
    SOLUTION Y: <packet.Y>
    Reply with exactly one token on the first line:
      both    — X passes and Y passes
      X       — X passes, Y fails
      Y       — Y passes, X fails
      neither — both fail
    On the second line, grade each solution like a teacher grades a student:
      GRADES: X=<letter> Y=<letter>    (letters: A+ A A- B+ B B- C+ C C- D+ D D- F)
    On the third line, recommend the best path forward:
      PATH: <X|Y|merge>
    Say `merge` only when BOTH solutions meet the bar and each carries specific work the
    other lacks that the task is better off with — then your RATIONALE must name which
    deliverables to take from X and which from Y, concretely enough for a third party to
    compose them without re-deciding anything. Otherwise name the side you would ship.
    If your verdict turns on a requirement whose text admits two readings and X and Y
    split along them, add one line:
      BRIEF-DEFECT: "<the exact quoted clause>"
    Grade against your best reading anyway — the line marks the split's cause for the
    controller; it excuses neither side.
    A claim that code BEHAVES wrongly (throws, drops data, breaks on real input) is
    checked against the task's probe artifacts when any are listed; a behavior claim you
    could not check is stated as UNVERIFIED in your rationale, never as fact.
    The same rule binds claims that code behaves RIGHTLY: any "passes tests" / "satisfies
    the test requirement" statement in your rationale must name its receipt — the command
    and its pass/fail counts, read from the gate transcript in your directory (gate-x.txt /
    gate-y.txt) or from a run you made yourself — or be written UNVERIFIED. A solution's
    own report is never the receipt; a gate transcript in your directory outranks anything
    the report claims.
    Structural claims — a symbol exists or was removed, a caller was updated, a consumer
    sweep is complete, a file type-checks — you check with serena on the tree in your
    directory where your harness exposes it: `get_symbols_overview` / `find_symbol` for the
    symbol, `find_referencing_symbols` for the sweep, `get_diagnostics_for_file` for the
    check (call `activate_project` on your directory first if the server exposes it). Name
    each call you made in your RATIONALE the way you name a command; a serena error is quoted
    once and the claim stays UNVERIFIED. A harness without serena checks the same claims
    with grep and says nothing about the tool.
    Convicting a claim as FALSE binds tighter still. A report's numeric or
    command-output claim is false only when re-running the report's OWN quoted command,
    verbatim, against the same files produces a different result — and your rationale
    quotes both the command and the divergent output. Output from any other command,
    however similar its intent, contradicts nothing: a different measurement is your
    number beside theirs, not proof theirs is wrong. If the quoted command cannot be
    run in your directory, the claim is UNVERIFIED, never false, and a conviction must
    not rest on it. A quoted command whose spelling differs from the transcript's — a
    lost escape, a trimmed path, an abbreviated echo — while the transcript shows that
    command ran and returned what the report says is a transcription slip under the
    TASK's [PROCESS] method-naming line: grade notches, never a false claim (duel 409).
    The grade records HOW WELL the work was done and is independent of the verdict: a
    solution that fails its bar on one requirement may still grade A-, and both facts are
    true. An inconsequential formality — report formatting, a stylistic placement choice,
    an abbreviated or mis-escaped echo of a command the work demonstrably ran — costs at
    most one grade notch and never drops otherwise-complete, correct work below B+.
    Substance defects (wrong behavior, missing deliverable, out-of-scope edits) have no
    such floor.
    A rule the TASK tags [PROCESS] costs grade notches only and NEVER flips a verdict,
    however many times it was broken. Only [BAR] rules and substance defects fail a
    solution; an untagged rule is BAR only when breaking it changes the shipped tree's
    behavior, completeness, scope, or the truth of the report.
    The same severity line runs through [BAR] clauses themselves: a deviation you have
    confirmed in the diff fails the clause only when it changes an observable the TASK
    pins (emitted output, stored data, a mandated throw, a test outcome) or was left
    undisclosed. A disclosed, intent-preserving deviation inside the allowlist that
    leaves every pinned observable intact costs grade notches, never the verdict — and
    when the TASK itself forced the deviation (its own constraints admit no compliant
    alternative), it costs nothing. Judge the observable, not the mechanism: a guard the
    clause enumerates that another path in the shipped code demonstrably supplies is a
    strictness gap (grade), not a missing requirement (verdict) — unless an input exists
    on which the observables differ, in which case name that input in your rationale
    when you fail the side.
    A verdict that passes one side while failing the other carries an extra duty:
    every check that produced a defect on the failing side must be run against the
    passed side too — the same clause, the same fixture, the same probe — before the
    verdict is yours to give. A defect class you probed on only one side is not a
    discriminator; it is where the split you are about to cause comes from. Your
    rationale must show the parity run: for each defect that decided your verdict, one
    clause saying the passed side was checked against it and what you found.
    Then, starting on the next line, RATIONALE: 2-5 sentences stating WHY each solution
    passed or failed its bar — the specific defect or the specific requirement met.
    Refer to the solutions only as X and Y. Never guess or name a model, vendor, or lane.

## Lane recipes

| Lane | How to spawn | Bills to |
|------|--------------|----------|
| A | native Agent tool / agent(prompt, {model}) — NO effort channel: the side runs at the session default, and a B→A shift's route note says `effort <x> not enforceable on lane A`; record that effort as `session default`, never the pinned one. Serena: `serena` (JetBrains, session root) + `serena-lsp` (LSP; `activate_project <workdir>` first, references follow it) | Claude sub A |
| B | agentType claude-b; first prompt line `Model: <haiku\|sonnet\|opus\|fable>.`, plus route_task's `b_config_dir` as `ConfigDir: <path>.` and the side's effort as `Effort: <low\|medium\|high\|xhigh>.` in the courier header block (grammar: Claude-B call rules). Serena: its own LSP-backend server per Workdir (harness parity) | Claude sub B |
| codex | agentType codex:codex-rescue; first line `Use --model <id> --effort <low\|medium\|high\|xhigh>.` (`max` rejected by codex-cli 0.147.0) | ChatGPT sub |
| spark | codex-rescue with `Use --model gpt-5.3-codex-spark --effort <side effort>.` | Spark pool — METERED (v2.13.33, retiring the 2026-07-25 unmetered doctrine): its own weekly rolling window, polled from spark rollouts; a hard-capped reading holds the lane CLOSED until that window's own reset. When closed, `route_task` substitutes gpt-5.6-luna@high on lane codex (see the matrix notes above) |

## Session report

Every session close writes a duel report for the session's window — via the SessionEnd hook
in the USER's settings.json (`mrctl report --session-end`). Claude Code NEVER dispatches a
plugin-registered SessionEnd hook (2026-08-13 forensics; the dead plugin entry is removed as
of v2.13.22), so an install without the user-settings hook writes no reports — recover any
missed window with `mrctl report --window <fromMs,toMs> [session-id]`. The report carries
quality/latency wins with the judges' verbatim rationales,
timing (wall, execution span, idle, judging span), and a fairness section built from the
lane baselines plus each side's recorded `environment`. Reports accrue in the plugin
repo's own `Session reports/` dir (`MR_REPORTS_DIR` overrides) and regenerate
idempotently if the same session closes again. Zero-duel sessions write nothing.
Reports cover CLOSED duels only (v2.13.35): in-flight rows (`routed`/`awaiting_judgment`) are
never rendered or claimed — a session-close claim of a live duel buried its results forever
(duels 251, 258). A duel that closes after its session's report ran surfaces via a
`--window` replay over its mint window.
The pop-up (JetBrains `idea` if on PATH, else `xdg-open`) is the ONLY optional part:
`mrctl report auto on|off`, command override `mrctl report open-cmd <cmd|auto>`.
Manual regeneration: `mrctl report --window <fromMs,toMs> [session-id]`.

### Harness parity — what a duel measures (operator, 2026-08-10)

What the engine can and cannot check, stated once so no report claims more than it proves: a
codex-family proof is lane-checked (`laneAccept` — a spark rollout cannot attest a codex side
and vice versa), a lane-B proof is checked for being a session file under the offload root,
and since v2.13.20 the MODEL and EFFORT are attested from those same artifacts: an
extractable model that contradicts the routed side refuses the recording outright (the
cosplay class), an extractable effort that contradicts it is stored and flagged
(`effort_mismatch` on the reply), and judge proofs store their attested model/effort for the
operator's calibration. The residual, stated plainly: an artifact that carries NO extractable
model/effort attests nothing (columns stay NULL, silently) — observed live 2026-08-15: a
sonnet session file carried both fields, a haiku session carried neither, so attestation
coverage is model/version-dependent and a NULL is "unknown", never "verified". Lane A has no
artifact and never attests. Duel 211's complaint ("neither lane-B artifact's model or effort
was ever established") is closed for artifacts that carry the fields.

A duel scores **the lane as configured**, not the bare model: each side gets the best tools it
can use, and the job is to keep the *floor* even rather than to strip advantages. Do not disable
a lane's capability to make a matchup symmetric — level the weaker lane up instead. Per-kind
tooling (which lane gets `memories`, subagent fan-out, or a given MCP server for a given
task kind) is an open optimization, not a fairness bug.

Audited 2026-08-10 and equalized:
- Lane B runs under `CLAUDE_CONFIG_DIR=<b_config_dir from route_task>` (default
  `$HOME/.claude-b` when absent), a fully isolated config — it inherits
  nothing from lane A. It had no plugins enabled, no MCP servers, and no hooks, which made it
  the *poorest* lane in the matrix even though the matrix pairs it against codex in most kinds.
  It now carries the `serena` MCP server plus the `context7` plugin (verified connected).
  Serena on B runs `--language-backend LSP` (operator one-liner, 2026-09-03): the JetBrains
  backend serves only project roots open in the IDE and answers a headless side in any
  worktree — `duel<id>-w1`, `wv-judge<id>`, even `<repo>/.claude/worktrees/x` — with
  `ServerNotFoundError … STOP. Do not attempt any other tools` (probed 2026-09-03 on all
  three shapes). The LSP backend starts anywhere (`--project-from-cwd`, ~1.6 s cold to first
  answer), exposes 11 tools under the plain names (`get_symbols_overview`, `find_symbol`,
  `find_referencing_symbols`, `get_diagnostics_for_file`; no `jet_brains_*`), accepts
  absolute paths outside its root, and left `git status` clean in the probe worktree
  (`.serena/cache`, `.serena/memories` only). Diagnostics read the worktree's own
  `node_modules`: a worktree without them reports phantom `Cannot find module` errors.
  Each Workdir is still registered in `~/.serena/serena_config.yml` by `--project-from-cwd`
  (27 `wv-judge*` entries by 2026-09-03) — prune it when it bothers you, nothing reads the list.
- Lane A carries a SECOND server, `serena-lsp` (operator one-liner, 2026-09-03: a
  `mcpServers` entry in `~/.claude.json` with `--language-backend LSP` and no project flag,
  plus `mcp__serena-lsp` in the allow list), so a lane-A subagent reaches serena in any
  worktree: started with no project the server keeps `activate_project` exposed
  (single-project mode excludes it), a subagent activates its worktree (~0.1 s, registers it)
  and `find_referencing_symbols` answers worktree-scoped — the same server rooted at the
  repo refuses a worktree path outright (`outside of configured workspaces`, probed
  2026-09-03). Ceiling, stated plainly: ONE shared server per session, the last
  `activate_project` wins for every caller, so two subagents in different roots must not use
  it concurrently — mutating sides already run sequentially in the session worktree. The
  `serena` (JetBrains) server stays beside it for the operator's IDE-open root: 19 tools
  including `jet_brains_run_inspections` / `rename` / `type_hierarchy` that LSP lacks.
  `model-routing`'s MCP server stays broken there on purpose — the child must never call
  `route_task`; routing already happened.
- The `pal` MCP server was REMOVED from the whole system the same day (operator, 2026-08-10),
  lane B included. Its own activity log recorded 19 tool calls lifetime, the last on 2026-07-24,
  against 632 connection handshakes — every Claude and codex session was spawning it and never
  calling it. Do not re-add it to a lane for parity reasons: an unused server is startup latency,
  and the duel tiebreak is quality-then-time.
- `caveman`, `ponytail`, and `codex` stay disabled on B. They change output style and solution
  philosophy rather than capability, and lane-A subagents do not get their persona injection
  either — leaving them off keeps A and B behaviourally comparable.
- Codex reads `AGENTS.md`, Claude reads `CLAUDE.md`. Both `~/AGENTS.md` and
  `model-routing/AGENTS.md` are now symlinks to the matching `CLAUDE.md`, so codex sees the same
  house and repo rules the B child does. Before this, `~/AGENTS.md` was stale claude-flow
  boilerplate describing a different project — every codex duel under `~` was briefed wrong.
- Codex keeps `multi_agent`, `memories`, and `web_search_request` enabled per the axis above.

Any new lane, plugin, or MCP change re-opens this audit: check the *weakest* lane in the pairing
before assuming an advantage is unfair.

### Waiter contract — no bare waits
A turn must NEVER end while a lane is in flight unless a harness-tracked waiter is armed
(Monitor, or a background Bash until-loop). A dispatch that outlived its wrapper window is
an ORPHAN — headless B child, detached codex rollout — the harness does not track it, so no
completion notification can ever arrive. Ending the turn "waiting for its completion
notification" is the measured hang mode (2026-08-02: sessions idle 41m, 58m, 1h30, 2h16,
2×8h45 until the operator nudged). Every waiter loop must:
- exit (echoing a tag line) on the lane's completion signal — see per-lane signals below;
- ALSO exit when the child PROCESS is gone (`claude -p` / `codex exec` pid no longer
  running) — that is the primary exit signal; a dead child wakes the controller, it must
  never silence it. An mtime freeze ≥10 min with the pid alive is a STALL to look at, never
  an exit: xhigh runs sit silent for minutes inside one thinking turn (duel 391: the 60 s
  B signal fired at minute 2 of a 20-minute run and the 120 s codex signal at 140 s, both
  children alive and finishing normally — a controller obeying them relaunches a live side,
  the 2026-07-24 double-spend class);
- run under a hard cap: wrap in `timeout 1800` and echo `WAITER-TIMEOUT` on expiry — the
  controller wakes regardless, then applies the slow-vs-hung check and retry/walkover rules.

B-lane signals: the `claude -p` child exited (pid gone) — its session file under the
offload dir's `projects/<project>/` (`b_config_dir`, default `~/.claude-b`) is the result
and the `session_id` proof; the report file non-empty only ARMS the exit watch; session-file
mtime frozen ≥10 min with the pid alive = stall, look, do not relaunch.
Codex-lane signals: the codex process exited (pid gone), OR the newest lane-matching rollout
under `~/.codex/sessions` ends in a final assistant message (last `response_item`); rollout
mtime frozen ≥10 min with the pid alive = stall. A NON-EMPTY REPORT FILE ALONE IS
PROVISIONAL, never final: a codex side can
keep revising after the first write (duel 237: sol's report grew for ~10 more minutes,
35,396 → 45,393 output tokens, final bytes ≠ first write) — recording on the first-write
signal captures a non-final report and a mid-run token snapshot, the duel-211 class. Treat
report-non-empty as "arm the exit watch", and record only after exit/final-message.
NEVER watch the report file alone in either direction: the codex write-fail mode also
finishes runs that never write it (2026-08-02: a files-only Monitor sat blind 58m past
completion).

### Claude-B call rules
- Build every Claude-B dispatch with `mrctl launch b …`; it emits the blessed courier shape and refuses the known death shapes (wrong effort words and, on read-only reviews, the courier test-gate line, so the test-gate instruction below applies only to mutating dispatches), and hand-typed dispatches are how six of six codex sides died.
- Courier header block, EVERY dispatch (sides and judges): line 1 `Model: <tier>.`, then the
  optional headers `Workdir: <path>.`, `ConfigDir: <path>.`, `Effort: <low|medium|high|
  xhigh>.` and `Mode: read-only.` (emitted by `mrctl launch b --read-only`; the forwarder
  then omits the permission mode and passes the read-only grant without reading TASK for it)
  — each at most once, any order — then ONE BLANK LINE, then TASK. `Effort:` maps
  to `claude -p --effort` (verified headless 2026-08-15); an unlisted value is refused
  (`CLAUDE-B-FAILED: bad Effort`), and omitting the header runs the account default exactly
  as before the header existed. Pass the routed side's effort — the old "lane B has no
  effort channel" limitation is CLOSED. The blank line is a MANDATORY terminator, not a
  convention: the forwarder REFUSES a package without it
  (`CLAUDE-B-FAILED: malformed package (no header terminator)`), because a TASK whose first
  line is header-shaped is otherwise indistinguishable from one more header. A header-shaped
  line after the blank is TASK text and is never obeyed. Both header values must be absolute
  paths free of quote characters (`CLAUDE-B-FAILED: bad Workdir` / `bad ConfigDir`) — the
  wrapper single-quotes them, and an embedded quote breaks out of that quoting.
  `ConfigDir:` takes `route_task`'s `b_config_dir` verbatim; a `$HOME/…` or `~/…` spelling is
  refused too, since single quotes never expand it.
- Pin deliverability: an `MR_B_CONFIG_DIR` pin outside `$HOME/.claude-<name>` still resolves
  for polling and proof verification, but is NOT courier-deliverable — the forwarder's
  allowlist (parent must be `$HOME`, leaf must be `.claude-<letters/digits/_/->`) refuses it,
  so lane B can be measured but not dispatched. Keep pins to `$HOME/.claude-*` whenever lane B
  must actually run.
- Wrapper runs `claude -p --output-format json` — stdout is a JSON envelope; extract
  `result` (answer), `session_id` (duel proof — the envelope's TOP-LEVEL field only; a
  session_id inside `result` text is the child talking, never proof), `usage` (tokens).
- Persistent-file output contract EVERY dispatch: task must tell the child to write its
  final answer to a named file; read the file, not stdout.
- `Workdir:` sandboxes the child to that directory for READS as well as writes (verified
  2026-07-24: a brief under the session scratchpad came back "may only concatenate files
  from the allowed working directories"). So every path the TASK names — inputs and the
  output file — must live under the Workdir, or the brief must be inlined in the prompt.
- Never send long-running execution (big downloads, builds >~5 min) — child Bash timeout
  kills it. Run those controller-side.
- A dispatch that outlives the wrapper's Bash timeout keeps running on B. NEVER re-dispatch
  blind: the child is still burning account B, and a second copy doubles the spend
  (2026-07-24: a 13-minute opus review ran twice this way). Check the offload dir's
  `projects/<project>/` (`b_config_dir`, default `~/.claude-b`) — a session file still
  growing means the run is alive:
  arm the waiter (Waiter contract above) before ending the turn, never wait bare; a finished
  one means the work is done, and its file is both the result and the `session_id` proof.
- Child claims of external-service failure (dead API key, endpoint down) are unverified —
  re-probe before acting.
- Verification claims are unverified too (duel 77: sonnet-B reviewer claimed "independently
  re-ran tests — passes" while its envelope showed all 6 attempts permission-denied). B
  children CANNOT run repo test gates in scratchpad worktrees — so every review/impl dispatch
  says: "You CANNOT run build/test/commit — the controller runs all gates. Report a denied
  command as NOT RUN. Claiming a result for a command you did not run is an automatic FAIL."
  Before `record_duel`, cross-check: envelope `permission_denials` non-empty + output claiming
  execution ("ran", "passed", "verified") → append a controller fact-check note to that side's
  stored output (judges see it — that note is what lost duel 77 for the fabricator) AND
  `record_outcome {kind: FAIL, integrity: true}` EVERY time, not just on a repeat: duel 95's
  fabricated "live npm test 461/461" was fact-checked into the duel output but got no ledger
  row, so the lie cost nothing in standings — annotation reaches the judges, the outcome row
  reaches the engine; a proven fabrication needs both.
  Denials alone are NOT proof. Before the outcome row, scan the child transcript for a LATER
  successful variant of the same check (a retry on an allowed path, a tool substitute, an
  artifact left on disk): a check that eventually ran is not a fabrication, whatever the
  denial list shows. Duel 208: 3 denied Bash pipelines for a citation cross-check, then a 4th
  ALLOWED retry that wrote `.review-scratch/cited-daily.txt` — the integrity FAIL was booked on
  the denials and had to be retracted (`outcomes` has no retraction command; the repair is a
  one-off `UPDATE outcomes SET consumed=1 WHERE id=<row>`, which is the engine's own
  "logged, not counted" state, plus a correction line in the fact-check note).
  Triage the two cases apart — they earn different consequences: fabricated RESULT (no
  successful run at all) = fact-check note + integrity FAIL; mislabeled METHOD (the check ran,
  the named tool did not — duel 208's "comm-verified" was a grep+sort+read) = fact-check note
  only, no ledger row.
- Mutating dispatches run the child with `--permission-mode acceptEdits`
  (`bypassPermissions` is classifier-blocked). acceptEdits only auto-approves edits
  inside the child's cwd (verified 2026-07-24: out-of-cwd Write denied) — so every
  mutating/worktree dispatch MUST pass `Workdir: <target dir>.` in the claude-b prompt's
  header block, and TASK paths must live under it. B mirrors A's permission config;
  project-scope allowlists apply automatically (same cwd), and since 2026-09-04 both offload dirs
  carry `defaultMode: auto`, so a `Mode: read-only` run is a full-toolset run as well (duel 417).
  After a mutating run,
  check the envelope's `permission_denials` — denied build/test/commit steps are
  finished controller-side, and recurring denials go into that project's
  `.claude/settings.json` allowlist.
- `CLAUDE-B-FAILED:` response → report to user, count the duel side as failed (walkover).
- Mid-flight child death (no envelope, empty/absent report file, session file stopped
  growing): same class as a failed spawn — relaunch ONCE while the B lane is open before
  conceding the walkover (duel 94 forfeited the whole Anthropic entry on a single death).
  The no-blind-re-dispatch rule above still gates this: relaunch only after the session
  file check says the child is actually dead, never merely slow.
- Cosplay detector: a claude-b reply that is NOT the JSON envelope (no `session_id`)
  means the forwarder answered the task itself on account A (2026-07-24 probe: forwarder
  ran `echo` instead of the wrapper). REJECT the content — treat as `CLAUDE-B-FAILED`,
  retry the spawn once; still no envelope → side failed (walkover) + tell the user.

### Codex call rules
- Build every Codex dispatch with `mrctl launch codex …`; it emits the blessed detached shape and refuses the known death shapes (wrong effort words, an unwritable root, and nested `codex exec`), and hand-typed dispatches are how six of six codex sides died.
- Every claim in this section about a codex flag names the binary version it was verified
  against and the date. Re-verify on a version bump — `codex exec --help` and the companion's
  own `valueOptions` are the authority, never a single past observation. Two rules here were
  wrong for exactly that reason (the `--effort` spelling and the companion cwd claim below),
  and each forbade or prescribed a path that demonstrably behaves the other way.
- ALWAYS an explicit effort (omission falls through to config default `ultra` — banned),
  and ALWAYS the side's `effort` from route_task verbatim. **The spelling differs by path**:
  the `codex:codex-rescue` agent takes it as `--effort` in its first prompt line (the
  companion parses that); a DIRECT `codex exec` has no `--effort` flag at all and takes
  `-c model_reasoning_effort=<x>` (verified codex-cli 0.147.0, 2026-08-14: `codex exec
  --help` lists only `-c/--config` and `-C/--cd`). Passing `--effort` to `codex exec` dies on
  the flag, and dropping it silently buys the banned `ultra` default.
  `max` is NOT a codex effort:
  codex-cli 0.147.0 rejects it (`Use one of: none, minimal, low, medium, high, xhigh`, hit live
  2026-08-10/11; the 2026-08-10 "accepted" claim never reproduced) — the matrix no longer
  prescribes it (v2.12.5); stale `max` clamps to `xhigh`, deviation surfaced loud. Spark has
  its own ceiling: spark supports low|medium|high|xhigh ONLY — omission hits config default
  `ultra` and the API 400s; `none` also rejected, verified 2026-07-24.
- 600s is the Bash tool's HARD ceiling, not a run budget you may spend. A foreground
  `codex exec` that outlives it is killed mid-run and the work survives only as a detached
  orphan the controller has to go recover — duel 205 (wrapper timeout, result lifted from the
  companion job record), duel 208 (timeout, run finished orphaned, report recovered from
  `last_agent_message`) and duel 203 (interrupted at ~9.5 min, one resume relaunch) all paid
  that toll, and each recovery costs a stub-scan, an `environment` disclosure and a latency
  number nobody can trust. Any side expected to run long — every xhigh review or build —
  launches BACKGROUNDED (`run_in_background` Bash, or the companion's `--background`) with a
  waiter armed per the Waiter contract; duel 209's detached launch is the shape that works.
  Foreground is for runs that comfortably finish inside the cap.
- Known codex-exec hang (stalls at 'verifying' / dead PID): cap the run at 600s Bash
  timeout, retry ONCE; still hung/failed → side is `failed: true` (walkover) + tell the
  user + `record_outcome {model, kind: FAIL}`. Never hand-finish as the lane.
  BEFORE retrying, check whether the run is merely slow rather than hung: a high-effort
  run can outlive the 600s cap, and re-running it duplicates the whole task (2026-07-24:
  ~2M tokens burned twice). Newest rollout under `~/.codex/sessions` — if its mtime is
  still advancing, the run is alive: arm the waiter (Waiter contract above) before ending
  the turn, never wait bare; if its last `response_item` is the final assistant message,
  the run FINISHED — recover the result (and the session id as `proof`) from the rollout
  instead of retrying.
- Any resumed/relaunched run's final report gets a STUB-SCAN before `record_duel`: grep the
  artifact for placeholder markers (`[Full`, `TODO`, `TBD`, bracketed references to sections
  that don't exist). Duel 203: the resume-in-place relaunch claimed it "verified the report",
  yet shipped its mandated section 3 as a bracketed placeholder — self-verification is not
  verification. Stub found → one expand pass; still stubbed → record as-is and name the gap
  in that side's `environment`.
  Same scan on any RECOVERED report — one the side never wrote to its artifact path and the
  controller lifted from the rollout `last_agent_message` or the companion job record (duel
  205: 600s wrapper timeout; duel 208: sandbox rejected the report-file write, run finished
  as a detached orphan). A recovered report is a wrapper-truncation candidate on top of the
  stub risk, so also confirm it reaches its mandated last section (verdict/gate lines) before
  recording, and name the recovery in `environment`.
- The side's `proof` is the rollout FILENAME under `~/.codex/sessions` (newest, mtime inside
  the run window, lane-matching) — never an id the run prints in its output: self-reported
  ids get fabricated or echoed (2026-07-31); the filename is the artifact.
- Worktree (mutating) tasks: the sandbox roots at the codex PROCESS's cwd, so the launch
  itself must be rooted there — `codex exec -C <worktree> -s workspace-write`. Telling the
  prompt to `cd` does NOT move the root: a `cd` inside a shell tool call changes that
  command's directory, never the writable set the sandbox was built with, and the write then
  dies `NOT_WRITABLE` on first contact. That is the whole invariant, and it holds on BOTH
  launch paths: the companion also takes a root, `--cwd <dir>` or `-C <dir>` (verified
  companion 1.0.6, 2026-08-14: `handleTask` lists `cwd` in `valueOptions` and
  `parseCommandInput` merges `C: "cwd"` into every command), so a worktree side may launch
  through `codex:codex-rescue` as long as the call carries the root. The former rule here —
  "the companion exposes no cwd flag, so a worktree side never uses the rescue agent" — was
  false and forbade a path duels 214 and 216 then ran successfully; the NOT_WRITABLE deaths
  in 204 and 210 were a MISSING root, not a missing flag.
  Codex can NEVER commit in a linked worktree (git metadata lives outside the sandbox); it
  returns the diff, the controller applies and commits it verbatim.
- A read-only REVIEW side still has to write one file — its report. `-s read-only` denies
  that write, so the run finishes with nothing on disk and the controller lifts the report
  out of the rollout instead (duel 208: "sandbox rejected the report-file write"). A
  recovered report is a truncation candidate that has to be stub-scanned and disclosed, so
  review sides launch `-s workspace-write` and the brief names the ONE path they may write:
  `.review-scratch/duel<id>-openai.md`. That is the same shape lane B already runs under
  (`acceptEdits` plus an allowlist), and it is verified the same way — `git status
  --porcelain` before recording; anything beyond the named artifact is a controller
  fact-check note on that side's stored output. Read-only stays right for a side with no
  artifact to leave.
- Codex sandbox cannot run listener/server tests (no sockets) — run those controller-side.

## Outcomes (scorecard successor)

Notable non-duel signals still get logged: `record_outcome {date, task_kind, model,
kind: FAIL|PROMOTE, evidence}`. FAIL = verification failed / redone stronger / user
correction. PROMOTE = cheaper model aced again. ≥2 consistent → the engine FLAGS the streak in
its reply and shifts nothing — ALL matrix automatism is retired (operator, 2026-08-10): no
ladder steps, no tier re-pairing, no spark auto-eviction. Surface the flag to the operator,
who moves the matrix by hand; the streak stays unspent and keeps re-flagging until an
operator swap spends it.

## Dashboards

`/model-routing:routing-status` — quota + pace. `/model-routing:showdown` — standings.
Pending/revivable duel ids: SessionStart hook line, `mrctl status`, or `standings.pending`.

## Ops note

Engine changed? Run `npm run build` in `~/model-routing` (tsc → `dist/`), bump the version, and
RESTART any running MCP server processes as part of the same ritual — "restart when
convenient" carried across six handoffs is how stale servers minted rows for three days
(v15 stamps now make the skew visible per row: `minted_by_version`/`recorded_by_version`,
and the pending surface flags rows minted by a build other than the running server). Keep
`package.json`'s version synced in the bump (one sed; it sat at 2.6.2 for 70+ releases —
`.claude-plugin/plugin.json` stays the authority). Bump the version in
`.claude-plugin/plugin.json`. The plugin serves LIVE from the repo — `CLAUDE_PLUGIN_ROOT` is
`~/model-routing/`, so the next session picks the change up with no install step
(verified 2026-07-24). The MCP server process of an already-running session keeps the old code
until that session restarts. `claude plugin update` is not needed; the version-pinned cache
dirs under `~/.claude/plugins/` are vestigial.

Back up `~/.local/share/model-routing/mr.db` with SQLite, never `cp`: the DB runs in WAL mode, so
a plain copy takes only the checkpointed pages and silently leaves out everything still in the
`-wal` file. Every `.bak` taken before 2.6.1 is stale that way — the one made minutes before the
union migration held a day-old schema with no `proof_claims` table at all. Use
`sqlite3 mr.db ".backup <dest>"` or a `VACUUM INTO '<dest>'`, and check the copy's `duels` count
before relying on it.

Lane A's oauth token is never refreshed by the poller — that credential belongs to the running
Claude Code session, which rotates it itself, and a second writer spending the refresh token logs
you out of the account you are working in. Only lane B is refreshed (it has no owner), under a
lockfile so two sessions starting together cannot both spend the same token. `A: stale` on the
dashboard therefore means "start a session on A", and `— RE-AUTH NEEDED` means `claude /login`.
