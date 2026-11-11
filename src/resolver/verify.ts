import { rmSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PackageManager } from '../config/config.js';
import type { PackageChange, PeerConflict, ResolutionCheck } from '../model.js';
import { pathExists, readJsonIfExists, removeWithRetry } from '../platform/fs.js';
import { run } from '../platform/process.js';

export const DEFAULT_RESOLUTION_TIMEOUT_MS = 300_000;

export interface VerifyResolutionOptions {
  projectRoot: string;
  packageManager: PackageManager;
  changes: PackageChange[];
  /** Timeout in milliseconds for the resolution subprocess (default: 300000 = 5 minutes). */
  timeoutMs?: number;
  /** Optional callback for informational messages (e.g. Yarn classic download estimate). */
  onNotice?: (message: string) => void;
  onTempDirReady?: (info: { tempDir: string; copiedFiles: string[] }) => void;
}

/**
 * Removes lockfile stanzas for the given package names from a Yarn lockfile
 * so Yarn keeps all unchanged dependencies locked and updates only the changed packages.
 */
export function pruneYarnLockEntries(content: string, packageNames: readonly string[]): string {
  if (packageNames.length === 0) return content;
  const targets = new Set(packageNames);
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let skippingStanza = false;

  const extractPkgName = (descriptor: string): string => {
    const cleaned = descriptor.trim().replace(/^["']|["']$/g, '');
    const atIdx = cleaned.startsWith('@') ? cleaned.indexOf('@', 1) : cleaned.indexOf('@');
    return atIdx > 0 ? cleaned.slice(0, atIdx) : cleaned;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (skippingStanza) {
      if (line.trim() === '') {
        skippingStanza = false;
        continue;
      }
      if (/^\s+/.test(line)) {
        continue;
      }
      skippingStanza = false;
    }

    if (!line.startsWith('#') && !/^\s/.test(line) && line.trimEnd().endsWith(':')) {
      const headerBody = line.trimEnd().slice(0, -1);
      if (headerBody !== '__metadata') {
        const descriptors = headerBody.split(',');
        if (descriptors.some((d) => targets.has(extractPkgName(d)))) {
          skippingStanza = true;
          continue;
        }
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

export function formatYarnClassicDownloadEstimate(
  changedCount: number,
  totalDirectDeps: number,
  hasYarnLock: boolean,
  timeoutMs: number,
): string {
  const packagesToFetch = hasYarnLock ? Math.max(changedCount, 1) : Math.max(totalDirectDeps, changedCount, 1);
  const approxMinMb = Math.max(5, Math.round(packagesToFetch * 1.5));
  const approxMaxMb = Math.max(15, Math.round(packagesToFetch * 4));
  const timeoutSec = Math.round(timeoutMs / 1000);
  const scopeNote = hasYarnLock
    ? `copied yarn.lock and updating ${changedCount} changed package(s)`
    : `installing ${totalDirectDeps} direct package(s)`;
  return `Yarn classic (1.x) has no lockfile-only mode: running isolated install in temp directory with --ignore-scripts (${scopeNote}; estimated download ~${approxMinMb}-${approxMaxMb} MB if uncached, timeout ${timeoutSec}s).`;
}

/**
 * Detects Yarn Classic (1.x) vs Yarn Berry (2+) from a yarn.lock file's content.
 * - Classic (v1): contains `# yarn lockfile v1` header.
 * - Berry (v2+): YAML format containing `__metadata:` key.
 */
export function detectYarnLockfileFlavor(content: string): 'classic' | 'berry' | undefined {
  if (/^#\s*yarn lockfile v1\b/im.test(content)) {
    return 'classic';
  }
  if (/^__metadata:\s*$/m.test(content)) {
    return 'berry';
  }
  return undefined;
}

/**
 * Detects Yarn Classic (1.x) vs Yarn Berry (2+) from `yarn --version` output.
 */
export function parseYarnVersionFlavor(versionOutput: string): {
  flavor?: 'classic' | 'berry';
  version?: string;
} {
  const cleaned = versionOutput.trim().split(/\r?\n/).pop()?.trim() ?? '';
  const match = /^v?(\d+)\.(\d+)\.(\d+(?:-[\w.-]+)?)$/.exec(cleaned);
  if (!match) {
    return {};
  }
  const major = Number.parseInt(match[1]!, 10);
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (major === 1) {
    return { flavor: 'classic', version };
  }
  if (major >= 2) {
    return { flavor: 'berry', version };
  }
  return { version };
}

export async function detectYarnFlavor(
  projectRoot: string,
  cwd: string,
  cancelSignal?: AbortSignal,
): Promise<{ flavor: 'classic' | 'berry'; version?: string }> {
  let lockfileFlavor: 'classic' | 'berry' | undefined;
  const yarnLockPath = path.join(projectRoot, 'yarn.lock');
  if (await pathExists(yarnLockPath)) {
    const content = await readFile(yarnLockPath, 'utf8').catch(() => '');
    lockfileFlavor = detectYarnLockfileFlavor(content);
  }

  const verRes = await run('yarn', ['--version'], { cwd, ...(cancelSignal ? { cancelSignal } : {}) });
  const parsedVer = verRes.exitCode === 0 ? parseYarnVersionFlavor(verRes.stdout) : {};

  // Prefer the installed binary flavor when lockfile is absent or matches; if lockfile says berry, use berry only when binary is 2+, otherwise classic binary cannot run --mode update-lockfile
  const flavor = parsedVer.flavor ?? lockfileFlavor ?? 'classic';
  return {
    flavor,
    ...(parsedVer.version ? { version: parsedVer.version } : {}),
  };
}

/**
 * Parses peer dependency conflicts and warnings from npm (ERESOLVE), pnpm, and yarn (v1 and Berry) output.
 * Not npm-only: supports npm ERESOLVE stanzas, pnpm unmet/missing peer trees, yarn v1 incorrect/unmet peer warnings,
 * and yarn Berry YN0060 peer warnings.
 */
export function parsePeerConflicts(output: string): PeerConflict[] {
  const conflicts: PeerConflict[] = [];
  const lines = output.split(/\r?\n/);
  let lastFound: string | undefined;
  let lastWhileResolving: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const whileMatch = /While resolving:\s+([@\w/.-]+@[\d\w.-]+)/i.exec(line);
    if (whileMatch) {
      lastWhileResolving = whileMatch[1]!;
    }

    const foundMatch = /(?:Found|Conflicting peer dependency):\s+([@\w/.-]+@[\d\w.-]+)/i.exec(line);
    if (foundMatch) {
      lastFound = foundMatch[1]!;
    }

    // Match npm: 'peer @angular/core@"^15.0.0" from @angular/material@15.2.0'
    const npmMatch = /peer\s+([@\w/.-]+)@["']([^"']+)["']\s+from\s+([@\w/.-]+@[\d\w.-]+)/i.exec(line);
    if (npmMatch) {
      conflicts.push({
        peer: npmMatch[1]!,
        range: npmMatch[2]!,
        requiredBy: npmMatch[3]!,
        ...(lastFound ? { found: lastFound } : {}),
      });
      continue;
    }

    // Match pnpm: '✕ unmet peer @angular/core@"^15.0.0": found 16.2.12' or '✕ missing peer @angular/core@"^15.0.0"' (under package header)
    const pnpmParentMatch = /^[\s└├│─┬]+([@\w/.-]+)\s+([\d]+\.[\d]+\.[\d]+[\w.-]*)\s*$/i.exec(line);
    if (pnpmParentMatch) {
      lastWhileResolving = `${pnpmParentMatch[1]}@${pnpmParentMatch[2]}`;
    }
    const pnpmPeerMatch = /unmet peer\s+([@\w/.-]+)@["']?([^"':]+)["']?:\s*found\s+([\d\w.-]+)/i.exec(line);
    if (pnpmPeerMatch && lastWhileResolving) {
      conflicts.push({
        peer: pnpmPeerMatch[1]!,
        range: pnpmPeerMatch[2]!.trim(),
        requiredBy: lastWhileResolving,
        found: `${pnpmPeerMatch[1]}@${pnpmPeerMatch[3]}`,
      });
      continue;
    }
    const pnpmMissingMatch = /missing peer\s+([@\w/.-]+)@["']?([^"':\s]+)["']?/i.exec(line);
    if (pnpmMissingMatch && lastWhileResolving) {
      conflicts.push({
        peer: pnpmMissingMatch[1]!,
        range: pnpmMissingMatch[2]!.trim(),
        requiredBy: lastWhileResolving,
      });
      continue;
    }

    // Match yarn v1: 'ngx-foo@3.1.0 requires a peer of @angular/core@^15.0.0'
    const yarnPeerMatch = /([@\w/.-]+@[\d\w.-]+)\s+requires a peer of\s+([@\w/.-]+)@["']?([^\s"']+)["']?/i.exec(line);
    if (yarnPeerMatch) {
      conflicts.push({
        peer: yarnPeerMatch[2]!,
        range: yarnPeerMatch[3]!,
        requiredBy: yarnPeerMatch[1]!,
      });
      continue;
    }
    // Match yarn v1: 'warning " > pkg@1.0.0" has incorrect/unmet peer dependency "@angular/core@^15.0.0"'
    const yarnWarnMatch = /([@\w/.-]+@[\d\w.-]+)["']?\s+has (?:incorrect|unmet) peer dependency\s+["']([@\w/.-]+)@([^"']+)["']/i.exec(line);
    if (yarnWarnMatch) {
      conflicts.push({
        peer: yarnWarnMatch[2]!,
        range: yarnWarnMatch[3]!,
        requiredBy: yarnWarnMatch[1]!,
      });
      continue;
    }
    // Match yarn Berry (YN0060): 'provides @angular/core (p123) with version 16.2.12, which doesn't satisfy what @angular/material (and others) request (^15.0.0).'
    const yarnBerryMatch = /provides\s+([@\w/.-]+)\s+(?:\([^)]+\)\s+)?with version\s+([\d\w.-]+),\s+which doesn't satisfy what\s+([@\w/.-]+)(?:\s+\(and others\))?\s+requests?\s+\(([^)]+)\)/i.exec(line);
    if (yarnBerryMatch) {
      conflicts.push({
        peer: yarnBerryMatch[1]!,
        found: `${yarnBerryMatch[1]}@${yarnBerryMatch[2]}`,
        requiredBy: yarnBerryMatch[3]!,
        range: yarnBerryMatch[4]!.trim(),
      });
    }
  }

  return conflicts;
}

/** Alias maintained for existing callers; delegates to multi-PM parsePeerConflicts. */
export const parseNpmEresolve = parsePeerConflicts;

/**
 * Verifies proposed dependency versions by running a lockfile-only dry run
 * in a temporary directory holding copies of the manifest, lockfile, and .npmrc (plan section 7.3).
 * Never touches the real project directory, and cleans up the temp directory even on process interruption.
 */
export async function verifyWithPackageManager(
  options: VerifyResolutionOptions,
): Promise<ResolutionCheck> {
  const {
    projectRoot,
    packageManager,
    changes,
    timeoutMs = DEFAULT_RESOLUTION_TIMEOUT_MS,
    onNotice,
    onTempDirReady,
  } = options;

  let tempDir: string | undefined;
  let cleaned = false;
  let interruptedExitCode: number | undefined;
  const abortController = new AbortController();
  const copiedFiles: string[] = [];

  const cleanupTempSync = () => {
    if (cleaned || !tempDir) return;
    cleaned = true;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore on exit
    }
  };
  const onSigInt = () => {
    interruptedExitCode = 130;
    abortController.abort();
    cleanupTempSync();
  };
  const onSigTerm = () => {
    interruptedExitCode = 143;
    abortController.abort();
    cleanupTempSync();
  };

  process.on('exit', cleanupTempSync);
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'ngm-resolve-'));

    // Read original package.json and apply proposed changes
    const originalPkg = await readJsonIfExists<Record<string, unknown>>(
      path.join(projectRoot, 'package.json'),
    );
    if (!originalPkg) {
      return { status: 'failed', detail: 'Could not read project package.json' };
    }

    const modifiedPkg = { ...originalPkg };
    const deps = { ...(modifiedPkg.dependencies as Record<string, string> | undefined) };
    const devDeps = { ...(modifiedPkg.devDependencies as Record<string, string> | undefined) };

    for (const change of changes) {
      if (change.type === 'devDependencies') {
        devDeps[change.name] = change.targetSpec;
      } else {
        deps[change.name] = change.targetSpec;
      }
    }

    modifiedPkg.dependencies = deps;
    modifiedPkg.devDependencies = devDeps;

    await writeFile(
      path.join(tempDir, 'package.json'),
      `${JSON.stringify(modifiedPkg, null, 2)}\n`,
    );
    copiedFiles.push('package.json');

    // Copy lockfiles if present
    for (const lockfile of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
      const src = path.join(projectRoot, lockfile);
      if (await pathExists(src)) {
        const dest = path.join(tempDir, lockfile);
        await copyFile(src, dest).catch(() => undefined);
        copiedFiles.push(lockfile);
        if (lockfile === 'package-lock.json' && changes.length > 0) {
          const lockJson = await readJsonIfExists<Record<string, unknown>>(dest).catch(() => undefined);
          if (lockJson) {
            const pkgs = lockJson.packages as Record<string, unknown> | undefined;
            const lockDeps = lockJson.dependencies as Record<string, unknown> | undefined;
            if (pkgs && pkgs[''] && typeof pkgs[''] === 'object') {
              const rootEntry = pkgs[''] as Record<string, unknown>;
              rootEntry.dependencies = deps;
              rootEntry.devDependencies = devDeps;
            }
            for (const change of changes) {
              if (pkgs) delete pkgs[`node_modules/${change.name}`];
              if (lockDeps) delete lockDeps[change.name];
            }
            await writeFile(dest, `${JSON.stringify(lockJson, null, 2)}\n`).catch(() => undefined);
          }
        } else if (lockfile === 'yarn.lock' && changes.length > 0) {
          const rawLock = await readFile(dest, 'utf8').catch(() => undefined);
          if (rawLock !== undefined) {
            const pruned = pruneYarnLockEntries(
              rawLock,
              changes.map((c) => c.name),
            );
            await writeFile(dest, pruned).catch(() => undefined);
          }
        }
      }
    }

    // Copy .npmrc if present
    const npmrcSrc = path.join(projectRoot, '.npmrc');
    if (await pathExists(npmrcSrc)) {
      await copyFile(npmrcSrc, path.join(tempDir, '.npmrc')).catch(() => undefined);
      copiedFiles.push('.npmrc');
    }

    onTempDirReady?.({ tempDir, copiedFiles: [...copiedFiles] });

    // Run resolution check in the isolated OS temp directory
    let cmd = 'npm';
    let args: string[] = [
      'install',
      '--package-lock-only',
      '--dry-run',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
    ];
    let yarnFlavor: 'classic' | 'berry' | undefined;
    let downloadEstimateMessage: string | undefined;

    if (packageManager === 'pnpm') {
      cmd = 'pnpm';
      args = [
        'install',
        '--lockfile-only',
        '--ignore-scripts',
        '--strict-peer-dependencies',
        '--config.strict-peer-dependencies=true',
      ];
    } else if (packageManager === 'yarn') {
      cmd = 'yarn';
      const detected = await detectYarnFlavor(projectRoot, tempDir, abortController.signal);
      yarnFlavor = detected.flavor;
      if (yarnFlavor === 'berry') {
        args = ['install', '--mode', 'update-lockfile', '--ignore-scripts'];
      } else {
        args = ['install', '--ignore-scripts', '--non-interactive', '--no-progress'];
        const totalDirectDeps = Object.keys(deps).length + Object.keys(devDeps).length;
        const hasYarnLock = copiedFiles.includes('yarn.lock');
        downloadEstimateMessage = formatYarnClassicDownloadEstimate(
          changes.length,
          totalDirectDeps,
          hasYarnLock,
          timeoutMs,
        );
        onNotice?.(downloadEstimateMessage);
      }
    }

    const command = `${cmd} ${args.join(' ')}`;
    const result = await run(cmd, args, {
      cwd: tempDir,
      timeoutMs,
      cancelSignal: abortController.signal,
    });

    await removeWithRetry(tempDir).catch(() => undefined);
    cleaned = true;
    const tempDirCleaned = !(await pathExists(tempDir));

    if (interruptedExitCode !== undefined && !process.env.VITEST) {
      process.exit(interruptedExitCode);
    }

    const fullOutput = `${result.stdout}\n${result.stderr}`;
    const conflicts = parsePeerConflicts(fullOutput);
    const hasWarningLines = /(?:^|\n)\s*(?:npm warn|warn\b|warning\b|➤ YN\d+:)/i.test(fullOutput);
    const extraMeta = {
      ...(yarnFlavor ? { yarnFlavor } : {}),
      ...(downloadEstimateMessage ? { downloadEstimateMessage } : {}),
      timeoutMs,
      ...(result.timedOut ? { timedOut: true } : {}),
      command,
    };

    // Even if npm, pnpm, or yarn exits 0, peer warnings parsed from output are treated as peer-conflict blockers
    if (conflicts.length > 0) {
      return {
        status: 'conflict',
        packageManager,
        ...extraMeta,
        withWarnings: result.exitCode === 0 || hasWarningLines,
        detail: 'Peer dependency conflict during resolution check.',
        conflicts,
        tempDir,
        copiedFiles,
        tempDirCleaned,
      };
    }

    if (result.exitCode === 0) {
      return {
        status: 'confirmed',
        packageManager,
        ...extraMeta,
        withWarnings: hasWarningLines,
        tempDir,
        copiedFiles,
        tempDirCleaned,
      };
    }

    if (
      fullOutput.includes('ERESOLVE') ||
      fullOutput.includes('Could not resolve dependency') ||
      fullOutput.includes('ERR_PNPM_PEER_DEP_ISSUES') ||
      fullOutput.includes('unmet peer') ||
      fullOutput.includes('requires a peer of') ||
      fullOutput.includes('has incorrect peer dependency') ||
      fullOutput.includes('has unmet peer dependency')
    ) {
      return {
        status: 'conflict',
        packageManager,
        ...extraMeta,
        withWarnings: hasWarningLines,
        detail: 'Peer dependency conflict during resolution check.',
        tempDir,
        copiedFiles,
        tempDirCleaned,
      };
    }

    if (packageManager === 'yarn' && yarnFlavor === 'classic') {
      return {
        status: 'unverified',
        packageManager,
        ...extraMeta,
        withWarnings: hasWarningLines,
        detail: 'resolution not verified (yarn classic)',
        tempDir,
        copiedFiles,
        tempDirCleaned,
      };
    }

    return {
      status: 'failed',
      packageManager,
      ...extraMeta,
      withWarnings: hasWarningLines,
      detail: result.stderr.trim() || result.stdout.trim() || `Package manager exited with code ${result.exitCode}`,
      tempDir,
      copiedFiles,
      tempDirCleaned,
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: (err as Error).message,
    };
  } finally {
    process.off('exit', cleanupTempSync);
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    if (tempDir && !cleaned) {
      cleaned = true;
      await removeWithRetry(tempDir).catch(() => undefined);
    }
  }
}
