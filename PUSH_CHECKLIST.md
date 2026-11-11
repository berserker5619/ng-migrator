# Push Readiness & Verification Checklist

This document details the exact git and CI status for `ng-migrator` before pushing to GitHub.

---

## 1. Repository Configuration & Links Resolution

- **Repository Owner & Name (`package.json`):**
  - Owner: `berserker5619`
  - Repository: `ng-migrator`
  - URL: `https://github.com/berserker5619/ng-migrator`
- **Troubleshooting Documentation URL:**
  - Base: `https://github.com/berserker5619/ng-migrator/blob/main/docs/troubleshooting.md`
- **Will Links Resolve Once Public?**
  - **Yes.** As soon as the GitHub repository `berserker5619/ng-migrator` is public (or accessible to the authenticated user on GitHub), all generated links and CLI error messages will resolve directly to their exact heading anchors (e.g., `#ngm-1001-unexpected-internal-error`).

---

## 2. Tracked Files Audit (`git ls-files`)

A complete audit of all tracked files confirms:
- **No secrets or tokens:** No API keys, NPM tokens, personal access tokens, or credentials are tracked.
- **No local drive paths:** No hardcoded local drive paths (such as `L:\`, `C:\Users\...`) exist in any committed files.
- **No personal data:** No internal machine hostnames or usernames are leaked.
- **No corpus clones or vendored repositories:** Only baseline metadata JSON files exist under `corpus/baselines/` (`angular-13-login.json`, `angular-14-login.json`, `angular-15-signup-boilerplate.json`, `k8s-istio-observe-frontend.json`, `ng-material-starter-kit.json`). No test clones or upstream code is vendored.
- **No `.ng-migrator/` runtime artifacts:** Git ignores `.ng-migrator/` across workspaces.
- **No `node_modules/` or build artifacts:** Dist and node_modules are ignored and not tracked.

---

## 3. Remote & Commit Log Status

- **Remotes (`git remote -v`):**
  ```text
  origin  https://github.com/berserker5619/ng-migrator.git (fetch)
  origin  https://github.com/berserker5619/ng-migrator.git (push)
  ```
- **Local commit status:** `main` is ahead of `origin/main` by local commits ready for review.

---

## 4. Commands to Push a Branch and Run CI

To trigger GitHub Actions CI without pushing directly to `main`, push to a feature branch:

```bash
# 1. Ensure you are on a branch (e.g., prepare-v1.1.0)
git checkout -b prepare-v1.1.0

# 2. Push the branch to origin
git push -u origin prepare-v1.1.0
```

Once pushed, open a Pull Request against `main` on GitHub to trigger the CI workflow.

---

## 5. What to Look For in the First CI Results

When the CI workflow runs on GitHub (`.github/workflows/ci.yml`), verify:

1. **Matrix Execution:**
   - Runs 9 matrix combinations across 3 OSes (`ubuntu-latest`, `macos-latest`, `windows-latest`) and 3 Node lines (`22`, `24`, `26`).
2. **Action SHA Pinning:**
   - Both `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` and `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` execute without warnings or unpinned tag deprecation notices.
3. **Check Steps:**
   - `npm ci` completes cleanly.
   - `npm run lint` passes with 0 ESLint errors/warnings.
   - `npm run typecheck` (`tsc --noEmit`) passes with 0 TypeScript diagnostics.
   - `npm run build` bundles `dist/cli.js` via `tsup` targeting `node22`.
   - `npm test` runs all 151 Vitest tests across 17 test suites and passes.
4. **Tarball Install Smoke Test:**
   - The final smoke step creates a fresh temp directory, runs `npm pack`, installs the `.tgz` package into an isolated consumer project, and verifies `npx ng-migrator --version` outputs `1.1.0` and `npx ng-migrator --help` succeeds without missing dependencies.
