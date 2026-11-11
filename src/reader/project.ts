import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import type { PackageManager } from '../config/config.js';
import { NgmError } from '../errors.js';
import { pathExists, readJsonIfExists } from '../platform/fs.js';
import { compareOrdinal } from '../platform/paths.js';
import exceptions from '../rules/angular-exceptions.json' with { type: 'json' };
import type { DependencyInfo, DependencyType, ProjectInfo, ProjectStyle, WorkspaceType } from '../model.js';
import { walkProject } from './files.js';

interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  resolutions?: Record<string, unknown>;
  pnpm?: { overrides?: Record<string, unknown> };
  workspaces?: unknown;
  scripts?: Record<string, string>;
  typings?: string;
  types?: string;
  version?: string;
  __processed_by_ivy_ngcc__?: unknown;
}

interface PackageLock {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string }>;
  dependencies?: Record<string, { version?: string }>;
}

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** Paths longer than this (project-relative) risk the Windows 260-character limit once the project sits in a folder. */
const LONG_RELATIVE_PATH = 200;

function nodeModulesPackageJson(root: string, name: string): string {
  return path.join(root, 'node_modules', ...name.split('/'), 'package.json');
}

async function detectPackageManager(root: string, pkg: PackageJson, warnings: string[]): Promise<ProjectInfo['packageManager']> {
  const found: Array<[string, PackageManager]> = [];
  for (const entry of LOCKFILES) {
    if (await pathExists(path.join(root, entry[0]))) found.push(entry);
  }
  const managers = new Set(found.map(([, pm]) => pm));
  if (managers.size > 1) {
    warnings.push(`Lockfiles for several package managers found (${found.map(([f]) => f).join(', ')}); keep only one.`);
  }
  const field = pkg.packageManager?.split('@')[0];
  if (field === 'npm' || field === 'yarn' || field === 'pnpm') {
    const lockfile = found.find(([, pm]) => pm === field)?.[0];
    return { name: field, source: 'packageManager field', ...(lockfile ? { lockfile } : {}) };
  }
  const first = found[0];
  if (first) return { name: first[1], source: 'lockfile', lockfile: first[0] };
  return { name: 'npm', source: 'default' };
}

export function parseYarnLockVersions(content: string, names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  let currentMatches: string[] = [];

  for (const line of lines) {
    if (!line.startsWith(' ') && line.endsWith(':')) {
      currentMatches = [];
      for (const name of names) {
        if (out.has(name)) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headerRegex = new RegExp(`(?:^|["',\\s])${escaped}@(?:npm:)?[^"',:\\s]+`);
        if (headerRegex.test(line)) {
          currentMatches.push(name);
        }
      }
      continue;
    }
    if (currentMatches.length > 0) {
      const verMatch = /^\s+version(?::\s*|\s+)["']?([0-9]+\.[0-9]+\.[0-9]+[^"'\s]*)["']?/.exec(line);
      if (verMatch && semver.valid(verMatch[1]!)) {
        for (const matchedName of currentMatches) {
          if (!out.has(matchedName)) {
            out.set(matchedName, verMatch[1]!);
          }
        }
        currentMatches = [];
      }
    }
  }
  return out;
}

export function parsePnpmLockVersions(content: string, names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match pnpm v6/v9 dependency blocks:
    //   '@angular/core':
    //     specifier: ^15.2.0
    //     version: 15.2.10(@angular/common@15.2.10)
    // or inline: '@angular/core': 15.2.10
    const blockRegex = new RegExp(
      `['"]?${escaped}['"]?:\\s*(?:\\r?\\n\\s+specifier:[^\\r\\n]+\\r?\\n\\s+version:\\s*['"]?([0-9]+\\.[0-9]+\\.[0-9]+[^('"\\s]*)|['"]?([0-9]+\\.[0-9]+\\.[0-9]+[^('"\\s]*))`,
      'm',
    );
    const m = blockRegex.exec(content);
    const candidate = m?.[1] ?? m?.[2];
    if (candidate && semver.valid(candidate)) {
      out.set(name, candidate);
      continue;
    }
    // Also match packages section keys like '/@angular/core@15.2.10:' or '@angular/core@15.2.10:' or '/@angular/core/15.2.10:'
    const pkgKeyRegex = new RegExp(`['"]?/?${escaped}[@/]([0-9]+\\.[0-9]+\\.[0-9]+[^('"\\s:]*)`, 'm');
    const pm = pkgKeyRegex.exec(content);
    if (pm?.[1] && semver.valid(pm[1])) {
      out.set(name, pm[1]);
    }
  }
  return out;
}

