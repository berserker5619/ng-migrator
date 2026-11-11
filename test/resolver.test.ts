import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config/config.js';
import type { ProjectInfo, StepRequirements } from '../src/model.js';
import * as proc from '../src/platform/process.js';
import { createPlan } from '../src/planner/plan.js';
import { readProject } from '../src/reader/project.js';
import { RegistryClient, type Packument } from '../src/registry/client.js';
import { loadNpmrc } from '../src/registry/npmrc.js';
import { preserveRangeStyle, satisfiesAngularPeer } from '../src/resolver/range.js';
import { resolveStepDependencies } from '../src/resolver/resolve.js';
import {
  detectYarnLockfileFlavor,
  parseNpmEresolve,
  parsePeerConflicts,
  parseYarnVersionFlavor,
  pruneYarnLockEntries,
  verifyWithPackageManager,
} from '../src/resolver/verify.js';
import { tempProject, writeCacheEntry } from './helpers.js';

describe('preserveRangeStyle', () => {
  it('preserves caret, tilde, and exact', () => {
    expect(preserveRangeStyle('16.2.0', '^15.0.0')).toBe('^16.2.0');
    expect(preserveRangeStyle('16.2.0', '~15.1.2')).toBe('~16.2.0');
    expect(preserveRangeStyle('16.2.0', '15.0.0')).toBe('16.2.0');
    expect(preserveRangeStyle('16.2.0', '>=15.0.0')).toBe('>=16.2.0');
  });
});

describe('satisfiesAngularPeer', () => {
  it('checks angular peer dependency ranges', () => {
    expect(satisfiesAngularPeer({ '@angular/core': '^16.0.0' }, '16.2.0', 16)).toBe(true);
    expect(satisfiesAngularPeer({ '@angular/core': '^15.0.0' }, '16.2.0', 16)).toBe(false);
    expect(satisfiesAngularPeer({ '@angular/core': '^15.0.0 || ^16.0.0' }, '16.2.0', 16)).toBe(true);
    expect(satisfiesAngularPeer(undefined, '16.2.0', 16)).toBe(true);
  });
});

