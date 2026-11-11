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
 * A stale lock (dead process on this host) is reported, not silently removed.
 */
export async function acquireLock(root: string, command: string, now: Date = new Date()): Promise<Lock> {
  const file = lockPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), command, startedAt: now.toISOString() };

  try {
    await writeFile(file, `${JSON.stringify(info, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let held: Partial<LockInfo> = {};
    try {
      held = JSON.parse(await readFile(file, 'utf8')) as LockInfo;
    } catch {
      // Unreadable lock: treat as held by an unknown process.
    }
    const where = `${STATE_DIR}/${LOCK_FILE}`;
    const sameHost = held.hostname === os.hostname();
    if (sameHost && typeof held.pid === 'number' && !isProcessAlive(held.pid)) {
      throw new NgmError('NGM-3003', `A previous run ("${held.command ?? 'unknown'}", pid ${held.pid}) ended without releasing ${where}.`, {
        hint: `Make sure no ng-migrator is running, then delete ${where}.`,
      });
    }
    throw new NgmError(
      'NGM-3002',
      `Another ng-migrator run ("${held.command ?? 'unknown'}", pid ${held.pid ?? '?'} on ${held.hostname ?? 'unknown host'}) is using this project.`,
      { hint: `Wait for it to finish. If it is not running, delete ${where}.` },
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
export async function withLock<T>(root: string, command: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(root, command);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

