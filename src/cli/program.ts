import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import semver from 'semver';
import {
  PACKAGE_MANAGERS,
  readConfigFile,
  resolveConfig,
  type PackageManager,
} from '../config/config.js';
import {
  ERRORS,
  ExitCode,
  NgmError,
  TROUBLESHOOTING_BASE_URL,
  getTroubleshootingUrl,
  isNgmError,
  type ErrorId,
} from '../errors.js';
import type { ResolutionCheck } from '../model.js';
import { isPortInUse } from '../platform/doctor.js';
import { checkGitStatus } from '../platform/git.js';
import { writeGeneratedText } from '../platform/text.js';
import { getStepRequirements } from '../planner/metadata.js';
import { createPlan } from '../planner/plan.js';
import { readProject } from '../reader/project.js';
import { loadRules } from '../recommend/rules.js';
import { RegistryClient, stableVersionsDesc } from '../registry/client.js';
import { loadNpmrc } from '../registry/npmrc.js';
import { resolveStepDependencies } from '../resolver/resolve.js';
import { enrichBlockersWithResolutionCheck, verifyWithPackageManager } from '../resolver/verify.js';
import { withLock } from '../state/lock.js';
import { readState, writeState } from '../state/state.js';
import {
  extractDecisionsFromFile,
  writePlanDocuments,
} from '../steps/writer.js';
import { NODE_RANGE, TOOL_NAME, TOOL_VERSION } from '../version.js';
import { Output, shouldUseColor, type Writer } from './output.js';

export interface CliIo {
  stdout: Writer;
  stderr: Writer;
  isTTY: boolean | undefined;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  cwd: string;
  clock?: () => Date;
}

interface GlobalOptions {
  color?: boolean;
  ascii?: boolean;
  verbose?: boolean;
  project?: string;
  asOf?: string;
}

export function parseAsOfDate(value: string): Date {
  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new NgmError('NGM-2001', `--as-of must be a valid ISO date (for example 2026-11-01), not "${value}".`);
  }
  return parsed;
}

export function parseTargetMajor(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new NgmError('NGM-2002', `--to must be a single Angular major version such as 19, not "${value}".`, {
      hint: 'ng-migrator always plans one major at a time (n-1 to n) up to the --to major.',
    });
  }
  const major = Number(value);
  if (major < 2) throw new NgmError('NGM-2002', `--to ${major} is not an Angular (2+) major version.`);
  return major;
}

