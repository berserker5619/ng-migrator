import { describe, expect, it } from 'vitest';
import { NgmError } from '../src/errors.js';
import { assertAllowedCommand, gitSubcommand, onSpawn, parseCommandPrefix, run } from '../src/platform/process.js';

describe('git guard', () => {
  it('allows read-only git commands', () => {
    for (const args of [['status', '--porcelain'], ['rev-parse', 'HEAD'], ['--version'], ['-C', 'some dir', 'status']]) {
      expect(() => assertAllowedCommand('git', args)).not.toThrow();
    }
  });

  it.each(['add', 'commit', 'push', 'stash', 'checkout', 'reset', 'revert', 'tag', 'config', 'init'])(
    'refuses git %s',
    (sub) => {
      expect(() => assertAllowedCommand('git', [sub])).toThrow(NgmError);
      expect(() => assertAllowedCommand('C:\\Program Files\\Git\\cmd\\git.exe', ['-c', 'x=y', sub])).toThrow(NgmError);
    },
  );

  it('refuses bare git with no subcommand', () => {
    expect(() => assertAllowedCommand('git', [])).toThrow(NgmError);
  });

  it('finds the subcommand after global options', () => {
    expect(gitSubcommand(['-C', 'dir', '--no-pager', 'status'])).toBe('status');
  });

  it('ignores non-git commands', () => {
    expect(() => assertAllowedCommand('npm', ['commit'])).not.toThrow();
  });

  it('blocks git writes in run() before anything is spawned', async () => {
    const seen: string[] = [];
    const off = onSpawn((cmd, args) => seen.push([cmd, ...args].join(' ')));
    await expect(run('git', ['commit', '-m', 'x'], { cwd: process.cwd() })).rejects.toThrow(NgmError);
    off();
    expect(seen).toEqual([]);
  });
});

describe('command prefix', () => {
  it('splits on whitespace and honors quotes', () => {
    expect(parseCommandPrefix('fnm exec --using 16 --')).toEqual(['fnm', 'exec', '--using', '16', '--']);
    expect(parseCommandPrefix(`volta run --node "16.20.2" 'a b'`)).toEqual(['volta', 'run', '--node', '16.20.2', 'a b']);
    expect(parseCommandPrefix('x ""')).toEqual(['x', '']);
  });

  it('rejects unterminated quotes', () => {
    expect(() => parseCommandPrefix('fnm "exec')).toThrow(NgmError);
  });
});

describe('run', () => {
  it('runs a process with an argument array and captures output', async () => {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("hi " + process.argv[1])', 'with space'], {
      cwd: process.cwd(),
    });
    expect(r).toMatchObject({ exitCode: 0, stdout: 'hi with space', failed: false });
  });

  it('reports non-zero exits without throwing', async () => {
    const r = await run(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'], { cwd: process.cwd() });
    expect(r).toMatchObject({ exitCode: 3, stderr: 'bad', failed: true });
  });

  it('applies the command prefix', async () => {
    // The prefix runs node, which then runs the script given as the command.
    const r = await run('-e', ['process.stdout.write("prefixed")'], { cwd: process.cwd(), commandPrefix: `"${process.execPath}"` });
    expect(r.stdout).toBe('prefixed');
  });
});

