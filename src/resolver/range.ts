import semver from 'semver';

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
): boolean {
  if (!peerDeps) return true;
  const angularPeer = peerDeps['@angular/core'];
  if (!angularPeer) return true;

  // Check direct semver satisfaction
  if (semver.satisfies(targetCoreVersion, angularPeer, { includePrerelease: false })) {
    return true;
  }

  // Also check if the peer range allows any version in the target major
  // e.g. "^15.0.0 || ^16.0.0" or ">=15.0.0"
  const minV = semver.minVersion(angularPeer);
  if (minV && minV.major <= targetMajor) {
    // Check if the range overlaps with the major range e.g. ">=16.0.0 <17.0.0-0"
    const majorRange = `>=${targetMajor}.0.0 <${targetMajor + 1}.0.0-0`;
    if (semver.subset(majorRange, angularPeer) || semver.intersects(angularPeer, majorRange)) {
      return true;
    }
  }

  return false;
}

