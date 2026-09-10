import type { DatabaseSync } from 'node:sqlite';
import type { Lane, LaneStatus, RouteDecision, Side } from './types.js';
import { bumpSpotCounter, getRow, SPOT_INTERVAL, type MatrixRow } from './matrix.js';
import { createDuel, DUEL_TTL_MS } from './duel.js';
import { HARD_PCT, laneStatus } from './quota/pace.js';
import { latestSnapshot } from './quota/poll.js';
import { SPARK_MODEL } from './outcomes.js';
import { B_JUDGE_MODEL, FABLE_BACKUP_MODEL, FABLE_MODEL, SPARK_BACKUP_EFFORT, SPARK_BACKUP_MODEL }
  from './types.js';

export { SPARK_MODEL, SPOT_INTERVAL };

export interface RouteInput { kind: string; mutating?: boolean; tier?: string }

// The spark earn-in shadow was RETIRED 2026-07-25 (operator). Spark holds the haiku tier seat by
// the seed and duels haiku directly on mechanical-apply, mechanical-sweep, bulk-mechanical-misc
// and transcription (every canonical row seeded onto it), so there is nothing left
// for a shadow to earn; and union kinds are deep analysis between frontier models, which spark is
// never part of. A union row could still have emitted a shadow that no protocol could judge —
// shadow earn-in needs a task winner, and a union deliberately has none.

