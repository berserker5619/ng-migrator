import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config/config.js';
import { createPlan } from '../src/planner/plan.js';
import { pathExists } from '../src/platform/fs.js';
import * as processMod from '../src/platform/process.js';
import { readProject } from '../src/reader/project.js';
import type { Packument, RegistryClient } from '../src/registry/client.js';
import { verifyWithPackageManager } from '../src/resolver/verify.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

async function hashDirectoryFiles(
  baseDir: string,
  ignoreDirs: Set<string> = new Set(['.ng-migrator', 'node_modules', '.git']),
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        const fullPath = path.join(current, entry.name);
        const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const content = await readFile(fullPath);
        result[rel] = createHash('sha256').update(content).digest('hex');
      }
    }
  }

  await walk(baseDir);
  return result;
}

describe('Safety audit: non-destructive planning guarantees', () => {
  it('guarantees all files outside .ng-migrator/ (including package.json and lockfile) are 100% untouched and identical after plan', async () => {
    // Scaffold test project
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'audit-project',
          version: '1.0.0',
          dependencies: {
            '@angular/core': '^14.2.0',
            rxjs: '~7.5.0',
          },
        },
        null,
        2,
      ) + '\n',
    );
    await writeFile(path.join(dir, 'package-lock.json'), '{"name": "audit-project", "lockfileVersion": 2}\n');
    await writeFile(path.join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
    await writeFile(path.join(dir, 'app.component.ts'), 'export class AppComponent {}\n');

    // 1. Compute baseline hashes of all files outside .ng-migrator/
    const hashesBefore = await hashDirectoryFiles(dir);
    expect(hashesBefore['package.json']).toBeDefined();
    expect(hashesBefore['package-lock.json']).toBeDefined();
    expect(hashesBefore['.npmrc']).toBeDefined();
    expect(hashesBefore['app.component.ts']).toBeDefined();

    // 2. Execute plan
    const mockRegistry = {
      packument: async (name: string): Promise<Packument | undefined> => {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '15.2.10' },
            versions: {
              '14.2.0': { version: '14.2.0' },
              '15.2.10': { version: '15.2.10', engines: { node: '>=14.20' } },
            },
          };
        }
        if (name === 'rxjs') {
          return {
            name: 'rxjs',
            distTags: { latest: '7.8.2' },
            versions: {
              '7.5.0': { version: '7.5.0' },
              '7.8.2': { version: '7.8.2' },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const project = await readProject(dir);
    const config = resolveConfig({}, {}, { packageManager: 'npm' });
    await createPlan({
      project,
      targetMajor: 15,
      registry: mockRegistry,
      config,
      verifyResolution: false,
    });

    // 3. Compute hashes after planning
    const hashesAfter = await hashDirectoryFiles(dir);

    // Assert that every file outside .ng-migrator/ has identical SHA256 checksums!
    expect(hashesAfter).toEqual(hashesBefore);
  });

  it('runs package-manager resolution checks in an isolated temp directory, never modifying project files', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'isolated-check-project',
          dependencies: { '@angular/core': '14.0.0' },
        },
        null,
        2,
      ) + '\n',
    );
    await writeFile(path.join(dir, 'package-lock.json'), '{"name": "isolated-check", "lockfileVersion": 2}\n');
    await writeFile(path.join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

    const hashesBefore = await hashDirectoryFiles(dir);

    let executedInCwd = '';
    let foundCopiedManifest = false;
    let foundCopiedLockfile = false;
    let foundCopiedNpmrc = false;

    const runSpy = vi.spyOn(processMod, 'run').mockImplementation(async (_cmd, _args, options) => {
      executedInCwd = options?.cwd ?? '';
      foundCopiedManifest = await pathExists(path.join(executedInCwd, 'package.json'));
      foundCopiedLockfile = await pathExists(path.join(executedInCwd, 'package-lock.json'));
      foundCopiedNpmrc = await pathExists(path.join(executedInCwd, '.npmrc'));
      return {
        command: `${_cmd} ${_args.join(' ')}`,
        exitCode: 0,
        stdout: 'added 1 package',
        stderr: '',
        durationMs: 5,
        timedOut: false,
        failed: false,
      };
    });

    try {
      const result = await verifyWithPackageManager({
        projectRoot: dir,
        packageManager: 'npm',
        changes: [
          {
            name: '@angular/core',
            type: 'dependencies',
            current: '14.0.0',
            currentSpec: '14.0.0',
            target: '15.2.10',
            targetSpec: '^15.2.10',
            reason: 'Test',
            evidence: 'declared',
          },
        ],
      });

      expect(result.status).toBe('confirmed');
      expect(runSpy).toHaveBeenCalled();
      expect(executedInCwd).not.toBe(dir);
      expect(executedInCwd.toLowerCase()).toContain(os.tmpdir().toLowerCase());
      expect(foundCopiedManifest).toBe(true);
      expect(foundCopiedLockfile).toBe(true);
      expect(foundCopiedNpmrc).toBe(true);

      const hashesAfter = await hashDirectoryFiles(dir);

      // Verified: No project files, lockfiles, or .npmrc modified!
      expect(hashesAfter).toEqual(hashesBefore);
    } finally {
      runSpy.mockRestore();
    }
  });
});
