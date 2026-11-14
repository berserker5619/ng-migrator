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

      const plan = await createPlan({
        project,
        targetMajor: expected.targetMajor,
        registry: fakeRegistry,
        config: resolveConfig({}, {}, { packageManager: project.packageManager.name }),
        verifyResolution: false,
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

  it('requires a Golden-Update commit-message explanation whenever corpus/golden-counts.json changes', async () => {
    const statusRes = await run(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '--', 'corpus/golden-counts.json'],
      { cwd: REPO_ROOT },
    );
    const dirty = statusRes.stdout.trim();

    if (dirty.length > 0) {
      // During pre-commit development/testing, require an explicit explanation env var.
      const preCommitReason = process.env.NGM_GOLDEN_UPDATE_REASON ?? '';
      expect(
        preCommitReason,
        'Uncommitted change in corpus/golden-counts.json requires NGM_GOLDEN_UPDATE_REASON="Golden-Update: <explanation>" before committing.',
      ).toMatch(/Golden-Update:\s+\S+/);
      return;
    }

    const logRes = await execa(
      'git',
      ['--no-optional-locks', 'log', '-n', '1', '--format=%B', '--', 'corpus/golden-counts.json'],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true },
    );
    expect(
      logRes.stdout,
      'Latest commit modifying corpus/golden-counts.json must include "Golden-Update: <explanation>" in the commit message.',
    ).toMatch(/Golden-Update:\s+\S+/);
  });
});
