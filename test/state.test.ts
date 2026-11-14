import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  it('prevents a second run and releases cleanly with the NGM-3003 manual hint', async () => {
    const lock = await acquireLock(dir, 'plan');
    const written = JSON.parse(await readFile(lockPath(dir), 'utf8')) as {
      pid: number;
      hostname: string;
      startedAt: string;
      processStartedAtMs?: number;
    };
    expect(written.pid).toBe(process.pid);
    expect(written.hostname).toBe(os.hostname());
    expect(typeof written.processStartedAtMs).toBe('number');

    await expect(acquireLock(dir, 'analyze')).rejects.toMatchObject({
      id: 'NGM-3002',
      hint: expect.stringContaining('Make sure no ng-migrator is running, then delete .ng-migrator/lock.'),
    });
    await lock.release();
    await withLock(dir, 'status', async () => undefined);
    await expect(readFile(lockPath(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('auto-recovers a stale lock from a dead process on the same host and prints what it did', async () => {
    await mkdir(path.dirname(lockPath(dir)), { recursive: true });
    // A pid this high is not a live process on any CI runner.
    const deadPid = 2 ** 22 + 12345;
    const stale = {
      pid: deadPid,
      hostname: os.hostname(),
      command: 'plan',
      startedAt: '2026-01-01T00:00:00Z',
    };
    await writeFile(lockPath(dir), JSON.stringify(stale));

    const notices: string[] = [];
    const recovered = await acquireLock(dir, 'plan', new Date(), (msg) => notices.push(msg));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Recovered stale lock .ng-migrator/lock from dead process');
    expect(notices[0]).toContain(`pid ${deadPid}`);

    const replacement = JSON.parse(await readFile(lockPath(dir), 'utf8')) as { pid: number };
    expect(replacement.pid).toBe(process.pid);
    await recovered.release();
  });

  it('auto-recovers a lock from before host boot even when the PID was later reused', async () => {
    await mkdir(path.dirname(lockPath(dir)), { recursive: true });
    const preBoot = Date.now() - os.uptime() * 1000 - 120_000;
    const stale = {
      pid: process.pid,
      hostname: os.hostname(),
      command: 'plan',
      startedAt: new Date(preBoot).toISOString(),
      processStartedAtMs: preBoot,
    };
    await writeFile(lockPath(dir), JSON.stringify(stale));

    const notices: string[] = [];
    const recovered = await acquireLock(dir, 'plan', new Date(), (msg) => notices.push(msg));
    expect(notices[0]).toContain('Recovered stale lock .ng-migrator/lock');
    await recovered.release();
  });

  it('refuses with NGM-3003 hint when lock owner cannot be determined (corrupt, incomplete, or other host)', async () => {
    await mkdir(path.dirname(lockPath(dir)), { recursive: true });

    await writeFile(lockPath(dir), '{not-valid-json');
    await expect(acquireLock(dir, 'plan')).rejects.toMatchObject({
      id: 'NGM-3003',
      hint: 'Make sure no ng-migrator is running, then delete .ng-migrator/lock.',
    });

    const missingStart = { pid: 2 ** 22 + 999, hostname: os.hostname(), command: 'plan' };
    await writeFile(lockPath(dir), JSON.stringify(missingStart));
    await expect(acquireLock(dir, 'plan')).rejects.toMatchObject({
      id: 'NGM-3003',
      hint: 'Make sure no ng-migrator is running, then delete .ng-migrator/lock.',
    });

    const otherHost = {
      pid: 2 ** 22 + 999,
      hostname: 'other-ci-runner.invalid',
      command: 'plan',
      startedAt: new Date().toISOString(),
    };
    await writeFile(lockPath(dir), JSON.stringify(otherHost));
    await expect(acquireLock(dir, 'plan')).rejects.toMatchObject({
      id: 'NGM-3003',
      hint: 'Make sure no ng-migrator is running, then delete .ng-migrator/lock.',
    });
    expect(JSON.parse(await readFile(lockPath(dir), 'utf8'))).toEqual(otherHost);
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

  it('auto-recovers a lock left by a SIGKILLed child process and prints what it did', async () => {
    const targetLock = lockPath(dir);
    await mkdir(path.dirname(targetLock), { recursive: true });

    const child = execa(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs'); const os = require('node:os'); fs.writeFileSync(${JSON.stringify(targetLock)}, JSON.stringify({ pid: process.pid, hostname: os.hostname(), command: 'plan', startedAt: new Date().toISOString(), processStartedAtMs: Date.now() - Math.floor(process.uptime() * 1000) })); console.log('READY'); setInterval(() => {}, 10000);`,
      ],
      { cwd: dir, windowsHide: true, reject: false },
    );

    // Wait until the child actually writes the lock file before sending SIGKILL
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const content = await readFile(targetLock, 'utf8').catch(() => '');
      if (content.includes('"pid"')) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    child.kill('SIGKILL');
    await child;

    const writtenLock = JSON.parse(await readFile(targetLock, 'utf8')) as { pid: number };
    expect(typeof writtenLock.pid).toBe('number');

    const notices: string[] = [];
    const recovered = await acquireLock(dir, 'plan', new Date(), (msg) => notices.push(msg));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Recovered stale lock .ng-migrator/lock from dead process');
    expect(notices[0]).toContain(`pid ${writtenLock.pid}`);
    await recovered.release();
  });
});

