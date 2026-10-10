import type { TaskPageGitHubSearchPaginationModel } from './use-task-page-github-search-pagination'
import { stripRepoQualifiers } from '../../../shared/task-query'
import { useAppStore } from '@/store'
import {
  taskPageGitHubResumeCache,
  TASK_PAGE_GITHUB_RESUME_FRESH_MS
} from '@/components/task-page-github-resume-cache'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
import { sortWorkItemsByNumber } from '../../../shared/work-items'
import {
  materializeTaskPageItemList,
  overlayPendingOnTaskPagePages,
  clearTaskPageGitHubAuthorityThroughGeneration,
  reapplyPendingTaskPageGitHubMutationsToCache
} from '@/components/task-page-github-work-item-mutations'
import { getOrCreateQuietRevalidateState } from '@/components/task-page-github-work-item-mutation-registry'
import {
  taskPageToGitHubApiPage,
  resolveEmptyPageOutcome
} from '@/components/task-page-work-item-pagination'
import {
  deriveTaskPageGitHubWorkItemsFetchOptions,
  shouldReplaceTaskPageItemsAfterRefresh,
  shouldResetTaskPagePaginationAfterLandingRefresh,
  reconcileTaskPagePagesAfterLandingRefresh
} from '@/components/task-page-cache-selectors'
export function runTaskPageGitHubLandingRefresh(model: TaskPageGitHubSearchPaginationModel) {
  const {
    fetchWorkItemsAcrossRepos,
    getCachedWorkItems,
    workItemsInvalidationNonce,
    selectedRepos,
    taskSource,
    taskResumeApplied,
    githubMode,
    appliedTaskSearch,
    setTasksLoading,
    setTasksRefreshing,
    setTasksFiltering,
    setTasksError,
    setFailedCount,
    setGithubUnavailable,
    taskRefreshNonce,
    lastFetchedNonceRef,
    lastFetchedInvalidationNonceRef,
    paginationGenerationRef,
    landingGitHubRefreshKeysRef,
    githubPerRepoPageLimit,
    githubPageSize,
    githubResumeContextKey,
    setPages,
    setCurrentPage,
    pagesRef,
    currentPageRef,
    githubResumeConsumedRef,
    githubResumeContextRef,
    pendingGithubScrollRestoreRef,
    setPaginationLoading,
    setLoadingTargetPage,
    setCountedTotalPages,
    setProvenPageLimit,
    countedTotalPagesRef,
    hardRefreshEpochRef,
    fetchWorkItemsNextPage,
    countWorkItemsAcrossRepos,
    retryingSourceKeys,
    setRetryingSourceKeys,
    githubWorkItemMutationQueryKey
  } = model
  if (!taskResumeApplied) {
    return
  }
  // Why: both early-return branches must clear retryingSourceKeys — if they fire, neither .then nor .catch runs and Retry stays stuck.
  if (taskSource !== 'github' || githubMode !== 'items') {
    setRetryingSourceKeys(new Set())
    setTasksRefreshing(false)
    setTasksFiltering(false)
    return
  }
  if (selectedRepos.length === 0) {
    setRetryingSourceKeys(new Set())
    setTasksRefreshing(false)
    setTasksFiltering(false)
    return
  } // unreachable — multi-combobox forbids empty

  // Why: strip repo:owner/name qualifiers before fan-out — cross-repo they'd pin every fetch to one repo. See stripRepoQualifiers.
  const q = stripRepoQualifiers(appliedTaskSearch.trim())
  let cancelled = false
  const contextChanged = githubResumeContextRef.current !== githubResumeContextKey
  githubResumeContextRef.current = githubResumeContextKey
  const savedPosition = !githubResumeConsumedRef.current
    ? useAppStore.getState().taskListPosition
    : undefined
  githubResumeConsumedRef.current = true
  const savedPositionMatches = savedPosition?.contextKey === githubResumeContextKey
  const targetPage = savedPositionMatches
    ? savedPosition.page
    : contextChanged
      ? 0
      : currentPageRef.current
  const liveTargetItems = pagesRef.current[targetPage]
  const cachedTargetPage = liveTargetItems
    ? {
        items: liveTargetItems,
        cachedAt: Date.now()
      }
    : taskPageGitHubResumeCache.read(githubResumeContextKey, targetPage)
  const cachedTargetIsFresh =
    cachedTargetPage !== null &&
    Date.now() - cachedTargetPage.cachedAt < TASK_PAGE_GITHUB_RESUME_FRESH_MS
  if (savedPositionMatches) {
    pendingGithubScrollRestoreRef.current = savedPosition.scrollTop
  } else if (contextChanged) {
    pendingGithubScrollRestoreRef.current = 0
  }

  // Why: paint cached rows synchronously before the fan-out so a selection change doesn't leave the prior rows on screen for a frame.
  const preMerged: GitHubWorkItem[] = []
  let anyUncached = false
  let anyRepoCached = false
  for (const r of selectedRepos) {
    const cached = getCachedWorkItems(
      r.id,
      githubPerRepoPageLimit,
      q,
      r.path,
      getTaskPageRepoSourceContext(r, 'github')
    )
    if (cached === null) {
      anyUncached = true
    } else {
      anyRepoCached = true
      preMerged.push(...cached)
    }
  }
  // Why: page-one metadata and the restored numbered page have independent lifecycles.
  const page0Raw =
    preMerged.length > 0 ? sortWorkItemsByNumber(preMerged).slice(0, githubPageSize) : []
  // Why: pre-paint must still overlay in-flight mutations (K4/K18).
  const landingPages: (GitHubWorkItem[] | null)[] = Array.from(
    {
      length: targetPage + 1
    },
    () => null
  )
  landingPages[0] = materializeTaskPageItemList({
    networkItems: page0Raw,
    previousItems: pagesRef.current.flatMap((page) => page ?? []),
    queryKey: githubWorkItemMutationQueryKey
  })
  if (targetPage > 0 && cachedTargetPage) {
    landingPages[targetPage] = overlayPendingOnTaskPagePages([cachedTargetPage.items])[0] ?? []
  }
  pagesRef.current = landingPages
  currentPageRef.current = targetPage
  setPages(landingPages)
  setCurrentPage(targetPage)
  setCountedTotalPages(null)
  countedTotalPagesRef.current = null
  setProvenPageLimit(null)
  setTasksError(null)
  setFailedCount(0) // reset so a prior failure banner doesn't linger
  // reset so a prior failure banner doesn't linger
  setGithubUnavailable(false)
  setTasksLoading(targetPage > 0 ? cachedTargetPage === null : anyUncached)

  // Preserve the existing nonce-gated force behavior.
  const forceRefresh = taskRefreshNonce !== lastFetchedNonceRef.current
  lastFetchedNonceRef.current = taskRefreshNonce
  // Why: treat a preference-flip nonce bump as a forced refresh so it bypasses the dedupe map and can't reuse pre-flip data.
  const preferenceInvalidated =
    workItemsInvalidationNonce !== lastFetchedInvalidationNonceRef.current
  lastFetchedInvalidationNonceRef.current = workItemsInvalidationNonce
  const forcedFetch = (forceRefresh && taskRefreshNonce > 0) || preferenceInvalidated
  if (forcedFetch) {
    hardRefreshEpochRef.current += 1
  }
  const forcedFetchAuthorityGeneration = forcedFetch
    ? getOrCreateQuietRevalidateState(githubWorkItemMutationQueryKey).dirtyGeneration
    : null
  const repoArgs = selectedRepos.map((r) => ({
    repoId: r.id,
    path: r.path,
    executionHostId: r.executionHostId,
    sourceContext: getTaskPageRepoSourceContext(r, 'github')
  }))
  const landingRefreshKey = `${repoArgs.map((r) => `${r.repoId}:${r.path}`).join('|')}::${q}`
  const shouldProbeOnLanding =
    !forcedFetch &&
    !cachedTargetIsFresh &&
    anyRepoCached &&
    !landingGitHubRefreshKeysRef.current.has(landingRefreshKey)
  if (shouldProbeOnLanding) {
    landingGitHubRefreshKeysRef.current = new Set([
      ...landingGitHubRefreshKeysRef.current,
      landingRefreshKey
    ])
  }
  // Why: manual refresh keeps cached rows (tasksLoading stays false), so track forced fetch separately for the toolbar spinner.
  setTasksRefreshing(forcedFetch)
  if (targetPage > 0 && (!cachedTargetIsFresh || forcedFetch)) {
    const requestGeneration = paginationGenerationRef.current
    if (!cachedTargetPage) {
      setPaginationLoading(true)
      setLoadingTargetPage(targetPage)
    }
    void fetchWorkItemsNextPage(
      repoArgs,
      githubPerRepoPageLimit,
      githubPageSize,
      q,
      taskPageToGitHubApiPage(targetPage)
    )
      .then(({ items, failedCount, errorTypes }) => {
        if (cancelled || paginationGenerationRef.current !== requestGeneration) {
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
      })
      .catch((error) => {
        console.error('Failed to restore GitHub task page:', error)
      })
      .finally(() => {
        if (!cancelled && paginationGenerationRef.current === requestGeneration) {
          setPaginationLoading(false)
          setLoadingTargetPage(null)
          setTasksLoading(false)
        }
      })
  }

  // Why: snapshot retrying keys at dispatch so an earlier settling effect doesn't wipe a newer retry's pending source.
  const dispatchedRetrySourceKeys = retryingSourceKeys
  void fetchWorkItemsAcrossRepos(repoArgs, githubPerRepoPageLimit, githubPageSize, q, {
    ...deriveTaskPageGitHubWorkItemsFetchOptions(forcedFetch, shouldProbeOnLanding),
    ...(forcedFetch
      ? {
          requireComplete: true
        }
      : {})
  })
    .then(
      ({ items, failedCount: failed, githubUnavailable: unavailable, requestFailureCount = 0 }) => {
        // Why: clear only the dispatch-time snapshot keys so an overlapping retry's newer source isn't wiped.
        setRetryingSourceKeys((prev) => {
          if (dispatchedRetrySourceKeys.size === 0) {
            return prev
          }
          const next = new Set(prev)
          for (const key of dispatchedRetrySourceKeys) {
            next.delete(key)
          }
          return next
        })
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
        const sourceContextByRepoId = new Map(
          repoArgs.map((r) => [r.repoId, r.sourceContext] as const)
        )
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
    )
    .catch((err) => {
      // Why: fetchWorkItemsAcrossRepos swallows per-repo failures, so a reject here is IPC/programmer error — surface it.
      // Why: clear only the dispatch-time snapshot keys so an overlapping retry's newer source isn't wiped.
      setRetryingSourceKeys((prev) => {
        if (dispatchedRetrySourceKeys.size === 0) {
          return prev
        }
        const next = new Set(prev)
        for (const key of dispatchedRetrySourceKeys) {
          next.delete(key)
        }
        return next
      })
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
    })

  // Why: fire-and-forget count query alongside the items fetch; the search API is cached 120s server-side so it adds little cost.
  void countWorkItemsAcrossRepos(
    selectedRepos.map((r) => ({
      repoId: r.id,
      path: r.path,
      executionHostId: r.executionHostId,
      sourceContext: getTaskPageRepoSourceContext(r, 'github')
    })),
    q,
    githubPerRepoPageLimit
  ).then(({ totalPages: countedPages }) => {
    if (!cancelled) {
      // Why: the count overwrites unconditionally — proven window limits live
      // in provenPageLimit, so a late count can't be pinned by a speculative
      // end-of-data withdrawal, and can't resurrect proven-dead pages either.
      countedTotalPagesRef.current = countedPages
      setCountedTotalPages(countedPages)
    }
  })
  return () => {
    cancelled = true
  }
}
