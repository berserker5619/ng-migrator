import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli/program.js';
import { ERRORS, ExitCode } from '../src/errors.js';
import { TOOL_VERSION } from '../src/version.js';

function io(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    isTTY: false,
    env: {},
    nodeVersion: '24.0.0',
    cwd: process.cwd(),
    ...overrides,
  };
  return { value, out: () => out.join(''), err: () => err.join('') };
}

describe('cli', () => {
  it('prints the version', async () => {
    const t = io();
    expect(TOOL_VERSION).toBe('0.1.0');
    expect(await runCli(['--version'], t.value)).toBe(ExitCode.Success);
    expect(t.out().trim()).toBe('0.1.0');
  });

  it('lists the 1.0 commands in help and rejects migrate', async () => {
    const t = io();
    expect(await runCli(['--help'], t.value)).toBe(ExitCode.Success);
    for (const cmd of ['doctor', 'analyze', 'plan', 'status', 'approve']) expect(t.out()).toContain(cmd);
    expect(t.out()).not.toContain('migrate');

    const m = io();
    expect(await runCli(['migrate'], m.value)).toBe(ExitCode.Usage);
    expect(m.err()).toContain('NGM-2001');
  });

  it('exits 2 on an unknown flag', async () => {
    const t = io();
    expect(await runCli(['analyze', '--bogus'], t.value)).toBe(ExitCode.Usage);
    expect(t.err()).toContain('NGM-2001');
  });

  it('exits 2 on a range or minor passed to --to', async () => {
    for (const to of ['17-19', '19.1', 'latest', '^19']) {
      const t = io();
      expect(await runCli(['plan', '--to', to], t.value)).toBe(ExitCode.Usage);
      expect(t.err()).toContain('NGM-2002');
    }
  });

  it('exits 2 on an invalid step number', async () => {
    const t = io();
    expect(await runCli(['approve', 'two'], t.value)).toBe(ExitCode.Usage);
  });

  it('exits 6 on an unsupported Node version', async () => {
    const t = io({ nodeVersion: '18.19.0' });
    expect(await runCli(['status'], t.value)).toBe(ExitCode.Environment);
    expect(t.err()).toContain('NGM-6001');
  });

  it('uses ASCII symbols and no color when asked', async () => {
    const t = io({ isTTY: true });
    await runCli(['--no-color', '--ascii', 'plan', '--to', '19.1'], t.value);
    expect(t.err()).toContain('[x] NGM-2002');
    expect(t.err()).not.toContain('\u001b[');
  });

  it('has error ids whose first digit matches the exit code', () => {
    for (const [id, spec] of Object.entries(ERRORS)) expect(id.charAt(4)).toBe(String(spec.exitCode));
  });
});

