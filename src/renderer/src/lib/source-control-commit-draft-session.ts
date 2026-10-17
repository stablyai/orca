type CommitDraftsByWorktree = Record<string, string>

let sessionCommitDraftsByWorktree: CommitDraftsByWorktree = {}

export function loadSessionCommitDrafts(): CommitDraftsByWorktree {
  return sessionCommitDraftsByWorktree
}

export function saveSessionCommitDrafts(nextDrafts: CommitDraftsByWorktree): void {
  sessionCommitDraftsByWorktree = nextDrafts
}

// Nested-repo drafts are keyed by nestedStatusKey so they never share the workspace's draft record.
const sessionNestedCommitDrafts = new Map<string, string>()

export function loadSessionNestedCommitDraft(key: string): string {
  return sessionNestedCommitDrafts.get(key) ?? ''
}

export function saveSessionNestedCommitDraft(key: string, message: string): void {
  if (message) {
    sessionNestedCommitDrafts.set(key, message)
  } else {
    sessionNestedCommitDrafts.delete(key)
  }
}

export function clearSessionCommitDraftForWorktree(worktreeId: string): void {
  for (const key of sessionNestedCommitDrafts.keys()) {
    if (key.startsWith(`${worktreeId}::`)) {
      sessionNestedCommitDrafts.delete(key)
    }
  }
  if (!(worktreeId in sessionCommitDraftsByWorktree)) {
    return
  }
  const next = { ...sessionCommitDraftsByWorktree }
  delete next[worktreeId]
  sessionCommitDraftsByWorktree = next
}
