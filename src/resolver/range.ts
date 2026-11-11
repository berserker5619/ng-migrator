import semver from 'semver';

/**
 * Normalizes common malformed semver range strings encountered in real-world npm packages.
 * e.g. "7.x | 8.x" -> "7.x || 8.x"
 */
export function normalizeRange(range: string): string {
  let cleaned = range.trim();
  // Single pipe used instead of double pipe (e.g. @swimlane/ngx-charts: "7.x | 8.x")
  cleaned = cleaned.replace(/(?<!\|)\|(?!\|)/g, '||');
  return cleaned;
}

/**
 * Safely computes minVersion of a semver range string, returning null if invalid or cannot be parsed.
 */
export function safeMinVersion(range: string): semver.SemVer | null {
  try {
    const normalized = normalizeRange(range);
    return semver.minVersion(normalized);
  } catch {
    return null;
  }
}

/**
 * Preserves the prefix style (^, ~, >=, <=, or exact) of the original spec
 * when updating to a target version.
 */
export function preserveRangeStyle(targetVersion: string, originalSpec: string): string {
  const trimmed = originalSpec.trim();
  if (trimmed.startsWith('^')) return `^${targetVersion}`;
  if (trimmed.startsWith('~')) return `~${targetVersion}`;
  if (trimmed.startsWith('>=')) return `>=${targetVersion}`;
  // If exact or other format, default to exact if original was exact, or keep prefix
  const match = /^([^\d]*)/.exec(trimmed);
  const prefix = match ? match[1]! : '';
  if (prefix === '') return targetVersion;
  return `${prefix}${targetVersion}`;
}

/**
 * Checks if a candidate version's peerDependencies satisfy the target Angular version.
 * If peerDependencies['@angular/core'] is present, checks if coreVersion satisfies it.
 */
export function satisfiesAngularPeer(
  peerDeps: Record<string, string> | undefined,
  targetCoreVersion: string,
  targetMajor: number,
  candidateVersion?: string,
): boolean {
  if (!peerDeps) return true;
  const angularPeer = peerDeps['@angular/core'];
  if (!angularPeer) return true;

  const normalizedPeer = normalizeRange(angularPeer);
  if (!semver.validRange(normalizedPeer)) {
    return false;
  }

  const isPrerelease = candidateVersion ? semver.prerelease(candidateVersion) !== null : false;
  const targetIsPrerelease = semver.prerelease(targetCoreVersion) !== null;
  const includePrerelease = isPrerelease || targetIsPrerelease;

  try {
    // Check direct semver satisfaction
    if (semver.satisfies(targetCoreVersion, normalizedPeer, { includePrerelease })) {
      return true;
    }

    // Also check if the peer range allows any version in the target major
    // e.g. "^15.0.0 || ^16.0.0" or ">=15.0.0" or ">=15.0.2"
    const minV = semver.minVersion(normalizedPeer);
    if (minV && minV.major <= targetMajor) {
      // Check if the range overlaps with the major range e.g. ">=16.0.0 <17.0.0-0"
      const majorRange = `>=${targetMajor}.0.0 <${targetMajor + 1}.0.0-0`;
      if (
        semver.subset(majorRange, normalizedPeer, { includePrerelease }) ||
        semver.intersects(normalizedPeer, majorRange, { includePrerelease })
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

