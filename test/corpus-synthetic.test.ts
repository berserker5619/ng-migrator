import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Packument, RegistryClient } from '../src/registry/client.js';
import { createPlan } from '../src/planner/plan.js';
import { readProject } from '../src/reader/project.js';
import { resolveConfig } from '../src/config/config.js';
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
          '16.2.12': { version: '16.2.12', peerDependencies: { typescript: '>=4.9.3 <5.2.0' } },
        },
      },
      '@angular/cli': {
        name: '@angular/cli',
        distTags: { latest: '16.2.12' },
        versions: {
          '16.2.12': { version: '16.2.12', engines: { node: '^16.14.0 || >=18.10.0' } },
        },
      },
      ...customPacks,
    };

    return {
      packument: async (name: string) => packs[name],
    } as unknown as RegistryClient;
  }

  it('Fixture 1: detects abandoned package with no compatible release', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-abandoned',
        dependencies: {
          '@angular/core': '15.2.0',
          'abandoned-chart-lib': '1.0.0',
        },
      }),
    );

    const mockRegistry = makeMockRegistry({
      'abandoned-chart-lib': {
        name: 'abandoned-chart-lib',
        distTags: { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            version: '1.0.0',
            peerDependencies: { '@angular/core': '^14.0.0 || ^15.0.0' },
          },
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
    const blocker = step1.blockers.find((b) => b.package === 'abandoned-chart-lib');
    expect(blocker).toBeDefined();
    expect(blocker?.reason).toBe('no-compatible-version');
    expect(blocker?.lastCompatible).toBe('1.0.0');
  });

  it('Fixture 2: flags View Engine library relying on ngcc when upgrading to Angular 16', async () => {
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

    // Emulate View Engine node_modules structure
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

  it('Fixture 3: isolates held-back packages requiring Angular n+1', async () => {
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

  it('Fixture 4: recommends inlining for small tooltip library with CDK present', async () => {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-inline-tooltip',
        dependencies: {
          '@angular/core': '15.2.0',
          '@angular/cdk': '15.2.0',
          'tiny-tooltip': '0.5.0',
        },
      }),
    );

    await writeFile(
      path.join(dir, 'src', 'app.component.ts'),
      `
        import { Component } from '@angular/core';
        import { TinyTooltipDirective } from 'tiny-tooltip';

        @Component({
          selector: 'app-root',
          template: '<span tinyTooltip="info">Hover</span>'
        })
        export class AppComponent {
          dir = TinyTooltipDirective;
        }
      `,
    );

    const mockRegistry = makeMockRegistry({
      '@angular/cdk': {
        name: '@angular/cdk',
        distTags: { latest: '16.2.12' },
        versions: { '16.2.12': { version: '16.2.12' } },
      },
      'tiny-tooltip': {
        name: 'tiny-tooltip',
        distTags: { latest: '0.5.0' },
        versions: {
          '0.5.0': {
            version: '0.5.0',
            peerDependencies: { '@angular/core': '^15.0.0' },
          },
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
    const tooltipBlocker = step1.blockers.find((b) => b.package === 'tiny-tooltip');
    expect(tooltipBlocker?.recommendation).toBe('inline');
    expect(tooltipBlocker?.confidence).toBe('high');
    expect(tooltipBlocker?.effort).toContain('hours');
  });
});
