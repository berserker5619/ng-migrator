# Rule Authoring Guide

`ng-migrator` includes a recommendation engine that dynamically computes migration strategies for third-party dependencies based on codebase usage footprint and package metadata.

Rules allow teams and community contributors to flag packages that stopped releasing after a given Angular major (`lastReleaseFor`) and provide curated recommendations, alternatives, and guidance. A rule never overrides peer-range compatibility evidence or turns a declared-compatible package into a hard blocker.

---

## Rule Schema

A rule file is a JSON document containing an array of rule objects (or an object with a `rules` array):

```json
[
  {
    "package": "@angular/flex-layout",
    "status": "deprecated",
    "lastReleaseFor": 15,
    "category": "layout",
    "recommendation": "alternate",
    "alternatives": ["CSS flexbox/grid", "Tailwind CSS"],
    "notes": "No releases past Angular 15. Migrate to native CSS flexbox/grid or modern utility frameworks."
  }
]
```

### Fields

| Field | Type | Description |
|---|---|---|
| `package` | `string` | The exact npm package name (required). |
| `status` | `'deprecated' \| 'abandoned' \| 'maintained'` | Maintenance status of the package. |
| `lastReleaseFor` | `number` | The final Angular major version for which this package published a dedicated release (e.g. `15`). Flags the package as unmaintained without overriding peer-range evidence. |
| `category` | `string` | Domain category: `'layout'`, `'ui'`, `'utility'`, `'tooling'`, `'auth'`, `'crypto'`, `'sdk'`, etc. |
| `recommendation` | `'upgrade' \| 'alternate' \| 'fork' \| 'inline' \| 'manual'` | Recommended action from the resolution ladder. |
| `alternatives` | `string[]` | Ordered list of alternate packages, tooling migrations, or architectural replacements. |
| `fork` | `string` | Recommended community fork supporting modern Angular versions. |
| `notes` | `string` | Context and guidance displayed in step documents. |

---

## Configuring Custom Rules

### 1. In `ng-migrator.config.json`

Add paths to your rule files in `rules`:

```json
{
  "rules": ["./custom-migration-rules.json"]
}
```

### 2. Via CLI Flag

Pass rule files directly when planning:

```bash
npx ng-migrator plan --to 19 --rules ./team-rules.json ./company-rules.json
```

---

## Examples

### 1. Simple Utility to Inline

For small utilities with simple logic (like clipboard or tooltip directives), recommend inlining:

```json
{
  "package": "ngx-clipboard",
  "status": "abandoned",
  "lastReleaseFor": 15,
  "category": "utility",
  "recommendation": "inline",
  "notes": "Replace with Angular CDK Clipboard (CdkCopyToClipboard) or navigator.clipboard in a small custom directive."
}
```

### 2. Dev-Only Tooling Migration

For deprecated build/lint tooling (such as `codelyzer`), use `category: "tooling"` so the recommendation is described as a tooling migration rather than a runtime package swap:

```json
{
  "package": "codelyzer",
  "status": "deprecated",
  "lastReleaseFor": 12,
  "category": "tooling",
  "recommendation": "alternate",
  "alternatives": ["TSLint to ESLint via @angular-eslint", "eslint"],
  "notes": "Codelyzer is a dev-only TSLint rule package with no releases past Angular 12; perform a tooling migration from TSLint to ESLint via @angular-eslint."
}
```
