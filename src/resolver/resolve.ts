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
import { normalizeRange, preserveRangeStyle, safeMinVersion, satisfiesAngularPeer } from './range.js';

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
  clock?: () => Date;
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
    now,
    clock,
  } = options;
  const effectiveNow = clock ? clock().getTime() : (now ?? Date.now());
  const changes: PackageChange[] = [];
  const unchanged: string[] = [];
  const heldBack: HeldBack[] = [];
  const blockers: Blocker[] = [];

  const neverTouchSet = new Set(neverTouch);
  const targetMajor = requirements.major;
  const coreVersion = requirements.coreVersion;
  const activeRules = options.rules ?? getBuiltInRules();

  // Partition dependencies so primary packages (e.g. @ngrx/store) are resolved
  // before secondary packages that peer on them (e.g. @ngrx/store-devtools, schematics, adapters).
  const sortedDependencies = [...project.dependencies].sort((a, b) => {
    const isSecondaryA = a.name.includes('devtools') || a.name.includes('schematics') || a.name.includes('adapter');
    const isSecondaryB = b.name.includes('devtools') || b.name.includes('schematics') || b.name.includes('adapter');
    if (isSecondaryA && !isSecondaryB) return 1;
    if (!isSecondaryA && isSecondaryB) return -1;
    return 0;
  });

  for (const dep of sortedDependencies) {
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
      const isUnmaint = isPackageUnmaintained(pack, targetVersion, rule, unmaintainedThresholdMonths, effectiveNow, targetMajor);

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
    const hasDirectAngularPeer = allReleases.some(
      (v) =>
        pack.versions[v]?.peerDependencies?.['@angular/core'] !== undefined ||
        pack.versions[v]?.peerDependencies?.['@angular/common'] !== undefined,
    );

    // Check if package declares peers on sibling packages present in the project (e.g. @ngrx/store)
    const hasSiblingPeer = allReleases.some((v) => {
      const p = pack.versions[v]?.peerDependencies;
      return (
        p &&
        Object.keys(p).some(
          (k) => !k.startsWith('@angular/') && project.dependencies.some((d) => d.name === k),
        )
      );
    });

    const isEcosystemPackage = Boolean(hasDirectAngularPeer || hasSiblingPeer);

    if (!isEcosystemPackage && !rule) {
      // Package does not have Angular or sibling peer dependencies (e.g. lodash, date-fns, karma)
      unchanged.push(dep.name);
      continue;
    }

    // Look for newer releases that require Angular > targetMajor or sibling > targetMajor (held back)
    for (const v of allReleases) {
      const meta = pack.versions[v];
      const peer = meta?.peerDependencies?.['@angular/core'];
      if (peer) {
        const minV = safeMinVersion(peer);
        if (minV && minV.major > targetMajor) {
          heldBack.push({
            name: dep.name,
            version: v,
            reason: `Requires @angular/core ${peer} (needs Angular ${minV.major}+)`,
          });
          break; // record newest held back
        }
      } else if (meta?.peerDependencies) {
        const siblingPeer = Object.entries(meta.peerDependencies).find(([k]) =>
          project.dependencies.some((d) => d.name === k),
        );
        if (siblingPeer) {
          const [siblingName, peerRange] = siblingPeer;
          const minV = safeMinVersion(peerRange);
          if (minV && minV.major > targetMajor) {
            heldBack.push({
              name: dep.name,
              version: v,
              reason: `Requires ${siblingName} ${peerRange} (needs Angular ${minV.major}+)`,
            });
            break;
          }
        }
      }
    }

    // Propose newest version compatible with target Angular based on direct or sibling peer ranges
    const compatible = allReleases.filter((v) => {
      const meta = pack.versions[v];
      const peerDeps = meta?.peerDependencies;

      // 1. Direct Angular peer check
      const versionHasDirectPeer =
        peerDeps?.['@angular/core'] !== undefined ||
        peerDeps?.['@angular/common'] !== undefined;

      if (versionHasDirectPeer) {
        return satisfiesAngularPeer(peerDeps, coreVersion, targetMajor, v);
      }

      // 2. Sibling / indirect peer check (e.g. @ngrx/store-devtools peering on @ngrx/store)
      if (hasSiblingPeer && peerDeps) {
        for (const [siblingName, peerRange] of Object.entries(peerDeps)) {
          if (siblingName.startsWith('@angular/')) continue;
          const isProjectDep = project.dependencies.some((d) => d.name === siblingName);
          if (!isProjectDep) continue;

          const inChanges = changes.find((c) => c.name === siblingName);
          const inProject = project.dependencies.find((d) => d.name === siblingName);
          const siblingTarget =
            inChanges?.target ?? inProject?.installed ?? safeMinVersion(inProject?.declared ?? '')?.version;

          if (siblingTarget) {
            const normalized = normalizeRange(peerRange);
            if (semver.validRange(normalized)) {
              if (semver.satisfies(siblingTarget, normalized)) {
                return true;
              }
              const minV = safeMinVersion(peerRange);
              if (minV && minV.major === targetMajor) {
                return true;
              }
            }
          }
        }
      }

      // 3. Same-scope lockstep fallback (e.g. @ngrx/* packages)
      if (dep.name.startsWith('@') && dep.name.includes('/')) {
        const scope = dep.name.split('/')[0]!;
        const sameScopeChange = changes.find((c) => c.name.startsWith(`${scope}/`) && c.name !== dep.name);
        if (sameScopeChange?.target) {
          if (v === sameScopeChange.target || semver.major(v) === semver.major(sameScopeChange.target)) {
            return true;
          }
        }
      }

      if (hasDirectAngularPeer) return false;
      return true;
    });

    const targetVersion = compatible.find((v) => semver.prerelease(v) === null) ?? compatible[0];

    if (targetVersion) {
      const meta = pack.versions[targetVersion];
      const currentVersion = dep.installed ?? safeMinVersion(dep.declared)?.version;
      const isDeprecated = Boolean(meta?.deprecated);
      const isUnmaint = isPackageUnmaintained(pack, targetVersion, rule, unmaintainedThresholdMonths, effectiveNow, targetMajor);

      const newerWithoutAngularPeer = hasDirectAngularPeer
        ? allReleases.filter((v) => {
          if (!semver.gt(v, targetVersion)) return false;
          const m = pack.versions[v];
          const p = m?.peerDependencies;
          if (!p) return true;
          if (p['@angular/core'] !== undefined || p['@angular/common'] !== undefined) return false;
          if (Object.keys(p).some((k) => project.dependencies.some((d) => d.name === k))) return false;
          return true;
        })
        : [];

      let chosenVersionReason: string | undefined;
      let heldRangeLabel: string | undefined;
      if (newerWithoutAngularPeer.length > 0) {
        const oldestHeldBack = newerWithoutAngularPeer[newerWithoutAngularPeer.length - 1]!;
        const newestHeldBack = newerWithoutAngularPeer[0]!;
        heldRangeLabel =
          oldestHeldBack === newestHeldBack ? newestHeldBack : `${oldestHeldBack} to ${newestHeldBack}`;
        chosenVersionReason = `held back from ${heldRangeLabel} because those newer releases declare no Angular peer range; chose ${targetVersion} as the highest release declaring an @angular/* peer range supporting Angular ${targetMajor}`;
        heldBack.push({
          name: dep.name,
          version: heldRangeLabel,
          reason: `Newer release(s) (${heldRangeLabel}) declare no Angular peer range; chose ${targetVersion} as highest release declaring an @angular/* peer range (${meta?.peerDependencies?.['@angular/core'] ?? meta?.peerDependencies?.['@angular/common'] ?? 'compatible'})`,
        });
      }

      const matchedSibling = meta?.peerDependencies
        ? Object.keys(meta.peerDependencies).find((k) => project.dependencies.some((d) => d.name === k))
        : undefined;
      const defaultReason = matchedSibling
        ? `Peer range supports ${matchedSibling} (Angular ${targetMajor})`
        : `Peer range supports Angular ${targetMajor}`;

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
          reason: heldRangeLabel
            ? `${defaultReason} (chose ${targetVersion}; ${heldRangeLabel} held back with no Angular peer range)`
            : defaultReason,
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
          ...(chosenVersionReason ? { chosenVersion: targetVersion, chosenVersionReason } : {}),
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

  // Enrich blockers with dependencyKind and recommendations
  for (const b of blockers) {
    if (!b.dependencyKind) {
      const depInfo = project.dependencies.find((d) => d.name === b.package);
      b.dependencyKind = depInfo?.type === 'devDependencies' ? 'dev-only' : 'runtime';
    }
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