describe('parseNpmEresolve', () => {
  it('extracts peer requirement conflicts from npm error output', () => {
    const output = `
npm error While resolving: @angular/material@15.2.0
npm error Found: @angular/core@16.2.0
npm error Could not resolve dependency:
npm error peer @angular/core@"^15.0.0" from @angular/material@15.2.0
    `;
    const conflicts = parseNpmEresolve(output);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      peer: '@angular/core',
      range: '^15.0.0',
      requiredBy: '@angular/material@15.2.0',
      found: '@angular/core@16.2.0',
    });
  });

  it('extracts peer requirement conflicts from pnpm and yarn output', () => {
    const pnpmOutput = `
 WARN  Issues with peer dependencies found
.
└─┬ ngx-old-chart 2.1.0
  └── ✕ unmet peer @angular/core@"^15.0.0": found 16.2.12
    `;
    expect(parseNpmEresolve(pnpmOutput)).toEqual([
      {
        peer: '@angular/core',
        range: '^15.0.0',
        requiredBy: 'ngx-old-chart@2.1.0',
        found: '@angular/core@16.2.12',
      },
    ]);

    const yarnOutput = `warning " > @ng-bootstrap/ng-bootstrap@14.2.0" has incorrect peer dependency "@angular/core@^15.0.0".`;
    expect(parseNpmEresolve(yarnOutput)).toEqual([
      {
        peer: '@angular/core',
        range: '^15.0.0',
        requiredBy: '@ng-bootstrap/ng-bootstrap@14.2.0',
      },
    ]);
  });

  it('parses recorded pnpm and yarn peer warning fixtures (confirming parser is not npm-only)', async () => {
    const pnpmFixture = await readFile(
      path.resolve(__dirname, 'fixtures', 'resolution', 'pnpm-peer-warnings.txt'),
      'utf8',
    );
    const yarnFixture = await readFile(
      path.resolve(__dirname, 'fixtures', 'resolution', 'yarn-peer-warnings.txt'),
      'utf8',
    );

    expect(parsePeerConflicts(pnpmFixture)).toEqual([
      {
        peer: '@angular/common',
        range: '^15.0.0',
        requiredBy: '@ng-bootstrap/ng-bootstrap@14.2.0',
        found: '@angular/common@16.2.12',
      },
      {
        peer: '@angular/core',
        range: '^15.0.0',
        requiredBy: '@ng-bootstrap/ng-bootstrap@14.2.0',
        found: '@angular/core@16.2.12',
      },
      {
        peer: '@angular/core',
        range: '^15.0.0',
        requiredBy: 'ngx-old-chart@2.1.0',
        found: '@angular/core@16.2.12',
      },
    ]);

    expect(parsePeerConflicts(yarnFixture)).toEqual([
      {
        peer: '@angular/core',
        range: '^15.0.0',
        requiredBy: '@ng-bootstrap/ng-bootstrap@14.2.0',
      },
      {
        peer: '@angular/common',
        range: '^15.0.0',
        requiredBy: '@ng-bootstrap/ng-bootstrap@14.2.0',
      },
      {
        peer: '@angular/core',
        range: '^12.0.0',
        requiredBy: 'ngx-chips@2.2.2',
      },
    ]);
  });

  it('parses real recorded npm ERESOLVE fixture with and without --strict-peer-deps', async () => {
    const realEresolveFixture = await readFile(
      path.resolve(__dirname, 'fixtures', 'resolution', 'npm-eresolve-real.txt'),
      'utf8',
    );
    const conflicts = parsePeerConflicts(realEresolveFixture);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({
      peer: '@angular/common',
      range: '^15.0.0',
      requiredBy: '@ng-bootstrap/ng-bootstrap@14.2.0',
      found: '@angular/common@16.2.12',
    });
  });
});

