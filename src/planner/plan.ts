import semver from 'semver';
import type { ResolvedConfig } from '../config/config.js';
import { NgmError } from '../errors.js';
import type { Plan, PlannedStep, ProjectInfo, ResolutionCheck } from '../model.js';
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
}

export async function createPlan(options: PlanOptions): Promise<Plan> {
  const { project, targetMajor, registry, config, verifyResolution = true } = options;

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
    });

    let resolutionCheck: ResolutionCheck = { status: 'skipped' };
    if (verifyResolution && isFirstStep) {
      resolutionCheck = await verifyWithPackageManager({
        projectRoot: project.root,
        packageManager: config.packageManager,
        changes: stepResolution.changes,
        commandPrefix: typeof config.commandPrefix === 'string' ? config.commandPrefix : config.commandPrefix?.[String(toMajor)],
      });
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
    if (stepResolution.blockers.length > 0) {
      risks.push(`${stepResolution.blockers.length} dependency blocker(s) require resolution before this step.`);
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
