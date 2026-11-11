import { writeFile } from 'node:fs/promises';
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
import { parseNpmEresolve, verifyWithPackageManager } from '../src/resolver/verify.js';
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
});
