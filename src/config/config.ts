import path from 'node:path';
import { NgmError } from '../errors.js';
import { readJsonIfExists } from '../platform/fs.js';

export const CONFIG_FILE = 'ng-migrator.config.json';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';
export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'yarn', 'pnpm'];

/** Contents of ng-migrator.config.json (plan section 19.1). Contains no secrets. */
export interface FileConfig {
  packageManager?: PackageManager;
  rules?: string[];
  neverTouch?: string[];
  pinned?: Record<string, string>;
  alternates?: { allow?: string[]; deny?: string[] };
  verify?: { build?: string; lint?: string; test?: string };
  cacheDir?: string;
  unmaintainedThresholdMonths?: number;
  /** Timeout in milliseconds for package-manager resolution checks (default: 300000 = 5 minutes). */
  resolutionTimeoutMs?: number;
  /** One prefix for every step, or a map keyed by the step's target major n. */
  commandPrefix?: string | Record<string, string>;
}

/** Values that may come from command-line flags. */
export interface FlagConfig {
  packageManager?: PackageManager;
  rules?: string[];
}

/** Values found by inspecting the project. */
export interface DetectedConfig {
  packageManager?: PackageManager;
}

export interface ResolvedConfig {
  packageManager: PackageManager;
  rules: string[];
  neverTouch: string[];
  pinned: Record<string, string>;
  alternates: { allow: string[]; deny: string[] };
  verify: { build?: string; lint?: string; test?: string };
  cacheDir: string;
  unmaintainedThresholdMonths: number;
  resolutionTimeoutMs: number;
  commandPrefix: string | Record<string, string> | undefined;
}

const KNOWN_KEYS = new Set([
  'packageManager',
  'rules',
  'neverTouch',
  'pinned',
  'alternates',
  'verify',
  'cacheDir',
  'unmaintainedThresholdMonths',
  'resolutionTimeoutMs',
  'commandPrefix',
]);

function fail(field: string, expected: string): never {
  throw new NgmError('NGM-2003', `${CONFIG_FILE}: "${field}" must be ${expected}.`, {
    hint: `Fix or remove "${field}" in ${CONFIG_FILE}.`,
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStringMap = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every((x) => typeof x === 'string');

/** Validate parsed JSON. Returns the typed config and warnings for unknown keys. */
export function validateFileConfig(raw: unknown): { config: FileConfig; warnings: string[] } {
  if (!isObject(raw)) fail('(root)', 'a JSON object');
  const warnings: string[] = [];
  for (const key of Object.keys(raw).sort()) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${CONFIG_FILE}: unknown key "${key}" is ignored.`);
  }

  const c: FileConfig = {};
  if (raw.packageManager !== undefined) {
    if (!PACKAGE_MANAGERS.includes(raw.packageManager as PackageManager)) fail('packageManager', 'npm, yarn or pnpm');
    c.packageManager = raw.packageManager as PackageManager;
  }
  for (const key of ['rules', 'neverTouch'] as const) {
    if (raw[key] !== undefined) {
      if (!isStringArray(raw[key])) fail(key, 'an array of strings');
      c[key] = raw[key] as string[];
    }
  }
  if (raw.pinned !== undefined) {
    if (!isStringMap(raw.pinned)) fail('pinned', 'an object of package name to version');
    c.pinned = raw.pinned;
  }
  if (raw.alternates !== undefined) {
    const a = raw.alternates;
    if (!isObject(a)) fail('alternates', 'an object with "allow" and "deny" arrays');
    if (a.allow !== undefined && !isStringArray(a.allow)) fail('alternates.allow', 'an array of strings');
    if (a.deny !== undefined && !isStringArray(a.deny)) fail('alternates.deny', 'an array of strings');
    c.alternates = { ...(a.allow ? { allow: a.allow as string[] } : {}), ...(a.deny ? { deny: a.deny as string[] } : {}) };
  }
  if (raw.verify !== undefined) {
    const v = raw.verify;
    if (!isObject(v)) fail('verify', 'an object with build, lint and test commands');
    for (const k of ['build', 'lint', 'test'] as const) {
      if (v[k] !== undefined && typeof v[k] !== 'string') fail(`verify.${k}`, 'a string');
    }
    c.verify = v as FileConfig['verify'];
  }
  if (raw.cacheDir !== undefined) {
    if (typeof raw.cacheDir !== 'string') fail('cacheDir', 'a string');
    c.cacheDir = raw.cacheDir;
  }
  if (raw.unmaintainedThresholdMonths !== undefined) {
    if (typeof raw.unmaintainedThresholdMonths !== 'number' || raw.unmaintainedThresholdMonths <= 0) {
      fail('unmaintainedThresholdMonths', 'a positive number of months');
    }
    c.unmaintainedThresholdMonths = raw.unmaintainedThresholdMonths;
  }
  if (raw.resolutionTimeoutMs !== undefined) {
    if (typeof raw.resolutionTimeoutMs !== 'number' || raw.resolutionTimeoutMs <= 0) {
      fail('resolutionTimeoutMs', 'a positive number of milliseconds');
    }
    c.resolutionTimeoutMs = raw.resolutionTimeoutMs;
  }
  if (raw.commandPrefix !== undefined) {
    const p = raw.commandPrefix;
    if (typeof p === 'string') c.commandPrefix = p;
    else if (isStringMap(p) && Object.keys(p).every((k) => /^\d+$/.test(k))) c.commandPrefix = p;
    else fail('commandPrefix', 'a string, or an object mapping a target Angular major (for example "14") to a string');
  }
  return { config: c, warnings };
}

export async function readConfigFile(root: string): Promise<{ config: FileConfig; warnings: string[] }> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path.join(root, CONFIG_FILE));
  } catch (err) {
    throw new NgmError('NGM-2003', `${CONFIG_FILE} is not valid JSON.`, { cause: err });
  }
  if (raw === undefined) return { config: {}, warnings: [] };
  return validateFileConfig(raw);
}

/** Precedence: command-line flags, then the config file, then auto-detection, then defaults. */
export function resolveConfig(flags: FlagConfig, file: FileConfig, detected: DetectedConfig): ResolvedConfig {
  return {
    packageManager: flags.packageManager ?? file.packageManager ?? detected.packageManager ?? 'npm',
    rules: [...(file.rules ?? []), ...(flags.rules ?? [])],
    neverTouch: [...(file.neverTouch ?? [])],
    pinned: { ...(file.pinned ?? {}) },
    alternates: { allow: [...(file.alternates?.allow ?? [])], deny: [...(file.alternates?.deny ?? [])] },
    verify: { ...(file.verify ?? {}) },
    cacheDir: file.cacheDir ?? '.ng-migrator/cache',
    unmaintainedThresholdMonths: file.unmaintainedThresholdMonths ?? 18,
    resolutionTimeoutMs: file.resolutionTimeoutMs ?? 300_000,
    commandPrefix: file.commandPrefix,
  };
}

/** The command prefix for the step whose target major is `toMajor`, if any. */
export function commandPrefixForStep(config: Pick<ResolvedConfig, 'commandPrefix'>, toMajor: number): string | undefined {
  const p = config.commandPrefix;
  if (p === undefined || typeof p === 'string') return p;
  return p[String(toMajor)];
}

