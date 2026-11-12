// Type-only, so the cycle back through workspace-cleanup-filter-model erases at build.
import type { WorkspaceCleanupBrowseState } from './workspace-cleanup-browse-state'
import type { ExecutionHostId } from '../execution-host'
import type { HostedReviewProvider } from '../source-control/hosted-review/hosted-review-contracts'
import { getWorkspaceCleanupCandidateHostId } from './workspace-cleanup-host-identity'
import type { WorktreeAtRiskLocalFiles } from '../worktree/at-risk-local-files'

export const WORKSPACE_CLEANUP_CLASSIFIER_VERSION = 2
export const WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const WORKSPACE_CLEANUP_IDLE_MS = 30 * 24 * 60 * 60 * 1000

export type WorkspaceCleanupReason = 'archived' | 'inactive' | 'merged' | 'unchanged'

/** What HEAD holds beyond the workspace's base ref (worktree base, else project base, else repo default). */
export type WorkspaceCleanupMergeEvidence = {
  /** Merged review for the branch; `containsHead` when HEAD is its head or the provider confirmed it. */
  mergedReview?: {
    number: number
    provider: Exclude<HostedReviewProvider, 'unsupported'>
    containsHead: boolean
  }
  /** Every change on HEAD is in the base: an ancestor, or Git proved a squash or rebase landed it. */
  headInDefaultBranch: boolean
  /** Commits on HEAD the base ref cannot reach. */
  aheadOfDefault: number
}

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
  | 'recent-visible-context'
  | 'live-agent'
  | 'ssh-disconnected'
  | 'git-status-error'
  | 'dirty-files'
  | 'ignored-files'
  | 'unpushed-commits'
  | 'unknown-base'
  | 'dismissed'

export type WorkspaceCleanupDismissal = {
  worktreeId: string
  dismissedAt: number
  fingerprint: string
  classifierVersion: number
  // Host-qualify repeating repoId::path identities; old dismissals retain their legacy id-only match (STA-4343).
  executionHostId?: ExecutionHostId
}

export type WorkspaceCleanupUIState = {
  dismissals: Record<string, WorkspaceCleanupDismissal>
  // Optional for older hosts that publish dismissals only.
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
    /** Absent when Git was not read or the base ref could not be resolved. */
    merge?: WorkspaceCleanupMergeEvidence
    /** Absent from older hosts, which never checked ignored files. */
    atRiskLocalFiles?: WorktreeAtRiskLocalFiles | null
  }
  fingerprint: string
}

export type WorkspaceCleanupScanArgs = {
  worktreeId?: string
  /** Non-destructive evidence refresh; bounded so one renderer cannot enqueue an unbounded scan. */
  worktreeIds?: string[]
  skipGitWorktreeIds?: string[]
  scanId?: string
  // Old clients retain suggestion-only broad scans; full-list clients explicitly opt into every row.
  includeAllWorkspaces?: boolean
  /** Re-stat activity for targeted rows; removal preflight needs fresh, batched evidence scans do not. */
  refreshActivity?: boolean
}

export const WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT = 500

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
  /** Optional for compatibility with older hosts that did not qualify scan errors. */
  executionHostId?: ExecutionHostId
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

/** One-shot consent to remove a workspace whose git status could not be read. */
export type WorkspaceCleanupUnverifiedRemovalConsent = {
  /** Host-qualified candidate identity, never a bare worktree id. */
  identity: string
  /** Minted for one removal call and released when that call settles. */
  attemptId: string
}

export type WorkspaceCleanupDismissArgs = {
  dismissals: WorkspaceCleanupDismissal[]
  /** Removed worktrees' persisted dismissals are dead weight; prune them. */
  removedWorktreeIds?: string[]
  /** Exact dismissal keys to drop (Stop ignoring / Undo); host-qualified, so other hosts' rows stay ignored. */
  restoredDismissalKeys?: string[]
}

const WORKSPACE_CLEANUP_QUEUE_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> = new Set([
  'main-worktree',
  'folder-repo',
  'ssh-disconnected'
])

export const WORKSPACE_CLEANUP_FORCE_REMOVE_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> =
  new Set(['dirty-files', 'unpushed-commits', 'unknown-base'])

// Active deletion uses sidebar-style focus handoff; live agents require stop confirmation at deletion, so neither blocks bulk selection (STA-4686).
export const WORKSPACE_CLEANUP_BULK_SELECT_EXCLUSIONS: ReadonlySet<WorkspaceCleanupBlocker> =
  new Set(['dismissed'])

export function canQueueWorkspaceCleanupCandidate(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers'>
): boolean {
  return !candidate.blockers.some((blocker) => WORKSPACE_CLEANUP_QUEUE_BLOCKERS.has(blocker))
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

/** Rows the user must review before removal; ignored files never make git refuse, so they need no force. */
export function needsWorkspaceCleanupRemovalApproval(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git'>
): boolean {
  return (
    shouldForceWorkspaceCleanupRemoval(candidate) || candidate.blockers.includes('ignored-files')
  )
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
    reasons.push('inactive')
  }
  return reasons
}

/** HEAD's commits already live in the base or in a merged review, so removing it loses no commits. */
export function isWorkspaceCleanupHeadLanded(
  merge: WorkspaceCleanupMergeEvidence | undefined
): boolean {
  return (
    merge !== undefined && (merge.headInDefaultBranch || merge.mergedReview?.containsHead === true)
  )
}

export function getWorkspaceCleanupMergeReasons(
  merge: WorkspaceCleanupMergeEvidence | undefined
): WorkspaceCleanupReason[] {
  if (!merge) {
    return []
  }
  // A Git-proved squash or rebase is a merge even when no review was cached for the branch.
  const merged =
    merge.mergedReview?.containsHead === true ||
    (merge.headInDefaultBranch && (merge.aheadOfDefault > 0 || merge.mergedReview !== undefined))
  if (merged) {
    return ['merged']
  }
  return merge.aheadOfDefault === 0 ? ['unchanged'] : []
}

/** Newest activity stamp Orca itself persisted; 0 when it never observed the workspace. */
export function getPersistedWorkspaceCleanupActivityAt(workspace: {
  createdAt?: number
  lastActivityAt: number
  lastTerminalUseAt?: number
}): number {
  const lastActivityAt = Number.isFinite(workspace.lastActivityAt) ? workspace.lastActivityAt : 0
  const createdAt = Number.isFinite(workspace.createdAt) ? (workspace.createdAt ?? 0) : 0
  // Written only by a sidebar-inputs host; absent on every other build.
  const terminalUseAt = Number.isFinite(workspace.lastTerminalUseAt)
    ? (workspace.lastTerminalUseAt ?? 0)
    : 0
  return Math.max(lastActivityAt, createdAt, terminalUseAt)
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
    // New dismissals hide only their host’s row; legacy unqualified ones retain fingerprint-only matching.
    (dismissal.executionHostId === undefined ||
      dismissal.executionHostId === getWorkspaceCleanupCandidateHostId(candidate))
  )
}
