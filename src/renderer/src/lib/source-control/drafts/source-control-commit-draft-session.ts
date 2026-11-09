import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../../shared/execution-host'

type CommitDraftsByWorktree = Record<string, string>

let sessionCommitDraftsByWorktree: CommitDraftsByWorktree = {}

export function loadSessionCommitDrafts(): CommitDraftsByWorktree {
  return sessionCommitDraftsByWorktree
}

export function saveSessionCommitDrafts(nextDrafts: CommitDraftsByWorktree): void {
  sessionCommitDraftsByWorktree = nextDrafts
}

export function clearSessionCommitDraftForWorktree(worktreeId: string): void {
  if (!(worktreeId in sessionCommitDraftsByWorktree)) {
    return
  }
  const next = { ...sessionCommitDraftsByWorktree }
  delete next[worktreeId]
  sessionCommitDraftsByWorktree = next
}

const retirementListeners = new Set<(worktreeId: string, hostId?: ExecutionHostId) => void>()

export function subscribeWorktreeCommitDraftRetirement(
  listener: (worktreeId: string, hostId?: ExecutionHostId) => void
): void {
  retirementListeners.add(listener)
}

/** Successful removal and authoritative purge, including owners with no mounted panel. */
export function retireRemovedWorktreeCommitDrafts(
  worktreeId: string,
  hostId?: ExecutionHostId
): void {
  for (const listener of retirementListeners) {
    listener(worktreeId, hostId)
  }
  if (hostId === undefined) {
    for (const key of Object.keys(sessionCommitDraftsByWorktree)) {
      if (key === worktreeId || key.endsWith(`::${worktreeId}`)) {
        clearSessionCommitDraftForWorktree(key)
      }
    }
  } else {
    clearSessionCommitDraftForWorktree(
      hostId === LOCAL_EXECUTION_HOST_ID ? worktreeId : `${hostId}::${worktreeId}`
    )
  }
}
