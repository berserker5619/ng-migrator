import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Packument, RegistryClient } from '../src/registry/client.js';
import { createPlan } from '../src/planner/plan.js';
import { readProject } from '../src/reader/project.js';
import { resolveConfig } from '../src/config/config.js';
import { generateDecisionId } from '../src/steps/writer.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('synthetic corpus fixtures', () => {
  function makeMockRegistry(customPacks: Record<string, Packument> = {}): RegistryClient {
    const packs: Record<string, Packument> = {
      '@angular/core': {
        name: '@angular/core',
        distTags: { latest: '16.2.12' },
        versions: {
          '14.2.12': { version: '14.2.12', engines: { node: '>=14.15' } },
          '15.2.10': { version: '15.2.10', engines: { node: '>=14.20' } },
          '16.2.12': {
            version: '16.2.12',
            engines: { node: '^16.14.0 || >=18.10.0' },
            peerDependencies: { rxjs: '^7.4.0', 'zone.js': '~0.13.0' },
          },
        },
      },
      '@angular/compiler-cli': {
        name: '@angular/compiler-cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '15.2.10': { version: '15.2.10', peerDependencies: { typescript: '>=4.8.2 <5.0' } },
          '16.2.12': { version: '16.2.12', peerDependencies: { typescript: '>=4.9.3 <5.2.0' } },
        },
      },
      '@angular/cli': {
        name: '@angular/cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '15.2.10': { version: '15.2.10', engines: { node: '>=14.20' } },
          '16.2.12': { version: '16.2.12', engines: { node: '^16.14.0 || >=18.10.0' } },
        },
      },
      ...customPacks,
    };

    return {
      packument: async (name: string) => packs[name],
    } as unknown as RegistryClient;
  }

  it('Synthetic Fixture (a): deprecated package with only prerelease versions and open-ended peers (@angular/flex-layout)', async () => {
    // Read the recorded offline fixture for @angular/flex-layout
    const fixturePath = path.resolve(__dirname, 'fixtures', 'registry', '%40angular%2Fflex-layout.json');
    const fixtureRaw = JSON.parse(await readFile(fixturePath, 'utf8')) as { packument: Packument };
    const flexPackument = fixtureRaw.packument;

    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-flex-layout',
        dependencies: {
          '@angular/core': '^14.2.0',
          '@angular/flex-layout': '^14.0.0-beta.40',
        },
      }),
    );

    const mockRegistry = makeMockRegistry({
      '@angular/flex-layout': flexPackument,
    });

    const project = await readProject(dir);
    const config = resolveConfig({}, {}, { packageManager: 'npm' });

    // Plan across 14 -> 15 -> 16
    const plan = await createPlan({
      project,
      targetMajor: 16,
      registry: mockRegistry,
      config,
      verifyResolution: false,
    });

    expect(plan.steps).toHaveLength(2);

    // Step 1: Angular 14 -> 15
    const step1 = plan.steps[0]!;
    expect(step1.from).toBe(14);
    expect(step1.to).toBe(15);

    const flexChange = step1.changes.find((c) => c.name === '@angular/flex-layout');
    expect(flexChange).toBeDefined();
    expect(flexChange?.target).toBe('15.0.0-beta.42');
    expect(flexChange?.evidence).toBe('declared');
    expect(flexChange?.unmaintained).toBe(true);
    expect(flexChange?.deprecated).toBeDefined();

    // In step 14 -> 15, it must NOT be a hard blocker!
    const softBlocker = step1.blockers.find((b) => b.package === '@angular/flex-layout');
    expect(softBlocker).toBeDefined();
    expect(softBlocker?.reason).toBe('deprecated');
    expect(softBlocker?.hard).toBe(false);

    // Step 2: Angular 15 -> 16: Flex-layout had no release past 15 (lastReleaseFor: 15)
    const step2 = plan.steps[1]!;
    expect(step2.from).toBe(15);
    expect(step2.to).toBe(16);
    const hardBlocker = step2.blockers.find((b) => b.package === '@angular/flex-layout');
    expect(hardBlocker).toBeDefined();
    expect(hardBlocker?.reason).toBe('no-compatible-version');
    expect(hardBlocker?.hard).toBe(true);
  });

  it('Synthetic Fixture (b): scoped package name resolution and stable decision IDs', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-scoped-package',
        dependencies: {
          '@angular/core': '15.2.0',
          '@my-org/ui-tokens': '1.0.0',
        },
      }),
    );

    const mockRegistry = makeMockRegistry({
      '@my-org/ui-tokens': {
        name: '@my-org/ui-tokens',
        distTags: { latest: '1.0.0' },
        versions: {
          '1.0.0': { version: '1.0.0', peerDependencies: { '@angular/core': '^14.0.0' } },
        },
      },
    });

    const project = await readProject(dir);
    const config = resolveConfig({}, {}, { packageManager: 'npm' });
    const plan = await createPlan({
      project,
      targetMajor: 16,
      registry: mockRegistry,
      config,
      verifyResolution: false,
    });

    const step1 = plan.steps[0]!;
    const blocker = step1.blockers.find((b) => b.package === '@my-org/ui-tokens');
    expect(blocker).toBeDefined();
    expect(blocker?.package).toBe('@my-org/ui-tokens');

    const decisionId = generateDecisionId(blocker!.package);
    expect(decisionId).toMatch(/^blocker-my-org-ui-tokens-[a-f0-9]{8}$/);
  });

  it('Synthetic Fixture (c): a package whose newest release needs n+1 and is held back', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-held-back',
        dependencies: {
          '@angular/core': '15.2.0',
          'fast-table': '1.0.0',
        },
      }),
    );

    const mockRegistry = makeMockRegistry({
      'fast-table': {
        name: 'fast-table',
        distTags: { latest: '3.0.0' },
        versions: {
          '3.0.0': { version: '3.0.0', peerDependencies: { '@angular/core': '^17.0.0' } }, // requires 17 (held back)
          '2.0.0': { version: '2.0.0', peerDependencies: { '@angular/core': '^16.0.0' } }, // target for step 16!
          '1.0.0': { version: '1.0.0', peerDependencies: { '@angular/core': '^15.0.0' } },
        },
      },
    });

    const project = await readProject(dir);
    const config = resolveConfig({}, {}, { packageManager: 'npm' });
    const plan = await createPlan({
      project,
      targetMajor: 16,
      registry: mockRegistry,
      config,
      verifyResolution: false,
    });

    const step1 = plan.steps[0]!;
    expect(step1.heldBack.some((h) => h.name === 'fast-table' && h.version === '3.0.0')).toBe(true);

    const change = step1.changes.find((c) => c.name === 'fast-table');
    expect(change?.target).toBe('2.0.0');
  });

  it('Synthetic Fixture (d): an abandoned View Engine-era package that breaks at the Angular 16 step', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-view-engine',
        dependencies: {
          '@angular/core': '15.2.0',
          'legacy-ve-grid': '2.0.0',
        },
      }),
    );

    // Emulate View Engine node_modules structure with __processed_by_ivy_ngcc__
    const veDir = path.join(dir, 'node_modules', 'legacy-ve-grid');
    await mkdir(veDir, { recursive: true });
    await writeFile(
      path.join(veDir, 'package.json'),
      JSON.stringify({
        name: 'legacy-ve-grid',
        version: '2.0.0',
        typings: 'index.d.ts',
        peerDependencies: { '@angular/core': '^15.0.0' },
        __processed_by_ivy_ngcc__: {},
      }),
    );
    await writeFile(path.join(veDir, 'index.d.ts'), '');

    const project = await readProject(dir);
    expect(project.viewEngineSuspects).toContain('legacy-ve-grid');

    const mockRegistry = makeMockRegistry();
    const config = resolveConfig({}, {}, { packageManager: 'npm' });
    const plan = await createPlan({
      project,
      targetMajor: 16,
      registry: mockRegistry,
      config,
      verifyResolution: false,
    });

    const step1 = plan.steps[0]!;
    const ngccBlocker = step1.blockers.find((b) => b.package === 'legacy-ve-grid');
    expect(ngccBlocker).toBeDefined();
    expect(ngccBlocker?.reason).toBe('ivy-or-ngcc');
    expect(ngccBlocker?.hard).toBe(true);
  });
});
