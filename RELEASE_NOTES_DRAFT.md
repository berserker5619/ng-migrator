# Release Notes Draft

## Proposed Version: `1.2.0`

**Reasoning:** A minor version bump (`1.1.2` -> `1.2.0`) is recommended under Semantic Versioning. This release introduces significant new user-facing analysis capabilities, new `ng-migrator.config.json` options (`maxConflictIterations`, `resolutionTimeoutMs`), and richer step runbook metadata (`unknown, verify by build` evidence, companion upgrades, full conflict discovery, and stale-lock recovery) while preserving full backward compatibility with existing CLI flags, exit codes, and `.ng-migrator/` state files.

*(Note: `package.json` has not been bumped yet and remains at `1.1.2` pending release approval.)*

---

## Summary of Changes Since `1.1.2`

- **Three-State Compatibility Evidence & Signal Precedence:**
  - Replaced binary peer classification with `declared compatible`, `declared incompatible`, and `unknown, verify by build`.
  - Packages without `@angular/*` peer ranges (and core runtime packages such as `rxjs`, `tslib`, `zone.js`) no longer produce false-positive hard blockers or automatic downgrades.
  - Resolves `unknown` packages using ordered signals: **(a)** sibling alignment (e.g. `@ngrx/store-devtools`, `@nebular/eva-icons`), **(b)** Angular major-line alignment, then **(c)** newest release published on or before Angular `n+1`'s release date.
- **Proposed-Release View Engine / `ngcc` Detection:**
  - Evaluates whether the installed package uses View Engine / `ngcc` and inspects the **proposed** target release's registry fields (`fesm2020`, `fesm2022`, `exports`, `module`, `typings`) to distinguish clean Ivy upgrades (`ivy-upgrade` note) from unmigrated View Engine blockers (`ivy-or-ngcc`) and high-risk soft blockers.
  - Explicitly notes in step documents when `node_modules` is missing and how to run the local check.
- **Baseline vs Introduced Peer-Conflict Discovery, Grouping & Companion Upgrades:**
  - Eliminated false `peer-conflict` parser artifacts from `npm` `ERESOLVE` `Found:` trees.
  - On `npm` `ERESOLVE`, resolves the isolated OS temp directory with `--legacy-peer-deps` and parses `npm ls --all --package-lock-only --json` against a baseline discovery on the current manifest and lockfile: only **introduced** conflicts become `peer-conflict` blockers, while **pre-existing** conflicts become non-blocking notes (`already present at the current versions; not caused by this step`) and **resolved** conflicts are noted.
  - Groups all blocker reasons per unique package (for example `ng2-ckeditor (ivy-or-ngcc + peer-conflict)`), so blocker counts and decision checkboxes reflect unique packages.
  - Proposes raise-only companion upgrades for outdated direct dependencies (e.g. `echarts`, `jasmine-core`, `@types/node`), tags `devDependencies` companions as `dev-only`, re-checks resolution up to `maxConflictIterations` (default `3`), and attributes official lockstep (`@angular/*`, `@angular/cdk`, `@angular/material`) conflicts to either the proposed set or the third-party peer package.
  - Records the package manager version in step runbooks (e.g. `Resolution check: npm 11.17.0 ...`).
- **Manifest vs Lockfile Disagreement Warnings & Deprecation Successors:**
  - Warns in `doctor`, `analyze`, `plan`, and step documents when `package.json` disagrees with the lockfile.
  - Extracts named successor packages from npm `deprecated` notices and provides actionable research steps when no alternate is known.
- **Stale Lock Recovery & CLI Progress:**
  - Automatically recovers `.ng-migrator/lock` when the owning process on the same host is verifiably dead (guarded by hostname and `processStartedAtMs`).
  - Emits non-TTY and `--ascii`-safe progress lines (`Fetching registry metadata X/Y`, `Checking resolution with <pm>`, `Total elapsed time`).

---

## Known Limitations

- **Read-only planning (`1.x` scope):** `ng-migrator` generates reviewable Markdown runbooks and records approvals; it does not yet execute `npm install` or run Angular schematics in the target workspace.
- **Package manager test depth:** The `npm` verification and full conflict-discovery path (`npm install --package-lock-only --dry-run`, `--legacy-peer-deps`, `npm ls --all --json`) is the most thoroughly tested across large real-world repositories (`ngx-admin`, `my-thai-star`, `angular-14-login`). `yarn` (Classic 1.x / Berry) and `pnpm` run isolated lockfile-only checks and parse peer conflict output, with less real-world corpus coverage.
- **What `"unknown, verify by build"` means:** The package declares no `@angular/*` peer dependency range on npm, so compatibility with the target Angular major cannot be proven from registry metadata alone. `ng-migrator` selects the best candidate using sibling/major/date signals and marks it as a non-blocking note so you verify it with `ng build` and `ng test` when applying the step.

---

## Upgrade Notes

- **New optional `ng-migrator.config.json` fields:**
  - `maxConflictIterations` (positive integer, default `3`): bounds companion-upgrade re-check iterations.
  - `resolutionTimeoutMs` (positive number in ms, default `300000`): timeout for isolated package-manager resolution checks.
  - `commandPrefix` (string or per-major map): validated now and reserved for future step execution support.
- Existing `ng-migrator.config.json` files and `.ng-migrator/state.json` files from `1.1.2` require no changes.

