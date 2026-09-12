import type { Worktree } from '../../../shared/worktree/types'

export type WorktreeCreationAttempt = {
  completed: boolean
  cancelled: boolean
  cleanupAfterSettlement?: () => Promise<boolean>
  cleanupRuntime?: () => Promise<void>
  worktree?: Worktree
  isCancelled: () => boolean
}

export const activeWorktreeCreationAttempts = new Map<string, WorktreeCreationAttempt>()

export function cancelActiveWorktreeCreation(creationId: string): boolean {
  const attempt = activeWorktreeCreationAttempts.get(creationId)
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
  const attempt = activeWorktreeCreationAttempts.get(creationId)
  if (attempt) {
    attempt.completed = true
  }
  activeWorktreeCreationAttempts.delete(creationId)
}
