# ng-migrator

> A read-only CLI that plans Angular upgrades one major version at a time (always $n \to n+1$), classifies dependencies with three-state compatibility evidence, detects View Engine / `ngcc` risks on proposed releases, verifies peer resolution in an isolated temp directory, and writes reviewable Markdown step runbooks under `.ng-migrator/`. **It never commits or modifies project files.**

[![CI](https://github.com/berserker5619/ng-migrator/actions/workflows/ci.yml/badge.svg)](https://github.com/berserker5619/ng-migrator/actions)
[![Node: >=22](https://img.shields.io/badge/node-%3E%3D22%20(22%20%7C%2024%20%7C%2026)-brightgreen.svg)](https://nodejs.org/)

---

## Quickstart

```bash
# 1. Install globally (or run directly with npx)
npm install -g ng-migrator

# 2. Check the machine and project health before starting
ng-migrator doctor

# 3. Inspect blockers for the immediate next Angular major version
ng-migrator analyze

# 4. Generate one Markdown runbook per n -> n+1 step up to your target major
ng-migrator plan --to 19

# 5. Check which steps are planned or approved
ng-migrator status

# 6. Approve step 1 after reviewing .ng-migrator/steps/01-angular-XX-to-YY.md
ng-migrator approve 1
```

You can also target a project in another directory using `--project <path>` and fix the reference date for maintenance calculations using `--as-of <YYYY-MM-DD>`:

```bash
ng-migrator --project ./path/to/app --as-of 2026-11-01 plan --to 19
```

---

## Safety Guarantees

- **Never commits or runs Git write commands:** `ng-migrator` enforces a subprocess guard that permits only read-only Git queries (`status`, `rev-parse`, `ls-files`, `--version`).
- **Never modifies files outside `.ng-migrator/`:** `doctor`, `analyze`, `plan`, `status`, and `approve` never edit `package.json`, lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), `.gitignore`, or source files. All generated plans, state, locks, and registry caches live strictly under `.ng-migrator/`.
- **Resolution checks run in an isolated OS temp directory:** When verifying whether a step's dependency set resolves cleanly, `ng-migrator` copies `package.json`, the project lockfile, and `.npmrc` into a fresh `os.tmpdir()` directory, runs the package manager with `--ignore-scripts` (never in the project directory), and deletes the temporary directory afterwards (including on `SIGINT`/`SIGTERM` interruption).
- **Stale lock auto-recovery:** `.ng-migrator/lock` records host name, lock timestamp, and process start time (`processStartedAtMs`) to guard against reused PIDs. If a lock's owning process on the same host is verifiably dead, `ng-migrator` recovers it automatically and prints what it did; live or unverifiable locks are refused safely (`NGM-3002` / `NGM-3003`).
- **Bundled parser isolation:** Code and template usage scanning uses the TypeScript parser bundled with `ng-migrator` and never loads a target project's compilers or plugins into the tool's process.

---

## How Analysis & Resolution Work

- **Three-state compatibility evidence:** Every package is classified as `declared compatible`, `declared incompatible`, or `unknown, verify by build` (when no `@angular/*` peer range is declared). `unknown` never emits a hard blocker or forces a downgrade; core runtime dependencies (`rxjs`, `tslib`, `zone.js`) are never flagged for lacking Angular peers. For `unknown` packages, target versions are chosen in precedence order: **(a)** sibling alignment (e.g. `@ngrx/store-devtools` -> `@ngrx/store`), **(b)** Angular major-line alignment, then **(c)** newest release published on or before Angular `n+1`'s release date.
- **View Engine / `ngcc` check on proposed releases:** `ng-migrator` checks whether the installed package uses View Engine / `ngcc` metadata and inspects the **proposed** target release's registry fields (`fesm2020`, `fesm2022`, `exports`, `module`, `typings`) to determine whether it is Ivy-era (`ivy-upgrade` note when an Ivy release exists, hard `ivy-or-ngcc` blocker when none exist, or high-risk soft blocker for old `unknown` releases). If `node_modules` is absent, step documents state that the local View Engine/`ngcc` check was not performed and how to run it.
- **Baseline vs introduced conflict discovery & companion upgrades:** When `npm` exits with `ERESOLVE` in the temp directory, `ng-migrator` resolves the temp directory with `--legacy-peer-deps` and parses `npm ls --all --package-lock-only --json` to discover all invalid and missing peer relationships, and compares them against a baseline discovery on the current manifest and lockfile (also in an isolated temp directory). Only **introduced** conflicts become blockers; **pre-existing** conflicts become grouped per-package notes (`already present at the current versions; not caused by this step`), and **resolved** ones are noted. Introduced missing peers that have a satisfying release in the registry (such as `@types/ckeditor@^4.9.10`) emit an `add-missing-peer` note (tagged `dev-only` for `@types/*` and test tooling) rather than a hard blocker. Findings are grouped per unique package (combining multiple reasons such as `ivy-or-ngcc + peer-conflict`). When a conflict can be fixed by **raising** an outdated direct dependency (e.g. `echarts` `4.9.0` -> `5.6.0` for `ngx-echarts@16.2.0`), it proposes a companion upgrade (tagging `devDependencies` companions as `dev-only`), re-checks resolution up to `maxConflictIterations` (default `3`), and reports a hard `peer-conflict` blocker if the conflict remains or would require a downgrade. Step documents record the exact package manager version used (e.g. `Resolution check: npm 11.17.0 ...`).
- **Progress & timing output:** Emits non-TTY and `--ascii`-safe progress lines (`Fetching registry metadata X/Y`, `Checking resolution with <pm> (this can take a minute)`, and `Total elapsed time`) on `stderr`.

---

## Supported Node.js Versions

- **Supported Node lines:** Node **22**, **24**, and **26** (`engines.node: ">=22"`).
- Node 18 and Node 20 are end of life and are rejected at startup with `NGM-6001`.

---

## Current Limits (Read-Only Planner)

- **Read-only planning only (`1.x` scope):** `ng-migrator` analyzes dependencies, verifies peer ranges, scans codebase usage footprints, writes `.ng-migrator/steps/*.md` and `.ng-migrator/summary.md`, and records human approval via `ng-migrator approve <step>`.
- **No `migrate` executor yet:** There is no `migrate` command or automated code/manifest executor in the current CLI. Step documents provide a `package.json` diff preview and actionable blocker resolutions for you to apply and review.
- **Package manager coverage:** The `npm` verification and full conflict discovery path is the most extensively tested across real-world repositories; `yarn` (Classic 1.x / Berry) and `pnpm` run isolated lockfile-only checks and parse peer conflict output, with narrower real-world corpus coverage.

---

## Commands & Options

| Command | Description |
|---|---|
| `ng-migrator doctor` | Pre-upgrade check: Node runtime (`>=22`), Git working tree status, Angular version (including manifest vs lockfile disagreements), package manager detection, path length warnings, and active port 4200 check. |
| `ng-migrator analyze` | Reports current Angular version, dependencies, and blockers for the next major (or audit-only mode when already at the latest published Angular major). Supports `--fail-on-blockers` (exits with code `4` on hard blockers only), `--report <path>`, and `--offline`. |
| `ng-migrator plan --to <major>` | Generates one `.ng-migrator/steps/XX-angular-N-to-M.md` document per step and `.ng-migrator/summary.md`. Supports `--package-manager <npm\|yarn\|pnpm>`, `--rules <path...>`, `--offline`, and `--allow-dirty`. |
| `ng-migrator status` | Shows which steps are `planned` or `approved`. |
| `ng-migrator approve <step>` | Reads ticked decision checkboxes and reviewer notes from the step document and marks the step `approved` in `.ng-migrator/state.json`. |

### Global Options

- `--project <path>`: Path to the Angular project root (default: current directory). All paths in output remain project-relative.
- `--as-of <date>`: Reference ISO date (for example `2026-11-01`) used to evaluate the unmaintained threshold and timestamps deterministically.
- `--no-color`: Plain output without ANSI colors.
- `--ascii`: ASCII symbols only (`[ok]`, `[!]`, `[x]`, `-`).
- `--verbose`: Print diagnostic details and stack traces.

---

## Configuration (`ng-migrator.config.json`)

```json
{
  "packageManager": "npm",
  "rules": ["./migration-rules.json"],
  "unmaintainedThresholdMonths": 18,
  "resolutionTimeoutMs": 300000,
  "maxConflictIterations": 3,
  "neverTouch": ["my-internal-sdk"],
  "pinned": {
    "rxjs": "7.8.2"
  },
  "alternates": {
    "allow": ["@floating-ui/dom"],
    "deny": ["deprecated-lib"]
  },
  "verify": {
    "build": "npm run build",
    "lint": "npm run lint",
    "test": "npm test"
  },
  "cacheDir": ".ng-migrator/cache",
  "commandPrefix": {
    "14": "fnm exec --using 14 --",
    "16": "fnm exec --using 16 --"
  }
}
```

- `resolutionTimeoutMs`: Timeout in milliseconds for isolated package-manager resolution checks (default: `300000`).
- `maxConflictIterations`: Maximum companion-upgrade re-check iterations when resolving fixable peer conflicts (default: `3`).
- `commandPrefix`: Optional string or per-target-major map reserved for running step commands under a specific Node toolchain (validated now; reserved for future execution support).

---

## Documentation

- [Rule Authoring Guide](docs/rules.md)
- [Troubleshooting & Error Codes](https://github.com/berserker5619/ng-migrator/blob/main/docs/troubleshooting.md) ([local copy](docs/troubleshooting.md))
- [Large Projects Testing Report](docs/large-projects-testing.md)
- [Release Checklist](RELEASE_CHECKLIST.md)
- [Push Checklist](PUSH_CHECKLIST.md)
- [Security Policy](SECURITY.md)

---

## Troubleshooting and Diagnostics

- **Diagnostics & Error IDs:** Every failure surfaces a stable `NGM-XXXX` code linking directly to its heading on the [Troubleshooting Page](https://github.com/berserker5619/ng-migrator/blob/main/docs/troubleshooting.md).
- **Stack Traces & Bundled Code:** `ng-migrator` ships as a compact, self-contained binary (`dist/cli.js`) without external source maps (`sourcemap: false`). Stack traces point into `dist/cli.js`. When diagnosing or reporting issues, always refer to the specific `NGM-*` error code, review the troubleshooting documentation, and capture full command diagnostics with `--verbose` and the run logs stored under `.ng-migrator/logs/`.
