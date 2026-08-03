import type { GitWorktreeInfo } from './types'

export const LOCKED_WORKTREE_REMOVAL_PREFIX = 'Worktree is locked by Git.'

export const UNSTOPPED_PTY_REMOVAL_PREFIX = 'Failed to physically stop every PTY for worktree:'

// Why (#11960): the desktop force affordance is driven entirely by the classifier
// below, so this hint and its matcher must stay in the same file — a message that
// tells the user to force-delete while the UI hides the button is the same dead end.
export const WORKTREE_TEARDOWN_FORCE_HINT = 'Retry with force delete (--force) to remove it anyway.'

export type WorktreeForceDeleteReason =
  | 'dirty'
  | 'orphan-directory'
  | 'missing-registration'
  | 'unstopped-pty'

export function isUnstoppedPtyRemovalError(error: string): boolean {
  return error.includes(UNSTOPPED_PTY_REMOVAL_PREFIX)
}

export function createLockedWorktreeRemovalError(lockReason?: string): Error {
  const reason = lockReason?.trim()
  return new Error(
    reason
      ? `${LOCKED_WORKTREE_REMOVAL_PREFIX} Lock reason: ${reason}. Run git worktree unlock <worktree-path> from its repository, then retry deletion.`
      : `${LOCKED_WORKTREE_REMOVAL_PREFIX} Run git worktree unlock <worktree-path> from its repository, then retry deletion.`
  )
}

export function assertWorktreeUnlockedForRemoval(
  worktree: Pick<GitWorktreeInfo, 'locked' | 'lockReason'> | undefined
): void {
  if (worktree?.locked) {
    throw createLockedWorktreeRemovalError(worktree.lockReason)
  }
}

export function isLockedWorktreeRemovalError(error: string): boolean {
  return (
    error.includes(LOCKED_WORKTREE_REMOVAL_PREFIX) ||
    error.includes('cannot remove a locked working tree')
  )
}

export function getLockedWorktreeRemovalReason(error: string): string | null {
  const prefixIndex = error.indexOf(`${LOCKED_WORKTREE_REMOVAL_PREFIX} Lock reason: `)
  if (prefixIndex === -1) {
    return null
  }
  const reasonStart = prefixIndex + `${LOCKED_WORKTREE_REMOVAL_PREFIX} Lock reason: `.length
  const recoverySuffix =
    '. Run git worktree unlock <worktree-path> from its repository, then retry deletion.'
  const suffixIndex = error.indexOf(recoverySuffix, reasonStart)
  const reason = error.slice(reasonStart, suffixIndex === -1 ? undefined : suffixIndex).trim()
  return reason || null
}

const FORMATTED_DIRTY_WORKTREE_REMOVAL_PATTERN =
  /Failed to delete worktree at [^\n]*\.\s*(?:(?:[MADRCUT][ MADRCUT]| [MADRCUT]|\?\?)\s+\S)/

export function classifyWorktreeForceDeleteReason(
  error: string,
  force = false,
  allowUnverifiedPtyStop = false
): WorktreeForceDeleteReason | null {
  if (isLockedWorktreeRemovalError(error)) {
    // Why: a Git lock can represent an external safety contract. It must be
    // unlocked explicitly rather than folded into Orca's dirty-file force path.
    return null
  }
  // Why (#11960): this must be decided before the `force` guard below. The ordinary
  // delete confirmation already passes force:true to skip the dirty-file prompt, but
  // it does NOT waive PTY-stop proof — so `force` alone is no evidence that the user
  // has already spent this escape hatch. Only the waiver itself is.
  if (isUnstoppedPtyRemovalError(error)) {
    return allowUnverifiedPtyStop ? null : 'unstopped-pty'
  }
  if (force) {
    return null
  }
  if (error.includes('Worktree is no longer registered with Git but its directory remains')) {
    return 'orphan-directory'
  }
  if (
    error.includes('Worktree is no longer registered with Git and its directory is already gone')
  ) {
    return 'missing-registration'
  }
  if (
    error.includes('Worktree has uncommitted or untracked changes') ||
    error.includes('contains modified or untracked files') ||
    FORMATTED_DIRTY_WORKTREE_REMOVAL_PATTERN.test(error)
  ) {
    return 'dirty'
  }
  return null
}
