import { useEffect } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
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
  executionHostId,
  issueCacheKey
}: {
  worktreeId: string
  executionHostId?: ExecutionHostId
  // Why a prop: the row projection already resolves it per snapshot; re-resolving here would rescan the catalog.
  issueCacheKey: string | null
}): null {
  useEffect(() => {
    if (!issueCacheKey) {
      return
    }
    // Why: the separate Space window shows the main window's published issueCache, so the main window does the read.
    const isSpaceWindow = window.location.pathname.endsWith('/space.html')
    return installWindowVisibilityInterval({
      run: () =>
        isSpaceWindow
          ? void window.api.workspaceSpace
              .requestIssueRefresh?.(worktreeId, executionHostId)
              .catch(() => {})
          : refreshLinkedIssueForWorktree(worktreeId, executionHostId),
      intervalMs: 5 * 60_000
    })
  }, [issueCacheKey, worktreeId, executionHostId])
  return null
}
