import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/config/config.js';
import type { ProjectInfo, StepRequirements } from '../src/model.js';
import * as proc from '../src/platform/process.js';
import { createPlan } from '../src/planner/plan.js';
import { readProject } from '../src/reader/project.js';
import { RegistryClient, allVersionsDesc, stableVersionsDesc, type Packument } from '../src/registry/client.js';
import { loadNpmrc } from '../src/registry/npmrc.js';
import { computeRecommendation, parseDeprecatedSuccessor } from '../src/recommend/engine.js';
import { normalizeRange, preserveRangeStyle, safeMinVersion, satisfiesAngularPeer } from '../src/resolver/range.js';
import { isProposedVersionIvyEra, resolveStepDependencies } from '../src/resolver/resolve.js';
import {
  baselineNotesForResolutionCheck,
  classifyBaselineVsProposedConflicts,
  detectYarnLockfileFlavor,
  enrichBlockersWithResolutionCheck,
  groupBlockersByPackage,
  parseNpmEresolve,
  parseNpmLsConflicts,
  parsePeerConflicts,
  parseYarnVersionFlavor,
  pruneYarnLockEntries,
  resolveFixablePeerConflicts,
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

  it('handles malformed real-world ranges without throwing', () => {
    // Real-world @swimlane/ngx-charts 11.0.0 declares "7.x | 8.x" with a single pipe
    expect(normalizeRange('7.x | 8.x')).toBe('7.x || 8.x');
    expect(satisfiesAngularPeer({ '@angular/core': '7.x | 8.x' }, '8.2.0', 8)).toBe(true);
    expect(satisfiesAngularPeer({ '@angular/core': '7.x | 8.x' }, '16.2.0', 16)).toBe(false);
    // Completely invalid semver range does not throw
    expect(satisfiesAngularPeer({ '@angular/core': 'not-a-valid-semver-range' }, '16.2.0', 16)).toBe(false);
    expect(safeMinVersion('not-a-valid-semver-range')).toBeNull();
    expect(safeMinVersion('7.x | 8.x')?.version).toBe('7.0.0');
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
    expect(change?.target).toBe('5.0.4');
    expect(change?.evidence).toBe('unknown');
    expect(change?.reason).toContain('published on 2022-02-01 during the Angular 13 lifecycle');
  });

  it('resolves sibling peer dependencies when package lacks direct @angular/core peer (e.g. @ngrx/store-devtools)', async () => {
    const siblingProject: ProjectInfo = {
      root: 'l:/fake/ngrx-app',
      name: 'ngrx-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '12.2.0', major: 12 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^12.2.0', installed: '12.2.0', type: 'dependencies' },
        { name: '@ngrx/store', declared: '^12.2.0', installed: '12.2.0', type: 'dependencies' },
        { name: '@ngrx/store-devtools', declared: '^12.2.0', installed: '12.2.0', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const siblingRegistry = {
      async packument(name: string) {
        if (name === '@ngrx/store') {
          return {
            name: '@ngrx/store',
            distTags: { latest: '14.3.3' },
            versions: {
              '12.2.0': { version: '12.2.0', peerDependencies: { '@angular/core': '^12.0.0' } },
              '14.3.3': { version: '14.3.3', peerDependencies: { '@angular/core': '^14.0.0' } },
            },
          };
        }
        if (name === '@ngrx/store-devtools') {
          return {
            name: '@ngrx/store-devtools',
            distTags: { latest: '14.3.3' },
            versions: {
              '12.2.0': { version: '12.2.0', peerDependencies: { '@ngrx/store': '12.2.0' } },
              '14.3.3': { version: '14.3.3', peerDependencies: { '@ngrx/store': '14.3.3' } },
              '18.1.0': { version: '18.1.0', peerDependencies: { '@angular/core': '^18.0.0' } },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project: siblingProject,
      requirements: { major: 14, coreVersion: '14.3.0', notes: [] },
      registry: siblingRegistry,
      neverTouch: [],
    });

    const storeChange = result.changes.find((c) => c.name === '@ngrx/store');
    const devtoolsChange = result.changes.find((c) => c.name === '@ngrx/store-devtools');
    expect(storeChange?.target).toBe('14.3.3');
    expect(devtoolsChange?.target).toBe('14.3.3');
    // Ensure @ngrx/store-devtools is NOT marked as a blocker!
    const devtoolsBlocker = result.blockers.find((b) => b.package === '@ngrx/store-devtools');
    expect(devtoolsBlocker).toBeUndefined();
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
        'yarn install --ignore-scripts --prefer-offline --no-bin-links --non-interactive --no-progress',
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
      expect(notices[0]).toContain('Rough estimate');
      expect(notices[0]).toContain('hundreds of MB');
      expect(notices[0]).toContain('timeout: 60s');
      spy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});

describe('Three-state evidence and synthetic pattern fixtures', () => {
  it('handles pattern A: no Angular peer but aligned sibling peer (@ngrx/store-devtools)', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/ngrx-app',
      name: 'ngrx-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '13.1.2', major: 13 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^13.1.2', installed: '13.1.2', type: 'dependencies' },
        { name: '@ngrx/store', declared: '^13.1.2', installed: '13.1.2', type: 'dependencies' },
        { name: '@ngrx/store-devtools', declared: '^13.1.2', installed: '13.1.2', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '14.3.0' },
            versions: { '14.3.0': { version: '14.3.0' } },
            time: { '14.0.0': '2022-06-02T00:00:00.000Z', '15.0.0': '2022-11-16T00:00:00.000Z' },
          };
        }
        if (name === '@ngrx/store') {
          return {
            name: '@ngrx/store',
            distTags: { latest: '14.3.3' },
            versions: {
              '13.1.2': { version: '13.1.2', peerDependencies: { '@angular/core': '^13.0.0' } },
              '14.3.3': { version: '14.3.3', peerDependencies: { '@angular/core': '^14.0.0' } },
            },
          };
        }
        if (name === '@ngrx/store-devtools') {
          return {
            name: '@ngrx/store-devtools',
            distTags: { latest: '18.1.1' },
            versions: {
              '13.1.2': { version: '13.1.2', peerDependencies: { '@ngrx/store': '13.1.2' } },
              '14.3.3': { version: '14.3.3', peerDependencies: { '@ngrx/store': '14.3.3' } },
              '18.1.1': { version: '18.1.1', peerDependencies: { '@angular/core': '^18.0.0' } },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project,
      requirements: { major: 14, coreVersion: '14.3.0', notes: [] },
      registry,
      neverTouch: [],
    });

    const devtoolsChange = result.changes.find((c) => c.name === '@ngrx/store-devtools');
    expect(devtoolsChange?.target).toBe('14.3.3');
    expect(devtoolsChange?.evidence).toBe('unknown');
    expect(devtoolsChange?.reason).toContain('aligned with sibling dependency @ngrx/store@14.3.3');
    expect(devtoolsChange?.reason).toContain('Unknown, verify by build');

    // Crucial: unknown evidence must NEVER produce a hard blocker!
    const hardBlocker = result.blockers.find((b) => b.package === '@ngrx/store-devtools' && b.hard);
    expect(hardBlocker).toBeUndefined();
  });

  it('handles pattern B: version-aligned releases without Angular peers (ngx-echarts at Angular 16)', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/echarts-app',
      name: 'echarts-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '15.2.10', major: 15 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
        { name: 'ngx-echarts', declared: '^15.0.3', installed: '15.0.3', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '16.2.12' },
            versions: { '16.2.12': { version: '16.2.12' } },
            time: { '16.0.0': '2023-05-03T00:00:00.000Z', '17.0.0': '2023-11-08T00:00:00.000Z' },
          };
        }
        if (name === 'ngx-echarts') {
          return {
            name: 'ngx-echarts',
            distTags: { latest: '22.0.0' },
            versions: {
              '6.0.1': { version: '6.0.1', peerDependencies: { '@angular/core': '>=10.0.0' } },
              '15.0.3': { version: '15.0.3', peerDependencies: { echarts: '>=5.0.0' } },
              '16.2.0': { version: '16.2.0', peerDependencies: { echarts: '>=5.0.0' } },
              '22.0.0': { version: '22.0.0', peerDependencies: { echarts: '>=5.0.0' } },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project,
      requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
      registry,
      neverTouch: [],
    });

    const echartsChange = result.changes.find((c) => c.name === 'ngx-echarts');
    // Must NOT downgrade to 6.0.1! Must choose 16.2.0 and show newest 22.0.0
    expect(echartsChange?.target).toBe('16.2.0');
    expect(echartsChange?.newestVersion).toBe('22.0.0');
    expect(echartsChange?.evidence).toBe('unknown');
    expect(echartsChange?.reason).toContain('major version 16 aligns with Angular 16');
    expect(echartsChange?.reason).toContain('Unknown, verify by build');

    const hardBlocker = result.blockers.find((b) => b.package === 'ngx-echarts' && b.hard);
    expect(hardBlocker).toBeUndefined();
  });

  it('handles pattern C: real declared incompatibility (ng2-smart-table declaring @angular/core ^10.0.0)', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/table-app',
      name: 'table-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '15.2.10', major: 15 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
        { name: 'ng2-smart-table', declared: '^1.7.2', installed: '1.7.2', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '16.2.12' },
            versions: { '16.2.12': { version: '16.2.12' } },
          };
        }
        if (name === 'ng2-smart-table') {
          return {
            name: 'ng2-smart-table',
            distTags: { latest: '1.7.2' },
            versions: {
              '1.7.2': {
                version: '1.7.2',
                peerDependencies: {
                  '@angular/core': '^10.0.0',
                  '@angular/common': '^10.0.0',
                },
              },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project,
      requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
      registry,
      neverTouch: [],
    });

    const hardBlocker = result.blockers.find((b) => b.package === 'ng2-smart-table');
    expect(hardBlocker).toBeDefined();
    expect(hardBlocker?.hard).toBe(true);
    expect(hardBlocker?.reason).toBe('no-compatible-version');
    expect(hardBlocker?.evidence).toBe('declared-incompatible');
  });

  it('handles pattern D: package declaring no Angular peer in any release (ng2-ckeditor) - non-blocker note when no red flag', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/editor-app',
      name: 'editor-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '15.2.10', major: 15 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
        { name: 'ng2-ckeditor', declared: '^1.3.7', installed: '1.3.7', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '16.2.12' },
            versions: { '16.2.12': { version: '16.2.12' } },
          };
        }
        if (name === 'ng2-ckeditor') {
          return {
            name: 'ng2-ckeditor',
            distTags: { latest: '1.3.7' },
            versions: {
              '1.3.7': { version: '1.3.7', peerDependencies: { '@types/ckeditor': '^4.9.10' } },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project,
      requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
      registry,
      neverTouch: [],
    });

    const ckChange = result.changes.find((c) => c.name === 'ng2-ckeditor');
    expect(ckChange?.target).toBe('1.3.7');
    expect(ckChange?.evidence).toBe('unknown');

    expect(result.blockers.find((b) => b.package === 'ng2-ckeditor')).toBeUndefined();
    const note = result.notes.find((n) => n.package === 'ng2-ckeditor');
    expect(note).toBeDefined();
    expect(note?.kind).toBe('verify-by-build');
    expect(note?.evidence).toBe('unknown');
  });

  it('handles pattern E: publish date falling between release dates of Angular n and n+1 (ngx-logger 5.0.12)', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/logger-app',
      name: 'logger-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '14.2.0', major: 14 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^14.2.0', installed: '14.2.0', type: 'dependencies' },
        { name: 'ngx-logger', declared: '^5.0.3', installed: '5.0.3', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '15.2.10' },
            versions: { '15.2.10': { version: '15.2.10' } },
            time: {
              '15.0.0': '2022-11-16T00:00:00.000Z',
              '16.0.0': '2023-05-03T00:00:00.000Z',
            },
          };
        }
        if (name === 'ngx-logger') {
          return {
            name: 'ngx-logger',
            distTags: { latest: '5.0.12' },
            versions: {
              '5.0.3': { version: '5.0.3', peerDependencies: { '@angular/core': '>6.0.0' } },
              '5.0.12': { version: '5.0.12', peerDependencies: { rxjs: '>6.0.0' }, releaseDate: '2023-04-13T14:29:38.404Z' },
            },
            time: {
              '5.0.3': '2021-11-08T18:42:10.271Z',
              '5.0.12': '2023-04-13T14:29:38.404Z',
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project,
      requirements: { major: 15, coreVersion: '15.2.10', notes: [] },
      registry,
      neverTouch: [],
    });

    const loggerChange = result.changes.find((c) => c.name === 'ngx-logger');
    expect(loggerChange?.target).toBe('5.0.12');
    expect(loggerChange?.evidence).toBe('unknown');
    expect(loggerChange?.reason).toContain('published on 2023-04-13 during the Angular 15 lifecycle');
  });
});

