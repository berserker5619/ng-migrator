# Changelog

All notable changes to `ng-migrator` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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

- **Sequential $n-1 \to n$ Planning:** Plans Angular major upgrades one step at a time (`plan --to <major>`), marking steps after the first as provisional until the preceding step is completed.
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
