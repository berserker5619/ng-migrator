import semver from 'semver';
import type { ResolvedConfig } from '../config/config.js';
import { NgmError } from '../errors.js';
import type { Plan, PlannedStep, ProjectInfo, ResolutionCheck } from '../model.js';
import { loadRules } from '../recommend/rules.js';
import type { RegistryClient } from '../registry/client.js';
import { resolveStepDependencies } from '../resolver/resolve.js';
import { verifyWithPackageManager } from '../resolver/verify.js';
import { getStepRequirements } from './metadata.js';

export interface PlanOptions {
  project: ProjectInfo;
  targetMajor: number;
  registry: RegistryClient;
  config: ResolvedConfig;
  verifyResolution?: boolean;
  onNotice?: (message: string) => void;
  now?: number;
  clock?: () => Date;
}

export async function createPlan(options: PlanOptions): Promise<Plan> {
  const { project, targetMajor, registry, config, verifyResolution = true, onNotice, now, clock } = options;

  const currentVersion = project.angular.version;
  const currentMajor = project.angular.major;

  if (!currentVersion || currentMajor === undefined) {
    throw new NgmError('NGM-3007', 'Could not detect an installed or declared @angular/core version.', {
      hint: 'Ensure this is an Angular project with @angular/core in dependencies.',
    });
  }

  if (targetMajor <= currentMajor) {
    throw new NgmError(
      'NGM-2002',
      `Target major version ${targetMajor} must be greater than current major ${currentMajor}.`,
      { hint: 'ng-migrator only plans forward upgrades (n-1 to n).' },
    );
  }

  const steps: PlannedStep[] = [];
  const numSteps = targetMajor - currentMajor;
  const removedAtStep = new Map<string, number>();

  for (let i = 0; i < numSteps; i++) {
    const fromMajor = currentMajor + i;
    const toMajor = fromMajor + 1;
    const isFirstStep = i === 0;
    const isProvisional = !isFirstStep;

    const requirements = await getStepRequirements(toMajor, registry);

    // Check same-major patch for step 1
    let samePatch: string | undefined;
    if (isFirstStep) {
      const corePack = await registry.packument('@angular/core');
      if (corePack) {
        const patchVersions = Object.keys(corePack.versions)
          .filter((v) => semver.major(v) === currentMajor && semver.prerelease(v) === null)
          .sort(semver.rcompare);
        if (patchVersions.length > 0 && semver.gt(patchVersions[0]!, currentVersion)) {
          samePatch = patchVersions[0];
        }
      }
    }

    const stepResolution = await resolveStepDependencies({
      project,
      requirements,
      registry,
      pinned: config.pinned,
      neverTouch: config.neverTouch,
      rules: await loadRules(config.rules, project.root),
      alternatesAllow: config.alternates.allow,
      alternatesDeny: config.alternates.deny,
      unmaintainedThresholdMonths: config.unmaintainedThresholdMonths,
      now,
      clock,
    });

    let resolutionCheck: ResolutionCheck = { status: 'skipped', packageManager: config.packageManager };
    if (verifyResolution && isFirstStep) {
      resolutionCheck = await verifyWithPackageManager({
        projectRoot: project.root,
        packageManager: config.packageManager,
        changes: stepResolution.changes,
        timeoutMs: config.resolutionTimeoutMs,
        ...(onNotice ? { onNotice } : {}),
      });
    }

    if (resolutionCheck.status === 'conflict') {
      const overrideKey =
        config.packageManager === 'yarn'
          ? 'resolutions'
          : config.packageManager === 'pnpm'
            ? 'pnpm.overrides'
            : 'overrides';

      const conflicts = resolutionCheck.conflicts ?? [];
      if (conflicts.length > 0) {
        for (const conflict of conflicts) {
          const pkgName = conflict.requiredBy.replace(/@[^@]+$/, '');
          const depInfo = project.dependencies.find((d) => d.name === pkgName);
          const dependencyKind = depInfo?.type === 'devDependencies' ? 'dev-only' : 'runtime';
          const optionsList = [
            `Swap ${pkgName} for a compatible package or version supporting ${conflict.peer} in Angular ${toMajor}.`,
            `Add an explicit override in package.json under "${overrideKey}" for "${conflict.peer}".`,
          ];
          const conflictDetails = `Peer dependency conflict (${config.packageManager}): ${conflict.requiredBy} requires peer ${conflict.peer}@"${conflict.range}"${conflict.found ? `, but found ${conflict.found}` : ''}.`;

          const existing = stepResolution.blockers.find(
            (b) => b.package === pkgName && b.reason === 'peer-conflict',
          );
          if (!existing) {
            stepResolution.blockers.push({
              package: pkgName,
              reason: 'peer-conflict',
              hard: true,
              dependencyKind,
              details: conflictDetails,
              recommendedFix: `Swap ${pkgName} or add an explicit override in package.json (${overrideKey})`,
              source: 'analysis',
              confidence: 'high',
              effort: '15 to 30 minutes',
              runnerUp: `Add explicit override in package.json under "${overrideKey}"`,
              options: optionsList,
            });
          }
        }
      } else {
        stepResolution.blockers.push({
          package: 'peer-resolution',
          reason: 'peer-conflict',
          hard: true,
          dependencyKind: 'runtime',
          details: resolutionCheck.detail ?? 'Package manager reported peer dependency conflict during resolution check.',
          recommendedFix: `Swap conflicting package or add an explicit override in package.json (${overrideKey})`,
          source: 'analysis',
          confidence: 'medium',
          effort: '15 to 30 minutes',
          runnerUp: `Add explicit override in package.json under "${overrideKey}"`,
          options: [
            'Swap the conflicting package for a compatible alternative.',
            `Add an explicit override in package.json under "${overrideKey}".`,
          ],
        });
      }
    }

    // If a package had a "remove" recommendation at an earlier step n, do not repeat it as a blocker
    // at later steps; instead record that this step depends on the decision at step n.
    const dependsOnDecisions: Array<{ package: string; stepIndex: number }> = [];
    if (removedAtStep.size > 0) {
      for (const b of stepResolution.blockers) {
        const originStep = removedAtStep.get(b.package);
        if (originStep !== undefined) {
          dependsOnDecisions.push({ package: b.package, stepIndex: originStep });
        }
      }
      stepResolution.blockers = stepResolution.blockers.filter((b) => !removedAtStep.has(b.package));
      stepResolution.changes = stepResolution.changes.filter((c) => !removedAtStep.has(c.name));
      stepResolution.heldBack = stepResolution.heldBack.filter((h) => !removedAtStep.has(h.name));
    }

    for (const b of stepResolution.blockers) {
      if (b.recommendation === 'remove' && !removedAtStep.has(b.package)) {
        removedAtStep.set(b.package, i + 1);
      }
    }

    const actions: string[] = [];
    if (samePatch) {
      actions.push(`Update to latest patch release of current major (Angular ${samePatch})`);
    }
    actions.push(`Update @angular/* packages and dependencies to Angular ${toMajor}`);
    if (toMajor === 16 && project.ngccScripts.length > 0) {
      actions.push(`Remove ngcc calls from package.json scripts (${project.ngccScripts.join(', ')})`);
    }

    const risks: string[] = [];
    const hardCount = stepResolution.blockers.filter((b) => b.hard).length;
    if (hardCount > 0) {
      risks.push(`${hardCount} hard dependency blocker(s) require resolution before this step.`);
    }
    for (const b of stepResolution.blockers) {
      if (b.riskNote) {
        risks.push(b.riskNote);
      }
    }
    for (const d of dependsOnDecisions) {
      risks.push(`${d.package}: depends on the decision at step ${d.stepIndex}.`);
    }
    if (resolutionCheck.status === 'conflict') {
      risks.push('Package manager reported peer dependency conflicts during resolution check.');
    }

    steps.push({
      index: i + 1,
      from: fromMajor,
      to: toMajor,
      provisional: isProvisional,
      requirements,
      samePatch,
      changes: stepResolution.changes,
      unchanged: stepResolution.unchanged,
      heldBack: stepResolution.heldBack,
      blockers: stepResolution.blockers,
      ...(dependsOnDecisions.length > 0 ? { dependsOnDecisions } : {}),
      resolution: resolutionCheck,
      actions,
      risks,
      breakingChangesUrl: `https://update.angular.io/?v=${fromMajor}.0-${toMajor}.0`,
    });
  }

  return {
    startVersion: currentVersion,
    fromMajor: currentMajor,
    targetMajor,
    steps,
  };
}
