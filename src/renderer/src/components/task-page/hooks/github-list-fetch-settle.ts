import type { Dispatch, MutableRefObject, SetStateAction } from 'react'

import { useAppStore } from '@/store'
import {
  clearTaskPageGitHubAuthorityThroughGeneration,
  materializeTaskPageItemList,
  overlayPendingOnTaskPagePages,
  reapplyPendingTaskPageGitHubMutationsToCache
} from '@/components/task-page-github-work-item-mutations'
import {
  reconcileTaskPagePagesAfterLandingRefresh,
  shouldReplaceTaskPageItemsAfterRefresh,
  shouldResetTaskPagePaginationAfterLandingRefresh
} from '@/components/task-page-cache-selectors'
import { resolveEmptyPageOutcome } from '@/components/task-page-work-item-pagination'
import { taskPageGitHubResumeCache } from '@/components/task-page-github-resume-cache'
import type { ClassifiedError } from '../../../../../shared/classified-error'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

function clearDispatchedRetrySourceKeys(
  dispatchedRetrySourceKeys: ReadonlySet<string>,
  setRetryingSourceKeys: Dispatch<SetStateAction<ReadonlySet<string>>>
): void {
  // Why: clear only the dispatch-time snapshot keys so an overlapping retry's newer source isn't wiped.
  if (dispatchedRetrySourceKeys.size === 0) {
    return
  }
  setRetryingSourceKeys((prev) => {
    const next = new Set(prev)
    for (const key of dispatchedRetrySourceKeys) {
      next.delete(key)
    }
    return next
  })
}

type GitHubPages = (GitHubWorkItem[] | null)[]

export type GitHubListFetchRepoArg = {
  repoId: string
  path: string
  executionHostId?: string | null
  sourceContext: TaskSourceContext | null
}

export function settleGitHubRestoredPage({
  cancelled,
  paginationGeneration,
  requestGeneration,
  items,
  failedCount,
  errorTypes,
  targetPage,
  cachedTargetPage,
  pendingGithubScrollRestoreRef,
  currentPageRef,
  pagesRef,
  setCurrentPage,
  setPages,
  githubResumeContextKey
}: {
  cancelled: boolean
  paginationGeneration: number
  requestGeneration: number
  items: GitHubWorkItem[]
  failedCount: number
  errorTypes: ClassifiedError['type'][]
  targetPage: number
  cachedTargetPage: { items: GitHubWorkItem[]; cachedAt: number } | null
  pendingGithubScrollRestoreRef: MutableRefObject<number | null>
  currentPageRef: MutableRefObject<number>
  pagesRef: MutableRefObject<GitHubPages>
  setCurrentPage: Dispatch<SetStateAction<number>>
  setPages: Dispatch<SetStateAction<GitHubPages>>
  githubResumeContextKey: string
}): void {
  if (cancelled || paginationGeneration !== requestGeneration) {
    return
  }
  if (items.length === 0) {
    const { reason } = resolveEmptyPageOutcome({
      target: targetPage,
      failedCount,
      errorTypes,
      countedTotalPages: null
    })
    if (reason === 'load-failed' && cachedTargetPage) {
      return
    }
    pendingGithubScrollRestoreRef.current = 0
    currentPageRef.current = 0
    setCurrentPage(0)
    const next = [pagesRef.current[0] ?? []]
    pagesRef.current = next
    setPages(next)
    return
  }
  const restoredItems = overlayPendingOnTaskPagePages([items])[0] ?? []
  taskPageGitHubResumeCache.write(githubResumeContextKey, targetPage, restoredItems)
  const next = [...pagesRef.current]
  while (next.length <= targetPage) {
    next.push(null)
  }
  next[targetPage] = restoredItems
  pagesRef.current = next
  setPages(next)
}

