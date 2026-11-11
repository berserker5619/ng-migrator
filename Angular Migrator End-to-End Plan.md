# Angular Migrator: End-to-End Plan

Name: **ng-migrator** (chosen in step 0 on 2026-11-09; free on npm, reservation pending, see section 15). A CLI that plans and performs Angular upgrades one major version at a time (always n-1 to n), together with the dependencies, and leaves every change uncommitted for the user to review.

## 1. Summary

The tool upgrades an Angular project one major version at a time, always from n-1 to n, and writes a Markdown document for every step so the user can review it. It recommends the best fix for every dependency that blocks an upgrade, and it never commits anything: the user reviews the changes and decides what to commit.

**Problem.** `ng update` upgrades Angular and packages that ship schematics, but it does not plan around third-party dependencies: peer-dependency conflicts, libraries with no release for the target version, abandoned packages, and replacements for deprecated ones. Teams discover these one failure at a time.

**What the tool does.** It analyzes the project, plans every step, flags each blocker with a recommended fix (upgrade, alternate package, fork, or small code written inside the project), and, from 1.1, executes one approved step at a time with a snapshot for rollback.

**What makes it different.** It answers one question existing tools answer poorly: what will block this upgrade, and what is the best fix for each blocker? It orchestrates `ng update` instead of competing with it.

**Non-goals**

- AngularJS to Angular migration, and non-Angular frameworks
- Rewriting application logic or fixing a project's failing business tests
- Skipping versions, or migrating several versions in one run
- Committing, pushing or otherwise managing version control for the user

## 2. Core rules

These rules apply to every later section. If another section seems to conflict with one of them, the rule wins.

1. **Always n-1 to n.** One major per run. No skipping, no ranges, no chained runs without a review in between.
2. **Plan first, change second.** Every run can end at a report with no changes to the project.
3. **The tool never commits.** It makes no git writes at all. The user reviews the changes and decides whether and when to commit.
4. **Review through a Markdown document per step.** Approval happens only through the `approve` command, never by editing a file.
5. **Dependencies stay within the step.** Packages move only to versions that support the step's target n.
6. **Verified, not assumed.** Every compatibility claim is labeled declared compatible or verified by build, and the package manager confirms resolution.
7. **Honest about gaps.** If no compatible version or good alternative exists, the tool says so, with a confidence level, instead of guessing.
8. **Reversible.** Each step saves a snapshot, so exactly that step can be undone.
9. **Public code only for testing.** No employer or client application is used for tests, calibration or examples.
10. **Same behavior everywhere.** macOS, Windows and Linux produce identical plans and reports.

## 3. Scope and releases

| Release | Contents |
| --- | --- |
| 1.0 (about 6 to 7 weeks) | `doctor`, `analyze`, `plan`, `status`, `approve`; step documents and `summary.md` that act as the runbook; blocker analysis and the recommendation engine; declared vs verified labels; the test corpus |
| 1.1 | Executor: `migrate --next`, `resume`, `rollback`, snapshots, verification (build, lint, test); per-step Node command prefix |
| 1.2 | Codemods for third-party swaps, Angular Material, config and Sass changes; monorepo and Nx support |
| 1.3 | Alternate-swap codemods and template-based in-house shim generation |

**Out of scope for now:** private registry authentication beyond respecting the project's `.npmrc` (the tool fails gracefully on a 401 and says why), and Angular variants such as Ionic or SSR-specific migrations (detected and reported, not transformed).

## 4. User experience

```
npx ng-migrator doctor                 # check the machine and project before starting
npx ng-migrator analyze                # what the project has and what blocks it
npx ng-migrator plan --to 19           # writes one document per step, changes nothing
npx ng-migrator status                 # which steps are planned, approved, done or failed
npx ng-migrator approve 3              # approve step 3 after reading its document
npx ng-migrator migrate --next         # run the next approved step, n-1 to n only (1.1)
npx ng-migrator resume                 # finish a failed step after a fix (1.1)
npx ng-migrator rollback --step 3      # restore the files from step 3's snapshot (1.1)
```

The package and command name `ng-migrator` was settled in step 0 (section 15).

**Typical session**

1. Run `doctor`, fix anything it reports, and start from a clean working tree.
2. Run `plan --to 19` and read `summary.md` and the first step document.
3. Settle open decisions, then `approve 1`.
4. Run `migrate --next` (1.1) or follow the document by hand (1.0).
5. Review the diff and the updated step document.
6. Commit if satisfied. This is entirely the user's choice.
7. Approve the next step and repeat.

**Flags**

| Flag | Meaning |
| --- | --- |
| `--to <version>` | Final target for `plan` only; execution commands never take a range |
| `--dry-run` | Show what a command would do without writing |
| `--package-manager <name>` | Override detection (npm, yarn or pnpm) |
| `--report <path>` | Write the Markdown/JSON report elsewhere |
| `--rules <path>` | Add project or team rules (section 10) |
| `--allow-dirty` | Run with uncommitted changes in the tree; the report notes it |
| `--yes` | Answers confirmation prompts only; never approves a step or runs more than one |
| `--no-color`, `--ascii` | Plain output for older terminals and CI logs |

## 5. Step documents

