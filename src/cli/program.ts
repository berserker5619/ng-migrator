import { Command, CommanderError, Option } from 'commander';
import semver from 'semver';
import { PACKAGE_MANAGERS } from '../config/config.js';
import { ExitCode, NgmError, isNgmError } from '../errors.js';
import { NODE_RANGE, TOOL_NAME, TOOL_VERSION } from '../version.js';
import { Output, shouldUseColor, type Writer } from './output.js';

export interface CliIo {
  stdout: Writer;
  stderr: Writer;
  isTTY: boolean | undefined;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  cwd: string;
}

interface GlobalOptions {
  color?: boolean;
  ascii?: boolean;
  verbose?: boolean;
}

/** Parse `--to` as a plain Angular major such as 19. Ranges and minors are rejected. */
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

function notImplemented(command: string, phase: string): never {
  throw new NgmError('NGM-1002', `"${command}" is not implemented yet (planned for ${phase}).`);
}

export function createProgram(io: CliIo, getOutput: () => Output): Command {
  const program = new Command();
  program
    .name(TOOL_NAME)
    .description('Plan Angular upgrades one major version at a time (n-1 to n). Never commits.')
    .version(TOOL_VERSION, '-v, --version')
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
    .action(() => notImplemented('doctor', 'phase 2'));

  program
    .command('analyze')
    .description('report what the project has and what blocks the next upgrade')
    .option('--fail-on-blockers', 'exit with code 4 when hard blockers are found')
    .option('--report <path>', 'write the report to this path')
    .action(() => notImplemented('analyze', 'phase 1'));

  program
    .command('plan')
    .description('write one document per n-1 to n step; changes nothing in the project')
    .requiredOption('--to <major>', 'final Angular major version, for example 19')
    .addOption(new Option('--package-manager <name>', 'override detection').choices([...PACKAGE_MANAGERS]))
    .option('--rules <path...>', 'extra rule files')
    .option('--offline', 'use cached registry data only')
    .option('--allow-dirty', 'allow uncommitted changes in the working tree')
    .action((opts: { to: string }) => {
      const major = parseTargetMajor(opts.to);
      getOutput().debug(`target major: ${major}`);
      notImplemented('plan', 'phase 1');
    });

  program
    .command('status')
    .description('show which steps are planned, approved, done or failed')
    .action(() => notImplemented('status', 'phase 2'));

  program
    .command('approve')
    .description('approve a step after reading its document')
    .argument('<step>', 'step number')
    .action((step: string) => {
      if (!/^\d+$/.test(step) || Number(step) < 1) {
        throw new NgmError('NGM-2001', `Step must be a positive number, not "${step}".`);
      }
      notImplemented('approve', 'phase 2');
    });

  return program;
}

/** Run the CLI and return the exit code. Never calls process.exit, so it is testable. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let output = new Output(io.stdout, io.stderr, { color: shouldUseColor(undefined, io.isTTY, io.env), ascii: false, verbose: false });
  const getOutput = () => output;

  const program = createProgram(io, getOutput);
  program.hook('preAction', (thisCommand) => {
    const g = thisCommand.optsWithGlobals<GlobalOptions>();
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
      // --help and --version end with a CommanderError carrying exit code 0.
      if (err.exitCode === 0) return ExitCode.Success;
      output.error(`NGM-2001 ${err.message.replace(/^error:\s*/i, '')}`);
      return ExitCode.Usage;
    }
    if (isNgmError(err)) {
      output.error(`${err.id} ${err.message}`);
      if (err.hint) output.info(`  ${err.hint}`);
      return err.exitCode;
    }
    output.error(`NGM-1001 Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) output.debug(err.stack);
    output.info('  Please report this with the output of --verbose.');
    return ExitCode.Unexpected;
  }
}

