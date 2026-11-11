import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { NgmError } from '../errors.js';
import { atomicWrite } from '../platform/fs.js';
import { authHeaderFor, registryFor, type NpmrcConfig } from './npmrc.js';

/** The fields of a published version that planning needs. */
export interface VersionMeta {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: { node?: string };
  deprecated?: string;
  releaseDate?: string;
}

export interface Packument {
  name: string;
  distTags: Record<string, string>;
  versions: Record<string, VersionMeta>;
  modified?: string;
  time?: Record<string, string>;
}

interface CacheEntry {
  fetchedAt: number;
  packument: Packument;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface RegistryClientOptions {
  npmrc: NpmrcConfig;
  /** Absolute cache directory. */
  cacheDir: string;
  /** Use the cache only; never touch the network. */
  offline?: boolean;
  /** How long cached metadata is fresh. Default 24 hours. */
  ttlMs?: number;
  fetch?: FetchLike;
  now?: () => number;
  onWarning?: (message: string) => void;
  /** Maximum parallel requests. */
  concurrency?: number;
  timeoutMs?: number;
}

const CORGI = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8';

function trim(raw: Record<string, unknown>): Packument {
  const versions: Record<string, VersionMeta> = {};
  const time = (raw.time ?? {}) as Record<string, string>;
  for (const [v, meta] of Object.entries((raw.versions ?? {}) as Record<string, Record<string, unknown>>)) {
    const m: VersionMeta = { version: v };
    if (meta.peerDependencies) m.peerDependencies = meta.peerDependencies as Record<string, string>;
    if (meta.peerDependenciesMeta) m.peerDependenciesMeta = meta.peerDependenciesMeta as VersionMeta['peerDependenciesMeta'];
    if (meta.engines && typeof (meta.engines as { node?: unknown }).node === 'string') m.engines = { node: (meta.engines as { node: string }).node };
    if (typeof meta.deprecated === 'string' && meta.deprecated !== '') m.deprecated = meta.deprecated;
    if (typeof time[v] === 'string') m.releaseDate = time[v];
    versions[v] = m;
  }
  return {
    name: String(raw.name),
    distTags: (raw['dist-tags'] ?? {}) as Record<string, string>,
    versions,
    ...(typeof raw.modified === 'string' ? { modified: raw.modified } : {}),
    ...(Object.keys(time).length > 0 ? { time } : {}),
  };
}

export function encodePackageName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/**
 * npm registry metadata client with an on-disk cache and offline mode
 * (plan section 6). Only talks to the registries configured in .npmrc.
 */
export class RegistryClient {
  private readonly memory = new Map<string, Promise<Packument | undefined>>();
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly options: RegistryClientOptions) {}

  /** Package metadata, or undefined if the registry has no such package. */
  packument(name: string): Promise<Packument | undefined> {
    let p = this.memory.get(name);
    if (!p) {
      p = this.load(name);
      this.memory.set(name, p);
    }
    return p;
  }

  private cacheFile(name: string): string {
    return path.join(this.options.cacheDir, 'registry', `${encodeURIComponent(name)}.json`);
  }

  private async readCache(name: string): Promise<CacheEntry | undefined> {
    try {
      return JSON.parse(await readFile(this.cacheFile(name), 'utf8')) as CacheEntry;
    } catch {
      return undefined;
    }
  }

  private async load(name: string): Promise<Packument | undefined> {
    const now = this.options.now ?? Date.now;
    const cached = await this.readCache(name);
    const ttl = this.options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (cached && (this.options.offline || now() - cached.fetchedAt < ttl)) return cached.packument;
    if (this.options.offline) {
      throw new NgmError('NGM-6004', `No cached metadata for ${name} and --offline was given.`, {
        hint: 'Run once without --offline to fill the cache.',
      });
    }

    const registry = registryFor(name, this.options.npmrc);
    const url = `${registry}${encodePackageName(name)}`;
    const headers: Record<string, string> = { accept: CORGI, 'user-agent': 'ng-migrator' };
    const auth = authHeaderFor(url, this.options.npmrc);
    if (auth) headers.authorization = auth;

    let status: number;
    let body: unknown;
    try {
      ({ status, body } = await this.limited(async () => {
        const res = await (this.options.fetch ?? (globalThis.fetch as unknown as FetchLike))(url, {
          headers,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
        });
        return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
      }));
    } catch (err) {
      return this.fallback(name, cached, `network error (${(err as Error).message})`);
    }

    if (status === 200) {
      const packument = trim(body as Record<string, unknown>);
      await atomicWrite(this.cacheFile(name), `${JSON.stringify({ fetchedAt: now(), packument } satisfies CacheEntry)}\n`).catch(
        () => undefined,
      );
      return packument;
    }
    if (status === 404) return undefined;
    if (status === 401 || status === 403) {
      throw new NgmError('NGM-6003', `The registry refused access to ${name} (HTTP ${status}) at ${registry}.`, {
        hint: 'Check the credentials for this registry in your .npmrc (for example run "npm login --registry ' + registry + '").',
      });
    }
    return this.fallback(name, cached, `HTTP ${status}`);
  }

  private fallback(name: string, cached: CacheEntry | undefined, why: string): Packument {
    if (cached) {
      this.options.onWarning?.(`Using cached metadata for ${name}: ${why}.`);
      return cached.packument;
    }
    throw new NgmError('NGM-6004', `Could not fetch metadata for ${name}: ${why}.`, {
      hint: 'Check your network connection or registry settings, or use --offline with a filled cache.',
    });
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.options.concurrency ?? 8;
    if (this.active >= max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Stable releases, newest first. */
export function stableVersionsDesc(p: Packument): string[] {
  return Object.keys(p.versions)
    .filter((v) => semver.valid(v) && semver.prerelease(v) === null)
    .sort(semver.rcompare);
}

/** All valid releases (including prereleases), newest first. */
export function allVersionsDesc(p: Packument): string[] {
  return Object.keys(p.versions)
    .filter((v) => semver.valid(v) !== null)
    .sort(semver.rcompare);
}

/**
 * True if `version` belongs to Angular major `major`. Some @angular-devkit
 * packages use 0.MMmm.p versions (0.1502.3 is Angular 15.2).
 */
export function inAngularMajor(version: string, major: number): boolean {
  const v = semver.parse(version);
  if (!v) return false;
  if (v.major === major) return true;
  return v.major === 0 && v.minor >= 1000 && Math.floor(v.minor / 100) === major;
}

