import { useEffect } from 'react'

import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'

type ChecksPanelConflictRefreshInput = Pick<
  ChecksPanelControllerState,
  | 'activeWorktreeId'
  | 'branch'
  | 'conflictSummaryRefreshKeyRef'
  | 'fetchPRForBranch'
  | 'repo'
  | 'setConflictDetailsRefreshing'
> &
  Pick<
    ChecksPanelContextState,
    'fallbackGitHubPRNumber' | 'isFolder' | 'linkedPR' | 'pr' | 'prCacheKey'
  >

export function useChecksPanelConflictRefresh(model: ChecksPanelConflictRefreshInput) {
  const {
    activeWorktreeId,
    branch,
    conflictSummaryRefreshKeyRef,
    fallbackGitHubPRNumber,
    fetchPRForBranch,
    isFolder,
    linkedPR,
    pr,
    prCacheKey,
    repo,
    setConflictDetailsRefreshing
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
      conflictSummaryRefreshKeyRef.current = null
      setConflictDetailsRefreshing(false)
      return
    }

    const refreshKey = `${prCacheKey}::${branch}::${pr.number}`
    if (conflictSummaryRefreshKeyRef.current === refreshKey) {
      return
    }

    // Why: stale conflict metadata is visibly wrong here; force-refresh conflicting PRs once to avoid stale cached summaries.
    conflictSummaryRefreshKeyRef.current = refreshKey
    setConflictDetailsRefreshing(true)
    void fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      worktreeId: activeWorktreeId ?? undefined,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber ?? pr.number
    }).finally(() => {
      // Why: fetchPRForBranch can rerun this effect; only the current key clears the spinner so stale requests don't race newer branches.
      if (conflictSummaryRefreshKeyRef.current === refreshKey) {
        setConflictDetailsRefreshing(false)
      }
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
    conflictSummaryRefreshKeyRef,
    setConflictDetailsRefreshing
  ])
}
