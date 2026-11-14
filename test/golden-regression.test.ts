import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config/config.js';
import type { ProjectInfo } from '../src/model.js';
import { run } from '../src/platform/process.js';
import { createPlan } from '../src/planner/plan.js';
import type { Packument, RegistryClient } from '../src/registry/client.js';
import { verifyWithPackageManager } from '../src/resolver/verify.js';

interface GoldenStepExpectation {
  step: number;
  from: number;
  to: number;
  blockerCount: number;
  noteCount: number;
  blockers: Array<{
    package: string;
    reason: string;
    hard: boolean;
    highRisk: boolean;
    evidence: string | null;
  }>;
  notes: Array<{
    package: string;
    kind: string;
    severity: string;
    evidence: string;
  }>;
}

interface GoldenCountsFile {
  clock: string;
  mode: string;
  projects: Record<
    string,
    {
      targetMajor: number;
      steps: GoldenStepExpectation[];
    }
  >;
}

type StoredProject = Omit<ProjectInfo, 'root'> & {
  stubFiles?: Record<string, string>;
};

interface GoldenProjectsFile {
  projects: Record<string, StoredProject>;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('Offline golden regression suite', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reproduces exact blocker and note counts per step across the 5 corpus projects + ngx-admin offline', async () => {
    const registryData = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, 'test/fixtures/golden-registry.json'), 'utf8'),
    ) as Record<string, Packument>;
    const projectsFile = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, 'test/fixtures/golden-projects.json'), 'utf8'),
    ) as GoldenProjectsFile;
    const goldenCounts = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, 'corpus/golden-counts.json'), 'utf8'),
    ) as GoldenCountsFile;

    const fakeRegistry = {
      async packument(name: string): Promise<Packument | undefined> {
        return registryData[name];
      },
    } as unknown as RegistryClient;

    const fixedDate = new Date(goldenCounts.clock);
    const fixedNow = fixedDate.getTime();
    const fixedClock = () => new Date(fixedNow);

    const projectNames = Object.keys(goldenCounts.projects);
    expect(projectNames).toEqual([
      'angular-13-login',
      'angular-14-login',
      'angular-15-signup-boilerplate',
      'k8s-istio-observe-frontend',
      'ng-material-starter-kit',
      'ngx-admin',
    ]);

    for (const name of projectNames) {
      const expected = goldenCounts.projects[name]!;
      const stored = projectsFile.projects[name];
      expect(stored, `missing fixture project ${name}`).toBeDefined();

      const { stubFiles, ...projectBase } = stored!;
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ngm-golden-${name}-`));
      tempDirs.push(tempRoot);

      for (const [rel, content] of Object.entries(stubFiles ?? {})) {
        const dest = path.join(tempRoot, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, 'utf8');
      }

      const project: ProjectInfo = {
        ...projectBase,
        root: tempRoot,
      };

      const ngxAdminConflicts =
        name === 'ngx-admin'
          ? (JSON.parse(
              await fs.readFile(path.join(REPO_ROOT, 'test/fixtures/resolution/ngx-admin-ng16-conflicts.json'), 'utf8'),
            ) as {
              initialEresolveStderr: string;
              recheckEresolveStderr: string;
              initialNpmLsJson: unknown;
              recheckNpmLsJson: unknown;
              lockfileJson: unknown;
            })
          : undefined;

      if (ngxAdminConflicts) {
        const deps: Record<string, string> = {};
        const devDeps: Record<string, string> = {};
        for (const d of project.dependencies) {
          if (d.type === 'devDependencies') devDeps[d.name] = d.declared;
          else deps[d.name] = d.declared;
        }
        await fs.writeFile(
          path.join(tempRoot, 'package.json'),
          JSON.stringify({ name: 'ngx-admin', version: '11.0.0', dependencies: deps, devDependencies: devDeps }),
          'utf8',
        );
      }

      let installPass = 0;
      const runMock: typeof run | undefined = ngxAdminConflicts
        ? async (cmd, args, opts) => {
            const joined = `${cmd} ${args.join(' ')}`;
            if (cmd === 'npm' && args[0] === 'install' && args.includes('--dry-run')) {
              installPass++;
              return {
                command: joined,
                exitCode: 1,
                stdout: '',
                stderr: installPass === 1 ? ngxAdminConflicts.initialEresolveStderr : ngxAdminConflicts.recheckEresolveStderr,
                timedOut: false,
                failed: true,
              };
            }
            if (cmd === 'npm' && args[0] === 'install' && args.includes('--legacy-peer-deps')) {
              await fs.writeFile(
                path.join(opts!.cwd!, 'package-lock.json'),
                JSON.stringify(ngxAdminConflicts.lockfileJson),
                'utf8',
              );
              return { command: joined, exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false };
            }
            if (cmd === 'npm' && args[0] === 'ls') {
              return {
                command: joined,
                exitCode: 1,
                stdout: JSON.stringify(
                  installPass === 1 ? ngxAdminConflicts.initialNpmLsJson : ngxAdminConflicts.recheckNpmLsJson,
                ),
                stderr: '',
                timedOut: false,
                failed: true,
              };
            }
            return { command: joined, exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false };
          }
        : undefined;

      const plan = await createPlan({
        project,
        targetMajor: expected.targetMajor,
        registry: fakeRegistry,
        config: resolveConfig({}, {}, { packageManager: project.packageManager.name }),
        verifyResolution: Boolean(ngxAdminConflicts),
        ...(runMock ? { verifyFn: (opts) => verifyWithPackageManager({ ...opts, runFn: runMock }) } : {}),
        now: fixedNow,
        clock: fixedClock,
      });

      const actualSteps: GoldenStepExpectation[] = plan.steps.map((s) => ({
        step: s.index,
        from: s.from,
        to: s.to,
        blockerCount: s.blockers.length,
        noteCount: (s.notes ?? []).length,
        blockers: s.blockers.map((b) => ({
          package: b.package,
          reason: b.reason,
          hard: b.hard,
          highRisk: Boolean(b.highRisk),
          evidence: b.evidence ?? null,
        })),
        notes: (s.notes ?? []).map((n) => ({
          package: n.package,
          kind: n.kind,
          severity: n.severity,
          evidence: n.evidence,
        })),
      }));

      expect(actualSteps, `golden count mismatch for ${name}`).toEqual(expected.steps);
    }
  });

async function verifyGoldenUpdateGuard(
  repoRoot: string,
  preCommitReason: string = process.env.NGM_GOLDEN_UPDATE_REASON ?? '',
): Promise<{ status: 'dirty-ok' | 'clean-ok' | 'skipped'; message: string }> {
  const statusRes = await run(
    'git',
    ['--no-optional-locks', 'status', '--porcelain', '--', 'corpus/golden-counts.json'],
    { cwd: repoRoot },
  );
  const dirty = statusRes.stdout.trim();

  if (dirty.length > 0) {
    expect(
      preCommitReason,
      'Uncommitted change in corpus/golden-counts.json requires NGM_GOLDEN_UPDATE_REASON="Golden-Update: <explanation>" before committing.',
    ).toMatch(/Golden-Update:\s+\S+/);
    return { status: 'dirty-ok', message: 'Validated pre-commit Golden-Update reason.' };
  }

  const logRes = await execa(
    'git',
    ['--no-optional-locks', 'log', '-n', '1', '--format=%B', '--', 'corpus/golden-counts.json'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  );

  if (/Golden-Update:\s+\S+/.test(logRes.stdout)) {
    return { status: 'clean-ok', message: 'Verified Golden-Update commit message in git history.' };
  }

  const shallowRes = await execa(
    'git',
    ['--no-optional-locks', 'rev-parse', '--is-shallow-repository'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  ).catch(() => ({ stdout: 'false' }));
  const hasShallowFile = await fs
    .access(path.join(repoRoot, '.git', 'shallow'))
    .then(() => true)
    .catch(() => false);
  const isShallow = shallowRes.stdout.trim() === 'true' || hasShallowFile;

  if (isShallow) {
    // Only enforce when the shallow window itself contains a commit diff touching corpus/golden-counts.json.
    let modifiedWithinShallowWindow = false;
    const parentRes = await execa('git', ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD~1'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    }).catch(() => null);
    if (parentRes && parentRes.exitCode === 0) {
      const diffRes = await execa(
        'git',
        ['--no-optional-locks', 'diff', '--name-only', 'HEAD~1', 'HEAD', '--', 'corpus/golden-counts.json'],
        { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
      ).catch(() => null);
      if (diffRes && diffRes.stdout.trim().length > 0) {
        modifiedWithinShallowWindow = true;
      }
    }

    if (!modifiedWithinShallowWindow) {
      return {
        status: 'skipped',
        message:
          'Skipping Golden-Update commit-message guard: shallow clone without full commit history for corpus/golden-counts.json (set fetch-depth: 0 to verify).',
      };
    }
  }

  expect(
    logRes.stdout,
    'Latest commit modifying corpus/golden-counts.json must include "Golden-Update: <explanation>" in the commit message.',
  ).toMatch(/Golden-Update:\s+\S+/);
  return { status: 'clean-ok', message: 'Verified Golden-Update commit message in git history.' };
}

  it('requires a Golden-Update commit-message explanation whenever corpus/golden-counts.json changes', async () => {
    const result = await verifyGoldenUpdateGuard(REPO_ROOT);
    if (result.status === 'skipped') {
      console.info(result.message);
    }
    expect(['clean-ok', 'dirty-ok', 'skipped']).toContain(result.status);
  });

  it('skips Golden-Update commit-message guard with a clear message on a simulated shallow clone (depth 1)', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ngm-golden-shallow-'));
    tempDirs.push(repoDir);

    const gitEnv = {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };

    await execa('git', ['init'], { cwd: repoDir, windowsHide: true });
    await fs.mkdir(path.join(repoDir, 'corpus'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'corpus', 'golden-counts.json'), '{"steps":[]}\n', 'utf8');
    await execa('git', ['add', '.'], { cwd: repoDir, windowsHide: true });
    await execa('git', ['commit', '-m', 'Golden-Update: initial baseline'], {
      cwd: repoDir,
      env: gitEnv,
      windowsHide: true,
    });

    // Subsequent unrelated commit, then graft HEAD via .git/shallow (depth-1 shallow checkout state)
    await fs.writeFile(path.join(repoDir, 'README.md'), 'docs update\n', 'utf8');
    await execa('git', ['add', '.'], { cwd: repoDir, windowsHide: true });
    await execa('git', ['commit', '-m', 'docs: update readme'], {
      cwd: repoDir,
      env: gitEnv,
      windowsHide: true,
    });

    const headSha = (
      await execa('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
        cwd: repoDir,
        encoding: 'utf8',
        windowsHide: true,
      })
    ).stdout.trim();
    await fs.writeFile(path.join(repoDir, '.git', 'shallow'), `${headSha}\n`, 'utf8');

    const isShallow = (
      await execa('git', ['--no-optional-locks', 'rev-parse', '--is-shallow-repository'], {
        cwd: repoDir,
        encoding: 'utf8',
        windowsHide: true,
      })
    ).stdout.trim();
    expect(isShallow).toBe('true');

    const result = await verifyGoldenUpdateGuard(repoDir);
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('Skipping Golden-Update commit-message guard: shallow clone');
    expect(result.message).toContain('fetch-depth: 0');
  });
});
