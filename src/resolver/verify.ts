import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PackageManager } from '../config/config.js';
import type { PackageChange, PeerConflict, ResolutionCheck } from '../model.js';
import { pathExists, readJsonIfExists, removeWithRetry } from '../platform/fs.js';
import { run } from '../platform/process.js';

export interface VerifyResolutionOptions {
  projectRoot: string;
  packageManager: PackageManager;
  changes: PackageChange[];
  commandPrefix?: string;
}

/**
 * Parses npm ERESOLVE peer dependency error messages from stderr.
 * Example npm output:
 *   npm error While resolving: @angular/material@15.2.0
 *   npm error Found: @angular/core@16.2.0
 *   npm error Could not resolve dependency:
 *   npm error peer @angular/core@"^15.0.0" from @angular/material@15.2.0
 */
export function parseNpmEresolve(output: string): PeerConflict[] {
  const conflicts: PeerConflict[] = [];
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Match "peer @angular/core@"^15.0.0" from @angular/material@15.2.0"
    const match = /peer\s+([@\w/-]+)@["']([^"']+)["']\s+from\s+([@\w/-]+@[\d\w.-]+)/i.exec(line);
    if (match) {
      conflicts.push({
        peer: match[1]!,
        range: match[2]!,
        requiredBy: match[3]!,
      });
    }
  }

  return conflicts;
}

/**
 * Verifies proposed dependency versions by running a lockfile-only dry run
 * in a temporary directory holding copies of the manifest and lockfile (plan section 7.3).
 * Never touches the real project directory.
 */
export async function verifyWithPackageManager(
  options: VerifyResolutionOptions,
): Promise<ResolutionCheck> {
  const { projectRoot, packageManager, changes, commandPrefix } = options;

  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'ngm-resolve-'));

    // Read original package.json and apply proposed changes
    const originalPkg = await readJsonIfExists<Record<string, unknown>>(
      path.join(projectRoot, 'package.json'),
    );
    if (!originalPkg) {
      return { status: 'failed', detail: 'Could not read project package.json' };
    }

    const modifiedPkg = { ...originalPkg };
    const deps = { ...(modifiedPkg.dependencies as Record<string, string> | undefined) };
    const devDeps = { ...(modifiedPkg.devDependencies as Record<string, string> | undefined) };

    for (const change of changes) {
      if (change.type === 'devDependencies') {
        devDeps[change.name] = change.targetSpec;
      } else {
        deps[change.name] = change.targetSpec;
      }
    }

    modifiedPkg.dependencies = deps;
    modifiedPkg.devDependencies = devDeps;

    await writeFile(
      path.join(tempDir, 'package.json'),
      `${JSON.stringify(modifiedPkg, null, 2)}\n`,
    );

    // Copy lockfiles if present
    for (const lockfile of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      const src = path.join(projectRoot, lockfile);
      if (await pathExists(src)) {
        await copyFile(src, path.join(tempDir, lockfile)).catch(() => undefined);
      }
    }

    // Copy .npmrc if present
    const npmrcSrc = path.join(projectRoot, '.npmrc');
    if (await pathExists(npmrcSrc)) {
      await copyFile(npmrcSrc, path.join(tempDir, '.npmrc')).catch(() => undefined);
    }

    // Run lockfile-only check
    let cmd = 'npm';
    let args: string[] = ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts'];

    if (packageManager === 'pnpm') {
      cmd = 'pnpm';
      args = ['install', '--lockfile-only', '--ignore-scripts'];
    } else if (packageManager === 'yarn') {
      cmd = 'yarn';
      args = ['install', '--mode', 'update-lockfile', '--ignore-scripts'];
    }

    const result = await run(cmd, args, { cwd: tempDir, commandPrefix });

    if (result.exitCode === 0) {
      return { status: 'confirmed' };
    }

    const fullOutput = `${result.stdout}\n${result.stderr}`;
    if (fullOutput.includes('ERESOLVE') || fullOutput.includes('Could not resolve dependency')) {
      const conflicts = parseNpmEresolve(fullOutput);
      return {
        status: 'conflict',
        detail: 'Peer dependency conflict during resolution check.',
        conflicts: conflicts.length > 0 ? conflicts : undefined,
      };
    }

    return {
      status: 'failed',
      detail: result.stderr.trim() || result.stdout.trim() || `Package manager exited with code ${result.exitCode}`,
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: (err as Error).message,
    };
  } finally {
    if (tempDir) {
      await removeWithRetry(tempDir).catch(() => undefined);
    }
  }
}
