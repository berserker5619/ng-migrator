import { describe, expect, it } from 'vitest';
import type { ProjectInfo, StepRequirements } from '../src/model.js';
import type { Packument, RegistryClient } from '../src/registry/client.js';
import { preserveRangeStyle, satisfiesAngularPeer } from '../src/resolver/range.js';
import { resolveStepDependencies } from '../src/resolver/resolve.js';
import { parseNpmEresolve } from '../src/resolver/verify.js';

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
    });
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
