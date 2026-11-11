/** Shared data model (plan section 6). */

import type { PackageManager } from './config/config.js';

export type WorkspaceType = 'single' | 'nx' | 'angular-multi';
export type ProjectStyle = 'standalone' | 'ngmodule' | 'mixed' | 'unknown';
export type DependencyType = 'dependencies' | 'devDependencies';

export interface DependencyInfo {
  name: string;
  /** Range as written in package.json. */
  declared: string;
  /** Version actually installed (node_modules, else lockfile). */
  installed?: string;
  type: DependencyType;
}

export interface ProjectInfo {
  root: string;
  name?: string;
  angular: { declared?: string; installed?: string; version?: string; major?: number };
  packageManager: { name: PackageManager; source: 'packageManager field' | 'lockfile' | 'default'; lockfile?: string };
  workspace: WorkspaceType;
  angularProjects: string[];
  style: ProjectStyle;
  /** Sorted by name. */
  dependencies: DependencyInfo[];
  /** Packages that already have overrides or resolutions entries. */
  overrides: string[];
  /** Installed Angular libraries that still ship View Engine metadata (need ngcc, removed in 16). */
  viewEngineSuspects: string[];
  /** package.json scripts that run ngcc. */
  ngccScripts: string[];
  hasNodeModules: boolean;
  hasNpmWorkspaces: boolean;
  /** Platform-independent warnings, sorted. */
  warnings: string[];
}

export interface StepRequirements {
  major: number;
  /** Latest release of @angular/core in this major. */
  coreVersion: string;
  node?: string;
  typescript?: string;
  rxjs?: string;
  zone?: string;
  notes: string[];
}

export interface PackageChange {
  name: string;
  type: DependencyType;
  /** Installed version, or the lowest version of the declared range. */
  current?: string;
  currentSpec: string;
  target: string;
  /** New package.json value, keeping the user's range style. */
  targetSpec: string;
  reason: string;
  evidence: 'declared' | 'verified';
  /** Set when the chosen release is deprecated on the registry. */
  deprecated?: string;
}

export interface HeldBack {
  name: string;
  version: string;
  reason: string;
}

export type BlockerReason = 'no-compatible-version' | 'deprecated' | 'peer-conflict' | 'ivy-or-ngcc' | 'unknown';

export interface Blocker {
  package: string;
  reason: BlockerReason;
  /** Hard blockers stop the step until resolved. */
  hard: boolean;
  details: string;
  current?: string;
  /** Newest release that supported the previous major, if known. */
  lastCompatible?: string;
  recommendation?: 'upgrade' | 'alternate' | 'fork' | 'inline' | 'manual';
  confidence?: 'high' | 'medium' | 'low';
  effort?: string;
  runnerUp?: string;
}

export interface PeerConflict {
  /** Package whose peer requirement failed, e.g. "ngx-foo@3.1.0". */
  requiredBy: string;
  peer: string;
  range: string;
  found?: string;
}

export interface ResolutionCheck {
  status: 'confirmed' | 'conflict' | 'skipped' | 'failed';
  detail?: string;
  conflicts?: PeerConflict[];
}

export interface PlannedStep {
  index: number;
  from: number;
  to: number;
  provisional: boolean;
  requirements: StepRequirements;
  /** Same-major update to run first, e.g. "15.2.10" when 15.0.0 is installed. */
  samePatch?: string;
  changes: PackageChange[];
  unchanged: string[];
  heldBack: HeldBack[];
  blockers: Blocker[];
  resolution: ResolutionCheck;
  actions: string[];
  risks: string[];
  breakingChangesUrl: string;
}

export interface Plan {
  startVersion: string;
  fromMajor: number;
  targetMajor: number;
  steps: PlannedStep[];
}