Every step gets a Markdown document that explains what will happen and, after the run, what did happen. The documents are the review surface and, in 1.0, the runbook.

### 5.1 Location

```
.ng-migrator/
  state.json                  # machine state: statuses, approvals, snapshot ids
  summary.md                  # overview of all steps and their status
  steps/
    01-angular-13-to-14.md
    02-angular-14-to-15.md
    ...
  snapshots/                  # working files for rollback (1.1); suggested for .gitignore
```

The documents are UTF-8 with LF line endings and use project-relative paths with forward slashes, so they read the same on every operating system. File names start with a zero-padded step number so they sort in order. The tool creates these files but never commits or git-ignores them; that is the user's decision.

### 5.2 Contents

Before the step runs:

| Section | Content |
| --- | --- |
| Header | Step number, from and to versions, status, generated date, tool version |
| Requirements | Node, TypeScript, RxJS and zone.js for this step, and what the user's machine has now |
| Dependency changes | Each package: current, target, reason, declared compatible or verified by build; newer releases held back because they need a later step; plus a manifest diff preview of the exact package.json changes, keeping the user's existing range style (caret, tilde or exact) |
| Blockers | Each blocker with the recommended fix, confidence, reasoning, effort estimate and runner-up |
| Breaking changes | Angular's breaking changes for this step that apply to this project, with files affected |
| Planned actions | Ordered commands (schematics, installs, codemods) and manual tasks |
| Risks and rollback | What could go wrong and the rollback command |
| Decisions needed | Open questions as a checklist; `approve` warns if any are open |
| Approval | Status set only by the `approve` command, plus optional reviewer notes |

After the step runs:

| Section | Content |
| --- | --- |
| Outcome | Success, failed or partly done, with timing |
| Changes made | Files changed, created and deleted; packages added, removed and upgraded; codemods applied with counts |
| Verification | Build, lint and test results, with failing output if any |
| Deviations | Anything that differed from the plan, and why |
| Manual follow-ups | Tasks the tool could not do, with file and line references |
| Snapshot | Snapshot id for rollback |

### 5.3 Sample

```markdown
# Step 3: Angular 15 to 16

Status: planned | Generated: 2026-11-08 | Tool: 1.0.0

## Requirements
- Node: 16.14+ or 18.10+ (this machine: 18.19, OK)
- TypeScript: 4.9.3 to 5.1
- RxJS: 6.5 or 7.4+
- zone.js: 0.13+

## Manifest changes (package.json preview)
- "@angular/core": "^15.2.10"
+ "@angular/core": "^16.2.12"
- "rxjs": "^7.5.0"
+ "rxjs": "^7.8.1"

## Dependency changes
| Package | Current | Target | Reason | Status |
|---|---|---|---|---|
| @angular/core | 15.2.10 | 16.2.12 | Step target | verified by build |
| ngx-example-lib | 3.1.0 | 4.0.1 | Peer range now includes Angular 16 | declared compatible |

## Blockers
### some-tooltip-lib (no release supports Angular 16)
- Recommendation: write it in the codebase (confidence: high)
- Why: 1 directive used, 3 inputs, CDK overlay already installed
- Effort: about 4 files, 2 to 3 hours
- Runner-up: alternate package (confidence: medium)

## Planned actions
1. Update Angular packages with ng update
2. Remove the ngcc postinstall step
3. Replace some-tooltip-lib (see blocker)

## Rollback
npx ng-migrator rollback --step 3

## Decisions needed
- [ ] Accept the tooltip recommendation or choose the alternate

## Approval
Status: pending. Run: npx ng-migrator approve 3
```

### 5.4 Rules for the documents

- **Plan before change.** All documents exist before step 1 starts so the user sees the whole journey; later steps are marked provisional because earlier steps can change what is possible.
- **Re-plan after each step.** The next documents are regenerated against the real project state, and the tool shows what changed in the plan.
- **User input is kept.** Ticked decisions and reviewer notes survive regeneration.
- **Stop on failure.** A failed step keeps its document in failed state with logs.
- **Machine readable too.** The same data is in `state.json` for CI and other tools.
- **No secrets or private paths.** Only project-relative paths and package names; never tokens, registry credentials or home directories.

## 6. Architecture

One npm package with folders inside. Split into separate `core` and `cli` packages only when something else needs to import the core.

```
src/
  cli/          commands and output
  reader/       project reader: manifests, lockfile, angular.json, tsconfig
  registry/     npm metadata client with a cache
  resolver/     candidate versions and package-manager verification
  planner/      step list and per-step requirements
  recommend/    signals, scoring, alternates, shim templates
  steps/        step document and summary generation
  platform/     paths, process execution, line endings, safe file writes
  rules/        built-in rules (JSON)
  exec/         executor and snapshotter (1.1)
  codemods/     third-party swaps, Material, config (1.2 and later)
```

| Module | Responsibility |
| --- | --- |
| Project Reader | Parse manifests; detect package manager, workspace type (single, Nx, Angular multi-project) and standalone vs NgModule style; warn about case-only import mismatches and long paths |
| Registry Client | Fetch package metadata and peer ranges per version with caching and an offline mode |
| Resolver | Propose candidate versions for a step and confirm them with the package manager |
| Planner | Build the ordered n-1 to n steps and their requirements |
| Recommendation Engine | Gather signals for each blocker and recommend the fix |
| Step Writer | Generate and regenerate the step documents and summary |
| Platform Layer | Cross-platform paths, `execa`-based process calls, line-ending-preserving file writer, retrying deletes, atomic writes |
| Executor and Snapshotter (1.1) | Run one step and save and restore snapshots |