export function settleGitHubListItemsSuccess({
  dispatchedRetrySourceKeys,
  setRetryingSourceKeys,
  cancelled,
  forcedFetchAuthorityGeneration,
  items,
  failed,
  requestFailureCount,
  unavailable,
  githubWorkItemMutationQueryKey,
  repoArgs,
  targetPage,
  pagesRef,
  setPages,
  shouldProbeOnLanding,
  page0Raw,
  currentPageRef,
  setCurrentPage,
  setFailedCount,
  setGithubUnavailable,
  cachedTargetPage,
  setTasksLoading,
  setTasksRefreshing,
  setTasksFiltering
}: {
  dispatchedRetrySourceKeys: ReadonlySet<string>
  setRetryingSourceKeys: Dispatch<SetStateAction<ReadonlySet<string>>>
  cancelled: boolean
  forcedFetchAuthorityGeneration: number | null
  items: GitHubWorkItem[]
  failed: number
  requestFailureCount: number
  unavailable: boolean
  githubWorkItemMutationQueryKey: string
  repoArgs: readonly GitHubListFetchRepoArg[]
  targetPage: number
  pagesRef: MutableRefObject<GitHubPages>
  setPages: Dispatch<SetStateAction<GitHubPages>>
  shouldProbeOnLanding: boolean
  page0Raw: GitHubWorkItem[]
  currentPageRef: MutableRefObject<number>
  setCurrentPage: Dispatch<SetStateAction<number>>
  setFailedCount: Dispatch<SetStateAction<number>>
  setGithubUnavailable: Dispatch<SetStateAction<boolean>>
  cachedTargetPage: { items: GitHubWorkItem[]; cachedAt: number } | null
  setTasksLoading: Dispatch<SetStateAction<boolean>>
  setTasksRefreshing: Dispatch<SetStateAction<boolean>>
  setTasksFiltering: Dispatch<SetStateAction<boolean>>
}): void {
  clearDispatchedRetrySourceKeys(dispatchedRetrySourceKeys, setRetryingSourceKeys)
  if (cancelled) {
    return
  }
  // Why: user hard refresh (force) is design tier-3 — drop confirmed
  // authority so search can adopt for non-pending families. Pending ops
  // still overlay. Quiet path must NOT clear authority.
  if (
    forcedFetchAuthorityGeneration !== null &&
    failed === 0 &&
    requestFailureCount === 0 &&
    !unavailable
  ) {
    clearTaskPageGitHubAuthorityThroughGeneration(
      githubWorkItemMutationQueryKey,
      forcedFetchAuthorityGeneration
    )
  }
  // Why: best-effort cache re-apply after wholesale list replace (K4).
  const sourceContextByRepoId = new Map(repoArgs.map((r) => [r.repoId, r.sourceContext] as const))
  reapplyPendingTaskPageGitHubMutationsToCache({
    items,
    patchWorkItem: useAppStore.getState().patchWorkItem,
    sourceContextByRepoId
  })
  if (targetPage > 0) {
    const next = [...pagesRef.current]
    next[0] = materializeTaskPageItemList({
      networkItems: items,
      previousItems: next.flatMap((page) => page ?? []),
      queryKey: githubWorkItemMutationQueryKey
    })
    pagesRef.current = next
    setPages(next)
  } else if (shouldProbeOnLanding) {
    const replaceFirstPage = shouldReplaceTaskPageItemsAfterRefresh(page0Raw, items)
    const resetPagination = shouldResetTaskPagePaginationAfterLandingRefresh(page0Raw, items)
    setPages((current) =>
      reconcileTaskPagePagesAfterLandingRefresh(current, items).map((page) =>
        page ? (overlayPendingOnTaskPagePages([page])[0] ?? []) : null
      )
    )
    if (replaceFirstPage || resetPagination) {
      currentPageRef.current = 0
      setCurrentPage(0)
    }
  } else {
    setPages((previous) => [
      materializeTaskPageItemList({
        networkItems: items,
        previousItems: previous.flatMap((page) => page ?? []),
        queryKey: githubWorkItemMutationQueryKey
      })
    ])
    currentPageRef.current = 0
    setCurrentPage(0)
  }
  setFailedCount(failed)
  setGithubUnavailable(unavailable)
  if (targetPage === 0 || cachedTargetPage) {
    setTasksLoading(false)
  }
  setTasksRefreshing(false)
  setTasksFiltering(false)
}

export function settleGitHubListItemsFailure({
  dispatchedRetrySourceKeys,
  setRetryingSourceKeys,
  cancelled,
  err,
  setTasksError,
  setFailedCount,
  setGithubUnavailable,
  targetPage,
  cachedTargetPage,
  setTasksLoading,
  setTasksRefreshing,
  setTasksFiltering
}: {
  dispatchedRetrySourceKeys: ReadonlySet<string>
  setRetryingSourceKeys: Dispatch<SetStateAction<ReadonlySet<string>>>
  cancelled: boolean
  err: unknown
  setTasksError: Dispatch<SetStateAction<string | null>>
  setFailedCount: Dispatch<SetStateAction<number>>
  setGithubUnavailable: Dispatch<SetStateAction<boolean>>
  targetPage: number
  cachedTargetPage: { items: GitHubWorkItem[]; cachedAt: number } | null
  setTasksLoading: Dispatch<SetStateAction<boolean>>
  setTasksRefreshing: Dispatch<SetStateAction<boolean>>
  setTasksFiltering: Dispatch<SetStateAction<boolean>>
}): void {
  // Why: fetchWorkItemsAcrossRepos swallows per-repo failures, so a reject here is IPC/programmer error — surface it.
  clearDispatchedRetrySourceKeys(dispatchedRetrySourceKeys, setRetryingSourceKeys)
  if (cancelled) {
    return
  }
  setTasksError(err instanceof Error ? err.message : 'Failed to load GitHub work.')
  setFailedCount(0) // the per-repo banner would be misleading next to tasksError
  setGithubUnavailable(false)
  if (targetPage === 0 || cachedTargetPage) {
    setTasksLoading(false)
  }
  setTasksRefreshing(false)
  setTasksFiltering(false)
}

export function settleGitHubListCount({
  cancelled,
  countedPages,
  countedTotalPagesRef,
  setCountedTotalPages
}: {
  cancelled: boolean
  countedPages: number
  countedTotalPagesRef: MutableRefObject<number | null>
  setCountedTotalPages: Dispatch<SetStateAction<number | null>>
}): void {
  if (!cancelled) {
    // Why: the count overwrites unconditionally — proven window limits live
    // in provenPageLimit, so a late count can't be pinned by a speculative
    // end-of-data withdrawal, and can't resurrect proven-dead pages either.
    countedTotalPagesRef.current = countedPages
    setCountedTotalPages(countedPages)
  }
}
