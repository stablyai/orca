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
  skipGitWorktreeIds?: string[]
}

export type WorkspaceCleanupLocalProcessArgs = {
  worktreeId: string
  connectionId?: string | null
  worktreePath?: string
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

export type WorkspaceCleanupLocalProcessResult = {
  hasKillableProcesses: boolean | null
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

export function isWorkspaceOldForCleanup(
  workspace: WorkspaceCleanupInactivityInput,
  scannedAt: number
): boolean {
  return getWorkspaceCleanupInactivityReasons(workspace, scannedAt).length > 0
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
