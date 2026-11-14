import semver from 'semver';
import type {
  Blocker,
  EvidenceKind,
  HeldBack,
  PackageChange,
  ProjectInfo,
  StepNote,
  StepRequirements,
} from '../model.js';
import { computeRecommendation } from '../recommend/engine.js';
import { findRule, getBuiltInRules, type MigrationRule } from '../recommend/rules.js';
import {
  allVersionsDesc,
  inAngularMajor,
  type Packument,
  type RegistryClient,
  type VersionMeta,
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
  notes: StepNote[];
}

export const KNOWN_ANGULAR_RELEASE_DATES: Record<number, string> = {
  12: '2021-05-12T18:51:12.205Z',
  13: '2021-11-03T18:01:09.111Z',
  14: '2022-06-02T16:57:42.193Z',
  15: '2022-11-16T17:44:46.796Z',
  16: '2023-05-03T16:47:02.052Z',
  17: '2023-11-08T12:25:24.973Z',
  18: '2024-05-22T17:56:03.169Z',
  19: '2024-11-19T14:22:30.784Z',
  20: '2025-05-28T13:53:18.215Z',
  21: '2025-11-19T18:07:38.390Z',
  22: '2026-06-03T13:04:10.790Z',
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
  const allVers = allVersionsDesc(pack);
  const latestVer =
    pack.distTags?.latest ?? allVers.find((v) => semver.prerelease(v) === null) ?? allVers[0] ?? version;
  const latestMeta = latestVer ? pack.versions?.[latestVer] : undefined;
  const meta = pack.versions?.[version];
  const dateStr =
    latestMeta?.releaseDate ??
    (latestVer ? pack.time?.[latestVer] : undefined) ??
    meta?.releaseDate ??
    pack.time?.[version] ??
    pack.time?.modified ??
    pack.modified;
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

/**
 * Determines whether a proposed package release from the registry is Ivy-era (Partial/Full Ivy)
 * rather than legacy View Engine, inspecting only registry version document fields.
 */
export function isProposedVersionIvyEra(
  pkgName: string,
  version: string | undefined,
  meta: VersionMeta | undefined,
  targetMajor?: number,
): boolean {
  if (pkgName.startsWith('@angular/') || pkgName.startsWith('@angular-devkit/')) {
    if (version && semver.valid(version)) {
      return semver.major(version) >= 12 || (targetMajor !== undefined && semver.major(version) === targetMajor);
    }
    return true;
  }

  if (!meta) return false;

  if (typeof meta.metadata === 'string' && meta.metadata.endsWith('.metadata.json')) {
    return false;
  }

  if (meta.fesm2022 || meta.fesm2020 || meta.esm2022 || meta.esm2020) {
    return true;
  }

  const entryFields = [meta.module, meta.es2015, meta.esm2015, meta.fesm2015, meta.main];
  if (
    entryFields.some(
      (s) =>
        typeof s === 'string' &&
        (s.includes('fesm2022') || s.includes('fesm2020') || s.includes('esm2022') || s.includes('esm2020') || s.endsWith('.mjs')),
    )
  ) {
    return true;
  }

  if (meta.exports && typeof meta.exports === 'object') {
    const serialized = JSON.stringify(meta.exports);
    if (
      serialized.includes('fesm2022') ||
      serialized.includes('fesm2020') ||
      serialized.includes('esm2022') ||
      serialized.includes('esm2020') ||
      serialized.includes('.mjs')
    ) {
      return true;
    }
    const keys = Object.keys(meta.exports);
    if (keys.some((k) => k !== './package.json')) {
      return true;
    }
  }

  return false;
}

export interface UnknownSignalResult {
  version: string;
  signal: 'sibling' | 'major-match' | 'publish-date' | 'latest-patch' | 'none';
  explanation: string;
  lowConfidence?: boolean;
}

const CORE_UTILITY_PACKAGES = new Set(['rxjs', 'tslib', 'zone.js', 'typescript']);

/**
 * For unknown cases (package declares no Angular peer range at all), use weaker signals:
 * (a) peer ranges on sibling packages that are version-aligned with Angular
 * (b) version numbers that follow the Angular major
 * (c) publish date falling on or before release date of Angular n+1
 */
export function evaluateUnknownSignals(
  allReleases: string[],
  pack: Packument,
  project: ProjectInfo,
  changes: PackageChange[],
  targetMajor: number,
  angularTimeWindow: { start: Date; end?: Date },
  currentVersion?: string,
  angularAlignedSiblings?: Set<string>,
): UnknownSignalResult | undefined {
  const candidatesWithoutDirectPeer = allReleases.filter((v) => {
    const p = pack.versions?.[v]?.peerDependencies;
    return !p || (p['@angular/core'] === undefined && p['@angular/common'] === undefined);
  });

  if (candidatesWithoutDirectPeer.length === 0) return undefined;

  // Guard: if the package's newest stable release explicitly declares @angular/core or @angular/common
  // peer compatibility that rejects targetMajor AND caps compatibility at or below targetMajor (e.g. abandoned <12),
  // do not treat older releases lacking peers as compatible. Future-major releases (minV.major > targetMajor)
  // are simply held back, so older unknown releases remain valid candidates.
  const newestStable = allReleases.find((v) => semver.prerelease(v) === null) ?? allReleases[0];
  if (newestStable) {
    const newestPeers = pack.versions?.[newestStable]?.peerDependencies;
    if (
      newestPeers &&
      (newestPeers['@angular/core'] !== undefined || newestPeers['@angular/common'] !== undefined) &&
      !satisfiesAngularPeer(newestPeers, `${targetMajor}.0.0`, targetMajor, newestStable)
    ) {
      const minAngularPeer = safeMinVersion(newestPeers['@angular/core'] ?? newestPeers['@angular/common'] ?? '');
      if (!minAngularPeer || minAngularPeer.major <= targetMajor) {
        return undefined;
      }
    }
  }

  const isAlignedSibling = (siblingName: string): boolean => {
    if (siblingName.startsWith('@angular/')) return false;
    if (CORE_UTILITY_PACKAGES.has(siblingName)) return false;
    if (!project.dependencies.some((d) => d.name === siblingName)) return false;
    return angularAlignedSiblings ? angularAlignedSiblings.has(siblingName) : true;
  };

  // Signal (a): peer ranges on sibling packages that are version-aligned with Angular
  // Evaluated before the publish-date cutoff so sibling ecosystems releasing right after Angular n+1 stay aligned.
  for (const v of candidatesWithoutDirectPeer) {
    const meta = pack.versions?.[v];
    const peerDeps = meta?.peerDependencies;
    if (!peerDeps) continue;

    const alignedEntries = Object.entries(peerDeps).filter(([siblingName]) => isAlignedSibling(siblingName));
    if (alignedEntries.length === 0) continue;

    let allMatched = true;
    const matchedNotes: string[] = [];

    for (const [siblingName, peerRange] of alignedEntries) {
      const inChanges = changes.find((c) => c.name === siblingName);
      const inProject = project.dependencies.find((d) => d.name === siblingName);
      const siblingTarget =
        inChanges?.target ?? inProject?.installed ?? safeMinVersion(inProject?.declared ?? '')?.version;

      const normalized = normalizeRange(peerRange);
      if (!siblingTarget || !normalized || !semver.validRange(normalized)) {
        allMatched = false;
        break;
      }

      const satisfiesTarget = semver.satisfies(siblingTarget, normalized);
      const minV = safeMinVersion(peerRange);
      const minMatchesMajor = Boolean(minV && minV.major === targetMajor);

      if (satisfiesTarget) {
        matchedNotes.push(`${siblingName}@${siblingTarget}`);
      } else if (minMatchesMajor && !inChanges) {
        matchedNotes.push(`${siblingName} (target major ${targetMajor})`);
      } else {
        allMatched = false;
        break;
      }
    }

    if (allMatched && matchedNotes.length > 0) {
      return {
        version: v,
        signal: 'sibling',
        explanation: `No @angular/* peer range declared; aligned with sibling dependency ${matchedNotes.join(', ')} (Angular ${targetMajor}).`,
      };
    }
  }

  const getReleaseDate = (v: string): Date | undefined => {
    const ds = pack.versions?.[v]?.releaseDate ?? pack.time?.[v];
    if (!ds) return undefined;
    const d = new Date(ds);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  // Date rule for unknown evidence: a release is a candidate only if published on or before Angular n+1 release date.
  const hasPublishDates = candidatesWithoutDirectPeer.some((v) => getReleaseDate(v) !== undefined);
  const endCutoff = angularTimeWindow.end;
  let eligibleCandidates = candidatesWithoutDirectPeer;

  if (hasPublishDates && endCutoff) {
    const byDate = candidatesWithoutDirectPeer.filter((v) => {
      const d = getReleaseDate(v);
      return d !== undefined && d.getTime() <= endCutoff.getTime();
    });
    if (byDate.length === 0) {
      const fallback =
        (currentVersion && candidatesWithoutDirectPeer.includes(currentVersion) ? currentVersion : undefined) ??
        candidatesWithoutDirectPeer.find((v) => semver.prerelease(v) === null) ??
        candidatesWithoutDirectPeer[0]!;
      const endIso = endCutoff.toISOString().slice(0, 10);
      return {
        version: fallback,
        signal: 'none',
        lowConfidence: true,
        explanation: `No release published on or before Angular ${targetMajor + 1} release date (${endIso}); retained ${fallback}.`,
      };
    }
    eligibleCandidates = byDate;
  }

  // Signal (b): version numbers that follow the Angular major
  const majorMatches = eligibleCandidates.filter((v) => {
    if (semver.prerelease(v) !== null) return false;
    return semver.major(v) === targetMajor;
  });
  if (majorMatches.length > 0) {
    const chosen = majorMatches[0]!;
    const relDate = getReleaseDate(chosen);
    const dateNote =
      relDate && endCutoff
        ? ` (published ${relDate.toISOString().slice(0, 10)} <= Angular ${targetMajor + 1} release ${endCutoff.toISOString().slice(0, 10)})`
        : '';
    return {
      version: chosen,
      signal: 'major-match',
      explanation: `No @angular/* peer range declared; package major version ${targetMajor} aligns with Angular ${targetMajor}${dateNote}.`,
    };
  }

  // Signal (c): publish date falling on or before the release date of Angular n+1
  const stableEligible = eligibleCandidates.filter((v) => semver.prerelease(v) === null);
  const datedEligible = stableEligible.filter((v) => getReleaseDate(v) !== undefined);
  if (datedEligible.length > 0 && (angularTimeWindow.start.getTime() > 0 || endCutoff)) {
    const inLifecycleWindow = datedEligible.filter((v) => {
      const d = getReleaseDate(v)!;
      if (angularTimeWindow.start.getTime() > 0 && d < angularTimeWindow.start) return false;
      if (endCutoff && d.getTime() > endCutoff.getTime()) return false;
      return true;
    });

    const beforeNextMajor = datedEligible.filter((v) => {
      const d = getReleaseDate(v)!;
      return endCutoff ? d.getTime() <= endCutoff.getTime() : d >= angularTimeWindow.start;
    });

    const chosen = inLifecycleWindow[0] ?? beforeNextMajor[0];
    if (chosen) {
      const isoDate = getReleaseDate(chosen)!.toISOString().slice(0, 10);
      const inWindow = inLifecycleWindow.includes(chosen);
      const endInfo = endCutoff
        ? inWindow
          ? `during the Angular ${targetMajor} lifecycle (on or before Angular ${targetMajor + 1} release date ${endCutoff.toISOString().slice(0, 10)})`
          : `on or before Angular ${targetMajor + 1} release date (${endCutoff.toISOString().slice(0, 10)})`
        : `during the Angular ${targetMajor} lifecycle`;
      return {
        version: chosen,
        signal: 'publish-date',
        explanation: `No @angular/* peer range declared; release ${chosen} was published on ${isoDate} ${endInfo}.`,
      };
    }
  }

  // Fallback: stay on current or latest patch/minor of current line within eligible releases
  if (currentVersion && semver.valid(currentVersion)) {
    const curMajor = semver.major(currentVersion);
    const sameMajorLine = eligibleCandidates.filter(
      (v) => semver.major(v) === curMajor && semver.prerelease(v) === null,
    );
    if (sameMajorLine.length > 0) {
      const chosen = sameMajorLine[0]!;
      return {
        version: chosen,
        signal: 'latest-patch',
        explanation: `No @angular/* peer range declared; preserved newest eligible release in current ${curMajor}.x line (${chosen}).`,
      };
    }
  }

  // Otherwise, newest eligible stable candidate without direct peer
  const fallback = stableEligible[0] ?? eligibleCandidates[0]!;
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
  const notes: StepNote[] = [];

  const neverTouchSet = new Set(neverTouch);
  const targetMajor = requirements.major;
  const coreVersion = requirements.coreVersion;
  const activeRules = options.rules ?? getBuiltInRules();

  const corePack = await registry.packument('@angular/core').catch(() => undefined);
  const angularTimeWindow = getAngularMajorTimeWindow(corePack, targetMajor);
  const angular16Window = getAngularMajorTimeWindow(corePack, 16);

  // Pre-scan dependencies in parallel (bounded by RegistryClient's concurrency limit)
  // to identify Angular-aligned primary siblings declaring @angular/core or @angular/common.
  const angularAlignedSiblings = new Set<string>();
  await Promise.all(
    project.dependencies.map(async (d) => {
      if (d.name.startsWith('@angular/') || d.name.startsWith('@angular-devkit/')) {
        angularAlignedSiblings.add(d.name);
        return;
      }
      if (CORE_UTILITY_PACKAGES.has(d.name)) return;
      try {
        const p = await registry.packument(d.name);
        if (!p?.versions) return;
        const vers = allVersionsDesc(p);
        if (
          vers.some(
            (v) =>
              p.versions?.[v]?.peerDependencies?.['@angular/core'] !== undefined ||
              p.versions?.[v]?.peerDependencies?.['@angular/common'] !== undefined,
          )
        ) {
          angularAlignedSiblings.add(d.name);
        }
      } catch {
        // Ignore packument lookup failures during pre-scan; main loop handles reporting.
      }
    }),
  );

  // Partition dependencies so Angular framework and primary aligned siblings are resolved
  // before secondary packages that peer on them (e.g. @ngrx/store before @ngrx/store-devtools,
  // @nebular/theme before @nebular/eva-icons).
  const getPriority = (name: string): number => {
    if (name.startsWith('@angular/') || name.startsWith('@angular-devkit/')) return 0;
    const isSecondary =
      name.includes('devtools') ||
      name.includes('schematics') ||
      name.includes('adapter') ||
      name.includes('eva-icons');
    if (angularAlignedSiblings.has(name) && !isSecondary) return 1;
    if (angularAlignedSiblings.has(name)) return 2;
    if (!isSecondary) return 3;
    return 4;
  };
  const sortedDependencies = [...project.dependencies].sort((a, b) => getPriority(a.name) - getPriority(b.name));

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

      // tslib (runtime helper, never flagged for lacking an Angular peer)
      if (dep.name === 'tslib') {
        unchanged.push(dep.name);
        continue;
      }

      // TypeScript
      if (dep.name === 'typescript') {
        if (requirements.typescript) {
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
        unchanged.push(dep.name);
        continue;
      }

      // RxJS
      if (dep.name === 'rxjs') {
        if (requirements.rxjs) {
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
        unchanged.push(dep.name);
        continue;
      }

      // zone.js
      if (dep.name === 'zone.js') {
        if (requirements.zone) {
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
        unchanged.push(dep.name);
        continue;
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
          pack.versions?.[v]?.peerDependencies?.['@angular/core'] !== undefined ||
          pack.versions?.[v]?.peerDependencies?.['@angular/common'] !== undefined,
      );

      // @angular-eslint/* packages without direct @angular/core peers align lockstep by major
      if (dep.name.startsWith('@angular-eslint/') && !hasDirectAngularPeer) {
        const stableMajorMatches = allReleases.filter(
          (v) => inAngularMajor(v, targetMajor) && semver.prerelease(v) === null,
        );
        const anyMajorMatches = allReleases.filter((v) => inAngularMajor(v, targetMajor));
        const eslintTarget = stableMajorMatches[0] ?? anyMajorMatches[0];
        if (eslintTarget) {
          if (currentVersion && semver.valid(currentVersion) && semver.eq(currentVersion, eslintTarget)) {
            unchanged.push(dep.name);
          } else {
            changes.push({
              name: dep.name,
              type: dep.type,
              current: dep.installed,
              currentSpec: dep.declared,
              target: eslintTarget,
              targetSpec: preserveRangeStyle(eslintTarget, dep.declared),
              reason: `Aligned @angular-eslint/* major to Angular ${targetMajor}`,
              evidence: 'declared',
              newestVersion: newestRelease,
            });
          }
          continue;
        }
        blockers.push({
          package: dep.name,
          reason: 'no-compatible-version',
          hard: true,
          evidence: 'declared-incompatible',
          details: `No release of ${dep.name} found for Angular ${targetMajor}.`,
          current: dep.installed ?? dep.declared,
          newestVersion: newestRelease,
        });
        continue;
      }

      const hasSiblingPeer = allReleases.some((v) => {
        const p = pack.versions?.[v]?.peerDependencies;
        return (
          p &&
          Object.keys(p).some((k) => !k.startsWith('@angular/') && angularAlignedSiblings.has(k))
        );
      });

      const isAngularName =
        dep.name.startsWith('@angular/') ||
        dep.name.startsWith('ngx-') ||
        dep.name.startsWith('ng2-') ||
        dep.name.startsWith('@ngrx/') ||
        dep.name.startsWith('@ngx-') ||
        dep.name.startsWith('@angular-eslint/');

      const isEcosystemPackage = Boolean(hasDirectAngularPeer || hasSiblingPeer || isAngularName);

      if (!isEcosystemPackage && !rule) {
        unchanged.push(dep.name);
        continue;
      }

      // 1. Direct Angular peer releases that explicitly declare compatibility
      const declaredCompatible = allReleases.filter((v) => {
        const meta = pack.versions?.[v];
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
        angularAlignedSiblings,
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
        evidence = unknownSignal.lowConfidence ? 'unknown-low-confidence' : 'unknown';
        unknownExplanation = unknownSignal.explanation;
        const unknownLabel = unknownSignal.lowConfidence ? 'Unknown, low confidence' : 'Unknown, verify by build';
        chosenReason = `${unknownSignal.explanation} (chose ${targetVersion}, newest: ${newestRelease}). ${unknownLabel}.`;
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
        const isUnknownEv = evidence === 'unknown' || evidence === 'unknown-low-confidence';

        if (currentVersion && semver.valid(currentVersion) && semver.eq(currentVersion, targetVersion) && !isDeprecated && !isUnmaint && !isUnknownEv) {
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

        // Add soft blocker only if deprecated or unmaintained (explicit red flag).
        // Unknown evidence with no other red flag becomes a non-blocker note ("verify by build").
        if (isDeprecated || isUnmaint) {
          const reason = isDeprecated ? 'deprecated' : 'unmaintained';
          const riskNote =
            rule?.lastReleaseFor && targetMajor > rule.lastReleaseFor
              ? `Open-ended peer range on ${dep.name}@${targetVersion} declares compatibility with Angular ${targetMajor}, but last release was for Angular ${rule.lastReleaseFor} (unmaintained).`
              : isDeprecated
                ? `Package ${dep.name}@${targetVersion} is deprecated${isUnmaint ? ' and unmaintained' : ''}; ${isUnknownEv ? 'declares no @angular/* peer range' : `peer range declares compatibility with Angular ${targetMajor}`}.`
                : `Package ${dep.name}@${targetVersion} is unmaintained; ${isUnknownEv ? 'declares no @angular/* peer range' : `peer range declares compatibility with Angular ${targetMajor}`}.`;
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
        } else if (isUnknownEv) {
          notes.push({
            package: dep.name,
            kind: 'verify-by-build',
            severity: 'note',
            evidence,
            message:
              evidence === 'unknown-low-confidence'
                ? `${unknownExplanation ?? `No @angular/* peer range declared for ${dep.name}@${targetVersion}.`} Unknown, low confidence — verify by build and tests.`
                : `${unknownExplanation ?? `No @angular/* peer range declared in ${dep.name}@${targetVersion}.`} Chosen ${targetVersion}${newestRelease !== targetVersion ? ` (newest: ${newestRelease})` : ''}. Verify compatibility by build and tests.`,
            current: dep.installed ?? dep.declared,
            target: targetVersion,
          });
        }
      } else {
        // Neither declaredCompatible nor a viable unknown signal found.
        // Distinguish declared-incompatible (real hard blocker) vs unknown (note).
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
          // Package declared no Angular peer range at all in latest release -> unknown (note, never hard blocker)
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

          notes.push({
            package: dep.name,
            kind: 'verify-by-build',
            severity: 'note',
            evidence: 'unknown',
            message: `Package ${dep.name} declares no @angular/* peer range in release ${fallbackTarget}. Verify compatibility by build and tests.`,
            current: dep.installed ?? dep.declared,
            target: fallbackTarget,
          });
        }
      }
    } catch (err) {
      // Robustness: one malformed registry entry must never crash a run.
      // Wrap evaluation per package so a failure yields evidence "unknown" plus a note naming the package.
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

      notes.push({
        package: dep.name,
        kind: 'verify-by-build',
        severity: 'note',
        evidence: 'unknown',
        message: `Failed to evaluate package ${dep.name} (${msg}); retained ${fallbackTarget}. Verify compatibility by build and tests.`,
        current: dep.installed ?? dep.declared,
        target: fallbackTarget,
      });
    }
  }

  // Check View Engine / ngcc compatibility against the PROPOSED release when targeting Angular >= 16.
  if (targetMajor >= 16) {
    for (const veName of project.viewEngineSuspects) {
      if (veName.startsWith('@angular/') || veName.startsWith('@angular-devkit/')) {
        continue;
      }

      const depInfo = project.dependencies.find((d) => d.name === veName);
      const installedVersion = depInfo?.installed ?? depInfo?.declared;
      const existingChange = changes.find((c) => c.name === veName);
      const existingBlockerIdx = blockers.findIndex((b) => b.package === veName);
      const existingBlocker = existingBlockerIdx >= 0 ? blockers[existingBlockerIdx] : undefined;

      const pack = await registry.packument(veName).catch(() => undefined);
      const proposedVersion =
        existingChange?.target ?? existingBlocker?.chosenVersion ?? installedVersion;
      const proposedMeta =
        proposedVersion && semver.valid(proposedVersion) ? pack?.versions?.[proposedVersion] : undefined;

      const ivyEra = isProposedVersionIvyEra(veName, proposedVersion, proposedMeta, targetMajor);
      const evidenceKind = existingChange?.evidence ?? existingBlocker?.evidence;
      const isUnknown = evidenceKind === 'unknown' || evidenceKind === 'unknown-low-confidence';

      const proposedDateStr =
        proposedMeta?.releaseDate ?? (proposedVersion ? pack?.time?.[proposedVersion] : undefined);
      const proposedMs = proposedDateStr ? new Date(proposedDateStr).getTime() : Number.NaN;
      const isBeforeAngular16 = !Number.isNaN(proposedMs) && proposedMs < angular16Window.start.getTime();
      const isOldUnmaintained = existingBlocker?.unmaintained === true;
      const isOldDate = isBeforeAngular16 || isOldUnmaintained;

      if (!ivyEra) {
        // Outcome: installed View Engine and no Ivy-era proposed release -> hard blocker
        const hardBlocker: Blocker = {
          ...(existingBlocker ?? {}),
          package: veName,
          reason: 'ivy-or-ngcc',
          hard: true,
          evidence: existingBlocker?.evidence ?? (existingChange?.evidence ?? 'declared-incompatible'),
          details: `${veName}@${installedVersion ?? 'installed'} was compiled for View Engine and relies on ngcc, which was removed in Angular 16; proposed release ${proposedVersion ?? 'none'} does not provide Ivy/FESM2020+ artifacts.`,
          current: installedVersion,
          chosenVersion: proposedVersion,
          lastCompatible: existingBlocker?.lastCompatible,
          newestVersion: existingBlocker?.newestVersion ?? existingChange?.newestVersion,
          dependencyKind: existingBlocker?.dependencyKind ?? (depInfo?.type === 'devDependencies' ? 'dev-only' : 'runtime'),
        };
        if (existingBlockerIdx >= 0) {
          blockers[existingBlockerIdx] = hardBlocker;
        } else {
          blockers.unshift(hardBlocker);
        }
      } else if (isUnknown && isOldDate) {
        // Outcome: View Engine + unknown evidence + old publish date -> high-risk soft blocker
        const isoDate = !Number.isNaN(proposedMs) ? new Date(proposedMs).toISOString().slice(0, 10) : 'unknown date';
        const highRiskBlocker: Blocker = {
          ...(existingBlocker ?? {}),
          package: veName,
          reason: 'ivy-or-ngcc',
          hard: false,
          highRisk: true,
          unmaintained: isOldUnmaintained || existingBlocker?.unmaintained,
          evidence: evidenceKind ?? 'unknown',
          details: `${veName}@${installedVersion ?? 'installed'} is View Engine; proposed ${proposedVersion} ships Ivy fields but declares no Angular peer and has an old publish date (${isoDate}) — high-risk soft blocker. Verify carefully or replace.`,
          riskNote: `${veName}: installed View Engine library upgrading to ${proposedVersion} (${isoDate}) with unknown Angular peer compatibility.`,
          current: installedVersion,
          chosenVersion: proposedVersion,
          newestVersion: existingBlocker?.newestVersion ?? existingChange?.newestVersion,
          unknownExplanation: existingBlocker?.unknownExplanation ?? existingChange?.unknownExplanation,
          chosenVersionReason: existingBlocker?.chosenVersionReason,
          dependencyKind: existingBlocker?.dependencyKind ?? (depInfo?.type === 'devDependencies' ? 'dev-only' : 'runtime'),
        };
        if (existingBlockerIdx >= 0) {
          blockers[existingBlockerIdx] = highRiskBlocker;
        } else {
          blockers.unshift(highRiskBlocker);
        }
        if (proposedVersion && proposedVersion !== installedVersion) {
          notes.push({
            package: veName,
            kind: 'ivy-upgrade',
            severity: 'note',
            evidence: evidenceKind ?? 'unknown',
            message: `${veName}@${installedVersion ?? 'installed'} is compiled with View Engine/ngcc; must upgrade to ${proposedVersion} (Ivy-era release, ${isoDate}) for Angular ${targetMajor}.`,
            current: installedVersion,
            target: proposedVersion,
          });
        }
      } else {
        // Outcome: installed View Engine and an Ivy-era release exists -> "must upgrade to X" note
        notes.push({
          package: veName,
          kind: 'ivy-upgrade',
          severity: 'note',
          evidence: existingChange?.evidence ?? 'declared',
          message: `${veName}@${installedVersion ?? 'installed'} is compiled with View Engine/ngcc; must upgrade to ${proposedVersion} (Ivy-era release) for Angular ${targetMajor}.`,
          current: installedVersion,
          target: proposedVersion,
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
    if (rec.nextSteps && rec.nextSteps.length > 0) {
      b.nextSteps = rec.nextSteps;
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
    notes,
  };
}
