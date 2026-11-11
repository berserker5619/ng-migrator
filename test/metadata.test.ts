import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStepRequirements } from '../src/planner/metadata.js';
import { RegistryClient, type FetchLike } from '../src/registry/client.js';
import { DEFAULT_REGISTRY } from '../src/registry/npmrc.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('metadata requirements', () => {
  it('throws NGM-3008 if major is older than oldestSupportedMajor (12)', async () => {
    const client = new RegistryClient({
      npmrc: { registry: DEFAULT_REGISTRY, scopes: {}, auth: {} },
      cacheDir: path.join(dir, 'cache'),
    });
    await expect(getStepRequirements(11, client)).rejects.toMatchObject({ id: 'NGM-3008' });
  });

  it('derives requirements from core, compiler-cli, and exceptions for a major', async () => {
    const fetch: FetchLike = async (url) => {
      if (url.includes('@angular%2Fcore')) {
        return {
          status: 200,
          json: async () => ({
            name: '@angular/core',
            'dist-tags': { latest: '16.2.12' },
            versions: {
              '16.2.12': {
                version: '16.2.12',
                engines: { node: '^16.14.0 || >=18.10.0' },
                peerDependencies: {
                  rxjs: '^6.5.3 || ^7.4.0',
                  'zone.js': '~0.13.0',
                },
              },
            },
          }),
        };
      }
      if (url.includes('@angular%2Fcompiler-cli')) {
        return {
          status: 200,
          json: async () => ({
            name: '@angular/compiler-cli',
            versions: {
              '16.2.12': {
                version: '16.2.12',
                peerDependencies: { typescript: '>=4.9.3 <5.2.0' },
              },
            },
          }),
        };
      }
      if (url.includes('@angular%2Fcli')) {
        return {
          status: 200,
          json: async () => ({
            name: '@angular/cli',
            versions: {
              '16.2.12': {
                version: '16.2.12',
                engines: { node: '^16.14.0 || >=18.10.0' },
              },
            },
          }),
        };
      }
      return { status: 404, json: async () => ({}) };
    };

    const client = new RegistryClient({
      npmrc: { registry: DEFAULT_REGISTRY, scopes: {}, auth: {} },
      cacheDir: path.join(dir, 'cache'),
      fetch,
    });

    const reqs = await getStepRequirements(16, client);
    expect(reqs.major).toBe(16);
    expect(reqs.coreVersion).toBe('16.2.12');
    expect(reqs.node).toBe('^16.14.0 || >=18.10.0');
    expect(reqs.typescript).toBe('>=4.9.3 <5.2.0');
    expect(reqs.rxjs).toBe('^6.5.3 || ^7.4.0');
    expect(reqs.zone).toBe('~0.13.0');
    expect(reqs.notes.some((n) => n.includes('ngcc was removed'))).toBe(true);
  });
});
