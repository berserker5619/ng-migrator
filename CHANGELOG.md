# Changelog

All notable changes to `ng-migrator` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [1.3.0] - 2026-11-24

- **Optional `--to` on `plan`**: `ng-migrator plan` without `--to` now defaults to the next Angular major (`n+1`), matching `analyze`. When the project is already on the latest published Angular major and `--to` is omitted, `plan` reports that nothing needs to be planned and exits `0`.
- **Nested Angular App Detection (`NGM-3007`)**: When `package.json` or `@angular/core` is missing in the target directory (for example, in full-stack repositories with an `angular/` or `frontend/` subfolder), `ng-migrator` scans subfolders (up to depth 2) for `package.json` + `angular.json` (or `nx.json` with `@angular/core`) and suggests `--project <subfolder>` across `doctor`, `analyze`, and `plan`, without creating `.ng-migrator/` in the non-Angular root.

## [1.2.1] - 2026-11-18

- Updated CLI help text, error hints, package description, and documentation from `n-1 to n` to `n to n+1`.

## [1.2.0] - 2026-11-14

- **Three-State Evidence & Signal Precedence**: Replaced binary Angular-peer classification with `declared compatible`, `declared incompatible`, and `unknown` (non-blocking "verify by build" note; core packages such as `rxjs`, `tslib`, and `zone.js` never flagged). Evaluates unknown-evidence signals in precedence order: `(a)` sibling alignment (e.g. `@ngrx/store-devtools`, `@nebular/eva-icons`), `(b)` Angular major alignment taking the newest release of the matching major line (e.g. `ngx-echarts` `16.2.0`) even when published after Angular `n+1`, then `(c)` newest release published on or before Angular `n+1`'s release date (`unknown-low-confidence` when none qualify).
- **Baseline vs Introduced Peer-Conflict Diff, Missing-Peer Notes & Per-Package Grouping**: Fixed `parsePeerConflicts` to ignore satisfied `Found:` dependency tree lines in `npm` `ERESOLVE` output. When `npm` reports `ERESOLVE`, `verifyWithPackageManager` compares proposed-set conflicts (`--legacy-peer-deps` + `npm ls --all --package-lock-only --json`) against a baseline discovery on the current manifest and lockfile in a temp directory: only **introduced** conflicts become hard `peer-conflict` blockers, **pre-existing** conflicts become grouped per-package notes (`already present at the current versions; not caused by this step`), and **resolved** conflicts are noted. When an introduced missing peer has a satisfying registry release (e.g. `@types/ckeditor@^4.9.10`), emits an `add-missing-peer` note (`dev-only` for `@types/*` and test tooling) instead of a hard blocker. Applies minimal-major raise-only companion upgrades (`echarts`, `jasmine-core`, `@types/node`) up to `maxConflictIterations` (default `3`), records the package manager version in step reports, attributes official lockstep conflicts, and groups all blocker reasons per unique package (`groupBlockersByPackage`).
- **Hardened Release Workflow & Live Nightly Matrix**: Updated `.github/workflows/release.yml` to gate `publish` on a 3-OS `test` job, verify tag-to-`package.json` parity, require `npm-publish` manual approval, use `NODE_AUTH_TOKEN` via `actions/setup-node` (`registry-url`), default `workflow_dispatch` to `dry_run: true`, and publish with `--provenance --access public`; added [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) and a non-blocking `live: informational` matrix job in `.github/workflows/nightly.yml` against `test/fixtures/live-mini`.
- **Proposed-Release View Engine / Ivy Detection & Lockfile Warnings**: Evaluates View Engine / `ngcc` suspects against registry artifacts (`fesm2020`, `fesm2022`, `exports`, `module`, `typings`) on the proposed target release (emits `ivy-upgrade` note when an Ivy release exists, hard blocker when none exist, or high-risk soft blocker for unknown old releases), warns clearly in step docs when `node_modules` is missing, and warns across `doctor`, `analyze`, `plan`, and step headers when `package.json` disagrees with the lockfile.
- **Deprecation Successor Parsing & Research Guidance**: Extracts named successor packages from npm `deprecated` notices (e.g. `@ngneat/transloco` -> `@jsverse/transloco`) as medium-confidence alternates and provides actionable next steps (`npm view`, repository link, README) when no alternate is known.
- **Offline Golden Regression & Shallow CI Guard**: Added an offline golden regression suite across the corpus projects and `ngx-admin`, set `fetch-depth: 0` in `.github/workflows/ci.yml`, and made the `Golden-Update:` commit-message guard skip cleanly with a clear message on shallow checkouts lacking commit history.
- **Stale Lock Auto-Recovery**: Stores host name, lock timestamp, and process start time (`processStartedAtMs`) to guard against reused PIDs across reboots, auto-recovers same-host verifiably dead locks while printing recovery details, and retains `NGM-3002` / `NGM-3003` manual-removal refusals for live or unverifiable owners.
- **CLI Progress & Timing Reporting**: Emits non-TTY and `--ascii`-safe per-phase progress lines (`Fetching registry metadata X/Y`, `Checking resolution with <pm> (this can take a minute)`, and `Total elapsed time`) on `stderr`, and adds measured online vs offline timings to `docs/large-projects-testing.md`.

## [1.1.2] - 2026-11-12