describe('verifyWithPackageManager and ERESOLVE blocker options (npm, yarn, pnpm)', () => {
  it('runs resolution check in an OS temp directory with copied manifest, lockfile and .npmrc, and cleans up afterwards', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'verify-test',
          dependencies: { '@angular/core': '^15.2.0', 'legacy-widget': '^1.0.0' },
        }),
      );
      await writeFile(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      await writeFile(path.join(dir, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

      const spy = vi.spyOn(proc, 'run').mockResolvedValue({
        command: 'pnpm install --lockfile-only --ignore-scripts',
        exitCode: 1,
        stdout: '',
        stderr: `
npm error While resolving: legacy-widget@1.0.0
npm error Found: @angular/core@16.2.12
npm error Could not resolve dependency:
npm error peer @angular/core@"^15.0.0" from legacy-widget@1.0.0
`,
        timedOut: false,
        failed: true,
      });

      const res = await verifyWithPackageManager({
        projectRoot: dir,
        packageManager: 'pnpm',
        changes: [
          {
            name: '@angular/core',
            type: 'dependencies',
            current: '15.2.0',
            currentSpec: '^15.2.0',
            target: '16.2.12',
            targetSpec: '^16.2.12',
            reason: 'Target major 16',
            evidence: 'declared',
          },
        ],
      });

      expect(res.status).toBe('conflict');
      expect(res.copiedFiles).toEqual(['package.json', 'pnpm-lock.yaml', '.npmrc']);
      expect(res.tempDir).toContain('ngm-resolve-');
      expect(res.tempDirCleaned).toBe(true);
      expect(res.conflicts).toEqual([
        {
          peer: '@angular/core',
          range: '^15.0.0',
          requiredBy: 'legacy-widget@1.0.0',
          found: '@angular/core@16.2.12',
        },
      ]);

      spy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  it('converts ERESOLVE conflicts into peer-conflict blockers with swap and override options for npm, yarn, and pnpm', async () => {
    for (const [pm, lockfile, expectedOverrideKey] of [
      ['npm', 'package-lock.json', '"overrides"'],
      ['yarn', 'yarn.lock', '"resolutions"'],
      ['pnpm', 'pnpm-lock.yaml', '"pnpm.overrides"'],
    ] as const) {
      const { dir, cleanup } = await tempProject();
      try {
        await writeFile(
          path.join(dir, 'package.json'),
          JSON.stringify({
            name: `${pm}-conflict-app`,
            dependencies: {
              '@angular/core': '^15.2.0',
              'conflicting-pkg': '^2.0.0',
            },
          }),
        );
        await writeFile(path.join(dir, lockfile), '');

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
        await writeCacheEntry(dir, 'conflicting-pkg', {
          name: 'conflicting-pkg',
          distTags: { latest: '2.0.0' },
          versions: {
            '2.0.0': {
              version: '2.0.0',
              peerDependencies: { '@angular/core': '>=15.0.0' },
            },
          },
        });

        const spy = vi.spyOn(proc, 'run').mockResolvedValue({
          command: `${pm} check`,
          exitCode: 1,
          stdout: '',
          stderr: `
npm error While resolving: conflicting-pkg@2.0.0
npm error Found: @angular/core@16.2.12
npm error Could not resolve dependency:
npm error peer @angular/core@"^15.0.0" from conflicting-pkg@2.0.0
`,
          timedOut: false,
          failed: true,
        });

        const project = await readProject(dir);
        const config = resolveConfig({}, {}, { packageManager: project.packageManager.name });
        const npmrc = await loadNpmrc(dir, {});
        const registry = new RegistryClient({
          npmrc,
          cacheDir: path.join(dir, '.ng-migrator', 'cache'),
          offline: true,
        });

        const plan = await createPlan({
          project,
          targetMajor: 16,
          registry,
          config,
          verifyResolution: true,
          clock: () => new Date('2026-11-01T00:00:00.000Z'),
        });

        const step = plan.steps[0]!;
        const peerBlocker = step.blockers.find((b) => b.reason === 'peer-conflict');
        expect(peerBlocker).toBeDefined();
        expect(peerBlocker?.hard).toBe(true);
        expect(peerBlocker?.details).toContain('conflicting-pkg@2.0.0 requires peer @angular/core@"^15.0.0"');
        expect(peerBlocker?.options).toHaveLength(2);
        expect(peerBlocker?.options?.[0]).toContain('Swap conflicting-pkg');
        expect(peerBlocker?.options?.[1]).toContain(expectedOverrideKey);

        spy.mockRestore();
      } finally {
        await cleanup();
      }
    }
  });

  it('runs pnpm and yarn in strictest mode and converts peer warnings (even on exit code 0) into the same blocker shape as npm ERESOLVE', async () => {
    const pnpmFixture = await readFile(
      path.resolve(__dirname, 'fixtures', 'resolution', 'pnpm-peer-warnings.txt'),
      'utf8',
    );
    const yarnFixture = await readFile(
      path.resolve(__dirname, 'fixtures', 'resolution', 'yarn-peer-warnings.txt'),
      'utf8',
    );

    for (const [pm, lockfile, fixtureText, expectedArg, expectedOverrideKey] of [
      ['pnpm', 'pnpm-lock.yaml', pnpmFixture, '--strict-peer-dependencies', '"pnpm.overrides"'],
      ['yarn', 'yarn.lock', yarnFixture, '--non-interactive', '"resolutions"'],
    ] as const) {
      const { dir, cleanup } = await tempProject();
      try {
        await writeFile(
          path.join(dir, 'package.json'),
          JSON.stringify({
            name: `${pm}-warning-app`,
            dependencies: {
              '@angular/core': '^15.2.0',
              '@ng-bootstrap/ng-bootstrap': '^14.2.0',
            },
          }),
        );
        await writeFile(path.join(dir, lockfile), '');

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
        await writeCacheEntry(dir, '@ng-bootstrap/ng-bootstrap', {
          name: '@ng-bootstrap/ng-bootstrap',
          distTags: { latest: '14.2.0' },
          versions: {
            '14.2.0': {
              version: '14.2.0',
              peerDependencies: { '@angular/core': '>=14.0.0' },
            },
          },
        });

        let spawnedArgs: readonly string[] = [];
        // Simulate yarn/pnpm exiting 0 while emitting peer warnings
        const spy = vi.spyOn(proc, 'run').mockImplementation(async (_cmd, args) => {
          spawnedArgs = args;
          return {
            command: `${_cmd} ${args.join(' ')}`,
            exitCode: 0,
            stdout: fixtureText,
            stderr: '',
            timedOut: false,
            failed: false,
          };
        });

        const project = await readProject(dir);
        const config = resolveConfig({}, {}, { packageManager: project.packageManager.name });
        const npmrc = await loadNpmrc(dir, {});
        const registry = new RegistryClient({
          npmrc,
          cacheDir: path.join(dir, '.ng-migrator', 'cache'),
          offline: true,
        });

        const plan = await createPlan({
          project,
          targetMajor: 16,
          registry,
          config,
          verifyResolution: true,
          clock: () => new Date('2026-11-01T00:00:00.000Z'),
        });

        expect(spawnedArgs).toContain(expectedArg);
        const step = plan.steps[0]!;
        expect(step.resolution.status).toBe('conflict');
        expect(step.resolution.packageManager).toBe(pm);
        expect(step.resolution.withWarnings).toBe(true);

        const ngbBlocker = step.blockers.find(
          (b) => b.package === '@ng-bootstrap/ng-bootstrap' && b.reason === 'peer-conflict',
        );
        expect(ngbBlocker).toBeDefined();
        expect(ngbBlocker?.hard).toBe(true);
        expect(ngbBlocker?.dependencyKind).toBe('runtime');
        expect(ngbBlocker?.options).toHaveLength(2);
        expect(ngbBlocker?.options?.[0]).toContain('Swap @ng-bootstrap/ng-bootstrap');
        expect(ngbBlocker?.options?.[1]).toContain(expectedOverrideKey);

        spy.mockRestore();
      } finally {
        await cleanup();
      }
    }
  });

  it('handles bundled dependencies (codelyzer case): npm exits 0 while tool check flags hard blocker, and step document contrasts both without saying compatible or verified', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'codelyzer-contrast-app',
          dependencies: {
            '@angular/core': '^12.2.0',
            '@angular/compiler': '^12.2.0',
          },
          devDependencies: {
            codelyzer: '^6.0.2',
          },
        }),
      );
      await writeFile(path.join(dir, 'package-lock.json'), '{"name": "codelyzer-contrast-app", "lockfileVersion": 2}\n');

      await writeCacheEntry(dir, '@angular/core', {
        name: '@angular/core',
        distTags: { latest: '13.4.0' },
        versions: {
          '12.2.0': { version: '12.2.0' },
          '13.4.0': { version: '13.4.0' },
        },
      });
      await writeCacheEntry(dir, '@angular/compiler', {
        name: '@angular/compiler',
        distTags: { latest: '13.4.0' },
        versions: {
          '12.2.0': { version: '12.2.0' },
          '13.4.0': { version: '13.4.0' },
        },
      });
      await writeCacheEntry(dir, '@angular/compiler-cli', {
        name: '@angular/compiler-cli',
        distTags: { latest: '13.4.0' },
        versions: {
          '13.4.0': { version: '13.4.0', peerDependencies: { typescript: '>=4.4.2 <4.6' } },
        },
      });
      await writeCacheEntry(dir, '@angular/cli', {
        name: '@angular/cli',
        distTags: { latest: '13.4.0' },
        versions: {
          '13.4.0': { version: '13.4.0' },
        },
      });
      // Codelyzer bundles @angular/core 9.0.0 in dependencies, but peerDependencies excludes 13 (<13.0.0)
      await writeCacheEntry(dir, 'codelyzer', {
        name: 'codelyzer',
        distTags: { latest: '6.0.2' },
        versions: {
          '6.0.2': {
            version: '6.0.2',
            dependencies: {
              '@angular/compiler': '9.0.0',
              '@angular/core': '9.0.0',
            },
            peerDependencies: {
              '@angular/compiler': '>=2.3.1 <13.0.0',
              '@angular/core': '>=2.3.1 <13.0.0',
            },
          },
        },
      });

      // Simulate npm resolving with exitCode 0
      const spy = vi.spyOn(proc, 'run').mockImplementation(async (cmd, args) => {
        return {
          command: `${cmd} ${args.join(' ')}`,
          exitCode: 0,
          stdout: 'up to date in 2s',
          stderr: '',
          timedOut: false,
          failed: false,
        };
      });

      const project = await readProject(dir);
      const config = resolveConfig({}, {}, { packageManager: 'npm' });
      const npmrc = await loadNpmrc(dir, {});
      const registry = new RegistryClient({
        npmrc,
        cacheDir: path.join(dir, '.ng-migrator', 'cache'),
        offline: true,
      });

      const plan = await createPlan({
        project,
        targetMajor: 13,
        registry,
        config,
        verifyResolution: true,
        clock: () => new Date('2026-11-01T00:00:00.000Z'),
      });

      expect(plan.steps).toHaveLength(1);
      const step1 = plan.steps[0]!;

      // 1. npm exited 0 -> resolution.status is confirmed
      expect(step1.resolution.status).toBe('confirmed');
      expect(step1.resolution.packageManager).toBe('npm');

      // 2. Tool's own check flagged codelyzer as hard blocker!
      const codelyzerBlocker = step1.blockers.find((b) => b.package === 'codelyzer');
      expect(codelyzerBlocker).toBeDefined();
      expect(codelyzerBlocker?.hard).toBe(true);
      expect(codelyzerBlocker?.reason).toBe('no-compatible-version');

      // 3. Step document shows both results side by side with "resolved by npm without errors"
      const { formatStepDocument } = await import('../src/steps/writer.js');
      const doc = formatStepDocument(step1);
      expect(doc).toContain('Resolution check: resolved by npm without errors (without warnings) | Tool peer check: 1 hard blocker(s) (codelyzer).');
      expect(doc).toContain('- Peer check vs package manager: tool peer check = hard blocker (no-compatible-version); npm check = resolved by npm without errors.');
      // Never say "compatible" or "verified" for resolution status
      expect(doc).not.toContain('Resolution check: confirmed compatible');
      expect(doc).not.toContain('Resolution check: verified');

      spy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});

