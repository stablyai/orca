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
