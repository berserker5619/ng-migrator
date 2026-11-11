# ng-migrator

> A CLI that plans Angular upgrades one major version at a time (always $n-1 \to n$), identifies dependency blockers, recommends fixes from codebase usage and peer-range metadata, and writes reviewable Markdown step runbooks under `.ng-migrator/`. **It never commits or modifies project files.**

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

# 4. Generate one Markdown runbook per n-1 -> n step up to your target major
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

- **Never commits or runs Git write commands:** `ng-migrator` enforces a strict subprocess guard that permits only read-only Git queries (`status`, `rev-parse`, `ls-files`, `--version`).
- **Never modifies files outside `.ng-migrator/`:** `doctor`, `analyze`, `plan`, `status`, and `approve` never edit `package.json`, lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`), `.gitignore`, or source files. All generated plans, state, locks, and registry caches live strictly under `.ng-migrator/`.
- **Resolution checks run in an isolated OS temp directory:** When verifying whether a step's dependency set resolves cleanly, `ng-migrator` copies `package.json`, the project lockfile, and `.npmrc` into a fresh `os.tmpdir()` directory, runs the package manager with `--ignore-scripts`, and deletes the temporary directory afterwards (including on `SIGINT`/`SIGTERM` interruption).
- **Bundled parser isolation:** Code and template usage scanning uses the TypeScript parser bundled with `ng-migrator` and never loads a target project's compilers or plugins into the tool's process.

---

## Supported Node.js Versions

- **Supported Node lines:** Node **22**, **24**, and **26** (`engines.node: ">=22"`).
- Node 18 and Node 20 are end of life and are rejected at startup with `NGM-6001`.

---

## Current Limits (Read-Only Planner)

- **Read-only planning only (`0.1.0` / `1.x` scope):** `ng-migrator` analyzes dependencies, verifies peer ranges, scans codebase usage footprints, writes `.ng-migrator/steps/*.md` and `.ng-migrator/summary.md`, and records human approval via `ng-migrator approve <step>`.
- **No `migrate` executor yet:** There is no `migrate` command or automated code/manifest executor in the current CLI. Step documents provide a `package.json` diff preview and actionable blocker resolutions for you to apply and review.
- **`commandPrefix` configuration:** `ng-migrator.config.json` accepts an optional `commandPrefix` (a string or per-major map, such as `"fnm exec --using 16 --"`). It is validated and documented now, and reserved for use when the step executor is introduced.

---

## Commands & Options

| Command | Description |
|---|---|
| `ng-migrator doctor` | Pre-upgrade check: Node runtime (`>=22`), Git working tree status, Angular version, package manager detection, path length warnings, and active port 4200 check. |
| `ng-migrator analyze` | Reports current Angular version, dependencies, and blockers for the next major. Supports `--fail-on-blockers` (exits with code `4` on hard blockers only), `--report <path>`, and `--offline`. |
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

---

## Documentation

- [Rule Authoring Guide](docs/rules.md)
- [Troubleshooting & Error Codes](https://github.com/berserker5619/ng-migrator/blob/main/docs/troubleshooting.md) ([local copy](docs/troubleshooting.md))
- [Security Policy](SECURITY.md)
- [Release Checklist](RELEASE_CHECKLIST.md)
