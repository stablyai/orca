import { useEffect } from 'react'

import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'

type ChecksPanelConflictRefreshInput = Pick<
  ChecksPanelControllerState,
  'activeWorktreeId' | 'branch' | 'conflictRefreshKeyRef' | 'fetchPRForBranch' | 'repo'
> &
  Pick<
    ChecksPanelContextState,
    'fallbackGitHubPRNumber' | 'isFolder' | 'linkedPR' | 'pr' | 'prCacheKey'
  >

export function useChecksPanelConflictRefresh(model: ChecksPanelConflictRefreshInput) {
  const {
    activeWorktreeId,
    branch,
    conflictRefreshKeyRef,
    fallbackGitHubPRNumber,
    fetchPRForBranch,
    isFolder,
    linkedPR,
    pr,
    prCacheKey,
    repo
  } = model
  useEffect(() => {
    if (
      !repo ||
      isFolder ||
      !branch ||
      !pr ||
      pr.mergeable !== 'CONFLICTING' ||
      !activeWorktreeId
    ) {
      conflictRefreshKeyRef.current = null
      return
    }

    const refreshKey = `${prCacheKey}::${branch}::${pr.number}`
    if (conflictRefreshKeyRef.current === refreshKey) {
      return
    }

    // Why: refresh mergeable once when a conflicting PR opens; the cached PR can be 5 min old and a stale conflict sends the user to an agent.
    conflictRefreshKeyRef.current = refreshKey
    void fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      worktreeId: activeWorktreeId ?? undefined,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber ?? pr.number,
      reason: 'active'
    })
  }, [
    repo,
    isFolder,
    branch,
    pr,
    prCacheKey,
    activeWorktreeId,
    linkedPR,
    fallbackGitHubPRNumber,
    fetchPRForBranch,
    conflictRefreshKeyRef
  ])
}
