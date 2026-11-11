# Test Corpus: Open-Source Benchmark Projects

To ensure calibration and prevent regression, `ng-migrator` is evaluated against real-world public open-source projects pinned to specific immutable commits (plan section 14.1).

> **Public Code & License Policy:** No proprietary, employer, or client applications are ever used for testing, calibration, or benchmarking. Upstream code is never forked, vendored, or copied into this repository. Projects without a verified permissive license (`license: "unknown"`) are marked **`local-only`** and are strictly excluded from CI and nightly runs.

---

## Pinned Benchmark Corpus Matrix

| Project | Upstream Repository | Commit SHA | License | Tier | Angular Baseline | Characteristics & Key Dependencies | Expected Blockers / Decisions |
|---|---|---|---|---|---|---|---|
| **angular-14-login** | `cornflourblue/angular-14-registration-login-example` | `f766ca720d38c4ac136be4a6a14e76547d06265e` | MIT | `ci` | Angular 14.2.12 | Classic NgModule architecture, RxJS ~7.5, TypeScript ~4.7.2 | Clean progression across 14 -> 15 -> 16 -> 17; zero blockers. |
| **k8s-istio-observe-frontend** | `garystafford/k8s-istio-observe-frontend` | `1e13e3e9bb40fa7b5f5c0e3df8f14f7ed245b3df` | MIT | `ci` | Angular 12.0.1 | Angular 12 with View Engine-era `codelyzer` (referenced in `tslint.json`) and unmaintained `ngx-logger` | Across 12 -> 13 -> 14 -> 15 -> 16: `codelyzer` is a hard blocker (`no-compatible-version`, recommended fix: `@angular-eslint/eslint-plugin`, referenced in `tslint.json`); `ngx-logger` is a soft blocker (`unmaintained`, `declared compatible`). |
| **angular-15-signup-boilerplate** | `cornflourblue/angular-15-signup-verification-boilerplate` | `0ba71391309cfad3940167842f3ca351bfd5b2fd` | MIT | `ci` | Angular 15.2.6 | Angular 15 auth/verification app, RxJS ~7.5, TypeScript ~4.8.2 | Clean progression across 15 -> 16 -> 17; zero blockers. |
| **angular-13-login** | `bezkoder/angular-13-login-registration-example` | `8eb9d13516642e15bc64e4ae157bf019a7872912` | unknown | `local-only` | Angular 13.0.3 | Angular 13 with JWT auth, Jasmine, Karma | Clean progression across 13 -> 14 -> 15 -> 16; zero blockers. Excluded from CI/nightly due to unknown license. |
| **ng-material-starter-kit** | `Lowgular/ng-material-starter-kit` | `741803635b0fb3a8070a1e09dc503b739538a780` | unknown | `local-only` | Angular 14.2.2 | Angular Material, CDK, `@angular/flex-layout` (unused in `src/`) | Both Step 1 (14 -> 15) and Step 2 (15 -> 16): `@angular/flex-layout@15.0.0-beta.42` has open-ended peers (`>=15.0.2`), so it is a soft blocker (`deprecated`, `declared compatible`, `unmaintained`); recommendation is `remove the unused dependency` (high confidence) with `CSS flexbox/grid, Tailwind CSS` as runner-ups. Excluded from CI/nightly due to unknown license. |

---

## Baseline Verification Protocol

Each corpus benchmark is associated with an exact baseline JSON record under `corpus/baselines/` documenting:
1. Pinned commit SHA, recorded license, and execution tier (`ci` vs `local-only`).
2. Expected major upgrade steps ($n-1 \to n$).
3. Expected dependency blockers, their severity (`hard: true | false`), and classified reasons (`deprecated`, `unmaintained`, `no-compatible-version`, etc.).
4. Expected recommendation (`remove`, `alternate`, `inline`, `upgrade`, `fork`, `manual`), confidence, and runner-ups.
5. CI and nightly workflows only run baselines with `tier: "ci"` (`ci: true`, `nightly: true`) and a verified permissive license; `local-only` baselines (`ci: false`, `nightly: false`) are never cloned or executed in CI/nightly.
