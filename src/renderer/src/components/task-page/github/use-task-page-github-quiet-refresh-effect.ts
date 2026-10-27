import type { TaskPageGitHubQuietRefreshPreludeModel } from './use-task-page-github-quiet-refresh'
import { useEffect } from 'react'
import { runTaskPageGitHubQuietRefresh } from './task-page-github-quiet-refresh-run'
export function useTaskPageGitHubQuietRefreshEffect(model: TaskPageGitHubQuietRefreshPreludeModel) {
  const { quietRefreshNonce } = model
  // Single-flight quiet refresh retains pages and confirmed authority, with backoff/trailing work instead of filter skeletons.
  useEffect(() => {
    return runTaskPageGitHubQuietRefresh(model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quietRefreshNonce])
  return model
}
export type TaskPageGitHubQuietRefreshEffectModel = ReturnType<
  typeof useTaskPageGitHubQuietRefreshEffect
>
