import { randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';

// Write-then-rename: a reader never sees a half-written file, and a crash mid-write cannot
// truncate the one already there. The temp file is a sibling because rename is only atomic
// within a filesystem.
// 'wx' + random suffix, not pid alone: pids recycle, and writeFileSync into an existing path
// keeps that file's mode (mode is applied at creation only) — so a leftover temp from a killed
// run could be written into with someone else's permissions. Colliding now fails instead.
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.mr-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', mode);
  try { writeSync(fd, data); } finally { closeSync(fd); }
  try { renameSync(tmp, path); }
  catch (e) { try { unlinkSync(tmp); } catch { /* nothing to clean */ } throw e; }
}
