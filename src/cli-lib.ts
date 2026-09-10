import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { writeFileAtomic } from './atomic.js';
import { renderMarkdown } from './matrix.js';
import { DATA_DIR, offloadDir } from './paths.js';
import type { Lane } from './types.js';

// Lane B's line names WHICH dir it currently points at — the one-glance answer to "is offload
// really the other account right now". Unresolvable stays visible instead of failing the line;
// the loud stop lives in route_task/poll, this is just the dashboard.
export function laneLabel(lane: Lane): string {
  if (lane !== 'B') return lane;
  try { return `B[${basename(offloadDir())}]`; } catch { return 'B[unresolved]'; }
}

export function writeMatrixDoc(db: DatabaseSync): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, 'matrix.md');
  // Atomic: every SessionStart rewrites this now, and it is the documented offline fallback —
  // a second session reading it mid-write would get half a table and route off it.
  writeFileAtomic(path, renderMarkdown(db), 0o644);
  return path;
}
