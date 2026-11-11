# Troubleshooting & Error Reference

Every error reported by `ng-migrator` includes a stable identifier (`NGM-XXXX`) whose first digit matches the process exit code:

- `1xxx` (`ExitCode.Unexpected = 1`): Unexpected internal error
- `2xxx` (`ExitCode.Usage = 2`): Command-line flag or configuration error
- `3xxx` (`ExitCode.Precondition = 3`): Project or state precondition not met
- `4xxx` (`ExitCode.HardBlockers = 4`): Hard dependency blockers detected
- `5xxx` (`ExitCode.VerificationFailed = 5`): Build, lint, or test verification failed
- `6xxx` (`ExitCode.Environment = 6`): Node runtime, subprocess guard, or registry environment error
- `7xxx` (`ExitCode.Snapshot = 7`): Snapshot or post-step file integrity error

---

## NGM-1001: Unexpected internal error

- **What happened:** `ng-migrator` encountered an unhandled runtime exception.
- **Why:** An unexpected filesystem, parsing, or internal logic error occurred that does not map to a known user or environment error.
- **What to do next:** Re-run the command with `--verbose` to print the full stack trace and open an issue with the output and your `.ng-migrator/state.json` (if present).

## NGM-1002: Command not implemented yet

- **What happened:** A command or execution path reserved for a future release was invoked.
- **Why:** The 1.0 CLI is a non-destructive upgrade planner (`doctor`, `analyze`, `plan`, `status`, `approve`) and does not execute in-place migrations.
- **What to do next:** Use `ng-migrator plan --to <major>` to generate step-by-step upgrade runbooks, review each step document under `.ng-migrator/steps/`, and approve steps with `ng-migrator approve <step>`.

## NGM-2001: Invalid command-line usage

- **What happened:** The CLI was called with an unknown command, unknown flag, missing required option, or invalid step argument.
- **Why:** Commander rejected the command-line arguments or the step index passed to `approve` was not a valid step number in the current plan.
- **What to do next:** Run `ng-migrator --help` or `ng-migrator <command> --help` to see valid commands and options.

## NGM-2002: Invalid target version

- **What happened:** The `--to <major>` value could not be used as a forward Angular major upgrade target.
- **Why:** `--to` was given a range or minor version (such as `19.1` or `^19`), a major version less than or equal to the project's current Angular major, or a major version with no published `@angular/core` releases.
- **What to do next:** Pass a single integer Angular major greater than your project's current major (for example, `ng-migrator plan --to 17`).

## NGM-2003: Invalid configuration file

- **What happened:** `ng-migrator.config.json` (or a custom rule file) could not be parsed or failed schema validation.
- **Why:** The JSON syntax is invalid, or a configuration field (`packageManager`, `rules`, `neverTouch`, `pinned`, `alternates`, `verify`, `cacheDir`, `unmaintainedThresholdMonths`, `commandPrefix`) has the wrong type.
- **What to do next:** Fix the syntax or field types in `ng-migrator.config.json` (or your custom rules JSON file) and re-run the command.

## NGM-3001: Working tree has uncommitted changes

- **What happened:** `ng-migrator plan` refused to run because the Git working tree has uncommitted modifications.
- **Why:** Planning against a clean commit ensures reproducibility and prevents mixing generated plans with in-flight edits.
- **What to do next:** Commit or stash your changes with `git status` / `git stash`, or pass `--allow-dirty` if you intentionally want to plan on a dirty working tree.

## NGM-3002: Another ng-migrator run holds the lock

- **What happened:** Another active `ng-migrator` process is currently holding `.ng-migrator/lock` for this project.
- **Why:** Concurrent runs on the same project are blocked to prevent corrupting `.ng-migrator/state.json` or step documents.
- **What to do next:** Wait for the other `ng-migrator` process to finish. If you are certain no other run is active (for example, on a shared network drive), delete `.ng-migrator/lock`.

## NGM-3003: Stale lock from a run that is no longer active

- **What happened:** `.ng-migrator/lock` exists on disk, but the process ID (`pid`) recorded in the lock file is no longer running on this host.
- **Why:** A previous `ng-migrator` process was forcefully terminated (`SIGKILL` / `TerminateProcess` or power loss) before it could release `.ng-migrator/lock`.
- **What to do next:** Confirm no `ng-migrator` process is running, then delete `.ng-migrator/lock` and re-run your command.

## NGM-3004: State file was written by a newer ng-migrator

- **What happened:** `.ng-migrator/state.json` has a `schemaVersion` higher than the version supported by this CLI binary.
- **Why:** A newer version of `ng-migrator` was previously used on this repository.
- **What to do next:** Upgrade `ng-migrator` (`npx ng-migrator@latest`) so your CLI version matches or exceeds the version that created `.ng-migrator/state.json`.

## NGM-3005: State file is unreadable

