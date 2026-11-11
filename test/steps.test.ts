import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Plan, PlannedStep } from '../src/model.js';
import {
  extractDecisionsFromFile,
  formatStepDocument,
  writePlanDocuments,
} from '../src/steps/writer.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('steps writer', () => {
  const sampleStep: PlannedStep = {
    index: 1,
    from: 15,
    to: 16,
    provisional: false,
    requirements: {
      major: 16,
      coreVersion: '16.2.12',
      node: '^16.14.0 || >=18.10.0',
      typescript: '>=4.9.3 <5.2.0',
      rxjs: '^7.4.0',
      zone: '~0.13.0',
      notes: ['ngcc was removed in 16'],
    },
    changes: [
      {
        name: '@angular/core',
        type: 'dependencies',
        current: '15.2.10',
        currentSpec: '^15.2.0',
        target: '16.2.12',
        targetSpec: '^16.2.12',
        reason: 'Target major 16',
        evidence: 'declared',
      },
    ],
    unchanged: [],
    heldBack: [],
    blockers: [
      {
        package: 'some-tooltip-lib',
        reason: 'no-compatible-version',
        hard: true,
        details: 'No release supports Angular 16',
        recommendation: 'inline',
      },
    ],
    resolution: { status: 'confirmed' },
    actions: ['Update packages with ng update'],
    risks: [],
    breakingChangesUrl: 'https://update.angular.io/?v=15.0-16.0',
  };

  const samplePlan: Plan = {
    startVersion: '15.2.10',
    fromMajor: 15,
    targetMajor: 16,
    steps: [sampleStep],
  };

  it('formats markdown step documents with headers, requirements, diffs and decisions', () => {
    const doc = formatStepDocument(sampleStep);
    expect(doc).toContain('# Step 1: Angular 15 to 16');
    expect(doc).toContain('- Node: ^16.14.0 || >=18.10.0');
    expect(doc).toContain('+ "@angular/core": "^16.2.12"');
    expect(doc).toContain('some-tooltip-lib');
    expect(doc).toContain('<!-- id: blocker-some-tooltip-lib -->');
    expect(doc).toContain('Status: pending. Run: npx ng-migrator approve 1');
  });

  it('writes step files and summary, and preserves ticked decisions across re-generation', async () => {
    // 1. Initial generation
    const res = await writePlanDocuments(dir, samplePlan);
    const stepFile = res.stepFiles[0]!;

    const initialContent = await readFile(stepFile, 'utf8');
    expect(initialContent).toContain('- [ ] Decide resolution for some-tooltip-lib');

    // 2. Simulate user checking a decision checkbox in the markdown file
    const checkedContent = initialContent.replace(
      '- [ ] Decide resolution for some-tooltip-lib',
      '- [x] Decide resolution for some-tooltip-lib',
    );
    await writePlanDocuments(dir, samplePlan); // should be stable

    // Extract decisions check
    const decisions = await extractDecisionsFromFile(stepFile);
    expect(decisions['blocker-some-tooltip-lib']).toBe(false);

    // Manually write the checked decision to the file
    const { writeFile } = await import('node:fs/promises');
    await writeFile(stepFile, checkedContent);

    // 3. Re-run writePlanDocuments
    await writePlanDocuments(dir, samplePlan);
    const reloadedContent = await readFile(stepFile, 'utf8');

    // The checked decision must be preserved!
    expect(reloadedContent).toContain('- [x] Decide resolution for some-tooltip-lib');

    // Scoped package decision test
    const scopedStep: PlannedStep = {
      ...sampleStep,
      blockers: [
        {
          package: '@angular/flex-layout',
          reason: 'no-compatible-version',
          hard: true,
          details: 'Deprecated and archived',
          recommendation: 'alternate',
        },
      ],
    };
    const scopedPlan: Plan = {
      ...samplePlan,
      steps: [scopedStep],
    };
    const scopedRes = await writePlanDocuments(dir, scopedPlan);
    const scopedFile = scopedRes.stepFiles[0]!;
    const scopedInit = await readFile(scopedFile, 'utf8');
    expect(scopedInit).toContain('<!-- id: blocker-@angular/flex-layout -->');

    const scopedChecked = scopedInit.replace(
      '- [ ] Decide resolution for @angular/flex-layout',
      '- [x] Decide resolution for @angular/flex-layout',
    );
    await writeFile(scopedFile, scopedChecked);
    const scopedDecisions = await extractDecisionsFromFile(scopedFile);
    expect(scopedDecisions['blocker-@angular/flex-layout']).toBe(true);

    await writePlanDocuments(dir, scopedPlan);
    const scopedReloaded = await readFile(scopedFile, 'utf8');
    expect(scopedReloaded).toContain('- [x] Decide resolution for @angular/flex-layout');
  });
});
