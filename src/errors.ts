/**
 * Exit codes and stable error identifiers (plan section 19.3).
 * Identifiers never change meaning once released; add new ones instead.
 */

export const ExitCode = {
  Success: 0,
  Unexpected: 1,
  Usage: 2,
  Precondition: 3,
  HardBlockers: 4,
  VerificationFailed: 5,
  Environment: 6,
  Snapshot: 7,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

interface ErrorSpec {
  exitCode: ExitCode;
  title: string;
}

/** Catalog of every error identifier. The first digit matches the exit code. */
export const ERRORS = {
  'NGM-1001': { exitCode: ExitCode.Unexpected, title: 'Unexpected internal error' },
  'NGM-1002': { exitCode: ExitCode.Unexpected, title: 'Command not implemented yet' },
  'NGM-2001': { exitCode: ExitCode.Usage, title: 'Invalid command-line usage' },
  'NGM-2002': { exitCode: ExitCode.Usage, title: 'Invalid target version' },
  'NGM-2003': { exitCode: ExitCode.Usage, title: 'Invalid configuration file' },
  'NGM-3001': { exitCode: ExitCode.Precondition, title: 'Working tree has uncommitted changes' },
  'NGM-3002': { exitCode: ExitCode.Precondition, title: 'Another ng-migrator run holds the lock' },
  'NGM-3003': { exitCode: ExitCode.Precondition, title: 'Stale lock from a run that is no longer active' },
  'NGM-3004': { exitCode: ExitCode.Precondition, title: 'State file was written by a newer ng-migrator' },
  'NGM-3005': { exitCode: ExitCode.Precondition, title: 'State file is unreadable' },
  'NGM-3006': { exitCode: ExitCode.Precondition, title: 'Path is outside the project' },
  'NGM-3007': { exitCode: ExitCode.Precondition, title: 'Not an Angular project' },
  'NGM-3008': { exitCode: ExitCode.Precondition, title: 'Angular version not supported' },
  'NGM-4001': { exitCode: ExitCode.HardBlockers, title: 'Hard blockers found during analysis' },
  'NGM-6001': { exitCode: ExitCode.Environment, title: 'Unsupported Node version' },
  'NGM-6002': { exitCode: ExitCode.Environment, title: 'Blocked subprocess' },
  'NGM-6003': { exitCode: ExitCode.Environment, title: 'Registry authentication failed' },
  'NGM-6004': { exitCode: ExitCode.Environment, title: 'Registry unreachable' },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorId = keyof typeof ERRORS;

export class NgmError extends Error {
  readonly id: ErrorId;
  readonly exitCode: ExitCode;
  /** What the user should do next. */
  readonly hint: string | undefined;

  constructor(id: ErrorId, message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NgmError';
    this.id = id;
    this.exitCode = ERRORS[id].exitCode;
    this.hint = options.hint;
  }
}

export function isNgmError(value: unknown): value is NgmError {
  return value instanceof NgmError;
}

