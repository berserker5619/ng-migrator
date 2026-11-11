import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodePackageName,
  inAngularMajor,
  RegistryClient,
  stableVersionsDesc,
  type FetchLike,
  type Packument,
} from '../src/registry/client.js';
import {
  authHeaderFor,
  DEFAULT_REGISTRY,
  parseNpmrc,
  registryFor,
  type NpmrcConfig,
} from '../src/registry/npmrc.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('npmrc', () => {
  it('parses registry, scopes, and auth with variable expansion', () => {
    const text = `
      registry=https://custom-registry.com/
      @myorg:registry=https://npm.myorg.internal/
      //npm.myorg.internal/:_authToken=\${MY_TOKEN}
      //other.internal/:_auth=dXNlcjpwYXNz
    `;
    const env = { MY_TOKEN: 'secret-token-123' };
    const parsed = parseNpmrc(text, env);

    expect(parsed.registry).toBe('https://custom-registry.com/');
    expect(parsed.scopes?.['@myorg']).toBe('https://npm.myorg.internal/');
    expect(parsed.auth?.['//npm.myorg.internal/']?.token).toBe('secret-token-123');
    expect(parsed.auth?.['//other.internal/']?.basic).toBe('dXNlcjpwYXNz');
  });

  it('selects registry based on scope', () => {
    const config: NpmrcConfig = {
      registry: DEFAULT_REGISTRY,
      scopes: { '@myorg': 'https://npm.myorg.internal/' },
      auth: {},
    };
    expect(registryFor('@myorg/pkg', config)).toBe('https://npm.myorg.internal/');
    expect(registryFor('@other/pkg', config)).toBe(DEFAULT_REGISTRY);
    expect(registryFor('lodash', config)).toBe(DEFAULT_REGISTRY);
  });

  it('resolves auth headers using longest prefix match', () => {
    const config: NpmrcConfig = {
      registry: DEFAULT_REGISTRY,
      scopes: {},
      auth: {
        '//registry.npmjs.org/': { token: 'token-root' },
        '//registry.npmjs.org/scoped/': { token: 'token-scoped' },
      },
    };
    expect(authHeaderFor('https://registry.npmjs.org/scoped/pkg', config)).toBe('Bearer token-scoped');
    expect(authHeaderFor('https://registry.npmjs.org/other-pkg', config)).toBe('Bearer token-root');
    expect(authHeaderFor('https://unknown.com/pkg', config)).toBeUndefined();
  });
});

describe('registry client helpers', () => {
  it('encodes package names with scopes', () => {
    expect(encodePackageName('lodash')).toBe('lodash');
    expect(encodePackageName('@angular/core')).toBe('@angular%2Fcore');
  });

  it('sorts stable versions descending and filters prereleases', () => {
    const p: Packument = {
      name: 'foo',
      distTags: {},
      versions: {
        '1.0.0': { version: '1.0.0' },
        '1.1.0-beta.0': { version: '1.1.0-beta.0' },
        '2.0.0': { version: '2.0.0' },
        '1.2.0': { version: '1.2.0' },
      },
    };
    expect(stableVersionsDesc(p)).toEqual(['2.0.0', '1.2.0', '1.0.0']);
  });

  it('identifies angular major versions including devkit 0.x', () => {
    expect(inAngularMajor('16.2.0', 16)).toBe(true);
    expect(inAngularMajor('15.0.0', 16)).toBe(false);
    expect(inAngularMajor('0.1502.3', 15)).toBe(true);
    expect(inAngularMajor('0.1600.0', 16)).toBe(true);
  });
});

describe('RegistryClient', () => {
  const fakeNpmrc: NpmrcConfig = {
    registry: 'https://registry.npmjs.org/',
    scopes: {},
    auth: {},
  };

  const samplePackument = {
    name: 'test-pkg',
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        version: '1.0.0',
        peerDependencies: { '@angular/core': '^15.0.0' },
      },
    },
  };

  it('fetches packument, caches in memory and on disk', async () => {
    let fetchCalls = 0;
    const fetch: FetchLike = async () => {
      fetchCalls++;
      return {
        status: 200,
        json: async () => samplePackument,
      };
    };

    const client = new RegistryClient({
      npmrc: fakeNpmrc,
      cacheDir: path.join(dir, 'cache'),
      fetch,
    });

    const p1 = await client.packument('test-pkg');
    expect(p1?.name).toBe('test-pkg');
    expect(p1?.versions['1.0.0']?.peerDependencies?.['@angular/core']).toBe('^15.0.0');
    expect(fetchCalls).toBe(1);

    // Second call uses memory cache
    const p2 = await client.packument('test-pkg');
    expect(p2).toBe(p1);
    expect(fetchCalls).toBe(1);

    // New client instance uses disk cache
    const client2 = new RegistryClient({
      npmrc: fakeNpmrc,
      cacheDir: path.join(dir, 'cache'),
      fetch,
    });
    const p3 = await client2.packument('test-pkg');
    expect(p3?.name).toBe('test-pkg');
    expect(fetchCalls).toBe(1);
  });

  it('returns undefined on 404', async () => {
    const fetch: FetchLike = async () => ({
      status: 404,
      json: async () => ({}),
    });
    const client = new RegistryClient({
      npmrc: fakeNpmrc,
      cacheDir: path.join(dir, 'cache'),
      fetch,
    });
    expect(await client.packument('non-existent')).toBeUndefined();
  });

  it('throws NGM-6003 on 401/403', async () => {
    const fetch: FetchLike = async () => ({
      status: 401,
      json: async () => ({}),
    });
    const client = new RegistryClient({
      npmrc: fakeNpmrc,
      cacheDir: path.join(dir, 'cache'),
      fetch,
    });
    await expect(client.packument('private-pkg')).rejects.toMatchObject({ id: 'NGM-6003' });
  });

  it('respects offline flag and throws if not in cache', async () => {
    const client = new RegistryClient({
      npmrc: fakeNpmrc,
      cacheDir: path.join(dir, 'cache'),
      offline: true,
    });
    await expect(client.packument('un-cached-pkg')).rejects.toMatchObject({ id: 'NGM-6004' });
  });
});
