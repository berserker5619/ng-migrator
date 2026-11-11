# Test Corpus: Open-Source Benchmark Projects

To ensure calibration and prevent regression, `ng-migrator` is evaluated against real-world public open-source projects pinned to specific immutable commits (plan section 14.1).

> **Public Code Only:** No proprietary, employer, or client applications are ever used for testing, calibration, or benchmarking. Upstream code is cloned at test time; no external code is copied into this repository.

---

## Benchmark Corpus Matrix

| Project | Upstream Repository | Commit SHA | License | Angular Baseline | Characteristics & Key Dependencies | Expected Blockers / Decisions |
|---|---|---|---|---|---|---|
| **Conduit RealWorld** | `gothinkster/angular-realworld-example-app` | `1a7f3d2...` | MIT | Angular 14 | Classic NgModule architecture, RxJS, NgRx, standard HTTP interceptors. | Angular 14 $\to$ 15 MDC component updates; standalone migration candidate. |
| **Tour of Heroes Extended** | `johnpapa/angular-tour-of-heroes` | `8c4e12a...` | MIT | Angular 13 | Legacy View Engine / Ivy transition project, Angular Material. | View Engine / `ngcc` cliff at Angular 16; Material legacy component deprecations. |
| **Angular Admin Dashboard** | `akveo/ngx-admin` | `5e9b81f...` | MIT | Angular 15 | Mixed NgModule & standalone, `@nebular/theme`, `@angular/cdk`, charts. | ECharts / Chart.js peer range constraints; CDK overlay migrations. |
| **Portfolio Showcase** | `sanjayshah/angular-portfolio` | `f29a04b...` | MIT | Angular 16 | Standalone components, modern signals early adoption, custom tooltips. | Custom tooltip inline recommendation; third-party animation library updates. |
| **Enterprise Starter** | `mathiscode/angular-enterprise-starter` | `d71c98e...` | MIT | Angular 15 | Strict workspace, custom ESLint rules, scoped internal dependencies. | RxJS 7 $\to$ 8 compatibility boundaries, Node engine shifts. |

---

## Baseline Verification Protocol

Each corpus benchmark is associated with a baseline JSON record under `corpus/baselines/` documenting:
1. Expected major upgrade steps ($n-1 \to n$).
2. Expected dependency blockers and their exact classified reasons.
3. Expected resolution ladder recommendation (Upgrade, Alternate, Fork, Inline, Manual).
4. Lockfile resolution status (confirmed without peer dependency errors).

Nightly CI executes test verification against these pinned baselines.
