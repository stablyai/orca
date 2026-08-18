// Type-only, so the cycle back through workspace-cleanup-filter-model erases at build.
import type { WorkspaceCleanupBrowseState } from './workspace-cleanup-browse-state'
import type { ExecutionHostId } from './execution-host'
import { getWorkspaceCleanupCandidateHostId } from './workspace-cleanup-host-identity'

export const WORKSPACE_CLEANUP_CLASSIFIER_VERSION = 2
export const WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const WORKSPACE_CLEANUP_IDLE_MS = 30 * 24 * 60 * 60 * 1000

export type WorkspaceCleanupTier = 'ready' | 'review' | 'protected'

export type WorkspaceCleanupReason = 'archived' | 'idle-clean'

export type WorkspaceCleanupInactivityInput = {
  isArchived: boolean
  lastActivityAt: number
}

export type WorkspaceCleanupBlocker =
  | 'main-worktree'
  | 'folder-repo'
  | 'pinned'
  | 'active-workspace'
  | 'running-terminal'
  | 'terminal-liveness-unknown'
  | 'dirty-editor-buffer'
  | 'volatile-local-context'
  | 'recent-visible-context'
  | 'live-agent'
  | 'ssh-disconnected'
  | 'git-status-error'
  | 'dirty-files'
  | 'unpushed-commits'
  | 'unknown-base'
  | 'dismissed'

export type WorkspaceCleanupDismissal = {
  worktreeId: string
  dismissedAt: number
  fingerprint: string
  classifierVersion: number
  // Why (STA-4343): `repoId::path` ids repeat across hosts, so ignoring one
  // host's row must not hide another host's. Optional: a dismissal persisted
  // before this field keeps its legacy id-only match.
  executionHostId?: ExecutionHostId
}

export type WorkspaceCleanupUIState = {
  dismissals: Record<string, WorkspaceCleanupDismissal>
  // Why optional: a host that predates the flat list still writes dismissals-only state.
  browse?: WorkspaceCleanupBrowseState
}

export type WorkspaceCleanupCandidate = {
  worktreeId: string
  repoId: string
  repoName: string
  connectionId: string | null
  executionHostId?: ExecutionHostId
  displayName: string
  branch: string
  path: string
  tier: WorkspaceCleanupTier
  selectedByDefault: boolean
  reasons: WorkspaceCleanupReason[]
  blockers: WorkspaceCleanupBlocker[]
  lastActivityAt: number
  createdAt?: number
  localContext: {
    terminalTabCount: number
    cleanEditorTabCount: number
    browserTabCount: number
    diffCommentCount: number
    newestDiffCommentAt: number | null
    retainedDoneAgentCount: number
  }
  git: {
    clean: boolean | null
    upstreamAhead: number | null
    upstreamBehind: number | null
    checkedAt: number | null
  }
  fingerprint: string
}

export type WorkspaceCleanupScanArgs = {
  worktreeId?: string
  /** Non-destructive evidence refresh; bounded so one renderer cannot enqueue an unbounded scan. */
  worktreeIds?: string[]
  skipGitWorktreeIds?: string[]
  scanId?: string
  // Why: optional so an older client still receives the legacy suggestion-only
  // broad scan; only a client that renders the full list asks for every row.
  includeAllWorkspaces?: boolean
  /** Re-stat activity for targeted rows; removal preflight needs fresh, batched evidence scans do not. */
  refreshActivity?: boolean
}

export const WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT = 500

export type WorkspaceCleanupLocalProcessArgs = {
  worktreeId: string
  connectionId?: string | null
  worktreePath?: string
}

export type WorkspaceCleanupSnapshotPruneBatchArgs = {
  batchId: string
}

export type WorkspaceCleanupSnapshotPruneRecordArgs = WorkspaceCleanupSnapshotPruneBatchArgs & {
  worktreeId: string
  executionHostId?: ExecutionHostId
}

export type WorkspaceCleanupScanError = {
  repoId: string
  repoName: string
  message: string
}

export type WorkspaceCleanupScanResult = {
  scannedAt: number
  candidates: WorkspaceCleanupCandidate[]
  errors: WorkspaceCleanupScanError[]
}

export type WorkspaceCleanupScanProgress = WorkspaceCleanupScanResult & {
  scanId: string
  scannedWorktreeCount: number
  totalWorktreeCount: number
  candidateMode?: 'append' | 'snapshot'
}

export type WorkspaceCleanupLocalProcessResult = {
  hasKillableProcesses: boolean | null
}

export type WorkspaceCleanupDismissArgs = {
  dismissals: WorkspaceCleanupDismissal[]
  /** Removed worktrees' persisted dismissals are dead weight; prune them. */
  removedWorktreeIds?: string[]
}

export const WORKSPACE_CLEANUP_HARD_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> = new Set([
  'main-worktree',
  'folder-repo',
  'pinned',
  'active-workspace',
  'running-terminal',
  'terminal-liveness-unknown',
  'dirty-editor-buffer',
  'volatile-local-context',
  'live-agent',
  'recent-visible-context',
  'ssh-disconnected',
  'git-status-error',
  'dirty-files',
  'unpushed-commits',
  'unknown-base',
  'dismissed'
])

