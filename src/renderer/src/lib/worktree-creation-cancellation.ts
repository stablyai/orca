import { toast } from 'sonner'
import { useAppStore } from '@/store'

import {
  getActiveWorktreeCreation,
  registerActiveWorktreeCreation,
  releaseActiveWorktreeCreation,
  type WorktreeCreationAttempt
} from './worktree-creation-attempt'
import { WORKTREE_INSTANCE_REPLACED_ERROR } from '@/store/slices/worktree-removal-options'

export async function withWorktreeCreationCancellation(
  creationId: string,
  execute: (attempt: WorktreeCreationAttempt) => Promise<void>
): Promise<void> {
  const previous = getActiveWorktreeCreation(creationId)
  if (previous && !previous.completed && !previous.cleanupAfterSettlement) {
    return
  }
  if (previous?.cleanupAfterSettlement) {
    const cleanup = previous.cleanupAfterSettlement
    previous.cleanupAfterSettlement = undefined
    if (!(await cleanup())) {
      throw new Error(
        'Could not clean up the previous workspace creation. Remove it before retrying.'
      )
    }
  }
  const attempt: WorktreeCreationAttempt = {
    completed: false,
    cancelled: false,
    isCancelled: () =>
      attempt.cancelled || !useAppStore.getState().pendingWorktreeCreations[creationId]
  }
  registerActiveWorktreeCreation(creationId, attempt)
  try {
    if (!attempt.isCancelled()) {
      await execute(attempt)
    }
  } finally {
    const cleanup = async (deferred: boolean): Promise<boolean> => {
      const outcome = await removeCancelledCreation(attempt, deferred)
      // Why: a deferred rollback whose removal call failed still owns a real
      // workspace, and its attempt is the only record of it. Dropping that record
      // would let the next retry create a second workspace beside the first, so
      // keep the obligation until a removal actually discharges it. An unidentified
      // workspace is exempt: no call was made, so retrying can never discharge it.
      // The entry check separates retry (kept, so it can re-attempt) from dismissal
      // (already gone, so a re-armed hook could never run again).
      if (
        deferred &&
        !outcome.ok &&
        outcome.retryable &&
        useAppStore.getState().pendingWorktreeCreations[creationId]
      ) {
        attempt.cleanupAfterSettlement = () => cleanup(deferred)
      } else {
        releaseActiveWorktreeCreation(creationId, attempt)
      }
      return outcome.ok
    }
    if (!attempt.completed && attempt.isCancelled()) {
      await cleanup(false)
    } else if (!attempt.completed && attempt.worktree) {
      // Failed post-create startup still owns a workspace when its error panel is dismissed.
      attempt.cleanupAfterSettlement = () => cleanup(true)
    } else {
      releaseActiveWorktreeCreation(creationId, attempt)
    }
  }
}

/** `retryable` is false when no removal was attempted, so retrying cannot help. */
type CancelledCreationCleanup = { ok: boolean; retryable: boolean }

/**
 * `deferred` marks a rollback that outlived its attempt, waiting behind an error
 * panel. Only that one can sit long enough for the user to delete and recreate at
 * the same path, so only it refuses to force-delete a workspace it cannot prove is
 * the one it created — a host too old to stamp `instanceId` leaves no other proof.
 */
async function removeCancelledCreation(
  attempt: WorktreeCreationAttempt,
  deferred: boolean
): Promise<CancelledCreationCleanup> {
  const { worktree } = attempt
  let retryable = true
  try {
    if (worktree) {
      if (deferred && !worktree.instanceId) {
        // No removal is attempted, so no later retry can discharge this.
        retryable = false
        throw new Error(
          'it could not be identified on the host, so it was left in place. Delete it manually if unwanted.'
        )
      }
      const result = await useAppStore
        .getState()
        .removeWorktree({ id: worktree.id, executionHostId: worktree.hostId ?? 'local' }, true, {
          skipArchiveHooks: true,
          suppressPreservedBranchToast: true,
          ...(worktree.instanceId ? { expectedInstanceId: worktree.instanceId } : {})
        })
      // A replaced instance means this attempt's workspace is already gone, so
      // there is nothing left to roll back — not a cleanup failure.
      if (!result.ok && result.error !== WORKTREE_INSTANCE_REPLACED_ERROR) {
        throw new Error(result.error)
      }
    }
    // Why: cancelling before the host answered leaves no row to remove, but the
    // host may still have finished. Say so rather than reporting a clean rollback.
    if (!worktree && attempt.createOutcomeUnknown) {
      toast.warning(
        'Cancelled before the host confirmed the workspace. If it appears, delete it manually.'
      )
    }
    await attempt.cleanupRuntime?.()
    return { ok: true, retryable }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('worktree create: cancellation cleanup failed', worktree?.id, error)
    // Why: the runtime is deliberately left running — tearing down a VM whose
    // workspace deletion never confirmed could destroy a workspace that survived.
    // Deleting the still-visible row is what releases both, so say so.
    const runtimeHint = attempt.cleanupRuntime
      ? ' Its runtime is still running; deleting the workspace releases it.'
      : ''
    toast.error(`Could not remove the cancelled workspace: ${message}${runtimeHint}`, {
      duration: Infinity
    })
    return { ok: false, retryable }
  }
}
