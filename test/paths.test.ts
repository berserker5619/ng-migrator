import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NgmError } from '../src/errors.js';
import {
  exceedsWindowsMaxPath,
  findCaseOnlyCollisions,
  projectRelative,
  sortPaths,
  toPosix,
} from '../src/platform/paths.js';

describe('paths', () => {
  it('converts backslashes to forward slashes', () => {
    expect(toPosix('src\\app\\main.ts')).toBe('src/app/main.ts');
  });

  it('makes project-relative POSIX paths', () => {
    const root = path.resolve('some project');
    expect(projectRelative(root, path.join(root, 'src', 'app', 'a.ts'))).toBe('src/app/a.ts');
    expect(projectRelative(root, root)).toBe('.');
  });

  it('refuses paths outside the project', () => {
    const root = path.resolve('some project');
    expect(() => projectRelative(root, path.resolve(root, '..', 'other'))).toThrow(NgmError);
  });

  it('sorts by code unit, not locale', () => {
    expect(sortPaths(['b.ts', 'B.ts', 'a\\z.ts', 'a/b.ts'])).toEqual(['B.ts', 'a/b.ts', 'a/z.ts', 'b.ts']);
  });

  it('flags the Windows 260 character limit only on win32', () => {
    const long = `C:\\${'x'.repeat(300)}`;
    expect(exceedsWindowsMaxPath(long, 'win32')).toBe(true);
    expect(exceedsWindowsMaxPath(long, 'linux')).toBe(false);
    expect(exceedsWindowsMaxPath('C:\\short', 'win32')).toBe(false);
  });

  it('finds imports that differ only by case', () => {
    expect(findCaseOnlyCollisions(['src/Foo.ts', 'src/foo.ts', 'src/bar.ts', 'src\\FOO.ts'])).toEqual([
      ['src/FOO.ts', 'src/Foo.ts', 'src/foo.ts'],
    ]);
  });
});

