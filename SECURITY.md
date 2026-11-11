# Security Policy

## Supported Versions

| Version | Supported | Node.js Runtime |
|---|---|---|
| `1.1.x` | Active | Node `22`, `24`, `26` (`>=22`) |
| `1.0.x` | Supported | Node `22`, `24`, `26` (`>=22`) |

*(Node 18 and Node 20 are end of life and are not supported.)*

## Supply-Chain & Workspace Safety Guarantees

`ng-migrator` enforces strict safety boundaries by design:

1. **Non-Destructive Workspace Guarantee:** `ng-migrator` never creates, modifies, or deletes any file in a target project outside `.ng-migrator/`. It never edits `package.json`, lockfiles, `.gitignore`, or source files during `doctor`, `analyze`, `plan`, `status`, or `approve`.
2. **Read-Only Git Subprocess Guard:** `ng-migrator` never commits, pushes, stashes, resets, or modifies Git configuration. An internal process guard (`src/platform/process.ts`) blocks any Git subcommand outside `status`, `rev-parse`, `ls-files`, and `--version`.
3. **Isolated Temp-Directory Resolution Checks with `--ignore-scripts`:** Package-manager resolution checks (`npm`, `pnpm`, `yarn`) run exclusively inside a freshly created `os.tmpdir()` directory holding copies of `package.json`, the lockfile, and `.npmrc` with `--ignore-scripts` enabled, and the temporary directory is deleted immediately afterwards (including on `SIGINT`/`SIGTERM`).
4. **Bundled Parser Isolation:** Codebase and template analysis uses the TypeScript parser bundled with `ng-migrator` and never loads or executes compilers, plugins, or scripts from the target project's `node_modules`.
5. **Credential & Path Redaction:** Registry tokens, Basic auth headers, URL credentials, and user home paths are scrubbed from generated Markdown step documents, summaries, and error messages.
6. **Zero Telemetry & Pinned CI Actions:** `ng-migrator` collects zero telemetry and only queries the npm registries configured in `.npmrc`. GitHub Actions workflows pin third-party actions by full 40-character commit SHA.

## Reporting a Vulnerability

If you discover a potential security vulnerability in `ng-migrator`, please report it privately rather than opening a public issue:

- Report via **GitHub Private Security Advisories** on the repository, or
- Email the maintainer at `nizamudeen5619@gmail.com`.
