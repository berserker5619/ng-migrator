import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export interface NpmrcConfig {
  registry: string;
  /** "@scope" to registry URL. */
  scopes: Record<string, string>;
  /** "//host/path/" to credentials. Never written to logs, reports or cache. */
  auth: Record<string, { token?: string; basic?: string }>;
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** Parse .npmrc text. `${VAR}` references are expanded from `env`. */
export function parseNpmrc(text: string, env: NodeJS.ProcessEnv): Partial<NpmrcConfig> {
  const out: Partial<NpmrcConfig> & { scopes: Record<string, string>; auth: NpmrcConfig['auth'] } = { scopes: {}, auth: {} };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? '');
    if (key === 'registry') out.registry = withSlash(value);
    else if (/^@[^:]+:registry$/.test(key)) out.scopes[key.slice(0, key.indexOf(':'))] = withSlash(value);
    else {
      const m = /^(\/\/.+?):(_authToken|_auth)$/.exec(key);
      if (m) {
        const prefix = withSlash(m[1]!);
        out.auth[prefix] = { ...out.auth[prefix], ...(m[2] === '_authToken' ? { token: value } : { basic: value }) };
      }
    }
  }
  return out;
}

function merge(base: NpmrcConfig, next: Partial<NpmrcConfig>): NpmrcConfig {
  return {
    registry: next.registry ?? base.registry,
    scopes: { ...base.scopes, ...next.scopes },
    auth: { ...base.auth, ...next.auth },
  };
}

/** User ~/.npmrc, then the project's .npmrc (project wins), like npm itself. */
export async function loadNpmrc(root: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Promise<NpmrcConfig> {
  let config: NpmrcConfig = { registry: DEFAULT_REGISTRY, scopes: {}, auth: {} };
  if (env.npm_config_registry) config.registry = withSlash(env.npm_config_registry);
  for (const file of [path.join(home, '.npmrc'), path.join(root, '.npmrc')]) {
    try {
      config = merge(config, parseNpmrc(await readFile(file, 'utf8'), env));
    } catch {
      // Missing or unreadable .npmrc files are ignored.
    }
  }
  return config;
}

export function registryFor(name: string, config: NpmrcConfig): string {
  if (name.startsWith('@')) {
    const scope = name.slice(0, name.indexOf('/'));
    const scoped = config.scopes[scope];
    if (scoped) return scoped;
  }
  return config.registry;
}

/** Authorization header value for a URL, using the longest matching credential prefix. */
export function authHeaderFor(url: string, config: NpmrcConfig): string | undefined {
  const bare = url.replace(/^https?:/, '');
  let best: { len: number; header: string } | undefined;
  for (const [prefix, cred] of Object.entries(config.auth)) {
    if (!bare.startsWith(prefix) || (best && best.len >= prefix.length)) continue;
    const header = cred.token ? `Bearer ${cred.token}` : cred.basic ? `Basic ${cred.basic}` : undefined;
    if (header) best = { len: prefix.length, header };
  }
  return best?.header;
}

