import path from 'node:path';
import { NgmError } from '../errors.js';

/** Convert any path to forward slashes. Used for everything written to reports. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Project-relative, POSIX-style path for reports and state.
 * Throws if `target` is outside `root`, so absolute or home paths never leak into output.
 */
export function projectRelative(root: string, target: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(root, target));
  if (rel === '') return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new NgmError('NGM-3006', `Path is outside the project: ${toPosix(rel)}`);
  }
  return toPosix(rel);
}

/** Ordinal (code-unit) comparison: identical on every OS and locale. */
export function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort paths deterministically after POSIX normalization. Returns a new array. */
export function sortPaths(paths: readonly string[]): string[] {
  return paths.map(toPosix).sort(compareOrdinal);
}

/** Classic Windows MAX_PATH limit. */
export const WINDOWS_MAX_PATH = 260;

/** True if the path would hit the Windows 260-character limit (only meaningful on win32). */
export function exceedsWindowsMaxPath(absPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && path.win32.resolve(absPath).length >= WINDOWS_MAX_PATH;
}

/**
 * Find paths that differ only by letter case (they work on Windows and macOS
 * but break on case-sensitive Linux CI). Returns groups of 2 or more.
 */
export function findCaseOnlyCollisions(paths: readonly string[]): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const p of paths) {
    const posix = toPosix(p);
    const key = posix.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = new Set();
      groups.set(key, group);
    }
    group.add(posix);
  }
  return [...groups.values()]
    .filter((g) => g.size > 1)
    .map((g) => [...g].sort(compareOrdinal))
    .sort((a, b) => compareOrdinal(a[0] ?? '', b[0] ?? ''));
}

