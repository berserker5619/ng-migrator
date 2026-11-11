import { run } from './process.js';

export interface GitStatusResult {
  isGitRepo: boolean;
  clean: boolean;
  headCommit?: string;
  dirtyEntries: string[];
}

export async function checkGitStatus(cwd: string): Promise<GitStatusResult> {
  const statusRun = await run('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd });
  if (statusRun.failed) {
    // Not a git repository, or git is not installed
    return {
      isGitRepo: false,
      clean: true,
      dirtyEntries: [],
    };
  }

  const lines = statusRun.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.endsWith('.ng-migrator') && !l.includes('.ng-migrator/'));

  const headRun = await run('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd });
  const headCommit = headRun.exitCode === 0 ? headRun.stdout.trim() : undefined;

  return {
    isGitRepo: true,
    clean: lines.length === 0,
    headCommit,
    dirtyEntries: lines,
  };
}

