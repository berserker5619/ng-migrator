import { rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NgmError } from '../errors.js';
import { removeWithRetry } from '../platform/fs.js';
import { STATE_DIR, stateDir } from './state.js';

export const LOCK_FILE = 'lock';

export interface LockInfo {
  pid: number;
  hostname: string;
  command: string;
  startedAt: string;
  processStartedAtMs?: number;
}

export function lockPath(root: string): string {
  return path.join(stateDir(root), LOCK_FILE);
}

/** True if a process with this pid exists on this machine. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Lock {
  release(): Promise<void>;
}

/**
 * Take the per-project lock so two runs never touch the same project.
 * Automatically recovers a lock whose owning process is verifiably dead on this host
 * (matching hostname, valid start time, PID not running or pre-boot). Refuses when held by
 * a live process or when the owner cannot be determined.
 */
export async function acquireLock(
  root: string,
  command: string,
  now: Date = new Date(),
  onNotice?: (message: string) => void,
): Promise<Lock> {
  const file = lockPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    command,
    startedAt: now.toISOString(),
    processStartedAtMs: now.getTime() - Math.floor(process.uptime() * 1000),
  };

  const where = `${STATE_DIR}/${LOCK_FILE}`;
  const manualHint = `Make sure no ng-migrator is running, then delete ${where}.`;

  try {
    await writeFile(file, `${JSON.stringify(info, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let held: Partial<LockInfo> | undefined;
    try {
      held = JSON.parse(await readFile(file, 'utf8')) as LockInfo;
    } catch {
      held = undefined;
    }

    if (
      !held ||
      typeof held.hostname !== 'string' ||
      held.hostname.length === 0 ||
      typeof held.pid !== 'number' ||
      !Number.isInteger(held.pid) ||
      held.pid <= 0 ||
      typeof held.startedAt !== 'string' ||
      Number.isNaN(Date.parse(held.startedAt))
    ) {
      throw new NgmError('NGM-3003', `Existing lock ${where} has unreadable or incomplete owner metadata.`, {
        hint: manualHint,
      });
    }

    const ownerPid = held.pid;
    const ownerHost = held.hostname;
    const ownerCommand = held.command ?? 'unknown';
    const ownerStartedAt = held.startedAt;

    if (ownerHost !== os.hostname()) {
      throw new NgmError(
        'NGM-3003',
        `Another ng-migrator run ("${ownerCommand}", pid ${ownerPid} on host ${ownerHost}) holds ${where}, and its status cannot be verified from this host (${os.hostname()}).`,
        { hint: manualHint },
      );
    }

    const bootTimeMs = Date.now() - os.uptime() * 1000;
    const preBootProcess =
      typeof held.processStartedAtMs === 'number' && held.processStartedAtMs < bootTimeMs - 60_000;
    const ownerAlive = isProcessAlive(ownerPid) && !preBootProcess;

    if (ownerAlive) {
      throw new NgmError(
        'NGM-3002',
        `Another ng-migrator run ("${ownerCommand}", pid ${ownerPid} on ${ownerHost}) is using this project.`,
        { hint: `Wait for it to finish. ${manualHint}` },
      );
    }

    // Verifiably dead on the same host: auto-recover the stale lock atomically.
    await removeWithRetry(file);
    try {
      await writeFile(file, `${JSON.stringify(info, null, 2)}\n`, { flag: 'wx' });
    } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new NgmError(
          'NGM-3002',
          `Another ng-migrator run acquired ${where} while stale lock recovery was in progress.`,
          { hint: `Wait for it to finish. ${manualHint}` },
        );
      }
      throw retryErr;
    }
    onNotice?.(
      `Recovered stale lock ${where} from dead process (pid ${ownerPid}, host ${ownerHost}, command "${ownerCommand}", started ${ownerStartedAt}).`,
    );
  }

  let released = false;
  const onExitCleanup = () => {
    if (released) return;
    released = true;
    try {
      rmSync(file, { force: true });
    } catch {
      // ignore on exit
    }
  };
  const onSigInt = () => {
    onExitCleanup();
    if (!process.env.VITEST) setTimeout(() => process.exit(130), 200).unref();
  };
  const onSigTerm = () => {
    onExitCleanup();
    if (!process.env.VITEST) setTimeout(() => process.exit(143), 200).unref();
  };
  process.on('exit', onExitCleanup);
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  return {
    async release() {
      process.off('exit', onExitCleanup);
      process.off('SIGINT', onSigInt);
      process.off('SIGTERM', onSigTerm);
      if (released) return;
      released = true;
      await removeWithRetry(file);
    },
  };
}

/** Run `fn` while holding the project lock. */
export async function withLock<T>(
  root: string,
  command: string,
  fn: () => Promise<T>,
  onNotice?: (message: string) => void,
): Promise<T> {
  const lock = await acquireLock(root, command, new Date(), onNotice);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

