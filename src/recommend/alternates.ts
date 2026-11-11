import type { Packument, RegistryClient } from '../registry/client.js';
import { stableVersionsDesc } from '../registry/client.js';
import { satisfiesAngularPeer } from '../resolver/range.js';
import type { MigrationRule } from './rules.js';

export interface AlternateCandidate {
  name: string;
  compatibleVersion?: string;
  supportsTargetAngular: boolean;
  isAllowed: boolean;
  notes?: string;
}

export async function findAlternateCandidates(
  packageName: string,
  targetMajor: number,
  targetCoreVersion: string,
  registry: RegistryClient,
  rule?: MigrationRule,
  allowList: readonly string[] = [],
  denyList: readonly string[] = [],
): Promise<AlternateCandidate[]> {
  const candidates: string[] = [];

  if (rule?.alternatives) {
    candidates.push(...rule.alternatives);
  }

  const denySet = new Set(denyList);
  const allowSet = new Set(allowList);

  const results: AlternateCandidate[] = [];

  for (const candidateName of candidates) {
    // If it's a generic technology or guidance (e.g. "CSS flexbox/grid", "Tailwind CSS")
    if (candidateName.includes(' ') || candidateName === 'CSS flexbox/grid') {
      results.push({
        name: candidateName,
        supportsTargetAngular: true,
        isAllowed: true,
        notes: 'Architectural / styling replacement',
      });
      continue;
    }

    if (denySet.has(candidateName)) {
      results.push({
        name: candidateName,
        supportsTargetAngular: false,
        isAllowed: false,
        notes: 'Disallowed by project configuration (alternates.deny)',
      });
      continue;
    }

    if (allowSet.size > 0 && !allowSet.has(candidateName)) {
      results.push({
        name: candidateName,
        supportsTargetAngular: false,
        isAllowed: false,
        notes: 'Not in project approved list (alternates.allow)',
      });
      continue;
    }

    let pack: Packument | undefined;
    try {
      pack = await registry.packument(candidateName);
    } catch {
      // not in registry
    }

    if (!pack) {
      results.push({
        name: candidateName,
        supportsTargetAngular: false,
        isAllowed: true,
        notes: 'Could not fetch metadata from npm registry',
      });
      continue;
    }

    const versions = stableVersionsDesc(pack);
    const compatible = versions.find((v) => {
      const meta = pack!.versions[v];
      return satisfiesAngularPeer(meta?.peerDependencies, targetCoreVersion, targetMajor);
    });

    results.push({
      name: candidateName,
      compatibleVersion: compatible,
      supportsTargetAngular: compatible !== undefined,
      isAllowed: true,
      notes: compatible ? `Version ${compatible} supports Angular ${targetMajor}` : `No release supports Angular ${targetMajor}`,
    });
  }

  // Sort candidates: allowed & supported first, preserving rule order on ties
  return results.sort((a, b) => {
    if (a.supportsTargetAngular === b.supportsTargetAngular) {
      return 0;
    }
    return a.supportsTargetAngular ? -1 : 1;
  });
}
