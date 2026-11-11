# Changelog

All notable changes to `ng-migrator` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-11-11

Initial production release of `ng-migrator`.

### Features

- **Sequential $n \to n+1$ Planning:** Strict single-major upgrade planning with provisional preview for multi-step upgrade paths.
- **Dependency Blocker Analyzer:** Detects peer-dependency conflicts (`ERESOLVE`), legacy View Engine packages relying on `ngcc`, and missing target releases.
- **Recommendation Engine:** Evaluates usage footprint in codebase and package complexity to suggest proven fixes via the resolution ladder (**Upgrade $\to$ Alternate Package $\to$ Fork $\to$ Inline Codebase Shim $\to$ Manual**).
- **Runbook Generation:** Formats zero-padded, reviewable markdown runbooks (`.ng-migrator/steps/01-angular-XX-to-YY.md`) and `.ng-migrator/summary.md`. Preserves ticked decision checkboxes across plan regenerations.
- **Isolated Package Manager Verification:** Runs dry-run lockfile checks (`--package-lock-only`) strictly in temporary directories with `--ignore-scripts`, never modifying the real project lockfile during planning.
- **CLI Commands:**
  - `doctor`: Comprehensive pre-flight health checks (Node, clean git status, lockfiles, Windows MAX_PATH, and active port 4200 servers).
  - `analyze`: Immediate blocker inspection for the next Angular major.
  - `plan`: Multi-step upgrade plan generation.
  - `status`: Interactive migration status and step review.
  - `approve`: Explicit CLI approval required before proceeding.
- **Cross-Platform Safety:**
  - Hard git write guard preventing unauthorized git write operations.
  - Line-ending preservation byte-for-byte across CRLF and LF files.
  - Windows file locking retries with backoff.
- **Test Corpus:** Synthetic fixtures covering abandoned libraries, View Engine cliffs, held-back releases, inlinable tooltips, and peer conflicts.