describe('resolveStepDependencies', () => {
  const requirements: StepRequirements = {
    major: 16,
    coreVersion: '16.2.12',
    notes: [],
  };

  const fakeProject: ProjectInfo = {
    root: '/test',
    angular: { version: '15.2.10', major: 15 },
    packageManager: { name: 'npm', source: 'default' },
    workspace: 'single',
    angularProjects: ['app'],
    style: 'standalone',
    dependencies: [
      { name: '@angular/core', declared: '^15.2.0', installed: '15.2.10', type: 'dependencies' },
      { name: 'ngx-lib', declared: '^2.0.0', installed: '2.0.0', type: 'dependencies' },
      { name: 'abandoned-lib', declared: '^1.0.0', installed: '1.0.0', type: 'dependencies' },
      { name: 'kept-internal', declared: '1.0.0', installed: '1.0.0', type: 'dependencies' },
    ],
    overrides: [],
    viewEngineSuspects: [],
    ngccScripts: [],
    hasNodeModules: true,
    hasNpmWorkspaces: false,
    warnings: [],
  };

  const packuments: Record<string, Packument> = {
    '@angular/core': {
      name: '@angular/core',
      distTags: { latest: '16.2.12' },
      versions: {
        '16.2.12': { version: '16.2.12' },
        '15.2.10': { version: '15.2.10' },
      },
    },
    'ngx-lib': {
      name: 'ngx-lib',
      distTags: { latest: '4.0.0' },
      versions: {
        '4.0.0': {
          version: '4.0.0',
          peerDependencies: { '@angular/core': '^17.0.0' }, // held back!
        },
        '3.0.0': {
          version: '3.0.0',
          peerDependencies: { '@angular/core': '^16.0.0' }, // candidate!
        },
        '2.0.0': {
          version: '2.0.0',
          peerDependencies: { '@angular/core': '^15.0.0' },
        },
      },
    },
    'abandoned-lib': {
      name: 'abandoned-lib',
      distTags: { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          version: '1.0.0',
          peerDependencies: { '@angular/core': '^14.0.0 || ^15.0.0' },
        },
      },
    },
  };

  const mockRegistry = {
    packument: async (name: string) => packuments[name],
  } as unknown as RegistryClient;

  it('proposes target versions, detects held back, flags blockers, and respects neverTouch', async () => {
    const result = await resolveStepDependencies({
      project: fakeProject,
      requirements,
      registry: mockRegistry,
      neverTouch: ['kept-internal'],
      clock: () => new Date('2026-11-01T00:00:00.000Z'),
    });

    // 1. Angular core upgraded to 16.2.12
    const coreChange = result.changes.find((c) => c.name === '@angular/core');
    expect(coreChange?.target).toBe('16.2.12');
    expect(coreChange?.targetSpec).toBe('^16.2.12');

    // 2. ngx-lib candidate is 3.0.0, 4.0.0 is held back
    const ngxChange = result.changes.find((c) => c.name === 'ngx-lib');
    expect(ngxChange?.target).toBe('3.0.0');

    expect(result.heldBack).toHaveLength(1);
    expect(result.heldBack[0]?.name).toBe('ngx-lib');
    expect(result.heldBack[0]?.version).toBe('4.0.0');

    // 3. abandoned-lib has no compatible version -> blocker
    expect(result.blockers.some((b) => b.package === 'abandoned-lib')).toBe(true);

    // 4. kept-internal in unchanged
    expect(result.unchanged).toContain('kept-internal');
  });

  it('records chosenVersion and chosenVersionReason when newer releases declare no Angular peer range (e.g. ngx-logger 5.0.4 to 5.0.12)', async () => {
    const ngxLoggerProject: ProjectInfo = {
      ...fakeProject,
      angular: { version: '12.2.0', major: 12 },
      dependencies: [
        { name: '@angular/core', declared: '~12.2.0', installed: '12.2.0', type: 'dependencies' },
        { name: 'ngx-logger', declared: '^5.0.0', installed: '5.0.0', type: 'dependencies' },
      ],
    };

    const ngxLoggerRegistry = {
      packument: async (name: string): Promise<Packument | undefined> => {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '13.4.0' },
            versions: {
              '12.2.0': { version: '12.2.0' },
              '13.4.0': { version: '13.4.0' },
            },
          };
        }
        if (name === 'ngx-logger') {
          return {
            name: 'ngx-logger',
            distTags: { latest: '5.0.12' },
            time: {
              '5.0.3': '2022-01-12T00:00:00.000Z',
              '5.0.4': '2022-02-01T00:00:00.000Z',
              '5.0.12': '2022-11-23T08:06:16.718Z',
            },
            versions: {
              '5.0.3': {
                version: '5.0.3',
                peerDependencies: { '@angular/core': '>=11.0.0', '@angular/common': '>=11.0.0' },
              },
              '5.0.4': {
                version: '5.0.4',
                peerDependencies: { tslib: '^2.3.0' },
              },
              '5.0.12': {
                version: '5.0.12',
                peerDependencies: { tslib: '^2.3.0' },
              },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project: ngxLoggerProject,
      requirements: { major: 13, coreVersion: '13.4.0', notes: [] },
      registry: ngxLoggerRegistry,
      neverTouch: [],
      clock: () => new Date('2026-11-01T00:00:00.000Z'),
    });

    const change = result.changes.find((c) => c.name === 'ngx-logger');
    expect(change?.target).toBe('5.0.3');
    expect(result.heldBack).toEqual([
      {
        name: 'ngx-logger',
        version: '5.0.4 to 5.0.12',
        reason:
          'Newer release(s) (5.0.4 to 5.0.12) declare no Angular peer range; chose 5.0.3 as highest release declaring an @angular/* peer range (>=11.0.0)',
      },
    ]);
    const blocker = result.blockers.find((b) => b.package === 'ngx-logger');
    expect(blocker?.chosenVersion).toBe('5.0.3');
    expect(blocker?.chosenVersionReason).toContain(
      'held back from 5.0.4 to 5.0.12 because those newer releases declare no Angular peer range; chose 5.0.3 as the highest release declaring an @angular/* peer range supporting Angular 13',
    );
  });
});

