/** Why a grace window: a workspace created from an already-merged PR branch is
 *  merged from its first second; the user still needs it. */
export const MERGED_WORKTREE_AUTO_CLOSE_MIN_AGE_MS = 10 * 60 * 1000

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
  now: number
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
  if (
    worktree.createdAt !== undefined &&
    now - worktree.createdAt < MERGED_WORKTREE_AUTO_CLOSE_MIN_AGE_MS
  ) {
    return 'recently-created'
  }
  return null
}

export function decideMergedWorktreeAutoClose(
  worktree: MergedWorktreeAutoCloseSubject,
  repo: MergedWorktreeAutoCloseRepoContext,
  evidence: MergedWorktreeAutoCloseEvidence,
  now: number
): MergedWorktreeAutoCloseDecision {
  const identity = {
    worktreeId: worktree.id,
    repoId: worktree.repoId,
    path: worktree.path,
    branch: normalizeAutoCloseBranchName(worktree.branch)
  }
  const structuralSkip = getMergedWorktreeAutoCloseStructuralSkipReason(worktree, repo, now)
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
