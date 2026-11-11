import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plan, PlannedStep } from '../model.js';
import { pathExists } from '../platform/fs.js';
import { writeGeneratedText } from '../platform/text.js';
import { createState, readState, statePath, writeState, type MigratorState, type StepState } from '../state/state.js';
import { TOOL_VERSION } from '../version.js';

export interface WritePlanResult {
  stateFile: string;
  summaryFile: string;
  stepFiles: string[];
}

function padStepNumber(index: number): string {
  return String(index).padStart(2, '0');
}

export function formatStepDocument(step: PlannedStep, stepState?: StepState): string {
  const lines: string[] = [];
  const status = stepState?.status ?? 'planned';
  const provisionalTag = step.provisional ? ' (provisional)' : '';

  lines.push(`# Step ${step.index}: Angular ${step.from} to ${step.to}${provisionalTag}`);
  lines.push('');
  lines.push(`Status: ${status} | Tool: ${TOOL_VERSION}`);
  lines.push('');

  lines.push('## Requirements');
  lines.push(`- Node: ${step.requirements.node ?? 'any'}`);
  lines.push(`- TypeScript: ${step.requirements.typescript ?? 'per Angular requirements'}`);
  lines.push(`- RxJS: ${step.requirements.rxjs ?? 'per Angular requirements'}`);
  lines.push(`- zone.js: ${step.requirements.zone ?? 'per Angular requirements'}`);
  if (step.requirements.notes.length > 0) {
    for (const note of step.requirements.notes) {
      lines.push(`- Note: ${note}`);
    }
  }
  lines.push('');

  lines.push('## Manifest changes (package.json preview)');
  if (step.changes.length === 0) {
    lines.push('_No package updates required._');
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
      const cur = c.current ?? c.currentSpec;
      lines.push(`| ${c.name} | ${cur} | ${c.target} | ${c.reason} | ${c.evidence} |`);
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
      lines.push(`### ${b.package} (${b.reason})`);
      lines.push(`- Details: ${b.details}`);
      if (b.current) lines.push(`- Current: ${b.current}`);
      if (b.lastCompatible) lines.push(`- Last compatible version: ${b.lastCompatible}`);
      if (b.recommendation) lines.push(`- Recommendation: ${b.recommendation}`);
      lines.push('');
    }
  }
  lines.push('');

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
    lines.push('- [ ] Confirm ready to proceed');
  } else {
    for (const b of step.blockers) {
      const decisionKey = `blocker-${b.package}`;
      const checked = stepState?.decisions[decisionKey] ? 'x' : ' ';
      lines.push(`- [${checked}] Decide resolution for ${b.package} (${b.reason}) <!-- id: ${decisionKey} -->`);
    }
  }
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

/** Parses existing ticked decisions from a step document file if it exists. */
export async function extractDecisionsFromFile(filePath: string): Promise<Record<string, boolean>> {
  const decisions: Record<string, boolean> = {};
  if (!(await pathExists(filePath))) return decisions;

  try {
    const text = await readFile(filePath, 'utf8');
    const regex = /- \[([ xX])\] (.*?)<!-- id: ([\w-]+) -->/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const isChecked = match[1]?.toLowerCase() === 'x';
      const id = match[3]!;
      decisions[id] = isChecked;
    }
  } catch {
    // ignore
  }

  return decisions;
}

export async function writePlanDocuments(root: string, plan: Plan): Promise<WritePlanResult> {
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
    const existingDecisions = await extractDecisionsFromFile(fullPath);

    if (!stepState) {
      stepState = {
        index: step.index,
        from: step.from,
        to: step.to,
        status: 'planned',
        files: { created: [], changed: [], deleted: [] },
        verification: [],
        decisions: existingDecisions,
      };
      state.steps.push(stepState);
    } else {
      // Merge decisions preserving user input
      stepState.decisions = { ...stepState.decisions, ...existingDecisions };
    }

    const docContent = formatStepDocument(step, stepState);
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
