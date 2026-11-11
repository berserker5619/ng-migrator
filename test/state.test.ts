import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/platform/process.js';
import { acquireLock, lockPath, withLock } from '../src/state/lock.js';
import { SCHEMA_VERSION, createState, readState, statePath, writeState } from '../src/state/state.js';
import { TOOL_VERSION } from '../src/version.js';
import { tempProject } from './helpers.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempProject()));
afterEach(async () => cleanup());

describe('state', () => {
  it('returns undefined when there is no state yet', async () => {
    expect(await readState(dir)).toBeUndefined();
  });

  it('round-trips state atomically with LF JSON', async () => {
    const state = createState(new Date('2026-11-09T00:00:00Z'));
    state.steps.push({
      index: 1,
      from: 13,
      to: 14,
      status: 'planned',
      files: { created: [], changed: [], deleted: [] },
      verification: [],
      decisions: { 'tooltip-choice': false },
    });
    await writeState(dir, state, new Date('2026-11-09T01:00:00Z'));
    const back = await readState(dir);
    expect(back).toMatchObject({ schemaVersion: SCHEMA_VERSION, toolVersion: TOOL_VERSION, updatedAt: '2026-11-09T01:00:00.000Z' });
    expect(back?.steps[0]?.decisions).toEqual({ 'tooltip-choice': false });
    expect(await readFile(statePath(dir), 'utf8')).not.toContain('\r');
  });

  it('refuses a newer schema with a clear error', async () => {
    await mkdir(path.dirname(statePath(dir)), { recursive: true });
    await writeFile(statePath(dir), JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, steps: [] }));
    await expect(readState(dir)).rejects.toMatchObject({ id: 'NGM-3004', exitCode: 3 });
  });

  it('reports corrupt state', async () => {
    await mkdir(path.dirname(statePath(dir)), { recursive: true });
    await writeFile(statePath(dir), '{ half written');
    await expect(readState(dir)).rejects.toMatchObject({ id: 'NGM-3005' });
    await writeFile(statePath(dir), '{}');
    await expect(readState(dir)).rejects.toMatchObject({ id: 'NGM-3005' });
  });
});

describe('lock', () => {
  it('prevents a second run and releases cleanly', async () => {
    const lock = await acquireLock(dir, 'plan');
    await expect(acquireLock(dir, 'analyze')).rejects.toMatchObject({ id: 'NGM-3002' });
    await lock.release();
    await withLock(dir, 'status', async () => undefined);
    await expect(readFile(lockPath(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a stale lock from a dead process with instructions on how to clear it, instead of removing it', async () => {
    await mkdir(path.dirname(lockPath(dir)), { recursive: true });
    // A pid this high is not a live process on any CI runner.
    const stale = { pid: 2 ** 22 + 12345, hostname: os.hostname(), command: 'plan', startedAt: '2026-01-01T00:00:00Z' };
    await writeFile(lockPath(dir), JSON.stringify(stale));
    await expect(acquireLock(dir, 'plan')).rejects.toMatchObject({
      id: 'NGM-3003',
      message: expect.stringContaining('ended without releasing .ng-migrator/lock'),
      hint: 'Make sure no ng-migrator is running, then delete .ng-migrator/lock.',
    });
    expect(JSON.parse(await readFile(lockPath(dir), 'utf8'))).toEqual(stale);
  });

  it('releases the lock even if the work throws or is interrupted', async () => {
    await expect(withLock(dir, 'plan', async () => Promise.reject(new Error('interrupted')))).rejects.toThrow('interrupted');
    await expect(readFile(lockPath(dir))).rejects.toMatchObject({ code: 'ENOENT' });
    await acquireLock(dir, 'plan').then((l) => l.release());
  });

  it('releases the lock file on process exit interruption', async () => {
    const lock = await acquireLock(dir, 'plan');
    // Simulate process exit listener firing before async release()
    process.emit('exit', 1);
    await expect(readFile(lockPath(dir))).rejects.toMatchObject({ code: 'ENOENT' });
    await lock.release();
  });

  it('releases the lock file on SIGINT and SIGTERM where the platform allows', async () => {
    const lock1 = await acquireLock(dir, 'plan');
    process.emit('SIGINT', 'SIGINT');
    await expect(readFile(lockPath(dir))).rejects.toMatchObject({ code: 'ENOENT' });
    await lock1.release();

    const lock2 = await acquireLock(dir, 'plan');
    process.emit('SIGTERM', 'SIGTERM');
    await expect(readFile(lockPath(dir))).rejects.toMatchObject({ code: 'ENOENT' });
    await lock2.release();
  });

  it('detects a lock left by a killed child process as stale (NGM-3003) and shows the hint', async () => {
    await mkdir(path.dirname(lockPath(dir)), { recursive: true });
    // Spawn a real child process via src/platform/process.ts that writes a lock file with its real PID and then gets killed via timeoutMs
    await run(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs'); const os = require('node:os'); fs.writeFileSync(${JSON.stringify(lockPath(dir))}, JSON.stringify({ pid: process.pid, hostname: os.hostname(), command: 'plan', startedAt: new Date().toISOString() })); setInterval(() => {}, 10000);`,
      ],
      { cwd: dir, timeoutMs: 150 },
    );

    const writtenLock = JSON.parse(await readFile(lockPath(dir), 'utf8')) as { pid: number };
    expect(typeof writtenLock.pid).toBe('number');

    await expect(acquireLock(dir, 'plan')).rejects.toMatchObject({
      id: 'NGM-3003',
      message: expect.stringContaining(`pid ${writtenLock.pid}`),
      hint: 'Make sure no ng-migrator is running, then delete .ng-migrator/lock.',
    });
  });
});

