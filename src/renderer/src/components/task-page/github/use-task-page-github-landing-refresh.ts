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

  // Nonce rerenders must not cancel shared in-flight/trailing bookkeeping; only true unmount does.
  return model
}
export type TaskPageGitHubLandingRefreshModel = ReturnType<typeof useTaskPageGitHubLandingRefresh>
