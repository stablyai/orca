import type { TaskPageGitHubSearchPaginationModel } from './use-task-page-github-search-pagination'
import { useEffect } from 'react'
import { runTaskPageGitHubLandingRefresh } from './task-page-github-landing-refresh-run'
export function useTaskPageGitHubLandingRefresh(model: TaskPageGitHubSearchPaginationModel) {
  const {
    workItemsInvalidationNonce,
    selectedReposKey,
    taskSource,
    taskResumeApplied,
    githubMode,
    appliedTaskSearch,
    taskRefreshNonce,
    githubWorkItemMutationQueryKey
  } = model
  useEffect(() => {
    return runTaskPageGitHubLandingRefresh(model)
    // Why: selectedReposKey covers every repo field read by the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedReposKey,
    appliedTaskSearch,
    taskRefreshNonce,
    taskSource,
    githubMode,
    workItemsInvalidationNonce,
    taskResumeApplied,
    githubWorkItemMutationQueryKey
  ])

  // Why: track true unmount only. The quiet-revalidate coalescing keys off the
  // shared quietState (inFlight/trailingQueued), so a nonce-triggered re-render
  // must NOT cancel the in-flight run's trailing bookkeeping.
  return model
}
export type TaskPageGitHubLandingRefreshModel = ReturnType<typeof useTaskPageGitHubLandingRefresh>
