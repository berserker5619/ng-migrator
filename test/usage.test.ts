import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Blocker } from '../src/model.js';
import type { RegistryClient } from '../src/registry/client.js';
import { computeRecommendation } from '../src/recommend/engine.js';
import { getBuiltInRules } from '../src/recommend/rules.js';
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

  it('detects template usage variants: [fxFlex], fxFlex.gt-sm, fxLayout="row wrap", inline templates, and *ngIf blocks', async () => {
    await mkdir(path.join(dir, 'src', 'app'), { recursive: true });

    // 1. External HTML template with [fxFlex], fxFlex.gt-sm, fxLayout="row wrap", and *ngIf block
    await writeFile(
      path.join(dir, 'src', 'app', 'dashboard.component.html'),
      `
      <section fxLayout="row wrap">
        <div *ngIf="isVisible" [fxFlex]="colWidth" fxFlex.gt-sm="33%">
          <span *ngIf="showBadge" [fxFlex.lt-md]="100">Card</span>
        </div>
      </section>
      `,
    );

    // 2. Inline component template using [fxFlex], fxFlex.gt-sm, fxLayout="row wrap" inside *ngIf
    await writeFile(
      path.join(dir, 'src', 'app', 'inline-card.component.ts'),
      `
      import { Component } from '@angular/core';
      @Component({
        selector: 'app-inline-card',
        template: \`
          <div *ngIf="ready" fxLayout="row wrap">
            <div [fxFlex]="'50%'" fxFlex.gt-sm="25%">Item</div>
          </div>
        \`
      })
      export class InlineCardComponent {
        ready = true;
      }
      `,
    );

    const footprint = await analyzePackageUsage(dir, '@angular/flex-layout');
    expect(footprint.files).toEqual([
      'src/app/dashboard.component.html',
      'src/app/inline-card.component.ts',
    ]);
    // 4 occurrences in dashboard.component.html (fxLayout="row wrap", [fxFlex], fxFlex.gt-sm, [fxFlex.lt-md])
    // + 3 occurrences in inline-card.component.ts (fxLayout="row wrap", [fxFlex], fxFlex.gt-sm) = 7
    expect(footprint.templateOccurrences).toBe(7);
  });

  describe('unused-dependency guard fixtures', () => {
    const mockRegistry = {
      packument: async () => undefined,
    } as unknown as RegistryClient;

    it('Fixture: used only in angular.json styles -> does not recommend remove', async () => {
      await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'app-styles-only',
          dependencies: { '@angular/core': '^15.2.0', '@angular/flex-layout': '^15.0.0-beta.42' },
        }),
      );
      await writeFile(
        path.join(dir, 'angular.json'),
        JSON.stringify({
          projects: {
            app: {
              architect: {
                build: {
                  options: {
                    styles: ['node_modules/@angular/flex-layout/prebuilt.css', 'src/styles.scss'],
                  },
                },
              },
            },
          },
        }),
      );
      await writeFile(path.join(dir, 'src', 'app', 'app.component.ts'), 'export class AppComponent {}');

      const blocker: Blocker = {
        package: '@angular/flex-layout',
        reason: 'deprecated',
        hard: false,
        details: 'Deprecated',
      };
      const rec = await computeRecommendation({
        projectRoot: dir,
        blocker,
        targetMajor: 16,
        targetCoreVersion: '16.2.12',
        registry: mockRegistry,
        rules: getBuiltInRules(),
      });

      expect(rec.recommendation).not.toBe('remove');
      expect(rec.recommendedFix).toBe('CSS flexbox/grid');
      expect(rec.usage?.summary).toContain('configs: [angular.json]');
    });

    it('Fixture: used only as a peer dependency of another installed package -> does not recommend remove', async () => {
      await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
      await mkdir(path.join(dir, 'node_modules', 'ngx-layout-wrapper'), { recursive: true });
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'app-peer-only',
          dependencies: {
            '@angular/core': '^15.2.0',
            '@angular/flex-layout': '^15.0.0-beta.42',
            'ngx-layout-wrapper': '^1.0.0',
          },
        }),
      );
      await writeFile(
        path.join(dir, 'node_modules', 'ngx-layout-wrapper', 'package.json'),
        JSON.stringify({
          name: 'ngx-layout-wrapper',
          version: '1.0.0',
          peerDependencies: { '@angular/flex-layout': '^15.0.0-beta.42' },
        }),
      );
      await writeFile(path.join(dir, 'src', 'app', 'app.component.ts'), 'export class AppComponent {}');

      const blocker: Blocker = {
        package: '@angular/flex-layout',
        reason: 'deprecated',
        hard: false,
        details: 'Deprecated',
      };
      const rec = await computeRecommendation({
        projectRoot: dir,
        blocker,
        targetMajor: 16,
        targetCoreVersion: '16.2.12',
        registry: mockRegistry,
        rules: getBuiltInRules(),
      });

      expect(rec.recommendation).not.toBe('remove');
      expect(rec.recommendedFix).toBe('CSS flexbox/grid');
      expect(rec.usage?.summary).toContain('peer dependency of: [ngx-layout-wrapper]');
    });

    it('Fixture: used only in an scss @use/@import -> does not recommend remove', async () => {
      await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'app-scss-only',
          dependencies: { '@angular/core': '^15.2.0', '@angular/flex-layout': '^15.0.0-beta.42' },
        }),
      );
      await writeFile(path.join(dir, 'src', 'styles.scss'), `@use '@angular/flex-layout/mq' as mq;\n`);
      await writeFile(path.join(dir, 'src', 'app', 'app.component.ts'), 'export class AppComponent {}');

      const blocker: Blocker = {
        package: '@angular/flex-layout',
        reason: 'deprecated',
        hard: false,
        details: 'Deprecated',
      };
      const rec = await computeRecommendation({
        projectRoot: dir,
        blocker,
        targetMajor: 16,
        targetCoreVersion: '16.2.12',
        registry: mockRegistry,
        rules: getBuiltInRules(),
      });

      expect(rec.recommendation).not.toBe('remove');
      expect(rec.recommendedFix).toBe('CSS flexbox/grid');
      expect(rec.usage?.summary).toContain('style imports: [src/styles.scss]');
    });

    it('Fixture: truly unused across workspace, configs, styles, and peers -> recommends "remove the unused dependency" with high confidence', async () => {
      await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
      await mkdir(path.join(dir, 'projects', 'sub-app', 'src'), { recursive: true });
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'app-truly-unused',
          scripts: { build: 'ng build' },
          dependencies: { '@angular/core': '^15.2.0', '@angular/flex-layout': '^15.0.0-beta.42' },
        }),
      );
      await writeFile(path.join(dir, 'angular.json'), JSON.stringify({ projects: { app: {} } }));
      await writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {} } }));
      await writeFile(path.join(dir, 'src', 'styles.scss'), 'body { margin: 0; }');
      await writeFile(path.join(dir, 'src', 'app', 'app.component.ts'), 'export class AppComponent {}');
      await writeFile(path.join(dir, 'projects', 'sub-app', 'src', 'main.ts'), 'export const x = 1;');

      const blocker: Blocker = {
        package: '@angular/flex-layout',
        reason: 'deprecated',
        hard: false,
        details: 'Deprecated',
      };
      const rec = await computeRecommendation({
        projectRoot: dir,
        blocker,
        targetMajor: 16,
        targetCoreVersion: '16.2.12',
        registry: mockRegistry,
        rules: getBuiltInRules(),
      });

      expect(rec.recommendation).toBe('remove');
      expect(rec.recommendedFix).toBe('remove the unused dependency');
      expect(rec.confidence).toBe('high');
      expect(rec.runnerUp).toBe('CSS flexbox/grid, Tailwind CSS');
    });

    it('Fixture: unused in source but peer check cannot be done (missing node_modules and lockfile with other 3rd-party deps) -> medium confidence "appears unused, verify"', async () => {
      await mkdir(path.join(dir, 'src', 'app'), { recursive: true });
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'app-unverifiable-peers',
          dependencies: {
            '@angular/core': '^15.2.0',
            '@angular/flex-layout': '^15.0.0-beta.42',
            'mystery-ui-kit': '^2.0.0',
          },
        }),
      );
      await writeFile(path.join(dir, 'src', 'app', 'app.component.ts'), 'export class AppComponent {}');

      const blocker: Blocker = {
        package: '@angular/flex-layout',
        reason: 'deprecated',
        hard: false,
        details: 'Deprecated',
      };
      const rec = await computeRecommendation({
        projectRoot: dir,
        blocker,
        targetMajor: 16,
        targetCoreVersion: '16.2.12',
        registry: mockRegistry,
        rules: getBuiltInRules(),
      });

      expect(rec.recommendation).toBe('remove');
      expect(rec.recommendedFix).toBe('appears unused, verify');
      expect(rec.confidence).toBe('medium');
    });
  });
});

