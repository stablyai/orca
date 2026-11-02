import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
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

    // Refresh conflicting PRs once to replace stale cached conflict summaries.
    conflictSummaryRefreshKeyRef.current = refreshKey
    setConflictDetailsRefreshing(true)
    void fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      repoOwnerExecutionHostId: getRepoExecutionHostId(repo),
      worktreeId: activeWorktreeId ?? undefined,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: fallbackGitHubPRNumber ?? pr.number,
      reason: 'active'
    }).finally(() => {
      // The fetch can rerun this effect; only the current key may clear the spinner.
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