export function createProgram(
  io: CliIo,
  getOutput: () => Output,
  getProjectRoot: () => string = () => io.cwd,
  getClock: () => () => Date = () => io.clock ?? (() => new Date()),
): Command {
  const program = new Command();
  program
    .name(TOOL_NAME)
    .description('Plan Angular upgrades one major version at a time (n-1 to n). Never commits.')
    .version(TOOL_VERSION, '-v, --version')
    .option('--project <path>', 'path to the Angular project root (default: current directory)')
    .option('--as-of <date>', 'reference ISO date for unmaintained threshold and timestamps (for example 2026-11-01)')
    .option('--no-color', 'plain output without colors')
    .option('--ascii', 'ASCII symbols only')
    .option('--verbose', 'print detailed output')
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    })
    .exitOverride()
    .showSuggestionAfterError(true);

  program
    .command('doctor')
    .description('check the machine and project before starting')
    .action(async () => {
      const out = getOutput();
      const projectRoot = getProjectRoot();
      out.info('Running pre-upgrade environment and project checks...\n');

      // 1. Node version
      if (semver.satisfies(io.nodeVersion, NODE_RANGE)) {
        out.success(`Node runtime: ${io.nodeVersion} (satisfies ${NODE_RANGE})`);
      } else {
        out.warn(`Node runtime: ${io.nodeVersion} (recommended: ${NODE_RANGE})`);
      }

      // 2. Git status
      const git = await checkGitStatus(projectRoot);
      if (!git.isGitRepo) {
        out.info('Git repository: not detected (working directory is clean).');
      } else if (git.clean) {
        out.success(`Git working tree is clean (HEAD: ${git.headCommit?.slice(0, 7) ?? 'unknown'})`);
      } else {
        out.warn(`Git working tree has ${git.dirtyEntries.length} uncommitted change(s).`);
      }

      // 3. Project read
      try {
        const project = await readProject(projectRoot);
        out.success(`Project: ${project.name ?? 'unnamed'} (Angular ${project.angular.version ?? 'unknown'})`);
        out.success(`Package manager: ${project.packageManager.name} (${project.packageManager.source})`);
        out.success(`Workspace structure: ${project.workspace}, style: ${project.style}`);

        if (project.warnings.length > 0) {
          out.info('\nProject warnings:');
          for (const w of project.warnings) out.warn(`  - ${w}`);
        }
      } catch (err) {
        out.error(`Project check failed: ${(err as Error).message}`);
      }

      // 4. Running dev server check (locks files on Windows)
      const portBusy = await isPortInUse(4200);
      if (portBusy) {
        out.warn('Port 4200 is active: an Angular dev server (ng serve) may be running. Stop it before upgrading to prevent file lock errors.');
      } else {
        out.success('Port 4200: free (no running ng serve dev server detected)');
      }

      out.info('\nDoctor check completed.');
    });

  program
    .command('analyze')
    .description('report what the project has and what blocks the next upgrade')
    .option('--to <major>', 'target Angular major version (defaults to next major)', parseTargetMajor)
    .option('--fail-on-blockers', 'exit with code 4 when hard blockers are found')
    .option('--report <path>', 'write the report to this path')
    .option('--offline', 'use cached registry data only')
    .action(async (opts: { to?: number; failOnBlockers?: boolean; report?: string; offline?: boolean }) => {
      const out = getOutput();
      const projectRoot = getProjectRoot();
      const project = await readProject(projectRoot);

      const currentMajor = project.angular.major;
      if (!currentMajor) {
        throw new NgmError('NGM-3007', 'Could not detect Angular version from project dependencies.');
      }

      const { config: fileConfig } = await readConfigFile(projectRoot);
      const config = resolveConfig({}, fileConfig, { packageManager: project.packageManager.name });
      const npmrc = await loadNpmrc(projectRoot, io.env);
      const registry = new RegistryClient({
        npmrc,
        cacheDir: path.resolve(projectRoot, config.cacheDir),
        offline: opts.offline,
        onWarning: (msg) => out.warn(msg),
      });

      const corePack = await registry.packument('@angular/core');
      const maxPublishedMajor = corePack
        ? Math.max(...stableVersionsDesc(corePack).map((v) => semver.major(v)))
        : 22;

      // When running analyze without --to on a project already at the latest Angular major,
      // report audit status and exit 0 (plan Section 19.3).
      if (opts.to === undefined && currentMajor >= maxPublishedMajor) {
        out.info(`Analyzing project: ${project.name ?? path.basename(projectRoot)}`);
        out.success(`✔ Project is already on the latest Angular major (${currentMajor}). Auditing current dependencies only...\n`);

        out.info(`Dependencies analyzed: ${project.dependencies.length}`);
        out.info(`Proposed package updates: 0 (already on latest Angular)`);
        out.info(`Blockers detected: 0\n`);
        out.success('No dependency blockers found.');
        return;
      }

      const targetMajor = opts.to ?? (currentMajor + 1);
      if (opts.to !== undefined && opts.to <= currentMajor) {
        throw new NgmError('NGM-2002', `--to ${opts.to} must be greater than current Angular major ${currentMajor}.`);
      }
      if (targetMajor > maxPublishedMajor) {
        throw new NgmError('NGM-2002', `No published releases found for Angular major version ${targetMajor}.`);
      }

      out.info(`Analyzing project: ${project.name ?? path.basename(projectRoot)}`);
      out.info(`Current Angular: ${project.angular.version} (major ${currentMajor}) -> Target step: ${targetMajor}\n`);

      const requirements = await getStepRequirements(targetMajor, registry);
      const rules = await loadRules(config.rules, projectRoot);
      const clock = getClock();
      const resolution = await resolveStepDependencies({
        project,
        requirements,
        registry,
        pinned: config.pinned,
        neverTouch: config.neverTouch,
        rules,
        alternatesAllow: config.alternates.allow,
        alternatesDeny: config.alternates.deny,
        unmaintainedThresholdMonths: config.unmaintainedThresholdMonths,
        clock,
      });

      // Run package-manager verification check to catch peer conflicts identically to plan
      let resolutionCheck: ResolutionCheck = { status: 'skipped', packageManager: config.packageManager };
      if (!opts.offline) {
        try {
          resolutionCheck = await verifyWithPackageManager({
            projectRoot,
            packageManager: config.packageManager,
            changes: resolution.changes,
            timeoutMs: config.resolutionTimeoutMs,
          });
        } catch {
          // Leave skipped if verification cannot run
        }
      }

      enrichBlockersWithResolutionCheck(
        resolution.blockers,
        resolutionCheck,
        project,
        targetMajor,
        config.packageManager,
      );

      out.info(`Dependencies analyzed: ${project.dependencies.length}`);
      out.info(`Proposed package updates: ${resolution.changes.length}`);
      out.info(`Held back releases: ${resolution.heldBack.length}`);
      out.info(`Blockers detected: ${resolution.blockers.length}\n`);

      if (resolution.blockers.length > 0) {
        out.warn('Blockers for next major:');
        for (const b of resolution.blockers) {
          out.warn(`  [${b.reason}] ${b.package}: ${b.details}`);
        }
        out.info('');
      } else {
        out.success('No dependency blockers found for immediate next major.');
      }

      if (opts.report) {
        const reportPath = path.resolve(projectRoot, opts.report);
        const relReportPath = path.relative(projectRoot, reportPath).replace(/\\/g, '/') || opts.report;
        const reportData = {
          project: project.name,
          currentAngular: project.angular.version,
          targetMajor,
          blockers: resolution.blockers,
          changes: resolution.changes,
          heldBack: resolution.heldBack,
        };
        await writeGeneratedText(reportPath, `${JSON.stringify(reportData, null, 2)}\n`);
        out.success(`Analysis report written to: ${relReportPath}`);
      }

      const hardBlockers = resolution.blockers.filter((b) => b.hard);
      if (opts.failOnBlockers && hardBlockers.length > 0) {
        throw new NgmError('NGM-4001', `Found ${hardBlockers.length} hard blocker(s) during analysis.`);
      }
    });

  program
    .command('plan')
    .description('write one document per n-1 to n step; changes nothing in the project')
    .requiredOption('--to <major>', 'final Angular major version, for example 19')
    .addOption(new Option('--package-manager <name>', 'override detection').choices([...PACKAGE_MANAGERS]))
    .option('--rules <path...>', 'extra rule files')
    .option('--offline', 'use cached registry data only')
    .option('--allow-dirty', 'allow uncommitted changes in the working tree')
    .action(async (opts: {
      to: string;
      packageManager?: PackageManager;
      rules?: string[];
      offline?: boolean;
      allowDirty?: boolean;
    }) => {
      const out = getOutput();
      const projectRoot = getProjectRoot();
      const targetMajor = parseTargetMajor(opts.to);

      // Check clean working tree
      const git = await checkGitStatus(projectRoot);
      if (git.isGitRepo && !git.clean && !opts.allowDirty) {
        throw new NgmError(
          'NGM-3001',
          `Working tree has uncommitted changes (${git.dirtyEntries.length} file(s)). Commit or stash them, or pass --allow-dirty.`,
          { hint: 'ng-migrator plans and runs safely when starting from a known commit.' },
        );
      }

      await withLock(projectRoot, 'plan', async () => {
        const project = await readProject(projectRoot);
        const { config: fileConfig } = await readConfigFile(projectRoot);
        const config = resolveConfig(
          { packageManager: opts.packageManager, rules: opts.rules },
          fileConfig,
          { packageManager: project.packageManager.name },
        );

        const npmrc = await loadNpmrc(projectRoot, io.env);
        const registry = new RegistryClient({
          npmrc,
          cacheDir: path.resolve(projectRoot, config.cacheDir),
          offline: opts.offline,
          onWarning: (msg) => out.warn(msg),
        });

        const clock = getClock();
        out.info(`Planning upgrade: Angular ${project.angular.version} -> ${targetMajor}...`);
        const plan = await createPlan({
          project,
          targetMajor,
          registry,
          config,
          verifyResolution: !opts.offline,
          onNotice: (msg) => out.info(msg),
          clock,
        });

        const step1Res = plan.steps[0]?.resolution;
        if (step1Res && step1Res.tempDir) {
          out.debug(
            `Resolution check ran in temp dir: ${step1Res.tempDir} (copied: [${(step1Res.copiedFiles ?? []).join(', ')}], status: ${step1Res.status}, deleted afterwards: ${String(step1Res.tempDirCleaned)})`,
          );
        }

        await writePlanDocuments(projectRoot, plan, project.hasNodeModules, clock);

        out.success(`\nPlan generated successfully (${plan.steps.length} step(s)):`);
        for (const s of plan.steps) {
          const prov = s.provisional ? ' [provisional]' : '';
          const blockers = s.blockers.length > 0 ? ` (${s.blockers.length} blocker(s))` : '';
          out.info(`  Step ${s.index}: Angular ${s.from} -> ${s.to}${prov}${blockers}`);
        }

        out.info(`\nSummary runbook written to: .ng-migrator/summary.md`);
        out.info(`First step review: .ng-migrator/steps/01-angular-${plan.steps[0]?.from}-to-${plan.steps[0]?.to}.md`);
        out.info(`Run "ng-migrator approve 1" after reviewing.`);
      });
    });

  program
    .command('status')
    .description('show which steps are planned, approved, done or failed')
    .action(async () => {
      const out = getOutput();
      const projectRoot = getProjectRoot();
      const state = await readState(projectRoot);
      if (!state || state.steps.length === 0) {
        out.info('No active migration plan found.');
        out.info('Run "ng-migrator plan --to <major>" to generate a plan.');
        return;
      }

      out.info(`Migration status: Angular ${state.startVersion ?? '?'} -> ${state.targetMajor ?? '?'}`);
      out.info(`Steps (${state.steps.length} total):\n`);

      for (const step of state.steps) {
        const symbol =
          step.status === 'done'
            ? out.symbols.ok
            : step.status === 'failed'
              ? out.symbols.fail
              : step.status === 'approved'
                ? '★'
                : out.symbols.bullet;
        out.info(`  ${symbol} Step ${step.index}: Angular ${step.from} -> ${step.to} [${step.status}]`);
      }
      out.info('');
    });

  program
    .command('approve')
    .description('approve a step after reading its document')
    .argument('<step>', 'step number')
    .action(async (stepArg: string) => {
      const out = getOutput();
      const projectRoot = getProjectRoot();
      if (!/^\d+$/.test(stepArg) || Number(stepArg) < 1) {
        throw new NgmError('NGM-2001', `Step must be a positive number, not "${stepArg}".`);
      }
      const stepIndex = Number(stepArg);

      await withLock(projectRoot, 'approve', async () => {
        const state = await readState(projectRoot);
        if (!state) {
          throw new NgmError('NGM-3005', 'No migration state found. Run "ng-migrator plan --to <major>" first.');
        }

        const step = state.steps.find((s) => s.index === stepIndex);
        if (!step) {
          throw new NgmError('NGM-2001', `Step ${stepIndex} does not exist in the current plan.`);
        }

        const stepFileName = `${String(step.index).padStart(2, '0')}-angular-${step.from}-to-${step.to}.md`;
        const stepFilePath = path.join(projectRoot, '.ng-migrator', 'steps', stepFileName);
        const { decisions, reviewerNotes } = await extractDecisionsFromFile(stepFilePath);

        step.decisions = { ...step.decisions, ...decisions };
        if (reviewerNotes) {
          step.reviewerNotes = reviewerNotes;
        }
        const openDecisions = Object.entries(step.decisions).filter(([, checked]) => !checked);
        if (openDecisions.length > 0) {
          out.warn(`Step ${stepIndex} has ${openDecisions.length} open decision(s) in ${stepFileName}.`);
        }

        step.status = 'approved';
        step.approvedAt = getClock()().toISOString();

        await writeState(projectRoot, state);

        // Re-read step file to update approval status line
        try {
          const content = await readFile(stepFilePath, 'utf8');
          const updated = content.replace(
            /## Approval\nStatus: [^\n]+/g,
            `## Approval\nStatus: approved at ${step.approvedAt}`,
          );
          await writeGeneratedText(stepFilePath, updated);
        } catch {
          // ignore if document was moved
        }

        out.success(`Step ${stepIndex} (Angular ${step.from} to ${step.to}) is now approved.`);
        out.info('Follow the planned actions in the step document or commit your review.');
      });
    });

  return program;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let output = new Output(io.stdout, io.stderr, { color: shouldUseColor(undefined, io.isTTY, io.env), ascii: false, verbose: false });
  let projectRoot = io.cwd;
  let clock: () => Date = io.clock ?? (() => new Date());
  const getOutput = () => output;
  const getProjectRoot = () => projectRoot;
  const getClock = () => clock;

  const program = createProgram(io, getOutput, getProjectRoot, getClock);
  program.hook('preAction', (thisCommand) => {
    const g = thisCommand.optsWithGlobals<GlobalOptions>();
    if (g.project) {
      projectRoot = path.resolve(io.cwd, g.project);
    }
    if (g.asOf) {
      const fixedDate = parseAsOfDate(g.asOf);
      clock = () => fixedDate;
    }
    output = new Output(io.stdout, io.stderr, {
      color: shouldUseColor(g.color, io.isTTY, io.env),
      ascii: Boolean(g.ascii),
      verbose: Boolean(g.verbose),
    });
  });

  try {
    if (!semver.satisfies(io.nodeVersion, NODE_RANGE)) {
      throw new NgmError('NGM-6001', `ng-migrator needs Node ${NODE_RANGE}; this is Node ${io.nodeVersion}.`, {
        hint: 'Run ng-migrator under a newer Node. Old project toolchains can still run through "commandPrefix" in ng-migrator.config.json.',
      });
    }
    await program.parseAsync([...argv], { from: 'user' });
    return ExitCode.Success;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) return ExitCode.Success;
      output.error(`NGM-2001 ${err.message.replace(/^error:\s*/i, '')}`);
      output.info('  Troubleshooting: https://github.com/berserker5619/ng-migrator/blob/main/docs/troubleshooting.md#ngm-2001-invalid-command-line-usage');
      return ExitCode.Usage;
    }
    if (isNgmError(err)) {
      output.error(`${err.id} ${err.message}`);
      if (err.hint) output.info(`  ${err.hint}`);
      const link = err.id in ERRORS ? getTroubleshootingUrl(err.id as ErrorId) : `${TROUBLESHOOTING_BASE_URL}#${err.id.toLowerCase()}`;
      output.info(`  Troubleshooting: ${link}`);
      return err.exitCode;
    }
    output.error(`NGM-1001 Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) output.debug(err.stack);
    output.info('  Troubleshooting: https://github.com/berserker5619/ng-migrator/blob/main/docs/troubleshooting.md#ngm-1001-unexpected-internal-error');
    output.info('  Please report this with the output of --verbose.');
    return ExitCode.Unexpected;
  }
}