async function installedVersions(root: string, names: string[], lock: PackageLock | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let yarnMap: Map<string, string> | undefined;
  let pnpmMap: Map<string, string> | undefined;

  const yarnLockPath = path.join(root, 'yarn.lock');
  if (await pathExists(yarnLockPath)) {
    const raw = await readFile(yarnLockPath, 'utf8').catch(() => '');
    if (raw) yarnMap = parseYarnLockVersions(raw, names);
  }

  const pnpmLockPath = path.join(root, 'pnpm-lock.yaml');
  if (await pathExists(pnpmLockPath)) {
    const raw = await readFile(pnpmLockPath, 'utf8').catch(() => '');
    if (raw) pnpmMap = parsePnpmLockVersions(raw, names);
  }

  for (const name of names) {
    const fromModules = await readJsonIfExists<PackageJson>(nodeModulesPackageJson(root, name)).catch(() => undefined);
    const version =
      fromModules?.version ??
      lock?.packages?.[`node_modules/${name}`]?.version ??
      lock?.dependencies?.[name]?.version ??
      pnpmMap?.get(name) ??
      yarnMap?.get(name);
    if (version && semver.valid(version)) out.set(name, version);
  }
  return out;
}

async function detectWorkspace(root: string): Promise<{ type: WorkspaceType; projects: string[] }> {
  const angularJson = await readJsonIfExists<{ projects?: Record<string, unknown> }>(path.join(root, 'angular.json')).catch(
    () => undefined,
  );
  const projects = Object.keys(angularJson?.projects ?? {}).sort(compareOrdinal);
  if (await pathExists(path.join(root, 'nx.json'))) return { type: 'nx', projects };
  return { type: projects.length > 1 ? 'angular-multi' : 'single', projects };
}

/**
 * Standalone vs NgModule, from decorators in the source. From Angular 19,
 * components are standalone unless they say `standalone: false`.
 */
