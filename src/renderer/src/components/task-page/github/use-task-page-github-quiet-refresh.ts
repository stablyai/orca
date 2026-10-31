import type { TaskPageGitHubLandingRefreshModel } from './use-task-page-github-landing-refresh'
import type { TaskPageGitHubQuietRefreshInput } from './task-page-github-delivery-inputs'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useRef } from 'react'
import type { QuietRevalidateRunOwner } from '@/components/task-page/github/task-page-github-work-item-quiet-state'
import { advanceTaskPageQuietRevalidateScope } from '@/components/task-page/github/task-page-github-work-item-quiet-revalidate'
import { useTaskPageGitHubQuietRefreshEffect } from './use-task-page-github-quiet-refresh-effect'
export type TaskPageGitHubQuietRefreshPreludeModel = ReturnType<
  typeof useTaskPageGitHubQuietRefreshPrelude<TaskPageGitHubLandingRefreshModel>
>
export function useTaskPageGitHubQuietRefreshPrelude<
  T extends Pick<
    TaskPageGitHubLandingRefreshModel,
    'githubWorkItemMutationQueryKey' | 'selectedReposKey'
  >
>(model: T) {
  const { githubWorkItemMutationQueryKey, selectedReposKey } = model
  // Nonce rerenders must preserve shared in-flight/trailing bookkeeping; track true unmount only.
  const quietRevalidateMountedRef = useMountedRef()
  const quietRevalidateOwnerRef = useRef<QuietRevalidateRunOwner>({})
  const quietRevalidateScopeRef = useRef({
    queryKey: githubWorkItemMutationQueryKey + selectedReposKey,
    generation: 0
  })
  // Revalidation may run before a passive effect observes a new key.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  quietRevalidateScopeRef.current = advanceTaskPageQuietRevalidateScope(
    quietRevalidateScopeRef.current,
    githubWorkItemMutationQueryKey + selectedReposKey
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
export function useTaskPageGitHubQuietRefresh<
  T extends Omit<
    TaskPageGitHubQuietRefreshInput,
    'quietRevalidateMountedRef' | 'quietRevalidateOwnerRef' | 'quietRevalidateScopeRef'
  >
>(model: T) {
  const preludeModel = useTaskPageGitHubQuietRefreshPrelude(model)
  return useTaskPageGitHubQuietRefreshEffect(preludeModel)
}
export type TaskPageGitHubQuietRefreshModel = ReturnType<
  typeof useTaskPageGitHubQuietRefresh<TaskPageGitHubLandingRefreshModel>
>