const WORKSPACE_CLEANUP_QUEUE_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> = new Set([
  'main-worktree',
  'folder-repo',
  'dismissed'
])

export const WORKSPACE_CLEANUP_FORCE_REMOVE_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> =
  new Set(['dirty-files', 'unpushed-commits', 'unknown-base', 'git-status-error'])

export function isWorkspaceCleanupHardBlocker(blocker: WorkspaceCleanupBlocker): boolean {
  return WORKSPACE_CLEANUP_HARD_BLOCKERS.has(blocker)
}

export function canQueueWorkspaceCleanupCandidate(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'reasons'>
): boolean {
  return (
    candidate.reasons.length > 0 &&
    !candidate.blockers.some((blocker) => WORKSPACE_CLEANUP_QUEUE_BLOCKERS.has(blocker))
  )
}

export function shouldForceWorkspaceCleanupRemoval(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git'>
): boolean {
  return (
    candidate.git.clean !== true ||
    candidate.git.checkedAt === null ||
    candidate.blockers.some((blocker) => WORKSPACE_CLEANUP_FORCE_REMOVE_BLOCKERS.has(blocker))
  )
}

export function canSelectWorkspaceCleanupCandidate(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git' | 'reasons'>
): boolean {
  return (
    candidate.reasons.length > 0 &&
    candidate.git.clean === true &&
    candidate.git.checkedAt !== null &&
    !candidate.blockers.some(isWorkspaceCleanupHardBlocker)
  )
}

export function applyWorkspaceCleanupPolicy(
  candidate: WorkspaceCleanupCandidate
): WorkspaceCleanupCandidate {
  const canSelect = canSelectWorkspaceCleanupCandidate(candidate)
  const hasHardBlocker = candidate.blockers.some(isWorkspaceCleanupHardBlocker)
  const tier: WorkspaceCleanupTier = hasHardBlocker ? 'protected' : canSelect ? 'ready' : 'review'

  return {
    ...candidate,
    tier,
    selectedByDefault: tier === 'ready' && canSelect
  }
}

export function createWorkspaceCleanupFingerprint(args: {
  branch: string
  head: string
  gitClean: boolean | null
  lastActivityAt: number
  classifierVersion?: number
}): string {
  const version = args.classifierVersion ?? WORKSPACE_CLEANUP_CLASSIFIER_VERSION
  const lastActivityBucket = Math.floor((args.lastActivityAt || 0) / (24 * 60 * 60 * 1000))
  return [
    version,
    args.branch,
    args.head,
    args.gitClean === null ? 'unknown' : args.gitClean ? 'clean' : 'dirty',
    lastActivityBucket
  ].join('|')
}

export function getWorkspaceCleanupInactivityReasons(
  workspace: WorkspaceCleanupInactivityInput,
  scannedAt: number
): WorkspaceCleanupReason[] {
  const reasons: WorkspaceCleanupReason[] = []
  if (
    workspace.isArchived &&
    scannedAt - workspace.lastActivityAt >= WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS
  ) {
    reasons.push('archived')
  }
  if (scannedAt - workspace.lastActivityAt >= WORKSPACE_CLEANUP_IDLE_MS) {
    reasons.push('idle-clean')
  }
  return reasons
}

/** Newest activity stamp Orca itself persisted; 0 when it never observed the workspace. */
export function getPersistedWorkspaceCleanupActivityAt(workspace: {
  createdAt?: number
  lastActivityAt: number
}): number {
  const lastActivityAt = Number.isFinite(workspace.lastActivityAt) ? workspace.lastActivityAt : 0
  const createdAt = Number.isFinite(workspace.createdAt) ? (workspace.createdAt ?? 0) : 0
  return Math.max(lastActivityAt, createdAt)
}

export function isWorkspaceOldForCleanup(
  workspace: WorkspaceCleanupInactivityInput,
  scannedAt: number
): boolean {
  return getWorkspaceCleanupInactivityReasons(workspace, scannedAt).length > 0
}

export function shouldHideWorkspaceCleanupCandidate(
  candidate: Pick<
    WorkspaceCleanupCandidate,
    'worktreeId' | 'fingerprint' | 'connectionId' | 'executionHostId'
  >,
  dismissal: WorkspaceCleanupDismissal | undefined
): boolean {
  return (
    dismissal?.worktreeId === candidate.worktreeId &&
    dismissal.fingerprint === candidate.fingerprint &&
    dismissal.classifierVersion === WORKSPACE_CLEANUP_CLASSIFIER_VERSION &&
    // A host-qualified dismissal hides only its own host's row; a legacy one
    // (no host recorded) keeps hiding every row that matches the fingerprint.
    (dismissal.executionHostId === undefined ||
      dismissal.executionHostId === getWorkspaceCleanupCandidateHostId(candidate))
  )
}