describe('Robustness: malformed peer range table-driven suite', () => {
  const malformedRanges: Array<[string, unknown]> = [
    ['pipe malformed', '7.x | 8.x'],
    ['empty string', ''],
    ['wildcard star', '*'],
    ['tag string latest', 'latest'],
    ['workspace protocol', 'workspace:*'],
    ['npm alias protocol', 'npm:other@1'],
    ['git url', 'git+https://example.com/x.git'],
    ['file path', 'file:../x'],
    ['unclosed operator', '>=1.0.0 <'],
    ['bare caret', '^'],
    ['huge 10,000-char string', 'a'.repeat(10_000)],
    ['raw number', 16],
    ['null value', null],
    ['object value', { range: '^16.0.0' }],
    ['array value', ['^16.0.0', '^17.0.0']],
  ];

  for (const [desc, val] of malformedRanges) {
    it(`never crashes on ${desc} (${typeof val === 'string' && val.length > 30 ? `${val.slice(0, 20)}...` : JSON.stringify(val)})`, async () => {
      expect(() => normalizeRange(val)).not.toThrow();
      expect(() => safeMinVersion(val)).not.toThrow();
      expect(() => satisfiesAngularPeer({ '@angular/core': val as unknown as string }, '16.2.12', 16)).not.toThrow();

      // Ensure full resolveStepDependencies does not crash when this range is encountered
      const project: ProjectInfo = {
        root: 'l:/fake/robust-app',
        name: 'robust-app',
        packageManager: { name: 'npm', source: 'default' },
        workspace: 'single',
        angularProjects: [],
        angular: { version: '15.2.10', major: 15 },
        style: 'ngmodule',
        dependencies: [
          { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
          { name: 'ngx-odd-pkg', declared: '^1.0.0', installed: '1.0.0', type: 'dependencies' },
        ],
        overrides: [],
        viewEngineSuspects: [],
        ngccScripts: [],
        hasNodeModules: false,
        hasNpmWorkspaces: false,
        warnings: [],
      };

      const registry = {
        async packument(name: string) {
          if (name === '@angular/core') {
            return {
              name: '@angular/core',
              distTags: { latest: '16.2.12' },
              versions: { '16.2.12': { version: '16.2.12' } },
            };
          }
          if (name === 'ngx-odd-pkg') {
            return {
              name: 'ngx-odd-pkg',
              distTags: { latest: '1.0.0' },
              versions: {
                '1.0.0': { version: '1.0.0', peerDependencies: { '@angular/core': val as unknown as string } },
              },
            };
          }
          return undefined;
        },
      } as unknown as RegistryClient;

      await expect(
        resolveStepDependencies({
          project,
          requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
          registry,
          neverTouch: [],
        }),
      ).resolves.toBeDefined();
    });
  }
});

describe('Manifest vs Lockfile Disagreement and View Engine Warnings', () => {
  it('detects manifest vs lockfile disagreement and warns in project reader and step runbook', async () => {
    const { dir, cleanup } = await tempProject({
      'package.json': JSON.stringify({
        name: 'material-app',
        dependencies: {
          '@angular/core': '^14.2.0',
        },
      }),
      'package-lock.json': JSON.stringify({
        name: 'material-app',
        lockfileVersion: 2,
        packages: {
          '': {
            dependencies: { '@angular/core': '^14.2.0' },
          },
          'node_modules/@angular/core': {
            version: '13.3.1',
          },
        },
        dependencies: {
          '@angular/core': {
            version: '13.3.1',
          },
        },
      }),
    });

    try {
      const project = await readProject(dir);
      expect(project.angular.major).toBe(13);
      expect(project.angular.version).toBe('13.3.1');
      expect(project.manifestLockfileDisagreement).toBeDefined();
      expect(project.manifestLockfileDisagreement?.declared).toBe('^14.2.0');
      expect(project.manifestLockfileDisagreement?.installed).toBe('13.3.1');
      expect(project.warnings.some((w) => w.includes('Manifest vs lockfile disagreement'))).toBe(true);

      const registry = {
        async packument(name: string) {
          if (name === '@angular/core') {
            return {
              name: '@angular/core',
              distTags: { latest: '14.3.0' },
              versions: { '14.3.0': { version: '14.3.0' } },
            };
          }
          return undefined;
        },
      } as unknown as RegistryClient;

      const plan = await createPlan({
        project,
        targetMajor: 14,
        registry,
        config: resolveConfig({}, undefined, { packageManager: 'npm' }),
        verifyResolution: false,
      });

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]?.from).toBe(13);
      expect(plan.steps[0]?.to).toBe(14);
      expect(plan.steps[0]?.manifestLockfileDisagreement).toBeDefined();

      const { formatStepDocument } = await import('../src/steps/writer.js');
      const doc = formatStepDocument(plan.steps[0]!, undefined, false);
      expect(doc).toContain('Manifest vs Lockfile Disagreement');
      expect(doc).toContain('package.json declares `@angular/core: "^14.2.0"`');
      expect(doc).toContain('lockfile installs `13.3.1`');
      expect(doc).toContain('View Engine/ngcc check NOT performed (node_modules missing)');
    } finally {
      await cleanup();
    }
  });

  it('detects View Engine library with __processed_by_ivy_ngcc__ or .metadata.json in node_modules', async () => {
    const { dir, cleanup } = await tempProject({
      'package.json': JSON.stringify({
        name: 'ivy-check-app',
        dependencies: {
          '@angular/core': '^15.2.0',
          'legacy-ve-lib': '^1.0.0',
        },
      }),
      'node_modules/@angular/core/package.json': JSON.stringify({
        name: '@angular/core',
        version: '15.2.10',
      }),
      'node_modules/legacy-ve-lib/package.json': JSON.stringify({
        name: 'legacy-ve-lib',
        version: '1.0.0',
        __processed_by_ivy_ngcc__: { core: '15.2.10' },
        peerDependencies: {
          '@angular/core': '^15.0.0',
        },
        typings: 'index.d.ts',
      }),
      'node_modules/legacy-ve-lib/index.d.ts': 'export declare class LegacyModule {}',
      'node_modules/legacy-ve-lib/index.metadata.json': '{"__symbolic":"module","version":4}',
    });

    try {
      const project = await readProject(dir);
      expect(project.hasNodeModules).toBe(true);
      expect(project.viewEngineSuspects).toContain('legacy-ve-lib');

      const registry = {
        async packument(name: string) {
          if (name === '@angular/core') {
            return {
              name: '@angular/core',
              distTags: { latest: '16.2.12' },
              versions: { '16.2.12': { version: '16.2.12' } },
            };
          }
          if (name === 'legacy-ve-lib') {
            return {
              name: 'legacy-ve-lib',
              distTags: { latest: '1.0.0' },
              versions: {
                '1.0.0': { version: '1.0.0', peerDependencies: { '@angular/core': '>=15.0.0' } },
              },
            };
          }
          return undefined;
        },
      } as unknown as RegistryClient;

      // When planning to Angular 16 (where ngcc was dropped), View Engine library must be a hard blocker!
      const result = await resolveStepDependencies({
        project,
        requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
        registry,
      });

      const veBlocker = result.blockers.find((b) => b.package === 'legacy-ve-lib');
      expect(veBlocker).toBeDefined();
      expect(veBlocker?.hard).toBe(true);
      expect(veBlocker?.reason).toBe('ivy-or-ngcc');
      expect(veBlocker?.details).toContain('compiled for View Engine and relies on ngcc, which was removed in Angular 16');
    } finally {
      await cleanup();
    }
  });

  it('handles View Engine outcomes for proposed releases (Ivy upgrade note, hard blocker, high-risk soft blocker, @angular/google-maps exclusion)', async () => {
    const { dir, cleanup } = await tempProject({
      'package.json': JSON.stringify({
        name: 've-outcomes-app',
        dependencies: {
          '@angular/core': '^15.2.10',
          '@angular/google-maps': '^12.2.0',
          'ngx-ivy-upgrade': '^4.0.0',
          'ng2-no-ivy': '^0.5.1',
          'ng2-old-unknown': '^1.2.9',
        },
      }),
      'node_modules/@angular/core/package.json': JSON.stringify({ name: '@angular/core', version: '15.2.10' }),
      'node_modules/@angular/google-maps/package.json': JSON.stringify({
        name: '@angular/google-maps',
        version: '12.2.13',
        metadata: 'google-maps.metadata.json',
        peerDependencies: { '@angular/core': '^12.0.0' },
      }),
      'node_modules/@angular/google-maps/index.metadata.json': '{}',
      'node_modules/ngx-ivy-upgrade/package.json': JSON.stringify({
        name: 'ngx-ivy-upgrade',
        version: '4.0.0',
        typings: 'index.d.ts',
        peerDependencies: { '@angular/core': '^12.0.0' },
      }),
      'node_modules/ngx-ivy-upgrade/index.d.ts': 'export declare class IvyUpgradeModule {}',
      'node_modules/ngx-ivy-upgrade/index.metadata.json': '{}',
      'node_modules/ng2-no-ivy/package.json': JSON.stringify({
        name: 'ng2-no-ivy',
        version: '0.5.1',
        typings: 'index.d.ts',
        peerDependencies: { '@angular/core': '>=6.0.0' },
      }),
      'node_modules/ng2-no-ivy/index.d.ts': 'export declare class NoIvyModule {}',
      'node_modules/ng2-no-ivy/index.metadata.json': '{}',
      'node_modules/ng2-old-unknown/package.json': JSON.stringify({
        name: 'ng2-old-unknown',
        version: '1.2.9',
        metadata: 'index.metadata.json',
        typings: 'index.d.ts',
        peerDependencies: { '@angular/core': '^10.0.4' },
      }),
      'node_modules/ng2-old-unknown/index.d.ts': 'export declare class OldUnknownModule {}',
      'node_modules/ng2-old-unknown/index.metadata.json': '{}',
    });

    try {
      const project = await readProject(dir);
      // Official @angular/* (including @angular/google-maps) must never be flagged in viewEngineSuspects
      expect(project.viewEngineSuspects).not.toContain('@angular/google-maps');
      expect(project.viewEngineSuspects).toEqual(['ng2-no-ivy', 'ng2-old-unknown', 'ngx-ivy-upgrade']);

      const registry = {
        async packument(name: string) {
          if (name === '@angular/core') {
            return {
              name: '@angular/core',
              distTags: { latest: '16.2.12' },
              versions: { '16.2.12': { version: '16.2.12' } },
              time: {
                '16.0.0': '2023-05-03T16:47:02.052Z',
                '17.0.0': '2023-11-08T12:25:24.973Z',
              },
            };
          }
          if (name === '@angular/google-maps') {
            return {
              name: '@angular/google-maps',
              distTags: { latest: '16.2.14' },
              versions: {
                '16.2.14': {
                  version: '16.2.14',
                  module: './fesm2022/google-maps.mjs',
                  peerDependencies: { '@angular/core': '^16.0.0 || ^17.0.0' },
                },
              },
              time: { '16.2.14': '2026-06-01T00:00:00.000Z' },
            };
          }
          if (name === 'ngx-ivy-upgrade') {
            return {
              name: 'ngx-ivy-upgrade',
              distTags: { latest: '16.1.0' },
              versions: {
                '4.0.0': { version: '4.0.0', peerDependencies: { '@angular/core': '^12.0.0' } },
                '16.1.0': {
                  version: '16.1.0',
                  fesm2020: 'fesm2020/ngx-ivy-upgrade.mjs',
                  exports: { '.': { esm2020: './esm2020/ngx-ivy-upgrade.mjs' } },
                  peerDependencies: { '@angular/core': '^16.0.0' },
                },
              },
              time: { '16.1.0': '2026-06-01T00:00:00.000Z' },
            };
          }
          if (name === 'ng2-no-ivy') {
            return {
              name: 'ng2-no-ivy',
              distTags: { latest: '0.5.1' },
              versions: {
                '0.5.1': {
                  version: '0.5.1',
                  main: 'dist/index.js',
                  typings: 'dist/index.d.ts',
                  peerDependencies: { '@angular/core': '>=6.0.0' },
                },
              },
              time: { '0.5.1': '2020-02-01T00:00:00.000Z' },
            };
          }
          if (name === 'ng2-old-unknown') {
            return {
              name: 'ng2-old-unknown',
              distTags: { latest: '1.3.7' },
              versions: {
                '1.3.7': {
                  version: '1.3.7',
                  fesm2020: 'fesm2020/ng2-old-unknown.mjs',
                  exports: { '.': { fesm2020: './fesm2020/ng2-old-unknown.mjs' } },
                  peerDependencies: { '@types/ckeditor': '^4.9.10' },
                },
              },
              time: { '1.3.7': '2022-08-13T00:00:00.000Z' },
            };
          }
          return undefined;
        },
      } as unknown as RegistryClient;

      const result = await resolveStepDependencies({
        project,
        requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
        registry,
        clock: () => new Date('2026-11-01T00:00:00.000Z'),
      });

      // Outcome 1: Ivy-era proposed release exists -> "must upgrade to X" note, no blocker
      expect(result.blockers.find((b) => b.package === 'ngx-ivy-upgrade')).toBeUndefined();
      const ivyNote = result.notes.find((n) => n.package === 'ngx-ivy-upgrade' && n.kind === 'ivy-upgrade');
      expect(ivyNote).toBeDefined();
      expect(ivyNote?.message).toContain('must upgrade to 16.1.0');

      // Outcome 2: No Ivy-era release -> hard blocker (ivy-or-ngcc)
      const hardVe = result.blockers.find((b) => b.package === 'ng2-no-ivy');
      expect(hardVe?.hard).toBe(true);
      expect(hardVe?.reason).toBe('ivy-or-ngcc');

      // Outcome 3: View Engine + unknown evidence + old publish date -> high-risk soft blocker
      const highRisk = result.blockers.find((b) => b.package === 'ng2-old-unknown');
      expect(highRisk).toBeDefined();
      expect(highRisk?.hard).toBe(false);
      expect(highRisk?.highRisk).toBe(true);
      expect(highRisk?.evidence).toBe('unknown');

      // Official @angular/google-maps is resolved via lockstep and never flagged
      expect(result.blockers.find((b) => b.package === '@angular/google-maps')).toBeUndefined();
      expect(isProposedVersionIvyEra('@angular/google-maps', '16.2.14', undefined, 16)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('gives major alignment (Signal b) precedence over Angular n+1 date cutoff (ngx-echarts 16.2.0) while enforcing date cutoff when no alignment exists, and ignores core packages', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/date-cutoff-app',
      name: 'date-cutoff-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '15.2.10', major: 15 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
        { name: 'rxjs', declared: '^7.5.0', installed: '7.5.7', type: 'dependencies' },
        { name: 'tslib', declared: '^2.3.0', installed: '2.4.1', type: 'dependencies' },
        { name: 'zone.js', declared: '~0.13.0', installed: '0.13.3', type: 'dependencies' },
        { name: 'ngx-echarts', declared: '^15.0.0', installed: '15.0.3', type: 'dependencies' },
        { name: 'ngx-dated-lib', declared: '^1.0.0', installed: '1.0.0', type: 'dependencies' },
        { name: 'ngx-future-only', declared: '^1.0.0', installed: '1.0.0', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '16.2.12' },
            versions: { '16.2.12': { version: '16.2.12' } },
            time: {
              '16.0.0': '2023-05-03T16:47:02.052Z',
              '17.0.0': '2023-11-08T12:25:24.973Z',
            },
          };
        }
        if (name === 'rxjs') {
          return { name: 'rxjs', distTags: { latest: '7.8.2' }, versions: { '7.8.2': { version: '7.8.2' } } };
        }
        if (name === 'tslib') {
          return { name: 'tslib', distTags: { latest: '2.8.1' }, versions: { '2.8.1': { version: '2.8.1' } } };
        }
        if (name === 'zone.js') {
          return { name: 'zone.js', distTags: { latest: '0.13.3' }, versions: { '0.13.3': { version: '0.13.3' } } };
        }
        if (name === 'ngx-echarts') {
          return {
            name: 'ngx-echarts',
            distTags: { latest: '22.0.0' },
            time: {
              '6.0.1': '2021-01-12T00:00:00.000Z',
              '16.1.1': '2023-10-12T10:21:55.349Z',
              '16.2.0': '2023-11-10T02:27:25.158Z',
              '22.0.0': '2026-07-01T00:00:00.000Z',
            },
            versions: {
              '6.0.1': { version: '6.0.1', peerDependencies: { '@angular/core': '>=10.0.0' } },
              '16.1.1': { version: '16.1.1', peerDependencies: { echarts: '^5.0.0', rxjs: '^6.0.0 || ^7.0.0' } },
              '16.2.0': { version: '16.2.0', peerDependencies: { echarts: '^5.0.0', rxjs: '^6.0.0 || ^7.0.0' } },
              '22.0.0': { version: '22.0.0', peerDependencies: { echarts: '^6.0.0' } },
            },
          };
        }
        if (name === 'ngx-dated-lib') {
          return {
            name: 'ngx-dated-lib',
            distTags: { latest: '1.3.0' },
            time: {
              '1.0.0': '2023-01-01T00:00:00.000Z',
              '1.2.0': '2023-09-01T00:00:00.000Z',
              '1.3.0': '2024-01-15T00:00:00.000Z',
            },
            versions: {
              '1.0.0': { version: '1.0.0', peerDependencies: {} },
              '1.2.0': { version: '1.2.0', peerDependencies: {} },
              '1.3.0': { version: '1.3.0', peerDependencies: {} },
            },
          };
        }
        if (name === 'ngx-future-only') {
          return {
            name: 'ngx-future-only',
            distTags: { latest: '2.0.0' },
            time: {
              '2.0.0': '2026-08-01T00:00:00.000Z',
            },
            versions: {
              '2.0.0': { version: '2.0.0', peerDependencies: {} },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const result = await resolveStepDependencies({
      project,
      requirements: { major: 16, coreVersion: '16.2.12', zone: '~0.13.0', rxjs: '^6.5.3 || ^7.4.0', notes: [] },
      registry,
      clock: () => new Date('2026-11-01T00:00:00.000Z'),
    });

    // Core/utility packages never produce blockers or unknown notes
    for (const corePkg of ['rxjs', 'tslib', 'zone.js']) {
      expect(result.blockers.find((b) => b.package === corePkg)).toBeUndefined();
      expect(result.notes.find((n) => n.package === corePkg)).toBeUndefined();
    }

    // Signal (b) precedence: ngx-echarts picks newest aligned major 16.2.0 even though published 2023-11-10 > Angular 17 (2023-11-08)
    // and is NOT marked unmaintained because newest 22.0.0 is from 2026
    const echartsChange = result.changes.find((c) => c.name === 'ngx-echarts');
    expect(echartsChange?.target).toBe('16.2.0');
    expect(echartsChange?.newestVersion).toBe('22.0.0');
    expect(echartsChange?.evidence).toBe('unknown');
    expect(echartsChange?.reason).toContain('> Angular 17 release 2023-11-08');
    expect(result.blockers.find((b) => b.package === 'ngx-echarts')).toBeUndefined();
    expect(result.notes.find((n) => n.package === 'ngx-echarts' && n.kind === 'verify-by-build')).toBeDefined();

    // Signal (c) date limit when no alignment exists: ngx-dated-lib picks 1.2.0 (<= 2023-11-08) over 1.3.0 (2024-01-15)
    const datedChange = result.changes.find((c) => c.name === 'ngx-dated-lib');
    expect(datedChange?.target).toBe('1.2.0');
    expect(datedChange?.newestVersion).toBe('1.3.0');
    expect(datedChange?.evidence).toBe('unknown');

    // ngx-future-only had no releases published <= Angular 17 release date -> unknown-low-confidence note
    const futureChange = result.changes.find((c) => c.name === 'ngx-future-only');
    expect(futureChange?.evidence).toBe('unknown-low-confidence');
    const futureNote = result.notes.find((n) => n.package === 'ngx-future-only');
    expect(futureNote?.evidence).toBe('unknown-low-confidence');
    expect(result.blockers.find((b) => b.package === 'ngx-future-only')).toBeUndefined();
  });

  it('parses deprecated message for named successor (@ngneat/transloco -> @jsverse/transloco) and provides nextSteps when no alternate is known', async () => {
    expect(
      parseDeprecatedSuccessor(
        'Package has been renamed and moved to @jsverse/transloco. Please use @jsverse/transloco instead.',
        '@ngneat/transloco',
      ),
    ).toBe('@jsverse/transloco');

    const mockReg = {
      async packument(name: string) {
        if (name === '@ngneat/transloco') {
          return {
            name: '@ngneat/transloco',
            distTags: { latest: '6.0.4' },
            versions: {
              '6.0.4': {
                version: '6.0.4',
                deprecated: 'This package has moved to @jsverse/transloco',
              },
            },
          };
        }
        if (name === 'obscure-legacy-pkg') {
          return {
            name: 'obscure-legacy-pkg',
            distTags: { latest: '1.0.0' },
            repository: { url: 'git+https://github.com/example/obscure-legacy-pkg.git' },
            versions: { '1.0.0': { version: '1.0.0' } },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const translocoRec = await computeRecommendation({
      projectRoot: 'l:/fake/nonexistent',
      blocker: {
        package: '@ngneat/transloco',
        reason: 'deprecated',
        hard: false,
        details: 'This package has moved to @jsverse/transloco',
      },
      targetMajor: 17,
      targetCoreVersion: '17.3.0',
      registry: mockReg,
      rules: [],
    });
    expect(translocoRec.recommendation).toBe('alternate');
    expect(translocoRec.confidence).toBe('medium');
    expect(translocoRec.recommendedFix).toContain('@jsverse/transloco');

    const manualRec = await computeRecommendation({
      projectRoot: 'l:/fake/nonexistent',
      blocker: {
        package: 'obscure-legacy-pkg',
        reason: 'no-compatible-version',
        hard: true,
        details: 'No release supports Angular 17.',
      },
      targetMajor: 17,
      targetCoreVersion: '17.3.0',
      registry: mockReg,
      rules: [],
    });
    expect(manualRec.recommendation).toBe('manual');
    expect(manualRec.nextSteps?.some((s) => s.includes('npm view obscure-legacy-pkg'))).toBe(true);
    expect(manualRec.nextSteps?.some((s) => s.includes('https://github.com/example/obscure-legacy-pkg'))).toBe(true);
    expect(manualRec.nextSteps?.some((s) => s.includes('README'))).toBe(true);
  });

  it('survives malformed packuments (missing time, malformed version keys, null version doc, missing versions object)', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/malformed-pack-app',
      name: 'malformed-pack-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '15.2.10', major: 15 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
        { name: 'ngx-broken-meta', declared: '^1.0.0', installed: '1.0.0', type: 'dependencies' },
        { name: 'ngx-no-versions', declared: '^1.0.0', installed: '1.0.0', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const brokenPack = {
      name: 'ngx-broken-meta',
      distTags: { latest: '1.0.0' },
      time: undefined,
      versions: {
        'not-a-semver': { version: 'not-a-semver' },
        '1.2.bad': null,
        '1.0.0': null,
        '2.0.0': { version: '2.0.0', peerDependencies: { '@angular/core': '^16.0.0' } },
      },
    } as unknown as Packument;

    const noVersionsPack = {
      name: 'ngx-no-versions',
      distTags: {},
      versions: undefined,
    } as unknown as Packument;

    expect(() => allVersionsDesc(brokenPack)).not.toThrow();
    expect(() => stableVersionsDesc(brokenPack)).not.toThrow();
    expect(() => allVersionsDesc(noVersionsPack)).not.toThrow();

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '16.2.12' },
            versions: { '16.2.12': { version: '16.2.12' } },
          };
        }
        if (name === 'ngx-broken-meta') return brokenPack;
        if (name === 'ngx-no-versions') return noVersionsPack;
        return undefined;
      },
    } as unknown as RegistryClient;

    const res = await resolveStepDependencies({
      project,
      requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
      registry,
    });
    expect(res.changes.find((c) => c.name === 'ngx-broken-meta')?.target).toBe('2.0.0');
    expect(res.unchanged).toContain('ngx-no-versions');
  });

  it('evaluates Signal (a) sibling alignment before the publish-date cutoff so post-release aligned siblings stay in lockstep', async () => {
    const project: ProjectInfo = {
      root: 'l:/fake/nebular-app',
      name: 'nebular-app',
      packageManager: { name: 'npm', source: 'default' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '15.2.10', major: 15 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
        { name: '@nebular/theme', declared: '^11.0.0', installed: '11.0.1', type: 'dependencies' },
        { name: '@nebular/eva-icons', declared: '^11.0.0', installed: '11.0.1', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === '@angular/core') {
          return {
            name: '@angular/core',
            distTags: { latest: '17.3.0' },
            time: {
              '16.0.0': '2023-05-03T18:54:51.000Z',
              '16.2.12': '2023-11-08T10:00:00.000Z',
              '17.0.0': '2023-11-08T12:25:24.973Z',
            },
            versions: {
              '16.2.12': { version: '16.2.12' },
              '17.0.0': { version: '17.0.0' },
            },
          };
        }
        if (name === '@nebular/theme') {
          return {
            name: '@nebular/theme',
            distTags: { latest: '12.0.0' },
            time: {
              '11.0.1': '2023-06-01T00:00:00.000Z',
              '12.0.0': '2023-11-09T13:29:25.633Z',
            },
            versions: {
              '11.0.1': {
                version: '11.0.1',
                peerDependencies: { '@angular/core': '^15.0.0' },
              },
              '12.0.0': {
                version: '12.0.0',
                peerDependencies: { '@angular/core': '^16.0.0' },
              },
            },
          };
        }
        if (name === '@nebular/eva-icons') {
          return {
            name: '@nebular/eva-icons',
            distTags: { latest: '12.0.0' },
            time: {
              '11.0.1': '2023-06-01T00:00:00.000Z',
              // Published 1 day AFTER Angular 17 (2023-11-08T12:25:24.973Z)
              '12.0.0': '2023-11-09T13:29:13.080Z',
            },
            versions: {
              '11.0.1': {
                version: '11.0.1',
                peerDependencies: { '@nebular/theme': '^11.0.0' },
              },
              '12.0.0': {
                version: '12.0.0',
                peerDependencies: { '@nebular/theme': '^12.0.0' },
              },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const res = await resolveStepDependencies({
      project,
      requirements: { major: 16, coreVersion: '16.2.12', notes: [] },
      registry,
      clock: () => new Date('2024-06-01T00:00:00.000Z'),
    });

    expect(res.changes.find((c) => c.name === '@nebular/theme')?.target).toBe('12.0.0');
    expect(res.changes.find((c) => c.name === '@nebular/eva-icons')?.target).toBe('12.0.0');
    expect(res.blockers.some((b) => b.package === '@nebular/eva-icons')).toBe(false);
    expect(res.notes.find((n) => n.package === '@nebular/eva-icons')?.evidence).toBe('unknown');
  });

  it('proposes companion direct-dependency upgrade from recorded npm ERESOLVE and clears hard blocker when re-check confirms', async () => {
    const eresolveRaw = await readFile(
      path.join(process.cwd(), 'test', 'fixtures', 'resolution', 'npm-eresolve-fixable-echarts.txt'),
      'utf8',
    );
    const parsedConflicts = parsePeerConflicts(eresolveRaw);
    expect(parsedConflicts).toEqual([
      {
        peer: 'echarts',
        range: '>=5.0.0',
        requiredBy: 'ngx-echarts@16.2.0',
        found: 'echarts@4.9.0',
      },
    ]);

    const project: ProjectInfo = {
      root: 'l:/fake/ngx-admin-echarts',
      name: 'ngx-admin',
      packageManager: { name: 'npm', source: 'lockfile' },
      workspace: 'single',
      angularProjects: [],
      angular: { version: '15.2.10', major: 15 },
      style: 'ngmodule',
      dependencies: [
        { name: '@angular/core', declared: '^15.2.10', installed: '15.2.10', type: 'dependencies' },
        { name: 'ngx-echarts', declared: '^15.0.3', installed: '15.0.3', type: 'dependencies' },
        { name: 'echarts', declared: '^4.9.0', installed: '4.9.0', type: 'dependencies' },
      ],
      overrides: [],
      viewEngineSuspects: [],
      ngccScripts: [],
      hasNodeModules: false,
      hasNpmWorkspaces: false,
      warnings: [],
    };

    const registry = {
      async packument(name: string) {
        if (name === 'echarts') {
          return {
            name: 'echarts',
            distTags: { latest: '6.1.0' },
            versions: {
              '4.9.0': { version: '4.9.0' },
              '5.5.1': { version: '5.5.1' },
              '5.6.0': { version: '5.6.0' },
              '6.0.0': { version: '6.0.0' },
              '6.1.0': { version: '6.1.0' },
            },
          };
        }
        return undefined;
      },
    } as unknown as RegistryClient;

    const initialChanges = [
      {
        name: 'ngx-echarts',
        type: 'dependencies' as const,
        current: '15.0.3',
        currentSpec: '^15.0.3',
        target: '16.2.0',
        targetSpec: '^16.2.0',
        reason: 'Aligned major',
        evidence: 'unknown' as const,
      },
    ];

    const recheckCalls: Array<{ names: string[] }> = [];
    const fixed = await resolveFixablePeerConflicts({
      project,
      registry,
      packageManager: 'npm',
      changes: initialChanges,
      resolutionCheck: {
        status: 'conflict',
        packageManager: 'npm',
        detail: eresolveRaw,
        conflicts: parsedConflicts,
      },
      verifyFn: async (opts) => {
        recheckCalls.push({ names: opts.changes.map((c) => `${c.name}@${c.target}`) });
        const hasEcharts5 = opts.changes.some((c) => c.name === 'echarts' && c.target === '5.6.0');
        return {
          status: hasEcharts5 ? 'confirmed' : 'conflict',
          packageManager: 'npm',
        };
      },
    });

    expect(recheckCalls).toHaveLength(1);
    expect(recheckCalls[0]?.names).toContain('echarts@5.6.0');
    expect(fixed.resolutionCheck.status).toBe('confirmed');
    expect(fixed.changes.find((c) => c.name === 'echarts')).toMatchObject({
      target: '5.6.0',
      targetSpec: '^5.6.0',
    });
    expect(fixed.companionNotes[0]?.kind).toBe('companion-upgrade');
    expect(fixed.companionNotes[0]?.message).toContain('also upgrade echarts to 5.6.0');
    expect(fixed.companionNotes[0]?.message).toContain('risk: breaking changes between 4 and 5, check usage');
    expect(fixed.companionRisks[0]).toContain('risk: breaking changes between 4 and 5, check usage');

    const blockers: import('../src/model.js').Blocker[] = [];
    enrichBlockersWithResolutionCheck(blockers, fixed.resolutionCheck, project, 16, 'npm');
    expect(blockers.filter((b) => b.reason === 'peer-conflict')).toHaveLength(0);

    // When the re-check STILL fails on echarts, revert companion proposal and keep the hard blocker
    const stillFails = await resolveFixablePeerConflicts({
      project,
      registry,
      packageManager: 'npm',
      changes: initialChanges,
      resolutionCheck: {
        status: 'conflict',
        packageManager: 'npm',
        detail: eresolveRaw,
        conflicts: parsedConflicts,
      },
      verifyFn: async () => ({
        status: 'conflict',
        packageManager: 'npm',
        conflicts: [
          {
            peer: 'echarts',
            range: '^4.0.0',
            requiredBy: 'echarts-for-react@2.0.16',
            found: 'echarts@5.6.0',
          },
        ],
      }),
    });

    expect(stillFails.resolutionCheck.status).toBe('conflict');
    expect(stillFails.changes.find((c) => c.name === 'echarts')).toBeUndefined();
    expect(stillFails.companionNotes).toHaveLength(0);
    const failBlockers: import('../src/model.js').Blocker[] = [];
    enrichBlockersWithResolutionCheck(failBlockers, stillFails.resolutionCheck, project, 16, 'npm');
    expect(failBlockers.some((b) => b.package === 'ngx-echarts' && b.reason === 'peer-conflict' && b.hard)).toBe(true);
  });

  it('ignores satisfied Found: tree lines in npm ERESOLVE and discovers all 3 independent conflicts in one pass', async () => {
    const fixtureRaw = await readFile(
      path.join(process.cwd(), 'test/fixtures/resolution/npm-multi-conflict-discovery.json'),
      'utf8',
    );
    const fixture = JSON.parse(fixtureRaw) as {
      eresolveStderr: string;
      npmLsJson: unknown;
      lockfileJson: unknown;
    };

    // 1. parsePeerConflicts must skip @angular/cdk and @nebular/theme inside the Found: tree
    const initialParsed = parsePeerConflicts(fixture.eresolveStderr);
    expect(initialParsed).toEqual([
      {
        peer: '@angular/common',
        range: '^10.0.0',
        requiredBy: 'ng2-smart-table@1.7.2',
        found: '@angular/common@16.2.12',
      },
    ]);

    // 2. parseNpmLsConflicts discovers all 3 conflicts from --legacy-peer-deps + npm ls
    const lsConflicts = parseNpmLsConflicts(fixture.npmLsJson, fixture.lockfileJson);
    expect(lsConflicts).toHaveLength(3);
    expect(lsConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peer: 'echarts', range: '>=5.0.0', requiredBy: 'ngx-echarts@16.2.0', found: 'echarts@4.9.0' }),
        expect.objectContaining({ peer: '@angular/common', range: '^10.0.0', requiredBy: 'ng2-smart-table@1.7.2', found: '@angular/common@16.2.12' }),
        expect.objectContaining({ peer: '@angular/cdk', range: '^14.0.0', requiredBy: 'ngx-legacy-grid@2.0.0', found: '@angular/cdk@16.2.14' }),
      ]),
    );

    // 3. End-to-end verifyWithPackageManager -> resolveFixablePeerConflicts -> enrichBlockersWithResolutionCheck
    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'multi-conflict-app',
          dependencies: {
            '@angular/common': '^16.2.12',
            '@angular/cdk': '^16.2.14',
            '@nebular/theme': '12.0.0',
            echarts: '^4.9.0',
            'ngx-echarts': '^16.2.0',
            'ng2-smart-table': '^1.6.0',
            'ngx-legacy-grid': '^2.0.0',
          },
        }),
      );

      let installStep = 0;
      const runMock: typeof proc.run = async (cmd, args, opts) => {
        const joined = `${cmd} ${args.join(' ')}`;
        if (args[0] === 'install' && args.includes('--dry-run')) {
          installStep++;
          return {
            command: joined,
            exitCode: 1,
            stdout: '',
            stderr: fixture.eresolveStderr,
            timedOut: false,
            failed: true,
          };
        }
        if (args[0] === 'install' && args.includes('--legacy-peer-deps')) {
          await writeFile(path.join(opts!.cwd!, 'package-lock.json'), JSON.stringify(fixture.lockfileJson));
          return { command: joined, exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false };
        }
        if (args[0] === 'ls') {
          const problems =
            installStep === 1
              ? (fixture.npmLsJson as { problems: string[] }).problems
              : [
                  'invalid: @angular/common@16.2.12 /tmp/ngm/node_modules/@angular/common',
                  'invalid: @angular/cdk@16.2.14 /tmp/ngm/node_modules/@angular/cdk',
                ];
          return {
            command: joined,
            exitCode: 1,
            stdout: JSON.stringify({ name: 'multi-conflict-app', problems }),
            stderr: '',
            timedOut: false,
            failed: true,
          };
        }
        return { command: joined, exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false };
      };

      const initialCheck = await verifyWithPackageManager({
        projectRoot: dir,
        packageManager: 'npm',
        changes: [],
        compareBaseline: false,
        runFn: runMock,
      });
      expect(initialCheck.status).toBe('conflict');
      expect(initialCheck.conflicts).toHaveLength(3);

      const registry = {
        async packument(name: string): Promise<Packument | null> {
          if (name === 'echarts') {
            return {
              name: 'echarts',
              distTags: { latest: '5.6.0' },
              versions: { '4.9.0': { version: '4.9.0' }, '5.6.0': { version: '5.6.0' } },
              time: { '4.9.0': '2020-08-26T00:00:00.000Z', '5.6.0': '2024-12-20T00:00:00.000Z' },
            };
          }
          return null;
        },
      } as unknown as RegistryClient;

      const project: ProjectInfo = {
        root: dir,
        packageManager: { name: 'npm', source: 'default' },
        angular: { version: '16.2.12', major: 16, source: 'lockfile' },
        dependencies: [
          { name: 'echarts', declared: '^4.9.0', installed: '4.9.0', type: 'dependencies' },
          { name: 'ngx-echarts', declared: '^16.2.0', installed: '16.2.0', type: 'dependencies' },
          { name: 'ng2-smart-table', declared: '^1.6.0', installed: '1.7.2', type: 'dependencies' },
          { name: 'ngx-legacy-grid', declared: '^2.0.0', installed: '2.0.0', type: 'dependencies' },
        ],
        ngccScripts: [],
      } as unknown as ProjectInfo;

      const resolved = await resolveFixablePeerConflicts({
        project,
        registry,
        packageManager: 'npm',
        changes: [],
        resolutionCheck: initialCheck,
        maxIterations: 2,
        verifyFn: (opts) => verifyWithPackageManager({ ...opts, compareBaseline: false, runFn: runMock }),
      });

      // Fixable companion upgrade (echarts -> 5.6.0) is retained, while the 2 unfixable conflicts remain
      expect(resolved.changes.find((c) => c.name === 'echarts')?.target).toBe('5.6.0');
      expect(resolved.companionNotes).toHaveLength(1);
      expect(resolved.resolutionCheck.conflicts).toHaveLength(2);

      const blockers: import('../src/model.js').Blocker[] = [];
      enrichBlockersWithResolutionCheck(blockers, resolved.resolutionCheck, project, 16, 'npm');
      expect(blockers.map((b) => b.package).sort()).toEqual(['ng2-smart-table', 'ngx-legacy-grid']);
      const smartTableBlocker = blockers.find((b) => b.package === 'ng2-smart-table')!;
      const gridBlocker = blockers.find((b) => b.package === 'ngx-legacy-grid')!;
      expect(smartTableBlocker.details).toContain('Conflict origin: third-party peer requirement from ng2-smart-table@1.7.2 (@angular/common@"^10.0.0")');
      expect(gridBlocker.details).toContain('Conflict origin: third-party peer requirement from ngx-legacy-grid@2.0.0 (@angular/cdk@"^14.0.0")');
    } finally {
      await cleanup();
    }
  });

  it('refuses companion downgrades when satisfying release is lower than installed version, tags dev-only companions, and records npm version', async () => {
    const fixtureRaw = await readFile(
      path.join(process.cwd(), 'test/fixtures/resolution/npm-ls-11-17-0-shapes.json'),
      'utf8',
    );
    const fixture = JSON.parse(fixtureRaw) as {
      npmVersion: string;
      lsOutput: unknown;
      lockfileJson: unknown;
    };

    const conflicts = parseNpmLsConflicts(fixture.lsOutput, fixture.lockfileJson);
    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peer: 'echarts', range: '^4.0.0', requiredBy: 'ngx-legacy-charts@4.0.0', found: 'echarts@5.0.0' }),
        expect.objectContaining({ peer: '@types/ckeditor', range: '^4.9.10', requiredBy: 'ng2-ckeditor@1.3.7' }),
      ]),
    );

    const { dir, cleanup } = await tempProject();
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'companion-no-downgrade-app',
          dependencies: { echarts: '^5.0.0', 'ngx-legacy-charts': '^4.0.0', 'ng2-ckeditor': '~1.3.7' },
          devDependencies: { 'jasmine-core': '~3.6.0' },
        }),
      );

      const runMock: typeof proc.run = async (cmd, args) => {
        const joined = `${cmd} ${args.join(' ')}`;
        if (args[0] === '--version') {
          return { command: joined, exitCode: 0, stdout: `${fixture.npmVersion}\n`, stderr: '', timedOut: false, failed: false };
        }
        return {
          command: joined,
          exitCode: 1,
          stdout: '',
          stderr: 'npm error Could not resolve dependency:\nnpm error peer echarts@"^4.0.0" from ngx-legacy-charts@4.0.0\nnpm error Found: echarts@5.0.0',
          timedOut: false,
          failed: true,
        };
      };

      const check = await verifyWithPackageManager({
        projectRoot: dir,
        packageManager: 'npm',
        changes: [],
        discoverConflicts: false,
        runFn: runMock,
      });
      expect(check.packageManagerVersion).toBe(fixture.npmVersion);

      const registry = {
        async packument(name: string): Promise<Packument | null> {
          if (name === 'echarts') {
            return {
              name: 'echarts',
              distTags: { latest: '5.6.0' },
              versions: { '4.9.0': { version: '4.9.0' }, '5.0.0': { version: '5.0.0' }, '5.6.0': { version: '5.6.0' } },
              time: {},
            };
          }
          if (name === 'jasmine-core') {
            return {
              name: 'jasmine-core',
              distTags: { latest: '5.1.0' },
              versions: { '3.6.0': { version: '3.6.0' }, '3.99.1': { version: '3.99.1' } },
              time: {},
            };
          }
          return null;
        },
      } as unknown as RegistryClient;

      const project = {
        root: dir,
        packageManager: { name: 'npm', source: 'default' },
        angular: { version: '16.2.12', major: 16, source: 'lockfile' },
        dependencies: [
          { name: 'echarts', declared: '^5.0.0', installed: '5.0.0', type: 'dependencies' },
          { name: 'ngx-legacy-charts', declared: '^4.0.0', installed: '4.0.0', type: 'dependencies' },
          { name: 'jasmine-core', declared: '~3.6.0', installed: '3.6.0', type: 'devDependencies' },
        ],
        ngccScripts: [],
      } as unknown as ProjectInfo;

      // Installed echarts is 5.0.0, satisfying release is 4.9.0 (< 5.0.0) -> must NOT propose downgrade; report blocker instead
      const noDowngrade = await resolveFixablePeerConflicts({
        project,
        registry,
        packageManager: 'npm',
        changes: [],
        resolutionCheck: check,
      });
      expect(noDowngrade.changes).toHaveLength(0);
      expect(noDowngrade.companionNotes).toHaveLength(0);
      const blockers: import('../src/model.js').Blocker[] = [];
      enrichBlockersWithResolutionCheck(blockers, noDowngrade.resolutionCheck, project, 16, 'npm');
      expect(blockers.some((b) => b.package === 'ngx-legacy-charts' && b.reason === 'peer-conflict' && b.hard)).toBe(true);

      // Dev-only companion upgrade (jasmine-core 3.6.0 -> 3.99.1) gets dependencyKind: 'dev-only'
      const devCompanion = await resolveFixablePeerConflicts({
        project,
        registry,
        packageManager: 'npm',
        changes: [],
        resolutionCheck: {
          status: 'conflict',
          packageManager: 'npm',
          packageManagerVersion: fixture.npmVersion,
          conflicts: [{ peer: 'jasmine-core', range: '>=3.8', requiredBy: 'karma-jasmine-html-reporter@1.7.0', found: 'jasmine-core@3.6.0' }],
        },
        verifyFn: async () => ({ status: 'confirmed', packageManager: 'npm', packageManagerVersion: fixture.npmVersion }),
      });
      expect(devCompanion.companionNotes[0]?.dependencyKind).toBe('dev-only');
    } finally {
      await cleanup();
    }
  });

  it('parses constructed npm 10.x ls --json without problems array, classifies baseline vs introduced conflicts, and groups blockers per package', async () => {
    const constructedRaw = await readFile(
      path.join(process.cwd(), 'test/fixtures/resolution/npm-ls-10-x-constructed.json'),
      'utf8',
    );
    const constructed = JSON.parse(constructedRaw) as { lsOutput: unknown };
    const ls10Conflicts = parseNpmLsConflicts(constructed.lsOutput);
    expect(ls10Conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ peer: '@angular/core', range: '^14.0.0', found: '@angular/core@16.2.12' }),
        expect.objectContaining({ peer: 'jquery', range: '1.9.1 - 3', requiredBy: 'bootstrap@4.3.1' }),
        expect.objectContaining({ peer: 'popper.js', range: '*', requiredBy: 'bootstrap@4.3.1' }),
      ]),
    );
    expect(parseNpmLsConflicts(null)).toEqual([]);
    expect(parseNpmLsConflicts({ problems: [123, 'unrecognized line'] })).toEqual([]);

    const baseline = [
      { peer: 'jquery', range: '1.9.1 - 3', requiredBy: 'bootstrap@4.3.1' },
      { peer: 'rxjs', range: '^6.0.0', requiredBy: 'old-pkg@1.0.0', found: 'rxjs@7.0.0' },
    ];
    const proposed = [
      { peer: 'jquery', range: '1.9.1 - 3', requiredBy: 'bootstrap@4.3.1' },
      { peer: '@types/ckeditor', range: '^4.9.10', requiredBy: 'ng2-ckeditor@1.3.7' },
    ];
    const classified = classifyBaselineVsProposedConflicts(baseline, proposed);
    expect(classified.introduced).toEqual([
      { peer: '@types/ckeditor', range: '^4.9.10', requiredBy: 'ng2-ckeditor@1.3.7' },
    ]);
    expect(classified.preExisting).toEqual([
      { peer: 'jquery', range: '1.9.1 - 3', requiredBy: 'bootstrap@4.3.1' },
    ]);
    expect(classified.resolved).toEqual([
      { peer: 'rxjs', range: '^6.0.0', requiredBy: 'old-pkg@1.0.0', found: 'rxjs@7.0.0' },
    ]);

    const baseNotes = baselineNotesForResolutionCheck({
      status: 'conflict',
      preExistingConflicts: classified.preExisting,
      resolvedConflicts: classified.resolved,
    });
    expect(baseNotes.find((n) => n.kind === 'pre-existing-conflict')?.message).toContain(
      'already present at the current versions; not caused by this step',
    );
    expect(baseNotes.find((n) => n.kind === 'resolved-conflict')?.package).toBe('old-pkg');

    const grouped = groupBlockersByPackage([
      { package: 'codelyzer', reason: 'no-compatible-version', hard: true, details: 'No compatible release.' },
      { package: 'codelyzer', reason: 'peer-conflict', hard: true, details: 'Peer conflict on @angular/core.' },
      { package: 'ng2-ckeditor', reason: 'ivy-or-ngcc', hard: false, highRisk: true, details: 'Old Ivy release.' },
      { package: 'ng2-ckeditor', reason: 'peer-conflict', hard: true, details: 'Missing @types/ckeditor.' },
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({
      package: 'codelyzer',
      reasons: ['no-compatible-version', 'peer-conflict'],
      hard: true,
    });
    expect(grouped[1]).toMatchObject({
      package: 'ng2-ckeditor',
      reasons: ['ivy-or-ngcc', 'peer-conflict'],
      hard: true,
      highRisk: true,
    });
  });
});

