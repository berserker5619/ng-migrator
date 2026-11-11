# Rule Authoring Guide

`ng-migrator` includes a recommendation engine that dynamically computes migration strategies for third-party dependencies based on codebase footprint and package complexity.

Rules allow teams and community contributors to provide explicit overrides, recommendations, and guidance for specific packages.

---

## Rule Schema

A rule file is a JSON document containing an array of rule objects (or an object with a `rules` array):

```json
[
  {
    "package": "@angular/flex-layout",
    "status": "deprecated",
    "appliesFrom": 15,
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
| `appliesFrom` | `number` | Angular major version from which this rule applies (e.g. `15`). |
| `category` | `string` | Domain category: `'layout'`, `'ui'`, `'utility'`, `'auth'`, `'crypto'`, `'sdk'`, etc. |
| `recommendation` | `'upgrade' \| 'alternate' \| 'fork' \| 'inline' \| 'manual'` | Recommended action from the resolution ladder. |
| `alternatives` | `string[]` | List of alternate packages or architectural replacements. |
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
  "appliesFrom": 16,
  "category": "utility",
  "recommendation": "inline",
  "notes": "Replace with Angular CDK Clipboard (CdkCopyToClipboard) or navigator.clipboard in a small custom directive."
}
```

### 2. Alternate Package Replacement

For complex dependencies where a healthy community alternative exists:

```json
{
  "package": "ngx-popper",
  "status": "deprecated",
  "appliesFrom": 16,
  "category": "ui",
  "recommendation": "alternate",
  "alternatives": ["@floating-ui/dom", "@angular/cdk/overlay"],
  "notes": "ngx-popper is no longer maintained. Migrate to Floating UI or Angular CDK Overlay."
}
```
