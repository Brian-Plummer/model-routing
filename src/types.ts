export type Lane = 'A' | 'B' | 'codex' | 'spark';
export type Vendor = 'anthropic' | 'openai';
// 'max' is Claude-side only: codex-cli 0.147.0 REJECTS it ("Use one of: none, minimal, low,
// medium, high, xhigh" — reproduced live 2026-08-10 and 2026-08-11; the earlier "verified
// accepted" claim never reproduced) and spark tops out at xhigh. setVendorModel refuses it for
// openai rows; the v10 migration relabeled every row that carried it (two live: deep-review's
// seed and decision-brief's 2026-08-10 operator pairing). 'ultra' — the codex
// config default an omitted --effort falls through to — stays off the type: banned on every lane.
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type LaneState = 'open' | 'soft' | 'burn' | 'closed' | 'stale';

// Lives here, not in outcomes.ts, because matrix.ts's SEED needs it at module-evaluation time
// and outcomes.ts already imports matrix.ts — the cycle left SPARK_MODEL undefined in the seed.
// outcomes.ts re-exports both, so every existing import site is unchanged.
export const SPARK_MODEL = 'gpt-5.3-codex-spark';
export const SPARK_EFFORT: Effort = 'low'; // spark rejects an omitted effort (config default is banned)
// The spark-closed backup (operator, 2026-08-20): spark meters its own pool now, and when it is
// exhausted (duel 268 died mid-task at 100% weekly) the openai side falls back to luna on the
// codex lane so spark-seeded kinds keep dueling. This is a narrow un-retirement: luna stays off
// the ladder and out of the scorecard import — a backup seat, not a return.
export const SPARK_BACKUP_MODEL = 'gpt-5.6-luna';
export const SPARK_BACKUP_EFFORT: Effort = 'high';
// The fable-closed backup (operator, 2026-09-03): fable meters its own pool on each account.
// A closed home pool shifts the side to the other lane (union rows included, on closure only),
// and both pools closed run the side as opus at the row's effort on whichever account is open.
// The matrix row is untouched — fable returns the moment a pool reopens.
export const FABLE_MODEL = 'fable';
export const FABLE_BACKUP_MODEL = 'opus';
// The B judge is opus (SKILL fixes the judges at opus@B / gpt-6-astra@codex); the router reads
// lane B for the judge's model, never for the side's.
export const B_JUDGE_MODEL = 'opus';

export interface WindowUsage {
  windowMinutes: number; // 300 = 5h, 10080 = weekly
  utilization: number;   // percent 0-100
  resetsAt: number;      // epoch ms
  synthetic?: boolean;   // resetsAt was invented (untouched pool reports none) — see parse.ts
  model?: string;        // a model-scoped pool ('fable'), never the account's own windows
}

export interface LaneUsage {
  lane: Lane;
  fetchedAt: number;     // epoch ms
  windows: WindowUsage[];
}

export interface LaneStatus {
  lane: Lane;
  state: LaneState;
  weeklyUtilization: number | null;
  weeklyPace: number | null; // utilization% - elapsed%; negative = underpaced
  resetsAt: number | null;   // weekly reset, epoch ms
  shortUtilization: number | null; // 5h window, when the payload carries one
  // The asked-for model's own pool, when the snapshot carries one: the reading behind a
  // model-scoped closure, for the route note (duel 391 M7).
  modelPool?: { model: string; utilization: number; resetsAt: number };
}

export interface Side {
  vendor: Vendor;
  lane: Lane;
  model: string;
  effort: Effort | null;     // null only when a row stores no effort; spark is always 'low'
}

export interface RouteDecision {
  // 'union' runs BOTH sides like a duel but ships the MERGE of their outputs instead of picking
  // a winner: no judges, no contest. For kinds where the two vendors were measured to
  // find different real defects, so discarding either report loses findings (deep-review,
  // 2026-07-25: every one of 5 dimensions had material findings unique to each side).
  mode: 'duel' | 'union' | 'single' | 'blocked';
  sides: Side[];             // duel/union: [anthropic, openai]; single: [winner]; blocked: []
  duelId: number | null;
  spotCheck: boolean;
  notes: string[];
  // No `shadow` field: spark's earn-in shadow was retired 2026-07-25 (operator). Spark holds the
  // haiku tier seat by the seed and contends directly; it is never a side-car run.
}