describe('Yarn Classic (1.x) vs Berry (2+) detection and verification', () => {
  it('detects Yarn lockfile and version flavors accurately', () => {
    expect(detectYarnLockfileFlavor('# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n')).toBe('classic');
    expect(detectYarnLockfileFlavor('__metadata:\n  version: 8\n')).toBe('berry');
    expect(detectYarnLockfileFlavor('')).toBeUndefined();

    expect(parseYarnVersionFlavor('1.22.22\n')).toEqual({ flavor: 'classic', version: '1.22.22' });
    expect(parseYarnVersionFlavor('4.5.1\n')).toEqual({ flavor: 'berry', version: '4.5.1' });
  });

  it('uses --mode update-lockfile for Yarn Berry and real temp-dir install with --ignore-scripts for Yarn Classic', async () => {
    for (const [flavor, versionOut, lockHeader, expectedCommand] of [
      [
        'berry',
        '4.5.1\n',
        '__metadata:\n  version: 8\n',
        'yarn install --mode update-lockfile --ignore-scripts',
      ],
      [
        'classic',
        '1.22.22\n',
        '# yarn lockfile v1\n',
        'yarn install --ignore-scripts --non-interactive --no-progress',
      ],
    ] as const) {
      const { dir, cleanup } = await tempProject();
      try {
        await writeFile(
          path.join(dir, 'package.json'),
          JSON.stringify({ name: `yarn-${flavor}-test`, dependencies: { '@angular/core': '^15.2.0' } }),
        );
        await writeFile(path.join(dir, 'yarn.lock'), lockHeader);

        const seenCommands: string[] = [];
        const spy = vi.spyOn(proc, 'run').mockImplementation(async (cmd, args) => {
          const full = `${cmd} ${args.join(' ')}`;
          seenCommands.push(full);
          if (args[0] === '--version') {
            return {
              command: full,
              exitCode: 0,
              stdout: versionOut,
              stderr: '',
              timedOut: false,
              failed: false,
            };
          }
          return {
            command: full,
            exitCode: 0,
            stdout: 'Done in 0.50s.',
            stderr: '',
            timedOut: false,
            failed: false,
          };
        });

        const res = await verifyWithPackageManager({
          projectRoot: dir,
          packageManager: 'yarn',
          changes: [
            {
              name: '@angular/core',
              type: 'dependencies',
              current: '15.2.0',
              currentSpec: '^15.2.0',
              target: '16.2.12',
              targetSpec: '^16.2.12',
              reason: 'Update',
              evidence: 'declared',
            },
          ],
        });

        expect(res.status).toBe('confirmed');
        expect(res.yarnFlavor).toBe(flavor);
        expect(res.command).toBe(expectedCommand);
        expect(seenCommands).toContain(expectedCommand);
        spy.mockRestore();
      } finally {
        await cleanup();
      }
    }
  });

  it('reports "resolution not verified (yarn classic)" when yarn classic cannot verify in the temp directory', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'yarn-classic-unverified', dependencies: { '@angular/core': '^15.2.0' } }),
      );
      await writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');

      const spy = vi.spyOn(proc, 'run').mockImplementation(async (cmd, args) => {
        const full = `${cmd} ${args.join(' ')}`;
        if (args[0] === '--version') {
          return {
            command: full,
            exitCode: 0,
            stdout: '1.22.22\n',
            stderr: '',
            timedOut: false,
            failed: false,
          };
        }
        return {
          command: full,
          exitCode: 1,
          stdout: '',
          stderr: 'error An unexpected error occurred: "https://registry.yarnpkg.com/@angular%2fcore: ENOTFOUND".',
          timedOut: false,
          failed: true,
        };
      });

      const res = await verifyWithPackageManager({
        projectRoot: dir,
        packageManager: 'yarn',
        changes: [],
      });

      expect(res.status).toBe('unverified');
      expect(res.yarnFlavor).toBe('classic');
      expect(res.detail).toBe('resolution not verified (yarn classic)');
      spy.mockRestore();
    } finally {
      await cleanup();
    }
  });

  it('prunes changed package entries from yarn.lock so yarn updates only the changed packages', () => {
    const sampleYarnLock = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT DIRECTLY.
# yarn lockfile v1


"@angular/common@^14.2.0":
  version "14.3.0"
  resolved "https://registry.yarnpkg.com/@angular/common/-/common-14.3.0.tgz"
  dependencies:
    tslib "^2.3.0"

"@angular/core@^14.2.0":
  version "14.3.0"
  resolved "https://registry.yarnpkg.com/@angular/core/-/core-14.3.0.tgz"
  dependencies:
    rxjs "^6.5.3 || ^7.4.0"
    tslib "^2.3.0"

"rxjs@~7.5.0":
  version "7.5.7"
  resolved "https://registry.yarnpkg.com/rxjs/-/rxjs-7.5.7.tgz"
  dependencies:
    tslib "^2.1.0"
`;

    const pruned = pruneYarnLockEntries(sampleYarnLock, ['@angular/core']);
    expect(pruned).not.toContain('@angular/core@^14.2.0');
    expect(pruned).toContain('@angular/common@^14.2.0');
    expect(pruned).toContain('rxjs@~7.5.0');
  });

  it('includes download estimate message and configurable timeout in Yarn classic resolution check', async () => {
    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'yarn-classic-timeout-test',
          dependencies: {
            '@angular/core': '^14.2.0',
            rxjs: '~7.5.0',
          },
        }),
      );
      await writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');

      const notices: string[] = [];
      let receivedTimeout: number | undefined;

      const spy = vi.spyOn(proc, 'run').mockImplementation(async (cmd, args, opts) => {
        if (args[0] === '--version') {
          return { command: `${cmd} ${args.join(' ')}`, exitCode: 0, stdout: '1.22.22\n', stderr: '', timedOut: false, failed: false };
        }
        receivedTimeout = opts?.timeoutMs;
        return { command: `${cmd} ${args.join(' ')}`, exitCode: 0, stdout: 'Done in 2.0s', stderr: '', timedOut: false, failed: false };
      });

      const res = await verifyWithPackageManager({
        projectRoot: dir,
        packageManager: 'yarn',
        changes: [
          {
            name: '@angular/core',
            type: 'dependencies',
            current: '14.2.0',
            currentSpec: '^14.2.0',
            target: '15.2.10',
            targetSpec: '^15.2.10',
            reason: 'upgrade',
            evidence: 'declared',
          },
        ],
        timeoutMs: 60_000,
        onNotice: (m) => notices.push(m),
      });

      expect(res.status).toBe('confirmed');
      expect(res.yarnFlavor).toBe('classic');
      expect(receivedTimeout).toBe(60_000);
      expect(res.timeoutMs).toBe(60_000);
      expect(res.downloadEstimateMessage).toBeDefined();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('Yarn classic (1.x) has no lockfile-only mode');
      expect(notices[0]).toContain('timeout 60s');
      spy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});
