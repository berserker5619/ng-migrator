# Troubleshooting & Error Code Index

Every error emitted by `ng-migrator` has a stable identifier prefixed with `NGM-`. The first digit corresponds to the process exit code (plan section 19.3).

---

## Exit Codes

| Code | Category | Description |
|---|---|---|
| `0` | Success | Command completed successfully. |
| `1` | Unexpected error | Internal error or unhandled exception. |
| `2` | Usage error | Invalid arguments, options, or configuration format. |
| `3` | Precondition failed | Working tree dirty, missing dependencies, or state conflict. |
| `4` | Hard blockers found | Unresolved blockers detected when running `analyze --fail-on-blockers`. |
| `5` | Verification failed | Post-step build, lint, or test command exited with an error. |
| `6` | Environment problem | Incompatible Node runtime, registry unreachable, or network issue. |
| `7` | Snapshot problem | Snapshot missing or corrupted during rollback. |

---

## Error Codes

### `NGM-1001`: Unexpected internal error
- **Cause:** An unhandled error occurred inside `ng-migrator`.
- **Action:** Re-run with `--verbose` to view the stack trace and report the issue on GitHub.

### `NGM-1002`: Command not implemented yet
- **Cause:** Attempted to invoke a command planned for a subsequent release.

### `NGM-2001`: Invalid command-line usage
- **Cause:** An unknown flag or invalid option argument was provided.
- **Action:** Check command syntax with `--help`.

### `NGM-2002`: Invalid target version
- **Cause:** The `--to` flag was given a range (e.g. `15-17`), a minor version (e.g. `16.2`), or a version older than the current Angular major.
- **Action:** Specify a single target major version integer (e.g. `--to 19`). `ng-migrator` always plans forward upgrades one major at a time.

### `NGM-2003`: Invalid configuration file
- **Cause:** `ng-migrator.config.json` contains malformed JSON or invalid property types.
- **Action:** Fix the offending field in `ng-migrator.config.json`.

### `NGM-3001`: Working tree has uncommitted changes
- **Cause:** `plan` was executed in a git repository with modified or staged files.
- **Action:** Commit or stash changes before planning so changes can be cleanly reviewed. To bypass, pass `--allow-dirty`.

### `NGM-3002`: Another ng-migrator run holds the lock
- **Cause:** Another process is currently running `ng-migrator` in the same project directory.
- **Action:** Wait for the running operation to complete.

### `NGM-3003`: Stale lock from a run that is no longer active
- **Cause:** A previous command crashed or was forcefully killed, leaving `.ng-migrator/lock`.
- **Action:** Verify no `ng-migrator` processes are running, then remove `.ng-migrator/lock`.

### `NGM-3004`: State file was written by a newer ng-migrator
- **Cause:** `.ng-migrator/state.json` has a schema version higher than what this version of `ng-migrator` supports.
- **Action:** Upgrade your `ng-migrator` installation to the latest release.

### `NGM-3005`: State file is unreadable or corrupted
- **Cause:** `.ng-migrator/state.json` contains invalid JSON or lacks a valid schema version.
- **Action:** Delete `.ng-migrator/state.json` and re-run `ng-migrator plan --to <major>`.

### `NGM-3006`: Path is outside the project
- **Cause:** A path outside the repository root was referenced. Paths in reports must be project-relative.

### `NGM-3007`: Not an Angular project
- **Cause:** `package.json` was not found, or `@angular/core` is not present in dependencies.
- **Action:** Run `ng-migrator` from the root directory of an Angular application.

### `NGM-3008`: Angular version not supported
- **Cause:** The current project is running an Angular major version older than Angular 12.
- **Action:** Upgrade manually to Angular 12 before using `ng-migrator`.

### `NGM-4001`: Hard blockers found during analysis
- **Cause:** `ng-migrator analyze --fail-on-blockers` found dependencies without compatible releases.
- **Action:** Review the analysis report and resolve blockers before running migration steps.

### `NGM-6001`: Unsupported Node version
- **Cause:** The Node runtime executing `ng-migrator` is older than Node 22.12.
- **Action:** Upgrade your active Node runtime to Node 22.12+ (or Node 24 LTS).

### `NGM-6002`: Blocked subprocess
- **Cause:** A prohibited command (such as a git write operation) was intercepted.
- **Action:** `ng-migrator` guarantees no git writes. If encountered, please report this bug.

### `NGM-6003`: Registry authentication failed
- **Cause:** The npm registry returned HTTP 401 or 403 when accessing package metadata.
- **Action:** Verify your authentication tokens or run `npm login --registry <url>`.

### `NGM-6004`: Registry unreachable or offline cache missing
- **Cause:** Network connectivity failure, or `--offline` was passed without a populated cache.
- **Action:** Check your network connection or run once online to populate `.ng-migrator/cache`.
