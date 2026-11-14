# Release Checklist

Use this checklist when publishing a new version of `ng-migrator` via `.github/workflows/release.yml`.

---

## 1. GitHub `npm-publish` Environment Setup

1. Open your GitHub repository **Settings -> Environments** and create an environment named **`npm-publish`**.
2. Enable **Required reviewers** and add yourself (or release maintainers) so every `publish` job pauses for manual approval before publishing to npm.
3. Optionally restrict **Deployment branches and tags** to `v*` tags and `main`.

---

## 2. Granular npm Access Token (Scoped & Expiring)

1. Sign in to [npmjs.com](https://www.npmjs.com/) -> **Access Tokens -> Generate New Token -> Granular Access Token**.
2. Set a short **Expiration** (for example, 30 or 90 days).
3. Under **Packages and scopes**, choose **Read and write** and restrict access strictly to the single package **`ng-migrator`**.
4. Save the token as an environment secret named **`NPM_TOKEN`** inside the **`npm-publish`** GitHub environment (never at the org level or committed to the repo).
5. `.github/workflows/release.yml` passes `${{ secrets.NPM_TOKEN }}` via `NODE_AUTH_TOKEN` with `actions/setup-node` (`registry-url: 'https://registry.npmjs.org'`), avoiding writing credentials to `~/.npmrc`.

---

## 3. Optional: npm Trusted Publishing (OIDC) Instead of a Token

If you prefer keyless OIDC publishing instead of `NPM_TOKEN`:

1. On npmjs.com, open **`ng-migrator` -> Settings -> Trusted Publisher -> GitHub Actions**.
2. Configure:
   - **Owner**: `berserker5619`
   - **Repository**: `ng-migrator`
   - **Workflow filename**: `release.yml`
   - **Environment**: `npm-publish`
3. Remove `NPM_TOKEN` from `npm-publish`. Because the `publish` job grants `id-token: write` and runs `npm publish --provenance --access public --tag <dist-tag>`, npm authenticates via GitHub OIDC automatically.

---

## 4. Pre-Release & Dispatch Steps

1. Run `npm run check` locally and confirm `package.json` version matches the tag you plan to push (`v<version>`).
2. Test first using **Actions -> Release & Publish -> Run workflow** with `dry_run: true` (the default) and `tag: v<version>`.
3. Once verified, push the tag `git push origin v<version>` (or run `workflow_dispatch` with `dry_run: false`) and approve the `npm-publish` environment gate.
