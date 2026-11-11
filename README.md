# ng-migrator

> A CLI that plans Angular upgrades one major version at a time (always $n-1 \to n$), identifies dependency blockers, recommends proven fixes, and writes reviewable Markdown runbooks. **It never commits anything.**

[![CI](https://github.com/berserker5619/ng-migrator/actions/workflows/ci.yml/badge.svg)](https://github.com/berserker5619/ng-migrator/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node: >=22.12](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)

---

## The Problem

`ng update` upgrades Angular core packages and packages with schematics, but it does not plan around third-party dependencies:
- Peer-dependency conflicts (`ERESOLVE`).
- Unmaintained libraries with no release for the target Angular version.
- Abandoned packages and View Engine era packages (where `ngcc` was removed in Angular 16).
- Shifting Node, TypeScript, RxJS, and `zone.js` constraints across versions.

Teams discover these issues one failure at a time.

## What ng-migrator Does

- **Plans $n-1 \to n$ only:** Upgrades one major version at a time, never skipping versions.
- **Dependency Blocker Analysis:** Scans npm metadata and peer ranges to determine exactly what will break before changing any file.
- **Recommendation Engine:** Evaluates usage footprint in your codebase and package complexity to recommend the best fix:
  1. *Upgrade* to a compatible release.
  2. *Alternate package* (ranked by maintenance, downloads, and API fit).
  3. *Maintained fork*.
  4. *Write in codebase* (inline directive/shim for simple utilities like tooltips or clipboards).
  5. *Manual review* with effort estimates and runner-up choices.
- **Reviewable Markdown Runbooks:** Generates a structured `.ng-migrator/steps/01-angular-XX-to-YY.md` document for each step.
- **Never Commits:** Leaves all changes uncommitted in the working tree for the team to review and decide when to commit.

---

## Quickstart

```bash
# Check the environment and project health before starting
npx ng-migrator doctor

# Inspect blockers for the next immediate major version
npx ng-migrator analyze

# Generate a multi-step upgrade plan up to your target major version (changes no project files)
npx ng-migrator plan --to 19

# Inspect plan status and approval states
npx ng-migrator status

# Approve step 1 after reviewing .ng-migrator/steps/01-...md
npx ng-migrator approve 1
```

---

## Commands

| Command | Description |
|---|---|
| `ng-migrator doctor` | Pre-upgrade health check: Node runtime, clean working tree, lockfile consistency, Windows MAX_PATH limits, and running dev servers on port 4200. |
| `ng-migrator analyze` | Reports current Angular version, dependencies, and immediate next-major blockers. Supports `--fail-on-blockers` for CI pipelines and `--report <path>`. |
| `ng-migrator plan --to <major>` | Generates $n-1 \to n$ step documents under `.ng-migrator/steps/` and `.ng-migrator/summary.md`. |
| `ng-migrator status` | Displays overview of all planned, approved, and completed steps. |
| `ng-migrator approve <step>` | Approves a step after human review. Warns if open checklist decisions remain unchecked. |

### Global Flags

- `--no-color`: Disable ANSI terminal colors.
- `--ascii`: Use plain ASCII symbols (`[ok]`, `[!]`, `[x]`) for older terminals and CI logs.
- `--verbose`: Print diagnostic details and stack traces.

---

## Configuration (`ng-migrator.config.json`)

You can customize `ng-migrator` by adding an optional `ng-migrator.config.json` at your project root:

```json
{
  "packageManager": "npm",
  "rules": ["./migration-rules.json"],
  "neverTouch": ["my-internal-sdk"],
  "pinned": {
    "rxjs": "7.8.1"
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

- **`commandPrefix`:** Allows steps targeting older Angular versions to execute subprocesses under their supported Node version while `ng-migrator` itself runs on modern Node.

---

## Documentation

- [Rule Authoring Guide](docs/rules.md)
- [Troubleshooting & Error Codes](docs/troubleshooting.md)
- [Security Policy](SECURITY.md)

---

## License

MIT © ng-migrator contributors
