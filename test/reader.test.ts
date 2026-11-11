import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkProject } from '../src/reader/files.js';
import { classifyStyle, findCaseMismatchedImports, readProject } from '../src/reader/project.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('files walker', () => {
  it('skips build and cache directories', async () => {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules', 'foo'), { recursive: true });
    await mkdir(path.join(dir, 'dist'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });

    await writeFile(path.join(dir, 'src', 'app.component.ts'), 'export class AppComponent {}');
    await writeFile(path.join(dir, 'node_modules', 'foo', 'index.ts'), '');
    await writeFile(path.join(dir, 'dist', 'bundle.ts'), '');

    const files = await walkProject(dir, { extensions: ['.ts'] });
    expect(files).toEqual(['src/app.component.ts']);
  });
});

describe('style classification', () => {
  it('detects ngmodule style', () => {
    const code = ['@NgModule({ declarations: [AppComponent] }) export class AppModule {}'];
    expect(classifyStyle(code, 15)).toBe('ngmodule');
  });

  it('detects standalone style with standalone: true', () => {
    const code = ['@Component({ selector: "app-root", standalone: true }) export class AppComponent {}'];
    expect(classifyStyle(code, 15)).toBe('standalone');
  });

  it('detects mixed style when both are present', () => {
    const code = [
      '@NgModule({ declarations: [LegacyComponent] }) export class AppModule {}',
      '@Component({ selector: "app-root", standalone: true }) export class AppComponent {}',
    ];
    expect(classifyStyle(code, 15)).toBe('mixed');
  });

  it('treats components as standalone by default in Angular 19+', () => {
    const code = ['@Component({ selector: "app-root" }) export class AppComponent {}'];
    expect(classifyStyle(code, 18)).toBe('unknown');
    expect(classifyStyle(code, 19)).toBe('standalone');

    const explicitFalse = ['@Component({ selector: "app-root", standalone: false }) export class AppComponent {}'];
    expect(classifyStyle(explicitFalse, 19)).toBe('unknown');
  });
});

describe('case mismatched imports', () => {
  it('finds imports differing only by case', () => {
    const files = ['src/app/HeroService.ts', 'src/app/main.ts'];
    const sources = new Map([
      ['src/app/main.ts', "import { HeroService } from './heroservice';"],
    ]);
    const warnings = findCaseMismatchedImports(files, sources);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('HeroService.ts');
  });
});

describe('readProject', () => {
  it('throws NGM-3007 when package.json does not exist', async () => {
    await expect(readProject(dir)).rejects.toMatchObject({ id: 'NGM-3007' });
  });

  it('detects packageManager field over lockfiles', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        packageManager: 'pnpm@9.0.0',
        dependencies: { '@angular/core': '^16.0.0' },
      }),
    );
    await writeFile(path.join(dir, 'package-lock.json'), '{}');

    const info = await readProject(dir);
    expect(info.packageManager).toEqual({
      name: 'pnpm',
      source: 'packageManager field',
    });
    expect(info.name).toBe('test-app');
  });

  it('detects lockfile package manager when field is missing', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        dependencies: { '@angular/core': '^15.2.0' },
      }),
    );
    await writeFile(path.join(dir, 'yarn.lock'), '');

    const info = await readProject(dir);
    expect(info.packageManager).toEqual({
      name: 'yarn',
      source: 'lockfile',
      lockfile: 'yarn.lock',
    });
    expect(info.angular.major).toBe(15);
  });

  it('detects nx workspace and angular projects', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-workspace' }),
    );
    await writeFile(path.join(dir, 'nx.json'), '{}');
    await writeFile(
      path.join(dir, 'angular.json'),
      JSON.stringify({ projects: { app1: {}, lib1: {} } }),
    );

    const info = await readProject(dir);
    expect(info.workspace).toBe('nx');
    expect(info.angularProjects).toEqual(['app1', 'lib1']);
  });

  it('identifies overrides and view engine suspects', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        scripts: { postinstall: 'ngcc' },
        overrides: { 'legacy-pkg': '1.0.0' },
        dependencies: {
          '@angular/core': '15.0.0',
          've-lib': '1.0.0',
        },
      }),
    );

    // Create fake node_modules for ve-lib
    const veLibDir = path.join(dir, 'node_modules', 've-lib');
    await mkdir(veLibDir, { recursive: true });
    await writeFile(
      path.join(veLibDir, 'package.json'),
      JSON.stringify({
        name: 've-lib',
        version: '1.0.0',
        typings: 'index.d.ts',
        peerDependencies: { '@angular/core': '^15.0.0' },
        __processed_by_ivy_ngcc__: {},
      }),
    );
    await writeFile(path.join(veLibDir, 'index.d.ts'), '');

    const info = await readProject(dir);
    expect(info.overrides).toEqual(['legacy-pkg']);
    expect(info.ngccScripts).toEqual(['postinstall']);
    expect(info.viewEngineSuspects).toContain('ve-lib');
  });
});
