import path from 'node:path';
import { NgmError } from '../errors.js';
import { readJsonIfExists, writeJsonAtomic } from '../platform/fs.js';
import { TOOL_VERSION } from '../version.js';

export const STATE_DIR = '.ng-migrator';
export const STATE_FILE = 'state.json';
export const SCHEMA_VERSION = 1;

export type StepStatus = 'planned' | 'approved' | 'done' | 'failed' | 'rolled-back';

export interface VerificationResult {
  command: string;
  passed: boolean;
  durationMs: number;
}

export interface StepState {
  /** 1-based step number, matching the step document file name. */
  index: number;
  from: number;
  /** Always from + 1. */
  to: number;
  status: StepStatus;
  approvedAt?: string;
  reviewerNotes?: string;
  snapshotId?: string;
  files: { created: string[]; changed: string[]; deleted: string[] };
  verification: VerificationResult[];
  /** Decision id to ticked/unticked, kept across re-planning. */
  decisions: Record<string, boolean>;
}

/** .ng-migrator/state.json: the single source of truth for statuses and approvals (section 19.2). */
export interface MigratorState {
  schemaVersion: number;
  toolVersion: string;
  createdAt: string;
  updatedAt: string;
  startVersion?: string;
  targetMajor?: number;
  /** Commit hash at the start, read-only from git, for the report. */
  startCommit?: string;
  steps: StepState[];
}

export function stateDir(root: string): string {
  return path.join(root, STATE_DIR);
}

export function statePath(root: string): string {
  return path.join(stateDir(root), STATE_FILE);
}

export function createState(now: Date = new Date()): MigratorState {
  const ts = now.toISOString();
  return { schemaVersion: SCHEMA_VERSION, toolVersion: TOOL_VERSION, createdAt: ts, updatedAt: ts, steps: [] };
}

/**
 * Forward migrations, keyed by the version they upgrade from.
 * Add one entry per schema bump: MIGRATIONS[1] turns a v1 object into v2.
 */
const MIGRATIONS: Record<number, (state: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrateState(raw: unknown): MigratorState {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { schemaVersion?: unknown }).schemaVersion !== 'number') {
    throw new NgmError('NGM-3005', `${STATE_DIR}/${STATE_FILE} has no schemaVersion.`, {
      hint: `Delete ${STATE_DIR}/${STATE_FILE} and run "ng-migrator plan" again.`,
    });
  }
  let state = raw as Record<string, unknown>;
  let version = state.schemaVersion as number;
  if (version > SCHEMA_VERSION) {
    throw new NgmError(
      'NGM-3004',
      `${STATE_DIR}/${STATE_FILE} uses schema ${version}, but this ng-migrator (${TOOL_VERSION}) only knows up to ${SCHEMA_VERSION}.`,
      { hint: 'Upgrade ng-migrator to the version that wrote this state.' },
    );
  }
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new NgmError('NGM-3005', `No migration from state schema ${version}.`);
    state = step(state);
    version += 1;
    state.schemaVersion = version;
  }
  return state as unknown as MigratorState;
}

export async function readState(root: string): Promise<MigratorState | undefined> {
  let raw: unknown;
  try {
    raw = await readJsonIfExists(statePath(root));
  } catch (err) {
    throw new NgmError('NGM-3005', `${STATE_DIR}/${STATE_FILE} is not valid JSON.`, {
      cause: err,
      hint: `Restore it from your version control, or delete it and run "ng-migrator plan" again.`,
    });
  }
  return raw === undefined ? undefined : migrateState(raw);
}

/** Write state atomically, stamping the tool version and update time. */
export async function writeState(root: string, state: MigratorState, now: Date = new Date()): Promise<MigratorState> {
  const next: MigratorState = { ...state, schemaVersion: SCHEMA_VERSION, toolVersion: TOOL_VERSION, updatedAt: now.toISOString() };
  await writeJsonAtomic(statePath(root), next);
  return next;
}

