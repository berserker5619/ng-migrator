import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/program.js';
import { ExitCode } from '../src/errors.js';
import { pathExists, readJsonIfExists } from '../src/platform/fs.js';
import type { MigratorState } from '../src/state/state.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

function makeIo(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    isTTY: false,
    env: {},
    nodeVersion: '24.0.0',
    cwd,
  };
  return { io, out: () => out.join(''), err: () => err.join('') };
}

describe('e2e plan, status, approve, analyze', () => {
  async function setupMockAngularProject(root: string) {
    // 1. package.json
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'test-angular-app',
        dependencies: {
          '@angular/core': '15.2.0',
          typescript: '~4.9.4',
        },
      }),
    );
    await writeFile(path.join(root, 'angular.json'), JSON.stringify({ projects: { app: {} } }));

    // 2. Pre-populate registry cache so tests run completely offline
    const cacheDir = path.join(root, '.ng-migrator', 'cache', 'registry');
    await mkdir(cacheDir, { recursive: true });

    const corePackument = {
      name: '@angular/core',
      'dist-tags': { latest: '17.2.0' },
      versions: {
        '15.2.10': { version: '15.2.10', engines: { node: '>=14.20' } },
        '16.2.12': { version: '16.2.12', engines: { node: '^16.14.0 || >=18.10.0' }, peerDependencies: { rxjs: '^7.4.0' } },
        '17.2.0': { version: '17.2.0', engines: { node: '^18.13.0 || >=20.9.0' }, peerDependencies: { rxjs: '^7.4.0' } },
      },
    };

    const compilerPackument = {
      name: '@angular/compiler-cli',
      'dist-tags': { latest: '17.2.0' },
      versions: {
        '16.2.12': { version: '16.2.12', peerDependencies: { typescript: '>=4.9.3 <5.2.0' } },
        '17.2.0': { version: '17.2.0', peerDependencies: { typescript: '>=5.2.0 <5.4.0' } },
      },
    };

    const cliPackument = {
      name: '@angular/cli',
      'dist-tags': { latest: '17.2.0' },
      versions: {
        '16.2.12': { version: '16.2.12', engines: { node: '^16.14.0 || >=18.10.0' } },
        '17.2.0': { version: '17.2.0', engines: { node: '^18.13.0 || >=20.9.0' } },
      },
    };

    const tsPackument = {
      name: 'typescript',
      'dist-tags': { latest: '5.3.3' },
      versions: {
        '5.1.6': { version: '5.1.6' },
        '5.3.3': { version: '5.3.3' },
      },
    };

    const now = Date.now();
    for (const [name, pack] of [
      ['@angular/core', corePackument],
      ['@angular/compiler-cli', compilerPackument],
      ['@angular/cli', cliPackument],
      ['typescript', tsPackument],
    ] as const) {
      await writeFile(
        path.join(cacheDir, `${encodeURIComponent(name)}.json`),
        JSON.stringify({ fetchedAt: now, packument: pack }),
      );
    }
  }

  it('runs doctor, analyze, plan, status, and approve end-to-end', async () => {
    await setupMockAngularProject(dir);

    // 1. Doctor
    const docIo = makeIo(dir);
    const docCode = await runCli(['doctor'], docIo.io);
    expect(docCode).toBe(ExitCode.Success);
    expect(docIo.out()).toContain('Doctor check completed');

    // 2. Analyze
    const anaIo = makeIo(dir);
    const anaCode = await runCli(['analyze', '--offline'], anaIo.io);
    expect(anaCode).toBe(ExitCode.Success);
    expect(anaIo.out()).toContain('Analyzing project: test-angular-app');
    expect(anaIo.out()).toContain('Current Angular: 15.2.0 (major 15) -> Target step: 16');

    // 3. Status before plan
    const stat1 = makeIo(dir);
    await runCli(['status'], stat1.io);
    expect(stat1.out()).toContain('No active migration plan found');

    // 4. Plan to 17
    const planIo = makeIo(dir);
    const planCode = await runCli(['plan', '--to', '17', '--offline', '--allow-dirty'], planIo.io);
    expect(planCode).toBe(ExitCode.Success);
    expect(planIo.out()).toContain('Plan generated successfully (2 step(s))');

    // Verify step files and summary exist
    expect(await pathExists(path.join(dir, '.ng-migrator', 'summary.md'))).toBe(true);
    expect(await pathExists(path.join(dir, '.ng-migrator', 'steps', '01-angular-15-to-16.md'))).toBe(true);
    expect(await pathExists(path.join(dir, '.ng-migrator', 'steps', '02-angular-16-to-17.md'))).toBe(true);

    // 5. Status after plan
    const stat2 = makeIo(dir);
    await runCli(['status'], stat2.io);
    expect(stat2.out()).toContain('Step 1: Angular 15 -> 16 [planned]');
    expect(stat2.out()).toContain('Step 2: Angular 16 -> 17 [planned]');

    // 6. Approve step 1
    const appIo = makeIo(dir);
    const appCode = await runCli(['approve', '1'], appIo.io);
    expect(appCode).toBe(ExitCode.Success);
    expect(appIo.out()).toContain('Step 1 (Angular 15 to 16) is now approved');

    // 7. Status after approval
    const stat3 = makeIo(dir);
    await runCli(['status'], stat3.io);
    expect(stat3.out()).toContain('Step 1: Angular 15 -> 16 [approved]');
    expect(stat3.out()).toContain('Step 2: Angular 16 -> 17 [planned]');

    // Check state.json
    const state = await readJsonIfExists<MigratorState>(path.join(dir, '.ng-migrator', 'state.json'));
    expect(state?.steps[0]?.status).toBe('approved');
    expect(state?.steps[1]?.status).toBe('planned');
  });
});
