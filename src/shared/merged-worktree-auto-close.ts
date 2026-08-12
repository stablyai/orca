const MS_PER_MINUTE = 60 * 1000

/** Why a grace window: a workspace created from an already-merged PR branch is
 *  merged from its first second; the user still needs it. Configurable because a
 *  user who never works that way wants a landed workspace gone on the next sweep. */
export const DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES = 10
export const MIN_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES = 0
export const MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES = 24 * 60

export const DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS =
  DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES * MS_PER_MINUTE

/**
 * Settings store the window in minutes. A profile that never wrote the setting,
 * or wrote a value no control can produce, gets the default rather than a
 * window that would delete a checkout the user still needs.
 */
export function resolveMergedWorktreeAutoCloseGraceMs(graceMinutes: number | undefined): number {
  if (graceMinutes === undefined || !Number.isFinite(graceMinutes)) {
    return DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS
  }
  const clamped = Math.min(
    MAX_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES,
    Math.max(MIN_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MINUTES, graceMinutes)
  )
  return clamped * MS_PER_MINUTE
}

export type MergedWorktreeAutoCloseSkipReason =
  | 'main-worktree'
  | 'folder-repo'
  | 'pinned'
  | 'remote-host'
  | 'detached-head'
  | 'recently-created'
  | 'never-published'
  | 'not-merged'
  | 'dirty-files'
  | 'merge-check-failed'
  | 'status-check-failed'

export type MergedWorktreeAutoCloseSubject = {
  id: string
  repoId: string
  path: string
  branch: string
  isMainWorktree: boolean
  isPinned: boolean
  createdAt?: number
}

export type MergedWorktreeAutoCloseEvidence = {
  /** null when Git could not prove the branch merged either way. */
  merged: boolean | null
  /** null when the worktree's status could not be read. */
  clean: boolean | null
  /** null when the branch's upstream configuration could not be read. */
  published: boolean | null
}

export type MergedWorktreeAutoCloseDecision = {
  worktreeId: string
  repoId: string
  path: string
  branch: string
} & ({ action: 'close' } | { action: 'skip'; reason: MergedWorktreeAutoCloseSkipReason })

export type MergedWorktreeAutoCloseRepoContext = {
  isFolderRepo: boolean
  isRemoteRepo: boolean
}

/**
 * Reasons that rule a workspace out before any Git evidence is read, so the
 * sweep never spends a status or merge probe on a workspace it cannot close.
 */
export function getMergedWorktreeAutoCloseStructuralSkipReason(
  worktree: MergedWorktreeAutoCloseSubject,
  repo: MergedWorktreeAutoCloseRepoContext,
  now: number,
  graceMs: number = DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS
): MergedWorktreeAutoCloseSkipReason | null {
  if (worktree.isMainWorktree) {
    return 'main-worktree'
  }
  if (repo.isFolderRepo) {
    return 'folder-repo'
  }
  // Why: proving a squash merge needs `patch-id` over stdin, which the SSH git
  // provider contract does not carry; remote workspaces stay manual for now.
  if (repo.isRemoteRepo) {
    return 'remote-host'
  }
  if (worktree.isPinned) {
    return 'pinned'
  }
  if (!normalizeAutoCloseBranchName(worktree.branch)) {
    return 'detached-head'
  }
  // Why the `graceMs > 0` guard: with no grace at all a workspace whose
  // recorded creation time sits slightly ahead of the clock must still close.
  //
  // Why an unknown creation time counts as inside the window: a workspace found
  // on disk gets metadata without `createdAt`, and reading that absence as "old
  // enough" deleted a merged, clean checkout on the very first sweep after it
  // was discovered. Unknown age means the window cannot be proven expired.
  if (graceMs > 0 && (worktree.createdAt === undefined || now - worktree.createdAt < graceMs)) {
    return 'recently-created'
  }
  return null
}

export function decideMergedWorktreeAutoClose(
  worktree: MergedWorktreeAutoCloseSubject,
  repo: MergedWorktreeAutoCloseRepoContext,
  evidence: MergedWorktreeAutoCloseEvidence,
  now: number,
  graceMs: number = DEFAULT_MERGED_WORKTREE_AUTO_CLOSE_GRACE_MS
): MergedWorktreeAutoCloseDecision {
  const identity = {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    path: worktree.path,
    branch: normalizeAutoCloseBranchName(worktree.branch)
  }
  const structuralSkip = getMergedWorktreeAutoCloseStructuralSkipReason(
    worktree,
    repo,
    now,
    graceMs
  )
  if (structuralSkip) {
    return { ...identity, action: 'skip', reason: structuralSkip }
  }
  // Why: an unpublished branch that reads as merged is usually a workspace that
  // never committed — its tip is still the base it was branched from.
  if (evidence.published !== true) {
    return { ...identity, action: 'skip', reason: 'never-published' }
  }
  if (evidence.merged === null) {
    return { ...identity, action: 'skip', reason: 'merge-check-failed' }
  }
  if (!evidence.merged) {
    return { ...identity, action: 'skip', reason: 'not-merged' }
  }
  if (evidence.clean === null) {
    return { ...identity, action: 'skip', reason: 'status-check-failed' }
  }
  if (!evidence.clean) {
    return { ...identity, action: 'skip', reason: 'dirty-files' }
  }
  return { ...identity, action: 'close' }
}

export function normalizeAutoCloseBranchName(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, '')
}
