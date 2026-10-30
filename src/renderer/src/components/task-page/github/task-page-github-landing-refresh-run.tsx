import { countTaskPageGitHubLandingPages } from './task-page-github-landing-cache-snapshot'
import { admitTaskPageGitHubListInputs } from './task-page-github-work-item-mutation-pages'

import { clearDispatchedTaskSourceRetries } from '../task-page-work-item-pagination'

import { beginGitHubTaskRead, type GitHubTaskRead } from '@/store/github/request-coordination'

import type { TaskPageGitHubSearchPaginationModel } from './use-task-page-github-search-pagination'

import { stripRepoQualifiers } from '../../../../../shared/task-query'

import { useAppStore } from '@/store/index'

import {
  taskPageGitHubResumeCache,
  TASK_PAGE_GITHUB_RESUME_FRESH_MS
} from '@/components/task-page/github/task-page-github-resume-cache'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import { getTaskPageRepoSourceContext } from '../task-page-source-context'

import { taskPageToGitHubApiPage } from '../../../../../shared/work-items'

import {
  createTaskPageGitHubProjectionContext,
  materializeTaskPageItemList,
  deliverTaskPageGitHubRead,
  restoreTaskPageGitHubReadPage,
  overlayPendingOnTaskPagePages,
  reapplyPendingTaskPageGitHubMutationsToCache
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import { clearTaskPageGitHubAuthorityThroughGeneration } from '@/components/task-page/github/task-page-github-work-item-authority-refresh'

import { getOrCreateQuietRevalidateState } from '@/components/task-page/github/task-page-github-work-item-quiet-state'

import { resolveEmptyPageOutcome } from '@/components/task-page/task-page-work-item-pagination'

import {
  deriveTaskPageGitHubWorkItemsFetchOptions,
  shouldReplaceTaskPageItemsAfterRefresh,
  shouldResetTaskPagePaginationAfterLandingRefresh,
  reconcileTaskPagePagesAfterLandingRefresh
} from '@/components/task-page/task-page-cache-selectors'

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
    retryingSourceKeys,
    setRetryingSourceKeys,
    githubWorkItemMutationQueryKey
  } = model
  if (!taskResumeApplied) {
    return
  }
  // Clear retry keys on early returns because no promise handler will run to release Retry.
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

  // Why: strip repo:owner/name qualifiers before fan-out — cross-repo they would pin every fetch to one repo.
  const context = createTaskPageGitHubProjectionContext(
    selectedRepos,
    model.appliedTaskQuery,
    githubWorkItemMutationQueryKey,
    model.githubViewerLogin
  )
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

  const repoArgs = selectedRepos.map((r) => ({
    repoId: r.id,
    path: r.path,
    executionHostId: r.executionHostId,
    sourceContext: getTaskPageRepoSourceContext(r, 'github')
  }))
  const reads = new Set<GitHubTaskRead>()
  const landingRead = beginGitHubTaskRead(repoArgs, undefined, { repos: selectedRepos })
  reads.add(landingRead)
  // Why: paint cached rows synchronously before the fan-out so a selection change doesn't leave the prior rows on screen for a frame.
  const { page0Raw, anyUncached, anyRepoCached } = readTaskPageGitHubLandingCache(
    { selectedRepos, getCachedWorkItems, githubPerRepoPageLimit, githubPageSize },
    q
  )
  admitTaskPageGitHubListInputs([...page0Raw, ...(cachedTargetPage?.items ?? [])], context, true)
  landingRead.borrow([...page0Raw, ...(cachedTargetPage?.items ?? [])])
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
    queryKey: githubWorkItemMutationQueryKey,
    context
  })
  if (targetPage > 0 && cachedTargetPage) {
    landingPages[targetPage] =
      overlayPendingOnTaskPagePages([cachedTargetPage.items], context)[0] ?? []
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
  setGithubUnavailable(false)
  setTasksLoading(targetPage > 0 ? cachedTargetPage === null : anyUncached)

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
    const restoredRead = beginGitHubTaskRead(repoArgs, undefined, { repos: selectedRepos })
    reads.add(restoredRead)
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
      taskPageToGitHubApiPage(targetPage),
      { taskRead: restoredRead }
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
        const next = restoreTaskPageGitHubReadPage(
          restoredRead,
          pagesRef.current,
          items,
          targetPage,
          context
        )
        taskPageGitHubResumeCache.write(githubResumeContextKey, targetPage, next[targetPage] ?? [])
        pagesRef.current = next
        deliverTaskPageGitHubRead(
          restoredRead,
          items,
          setPages,
          pagesRef,
          context,
          (current, rows, materialize) => {
            const next = [...current]
            while (next.length <= targetPage) {
              next.push(null)
            }
            next[targetPage] = materialize(rows, current[targetPage] ?? [])
            return next
          }
        )
      })
      .catch((error) => {
        console.error('Failed to restore GitHub task page:', error)
      })
      .finally(() => {
        restoredRead.finish(() => reads.delete(restoredRead))
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
    taskRead: landingRead,
    ...deriveTaskPageGitHubWorkItemsFetchOptions(forcedFetch, shouldProbeOnLanding),
    ...(forcedFetch
      ? {
          requireComplete: true
        }
      : {})
  })
    .then(
      ({
        items: returnedItems,
        failedCount: failed,
        githubUnavailable: unavailable,
        requestFailureCount = 0
      }) => {
        // Why: clear only the dispatch-time snapshot keys so an overlapping retry's newer source isn't wiped.
        setRetryingSourceKeys((prev) =>
          clearDispatchedTaskSourceRetries(prev, dispatchedRetrySourceKeys)
        )
        if (cancelled) {
          return
        }
        const items = landingRead.apply(
          returnedItems,
          pagesRef.current.flatMap((page) => page ?? [])
        )
        admitTaskPageGitHubListInputs(items, context)
        // Hard refresh releases confirmed authority for non-pending fields; quiet refresh must retain it.
        if (
          forcedFetchAuthorityGeneration !== null &&
          failed === 0 &&
          requestFailureCount === 0 &&
          !unavailable
        ) {
          clearTaskPageGitHubAuthorityThroughGeneration(
            githubWorkItemMutationQueryKey,
            forcedFetchAuthorityGeneration,
            context.owns,
            returnedItems
          )
        }
        // Why: best-effort cache re-apply after wholesale list replace (K4).
        reapplyPendingTaskPageGitHubMutationsToCache({
          items,
          patchWorkItems: useAppStore.getState().patchWorkItems,
          context
        })
        deliverTaskPageGitHubRead(
          landingRead,
          returnedItems,
          setPages,
          pagesRef,
          context,
          (current, rows, materialize) => {
            if (targetPage > 0) {
              const next = [...current]
              next[0] = materialize(
                rows,
                current.flatMap((page) => page ?? [])
              )
              return next
            }
            const items = materialize(
              rows,
              current.flatMap((page) => page ?? [])
            )
            return shouldProbeOnLanding
              ? reconcileTaskPagePagesAfterLandingRefresh(current, items)
              : [items]
          }
        )
        if (
          targetPage === 0 &&
          (!shouldProbeOnLanding ||
            shouldResetTaskPagePaginationAfterLandingRefresh(page0Raw, items) ||
            shouldReplaceTaskPageItemsAfterRefresh(page0Raw, items))
        ) {
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
      setRetryingSourceKeys((prev) =>
        clearDispatchedTaskSourceRetries(prev, dispatchedRetrySourceKeys)
      )
      if (cancelled) {
        return
      }
      landingRead.dispose()
      setTasksError(err instanceof Error ? err.message : 'Failed to load GitHub work.')
      setFailedCount(0) // the per-repo banner would be misleading next to tasksError
      setGithubUnavailable(false)
      if (targetPage === 0 || cachedTargetPage) {
        setTasksLoading(false)
      }
      setTasksRefreshing(false)
      setTasksFiltering(false)
    })
    .finally(() => {
      landingRead.finish(() => reads.delete(landingRead))
    })

  countTaskPageGitHubLandingPages(model, q, ({ totalPages: countedPages }) => {
    if (!cancelled) {
      countedTotalPagesRef.current = countedPages
      setCountedTotalPages(countedPages)
    }
  })
  return () => {
    cancelled = true
    for (const read of reads) {
      read.dispose()
    }
  }
}
import { readTaskPageGitHubLandingCache } from './task-page-github-landing-cache-snapshot'
