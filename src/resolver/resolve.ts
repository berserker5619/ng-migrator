import semver from 'semver';
import type {
  Blocker,
  HeldBack,
  PackageChange,
  ProjectInfo,
  StepRequirements,
} from '../model.js';
import { computeRecommendation } from '../recommend/engine.js';
import { findRule, getBuiltInRules, type MigrationRule } from '../recommend/rules.js';
import {
  allVersionsDesc,
  inAngularMajor,
  type Packument,
  type RegistryClient,
} from '../registry/client.js';
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
  unmaintainedThresholdMonths?: number;
  now?: number;
}

export interface StepResolution {
  changes: PackageChange[];
  unchanged: string[];
  heldBack: HeldBack[];
  blockers: Blocker[];
}

export function isPackageUnmaintained(
  pack: Packument,
  version: string,
  rule: MigrationRule | undefined,
  thresholdMonths: number = 18,
  nowMs: number = Date.now(),
  targetMajor?: number,
): boolean {
  if (rule?.status === 'deprecated' || rule?.status === 'abandoned') {
    return true;
  }
  if (rule?.lastReleaseFor !== undefined && (targetMajor === undefined || targetMajor >= rule.lastReleaseFor)) {
    return true;
  }
  const meta = pack.versions[version];
  const dateStr = meta?.releaseDate ?? pack.time?.[version] ?? pack.time?.modified ?? pack.modified;
  if (dateStr) {
    const timeMs = new Date(dateStr).getTime();
    if (!Number.isNaN(timeMs)) {
      const diffMonths = (nowMs - timeMs) / (1000 * 60 * 60 * 24 * 30.4375);
      if (diffMonths >= thresholdMonths) {
        return true;
      }
    }
  }
  return false;
}

