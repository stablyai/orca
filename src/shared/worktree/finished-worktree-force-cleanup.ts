/**
 * Finished automation checkouts can be force-cleaned. A user worktree the person
 * can still see in the UI stays fail-closed until that session is gone.
 */
export type FinishedWorktreeForceCleanupFacts = {
  hasAutomationProvenance: boolean
  workspaceStatus?: string | null
  /** Null means the count could not be read. Unknown is not ahead=0. */
  commitsAheadOfDefault: number | null
  hasLiveUiVisibleSession: boolean
}

export function qualifiesForFinishedWorktreeForceCleanup(
  facts: FinishedWorktreeForceCleanupFacts
): boolean {
  // A visible session on a workspace the user created is the session they are in.
  if (facts.hasLiveUiVisibleSession && !facts.hasAutomationProvenance) {
    return false
  }
  if (facts.hasAutomationProvenance) {
    return true
  }
  if (facts.workspaceStatus === 'completed') {
    return true
  }
  return facts.commitsAheadOfDefault === 0
}

export function formatLiveWorktreePidBlocker(pids: readonly number[]): string {
  return `cannot delete because PID ${pids.join(', ')} still running in this worktree`
}

export function isLiveWorktreePidBlocker(error: string): boolean {
  return (
    error.includes('cannot delete because PID ') &&
    error.includes(' still running in this worktree')
  )
}

export function readLiveWorktreePids(error: string): string | null {
  const match = error.match(/cannot delete because PID (.+?) still running in this worktree/)
  return match?.[1] ?? null
}