- **What happened:** `.ng-migrator/state.json` is missing when required (such as during `approve`) or contains corrupt/invalid JSON.
- **Why:** `approve` was run before `plan`, or `.ng-migrator/state.json` was manually edited and corrupted.
- **What to do next:** Run `ng-migrator plan --to <major>` to generate or regenerate `.ng-migrator/state.json` while preserving ticked decisions and reviewer notes from existing step documents.

## NGM-3006: Path is outside the project

- **What happened:** A path resolved from configuration or internal output pointed outside the target project root.
- **Why:** `ng-migrator` enforces path containment so it never writes files outside the project's `.ng-migrator/` directory.
- **What to do next:** Update any configured paths (`cacheDir`, `--report`, `--rules`) so they stay within the project workspace.

## NGM-3007: Not an Angular project

- **What happened:** `package.json` could not be found in the project root, is invalid JSON, or does not declare `@angular/core`.
- **Why:** `ng-migrator` was invoked in a directory that is not an Angular workspace root.
- **What to do next:** Run `ng-migrator` from the folder containing your Angular `package.json`, or pass `--project <path>` pointing to the Angular workspace root.

## NGM-3008: Angular version not supported

- **What happened:** The project's current Angular major version is older than the oldest supported starting major (Angular 12).
- **Why:** `ng-migrator` supports planning upgrades starting from Angular 12 (`oldestSupportedMajor: 12`).
- **What to do next:** Upgrade the project manually to Angular 12 using `https://update.angular.io`, then run `ng-migrator` for Angular 12+ steps.

## NGM-4001: Hard blockers found during analysis

- **What happened:** `ng-migrator analyze --fail-on-blockers` detected one or more hard dependency blockers for the next Angular major version.
- **Why:** At least one dependency has no compatible release for the target Angular major, requires removed View Engine/`ngcc` support (Angular 16+), or caused a hard peer conflict. (Soft blockers such as deprecated or unmaintained packages whose peer ranges still include the target major do not trigger `NGM-4001`.)
- **What to do next:** Run `ng-migrator plan --to <major>` and review the recommended fixes in `.ng-migrator/steps/` to replace, remove, or override the blocking dependencies.

## NGM-5001: Verification build, lint, or test failed

- **What happened:** A configured verification command (`verify.build`, `verify.lint`, or `verify.test`) exited with a non-zero status code.
- **Why:** The project's build, linter, or test suite reported errors.
- **What to do next:** Inspect the compiler, linter, or test output, resolve the reported failures, and re-run verification.

## NGM-6001: Unsupported Node version

- **What happened:** The Node.js runtime executing `ng-migrator` does not satisfy the required engine range (`>=22`).
- **Why:** Node 18 and 20 are end of life; `ng-migrator` requires Node `>=22` (supported lines: Node 22, 24, and 26) for its own CLI process.
- **What to do next:** Switch to Node 22, 24, or 26 (for example via `fnm`, `nvm`, or `volta`) to run `ng-migrator`. If your Angular project itself needs an older Node version for its toolchain, configure `commandPrefix` in `ng-migrator.config.json`.

## NGM-6002: Blocked subprocess

- **What happened:** The internal process guard refused to spawn a disallowed `git` command.
- **Why:** `ng-migrator` enforces a strict read-only Git policy (only `status`, `rev-parse`, `ls-files`, and `--version` are allowed) and never runs Git write commands.
- **What to do next:** This indicates an internal safety invariant tripped. Report the issue along with the `--verbose` output.

## NGM-6003: Registry authentication failed

- **What happened:** The npm registry returned HTTP `401` or `403` when fetching package metadata.
- **Why:** A private or scoped registry configured in `.npmrc` requires authentication, and the token or credentials in `.npmrc` / environment variables are missing or expired.
- **What to do next:** Refresh your credentials for the configured registry (for example, `npm login --registry <url>` or set the token environment variable referenced in `.npmrc`), or run with `--offline` if the metadata cache is already populated.

## NGM-6004: Registry unreachable

- **What happened:** Package metadata could not be fetched from the npm registry and no cached copy was available, or `--offline` was passed with an empty cache.
- **Why:** There is a network connectivity failure, DNS/proxy block, registry outage, or `--offline` was used before populating `.ng-migrator/cache/registry/`.
- **What to do next:** Check your network connection and `.npmrc` registry URL, or run once without `--offline` while connected to populate the metadata cache.

## NGM-7001: Snapshot not found

- **What happened:** A requested migration state snapshot could not be found in `.ng-migrator/`.
- **Why:** The snapshot file was deleted or never created for the specified step.
- **What to do next:** Check `.ng-migrator/state.json` via `ng-migrator status` or re-run `ng-migrator plan --to <major>` to re-initialize the plan state.

## NGM-7002: Files modified after migration step

- **What happened:** Project files were modified outside the expected step state after a step was recorded.
- **Why:** Manual edits were made to tracked files that conflict with the recorded step state.
- **What to do next:** Review `git status` and `git diff`, reconcile any manual changes, and regenerate the plan with `ng-migrator plan --to <major>`.
