import { describe, expect, it } from 'vitest';
import type { Blocker } from '../src/model.js';
import type { RegistryClient } from '../src/registry/client.js';
import { findAlternateCandidates } from '../src/recommend/alternates.js';
import { evaluateComplexity } from '../src/recommend/complexity.js';
import { computeRecommendation } from '../src/recommend/engine.js';
import { findRule, getBuiltInRules, type MigrationRule } from '../src/recommend/rules.js';

describe('complexity evaluation', () => {
  it('flags hard problem categories and assigns high complexity', () => {
    const complex = evaluateComplexity('ngx-echarts', undefined, 'Angular wrapper for ECharts and charts canvas');
    expect(complex.hasHardProblems).toBe(true);
    expect(complex.hardProblemCategories).toContain('charts');
    expect(complex.complexityLevel).toBe('high');
  });

  it('classifies simple primitives with low complexity', () => {
    const simple = evaluateComplexity('ngx-tooltip', undefined, 'Simple tooltip directive');
    expect(simple.hasHardProblems).toBe(false);
    expect(simple.isPresentational).toBe(true);
    expect(simple.complexityLevel).toBe('low');
  });
});

describe('rules and alternates', () => {
  it('loads built-in rules including @angular/flex-layout', () => {
    const rules = getBuiltInRules();
    const flex = findRule('@angular/flex-layout', rules);
    expect(flex).toBeDefined();
    expect(flex?.status).toBe('deprecated');
    expect(flex?.alternatives).toContain('Tailwind CSS');
  });

  it('filters alternates based on deny list', async () => {
    const mockRegistry = {
      packument: async () => undefined,
    } as unknown as RegistryClient;

    const rule: MigrationRule = {
      package: 'test-lib',
      alternatives: ['alt-1', 'alt-2', 'CSS flexbox'],
    };

    const alts = await findAlternateCandidates(
      'test-lib',
      16,
      '16.2.0',
      mockRegistry,
      rule,
      [],
      ['alt-2'],
    );

    const alt2 = alts.find((a) => a.name === 'alt-2');
    expect(alt2?.isAllowed).toBe(false);
    expect(alt2?.notes).toContain('alternates.deny');
  });
});

describe('recommendation engine resolution ladder', () => {
  const mockRegistry = {
    packument: async () => undefined,
  } as unknown as RegistryClient;

  it('recommends writing in codebase (inline) for small tooltip package', async () => {
    const blocker: Blocker = {
      package: 'ng2-tooltip-directive',
      reason: 'no-compatible-version',
      hard: true,
      details: 'No release for Angular 16',
    };

    const rec = await computeRecommendation({
      projectRoot: '/test',
      blocker,
      targetMajor: 16,
      targetCoreVersion: '16.2.12',
      registry: mockRegistry,
      rules: getBuiltInRules(),
    });

    expect(rec.recommendation).toBe('inline');
    expect(rec.confidence).toBe('high');
    expect(rec.runnerUp).toContain('alternate');
  });

  it('recommends alternate for flex-layout according to built-in rules', async () => {
    const blocker: Blocker = {
      package: '@angular/flex-layout',
      reason: 'no-compatible-version',
      hard: true,
      details: 'No release for Angular 16',
    };

    const rec = await computeRecommendation({
      projectRoot: '/test',
      blocker,
      targetMajor: 16,
      targetCoreVersion: '16.2.12',
      registry: mockRegistry,
      rules: getBuiltInRules(),
    });

    expect(rec.recommendation).toBe('alternate');
    expect(rec.confidence).toBe('high');
  });

  it('falls back to manual for unknown complex libraries without alternatives', async () => {
    const blocker: Blocker = {
      package: 'unknown-complex-editor',
      reason: 'no-compatible-version',
      hard: true,
      details: 'No release',
    };

    const rec = await computeRecommendation({
      projectRoot: '/test',
      blocker,
      targetMajor: 16,
      targetCoreVersion: '16.2.12',
      registry: mockRegistry,
      rules: [],
    });

    expect(rec.recommendation).toBe('manual');
    expect(rec.confidence).toBe('low');
  });
});
