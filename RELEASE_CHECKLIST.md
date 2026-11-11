# Release Checklist (`0.1.0`)

## 1. Package Name Check
- **Status:** `pending` (decided by repository owner before pushing/publishing).
- **Current working name in `package.json`:** `ng-migrator` (`0.1.0`).
- **Action before publishing:** Confirm final package name (`ng-migrator` or scoped name) and update `package.json`, `README.md`, and npm Trusted Publisher settings if changed.

## 2. License File (`LICENSE`)
- **Status:** `pending user confirmation`.
- **Current file:** [`LICENSE`](./LICENSE) (currently MIT template from initial repository scaffold; `package.json` `"license": "MIT"`).
- **Decision required:** Confirm which license you want (`MIT`, `Apache-2.0`, `BSD-3-Clause`, or another license) so `LICENSE` and `package.json` match your choice.

## 3. Security Policy (`SECURITY.md`)
- **Status:** `complete` — [`SECURITY.md`](./SECURITY.md).
- **Covers:** Supported versions (`0.1.x` on Node `22`, `24`, `26`), private vulnerability reporting via GitHub Security Advisories, and non-destructive runtime security guarantees (never writes outside `.ng-migrator/`, never executes lifecycle scripts during temp-dir resolution checks via `--ignore-scripts`, and never runs git write commands).

## 4. Changelog (`CHANGELOG.md`)
- **Status:** `complete` — [`CHANGELOG.md`](./CHANGELOG.md).
- **Covers:** `0.1.0` initial read-only release (`doctor`, `analyze`, `plan`, `status`, `approve`), safety guarantees, multi-package-manager peer conflict parsing (`npm`, `pnpm`, `yarn` Classic `1.x` and Berry `2+`), `--project <path>`, `--as-of <date>`, and `NGM-*` troubleshooting documentation.

## 5. `npm pack` Contents Check
Verified with `npm pack --dry-run`:

```text
npm notice
npm notice package: ng-migrator@0.1.0
npm notice Tarball Contents
npm notice 3.3kB CHANGELOG.md
npm notice 1.1kB LICENSE
npm notice 5.7kB README.md
npm notice 129.9kB dist/cli.js
npm notice 261.8kB dist/cli.js.map
npm notice 1.4kB package.json
npm notice Tarball Details
npm notice name: ng-migrator
npm notice version: 0.1.0
npm notice filename: ng-migrator-0.1.0.tgz
npm notice package size: 101.2 kB
npm notice unpacked size: 403.2 kB
npm notice total files: 6
```

- Only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json` are included (`"files": ["dist"]` in `package.json`).
- No `test/`, `corpus/`, `src/`, or `.ng-migrator/` artifacts are leaked into the published tarball.

## 6. Fresh-Machine Install Test (Windows, macOS, Linux)
- **Windows (verified locally on Windows / Node `v24.19.0`):**
  1. Packed `ng-migrator-0.1.0.tgz` via `npm pack` into an isolated OS temp directory.
  2. Installed into a clean consumer folder (`npm install --no-save --ignore-scripts --no-audit --no-fund ng-migrator-0.1.0.tgz`).
  3. Verified `ng-migrator --version` (`0.1.0`) and `ng-migrator --help` (lists only `doctor`, `analyze`, `plan`, `status`, `approve`; no `migrate` command).
  4. Removed the temporary directory (`PACK TEMP DIR CLEANED: true`).
- **macOS (`macos-latest`) and Linux (`ubuntu-latest`) (plus `windows-latest`):**
  - Configured in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) across `os: [ubuntu-latest, macos-latest, windows-latest]` and `node: [22, 24, 26]`.
  - To run a fresh-install smoke check on all three OSes in CI upon push, run:
    ```bash
    npm pack
    npm install --global ./ng-migrator-0.1.0.tgz
    ng-migrator --version
    ng-migrator --help
    ```

## 7. Provenance & Trusted Publishing Notes
- **Workflow:** [`.github/workflows/release.yml`](./.github/workflows/release.yml) triggers on `v*` tags (`v0.1.0`).
- **Pinned GitHub Actions:** All workflow actions in `ci.yml`, `nightly.yml`, and `release.yml` are pinned by full 40-character commit SHA with version comments (`actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332 # v5.0.0`, `actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0`).
- **OIDC Trusted Publishing & Provenance:**
  - `release.yml` declares `permissions: contents: read, id-token: write`.
  - Runs `npm publish --provenance --access public` on Node `24` (npm `11+`), which uses OpenID Connect (OIDC) Trusted Publishing without long-lived `NPM_TOKEN` secrets when Trusted Publisher is configured on npmjs.com for the repository and `release.yml` workflow.
  - Ensure the repository URL in `package.json` (`repository.url`) matches the GitHub `owner/repo` configured in npm Trusted Publisher settings so provenance attestation verification succeeds.
