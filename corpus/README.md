# Test Corpus: Open-Source Benchmark Projects

To ensure calibration and prevent regression, `ng-migrator` is evaluated against real-world public open-source projects pinned to specific immutable commits (plan section 14.1).

> **Public Code Only:** No proprietary, employer, or client applications are ever used for testing, calibration, or benchmarking. Upstream code is cloned at test time; no external code is copied into this repository.

---

## Pinned Benchmark Corpus Matrix

| Project | Upstream Repository | Commit SHA | License | Angular Baseline | Characteristics & Key Dependencies | Expected Blockers / Decisions |
|---|---|---|---|---|---|---|
| **angular-14-login** | `cornflourblue/angular-14-registration-login-example` | `f766ca720d38c4ac136be4a6a14e76547d06265e` | MIT | Angular 14.2.12 | Classic NgModule architecture, RxJS ~7.5, TypeScript ~4.7.2 | Clean progression across 14 -> 15 -> 16 -> 17; zero blockers. |
| **angular-13-login** | `bezkoder/angular-13-login-registration-example` | `8eb9d13516642e15bc64e4ae157bf019a7872912` | unknown | Angular 13.0.3 | Angular 13 with JWT auth, Jasmine, Karma | Ivy / ngcc cliff at Angular 16; zero blockers for 13 -> 14. |
| **ng-material-starter-kit** | `Lowgular/ng-material-starter-kit` | `741803635b0fb3a8070a1e09dc503b739538a780` | unknown | Angular 14.2.2 | Angular Material, CDK, `@angular/flex-layout` | Step 1 (14 -> 15): `@angular/flex-layout` is deprecated & unmaintained (declared compatible with 15.0.0-beta.42, soft blocker); Step 2 (15 -> 16): hard blocker. |

---

## Baseline Verification Protocol

Each corpus benchmark is associated with an exact baseline JSON record under `corpus/baselines/` documenting:
1. Pinned commit SHA and recorded license.
2. Expected major upgrade steps ($n-1 \to n$).
3. Expected dependency blockers and their exact classified reasons (`deprecated`, `no-compatible-version`, etc.).
4. Expected resolution ladder recommendation (Upgrade, Alternate, Fork, Inline, Manual).
5. Lockfile resolution status (confirmed without peer dependency errors).