- **Sibling / Indirect Peer Resolution**: Resolved ecosystem packages lacking direct `@angular/*` peer ranges (such as `@ngrx/store-devtools` peering on `@ngrx/store`) alongside their sibling dependencies rather than falsely flagging them as `no-compatible-version` blockers.
- **Harmonized Blocker Counting**: Exported and unified `enrichBlockersWithResolutionCheck` across both `analyze` and `plan`, ensuring package manager peer conflicts (e.g. `@angular-eslint/schematics`) are aggregated consistently and eliminating count discrepancies between the two commands.
- **Version Ceiling & Target Exit Code**: Added audit-only mode to `analyze` without `--to` on projects already at the maximum published Angular major (exiting `0`), and aligned out-of-bounds target errors (`NGM-2002`) to exit code `2` (Usage/Input error).
- **Yarn Classic Performance**: Added `--prefer-offline` and `--no-bin-links` to isolated temporary directory verification for Yarn 1.x projects, avoiding unnecessary binary compilation and linking during planning runs.

## [1.1.1] - 2026-11-11

- Fixed semver range parsing crash (`TypeError: Invalid comparator`) on packages with malformed peer dependencies (e.g. single pipe `|` instead of `||` as in `@swimlane/ngx-charts`).
- Added `normalizeRange` and `safeMinVersion` helpers with safe error handling to protect analysis and planning against invalid registry peer strings.
- Added comprehensive unit test coverage for malformed range handling.

## [1.1.0] - 2026-11-11

- Added global `--project <path>` option to `doctor`, `analyze`, `plan`, `status`, and `approve`.
- Added `--as-of <date>` option for time-independent reproducibility and unmaintained dependency threshold checks.
- Added support for Yarn Classic (`1.x`) and Yarn Berry (`2+`) resolution checks, lockfile pruning, and configurable timeout.
- Added peer conflict detection and warnings parser for pnpm and yarn, harmonized with npm ERESOLVE.
- Added `analyze --fail-on-blockers` (exit code 4 on hard blockers).
- Added `--no-optional-locks` Git process safety guard and byte-identical `.git/index` verification.
- Added exact GitHub heading anchor slugs for error links to `docs/troubleshooting.md`.
- Excluded unneeded source maps from published package tarball to minimize package size.

## [1.0.0] - 2026-11-11

- Initial release of `ng-migrator` upgrade planner CLI.

### Added

- **Sequential $n \to n+1$ Planning:** Plans Angular major upgrades one step at a time (`plan --to <major>`), marking steps after the first as provisional until the preceding step is completed.
- **Dependency Blocker & Peer-Range Analysis:**
  - Evaluates npm registry metadata (including prereleases such as `@angular/flex-layout@15.0.0-beta.42` with `includePrerelease`) and peer dependency ranges against target Angular versions.
  - Distinguishes **hard** blockers (`no-compatible-version`, `peer-conflict`, `ivy-or-ngcc`) from **soft** blockers (`deprecated`, `unmaintained` with compatible peer ranges).
  - Tracks `dependencyKind` (`runtime` vs `dev-only`) and recommends tooling migrations (e.g., TSLint to ESLint via `@angular-eslint` for `codelyzer`) for dev-only tooling blockers.
  - Reports held-back versions both when newer releases require a later Angular major and when newer releases omit `@angular/*` peer ranges (e.g., `ngx-logger` `5.0.4` to `5.0.12`).
  - Deduplicates `remove` recommendations across multi-step plans so later steps reference `"depends on the decision at step n"`.
- **Workspace Usage Scanner & Unused-Dependency Guard:**
  - Scans TypeScript imports, call sites, external `.html` templates, and inline `@Component` templates (including `[fxFlex]`, `fxFlex.gt-sm`, `fxLayout="row wrap"`, and `*ngIf` blocks) using the bundled TypeScript parser.
  - Guards `"remove the unused dependency"` (high confidence) behind checks across `projects/*`, `libs/*`, `angular.json` styles/scripts, `tsconfig*.json` paths/types, SCSS/CSS `@use`/`@import`, `package.json` scripts, tool configs, and peer dependencies of other installed packages.
- **Isolated Package Manager Verification (`npm`, `pnpm`, `yarn` Classic & Berry):**
  - Runs resolution checks inside an isolated `os.tmpdir()` directory with copies of `package.json`, lockfile, and `.npmrc` and `--ignore-scripts`, cleaning up the temp directory afterwards (including on `SIGINT`/`SIGTERM`).
  - Parses peer conflicts and warnings from `npm`, `pnpm`, `yarn` Classic (`1.x`), and `yarn` Berry (`2+`) into actionable blockers with swap and explicit override options (`overrides`, `resolutions`, `pnpm.overrides`).
- **Reviewable Markdown Runbooks:**
  - Writes `.ng-migrator/steps/XX-angular-N-to-M.md` and `.ng-migrator/summary.md` with `package.json` manifest diff previews and stable decision IDs (`blocker-<slug>-<hash8>`) that preserve ticked checkboxes and reviewer notes across plan regeneration.
- **Deterministic Time & Project Options:**
  - Global `--project <path>` option keeping all output paths project-relative.
  - Global `--as-of <date>` option (and injected clock) for deterministic maintenance threshold evaluation.
- **Troubleshooting & Documentation:**
  - Complete [`docs/troubleshooting.md`](docs/troubleshooting.md) covering all `NGM-XXXX` error codes, enforced by bi-directional test coverage.
