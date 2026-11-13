import semver from 'semver';
import type {
  Blocker,
  EvidenceKind,
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

export const KNOWN_ANGULAR_RELEASE_DATES: Record<number, string> = {
  12: '2021-05-12T00:00:00.000Z',
  13: '2021-11-03T00:00:00.000Z',
  14: '2022-06-02T00:00:00.000Z',
  15: '2022-11-16T00:00:00.000Z',
  16: '2023-05-03T00:00:00.000Z',
  17: '2023-11-08T00:00:00.000Z',
  18: '2024-05-22T00:00:00.000Z',
  19: '2024-11-19T00:00:00.000Z',
  20: '2025-05-21T00:00:00.000Z',
  21: '2025-11-19T00:00:00.000Z',
  22: '2026-05-20T00:00:00.000Z',
};

export function getAngularMajorTimeWindow(
  corePack: Packument | undefined,
  major: number,
): { start: Date; end?: Date } {
  let startStr = corePack?.time?.[`${major}.0.0`];
  let endStr = corePack?.time?.[`${major + 1}.0.0`];

  if (!startStr && corePack?.time) {
    for (const [ver, t] of Object.entries(corePack.time)) {
      if (semver.valid(ver) && semver.major(ver) === major) {
        if (!startStr || new Date(t) < new Date(startStr)) startStr = t;
      }
      if (semver.valid(ver) && semver.major(ver) === major + 1) {
        if (!endStr || new Date(t) < new Date(endStr)) endStr = t;
      }
    }
  }

  if (!startStr && KNOWN_ANGULAR_RELEASE_DATES[major]) {
    startStr = KNOWN_ANGULAR_RELEASE_DATES[major];
  }
  if (!endStr && KNOWN_ANGULAR_RELEASE_DATES[major + 1]) {
    endStr = KNOWN_ANGULAR_RELEASE_DATES[major + 1];
  }

  return {
    start: startStr ? new Date(startStr) : new Date(0),
    end: endStr ? new Date(endStr) : undefined,
  };
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

export interface UnknownSignalResult {
  version: string;
  signal: 'sibling' | 'major-match' | 'publish-date' | 'latest-patch' | 'none';
  explanation: string;
}

/**
 * For unknown cases (package declares no Angular peer range at all), use weaker signals:
 * (a) peer ranges on sibling packages that are version-aligned with Angular
 * (b) version numbers that follow the Angular major
 * (c) publish date falling between release dates of Angular n and n+1
 */
export function evaluateUnknownSignals(
  allReleases: string[],
  pack: Packument,
  project: ProjectInfo,
  changes: PackageChange[],
  targetMajor: number,
  angularTimeWindow: { start: Date; end?: Date },
  currentVersion?: string,
): UnknownSignalResult | undefined {
  const candidatesWithoutDirectPeer = allReleases.filter((v) => {
    const p = pack.versions[v]?.peerDependencies;
    return !p || (p['@angular/core'] === undefined && p['@angular/common'] === undefined);
  });

  if (candidatesWithoutDirectPeer.length === 0) return undefined;

  // Signal (a): peer ranges on sibling packages that are version-aligned with Angular
  for (const v of candidatesWithoutDirectPeer) {
    const meta = pack.versions[v];
    const peerDeps = meta?.peerDependencies;
    if (!peerDeps) continue;

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
        if (normalized && semver.validRange(normalized)) {
          if (semver.satisfies(siblingTarget, normalized)) {
            return {
              version: v,
              signal: 'sibling',
              explanation: `No @angular/* peer range declared; aligned with sibling dependency ${siblingName}@${siblingTarget} (Angular ${targetMajor}).`,
            };
          }
          const minV = safeMinVersion(peerRange);
          if (minV && minV.major === targetMajor) {
            return {
              version: v,
              signal: 'sibling',
              explanation: `No @angular/* peer range declared; aligned with sibling dependency ${siblingName} (target major ${targetMajor}).`,
            };
          }
        }
      }
    }
  }

  // Signal (b): version numbers that follow the Angular major
  const majorMatches = candidatesWithoutDirectPeer.filter((v) => {
    if (semver.prerelease(v) !== null) return false;
    return semver.major(v) === targetMajor;
  });
  if (majorMatches.length > 0) {
    const chosen = majorMatches[0]!;
    return {
      version: chosen,
      signal: 'major-match',
      explanation: `No @angular/* peer range declared; package major version ${targetMajor} aligns with Angular ${targetMajor}.`,
    };
  }

  // Signal (c): publish date falling between release dates of Angular n and n+1
  if (angularTimeWindow.start && angularTimeWindow.start.getTime() > 0) {
    const timeMatches = candidatesWithoutDirectPeer.filter((v) => {
      if (semver.prerelease(v) !== null) return false;
      const releaseDateStr = pack.versions[v]?.releaseDate ?? pack.time?.[v];
      if (!releaseDateStr) return false;
      const d = new Date(releaseDateStr);
      if (isNaN(d.getTime())) return false;
      if (d < angularTimeWindow.start) return false;
      if (angularTimeWindow.end && d >= angularTimeWindow.end) return false;
      return true;
    });

    if (timeMatches.length > 0) {
      const chosen = timeMatches[0]!;
      const dateStr = pack.versions[chosen]?.releaseDate ?? pack.time?.[chosen];
      const isoDate = dateStr ? new Date(dateStr).toISOString().slice(0, 10) : '';
      return {
        version: chosen,
        signal: 'publish-date',
        explanation: `No @angular/* peer range declared; release ${chosen} was published on ${isoDate} during the Angular ${targetMajor} lifecycle.`,
      };
    }
  }

  // Fallback: stay on current or latest patch/minor of current line
  if (currentVersion && semver.valid(currentVersion)) {
    const curMajor = semver.major(currentVersion);
    const sameMajorLine = candidatesWithoutDirectPeer.filter(
      (v) => semver.major(v) === curMajor && semver.prerelease(v) === null,
    );
    if (sameMajorLine.length > 0) {
      const chosen = sameMajorLine[0]!;
      return {
        version: chosen,
        signal: 'latest-patch',
        explanation: `No @angular/* peer range declared; preserved latest release in current ${curMajor}.x line (${chosen}).`,
      };
    }
  }

  // Otherwise, latest stable candidate without direct peer
  const stableCandidates = candidatesWithoutDirectPeer.filter((v) => semver.prerelease(v) === null);
  const fallback = stableCandidates[0] ?? candidatesWithoutDirectPeer[0]!;
  return {
    version: fallback,
    signal: 'none',
    explanation: `No @angular/* peer range declared in release ${fallback}.`,
  };
}

