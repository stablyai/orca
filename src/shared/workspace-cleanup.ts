import type { PRState } from './types'

export const WORKSPACE_CLEANUP_CLASSIFIER_VERSION = 1
export const WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const WORKSPACE_CLEANUP_IDLE_MS = 30 * 24 * 60 * 60 * 1000

export type WorkspaceCleanupTier = 'ready' | 'review' | 'protected'

export type WorkspaceCleanupReason = 'pr-merged' | 'pr-closed-clean' | 'archived' | 'idle-clean'

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
  | 'open-pr'
  | 'unknown-base'
  | 'dismissed'

export type WorkspaceCleanupDismissal = {
  worktreeId: string
  dismissedAt: number
  fingerprint: string
  classifierVersion: number
}

export type WorkspaceCleanupUIState = {
  dismissals: Record<string, WorkspaceCleanupDismissal>
}

export type WorkspaceCleanupCandidate = {
  worktreeId: string
  repoId: string
  repoName: string
  connectionId: string | null
  displayName: string
  branch: string
  path: string
  tier: WorkspaceCleanupTier
  selectedByDefault: boolean
  reasons: WorkspaceCleanupReason[]
  blockers: WorkspaceCleanupBlocker[]
  lastActivityAt: number
  createdAt?: number
  linkedPR?: { number: number; state: PRState | 'unknown' }
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
    branchCompareChangedFiles: number | null
    checkedAt: number | null
  }
  prStateCheckedAt: number | null
  staleEvidence: boolean
  fingerprint: string
}

export type WorkspaceCleanupScanArgs = {
  worktreeId?: string
  skipGitWorktreeIds?: string[]
}

export type WorkspaceCleanupScanResult = {
  scannedAt: number
  candidates: WorkspaceCleanupCandidate[]
  errors: { repoId: string; message: string }[]
}

export type WorkspaceCleanupDismissArgs = {
  dismissals: WorkspaceCleanupDismissal[]
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
  'ssh-disconnected',
  'git-status-error',
  'dirty-files',
  'unpushed-commits',
  'open-pr',
  'unknown-base',
  'dismissed'
])

export function isWorkspaceCleanupHardBlocker(blocker: WorkspaceCleanupBlocker): boolean {
  return WORKSPACE_CLEANUP_HARD_BLOCKERS.has(blocker)
}

export function hasWorkspaceCleanupDivergenceProof(
  candidate: Pick<WorkspaceCleanupCandidate, 'git'>
): boolean {
  const checked = candidate.git.checkedAt !== null
  if (!checked) {
    return false
  }
  return candidate.git.upstreamAhead === 0 || candidate.git.branchCompareChangedFiles === 0
}

export function canSelectWorkspaceCleanupCandidate(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git' | 'staleEvidence'>
): boolean {
  return (
    !candidate.staleEvidence &&
    candidate.git.clean === true &&
    hasWorkspaceCleanupDivergenceProof(candidate) &&
    !candidate.blockers.some(isWorkspaceCleanupHardBlocker)
  )
}

export function applyWorkspaceCleanupPolicy(
  candidate: WorkspaceCleanupCandidate
): WorkspaceCleanupCandidate {
  const canSelect = canSelectWorkspaceCleanupCandidate(candidate)
  const hasHardBlocker = candidate.blockers.some(isWorkspaceCleanupHardBlocker)
  const hasReadyReason = candidate.reasons.length > 0
  const tier: WorkspaceCleanupTier = hasHardBlocker
    ? 'protected'
    : canSelect && hasReadyReason
      ? 'ready'
      : 'review'

  return {
    ...candidate,
    tier,
    selectedByDefault: tier === 'ready' && canSelect
  }
}

export function createWorkspaceCleanupFingerprint(args: {
  branch: string
  head: string
  prState: PRState | 'unknown' | null
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
    args.prState ?? 'none',
    args.gitClean === null ? 'unknown' : args.gitClean ? 'clean' : 'dirty',
    lastActivityBucket
  ].join('|')
}

export function shouldHideWorkspaceCleanupCandidate(
  candidate: Pick<WorkspaceCleanupCandidate, 'worktreeId' | 'fingerprint'>,
  dismissal: WorkspaceCleanupDismissal | undefined
): boolean {
  return (
    dismissal?.worktreeId === candidate.worktreeId &&
    dismissal.fingerprint === candidate.fingerprint &&
    dismissal.classifierVersion === WORKSPACE_CLEANUP_CLASSIFIER_VERSION
  )
}
