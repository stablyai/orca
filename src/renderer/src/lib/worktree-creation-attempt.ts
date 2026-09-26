import type { Worktree } from '../../../shared/worktree/types'

/** Refused before the create reached the host, so nothing can have been created. */
export class WorktreeCreationCancelledError extends Error {}

export type WorktreeCreationAttempt = {
  completed: boolean
  cancelled: boolean
  cleanupAfterSettlement?: () => Promise<boolean>
  cleanupRuntime?: () => Promise<void>
  worktree?: Worktree
  /** The create call failed without proving the host did not create the workspace. */
  createOutcomeUnknown?: boolean
  isCancelled: () => boolean
}

// Why private: these hold cleanup closures, which a zustand slice cannot serialise,
// so attempt bookkeeping lives here while `pendingWorktreeCreations` stays the store's.
// Every mutation goes through the functions below so the identity-checked release
// (a newer attempt must not be evicted by an older one) has exactly one implementation.
const activeAttempts = new Map<string, WorktreeCreationAttempt>()

export function getActiveWorktreeCreation(creationId: string): WorktreeCreationAttempt | undefined {
  return activeAttempts.get(creationId)
}

export function registerActiveWorktreeCreation(
  creationId: string,
  attempt: WorktreeCreationAttempt
): void {
  activeAttempts.set(creationId, attempt)
}

/** Drop `attempt` only while it is still the registered one. */
export function releaseActiveWorktreeCreation(
  creationId: string,
  attempt: WorktreeCreationAttempt
): void {
  if (activeAttempts.get(creationId) === attempt) {
    activeAttempts.delete(creationId)
  }
}

export function resetActiveWorktreeCreations(): void {
  activeAttempts.clear()
}

export function cancelActiveWorktreeCreation(creationId: string): boolean {
  const attempt = activeAttempts.get(creationId)
  if (!attempt || attempt.completed) {
    return false
  }
  attempt.cancelled = true
  const cleanup = attempt.cleanupAfterSettlement
  attempt.cleanupAfterSettlement = undefined
  void cleanup?.().catch(console.error)
  return true
}

export function completeActiveWorktreeCreation(creationId: string): void {
  const attempt = activeAttempts.get(creationId)
  if (attempt) {
    attempt.completed = true
  }
  activeAttempts.delete(creationId)
}
