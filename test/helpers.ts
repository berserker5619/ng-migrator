import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathExists, removeWithRetry } from '../src/platform/fs.js';
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

export interface ProjectAuditSnapshot {
  /** SHA-256 per relative path for working-tree files (excludes .ng-migrator, .git, node_modules). */
  workingTreeHashes: Record<string, string>;
  /** Count of working-tree files outside .ng-migrator, .git, and node_modules. */
  workingTreeCount: number;
  /** SHA-256 per relative path for files inside .git/ (verifies no git write operations occurred). */
  gitDirHashes: Record<string, string>;
  /** Count of files inside .git/. */
  gitDirCount: number;
  /** Total files outside .ng-migrator and node_modules (workingTreeCount + gitDirCount). */
  totalOutsideMigratorCount: number;
  /** Deterministic aggregate SHA-256 over sorted workingTreeHashes entries. */
  aggregateWorkingTreeSha256: string;
  /** Deterministic aggregate SHA-256 over sorted workingTreeHashes + gitDirHashes entries. */
  aggregateTotalSha256: string;
}

/**
 * Canonical non-destructive safety audit helper with documented scope:
 * - `workingTreeHashes` / `workingTreeCount`: every working-tree file outside `.ng-migrator/`, `.git/`, and `node_modules/`.
 * - `gitDirHashes` / `gitDirCount`: every file inside `.git/` (verifies git state is untouched).
 * - `totalOutsideMigratorCount`: `workingTreeCount + gitDirCount`.
 */
export async function auditProjectFiles(baseDir: string): Promise<ProjectAuditSnapshot> {
  const workingTreeHashes: Record<string, string> = {};
  const gitDirHashes: Record<string, string> = {};
  const skippedDirs = new Set(['.ng-migrator', 'node_modules']);

  async function walk(current: string, inGitDir: boolean) {
    if (!(await pathExists(current))) return;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!inGitDir && skippedDirs.has(entry.name)) continue;
        const nextInGit = inGitDir || entry.name === '.git';
        await walk(path.join(current, entry.name), nextInGit);
      } else if (entry.isFile()) {
        const fullPath = path.join(current, entry.name);
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const content = await readFile(fullPath);
        const sha = createHash('sha256').update(content).digest('hex');
        if (inGitDir) {
          gitDirHashes[rel] = sha;
        } else {
          workingTreeHashes[rel] = sha;
        }
      }
    }
  }

  await walk(baseDir, false);

  const workingKeys = Object.keys(workingTreeHashes).sort();
  const gitKeys = Object.keys(gitDirHashes).sort();

  const workingAgg = createHash('sha256');
  const totalAgg = createHash('sha256');

  for (const k of workingKeys) {
    workingAgg.update(`${k}:${workingTreeHashes[k]}\n`);
  }
  for (const k of [...workingKeys, ...gitKeys].sort()) {
    const val = workingTreeHashes[k] ?? gitDirHashes[k];
    totalAgg.update(`${k}:${val}\n`);
  }

  return {
    workingTreeHashes,
    workingTreeCount: workingKeys.length,
    gitDirHashes,
    gitDirCount: gitKeys.length,
    totalOutsideMigratorCount: workingKeys.length + gitKeys.length,
    aggregateWorkingTreeSha256: workingAgg.digest('hex'),
    aggregateTotalSha256: totalAgg.digest('hex'),
  };
}