export function routeTask(
  db: DatabaseSync, input: RouteInput, now: number = Date.now(),
  opts: { bBlocked?: string } = {},
): RouteDecision {
  const notes: string[] = [];
  const row = getRow(db, input.kind, now, notes, input.tier);
  const st = (lane: Lane, model?: string): LaneStatus =>
    laneStatus(latestSnapshot(db, lane), now, lane, model);
  // The anthropic lanes are read for the row's model: a hard-capped model pool closes the lane
  // for that model while the account windows still read open — seven fable-B sides died at
  // spawn on exactly that (duel 391 M7). The other consumers keep the account view.
  // A quota snapshot can be fresh while the offload dir is unresolvable (e.g. the operator
  // just re-logged the main session into the other account). Routing to B then would bill
  // the MAIN account — the exact silent failure this lane exists to avoid — so every reading
  // of lane B (the side's model, the opus backup, the judge) closes under that block.
  const bBlock = (s: LaneStatus): LaneStatus => opts.bBlocked ? { ...s, state: 'closed' } : s;
  const states: Record<Lane, LaneStatus> = {
    A: st('A', row.anth_model), B: bBlock(st('B', row.anth_model)),
    codex: st('codex'), spark: st('spark'),
  };
  for (const l of ['A', 'B'] as const) {
    const p = states[l].modelPool;
    if (p && p.utilization >= HARD_PCT) {
      notes.push(`lane ${l}: ${p.model} pool ${p.utilization}% — closed until `
        + `${new Date(p.resetsAt).toISOString()} (the account windows do not show it)`);
    }
  }
  if (opts.bBlocked) notes.push(`lane B closed: offload unresolvable — ${opts.bBlocked}`);

  let anthLane = pickAnthropicLane(row, states, notes);
  let anthSide: Side = { vendor: 'anthropic', lane: anthLane,
    model: row.anth_model, effort: row.anth_effort };
  // Fable-closed backup (operator, 2026-09-03): fable meters its own pool on each account, and
  // eight deep-review unions shipped one-sided between 08-21 and 08-29 because the fable-B side
  // died at spawn on that pool while the account windows read open. pickAnthropicLane has
  // already moved the side to the other lane when that lane's fable pool is open (union rows
  // included, on closure only); a side still closed here has fable closed on BOTH accounts, so
  // it runs opus at the row's effort on the home lane, or on the other lane when the home
  // ACCOUNT is closed too. The matrix row is untouched — fable returns when a pool reopens.
  if (row.anth_model === FABLE_MODEL && states[anthLane].state === 'closed') {
    const home: 'A' | 'B' = row.anth_lane === 'A' ? 'A' : 'B';
    const other: 'A' | 'B' = home === 'A' ? 'B' : 'A';
    const backup = { A: st('A', FABLE_BACKUP_MODEL), B: bBlock(st('B', FABLE_BACKUP_MODEL)) };
    const lane = [home, other].find(l => backup[l].state !== 'closed');
    if (lane) {
      anthLane = lane;
      states[lane] = backup[lane]; // the lane read for the model that now runs on it
      anthSide = { vendor: 'anthropic', lane, model: FABLE_BACKUP_MODEL, effort: row.anth_effort };
      notes.push(`fable closed on A and B — ${FABLE_BACKUP_MODEL}@${row.anth_effort} backup on `
        + `lane ${lane} (operator standing order, 2026-09-03)` + (lane === 'A'
          ? `; effort ${row.anth_effort} not enforceable on lane A (session default)` : ''));
    }
  }
  let gptLane: Lane = row.gpt_model === SPARK_MODEL ? 'spark' : 'codex';
  let gptSide: Side | null = row.gpt_model
    ? { vendor: 'openai', lane: gptLane, model: row.gpt_model, effort: row.gpt_effort }
    : null;
  // Spark-closed backup (operator, 2026-08-20): spark's pool is metered and, once exhausted, the
  // lane cannot run again until its own reset — duel 268 died mid-task at 100% weekly and every
  // spark-seeded route after it walked over. Only 'closed' substitutes: stale is spark's steady
  // state when it has not run recently, and gating on it would retire the seat by accident. The
  // matrix row is untouched — the seeded pairing returns the moment spark's window resets.
  if (gptSide && gptLane === 'spark' && states.spark.state === 'closed'
      && states.codex.state !== 'closed') {
    gptLane = 'codex';
    gptSide = { vendor: 'openai', lane: 'codex',
      model: SPARK_BACKUP_MODEL, effort: SPARK_BACKUP_EFFORT };
    notes.push(`spark closed — ${SPARK_BACKUP_MODEL}@${SPARK_BACKUP_EFFORT} backup on codex `
      + '(operator standing order, 2026-08-20)');
  }

  const usable = (s: LaneStatus) => s.state !== 'closed';
  const duelable = (s: LaneStatus) => usable(s) && s.state !== 'soft';
  const anthUsable = usable(states[anthLane]);
  const gptUsable = gptSide !== null && usable(states[gptLane]);
  const single = (side: Side, spotCheck = false): RouteDecision =>
    ({ mode: 'single', sides: [side], duelId: null, spotCheck, notes });
  const blocked = (why: string): RouteDecision =>
    ({ mode: 'blocked', sides: [], duelId: null, spotCheck: false, notes: [...notes, why] });
  const duel = (spotCheck: boolean): RouteDecision => {
    const duelId = createDuel(db, row.task_kind, [anthSide, gptSide!],
      { mutating: !!input.mutating, spotCheck }, now);
    return { mode: 'duel', sides: [anthSide, gptSide!], duelId, spotCheck, notes };
  };
  const union = (): RouteDecision => {
    const duelId = createDuel(db, row.task_kind, [anthSide, gptSide!],
      { mutating: !!input.mutating, spotCheck: false, unionMode: true }, now);
    return { mode: 'union', sides: [anthSide, gptSide!], duelId, spotCheck: false, notes };
  };

  if (!gptSide) return anthUsable ? single(anthSide) : blocked('anthropic lanes closed, no gpt contender');
  if (!anthUsable && !gptUsable) return blocked('all lanes closed');

  // Union runs before every contest branch: a union kind has no contest to spot-check, no victor
  // to route single, and no ladder position to defend. Soft lanes do NOT degrade it to single the
  // way a duel degrades — the whole point is that one side's findings do not cover the other's, so
  // half a union is a worse deliverable, not a cheaper one. Only a CLOSED lane can force single.
  // A union ships the MERGE of two reports, and two independent diffs have no merge: whose edit
  // to `foo.ts:40` survives is not a content question the controller can resolve the way it
  // resolves two conflicting findings. SKILL.md said to route mutating work as a duel; nothing
  // enforced it, so `route_task {kind: <union kind>, mutating: true}` handed back two diffs and
  // no rule for applying either. Fall through to the contest branches instead — a duel has a
  // winner, and one winner's diff applies.
  if (row.union_mode && input.mutating) {
    notes.push('union kind routed as a contest — mutating work has no defined way to reconcile '
      + 'two independent diffs, so the winner\'s diff applies');
  } else if (row.union_mode) {
    if (anthUsable && gptUsable) return union();
    notes.push('union degraded to single (other lane closed) — merged coverage is incomplete');
    return single(anthUsable ? anthSide : gptSide!);
  }

  const anthDuelable = anthUsable && duelable(states[anthLane]);
  const gptDuelable = gptUsable && duelable(states[gptLane]);
  // Judges are part of a duel's feasibility, not an afterthought: recordJudgment only accepts an
  // anthropic judge attested under lane B and an openai judge under codex (SKILL.md fixes them at
  // opus@B / gpt-6-astra@codex), and there is no lane-A judge path. So while the SIDE happily
  // shifts B→A when B is closed, a duel routed then is unjudgeable from the moment it is created:
  // both sides run and attest, and the row can only sit until the sweep abandons it. That is the
  // verified mechanism that lost duels 46/49/53. Only 'closed' gates — a soft judge lane can
  // still afford two one-token verdicts, and 'stale' is unknown, not unavailable.
  // Lane B is read for the JUDGE's model here, not the side's: a closed fable pool closes the
  // fable side (shifted or fallen back to opus above), never the opus judge, so a fable kind
  // with both pools shut still gets a judged duel while the B account is open.
  const judgeClosed = (['B', 'codex'] as Lane[])
    .filter(l => (l === 'B' ? bBlock(st('B', B_JUDGE_MODEL)) : states[l]).state === 'closed');
  const judgeable = judgeClosed.length === 0;
  const paceSingle = (): RouteDecision => {
    const aP = states[anthLane].weeklyPace ?? 0;
    const gP = states[gptLane].weeklyPace ?? 0;
    return single(aP <= gP ? anthSide : gptSide!);
  };

  if (row.decided && row.victor_vendor) {
    // "Spot check is due" rather than "this call is a multiple of 10": the counter keeps
    // climbing while a lane is degraded and fires on the next call where both can duel, so a
    // soft lane delays the spot check instead of silently consuming its slot.
    // The slot is NOT consumed here: routing a spot duel is a promise, and resetting the
    // counter at creation let a spot duel that died unexecuted (closed judge lane, abandoned
    // session) buy the incumbent another ten unaudited routes — an incumbent whose audits
    // systematically die was unfalsifiable (duel-62 I4/S7). recordResults resets the counter
    // when the audit actually records; until then the debt stands, and the only thing this
    // branch checks is that one audit is not already in flight.
    const n = bumpSpotCounter(db, row.task_kind);
    if (n >= SPOT_INTERVAL && anthDuelable && gptDuelable && judgeable
        && !pendingSpotDuel(db, row.task_kind)) {
      // An audit that DIED (double-failure walkover, swept row) leaves the debt standing — but
      // its terminal status also clears the pending gate, so the audit re-fired on every single
      // route: 1-in-10 became 1-in-1, each attempt spawning two lanes plus two judges and
      // leaving a permanent walkover row (duel-64 opus #5). Failed audits back off instead.
      // The incumbent stays unaudited through the backoff — an incumbent whose audits keep
      // dying is an operator signal, surfaced in the note, not a reason to burn routes.
      // The backoff runs from the audit's DEATH — never from created_at: a sweep fires 6h
      // after routing, always past the 1h backoff, so swept audits re-fired instantly,
      // forever (duel-65 opus F3 / sol S5). The death is the LATEST stamp the row carries,
      // not any fixed COALESCE preference: preferring recorded_at misread a legacy blank-side
      // audit recorded long ago and swept today (duel-66 opus M6 / sol F3), and preferring
      // abandoned_at misread a ≤2.6.8 row swept long ago and recorded just now — that era
      // never cleared the sweep stamp on a later record, and no migration repairs it
      // (duel-67 sol F2 / opus F3). Per-row max is identical on well-formed rows and correct
      // on both legacy generations; rows from before either stamp existed fall back to
      // created_at, the old behavior. And dead means EVIDENCE-FREE: an audit that recorded
      // real outputs and was swept awaiting judges is revivable work, not a dying-audit
      // signal, and must not back off a healthy kind. Neither is a sitter the live audit
      // expired 'superseded' — that death means the audit SUCCEEDED (duel-67 opus F7). The
      // guard keys on the superseded_by tombstone as well as the spelling: RECORDING the
      // sitter's death recomputes decided_by to 'abandoned' (the action SKILL.md prescribes
      // for a pending abandoned row), and the spelling test alone re-armed this backoff off
      // a displacement (duel-73 opus F1).
      const lastDead = (db.prepare(`SELECT
          MAX(MAX(COALESCE(abandoned_at, 0), COALESCE(recorded_at, 0), created_at)) AS t
        FROM duels
        WHERE task_kind=? AND spot_check=1 AND status IN ('walkover','abandoned')
          AND winner_vendor IS NULL
          AND COALESCE(decided_by, '') <> 'superseded'
          AND superseded_by IS NULL
          AND NOT landed(anth_output) AND NOT landed(gpt_output)`)
        .get(row.task_kind) as any)?.t as number | null;
      if (lastDead != null && now - lastDead < SPOT_BACKOFF_MS) {
        notes.push('spot audit backed off — the previous audit died unexecuted; next attempt '
          + `in ${Math.ceil((SPOT_BACKOFF_MS - (now - lastDead)) / 60_000)}m (an incumbent `
          + 'whose audits keep dying is an operator signal)');
      } else {
        // The SELECT above and the INSERT inside duel() are not atomic across processes; the
        // idx_one_inflight_spot unique index is the real gate, and losing that race is not an
        // error — the audit exists, this route just is not it (duel-63 sol#4, duel-64 sol#2).
        try { return duel(true); } catch (e) {
          if (!/UNIQUE/i.test(String(e))) throw e;
          notes.push('audit already in flight (raced a concurrent route) — routed single');
        }
      }
    }
    const victorIsAnth = row.victor_vendor === 'anthropic';
    if (victorIsAnth ? anthUsable : gptUsable) return single(victorIsAnth ? anthSide : gptSide);
    notes.push('victor lane closed — routed to other vendor');
    return single(victorIsAnth ? gptSide : anthSide);
  }

  if (anthDuelable && gptDuelable) {
    if (judgeable) return duel(false);
    notes.push(`duel suppressed — judge lane ${judgeClosed.join('+')} closed, a duel routed now `
      + 'would be unjudgeable from creation; single on lower weekly pace');
    return paceSingle();
  }
  if (anthDuelable !== gptDuelable) {
    notes.push('duel degraded to single (soft/closed lane on other side)');
    return single(anthDuelable ? anthSide : gptSide);
  }
  if (!anthUsable) return single(gptSide);
  if (!gptUsable) return single(anthSide);
  notes.push('both vendors soft — single on lower weekly pace');
  return paceSingle();
}

