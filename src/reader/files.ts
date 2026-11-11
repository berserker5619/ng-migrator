import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { compareOrdinal, toPosix } from '../platform/paths.js';

/** Folders that never contain project source. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.angular', '.ng-migrator', 'coverage', '.nx', 'tmp', 'out-tsc', '.cache']);

export interface WalkOptions {
  extensions: readonly string[];
  maxFiles?: number;
}

/** List project files (project-relative, POSIX, sorted), skipping build output and dependencies. */
export async function walkProject(root: string, options: WalkOptions): Promise<string[]> {
  const max = options.maxFiles ?? 20000;
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareOrdinal(a.name, b.name));
    for (const entry of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(full);
      } else if (entry.isFile() && options.extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(toPosix(path.relative(root, full)));
      }
    }
  }
  await visit(root);
  return out.sort(compareOrdinal);
}

