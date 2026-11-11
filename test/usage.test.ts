import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzePackageUsage } from '../src/recommend/usage.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('usage analysis', () => {
  it('detects imports, symbols, call sites and template occurrences', async () => {
    await mkdir(path.join(dir, 'src', 'app'), { recursive: true });

    // Component TypeScript file importing some-tooltip-lib
    const tsCode = `
      import { Component } from '@angular/core';
      import { TooltipDirective } from 'some-tooltip-lib';

      @Component({
        selector: 'app-root',
        template: '<button tooltip="Click me">Submit</button>'
      })
      export class AppComponent {
        title = 'sample';
        ref = TooltipDirective;
      }
    `;
    await writeFile(path.join(dir, 'src', 'app', 'app.component.ts'), tsCode);

    // External HTML template referencing tooltip
    await writeFile(
      path.join(dir, 'src', 'app', 'nav.component.html'),
      '<span tooltip="Navigation">Home</span>',
    );

    const footprint = await analyzePackageUsage(dir, 'some-tooltip-lib');

    expect(footprint.packageName).toBe('some-tooltip-lib');
    expect(footprint.importedSymbols).toEqual(['TooltipDirective']);
    expect(footprint.files).toContain('src/app/app.component.ts');
    expect(footprint.files).toContain('src/app/nav.component.html');
    expect(footprint.callSiteCount).toBeGreaterThanOrEqual(1);
    expect(footprint.templateOccurrences).toBeGreaterThanOrEqual(1);
    expect(footprint.isSmallFootprint).toBe(true);
  });

  it('detects fx* directives in inline component templates even when FlexLayoutModule is imported in a separate module file', async () => {
    await mkdir(path.join(dir, 'src', 'app'), { recursive: true });

    await writeFile(
      path.join(dir, 'src', 'app', 'app.module.ts'),
      `
      import { NgModule } from '@angular/core';
      import { FlexLayoutModule } from '@angular/flex-layout';
      @NgModule({ imports: [FlexLayoutModule] })
      export class AppModule {}
      `,
    );

    await writeFile(
      path.join(dir, 'src', 'app', 'header.component.ts'),
      `
      import { Component } from '@angular/core';
      @Component({
        selector: 'app-header',
        template: '<div fxLayout="row" fxLayoutAlign="space-between center"><span fxFlex="50">Logo</span></div>'
      })
      export class HeaderComponent {}
      `,
    );

    const footprint = await analyzePackageUsage(dir, '@angular/flex-layout');
    expect(footprint.importedSymbols).toEqual(['FlexLayoutModule']);
    expect(footprint.files).toEqual(['src/app/app.module.ts', 'src/app/header.component.ts']);
    expect(footprint.templateOccurrences).toBe(3);
  });
});