// An audit already routed and not yet concluded blocks a second one: with the counter no
// longer reset at creation, every route past the interval would otherwise mint its own spot
// duel. An abandoned spot duel drops out of this set, so the debt re-fires — that is the point.
// A dead audit re-fires only after this backoff — one sixth of the sweep TTL, so a kind whose
// audits die still gets several attempts per sweep window without burning every route.
export const SPOT_BACKOFF_MS = DUEL_TTL_MS / 6;

function pendingSpotDuel(db: DatabaseSync, kind: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM duels WHERE task_kind=? AND spot_check=1 " +
    "AND status IN ('routed','awaiting_judgment') LIMIT 1",
  ).get(kind);
}

function pickAnthropicLane(
  row: MatrixRow, states: Record<Lane, LaneStatus>, notes: string[],
): Lane {
  const home: Lane = row.anth_lane === 'A' ? 'A' : 'B';
  if (!row.overflow_eligible) return home;
  const other: Lane = home === 'A' ? 'B' : 'A';
  const h = states[home], o = states[other];
  // Union ships both sides unjudged, while lane A writes no attestable artifact; union rows
  // stay out of pace/soft/burn B→A shifts so duels 117–141's unattested sides cannot recur. A
  // CLOSED home is the one exception (operator, 2026-09-03): the side moves to A rather than
  // dropping out of the union — an unattested report beats no report.
  if (row.union_mode && other === 'A' && !(h.state === 'closed' && o.state !== 'closed')) return home;
  // The Agent tool exposes no effort parameter (duel 391 M9): a side shifted onto A runs at the
  // session default against a pinned gpt effort, and lane A attests nothing. Say so where the
  // shift is decided, so the route note carries it into the controller's record.
  const shift = (why: string): Lane => {
    notes.push(`anthropic lane ${why}` + (other === 'A'
      ? `; effort ${row.anth_effort} not enforceable on lane A (session default)` : ''));
    return other;
  };
  if (o.state === 'burn' && h.state !== 'burn') return shift(`${other}: burn-down bias`);
  if (h.state === 'burn') return home;
  // A CLOSED home lane is unusable, full stop — so anything not closed beats it, including soft
  // and stale. The ranking below treats those three as equally 'bad', which kept the caller on a
  // closed lane and cost a whole side: routeTask reads that as "anthropic unusable", degrading a
  // union to a single-vendor run (or a duel to single) while a perfectly routable lane sat idle.
  if (h.state === 'closed' && o.state !== 'closed') {
    return shift(`shifted ${home}→${other} (home closed)`);
  }
  // 'stale' counts as bad here for the same reason it is never a shift *target*: unknown quota
  // should never be preferred over a lane we know is open.
  const bad = (s: LaneStatus) => s.state === 'soft' || s.state === 'closed' || s.state === 'stale';
  if (bad(h) && !bad(o) && o.state !== 'stale') {
    return shift(`shifted ${home}→${other} (home ${h.state})`);
  }
  // Both paces must be real numbers: a lane whose reset time had to be invented reports null
  // rather than the 0 that an assumed just-started window produces, because that 0 lost every
  // comparison and pulled work off an idle lane B onto a 28%-used A (see pace.ts).
  if (h.state === 'open' && o.state === 'open'
      && h.weeklyPace !== null && o.weeklyPace !== null
      && o.weeklyPace < h.weeklyPace) {
    return shift(`${other}: lower weekly pace`);
  }
  return home;
}
