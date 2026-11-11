import semver from 'semver';
import type {
  Blocker,
  HeldBack,
  PackageChange,
  ProjectInfo,
  StepRequirements,
} from '../model.js';
import { computeRecommendation } from '../recommend/engine.js';
import { getBuiltInRules, type MigrationRule } from '../recommend/rules.js';
import { inAngularMajor, stableVersionsDesc, type RegistryClient } from '../registry/client.js';
import { preserveRangeStyle, satisfiesAngularPeer } from './range.js';

export interface ResolveStepOptions {
  project: ProjectInfo;
  requirements: StepRequirements;
  registry: RegistryClient;
  pinned?: Record<string, string>;
  neverTouch?: string[];
  rules?: readonly MigrationRule[];
  alternatesAllow?: readonly string[];
  alternatesDeny?: readonly string[];
}

export interface StepResolution {
  changes: PackageChange[];
  unchanged: string[];
  heldBack: HeldBack[];
  blockers: Blocker[];
}

export async function resolveStepDependencies(
  options: ResolveStepOptions,
): Promise<StepResolution> {
  const { project, requirements, registry, pinned = {}, neverTouch = [] } = options;
  const changes: PackageChange[] = [];
  const unchanged: string[] = [];
  const heldBack: HeldBack[] = [];
  const blockers: Blocker[] = [];

  const neverTouchSet = new Set(neverTouch);
  const targetMajor = requirements.major;
  const coreVersion = requirements.coreVersion;

  for (const dep of project.dependencies) {
    if (neverTouchSet.has(dep.name)) {
      unchanged.push(dep.name);
      continue;
    }

    // Pinned version constraint
    if (pinned[dep.name]) {
      const pin = pinned[dep.name]!;
      changes.push({
        name: dep.name,
        type: dep.type,
        current: dep.installed,
        currentSpec: dep.declared,
        target: pin,
        targetSpec: pin,
        reason: 'Pinned in ng-migrator.config.json',
        evidence: 'declared',
      });
      continue;
    }

    // Angular framework / devkit packages
    if (dep.name.startsWith('@angular/') || dep.name.startsWith('@angular-devkit/')) {
      const pack = await registry.packument(dep.name);
      if (!pack) {
        blockers.push({
          package: dep.name,
          reason: 'unknown',
          hard: true,
          details: `Package ${dep.name} not found on npm registry.`,
          current: dep.installed ?? dep.declared,
        });
        continue;
      }
      const versions = stableVersionsDesc(pack).filter((v) => inAngularMajor(v, targetMajor));
      if (versions.length === 0) {
        // Some optional packages might not have a release in this major
        blockers.push({
          package: dep.name,
          reason: 'no-compatible-version',
          hard: true,
          details: `No release of ${dep.name} found for Angular ${targetMajor}.`,
          current: dep.installed ?? dep.declared,
        });
        continue;
      }
      const targetVersion = versions[0]!;
      changes.push({
        name: dep.name,
        type: dep.type,
        current: dep.installed,
        currentSpec: dep.declared,
        target: targetVersion,
        targetSpec: preserveRangeStyle(targetVersion, dep.declared),
        reason: `Target major ${targetMajor}`,
        evidence: 'declared',
      });
      continue;
    }

    // TypeScript
    if (dep.name === 'typescript' && requirements.typescript) {
      const pack = await registry.packument('typescript');
      if (pack) {
        const versions = stableVersionsDesc(pack).filter((v) =>
          semver.satisfies(v, requirements.typescript!),
        );
        if (versions.length > 0) {
          const target = versions[0]!;
          changes.push({
            name: dep.name,
            type: dep.type,
            current: dep.installed,
            currentSpec: dep.declared,
            target,
            targetSpec: preserveRangeStyle(target, dep.declared),
            reason: `Required by Angular ${targetMajor} (${requirements.typescript})`,
            evidence: 'declared',
          });
          continue;
        }
      }
    }

    // RxJS
    if (dep.name === 'rxjs' && requirements.rxjs) {
      const pack = await registry.packument('rxjs');
      if (pack) {
        const versions = stableVersionsDesc(pack).filter((v) =>
          semver.satisfies(v, requirements.rxjs!),
        );
        if (versions.length > 0) {
          const target = versions[0]!;
          changes.push({
            name: dep.name,
            type: dep.type,
            current: dep.installed,
            currentSpec: dep.declared,
            target,
            targetSpec: preserveRangeStyle(target, dep.declared),
            reason: `Required by Angular ${targetMajor} (${requirements.rxjs})`,
            evidence: 'declared',
          });
          continue;
        }
      }
    }

    // zone.js
    if (dep.name === 'zone.js' && requirements.zone) {
      const pack = await registry.packument('zone.js');
      if (pack) {
        const versions = stableVersionsDesc(pack).filter((v) =>
          semver.satisfies(v, requirements.zone!),
        );
        if (versions.length > 0) {
          const target = versions[0]!;
          changes.push({
            name: dep.name,
            type: dep.type,
            current: dep.installed,
            currentSpec: dep.declared,
            target,
            targetSpec: preserveRangeStyle(target, dep.declared),
            reason: `Required by Angular ${targetMajor} (${requirements.zone})`,
            evidence: 'declared',
          });
          continue;
        }
      }
    }

    // Third-party package: check peer dependencies
    const pack = await registry.packument(dep.name);
    if (!pack) {
      unchanged.push(dep.name);
      continue;
    }

    const allStable = stableVersionsDesc(pack);

    // Look for newer releases that require Angular > targetMajor (held back)
    for (const v of allStable) {
      const meta = pack.versions[v];
      const peer = meta?.peerDependencies?.['@angular/core'];
      if (peer) {
        const minV = semver.minVersion(peer);
        if (minV && minV.major > targetMajor) {
          heldBack.push({
            name: dep.name,
            version: v,
            reason: `Requires @angular/core ${peer} (needs Angular ${minV.major}+)`,
          });
          break; // record newest held back
        }
      }
    }

    // Propose newest version compatible with target Angular
    const compatible = allStable.filter((v) => {
      const meta = pack.versions[v];
      return satisfiesAngularPeer(meta?.peerDependencies, coreVersion, targetMajor);
    });

    if (compatible.length > 0) {
      const targetVersion = compatible[0]!;
      const meta = pack.versions[targetVersion];
      const currentVersion = dep.installed ?? semver.minVersion(dep.declared)?.version;

      if (currentVersion && semver.eq(currentVersion, targetVersion)) {
        unchanged.push(dep.name);
      } else {
        changes.push({
          name: dep.name,
          type: dep.type,
          current: dep.installed,
          currentSpec: dep.declared,
          target: targetVersion,
          targetSpec: preserveRangeStyle(targetVersion, dep.declared),
          reason: `Peer range supports Angular ${targetMajor}`,
          evidence: 'declared',
          deprecated: meta?.deprecated,
        });
      }
    } else {
      // Check if it actually declares an Angular peer dependency
      const hasAngularPeer = allStable.some(
        (v) => pack.versions[v]?.peerDependencies?.['@angular/core'] !== undefined,
      );

      if (hasAngularPeer) {
        // Find last version that supported targetMajor - 1
        const lastCompat = allStable.find((v) =>
          satisfiesAngularPeer(pack.versions[v]?.peerDependencies, `${targetMajor - 1}.99.99`, targetMajor - 1),
        );

        blockers.push({
          package: dep.name,
          reason: 'no-compatible-version',
          hard: true,
          details: `No release of ${dep.name} supports @angular/core ${coreVersion}.`,
          current: dep.installed ?? dep.declared,
          lastCompatible: lastCompat,
        });
      } else {
        // Package does not have Angular peer dependencies (e.g. lodash, date-fns)
        unchanged.push(dep.name);
      }
    }
  }

  // Also check for View Engine suspects when targeting Angular >= 16 (where ngcc was removed)
  if (targetMajor >= 16) {
    for (const veName of project.viewEngineSuspects) {
      if (!blockers.some((b) => b.package === veName)) {
        blockers.unshift({
          package: veName,
          reason: 'ivy-or-ngcc',
          hard: true,
          details: `${veName} was compiled for View Engine and relies on ngcc, which was removed in Angular 16.`,
          current: project.dependencies.find((d) => d.name === veName)?.installed,
        });
      }
    }
  }

  // Enrich blockers with recommendations
  const activeRules = options.rules ?? getBuiltInRules();
  for (const b of blockers) {
    const rec = await computeRecommendation({
      projectRoot: project.root,
      blocker: b,
      targetMajor,
      targetCoreVersion: coreVersion,
      registry,
      rules: activeRules,
      allowList: options.alternatesAllow,
      denyList: options.alternatesDeny,
    });
    b.recommendation = rec.recommendation;
    b.confidence = rec.confidence;
    b.effort = rec.effort;
    b.runnerUp = rec.runnerUp;
    if (!b.details.includes('Recommendation:')) {
      b.details = `${b.details} ${rec.reasoning}`;
    }
  }

  return {
    changes,
    unchanged,
    heldBack,
    blockers,
  };
}
