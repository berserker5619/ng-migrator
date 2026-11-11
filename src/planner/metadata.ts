import semver from 'semver';
import { NgmError } from '../errors.js';
import type { StepRequirements } from '../model.js';
import { stableVersionsDesc, type RegistryClient } from '../registry/client.js';
import exceptions from '../rules/angular-exceptions.json' with { type: 'json' };

/**
 * Derives Node, TypeScript, RxJS, and zone.js requirements for a given Angular major
 * from published @angular/core, @angular/cli, and @angular/compiler-cli packuments,
 * augmented with exceptions and notes from angular-exceptions.json.
 */
export async function getStepRequirements(
  major: number,
  registry: RegistryClient,
): Promise<StepRequirements> {
  if (major < exceptions.oldestSupportedMajor) {
    throw new NgmError(
      'NGM-3008',
      `Angular ${major} is older than the oldest supported starting major (${exceptions.oldestSupportedMajor}).`,
      { hint: `Upgrade your project manually to Angular ${exceptions.oldestSupportedMajor} first.` },
    );
  }

  const [corePack, compilerPack, cliPack] = await Promise.all([
    registry.packument('@angular/core'),
    registry.packument('@angular/compiler-cli'),
    registry.packument('@angular/cli'),
  ]);

  if (!corePack) {
    throw new NgmError('NGM-6004', 'Could not fetch metadata for @angular/core.');
  }

  // Find the latest stable release for this major
  const coreVersions = stableVersionsDesc(corePack).filter(
    (v) => semver.major(v) === major,
  );
  if (coreVersions.length === 0) {
    throw new NgmError(
      'NGM-2002',
      `No published releases found for Angular major version ${major}.`,
    );
  }
  const coreVersion = coreVersions[0]!;
  const coreMeta = corePack.versions[coreVersion];

  // Node engine range from @angular/core and @angular/cli
  const cliVersions = cliPack
    ? stableVersionsDesc(cliPack).filter((v) => semver.major(v) === major)
    : [];
  const cliMeta = cliVersions[0] ? cliPack?.versions[cliVersions[0]] : undefined;

  const nodeEngine = coreMeta?.engines?.node ?? cliMeta?.engines?.node;

  // TypeScript requirement from @angular/compiler-cli
  let typescriptRange: string | undefined;
  if (compilerPack) {
    const compilerVersions = stableVersionsDesc(compilerPack).filter(
      (v) => semver.major(v) === major,
    );
    const compilerMeta = compilerVersions[0]
      ? compilerPack.versions[compilerVersions[0]]
      : undefined;
    typescriptRange =
      compilerMeta?.peerDependencies?.typescript ??
      compilerMeta?.peerDependenciesMeta?.typescript ? undefined : undefined;
    if (!typescriptRange && compilerMeta?.peerDependencies?.typescript) {
      typescriptRange = compilerMeta.peerDependencies.typescript;
    }
  }

  const rxjsRange = coreMeta?.peerDependencies?.rxjs;
  const zoneRange = coreMeta?.peerDependencies?.['zone.js'];

  const majorNotes =
    (exceptions.notes as Record<string, string[]>)[String(major)] ?? [];

  return {
    major,
    coreVersion,
    node: nodeEngine,
    typescript: typescriptRange,
    rxjs: rxjsRange,
    zone: zoneRange,
    notes: [...majorNotes],
  };
}

