import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeWithRetry } from '../src/platform/fs.js';

/** A temporary directory whose path contains spaces, removed by the returned cleanup. */
export async function tempProject(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ng migrator test '));
  return { dir, cleanup: () => removeWithRetry(dir) };
}