export function classifyStyle(sources: readonly string[], angularMajor: number | undefined): ProjectStyle {
  const standaloneDefault = (angularMajor ?? 0) >= exceptions.standaloneDefaultFrom;
  let ngModules = 0;
  let standalone = 0;
  for (const text of sources) {
    ngModules += text.match(/@NgModule\s*\(/g)?.length ?? 0;
    const declarables = text.match(/@(Component|Directive|Pipe)\s*\(/g)?.length ?? 0;
    const explicitTrue = text.match(/standalone\s*:\s*true/g)?.length ?? 0;
    const explicitFalse = text.match(/standalone\s*:\s*false/g)?.length ?? 0;
    standalone += standaloneDefault ? Math.max(0, declarables - explicitFalse) : explicitTrue;
  }
  if (ngModules > 0 && standalone > 0) return 'mixed';
  if (ngModules > 0) return 'ngmodule';
  if (standalone > 0) return 'standalone';
  return 'unknown';
}

/** Relative imports whose path matches a file only when case is ignored (break on Linux CI). */
export function findCaseMismatchedImports(files: readonly string[], sources: ReadonlyMap<string, string>): string[] {
  const exact = new Set(files);
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  const warnings: string[] = [];
  for (const [file, text] of sources) {
    const dir = path.posix.dirname(file);
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const spec = match[1]!;
      const base = path.posix.normalize(path.posix.join(dir, spec));
      const candidates = [base, `${base}.ts`, `${base}/index.ts`];
      if (candidates.some((c) => exact.has(c))) continue;
      const hit = candidates.map((c) => lower.get(c.toLowerCase())).find((c) => c !== undefined);
      if (hit) warnings.push(`${file} imports "${spec}" but the file is "${hit}" (case differs; breaks on Linux).`);
    }
  }
  return warnings;
}

async function isViewEngineLibrary(root: string, name: string): Promise<boolean> {
  const file = nodeModulesPackageJson(root, name);
  const pkg = await readJsonIfExists<PackageJson>(file).catch(() => undefined);
  if (!pkg) return false;
  if (pkg.__processed_by_ivy_ngcc__ !== undefined) return true;
  const typings = pkg.typings ?? pkg.types;
  if (!typings || !typings.endsWith('.d.ts')) return false;
  // Libraries in View Engine format ship a .metadata.json next to their typings entry.
  return pathExists(path.join(path.dirname(file), typings.replace(/\.d\.ts$/, '.metadata.json')));
}

async function hasAngularPeer(root: string, name: string): Promise<boolean> {
  const pkg = await readJsonIfExists<PackageJson>(nodeModulesPackageJson(root, name)).catch(() => undefined);
  return Object.keys(pkg?.peerDependencies ?? {}).some((p) => p.startsWith('@angular/'));
}

/** Read the project without changing anything (plan section 7.1). */
export async function readProject(root: string): Promise<ProjectInfo> {
  const warnings: string[] = [];
  const pkg = await readJsonIfExists<PackageJson>(path.join(root, 'package.json'));
  if (!pkg) {
    throw new NgmError('NGM-3007', 'No package.json in this folder.', { hint: 'Run ng-migrator from the root of an Angular project.' });
  }

  const packageManager = await detectPackageManager(root, pkg, warnings);
  const lock = await readJsonIfExists<PackageLock>(path.join(root, 'package-lock.json')).catch(() => undefined);
  const hasNodeModules = await pathExists(path.join(root, 'node_modules'));
  if (!hasNodeModules) warnings.push('node_modules not found: installed versions come from the lockfile, and the View Engine check is skipped.');

  const declared: Array<[string, string, DependencyType]> = [];
  for (const type of ['dependencies', 'devDependencies'] as const) {
    for (const [name, range] of Object.entries(pkg[type] ?? {})) declared.push([name, range, type]);
  }
  const installed = await installedVersions(root, declared.map(([n]) => n), lock);
  const dependencies: DependencyInfo[] = declared
    .map(([name, range, type]) => ({ name, declared: range, type, ...(installed.has(name) ? { installed: installed.get(name)! } : {}) }))
    .sort((a, b) => compareOrdinal(a.name, b.name));

  const core = dependencies.find((d) => d.name === '@angular/core');
  const coreVersion = core?.installed ?? (core ? semver.minVersion(core.declared)?.version : undefined);
  const angular = {
    ...(core ? { declared: core.declared } : {}),
    ...(core?.installed ? { installed: core.installed } : {}),
    ...(coreVersion ? { version: coreVersion, major: semver.major(coreVersion) } : {}),
  };

  const workspace = await detectWorkspace(root);

  const files = await walkProject(root, { extensions: ['.ts'] });
  const sourceFiles = files.filter((f) => !f.endsWith('.d.ts'));
  const sources = new Map<string, string>();
  for (const f of sourceFiles) sources.set(f, await readFile(path.join(root, f), 'utf8'));
  const style = classifyStyle(
    [...sources].filter(([f]) => !f.endsWith('.spec.ts')).map(([, t]) => t),
    angular.major,
  );
  warnings.push(...findCaseMismatchedImports(files, sources));

  const long = files.filter((f) => f.length > LONG_RELATIVE_PATH);
  if (long.length > 0) {
    warnings.push(`${long.length} file path(s) are longer than ${LONG_RELATIVE_PATH} characters and may hit the Windows 260-character limit, e.g. ${long[0]}.`);
  }

  const viewEngineSuspects: string[] = [];
  if (hasNodeModules) {
    for (const dep of dependencies) {
      if (dep.name.startsWith('@angular/')) continue;
      if ((await hasAngularPeer(root, dep.name)) && (await isViewEngineLibrary(root, dep.name))) viewEngineSuspects.push(dep.name);
    }
  }

  const overrides = new Set([
    ...Object.keys(pkg.overrides ?? {}),
    ...Object.keys(pkg.resolutions ?? {}),
    ...Object.keys(pkg.pnpm?.overrides ?? {}),
  ]);
  const ngccScripts = Object.entries(pkg.scripts ?? {})
    .filter(([, cmd]) => /\bngcc\b/.test(cmd))
    .map(([name]) => name)
    .sort(compareOrdinal);

  return {
    root,
    ...(pkg.name ? { name: pkg.name } : {}),
    angular,
    packageManager,
    workspace: workspace.type,
    angularProjects: workspace.projects,
    style,
    dependencies,
    overrides: [...overrides].sort(compareOrdinal),
    viewEngineSuspects,
    ngccScripts,
    hasNodeModules,
    hasNpmWorkspaces: pkg.workspaces !== undefined,
    warnings: warnings.sort(compareOrdinal),
  };
}
