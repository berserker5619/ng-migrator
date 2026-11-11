import { execa } from 'execa';
import { NgmError } from '../errors.js';

/**
 * The only git subcommands the tool may run (plan section 12.1): it reads
 * status and the current commit, and never writes to the repository.
 */
const READ_ONLY_GIT = new Set(['status', 'rev-parse', 'ls-files', '--version', 'version']);

/** Global git options that take a value and come before the subcommand. */
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function isGit(command: string): boolean {
  const base = command.replace(/\\/g, '/').split('/').pop() ?? command;
  return /^git(\.exe|\.cmd)?$/i.test(base);
}

/** The git subcommand in an argument list, skipping global options. */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (GIT_OPTS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg === '--version' || arg === 'version') return arg;
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return undefined;
}

/** Throws unless the command is a read-only git call with --no-optional-locks (or not git at all). */
export function assertAllowedCommand(command: string, args: readonly string[]): void {
  if (!isGit(command)) return;
  const sub = gitSubcommand(args);
  if (sub === undefined || !READ_ONLY_GIT.has(sub)) {
    throw new NgmError('NGM-6002', `Refusing to run "git ${sub ?? ''}": ng-migrator never writes to git.`, {
      hint: 'This is a bug in ng-migrator. Please report it with the log file.',
    });
  }
  const subIdx = args.indexOf(sub);
  const lockIdx = args.indexOf('--no-optional-locks');
  if (lockIdx === -1 || lockIdx > subIdx) {
    throw new NgmError(
      'NGM-6002',
      `Refusing to run "git ${args.join(' ')}" without --no-optional-locks: ng-migrator never locks or modifies .git/index.`,
      {
        hint: 'This is a bug in ng-migrator. Please report it with the log file.',
      },
    );
  }
}

/**
 * Split a command prefix such as `fnm exec --using 16 --` or
 * `volta run --node "16.20.2"` into arguments. Supports single and double quotes.
 */
export function parseCommandPrefix(prefix: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (const ch of prefix.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) out.push(current);
      current = '';
      inToken = false;
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) throw new NgmError('NGM-2003', `Unterminated quote in command prefix: ${prefix}`);
  if (inToken) out.push(current);
  return out;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Milliseconds before the process is killed. */
  timeoutMs?: number;
  /** Prefix such as `fnm exec --using 16 --`, used to run under a step's Node version. */
  commandPrefix?: string;
  input?: string;
  cancelSignal?: AbortSignal;
}

export interface RunResult {
  /** The command as run, for logs (arguments joined with spaces). */
  command: string;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True if the process could not start or exited non-zero. */
  failed: boolean;
}

export type SpawnListener = (command: string, args: readonly string[]) => void;
const listeners = new Set<SpawnListener>();

/** Observe every subprocess the tool starts (used by tests to prove no git writes). */
export function onSpawn(listener: SpawnListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Run a subprocess. Always uses argument arrays (no shell), resolves binaries
 * from the project's node_modules/.bin, and handles Windows .cmd shims.
 * Never throws for a non-zero exit; check `failed` / `exitCode`.
 */
export async function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  assertAllowedCommand(command, args);

  const prefix = options.commandPrefix ? parseCommandPrefix(options.commandPrefix) : [];
  const [file, ...rest] = prefix.length > 0 ? [...prefix, command, ...args] : [command, ...args];
  for (const listener of listeners) listener(command, args);

  const result = await execa(file!, rest, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: true,
    preferLocal: true,
    localDir: options.cwd,
    reject: false,
    stripFinalNewline: true,
    windowsHide: true,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.cancelSignal === undefined ? {} : { cancelSignal: options.cancelSignal }),
  });

  return {
    command: [file, ...rest].join(' '),
    exitCode: result.exitCode,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    timedOut: Boolean(result.timedOut),
    failed: Boolean(result.failed),
  };
}

