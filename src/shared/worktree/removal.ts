import type { ExecutionHostId } from '../execution-host'
import type { GitWorktreeInfo, Worktree } from './types'

export function unregisteredFolderRefusal(worktreePath: string): Error {
  return new Error(
    `${worktreePath} is no longer a Git worktree, so its folder was left on disk. Delete the folder yourself to finish removing this workspace.`
  )
}

export const LOCKED_WORKTREE_REMOVAL_PREFIX = 'Worktree is locked by Git.'

export const UNSTOPPED_PTY_REMOVAL_PREFIX = 'Failed to physically stop every PTY for worktree:'

// Keep force hints and classifiers together so recommended actions remain visible (#11960).
export const WORKTREE_TEARDOWN_FORCE_HINT = 'Retry with force delete (--force) to remove it anyway.'

export type WorktreeForceDeleteReason =
  | 'dirty'
  | 'orphan-directory'
  | 'missing-registration'
  | 'unstopped-pty'
  | 'running-agent-session'
  | 'submodules'

// Only text after this boundary is Orca’s verdict; the worktree ID is a user-chosen path.
export const UNSTOPPED_PTY_DETAIL_SEPARATOR = ' — '

// Keep proven-live and unverifiable stops distinct in delete toasts. Both PTY and structured-session sweeps re-observe after stopping.
export const STILL_LIVE_DETAIL_PREFIX = 'still live:'

// Sweep timeouts need their own force matcher even without a per-PTY verdict (#11960).
export const WORKTREE_TEARDOWN_TIMEOUT_PREFIX = 'Timed out waiting for physical PTY teardown:'

// Running agent sessions also block removal; classify this prefix to expose the force waiver (#11960).
export const RUNNING_AGENT_SESSION_REMOVAL_PREFIX =
  'Refusing to remove worktree with running agent sessions:'

export function isRunningAgentSessionRemovalError(error: string): boolean {
  return error.includes(RUNNING_AGENT_SESSION_REMOVAL_PREFIX)
}

export function isUnstoppedPtyRemovalError(error: string): boolean {
  return (
    error.includes(UNSTOPPED_PTY_REMOVAL_PREFIX) || error.includes(WORKTREE_TEARDOWN_TIMEOUT_PREFIX)
  )
}

/** True only when verification positively observed the PTYs still running. */
export function isProvenLivePtyRemovalError(error: string): boolean {
  return (
    isUnstoppedPtyRemovalError(error) &&
    error.includes(`${UNSTOPPED_PTY_DETAIL_SEPARATOR}${STILL_LIVE_DETAIL_PREFIX}`)
  )
}

/** True only when the observation AFTER the close found the session still attached. */
export function isProvenLiveStructuredSessionRemovalError(error: string): boolean {
  return (
    isRunningAgentSessionRemovalError(error) &&
    error.includes(`${UNSTOPPED_PTY_DETAIL_SEPARATOR}${STILL_LIVE_DETAIL_PREFIX}`)
  )
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

// Name submodules in the dirty refusal before Git runs; retain the dirty sentence for older force classifiers.
export const SUBMODULE_DIRTY_REMOVAL_DETAIL =
  'Worktree has uncommitted or untracked changes, and it contains submodules.'

// Carries Git's own refusal text so every client version classifies it as the submodule Force Delete reason.
export const SUBMODULE_REMOVAL_REFUSAL =
  'This checkout contains submodule repositories, and Git refuses to remove it without force (working trees containing submodules cannot be moved or removed). Force also deletes anything in those submodules that was never pushed: commits, local branches and stashes.'

// Git refuses initialized submodules even when clean; force deletes their unpushed history too. English output lets clients classify older hosts.
export function isSubmoduleWorktreeRemovalRefusal(error: string): boolean {
  return (
    error.includes('working trees containing submodules cannot be moved or removed') ||
    error.includes(SUBMODULE_DIRTY_REMOVAL_DETAIL)
  )
}

const FORMATTED_DIRTY_WORKTREE_REMOVAL_PATTERN =
  /Failed to delete worktree at [^\n]*\.\s*(?:(?:[MADRCUT][ MADRCUT]| [MADRCUT]|\?\?)\s+\S)/

export function classifyWorktreeForceDeleteReason(
  error: string,
  force = false,
  allowUnverifiedPtyStop = false
): WorktreeForceDeleteReason | null {
  if (isLockedWorktreeRemovalError(error)) {
    // A Git lock may encode an external safety contract; require explicit unlock.
    return null
  }
  // Ordinary desktop delete already sets force for dirty files; only allowUnverifiedPtyStop waives stop proof, so classify first (#11960).
  if (isUnstoppedPtyRemovalError(error)) {
    return allowUnverifiedPtyStop ? null : 'unstopped-pty'
  }
  // The same explicit waiver governs sessions; force alone only bypasses dirty-file refusal.
  if (isRunningAgentSessionRemovalError(error)) {
    return allowUnverifiedPtyStop ? null : 'running-agent-session'
  }
  if (force) {
    return null
  }
  if (isSubmoduleWorktreeRemovalRefusal(error)) {
    return 'submodules'
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

// The same repoId::path can exist on several hosts. Route destructive removals to the confirmed row’s required host, never the active workspace’s host (STA-4343).

/** Require an explicit host claim for destructive removal. null deliberately means the confirmed legacy row declares no host. */
export type WorktreeRemovalTarget = {
  id: string
  executionHostId: ExecutionHostId | null
}

export function toWorktreeRemovalTarget(
  worktree: Pick<Worktree, 'id' | 'hostId'>
): WorktreeRemovalTarget {
  return { id: worktree.id, executionHostId: worktree.hostId ?? null }
}