**Stack.** Node 22.12+, TypeScript 6.0, `commander`, `semver`, `pacote`, `execa`, `vitest`, `tsup`, ESLint with `typescript-eslint`. (Raised from Node 18+ in phase 0: Node 18 and 20 are end-of-life, and current releases of `commander`, `execa`, `vitest`, `tsup` and changesets require Node 22. TypeScript stays on 6.0 until `typescript-eslint` supports 7.) Code analysis uses parsers bundled with the tool (the TypeScript compiler API, `ts-morph` from 1.2, and a bundled Angular template parser), so the tool never loads a project's own compilers into its process. The tool's own dependencies are pure JavaScript, with no native addons.

**Data model**

```ts
interface ProjectSnapshot {
  angularVersion: string;
  node: string;
  packageManager: 'npm' | 'yarn' | 'pnpm';
  workspace: 'single' | 'nx' | 'angular-multi';
  style: 'standalone' | 'ngmodule' | 'mixed';
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface UpgradeStep {
  from: number;                 // major n-1
  to: number;                   // major n, always from + 1
  status: 'planned' | 'approved' | 'done' | 'failed' | 'rolled-back';
  requirements: { node: string; typescript: string; rxjs: string; zone: string };
  packages: Record<string, { version: string; evidence: 'declared' | 'verified' }>;
  heldBack: Record<string, string>;   // newer releases that need a later step
  blockers: Blocker[];
  snapshotId?: string;
}

interface Blocker {
  package: string;
  reason: 'no-compatible-version' | 'deprecated' | 'peer-conflict' | 'ivy-or-ngcc' | 'unknown';
  recommendation: 'upgrade' | 'alternate' | 'fork' | 'inline' | 'manual';
  confidence: 'high' | 'medium' | 'low';
  effort: string;
  runnerUp?: string;
}
```

## 7. How planning works

### 7.1 Analysis

The reader collects the current Angular version and the installed (not just declared) versions; the package manager and lockfile; the workspace type; the project style (standalone, NgModule or mixed); every dependency with its declared range; and platform warnings such as case-only import mismatches, very long paths and a running dev server. Nothing is changed.

### 7.2 Requirements come from published metadata

For each target major, the tool reads Node engine ranges and peer dependencies from the published `@angular/core` and `@angular/cli` packages (TypeScript, RxJS and zone.js ranges). A small hardcoded file holds only exceptions and known quirks, so the tool does not go stale every six months.

### 7.3 Resolving dependencies for one step

