import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeWithRetry } from '../src/platform/fs.js';
import type { Packument } from '../src/registry/client.js';

/** A temporary directory whose path contains spaces, removed by the returned cleanup. */
export async function tempProject(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ng migrator test '));
  return { dir, cleanup: () => removeWithRetry(dir) };
}

/** Write a cached registry packument into a test project's .ng-migrator/cache/registry folder. */
export async function writeCacheEntry(projectDir: string, name: string, packument: Packument): Promise<void> {
  const regDir = path.join(projectDir, '.ng-migrator', 'cache', 'registry');
  await mkdir(regDir, { recursive: true });
  await writeFile(
    path.join(regDir, `${encodeURIComponent(name)}.json`),
    JSON.stringify({ fetchedAt: Date.now(), packument }),
  );
}