/**
 * Resolves dependencies for a single major upgrade step (plan section 8).
 * Pure: makes no filesystem changes.
 */
export async function resolveStepDependencies(options: ResolveStepOptions): Promise<StepResolution> {
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

  const corePack = await registry.packument('@angular/core').catch(() => undefined);
  const angularTimeWindow = getAngularMajorTimeWindow(corePack, targetMajor);

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
    try {
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
            evidence: 'declared-incompatible',
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
      if (allReleases.length === 0) {
        unchanged.push(dep.name);
        continue;
      }

      const newestRelease = allReleases[0]!;
      const currentVersion = dep.installed ?? safeMinVersion(dep.declared)?.version;

      const hasDirectAngularPeer = allReleases.some(
        (v) =>
          pack.versions[v]?.peerDependencies?.['@angular/core'] !== undefined ||
          pack.versions[v]?.peerDependencies?.['@angular/common'] !== undefined,
      );

      const hasSiblingPeer = allReleases.some((v) => {
        const p = pack.versions[v]?.peerDependencies;
        return (
          p &&
          Object.keys(p).some(
            (k) => !k.startsWith('@angular/') && project.dependencies.some((d) => d.name === k),
          )
        );
      });

      const isAngularName =
        dep.name.startsWith('@angular/') ||
        dep.name.startsWith('ngx-') ||
        dep.name.startsWith('ng2-') ||
        dep.name.startsWith('ng-') ||
        dep.name.startsWith('@ngrx/') ||
        dep.name.startsWith('@ng-') ||
        dep.name.startsWith('@ngx-');

      const isEcosystemPackage = Boolean(hasDirectAngularPeer || hasSiblingPeer || isAngularName);

      if (!isEcosystemPackage && !rule) {
        unchanged.push(dep.name);
        continue;
      }

      // 1. Direct Angular peer releases that explicitly declare compatibility
      const declaredCompatible = allReleases.filter((v) => {
        const meta = pack.versions[v];
        const peerDeps = meta?.peerDependencies;
        if (!peerDeps) return false;
        if (peerDeps['@angular/core'] === undefined && peerDeps['@angular/common'] === undefined) return false;
        return satisfiesAngularPeer(peerDeps, coreVersion, targetMajor, v);
      });

      // 2. Evaluate weaker unknown signals for releases without direct Angular peers
      const unknownSignal = evaluateUnknownSignals(
        allReleases,
        pack,
        project,
        changes,
        targetMajor,
        angularTimeWindow,
        currentVersion,
      );

      let targetVersion: string | undefined;
      let evidence: EvidenceKind = 'declared-compatible';
      let chosenReason: string | undefined;
      let unknownExplanation: string | undefined;

      // Determine candidate:
      // If an unknown signal is found, check if it avoids an ancient downgrade
      const topDeclared = declaredCompatible.find((v) => semver.prerelease(v) === null) ?? declaredCompatible[0];
      const isAncientDowngrade =
        topDeclared && currentVersion && semver.valid(topDeclared) && semver.valid(currentVersion)
          ? semver.major(topDeclared) < semver.major(currentVersion)
          : false;

      if (unknownSignal && (declaredCompatible.length === 0 || isAncientDowngrade || (topDeclared && semver.gt(unknownSignal.version, topDeclared)))) {
        targetVersion = unknownSignal.version;
        evidence = 'unknown';
        unknownExplanation = unknownSignal.explanation;
        chosenReason = `${unknownSignal.explanation} (chose ${targetVersion}, newest: ${newestRelease}). Unknown, verify by build.`;
      } else if (topDeclared) {
        targetVersion = topDeclared;
        evidence = 'declared';
        chosenReason = `Peer range declares compatibility with Angular ${targetMajor}`;
      }

      // Check held back releases: look for newer releases requiring Angular > targetMajor
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
            break;
          }
        }
      }

      if (targetVersion) {
        const meta = pack.versions[targetVersion];
        const isDeprecated = Boolean(meta?.deprecated);
        const isUnmaint = isPackageUnmaintained(pack, targetVersion, rule, unmaintainedThresholdMonths, effectiveNow, targetMajor);

        if (currentVersion && semver.eq(currentVersion, targetVersion) && !isDeprecated && !isUnmaint && evidence !== 'unknown') {
          unchanged.push(dep.name);
        } else {
          changes.push({
            name: dep.name,
            type: dep.type,
            current: dep.installed,
            currentSpec: dep.declared,
            target: targetVersion,
            targetSpec: preserveRangeStyle(targetVersion, dep.declared),
            reason: chosenReason ?? `Aligned for Angular ${targetMajor}`,
            evidence,
            newestVersion: newestRelease,
            unknownExplanation,
            deprecated: meta?.deprecated,
            unmaintained: isUnmaint,
          });
        }

        // Add soft blocker if deprecated or unmaintained
        if (isDeprecated || isUnmaint) {
          const reason = isDeprecated ? 'deprecated' : 'unmaintained';
          const riskNote =
            rule?.lastReleaseFor && targetMajor > rule.lastReleaseFor
              ? `Open-ended peer range on ${dep.name}@${targetVersion} declares compatibility with Angular ${targetMajor}, but last release was for Angular ${rule.lastReleaseFor} (unmaintained).`
              : isDeprecated
                ? `Package ${dep.name}@${targetVersion} is deprecated${isUnmaint ? ' and unmaintained' : ''}; peer range declares compatibility with Angular ${targetMajor}.`
                : `Package ${dep.name}@${targetVersion} is unmaintained; peer range declares compatibility with Angular ${targetMajor}.`;
          const details = meta?.deprecated ?? `Package ${dep.name}@${targetVersion} is ${reason}.`;

          blockers.push({
            package: dep.name,
            reason,
            hard: false,
            evidence,
            unmaintained: isUnmaint,
            riskNote,
            details,
            current: dep.installed ?? dep.declared,
            chosenVersion: targetVersion,
            newestVersion: newestRelease,
            unknownExplanation,
            chosenVersionReason: chosenReason,
          });
        } else if (evidence === 'unknown' && (!hasDirectAngularPeer || unknownSignal?.signal === 'none')) {
          // If no signal matched at all, also record as soft unknown blocker
          blockers.push({
            package: dep.name,
            reason: 'unknown',
            hard: false,
            evidence: 'unknown',
            details: `Package ${dep.name}@${targetVersion} declares no @angular/* peer range; verify compatibility by build and tests.`,
            current: dep.installed ?? dep.declared,
            chosenVersion: targetVersion,
            newestVersion: newestRelease,
            unknownExplanation,
            chosenVersionReason: chosenReason,
          });
        }
      } else {
        // Neither declaredCompatible nor a viable unknown signal found.
        // Distinguish declared-incompatible (real hard blocker) vs unknown (soft blocker).
        const latestMeta = pack.versions[newestRelease];
        const latestPeer = latestMeta?.peerDependencies;
        const hasExplicitAngularIncompatible =
          latestPeer &&
          (latestPeer['@angular/core'] !== undefined || latestPeer['@angular/common'] !== undefined);

        if (hasExplicitAngularIncompatible) {
          // Genuine declared incompatibility: package explicitly declared @angular/* peer range that excludes target
          const lastCompat = allReleases.find((v) =>
            satisfiesAngularPeer(pack.versions[v]?.peerDependencies, `${targetMajor - 1}.99.99`, targetMajor - 1, v),
          );

          blockers.push({
            package: dep.name,
            reason: 'no-compatible-version',
            hard: true,
            evidence: 'declared-incompatible',
            details: `No release of ${dep.name} supports @angular/core ${coreVersion}. (Latest release ${newestRelease} declares incompatible peer).`,
            current: dep.installed ?? dep.declared,
            lastCompatible: lastCompat,
            newestVersion: newestRelease,
          });
        } else {
          // Package declared no Angular peer range at all in latest release -> unknown (never hard blocker)
          const fallbackTarget = currentVersion ?? newestRelease;
          changes.push({
            name: dep.name,
            type: dep.type,
            current: dep.installed,
            currentSpec: dep.declared,
            target: fallbackTarget,
            targetSpec: preserveRangeStyle(fallbackTarget, dep.declared),
            reason: `No @angular/* peer range declared in ${dep.name} (chose ${fallbackTarget}, newest: ${newestRelease}). Unknown, verify by build.`,
            evidence: 'unknown',
            newestVersion: newestRelease,
            unknownExplanation: `Package ${dep.name} declares no @angular/* peer range in release ${fallbackTarget}.`,
          });

          blockers.push({
            package: dep.name,
            reason: 'unknown',
            hard: false,
            evidence: 'unknown',
            details: `Package ${dep.name} declares no @angular/* peer range in release ${fallbackTarget}. Verify compatibility by build and tests.`,
            current: dep.installed ?? dep.declared,
            chosenVersion: fallbackTarget,
            newestVersion: newestRelease,
            unknownExplanation: `No @angular/* peer range declared in any release of ${dep.name}.`,
          });
        }
      }
    } catch (err) {
      // Robustness: one malformed registry entry must never crash a run.
      // Wrap evaluation per package so a failure yields evidence "unknown" plus a warning naming the package.
      const msg = err instanceof Error ? err.message : String(err);
      const fallbackTarget = dep.installed ?? safeMinVersion(dep.declared)?.version ?? dep.declared;
      changes.push({
        name: dep.name,
        type: dep.type,
        current: dep.installed,
        currentSpec: dep.declared,
        target: fallbackTarget,
        targetSpec: dep.declared,
        reason: `Evaluation failed (${msg}); retained current version. Unknown, verify by build.`,
        evidence: 'unknown',
        unknownExplanation: `Evaluation threw an error: ${msg}. Verify compatibility by building the project.`,
      });

      blockers.push({
        package: dep.name,
        reason: 'unknown',
        hard: false,
        evidence: 'unknown',
        details: `Failed to evaluate package ${dep.name}: ${msg}.`,
        current: dep.installed ?? dep.declared,
        chosenVersion: fallbackTarget,
        unknownExplanation: `Evaluation error: ${msg}`,
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
