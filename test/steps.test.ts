import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Plan, PlannedStep } from '../src/model.js';
import {
  extractDecisionsFromFile,
  formatStepDocument,
  generateDecisionId,
  writePlanDocuments,
} from '../src/steps/writer.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('steps writer and decision tracking', () => {
  it('generates stable decision ids for scoped names, dots, hyphens and underscores', () => {
    const id1 = generateDecisionId('@scope/name');
    const id2 = generateDecisionId('pkg.name.js');
    const id3 = generateDecisionId('my-pkg-name');
    const id4 = generateDecisionId('my_pkg_name');

    expect(id1).toMatch(/^blocker-scope-name-[a-f0-9]{8}$/);
    expect(id2).toMatch(/^blocker-pkg-name-js-[a-f0-9]{8}$/);
    expect(id3).toMatch(/^blocker-my-pkg-name-[a-f0-9]{8}$/);
    expect(id4).toMatch(/^blocker-my-pkg-name-[a-f0-9]{8}$/);

    // Stable / deterministic
    expect(generateDecisionId('@scope/name')).toBe(id1);
    expect(generateDecisionId('pkg.name.js')).toBe(id2);
  });

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
        recommendedFix: 'Write replacement in project codebase',
        source: 'analysis',
        confidence: 'high',
        effort: '2 to 3 hours',
        runnerUp: 'alternate package',
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

  it('formats markdown step documents with declared compatible evidence label and recommendation fields', () => {
    const doc = formatStepDocument(sampleStep);
    expect(doc).toContain('# Step 1: Angular 15 to 16');
    expect(doc).toContain('- Node: ^16.14.0 || >=18.10.0');
    expect(doc).toContain('+ "@angular/core": "^16.2.12"');
    expect(doc).toContain('declared compatible');
    expect(doc).not.toContain('confirmed compatible');
    expect(doc).toContain('- Recommended fix: Write replacement in project codebase');
    expect(doc).toContain('- Source: analysis');
    expect(doc).toContain('- Confidence: high');
    expect(doc).toContain('- Estimated effort: 2 to 3 hours');
    expect(doc).toContain('- Runner-up: alternate package');
    expect(doc).toContain(`<!-- id: ${generateDecisionId('some-tooltip-lib')} -->`);
    expect(doc).toContain('Status: pending. Run: npx ng-migrator approve 1');
  });

  it('renders manifest diff preview keeping caret, tilde, and exact range styles, and renders ERESOLVE options', () => {
    const stepWithStylesAndConflict: PlannedStep = {
      ...sampleStep,
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
        {
          name: 'zone.js',
          type: 'dependencies',
          current: '0.12.0',
          currentSpec: '~0.12.0',
          target: '0.13.3',
          targetSpec: '~0.13.3',
          reason: 'Angular 16 requirement (~0.13.0)',
          evidence: 'declared',
        },
        {
          name: 'typescript',
          type: 'devDependencies',
          current: '4.9.5',
          currentSpec: '4.9.5',
          target: '5.1.6',
          targetSpec: '5.1.6',
          reason: 'Angular 16 requirement (>=4.9.3 <5.2.0)',
          evidence: 'declared',
        },
      ],
      blockers: [
        {
          package: 'legacy-chart',
          reason: 'peer-conflict',
          hard: true,
          details: 'ERESOLVE: legacy-chart@1.2.0 requires peer @angular/core@"^15.0.0" (found @angular/core@16.2.12).',
          options: [
            'Option 1 (Swap package): Replace legacy-chart with an Angular 16-compatible release or alternative library.',
            'Option 2 (Explicit override): Add "@angular/core": "^16.2.12" under "overrides" in package.json to force resolution.',
          ],
        },
      ],
    };

    const doc = formatStepDocument(stepWithStylesAndConflict);
    expect(doc).toContain('## Manifest changes (package.json preview)');
    expect(doc).toContain('- "@angular/core": "^15.2.0"\n+ "@angular/core": "^16.2.12"');
    expect(doc).toContain('- "zone.js": "~0.12.0"\n+ "zone.js": "~0.13.3"');
    expect(doc).toContain('- "typescript": "4.9.5"\n+ "typescript": "5.1.6"');
    expect(doc).toContain('### legacy-chart (peer-conflict)');
    expect(doc).toContain('1. Option 1 (Swap package): Replace legacy-chart');
    expect(doc).toContain('2. Option 2 (Explicit override): Add "@angular/core": "^16.2.12" under "overrides" in package.json');
  });

  it('preserves ticked decisions and reviewer notes across plan regeneration', async () => {
    // 1. Initial generation
    const res = await writePlanDocuments(dir, samplePlan);
    const stepFile = res.stepFiles[0]!;

    const initialContent = await readFile(stepFile, 'utf8');
    const stableId = generateDecisionId('some-tooltip-lib');
    expect(initialContent).toContain(`- [ ] Decide resolution for some-tooltip-lib (no-compatible-version) <!-- id: ${stableId} -->`);

    // 2. Simulate user ticking the decision and adding reviewer notes
    const editedContent = initialContent
      .replace(
        `- [ ] Decide resolution for some-tooltip-lib (no-compatible-version) <!-- id: ${stableId} -->`,
        `- [x] Decide resolution for some-tooltip-lib (no-compatible-version) <!-- id: ${stableId} -->`,
      )
      .replace(
        '<!-- reviewer-notes: start -->\n(Optional reviewer notes)\n<!-- reviewer-notes: end -->',
        '<!-- reviewer-notes: start -->\nReviewed by Team Lead. Inlining directive in src/app/shared.\n<!-- reviewer-notes: end -->',
      );

    await writeFile(stepFile, editedContent);

    // Verify extraction
    const extracted = await extractDecisionsFromFile(stepFile);
    expect(extracted.decisions[stableId]).toBe(true);
    expect(extracted.reviewerNotes).toBe('Reviewed by Team Lead. Inlining directive in src/app/shared.');

    // 3. Re-run writePlanDocuments
    await writePlanDocuments(dir, samplePlan);
    const reloadedContent = await readFile(stepFile, 'utf8');

    // Both ticked decision and reviewer notes must survive!
    expect(reloadedContent).toContain(`- [x] Decide resolution for some-tooltip-lib (no-compatible-version) <!-- id: ${stableId} -->`);
    expect(reloadedContent).toContain('Reviewed by Team Lead. Inlining directive in src/app/shared.');
  });

  it('migrates legacy blocker-<pkg> decision ids seamlessly', async () => {
    const legacyContent = `
## Decisions needed
- [x] Decide resolution for @angular/flex-layout (deprecated) <!-- id: blocker-@angular/flex-layout -->

## Reviewer notes
<!-- reviewer-notes: start -->
Legacy note
<!-- reviewer-notes: end -->
`;
    const stepFile = `${dir}/legacy-step.md`;
    await writeFile(stepFile, legacyContent);

    const extracted = await extractDecisionsFromFile(stepFile);
    const stableId = generateDecisionId('@angular/flex-layout');

    // Both legacy and new stable ID are true
    expect(extracted.decisions['blocker-@angular/flex-layout']).toBe(true);
    expect(extracted.decisions[stableId]).toBe(true);
    expect(extracted.reviewerNotes).toBe('Legacy note');
  });
});
