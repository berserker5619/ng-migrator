import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/program.js';
import { ERRORS, ExitCode } from '../src/errors.js';
import { pathExists } from '../src/platform/fs.js';
import { TOOL_VERSION } from '../src/version.js';
import { tempProject, writeCacheEntry } from './helpers.js';

function io(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    isTTY: false,
    env: {},
    nodeVersion: '24.0.0',
    cwd: process.cwd(),
    clock: () => new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  };
  return { value, out: () => out.join(''), err: () => err.join('') };
}

describe('cli', () => {
  it('prints the version', async () => {
    const t = io();
    expect(TOOL_VERSION).toBe('1.3.0');
    expect(await runCli(['--version'], t.value)).toBe(ExitCode.Success);
    expect(t.out().trim()).toBe('1.3.0');
  });

  it('lists the 1.0 commands in help and rejects migrate', async () => {
    const t = io();
    expect(await runCli(['--help'], t.value)).toBe(ExitCode.Success);
    for (const cmd of ['doctor', 'analyze', 'plan', 'status', 'approve']) expect(t.out()).toContain(cmd);
    expect(t.out()).not.toContain('migrate');

    const m = io();
    expect(await runCli(['migrate'], m.value)).toBe(ExitCode.Usage);
    expect(m.err()).toContain('NGM-2001');
  });

  it('exits 2 on an unknown flag', async () => {
    const t = io();
    expect(await runCli(['analyze', '--bogus'], t.value)).toBe(ExitCode.Usage);
    expect(t.err()).toContain('NGM-2001');
  });

  it('exits 2 on a range or minor passed to --to', async () => {
    for (const to of ['17-19', '19.1', 'latest', '^19']) {
      const t = io();
      expect(await runCli(['plan', '--to', to], t.value)).toBe(ExitCode.Usage);
      expect(t.err()).toContain('NGM-2002');
    }
  });

  it('exits 2 on an invalid step number', async () => {
    const t = io();
    expect(await runCli(['approve', 'two'], t.value)).toBe(ExitCode.Usage);
  });

  it('exits 6 on EOL Node versions (18, 20) and allows supported Node lines (22, 24, 26)', async () => {
    for (const eol of ['18.20.4', '20.18.0']) {
      const t = io({ nodeVersion: eol });
      expect(await runCli(['status'], t.value)).toBe(ExitCode.Environment);
      expect(t.err()).toContain('NGM-6001');
    }

    for (const v of ['22.12.0', '24.0.0', '26.0.0']) {
      const ok = io({ nodeVersion: v });
      expect(await runCli(['--version'], ok.value)).toBe(ExitCode.Success);
    }
  });

  it('uses ASCII symbols and no color when asked', async () => {
    const t = io({ isTTY: true });
    await runCli(['--no-color', '--ascii', 'plan', '--to', '19.1'], t.value);
    expect(t.err()).toContain('[x] NGM-2002');
    expect(t.err()).not.toContain('\u001b[');
  });

  it('has error ids whose first digit matches the exit code', () => {
    for (const [id, spec] of Object.entries(ERRORS)) expect(id.charAt(4)).toBe(String(spec.exitCode));
  });

  it('supports global --project <path> across doctor, analyze, plan, status, and approve with project-relative paths', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'proj-flag-test',
          dependencies: {
            '@angular/core': '^15.2.0',
          },
        }),
      );
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'main.ts'), 'export const x = 1;');

      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '16.2.12' },
        versions: {
          '15.2.0': { version: '15.2.0' },
          '16.2.12': { version: '16.2.12' },
        },
      });
      await writeCacheEntry(dir, '@angular/compiler-cli', {
        name: '@angular/compiler-cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12', peerDependencies: { typescript: '>=4.9.3 <5.2.0' } },
        },
      });
      await writeCacheEntry(dir, '@angular/cli', {
        name: '@angular/cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12' },
        },
      });

      // Run from a completely different cwd using --project <dir>
      const otherCwd = path.dirname(dir);

      const dOut = io({ cwd: otherCwd });
      expect(await runCli(['--project', dir, 'doctor'], dOut.value)).toBe(ExitCode.Success);
      expect(dOut.out()).toContain('Doctor check completed');

      const aOut = io({ cwd: otherCwd });
      expect(await runCli(['--project', dir, 'analyze', '--offline'], aOut.value)).toBe(ExitCode.Success);
      expect(aOut.out()).toContain('proj-flag-test');
      expect(aOut.out()).not.toContain(dir);

      const pOut = io({ cwd: otherCwd });
      expect(await runCli(['--project', dir, 'plan', '--to', '16', '--offline', '--allow-dirty'], pOut.value)).toBe(ExitCode.Success);
      expect(pOut.out()).toContain('.ng-migrator/steps/01-angular-15-to-16.md');
      expect(pOut.out()).not.toContain(dir);

      const sOut = io({ cwd: otherCwd });
      expect(await runCli(['--project', dir, 'status'], sOut.value)).toBe(ExitCode.Success);
      expect(sOut.out()).toContain('Step 1: Angular 15 -> 16 [planned]');

      const appOut = io({ cwd: otherCwd });
      expect(await runCli(['--project', dir, 'approve', '1'], appOut.value)).toBe(ExitCode.Success);
      expect(appOut.out()).toContain('Step 1 (Angular 15 to 16) is now approved');
    } finally {
      await cleanup();
    }
  });

  it('analyze --fail-on-blockers returns exit code 4 only for hard blockers, never for soft ones', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'main.ts'), "import '@angular/flex-layout';");

      // Case 1: Only soft blocker (@angular/flex-layout on Angular 15 -> 16 has open-ended peer >=15.0.2)
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'soft-blocker-app',
          dependencies: {
            '@angular/core': '^15.2.0',
            '@angular/flex-layout': '15.0.0-beta.42',
          },
        }),
      );
      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '16.2.12' },
        versions: {
          '15.2.0': { version: '15.2.0' },
          '16.2.12': { version: '16.2.12' },
        },
      });
      await writeCacheEntry(dir, '@angular/compiler-cli', {
        name: '@angular/compiler-cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12', peerDependencies: { typescript: '>=4.9.3 <5.2.0' } },
        },
      });
      await writeCacheEntry(dir, '@angular/cli', {
        name: '@angular/cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12' },
        },
      });
      await writeCacheEntry(dir, '@angular/flex-layout', {
        name: '@angular/flex-layout',
        distTags: { latest: '15.0.0-beta.42' },
        versions: {
          '15.0.0-beta.42': {
            version: '15.0.0-beta.42',
            peerDependencies: { '@angular/core': '>=15.0.2' },
            deprecated: 'Deprecated by Angular team',
          },
        },
        time: { '15.0.0-beta.42': '2023-01-01T00:00:00.000Z' },
      });

      const softOut = io({ cwd: dir });
      expect(await runCli(['analyze', '--fail-on-blockers', '--offline'], softOut.value)).toBe(ExitCode.Success);
      expect(softOut.err()).toContain('[deprecated] @angular/flex-layout');

      // Case 2: Hard blocker (package with no compatible version for Angular 16)
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'hard-blocker-app',
          dependencies: {
            '@angular/core': '^15.2.0',
            'strict-ng15-only': '1.0.0',
          },
        }),
      );
      await writeCacheEntry(dir, 'strict-ng15-only', {
        name: 'strict-ng15-only',
        distTags: { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            version: '1.0.0',
            peerDependencies: { '@angular/core': '^15.0.0' },
          },
        },
      });

      const hardOut = io({ cwd: dir });
      expect(await runCli(['analyze', '--fail-on-blockers', '--offline'], hardOut.value)).toBe(ExitCode.HardBlockers);
      expect(hardOut.err()).toContain('NGM-4001');
    } finally {
      await cleanup();
    }
  });

  it('supports --as-of <date> to compute unmaintained threshold against a fixed date and produce identical output on re-run', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'main.ts'), "import 'date-sensitive-lib';");
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'as-of-app',
          dependencies: {
            '@angular/core': '^15.2.0',
            'date-sensitive-lib': '^1.0.0',
          },
        }),
      );
      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '16.2.12' },
        versions: {
          '15.2.0': { version: '15.2.0' },
          '16.2.12': { version: '16.2.12' },
        },
      });
      await writeCacheEntry(dir, '@angular/compiler-cli', {
        name: '@angular/compiler-cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12', peerDependencies: { typescript: '>=4.9.3 <5.2.0' } },
        },
      });
      await writeCacheEntry(dir, '@angular/cli', {
        name: '@angular/cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12' },
        },
      });
      // Published on 2025-01-01:
      // - As of 2025-06-01 (5 months later), it is NOT unmaintained (< 18 months).
      // - As of 2026-11-01 (22 months later), it IS unmaintained (> 18 months).
      await writeCacheEntry(dir, 'date-sensitive-lib', {
        name: 'date-sensitive-lib',
        distTags: { latest: '2.0.0' },
        versions: {
          '2.0.0': {
            version: '2.0.0',
            peerDependencies: { '@angular/core': '^16.0.0' },
          },
        },
        time: { '2.0.0': '2025-01-01T00:00:00.000Z' },
      });

      // Invalid --as-of returns exit code 2 (NGM-2001)
      const badAsOf = io({ cwd: dir });
      expect(await runCli(['--as-of', 'not-a-date', 'analyze', '--offline'], badAsOf.value)).toBe(ExitCode.Usage);
      expect(badAsOf.err()).toContain('NGM-2001');

      // Early date: 2025-06-01 -> 0 blockers
      const earlyOut = io({ cwd: dir });
      expect(await runCli(['--as-of', '2025-06-01', 'analyze', '--offline'], earlyOut.value)).toBe(ExitCode.Success);
      expect(earlyOut.out()).toContain('Blockers detected: 0');

      // Later date: 2026-11-01 -> 1 unmaintained blocker
      const lateOut = io({ cwd: dir });
      expect(await runCli(['--as-of', '2026-11-01', 'analyze', '--offline'], lateOut.value)).toBe(ExitCode.Success);
      expect(lateOut.out()).toContain('Blockers detected: 1');
      expect(lateOut.err()).toContain('[unmaintained] date-sensitive-lib');

      // Re-running plan with fixed --as-of gives byte-for-byte identical output
      const plan1 = io({ cwd: dir, clock: () => new Date('2024-01-01T00:00:00Z') });
      expect(
        await runCli(['--as-of', '2026-11-01', 'plan', '--to', '16', '--offline', '--allow-dirty'], plan1.value),
      ).toBe(ExitCode.Success);
      const stepDoc1 = await readFile(path.join(dir, '.ng-migrator', 'steps', '01-angular-15-to-16.md'), 'utf8');
      const summary1 = await readFile(path.join(dir, '.ng-migrator', 'summary.md'), 'utf8');
      const state1 = await readFile(path.join(dir, '.ng-migrator', 'state.json'), 'utf8');

      const plan2 = io({ cwd: dir, clock: () => new Date('2029-12-31T23:59:59Z') });
      expect(
        await runCli(['--as-of', '2026-11-01', 'plan', '--to', '16', '--offline', '--allow-dirty'], plan2.value),
      ).toBe(ExitCode.Success);
      const stepDoc2 = await readFile(path.join(dir, '.ng-migrator', 'steps', '01-angular-15-to-16.md'), 'utf8');
      const summary2 = await readFile(path.join(dir, '.ng-migrator', 'summary.md'), 'utf8');
      const state2 = await readFile(path.join(dir, '.ng-migrator', 'state.json'), 'utf8');

      expect(stepDoc2).toBe(stepDoc1);
      expect(summary2).toBe(summary1);
      expect(state2).toBe(state1);
    } finally {
      await cleanup();
    }
  });

  it('exits 0 on analyze when project is already on latest major, and exits 2 on out-of-bounds --to', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'latest-major-app',
          dependencies: { '@angular/core': '^22.0.0' },
        }),
      );
      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '22.2.0' },
        versions: {
          '22.0.0': { version: '22.0.0' },
          '22.2.0': { version: '22.2.0' },
        },
      });

      const out = io({ cwd: dir });
      const code = await runCli(['analyze', '--offline'], out.value);
      expect(code).toBe(ExitCode.Success);
      expect(out.out()).toContain('already on the latest published major (22); nothing to upgrade');

      const outTo23 = io({ cwd: dir });
      const codeTo23 = await runCli(['analyze', '--to', '23', '--offline'], outTo23.value);
      expect(codeTo23).toBe(ExitCode.Usage);
      expect(outTo23.err()).toContain('NGM-2002');
    } finally {
      await cleanup();
    }
  });

  it('prints clear warning on manifest vs lockfile disagreement across doctor, analyze, and plan', async () => {
    const { dir, cleanup } = await tempProject({
      'package.json': JSON.stringify({
        name: 'disagree-app',
        dependencies: { '@angular/core': '^14.2.0' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'disagree-app',
        lockfileVersion: 2,
        packages: {
          '': { dependencies: { '@angular/core': '^14.2.0' } },
          'node_modules/@angular/core': { version: '13.3.1' },
        },
        dependencies: {
          '@angular/core': { version: '13.3.1' },
        },
      }),
    });
    try {
      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '14.3.0' },
        versions: {
          '13.3.1': { version: '13.3.1' },
          '14.3.0': { version: '14.3.0' },
        },
      });

      // Doctor
      const doctorIo = io({ cwd: dir });
      await runCli(['doctor'], doctorIo.value);
      const doctorOutput = doctorIo.out() + doctorIo.err();
      expect(doctorOutput).toContain('Manifest vs lockfile disagreement');
      expect(doctorOutput).toContain('package.json declares @angular/core "^14.2.0"');
      expect(doctorOutput).toContain('lockfile has "13.3.1"');

      // Analyze
      const analyzeIo = io({ cwd: dir });
      await runCli(['analyze', '--offline'], analyzeIo.value);
      const analyzeOutput = analyzeIo.out() + analyzeIo.err();
      expect(analyzeOutput).toContain('Manifest vs lockfile disagreement');

      // Plan
      const planIo = io({ cwd: dir });
      await runCli(['plan', '--to', '14', '--offline'], planIo.value);
      const planOutput = planIo.out() + planIo.err();
      expect(planOutput).toContain('Manifest vs lockfile disagreement');
      expect(planOutput).toContain('Planning upgrade: Angular 13.3.1 -> 14');
    } finally {
      await cleanup();
    }
  });

  it('prints per-phase progress lines and total elapsed time on stderr safely for --ascii and non-TTY', async () => {
    const { dir, cleanup } = await tempProject({
      'package.json': JSON.stringify({
        name: 'progress-timing-app',
        dependencies: {
          '@angular/core': '^13.3.1',
          '@angular/common': '^13.3.1',
        },
      }),
      'package-lock.json': JSON.stringify({
        name: 'progress-timing-app',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@angular/core': '^13.3.1', '@angular/common': '^13.3.1' } },
          'node_modules/@angular/core': { version: '13.3.1' },
          'node_modules/@angular/common': { version: '13.3.1' },
        },
      }),
    });
    try {
      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '14.3.0' },
        versions: {
          '13.3.1': { version: '13.3.1' },
          '14.3.0': { version: '14.3.0' },
        },
      });
      await writeCacheEntry(dir, '@angular/common', {
        name: '@angular/common',
        distTags: { latest: '14.3.0' },
        versions: {
          '13.3.1': { version: '13.3.1' },
          '14.3.0': { version: '14.3.0', peerDependencies: { '@angular/core': '^14.3.0' } },
        },
      });
      await writeCacheEntry(dir, '@angular/compiler-cli', {
        name: '@angular/compiler-cli',
        distTags: { latest: '14.3.0' },
        versions: {
          '14.3.0': { version: '14.3.0', peerDependencies: { typescript: '>=4.6.4 <4.9.0' } },
        },
      });
      await writeCacheEntry(dir, '@angular/cli', {
        name: '@angular/cli',
        distTags: { latest: '14.2.13' },
        versions: {
          '14.2.13': { version: '14.2.13' },
        },
      });

      // doctor (--ascii + non-TTY)
      const doctorIo = io({ cwd: dir, isTTY: false });
      expect(await runCli(['--ascii', 'doctor'], doctorIo.value)).toBe(ExitCode.Success);
      expect(doctorIo.err()).toContain('[i] Total elapsed time:');
      expect(doctorIo.out()).not.toContain('Total elapsed time:');
      expect(doctorIo.err()).not.toContain('\u001b[');

      // analyze --offline (--ascii + non-TTY)
      const analyzeIo = io({ cwd: dir, isTTY: false });
      expect(await runCli(['--ascii', 'analyze', '--offline'], analyzeIo.value)).toBe(ExitCode.Success);
      expect(analyzeIo.err()).toContain('[i] Fetching registry metadata 2/2');
      expect(analyzeIo.err()).toContain('[i] Total elapsed time:');
      expect(analyzeIo.out()).not.toContain('Fetching registry metadata');
      expect(analyzeIo.err()).not.toContain('\u001b[');

      // plan --offline (--ascii + non-TTY)
      const planIo = io({ cwd: dir, isTTY: false });
      expect(await runCli(['--ascii', 'plan', '--to', '14', '--offline'], planIo.value)).toBe(ExitCode.Success);
      expect(planIo.err()).toContain('[i] Fetching registry metadata 2/2');
      expect(planIo.err()).toContain('[i] Total elapsed time:');
      expect(planIo.out()).not.toContain('Fetching registry metadata');
      expect(planIo.err()).not.toContain('\u001b[');
    } finally {
      await cleanup();
    }
  });

  it('defaults plan without --to to next major (n+1) and exits 0 when already on latest major', async () => {
    const { dir, cleanup } = await tempProject({
      'package.json': JSON.stringify({
        name: 'default-to-plan-app',
        dependencies: { '@angular/core': '^15.2.0' },
      }),
    });
    try {
      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '16.2.12' },
        versions: {
          '15.2.0': { version: '15.2.0' },
          '16.2.12': { version: '16.2.12' },
        },
      });
      await writeCacheEntry(dir, '@angular/compiler-cli', {
        name: '@angular/compiler-cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12', peerDependencies: { typescript: '>=4.9.3 <5.2.0' } },
        },
      });
      await writeCacheEntry(dir, '@angular/cli', {
        name: '@angular/cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12' },
        },
      });

      const planIo = io({ cwd: dir });
      expect(await runCli(['--ascii', 'plan', '--offline', '--allow-dirty'], planIo.value)).toBe(ExitCode.Success);
      expect(planIo.out()).toContain('Planning upgrade: Angular 15.2.0 -> 16');
      expect(planIo.out()).toContain('.ng-migrator/steps/01-angular-15-to-16.md');
      expect(await pathExists(path.join(dir, '.ng-migrator', 'steps', '01-angular-15-to-16.md'))).toBe(true);

      // Now simulate a project already on the latest published major (22)
      const latest = await tempProject({
        'package.json': JSON.stringify({
          name: 'already-latest-app',
          dependencies: { '@angular/core': '^22.0.0' },
        }),
      });
      try {
        await writeCacheEntry(latest.dir, '@angular/core', {
          name: '@angular/core',
          distTags: { latest: '22.2.0' },
          versions: {
            '22.0.0': { version: '22.0.0' },
            '22.2.0': { version: '22.2.0' },
          },
        });

        const latestPlanIo = io({ cwd: latest.dir });
        expect(await runCli(['--ascii', 'plan', '--offline', '--allow-dirty'], latestPlanIo.value)).toBe(ExitCode.Success);
        expect(latestPlanIo.out()).toContain('already on the latest published major (22); nothing to plan');
        expect(await pathExists(path.join(latest.dir, '.ng-migrator', 'steps'))).toBe(false);

        const outOfBoundsIo = io({ cwd: latest.dir });
        expect(await runCli(['plan', '--to', '23', '--offline', '--allow-dirty'], outOfBoundsIo.value)).toBe(ExitCode.Usage);
        expect(outOfBoundsIo.err()).toContain('NGM-2002');
      } finally {
        await latest.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it('suggests --project <subfolder> across doctor, analyze, and plan when Angular lives in a nested folder', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await mkdir(path.join(dir, 'angular'), { recursive: true });
      await writeFile(
        path.join(dir, 'angular', 'package.json'),
        JSON.stringify({ name: 'nested-app', dependencies: { '@angular/core': '^15.2.0' } }),
      );
      await writeFile(path.join(dir, 'angular', 'angular.json'), JSON.stringify({ projects: {} }));

      // doctor prints hint on missing root package.json
      const docIo = io({ cwd: dir });
      expect(await runCli(['--ascii', 'doctor'], docIo.value)).toBe(ExitCode.Success);
      expect(docIo.err()).toContain('No package.json in this folder');
      expect(docIo.out()).toContain('--project angular');

      // analyze exits 3 with NGM-3007 and hint
      const anaIo = io({ cwd: dir });
      expect(await runCli(['--ascii', 'analyze', '--offline'], anaIo.value)).toBe(ExitCode.Precondition);
      expect(anaIo.err()).toContain('NGM-3007');
      expect(anaIo.out()).toContain('--project angular');

      // plan exits 3 with NGM-3007, prints hint, and does not create .ng-migrator in the non-Angular root
      const planIo = io({ cwd: dir });
      expect(await runCli(['--ascii', 'plan', '--offline'], planIo.value)).toBe(ExitCode.Precondition);
      expect(planIo.err()).toContain('NGM-3007');
      expect(planIo.out()).toContain('--project angular');
      expect(await pathExists(path.join(dir, '.ng-migrator'))).toBe(false);

      // Root package.json without @angular/core also suggests nested subfolder
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'monorepo-root', private: true }));

      const monoDocIo = io({ cwd: dir });
      expect(await runCli(['--ascii', 'doctor'], monoDocIo.value)).toBe(ExitCode.Success);
      expect(monoDocIo.err()).toContain('--project angular');

      const monoAnaIo = io({ cwd: dir });
      expect(await runCli(['--ascii', 'analyze', '--offline'], monoAnaIo.value)).toBe(ExitCode.Precondition);
      expect(monoAnaIo.err()).toContain('NGM-3007');
      expect(monoAnaIo.out()).toContain('--project angular');

      const monoPlanIo = io({ cwd: dir });
      expect(await runCli(['--ascii', 'plan', '--offline'], monoPlanIo.value)).toBe(ExitCode.Precondition);
      expect(monoPlanIo.err()).toContain('NGM-3007');
      expect(monoPlanIo.out()).toContain('--project angular');
    } finally {
      await cleanup();
    }
  });
});

