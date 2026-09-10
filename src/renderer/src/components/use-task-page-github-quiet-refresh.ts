import type { TaskPageGitHubLandingRefreshModel } from './use-task-page-github-landing-refresh'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useRef } from 'react'
import { advanceTaskPageQuietRevalidateScope } from '@/components/task-page-github-work-item-mutations'
import { useTaskPageGitHubQuietRefreshEffect } from './use-task-page-github-quiet-refresh-effect'
export type TaskPageGitHubQuietRefreshPreludeModel = ReturnType<
  typeof useTaskPageGitHubQuietRefreshPrelude
>
export function useTaskPageGitHubQuietRefreshPrelude(model: TaskPageGitHubLandingRefreshModel) {
  const { githubWorkItemMutationQueryKey } = model
  // Why: track true unmount only. The quiet-revalidate coalescing keys off the
  // shared quietState (inFlight/trailingQueued), so a nonce-triggered re-render
  // must NOT cancel the in-flight run's trailing bookkeeping.
  const quietRevalidateMountedRef = useMountedRef()
  const quietRevalidateOwnerRef = useRef<object>({})
  const quietRevalidateScopeRef = useRef({
    queryKey: githubWorkItemMutationQueryKey,
    generation: 0
  })
  // Revalidation may run before a passive effect observes a new key.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  quietRevalidateScopeRef.current = advanceTaskPageQuietRevalidateScope(
    quietRevalidateScopeRef.current,
    githubWorkItemMutationQueryKey
  )

  // Why: dedicated quiet revalidate path (K23) — never tasksFiltering / skeleton,
  // never blanks pages, never bumps taskRefreshNonce. Single-flight with backoff
  // trailing; never clear confirmed authority (K21).
  const nextModel = model as typeof model & {
    quietRevalidateMountedRef: typeof quietRevalidateMountedRef
    quietRevalidateOwnerRef: typeof quietRevalidateOwnerRef
    quietRevalidateScopeRef: typeof quietRevalidateScopeRef
  }
  nextModel.quietRevalidateMountedRef = quietRevalidateMountedRef
  nextModel.quietRevalidateOwnerRef = quietRevalidateOwnerRef
  nextModel.quietRevalidateScopeRef = quietRevalidateScopeRef
  return nextModel
}
export function useTaskPageGitHubQuietRefresh(model: TaskPageGitHubLandingRefreshModel) {
  const preludeModel = useTaskPageGitHubQuietRefreshPrelude(model)
  return useTaskPageGitHubQuietRefreshEffect(preludeModel)
}
export type TaskPageGitHubQuietRefreshModel = ReturnType<typeof useTaskPageGitHubQuietRefresh>
