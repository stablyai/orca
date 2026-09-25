import type { TaskPageGitHubQuietRefreshPreludeModel } from './use-task-page-github-quiet-refresh'
import { useEffect } from 'react'
import { runTaskPageGitHubQuietRefresh } from './task-page-github-quiet-refresh-run'
export function useTaskPageGitHubQuietRefreshEffect(model: TaskPageGitHubQuietRefreshPreludeModel) {
  const { quietRefreshNonce } = model
  // Why: dedicated quiet revalidate path (K23) — never tasksFiltering / skeleton,
  // never blanks pages, never bumps taskRefreshNonce. Single-flight with backoff
  // trailing; never clear confirmed authority (K21).
  useEffect(() => {
    return runTaskPageGitHubQuietRefresh(model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quietRefreshNonce])
  return model
}
export type TaskPageGitHubQuietRefreshEffectModel = ReturnType<
  typeof useTaskPageGitHubQuietRefreshEffect
>