export async function resolveStepDependencies(
  options: ResolveStepOptions,
): Promise<StepResolution> {
  const {
    project,
    requirements,
    registry,
    pinned = {},
    neverTouch = [],
    unmaintainedThresholdMonths = 18,
    now = Date.now(),
  } = options;
  const changes: PackageChange[] = [];
  const unchanged: string[] = [];
  const heldBack: HeldBack[] = [];
  const blockers: Blocker[] = [];

  const neverTouchSet = new Set(neverTouch);
  const targetMajor = requirements.major;
  const coreVersion = requirements.coreVersion;
  const activeRules = options.rules ?? getBuiltInRules();

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

    const rule = findRule(dep.name, activeRules);

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

      const allReleases = allVersionsDesc(pack);
      const versions = allReleases.filter((v) => {
        const meta = pack.versions[v];
        if (inAngularMajor(v, targetMajor)) {
          return satisfiesAngularPeer(meta?.peerDependencies, coreVersion, targetMajor, v);
        }
        const hasExplicitAngularPeer =
          meta?.peerDependencies?.['@angular/core'] !== undefined ||
          meta?.peerDependencies?.['@angular/common'] !== undefined;
        return hasExplicitAngularPeer && satisfiesAngularPeer(meta?.peerDependencies, coreVersion, targetMajor, v);
      });

      if (versions.length === 0) {
        blockers.push({
          package: dep.name,
          reason: 'no-compatible-version',
          hard: true,
          details: `No release of ${dep.name} found for Angular ${targetMajor}.`,
          current: dep.installed ?? dep.declared,
        });
        continue;
      }

      // Prefer stable release if available, otherwise prerelease
      const targetVersion = versions.find((v) => semver.prerelease(v) === null) ?? versions[0]!;
      const meta = pack.versions[targetVersion];
      const isDeprecated = Boolean(meta?.deprecated);
      const isUnmaint = isPackageUnmaintained(pack, targetVersion, rule, unmaintainedThresholdMonths, now, targetMajor);

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
        unmaintained: isUnmaint,
      });

      if (isDeprecated || isUnmaint) {
        const reason = isDeprecated ? 'deprecated' : 'unmaintained';
        const riskNote =
          rule?.lastReleaseFor && targetMajor > rule.lastReleaseFor
            ? `Open-ended peer range on ${dep.name}@${targetVersion} declares compatibility with Angular ${targetMajor}, but last release was for Angular ${rule.lastReleaseFor} (unmaintained).`
            : isDeprecated
              ? `Package ${dep.name}@${targetVersion} is deprecated${isUnmaint ? ' and unmaintained' : ''}; peer range declares compatibility with Angular ${targetMajor}.`
              : `Package ${dep.name}@${targetVersion} is unmaintained; peer range declares compatibility with Angular ${targetMajor}.`;
        blockers.push({
          package: dep.name,
          reason,
          hard: false,
          evidence: 'declared',
          unmaintained: isUnmaint,
          riskNote,
          details: meta?.deprecated ?? `Package ${dep.name} is ${reason}.`,
          current: dep.installed ?? dep.declared,
        });
      }
      continue;
    }

    // TypeScript
    if (dep.name === 'typescript' && requirements.typescript) {
      const pack = await registry.packument('typescript');
      if (pack) {
        const allReleases = allVersionsDesc(pack);
        const versions = allReleases.filter(
          (v) => semver.satisfies(v, requirements.typescript!) && semver.prerelease(v) === null,
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
        const allReleases = allVersionsDesc(pack);
        const versions = allReleases.filter(
          (v) => semver.satisfies(v, requirements.rxjs!) && semver.prerelease(v) === null,
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
        const allReleases = allVersionsDesc(pack);
        const versions = allReleases.filter(
          (v) => semver.satisfies(v, requirements.zone!) && semver.prerelease(v) === null,
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

    const allReleases = allVersionsDesc(pack);
    const hasAngularPeer = allReleases.some(
      (v) =>
        pack.versions[v]?.peerDependencies?.['@angular/core'] !== undefined ||
        pack.versions[v]?.peerDependencies?.['@angular/common'] !== undefined,
    );

    if (!hasAngularPeer && !rule) {
      // Package does not have Angular peer dependencies (e.g. lodash, date-fns, karma)
      unchanged.push(dep.name);
      continue;
    }

    // Look for newer releases that require Angular > targetMajor (held back)
    for (const v of allReleases) {
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

    // Propose newest version compatible with target Angular based strictly on peer ranges
    const compatible = allReleases.filter((v) => {
      const meta = pack.versions[v];
      if (hasAngularPeer) {
        const versionHasPeer =
          meta?.peerDependencies?.['@angular/core'] !== undefined ||
          meta?.peerDependencies?.['@angular/common'] !== undefined;
        if (!versionHasPeer) return false;
      }
      return satisfiesAngularPeer(meta?.peerDependencies, coreVersion, targetMajor, v);
    });

    const targetVersion = compatible.find((v) => semver.prerelease(v) === null) ?? compatible[0];

    if (targetVersion) {
      const meta = pack.versions[targetVersion];
      const currentVersion = dep.installed ?? semver.minVersion(dep.declared)?.version;
      const isDeprecated = Boolean(meta?.deprecated);
      const isUnmaint = isPackageUnmaintained(pack, targetVersion, rule, unmaintainedThresholdMonths, now, targetMajor);

      if (currentVersion && semver.eq(currentVersion, targetVersion) && !isDeprecated && !isUnmaint) {
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
          unmaintained: isUnmaint,
        });
      }

      if (isDeprecated || isUnmaint) {
        const reason = isDeprecated ? 'deprecated' : 'unmaintained';
        const riskNote =
          rule?.lastReleaseFor && targetMajor > rule.lastReleaseFor
            ? `Open-ended peer range on ${dep.name}@${targetVersion} declares compatibility with Angular ${targetMajor}, but last release was for Angular ${rule.lastReleaseFor} (unmaintained).`
            : isDeprecated
              ? `Package ${dep.name}@${targetVersion} is deprecated${isUnmaint ? ' and unmaintained' : ''}; peer range declares compatibility with Angular ${targetMajor}.`
              : `Package ${dep.name}@${targetVersion} is unmaintained; peer range declares compatibility with Angular ${targetMajor}.`;
        blockers.push({
          package: dep.name,
          reason,
          hard: false,
          evidence: 'declared',
          unmaintained: isUnmaint,
          riskNote,
          details: meta?.deprecated ?? `Package ${dep.name} is ${reason}.`,
          current: dep.installed ?? dep.declared,
        });
      }
    } else {
      // Find last version that supported targetMajor - 1
      const lastCompat = allReleases.find((v) =>
        satisfiesAngularPeer(pack.versions[v]?.peerDependencies, `${targetMajor - 1}.99.99`, targetMajor - 1, v),
      );

      blockers.push({
        package: dep.name,
        reason: 'no-compatible-version',
        hard: true,
        details: `No release of ${dep.name} supports @angular/core ${coreVersion}.`,
        current: dep.installed ?? dep.declared,
        lastCompatible: lastCompat,
      });
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
    b.recommendedFix = rec.recommendedFix;
    b.source = rec.source;
    b.confidence = rec.confidence;
    b.effort = rec.effort;
    b.runnerUp = rec.runnerUp;
    if (rec.usage) {
      b.usage = rec.usage;
    }
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
