import { toast } from 'sonner'
import { useAppStore } from '@/store'

import {
  activeWorktreeCreationAttempts as activeAttempts,
  type WorktreeCreationAttempt
} from './worktree-creation-attempt'

export async function withWorktreeCreationCancellation(
  creationId: string,
  execute: (attempt: WorktreeCreationAttempt) => Promise<void>
): Promise<void> {
  const previous = activeAttempts.get(creationId)
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
  activeAttempts.set(creationId, attempt)
  try {
    if (!attempt.isCancelled()) {
      await execute(attempt)
    }
  } finally {
    const cleanup = (): Promise<boolean> =>
      removeCancelledCreation(attempt).finally(() => {
        if (activeAttempts.get(creationId) === attempt) {
          activeAttempts.delete(creationId)
        }
      })
    if (!attempt.completed && attempt.isCancelled()) {
      await cleanup()
    } else if (!attempt.completed && attempt.worktree) {
      // Failed post-create startup still owns a workspace when its error panel is dismissed.
      attempt.cleanupAfterSettlement = cleanup
    } else if (activeAttempts.get(creationId) === attempt) {
      activeAttempts.delete(creationId)
    }
  }
}

async function removeCancelledCreation(attempt: WorktreeCreationAttempt): Promise<boolean> {
  const { worktree } = attempt
  try {
    if (worktree) {
      const result = await useAppStore
        .getState()
        .removeWorktree({ id: worktree.id, executionHostId: worktree.hostId ?? 'local' }, true, {
          skipArchiveHooks: true,
          suppressPreservedBranchToast: true,
          ...(worktree.instanceId ? { expectedInstanceId: worktree.instanceId } : {})
        })
      if (!result.ok) {
        throw new Error(result.error)
      }
    }
    await attempt.cleanupRuntime?.()
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('worktree create: cancellation cleanup failed', worktree?.id, error)
    toast.error(`Could not remove the cancelled workspace: ${message}`, {
      duration: Infinity
    })
    return false
  }
}
