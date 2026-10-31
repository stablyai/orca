import type { TaskPageGitHubQuietRefreshPreludeModel } from './use-task-page-github-quiet-refresh'
import type { TaskPageGitHubQuietRefreshInput } from './task-page-github-delivery-inputs'
import { useEffect } from 'react'
import { runTaskPageGitHubQuietRefresh } from './task-page-github-quiet-refresh-run'
export function useTaskPageGitHubQuietRefreshEffect<T extends TaskPageGitHubQuietRefreshInput>(
  model: T
) {
  const { quietRefreshNonce, githubWorkItemMutationQueryKey, selectedReposKey } = model
  // Single-flight quiet refresh retains pages and confirmed authority, with backoff/trailing work instead of filter skeletons.
  useEffect(() => {
    return runTaskPageGitHubQuietRefresh(model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quietRefreshNonce, githubWorkItemMutationQueryKey, selectedReposKey])
  return model
}
export type TaskPageGitHubQuietRefreshEffectModel = ReturnType<
  typeof useTaskPageGitHubQuietRefreshEffect<TaskPageGitHubQuietRefreshPreludeModel>
>