1. Set the step's required core versions for n (the latest release of major n).
2. For every other dependency, list published versions newest first and read each version's peer dependencies.
3. Propose the newest version whose peers include n and fit the chosen core set. A release that supports only n+1 is held back and reported as a later-step candidate.
4. Ask the package manager to confirm the proposed set (a lockfile-only install for npm, and the equivalents for pnpm and yarn). This runs in a temporary directory holding copies of the manifest, lockfile and .npmrc, never in the project itself, so planning cannot change the project's lockfile and an interrupted run leaves nothing behind. The tool does not reimplement dependency resolution: it proposes, and the package manager decides.
5. Label each result **declared compatible** (peer ranges say so) or **verified by build** (the step's build passed, from 1.1).
6. Anything unresolved becomes a blocker for the recommendation engine (section 8). A peer-dependency failure (ERESOLVE in npm 7 and later) is parsed into a blocker that names the conflicting packages and ranges, and the step document offers two options: swap the package through the resolution ladder, or add an explicit override (overrides in npm, resolutions in yarn, pnpm.overrides in pnpm), which is recorded in the report.

### 7.4 Planning the path

- Compute the majors between the current and target version; each is one step, n-1 to n. Steps are never merged or skipped, even when a step looks trivial.
- If the project is not on the latest patch of its current major, the first step document starts with a same-major `ng update` task.
- Dependencies are resolved per step, because some libraries have no release spanning both ends.
- Later steps are provisional and are regenerated after each completed step.

### 7.5 Preconditions before a step runs

1. The step document exists and was approved with `approve`.
2. The installed `@angular/core` is really version n-1; otherwise the tool refuses and asks to re-plan.
3. The previous step is done, or the user explicitly acknowledges it was handled by hand.
4. The working tree is clean, or `--allow-dirty` was given.
5. The active Node version matches what the step requires; otherwise the tool stops and names the version to switch to.

## 8. Blockers and the recommendation engine

The tool does not rely on a list of specific packages. For each blocker it analyzes the situation and recommends the most probable fix. Specific rules (section 10) are optional overrides.

### 8.1 Signals

| Group | Signals |
| --- | --- |
| Usage footprint (from the project) | Which exports are imported; files, call sites and template usages; inputs, outputs and options actually used versus the full API; one feature or app-wide |
| Package complexity (from the package) | Source size and file count; transitive dependencies; public surface; reliance on hard problems (complex positioning, rich text, charts, date math, drag and drop, browser APIs); mostly presentational or stateful |
| Alternate candidates (from the registry) | Supports the target version; last publish and maintenance activity; downloads; API similarity; bundle size; license |
| Project context | Standalone or NgModule; UI libraries already present (for example Angular Material and CDK); how critical the feature is |

### 8.2 Resolution ladder

For every blocked package, options are tried in this order and scored:

1. **Upgrade** to a release that supports n.
2. **Alternate package** that covers the same need, ranked by maintenance, Angular support and API similarity.
3. **Maintained fork** that supports n.
4. **Write it in the codebase** when the footprint is small and the logic is simple.
5. **Manual**, flagged as a hard blocker with notes.

| Situation | Recommendation |
| --- | --- |
| A maintained release supports n | Upgrade |
| Small footprint, low complexity, and an existing primitive (for example CDK) covers the hard part | Write it in the codebase |
| Wide usage or complex logic, and a healthy alternate with a similar API exists | Alternate package |
| Wide usage, complex logic, no healthy alternate, a maintained fork exists | Fork |
| Nothing fits | Manual |

Every recommendation carries a confidence level, the reasoning, an effort estimate, and the runner-up when the call is close. A human always makes the final decision.

### 8.3 Reference example: a tooltip package

A tooltip package is the textbook case for writing it in the codebase: usually one directive with a few inputs, simple logic, and positioning that Angular CDK overlay already solves. The engine recommends a local directive that keeps the same selector and inputs, so templates do not change. This matches what was done by hand in the manual migration.

### 8.4 Generating an in-house replacement (1.3)

1. A compatibility shim in the project exposing the same selector, inputs and outputs the project already uses
2. The import rewrite to the local implementation
3. A usage report: the API subset covered and any option in use that the shim does not implement
4. Tests generated from the observed usages
5. Removal of the old package only after build and tests pass, left uncommitted like everything else

Shims are generated from observed usage and templates for common small packages (tooltip, click-outside, debounce, copy-to-clipboard), never by copying a package's source, which avoids license problems. AI-assisted generation for other packages is a later option, always behind human review.

### 8.5 Supply-chain safeguards

- The tool never installs a recommended alternate on its own; the user chooses.
- Alternates are shown with license, last publish date and maintainer activity.
- `--ignore-scripts` is supported for installs.

## 9. Executing a step (1.1)

1. Check the preconditions (7.5).
2. Save the snapshot: the original of every file the step will touch (manifest, lockfile, `angular.json`, `tsconfig` files, and each source file a codemod will modify).
3. Write the step's resolved versions to the manifest and install, using `--ignore-scripts` if requested.
4. Run `ng update` for Angular's own packages and for packages that ship schematics.
5. Run the step's codemods (1.2 and later).
6. Build, lint and test.
7. Record the files created, changed and deleted, update the step document, and refresh the next step's document.
8. Stop. Print one message: review the diff and the document, commit if satisfied, then approve and run the next step.

**On failure** the project stays in its partial state and the step is marked failed. The user either fixes the problem and runs `resume` to finish the same n-1 to n step, or runs `rollback --step <n>`. The tool never advances on its own or jumps ahead.

**Rollback** restores the original files from the snapshot, removes files the step created, and tells the user to reinstall dependencies (`node_modules` is not snapshotted). It refuses if the user edited an affected file after the step, and shows which files differ, so nothing is overwritten silently.

**Node versions.** Old Angular CLIs need old Node and new ones need new Node, and the tool itself needs Node 22.12 or newer, so for an old project the tool cannot simply run under the Node the project needs. Planning (1.0) only reads manifests and registry metadata, so the tool's own Node is enough. For execution (1.1), `doctor` shows the exact Node version each step requires, and the `commandPrefix` setting (section 19.1) runs the step's subprocesses (`ng update`, install, build, test) under that Node while the tool itself stays on a modern one. The tool never switches the user's Node itself, and it stops with a clear message if the subprocess Node does not match the step.

**Speed.** Registry metadata and resolution results are cached, and each step report includes timing so slow steps are visible.

## 10. Rules and codemods

Rules are optional overrides on top of the recommendation engine, in JSON so the community can contribute them:

```json
{
  "package": "@angular/flex-layout",
  "status": "deprecated",
  "appliesFrom": 15,
  "category": "layout",
  "alternatives": ["CSS flexbox/grid", "Tailwind"],
  "notes": "No releases past Angular 15"
}
```

Rules may also carry `fork`, `inlineTemplate` and a `category` (for example auth, crypto or SDK) so sensitive libraries are verified first and flagged for manual regression testing.

**Codemod categories (1.2 and later):** configuration (`angular.json` builders, `tsconfig` options), TypeScript API changes for third-party swaps, templates, Sass and Material theme updates, and structural migrations such as NgModule to standalone.

- Codemods only cover what `ng update` does not: third-party swaps, shims and gaps. They never duplicate Angular's own schematics.
- They parse with the tool's bundled parsers and use the project's own tools only through subprocesses (for example `npx ng ...`), never by loading project packages into the tool's process, which avoids CommonJS and ESM interop problems with old Angular versions.
- Each codemod is idempotent, has before-and-after fixtures, and reports the files it changed.

## 11. Lessons from the manual migration (Angular 13 to 20+)

These problems came up in the manual migration. Each is now a feature of the tool.

| # | Challenge faced manually | What the tool does about it |
| --- | --- | --- |
| 1 | Libraries with no release for the next version, or abandoned | Registry scan flags the last compatible version, last publish date and deprecation; the engine recommends a fix |
| 2 | Packages built for View Engine that relied on ngcc, which was removed in Angular 16 | Early scan for packages without Ivy or partial-compilation metadata; listed first in `analyze` as hard blockers |
| 3 | Peer-dependency conflicts forcing `--legacy-peer-deps` or `overrides` | The resolver explains the exact conflicting ranges and proposes the correct version first; an `overrides` entry is a last resort and is recorded in the report |
| 4 | Node, TypeScript, RxJS and zone.js requirements shifting every major | Per-step requirements read from published metadata; Node version checked before each step |
| 5 | Angular Material and CDK theming and API breaks | Material codemods per major (1.2) |
| 6 | Builder, `angular.json` and `tsconfig` changes | Config codemods per step (1.2) |
| 7 | Several packages lost support, so alternates were needed | The resolution ladder: alternate, fork or in-house, scored and explained |
| 8 | One package (a tooltip library) was rewritten inside the project | Usage analysis plus the shim generator (8.3, 8.4) |
| 9 | Auth, encryption and SDK libraries with their own version limits | Rule categories verify these first and flag them for manual regression testing |

**Still to capture:** for each package that caused trouble, record the package name, the version where it broke, what fixed it, and the time it cost. Only public facts about the packages are used, never company code or project details.

## 12. Safety

### 12.1 No commits

The tool makes no git writes: no `add`, `commit`, `push`, `stash`, `checkout`, `reset`, `revert` or `tag`, and it never edits `.gitignore` or git config. It reads git only for status and the current commit hash (to warn about a dirty tree and note the starting point in the report). It works in projects that are not in a git repository.

| Consequence | Mitigation |
| --- | --- |
| No automatic history of each step | Each step document lists every change; `status` reminds the user to commit between steps if they want history |
| Rollback depends on the tool's snapshot folder | The tool warns before deleting anything under `.ng-migrator`, and `rollback` reports clearly when a snapshot is missing |
| User edits mixed with the tool's changes | A clean tree is required at the start; rollback refuses to overwrite files edited after the step |
| Larger diffs if the user does not commit between steps | Each document lists its own changes, so review stays per step |

### 12.2 Other safeguards

- Atomic writes: write to a temporary file in the same directory, then rename with retry; never leave a half-written manifest.
- Respect existing `overrides` and `resolutions`; warn when adding new ones.
- Planning never touches the project's lockfile: resolution checks run in a temporary directory with copies of the manifest, lockfile and .npmrc. During execution (1.1), lockfiles are regenerated by the package manager, never edited by hand, and are included in the step's snapshot.
- Network failures resume from the cache.
- Monorepos: detect every Angular project, upgrade shared libraries first, then apps (1.2).
- Private registries: respect `.npmrc`, and fail gracefully on a 401 with a clear message.

## 13. Cross-platform: macOS, Windows and Linux

| Area | Rule |
| --- | --- |
| Paths | Always `node:path`; reports store project-relative POSIX-style paths |
| Running commands | `execa` or `cross-spawn` with argument arrays, so Windows `.cmd` shims for `npm`, `ng` and `npx` work; resolve binaries through `node_modules/.bin` |
| Shell scripts | None; everything is pure Node |
| Line endings | Detect each file's line ending and preserve it on write; respect `.gitattributes`; never rewrite untouched files |
| Encoding | UTF-8, preserve a BOM if present |
| Case sensitivity | Report import paths that differ only by case (they break on Linux CI) |
| Long paths | Warn about the 260 character limit on Windows |
| File locking | Retry with backoff on `EBUSY`, `EPERM` and `ENOTEMPTY`; check for a running dev server first |
| Symlinks | Detect failures with pnpm or workspaces on Windows and explain the fix; never create symlinks |
| Node managers | Detect the active Node version only; never switch it |
| Native modules | None in the tool's own dependencies |
| Output | Graceful colors and Unicode; `--no-color` and `--ascii` |
| Ordering | Sort file lists explicitly so plans and diffs are identical everywhere |

`doctor` checks Node, package manager, git, long-path setting, symlink ability, line-ending configuration and running dev servers, and says what to fix on the current OS.

## 14. Testing

### 14.1 Test corpus: open-source projects from GitHub

The tool is tested on public code only: open-source projects and synthetic fixtures. No employer or client application is used.

| Criterion | Why |
| --- | --- |
| Permissive license (MIT, Apache-2.0, BSD) | Safe to fork, run in CI and show in reports |
| A spread of Angular versions (for example 12 to 17) | Exercises different paths, including the ngcc removal in 16 |
| Real dependency mix: Material, NgRx, a tooltip or dropdown library, charts, auth | Produces realistic blockers and replacement decisions |
| Builds and tests pass at the starting version | A failing baseline makes results ambiguous |
| NgModule, standalone and mixed projects | Covers structural variants |
| A few with abandoned packages | The cases the recommendation engine exists for |

Angular's own sample apps and the community RealWorld Angular example app are candidates; check each one's license, version and build status before adopting it. Each project is pinned to an exact commit with a recorded baseline (starting version, expected blockers, expected recommendation per blocker). A `corpus/README` lists every project, its license and its commit; upstream code is never copied into the tool.

### 14.2 Tiers

- **Synthetic fixtures:** tiny hand-built projects, each with one deliberate problem (an abandoned package, a View Engine-era package, a peer conflict, a tooltip package that is cheap to inline). They run on every commit on macOS, Windows and Linux.
- **Corpus projects:** run nightly, because installs and builds are slow.
- **Variants:** fixtures with CRLF and LF line endings prove they are preserved byte for byte, plus a project path containing spaces.

### 14.3 What is checked

1. `analyze` finds the expected blockers and nothing spurious.
2. `plan` produces valid n-1 to n steps, and each step's resolved set passes the package manager's own check.
3. Recommendations and confidence match the recorded expectation, or show the runner-up where the call is close.
4. Step documents are generated, correctly ordered and stable on a second run, and planning leaves every file in the project, lockfile included, unchanged except under .ng-migrator.
5. `migrate` (1.1) refuses a range, a skip, an unapproved step, a project not at n-1, and a missing previous step; it runs exactly one step and stops.
6. The tool spawns no git command other than read-only ones (a spy on the process helper).
7. Rollback restores manifests, lockfiles, codemod edits, created and deleted files, and refuses after a user edit.
8. Results are identical on all three operating systems after path normalization, and a second run changes nothing.

## 15. Roadmap

**Step 0: choose and verify the package name (before any scaffolding).** Renaming a scaffolded package, repo and CLI is costly, and npm may reject a name later.

1. Shortlist: `ng-migrator` (the working name), `angular-upgrade-planner`, `ng-upgrade-plan`, `angular-upgrade-path`, and a scoped option such as `@<your-npm-username>/ng-migrator`, which is always available.
2. Check each name on npm: `npm view <name>` (an E404 means free), the hyphen-free form (npm rejects names that differ only by punctuation), and `npm search <name>`.
3. Know what exists: `ngmigrate` (a template migration proof of concept) and `ngma` (an AngularJS migration assistant) are not conflicts, but avoid names within one character of them.
4. Check the CLI command name against other common global commands on macOS and Windows.
5. Check the GitHub repository name, and a docs domain if wanted.
6. Record the chosen name here, replacing the working name.
7. Reserve it: create the repository and publish a `0.0.1` placeholder, or set up trusted publishing early.

Exit criteria: package, command and repository names are confirmed free, recorded and reserved.

**Step 0 results (checked 2026-11-09)**

| Name | npm | Hyphen-free form | GitHub repo with exact name |
| --- | --- | --- | --- |
| `ng-migrator` | Free | `ngmigrator` free | One unrelated personal repo (1 star); no conflict under our own account |
| `angular-upgrade-planner` | Free | Free | None |
| `ng-upgrade-plan` | Free | Free | None |
| `angular-upgrade-path` | Free | Free | None |
| `ng-migrate` (extra check) | Free, but unpublishable | `ngmigrate` taken | Not checked |

- Existing similar packages: `ngmigrate` (0.0.4, last published 2022-06) and `ngma` (1.0.6, last published 2022-05). Neither conflicts; `ng-migrator` is two characters away from `ngmigrate`.
- npm search for the shortlisted names found nothing in the Angular upgrade space.
- CLI command `ng-migrator` collides with nothing on Windows; macOS still to check.
- **Chosen:** `ng-migrator` (package, command and repository).
- **Repository:** private GitHub repository `berserker5619/ng-migrator` (created 2026-11-11; made public before 1.0).
- **Still open:** reserve the npm name by publishing an early `0.0.x` of the main package (the separate placeholder folder was dropped); check the command name on macOS.

**Version 1.0 (about 6 to 7 weeks)**

| Phase | Weeks | Deliverables |
| --- | --- | --- |
| 0. Foundations | 1 | Single package, three-OS CI matrix, platform helpers (paths, process, line endings, safe writes) |
| 1. Analyze and plan | 2 to 3 | Project Reader, registry client, metadata reader, resolver with package-manager verification, `analyze`, `plan`, step documents, declared vs verified labels |
| 2. Recommend and runbook | 4 to 5 | Usage and complexity signals, scoring and confidence, alternates ranking, `status`, `approve`, `doctor`, summary and runbook generation |
| 3. Corpus and release | 6 to 7 | Corpus and synthetic fixtures in CI, docs and a rule authoring guide, 1.0 on npm |

**After 1.0:** 1.1 executor with snapshots, `migrate --next`, `resume` and `rollback`; 1.2 codemods, Material and config transforms, monorepo and Nx support; 1.3 alternate-swap codemods and in-house shim generation.

**Documentation:** README with a two-minute quickstart, `docs/rules.md` and `docs/codemods.md`, CONTRIBUTING, and a migration-failed issue template that asks for the report JSON. Semantic versioning with changesets.

## 16. Risks

| Risk | Mitigation |
| --- | --- |
| Angular releases every six months, so data goes stale | Requirements are read from published metadata; a scheduled CI job refreshes the exceptions file |
| Registry peer ranges are wrong or too loose | The package manager confirms resolution; build verification (1.1) upgrades a result from declared to verified |
| Recommendations are wrong for unusual packages | Confidence levels, runner-up shown, human decision, and the corpus to tune scoring |
| Codemods break edge-case code | Idempotent, fixture-tested, run against the project's own compilers, and rolled back per step |
| Overlap with `ng update`, Nx migrate and Renovate | Position as the step before and between `ng update`, and call it rather than replace it |
| Without commits, history and rollback depend on the user and the snapshot folder | Step documents, `status` reminders and clear missing-snapshot errors |
| Supply-chain risk from recommending packages | Never auto-install, show license and publish date, support `--ignore-scripts` |
| Scope creep | Ship 1.0 alone as a useful release |

## 17. Success criteria for 1.0

1. On every corpus project, `analyze` finds the expected blockers with no spurious ones.
2. Every planned step's resolved versions install without peer errors under the package manager's own check.
3. Recommendations match the recorded expectation for the corpus, or show the runner-up where the call is close.
4. Reports and step documents are identical on macOS, Windows and Linux after path normalization.
5. A user can follow a generated runbook, using `ng update` and the stated Node versions, to reach a green build on a corpus project without extra research.

## 18. Decisions log and next actions

| Decision | Outcome |
| --- | --- |
| Step size | Always n-1 to n, one step per run, never skipped |
| Version control | The tool never commits; the user reviews and decides |
| Approval | CLI command only (`approve <step>`) |
| Node handling | Detect and instruct; never switch the user's Node; 1.1 runs subprocesses through a configurable command prefix |
| Resolver | The package manager is the oracle; the tool proposes candidates |
| 1.0 scope | Analyze, plan, recommend, step documents and runbook; executor in 1.1 |
| Positioning | Orchestrate `ng update`, do not compete |
| Version matrix | Read from published metadata; small exceptions file |
| Alternates | Never auto-installed; templates for in-house shims, written from observed usage |
| Repo shape | Single package with folders |
| Testing | Open-source projects and synthetic fixtures only |
| Platforms | macOS, Windows and Linux from day one |
| ngcc cliff | Placed at Angular 16, where ngcc was removed |
| Package name | `ng-migrator`, chosen in step 0 (2026-11-09); reservation pending |
| Tool runtime | Node 22.12+ (phase 0); CI on Node 22, 24 and 26; project toolchains run through `commandPrefix` |

**Next actions**

1. Finish step 0: the name `ng-migrator` is chosen and verified and the private repository exists; reserve the npm name by publishing an early `0.0.x` of the main package.
2. Scaffold the single package with the three-OS CI matrix and platform helpers.
3. Build the Project Reader and the metadata reader.
4. Pick the first five corpus projects and write their baseline files.

## 19. Configuration, state and errors

### 19.1 Configuration file

An optional `ng-migrator.config.json` at the project root. Precedence is command-line flags, then the config file, then auto-detection.

```json
{
  "packageManager": "npm",
  "rules": ["./migration-rules.json"],
  "neverTouch": ["some-internal-lib"],
  "pinned": { "rxjs": "7.8.1" },
  "alternates": { "allow": [], "deny": [] },
  "verify": { "build": "npm run build", "lint": "npm run lint", "test": "npm test" },
  "cacheDir": ".ng-migrator/cache"
}
```

| Field | Purpose |
| --- | --- |
| `neverTouch` | Packages the tool must not upgrade, replace or remove; they appear in the plan as fixed constraints |
| `pinned` | Versions the user wants kept; the resolver treats them as constraints and reports any conflict |
| `alternates.allow` / `deny` | Restrict which alternate packages may be recommended (for example a company-approved list) |
| `verify` | The build, lint and test commands to run after each step, so projects with custom scripts work |
| `rules` | Extra rule files, merged over the built-in rules |
| Registry settings | Not duplicated here; the project's own `.npmrc` is respected |

The config file contains no secrets and is safe to commit.

**Command prefix.** `commandPrefix` (optional, global or per step) is prepended to the subprocesses the executor starts, for example `fnm exec --using 16 --` or `volta run --node 16`, so each step runs under the Node version it needs. A per-step map such as `{ "14": "fnm exec --using 14 --" }` is also accepted; keys are the step's target major n (here the 13 to 14 step). `nvm exec` is not suggested because nvm is a shell function on macOS and Linux and a separate program on Windows.

### 19.2 State file

`.ng-migrator/state.json` is the single source of truth for statuses and approvals. The step documents are generated from it, and editing a document never changes it.

- **Contents:** a `schemaVersion`, the tool version, the starting and target versions, and per step: status, approval time, snapshot id, files created, changed and deleted, verification results, and the decisions taken.
- **Schema changes:** the tool migrates older state files forward and refuses to read a newer schema than it knows, with a clear message.
- **Safe writes:** written atomically (temporary file, then rename with retry) so an interrupted run never corrupts it.
- **One run at a time:** a lock file under `.ng-migrator/` prevents two runs from touching the same project; a stale lock (dead process) is detected and reported with how to clear it.
- **Idempotent commands:** `plan`, `analyze`, `status` and `approve` are safe to repeat.

### 19.3 Errors, exit codes and logs

| Exit code | Meaning | Example |
| --- | --- | --- |
| 0 | Success | Plan written, step completed |
| 1 | Unexpected error | A bug; the message asks for the log file |
| 2 | Usage error | A range passed to `migrate`, an unknown flag |
| 3 | Precondition failed | Dirty working tree, project not at n-1, step not approved |
| 4 | Hard blockers found | `analyze --fail-on-blockers` for use in CI |
| 5 | Verification failed | Build, lint or test failed after a step |
| 6 | Environment problem | Wrong Node version, no network, registry 401 |
| 7 | Snapshot or rollback problem | Missing snapshot, file edited after the step |

- Every error has a stable identifier (for example `NGM-3001`), says what happened, why, and what to do next, and is documented in a troubleshooting page.
- `--verbose` prints detail, and every run writes a log to `.ng-migrator/logs/` with registry tokens, credentials and absolute home paths redacted.
- The tool sends no telemetry and makes network requests only to the configured registry.

## 20. Work breakdown for 1.0

Estimates assume one developer working full time; scale them for part-time work. Each task is done only when its acceptance criteria hold on macOS, Windows and Linux.

### Phase 0: Foundations (week 1)

| Task | Acceptance criteria |
| --- | --- |
| Name settled and reserved (step 0) | Package, command and repository names free, recorded, placeholder published |
| Repo, TypeScript, lint, `vitest`, `tsup`, changesets | `npm test` and `npm run build` pass on a clean clone |
| Three-OS CI matrix | A trivial test runs green on Ubuntu, macOS and Windows for Node 22, 24 and 26 |
| Platform layer | Path helpers, `execa` wrapper, line-ending-preserving writer, atomic write, retrying delete, each with tests including CRLF files and a path with spaces |
| Config and state skeleton | Config precedence, state schema with version, lock file, exit codes and error identifiers |

### Phase 1: Analyze and plan (weeks 2 to 3)

| Task | Acceptance criteria |
| --- | --- |
| Project Reader | Reads manifests, lockfile (npm first), `angular.json` and `tsconfig`; reports installed vs declared versions, workspace type and project style on all fixtures |
| Registry client | Fetches version lists and peer ranges, caches them, works offline from cache, fails gracefully on 401 and network errors |
| Metadata reader | Node, TypeScript, RxJS and zone.js requirements for any Angular major derived from published `@angular/core` and `@angular/cli`, plus a small exceptions file |
| Resolver | Proposes the newest versions that fit n, holds back releases needing n+1, confirms with an npm lockfile-only dry run, and labels results declared or verified |
| Planner | Produces strictly n-1 to n steps; refuses skips and ranges; adds the same-major patch task when needed |
| Step writer | Generates step documents and `summary.md`; regeneration preserves reviewer notes and decisions; output is byte-identical on a second run |
| `analyze` and `plan` commands | Run end to end on the synthetic fixtures with the expected output, without writing anything outside `.ng-migrator/` |

### Phase 2: Recommend and runbook (weeks 4 to 5)

| Task | Acceptance criteria |
| --- | --- |
| Usage analysis | For each blocked package, lists imported symbols, files, call sites and template usages, using the tool's bundled TypeScript and template parsers, read-only |
| Complexity signals | Source size, surface area, transitive dependencies and a hard-problem checklist computed from the published package |
| Scoring and recommendation | Reproduces the recorded expectation on every synthetic fixture, with confidence, reasoning, effort and runner-up; weights live in one configuration file |
| Alternates ranking | Ranks candidates by maintenance, Angular support, API similarity, license and bundle size; honors `alternates.allow` and `deny` |
| `status`, `approve`, `doctor` | `approve` records approval in state and warns on open decisions; `doctor` reports every item in section 13 with a fix per OS |
| Runbook | Each step document is complete enough to follow by hand, including the Node version to use and the exact commands |

### Phase 3: Corpus and release (weeks 6 to 7)

| Task | Acceptance criteria |
| --- | --- |
| Synthetic fixtures | At least one fixture per blocker type (abandoned, View Engine-era, peer conflict, inline-able small package, newer release needing n+1) |
| Corpus projects | Five open-source projects pinned and baselined; nightly run green |
| pnpm and yarn parity | The resolver confirmation and reader work on both, covered by fixtures |
| Documentation | README quickstart, troubleshooting page for every error identifier, rule authoring guide |
| Release checklist | License file, `SECURITY.md`, changelog, provenance or trusted publishing, `npm pack` contents checked, install tested on a clean machine on each OS |

## 21. Open questions and proposed defaults

| Question | Proposed default |
| --- | --- |
| Final package and command name | Decided: `ng-migrator` (step 0) |
| Oldest supported starting version | Angular 12; older projects get a clear message to upgrade by hand first |
| License | A permissive license (MIT) |
| pnpm and yarn in 1.0 | npm first in phase 1; pnpm and yarn parity in phase 3 |
| Network use by `plan` | Online by default; `--offline` uses the cache only |
| Usage analysis depth in 1.0 | TypeScript imports and template selectors, read-only; deeper analysis later |
| AI-assisted shim generation | Not in 1.0 or 1.3 by default; revisit after templates prove their limits |
| Telemetry | None |
