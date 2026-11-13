import type { ExecutionHostId } from '../execution-host'
import type {
  WorkspaceCleanupEvaluation,
  WorkspaceCleanupKeepCause,
  WorkspaceCleanupRuleReason,
  WorkspaceCleanupWaiting
} from './workspace-cleanup-evaluation'

// Workspaces no rule watches are not part of a run's receipt.
export const WORKSPACE_CLEANUP_UNWATCHED_CAUSES: ReadonlySet<WorkspaceCleanupKeepCause> = new Set([
  'not-removable',
  'project-off',
  'rules-off'
])

export const WORKSPACE_CLEANUP_REPORT_RUN_LIMIT = 20
// Matches T3 Code's report cap; a run over hundreds of workspaces must not bloat the sidecar.
export const WORKSPACE_CLEANUP_REPORT_ROW_LIMIT = 200

/** Who started a run. 'run-now' is an app's Clean up now; 'cli' is `orca` on the command line. */
export type WorkspaceCleanupRunTrigger = 'startup' | 'hourly' | 'settings' | 'run-now' | 'cli'

export type WorkspaceCleanupRunOutcome = 'removed' | 'archived' | 'kept' | 'failed'

export type WorkspaceCleanupWorkspaceRef = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  repoId: string
  repoName: string
  displayName: string
  branch: string
  path: string
}

export type WorkspaceCleanupRunRow = WorkspaceCleanupWorkspaceRef & {
  outcome: WorkspaceCleanupRunOutcome
  reason?: WorkspaceCleanupRuleReason
  keepCause?: WorkspaceCleanupKeepCause
  waiting?: WorkspaceCleanupWaiting
  /** Kept because the re-check right before removal found something new. */
  keptOnRecheck?: true
  /** The unmerged branch Git kept after the checkout was removed. */
  branchKept?: string
  /** Last measured checkout size; absent when Orca never measured it. */
  sizeBytes?: number
  /** Plain-words failure for 'failed' rows. */
  error?: string
}

export type WorkspaceCleanupRun = {
  id: string
  trigger: WorkspaceCleanupRunTrigger
  startedAt: number
  finishedAt: number
  counts: Record<WorkspaceCleanupRunOutcome, number>
  /** Sum of removed and archived rows' known sizes. */
  freedBytes: number
  /** Removed, archived and failed rows, then kept ones, capped at WORKSPACE_CLEANUP_REPORT_ROW_LIMIT. */
  rows: WorkspaceCleanupRunRow[]
  /** Set when the run itself could not finish, in plain words. */
  error?: string
}

export type WorkspaceCleanupReport = {
  /** Newest first, at most WORKSPACE_CLEANUP_REPORT_RUN_LIMIT. */
  runs: WorkspaceCleanupRun[]
  running: boolean
  /** Null when no rule is on, so no scheduled run would do anything. */
  nextRunAt: number | null
}

export type WorkspaceCleanupPreviewRow = WorkspaceCleanupWorkspaceRef & {
  evaluation: WorkspaceCleanupEvaluation
  sizeBytes?: number
}

export type WorkspaceCleanupPreview = {
  evaluatedAt: number
  rows: WorkspaceCleanupPreviewRow[]
}

/** Emitted by the host that ran it; clients may toast. */
export type WorkspaceCleanupRunFinishedEvent = {
  type: 'workspaceCleanupRunFinished'
  run: Omit<WorkspaceCleanupRun, 'rows'>
}
