import { useEffect } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { findWorktreeReviewOwner } from '@/store/github/refresh/worktree-refresh'

/** Re-reads the worktree's current linked issue in this window's store; fresh-gated by fetchIssue. */
export function refreshLinkedIssueForWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): void {
  const state = useAppStore.getState()
  const owner = findWorktreeReviewOwner(state, worktreeId, executionHostId)
  const issueNumber = owner?.worktree.linkedIssue
  if (owner && issueNumber) {
    void state.fetchIssue(owner.repo.path, issueNumber, { repoId: owner.repo.id })
  }
}

/** Mounted only inside an open decision hover: that hover owns its linked issue's freshness. */
export function WorkspaceSpaceIssueFreshness({
  worktreeId,
  executionHostId
}: {
  worktreeId: string
  executionHostId?: ExecutionHostId
}): null {
  const demandKey = useAppStore((state) => {
    const owner = findWorktreeReviewOwner(state, worktreeId, executionHostId)
    const issueNumber = owner?.worktree.linkedIssue
    return owner && issueNumber ? `${owner.repo.id}::${issueNumber}` : null
  })
  useEffect(() => {
    if (!demandKey) {
      return
    }
    // Why: the desktop Space window shows the main window's published issueCache, so the main window does the read.
    const requestIssueRefresh = window.api?.workspaceSpace?.requestIssueRefresh
    return installWindowVisibilityInterval({
      run: () =>
        requestIssueRefresh
          ? void requestIssueRefresh(worktreeId, executionHostId).catch(() => {})
          : refreshLinkedIssueForWorktree(worktreeId, executionHostId),
      intervalMs: 5 * 60_000
    })
  }, [demandKey, worktreeId, executionHostId])
  return null
}
