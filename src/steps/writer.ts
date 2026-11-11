import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plan, PlannedStep } from '../model.js';
import { pathExists } from '../platform/fs.js';
import { writeGeneratedText } from '../platform/text.js';
import {
  createState,
  readState,
  statePath,
  writeState,
  type MigratorState,
  type StepState,
} from '../state/state.js';
import { TOOL_VERSION } from '../version.js';

export interface WritePlanResult {
  stateFile: string;
  summaryFile: string;
  stepFiles: string[];
}

export function padStepNumber(index: number): string {
  return String(index).padStart(2, '0');
}

/** Generates a stable decision ID: slug plus short hash (8 hex chars). */
export function generateDecisionId(packageName: string, category: string = 'blocker'): string {
  const slug = packageName
    .replace(/^@/, '')
    .replace(/[/._]/g, '-')
    .toLowerCase();
  const hash = createHash('sha256').update(packageName).digest('hex').slice(0, 8);
  return `${category}-${slug}-${hash}`;
}

export function formatStepDocument(
  step: PlannedStep,
  stepState?: StepState,
  hasNodeModules: boolean = true,
): string {
  const lines: string[] = [];
  const status = stepState?.status ?? 'planned';
  const provisionalSuffix = step.provisional ? ' (provisional)' : '';

  lines.push(`# Step ${step.index}: Angular ${step.from} to ${step.to}${provisionalSuffix}`);
  lines.push('');
  lines.push(`Status: ${status} | Tool: ${TOOL_VERSION}`);
  lines.push('');

  lines.push('## Requirements');
  if (step.requirements.node) lines.push(`- Node: ${step.requirements.node}`);
  if (step.requirements.typescript) lines.push(`- TypeScript: ${step.requirements.typescript}`);
  if (step.requirements.rxjs) lines.push(`- RxJS: ${step.requirements.rxjs}`);
  if (step.requirements.zone) lines.push(`- zone.js: ${step.requirements.zone}`);
  for (const n of step.requirements.notes) {
    lines.push(`- Note: ${n}`);
  }
  lines.push('');

  lines.push('## Manifest changes (package.json preview)');
  if (step.changes.length === 0) {
    lines.push('_No direct package updates required._');
  } else {
    for (const c of step.changes) {
      lines.push(`- "${c.name}": "${c.currentSpec}"`);
      lines.push(`+ "${c.name}": "${c.targetSpec}"`);
    }
  }
  lines.push('');

  lines.push('## Dependency changes');
  if (step.changes.length === 0) {
    lines.push('_No package updates required._');
  } else {
    lines.push('| Package | Current | Target | Reason | Evidence |');
    lines.push('|---|---|---|---|---|');
    for (const c of step.changes) {
      let cur = c.current ?? c.currentSpec;
      if (!hasNodeModules && !c.current) {
        cur = `${c.currentSpec} (installed version unknown, lockfile used)`;
      }
      const evidenceLabel = c.evidence === 'verified' ? 'verified by build' : 'declared compatible';
      lines.push(`| ${c.name} | ${cur} | ${c.target} | ${c.reason} | ${evidenceLabel} |`);
    }
  }
  lines.push('');

  if (step.heldBack.length > 0) {
    lines.push('## Held-back packages (need later Angular versions)');
    lines.push('| Package | Candidate | Reason |');
    lines.push('|---|---|---|');
    for (const h of step.heldBack) {
      lines.push(`| ${h.name} | ${h.version} | ${h.reason} |`);
    }
    lines.push('');
  }

  lines.push('## Blockers');
  if (step.blockers.length === 0) {
    lines.push('None detected.');
  } else {
    for (const b of step.blockers) {
      const typeLabel = b.hard ? '' : ' [soft / unmaintained]';
      lines.push(`### ${b.package} (${b.reason})${typeLabel}`);
      if (b.evidence) {
        const evLabel = b.evidence === 'verified' ? 'verified by build' : 'declared compatible';
        lines.push(`- Evidence: ${evLabel}`);
      }
      if (b.recommendedFix) {
        lines.push(`- Recommended fix: ${b.recommendedFix}`);
      } else if (b.recommendation) {
        lines.push(`- Recommended fix: ${b.recommendation}`);
      }
      if (b.source) {
        lines.push(`- Source: ${b.source}`);
      }
      if (b.confidence) {
        lines.push(`- Confidence: ${b.confidence}`);
      }
      lines.push(`- Reasoning: ${b.details}`);
      if (b.riskNote) {
        lines.push(`- Risk note: ${b.riskNote}`);
      }
      if (b.effort) {
        lines.push(`- Estimated effort: ${b.effort}`);
      }
      if (b.runnerUp) {
        lines.push(`- Runner-up: ${b.runnerUp}`);
      }
      if (b.usage) {
        lines.push(`- Usage footprint: ${b.usage.summary}`);
      }
      if (b.current) {
        lines.push(`- Current version: ${b.current}`);
      }
      if (b.lastCompatible) {
        lines.push(`- Last compatible release: ${b.lastCompatible}`);
      }
      lines.push('');
    }
  }
  lines.push('');

  if (step.risks.length > 0) {
    lines.push('## Risks');
    for (const r of step.risks) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  lines.push('## Planned actions');
  step.actions.forEach((act, idx) => {
    lines.push(`${idx + 1}. ${act}`);
  });
  lines.push('');

  lines.push('## Breaking changes reference');
  lines.push(`Angular official update guide: ${step.breakingChangesUrl}`);
  lines.push('');

  lines.push('## Decisions needed');
  if (step.blockers.length === 0) {
    const confirmId = 'confirm-ready-to-proceed';
    const checked = stepState?.decisions[confirmId] ? 'x' : ' ';
    lines.push(`- [${checked}] Confirm ready to proceed <!-- id: ${confirmId} -->`);
  } else {
    for (const b of step.blockers) {
      const stableId = generateDecisionId(b.package, 'blocker');
      const legacyId = `blocker-${b.package}`;
      const checked = (stepState?.decisions[stableId] ?? stepState?.decisions[legacyId]) ? 'x' : ' ';
      lines.push(`- [${checked}] Decide resolution for ${b.package} (${b.reason}) <!-- id: ${stableId} -->`);
    }
  }
  lines.push('');

  lines.push('## Reviewer notes');
  lines.push('<!-- reviewer-notes: start -->');
  lines.push(stepState?.reviewerNotes ? stepState.reviewerNotes : '(Optional reviewer notes)');
  lines.push('<!-- reviewer-notes: end -->');
  lines.push('');

  lines.push('## Approval');
  if (status === 'approved') {
    lines.push(`Status: approved at ${stepState?.approvedAt ?? 'unknown'}.`);
  } else {
    lines.push(`Status: pending. Run: npx ng-migrator approve ${step.index}`);
  }
  lines.push('');

  return lines.join('\n');
}

export function formatSummary(plan: Plan, state: MigratorState): string {
  const lines: string[] = [];

  lines.push('# Angular Migration Plan Summary');
  lines.push('');
  lines.push(`Starting Angular Version: ${plan.startVersion} (major ${plan.fromMajor})`);
  lines.push(`Target Angular Major: ${plan.targetMajor}`);
  lines.push(`Total Steps: ${plan.steps.length}`);
  lines.push(`Status: ${state.steps.every((s) => s.status === 'done') ? 'completed' : 'in-progress'}`);
  lines.push('');

  lines.push('## Step Overview');
  lines.push('| Step | Range | Status | Blockers | Changes |');
  lines.push('|---|---|---|---|---|');

  for (const step of plan.steps) {
    const sState = state.steps.find((s) => s.index === step.index);
    const status = sState?.status ?? 'planned';
    lines.push(
      `| [Step ${step.index}](./steps/${padStepNumber(step.index)}-angular-${step.from}-to-${step.to}.md) | ${step.from} -> ${step.to} | ${status} | ${step.blockers.length} | ${step.changes.length} |`,
    );
  }
  lines.push('');

  lines.push('## Next Steps');
  const nextPending = state.steps.find((s) => s.status !== 'done');
  if (nextPending) {
    lines.push(`1. Review the step document: \`.ng-migrator/steps/${padStepNumber(nextPending.index)}-angular-${nextPending.from}-to-${nextPending.to}.md\``);
    lines.push(`2. Resolve any blockers and decisions.`);
    lines.push(`3. Approve the step: \`npx ng-migrator approve ${nextPending.index}\``);
  } else {
    lines.push('All steps completed!');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Parses existing ticked decisions and reviewer notes from a step document file.
 * Handles both new stable IDs and legacy blocker-<pkg> IDs.
 */
export async function extractDecisionsFromFile(filePath: string): Promise<{
  decisions: Record<string, boolean>;
  reviewerNotes?: string;
}> {
  const decisions: Record<string, boolean> = {};
  let reviewerNotes: string | undefined;

  if (!(await pathExists(filePath))) return { decisions };

  try {
    const text = await readFile(filePath, 'utf8');

    // 1. Parse decision checkboxes
    const regex = /- \[([ xX])\] (.*?)<!-- id: ([^\s>]+) -->/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const isChecked = match[1]?.toLowerCase() === 'x';
      const id = match[3]!;
      decisions[id] = isChecked;

      // Migration: If this was a legacy blocker-<pkg> ID, also map to the stable generated ID
      if (id.startsWith('blocker-')) {
        const legacyPkg = id.slice('blocker-'.length);
        const stableId = generateDecisionId(legacyPkg, 'blocker');
        decisions[stableId] = isChecked;
      }
    }

    // 2. Parse reviewer notes between markers
    const notesMatch = /<!-- reviewer-notes: start -->\s*([\s\S]*?)\s*<!-- reviewer-notes: end -->/.exec(text);
    if (notesMatch && notesMatch[1]) {
      const candidateNotes = notesMatch[1].trim();
      if (candidateNotes !== '(Optional reviewer notes)' && candidateNotes !== '') {
        reviewerNotes = candidateNotes;
      }
    }
  } catch {
    // ignore
  }

  return { decisions, reviewerNotes };
}

export async function writePlanDocuments(
  root: string,
  plan: Plan,
  hasNodeModules: boolean = true,
): Promise<WritePlanResult> {
  const baseDir = path.join(root, '.ng-migrator');
  const stepsDir = path.join(baseDir, 'steps');
  await mkdir(stepsDir, { recursive: true });

  // Read existing state or create new
  const existingState = await readState(root);
  const state: MigratorState = existingState ?? createState();
  state.startVersion = plan.startVersion;
  state.targetMajor = plan.targetMajor;

  const stepFiles: string[] = [];

  for (const step of plan.steps) {
    const filename = `${padStepNumber(step.index)}-angular-${step.from}-to-${step.to}.md`;
    const fullPath = path.join(stepsDir, filename);

    // Find existing step state or initialize
    let stepState = state.steps.find((s) => s.index === step.index);
    const { decisions: existingDecisions, reviewerNotes: existingNotes } =
      await extractDecisionsFromFile(fullPath);

    if (!stepState) {
      stepState = {
        index: step.index,
        from: step.from,
        to: step.to,
        status: 'planned',
        files: { created: [], changed: [], deleted: [] },
        verification: [],
        decisions: existingDecisions,
        reviewerNotes: existingNotes,
      };
      state.steps.push(stepState);
    } else {
      // Merge decisions and reviewer notes preserving user input
      stepState.decisions = { ...stepState.decisions, ...existingDecisions };
      if (existingNotes) {
        stepState.reviewerNotes = existingNotes;
      }
    }

    const docContent = formatStepDocument(step, stepState, hasNodeModules);
    await writeGeneratedText(fullPath, docContent);
    stepFiles.push(fullPath);
  }

  // Update summary.md and state.json
  const summaryContent = formatSummary(plan, state);
  const summaryFile = path.join(baseDir, 'summary.md');
  await writeGeneratedText(summaryFile, summaryContent);

  await writeState(root, state);

  return {
    stateFile: statePath(root),
    summaryFile,
    stepFiles,
  };
}
