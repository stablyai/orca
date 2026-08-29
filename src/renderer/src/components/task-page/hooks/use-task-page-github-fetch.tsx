import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  materializeTaskPageItemList,
  overlayPendingOnTaskPagePages
} from '@/components/task-page-github-work-item-mutations'
import { getOrCreateQuietRevalidateState } from '@/components/task-page-github-work-item-mutation-registry'
import { deriveTaskPageGitHubWorkItemsFetchOptions } from '@/components/task-page-cache-selectors'
import {
  taskPageGitHubResumeCache,
  TASK_PAGE_GITHUB_RESUME_FRESH_MS
} from '@/components/task-page-github-resume-cache'
import { taskPageToGitHubApiPage } from '@/components/task-page-work-item-pagination'
import { getTaskPageRepoSourceContext } from '@/components/task-page/source/repo-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import { stripRepoQualifiers } from '../../../../../shared/task-query'
import { sortWorkItemsByNumber } from '../../../../../shared/work-items'
import {
  settleGitHubListCount,
  settleGitHubListItemsFailure,
  settleGitHubListItemsSuccess,
  settleGitHubRestoredPage
} from './github-list-fetch-settle'

type GitHubPages = (GitHubWorkItem[] | null)[]

export function useTaskPageGitHubFetch({
  taskResumeApplied,
  taskSource,
  githubMode,
  selectedRepos,
  setRetryingSourceKeys,
  setTasksRefreshing,
  setTasksFiltering,
  appliedTaskSearch,
  githubResumeContextRef,
  githubResumeContextKey,
  githubResumeConsumedRef,
  currentPageRef,
  pagesRef,
  pendingGithubScrollRestoreRef,
  getCachedWorkItems,
  githubPerRepoPageLimit,
  githubPageSize,
  githubWorkItemMutationQueryKey,
  setPages,
  setCurrentPage,
  setCountedTotalPages,
  countedTotalPagesRef,
  setProvenPageLimit,
  setTasksError,
  setFailedCount,
  setGithubUnavailable,
  setTasksLoading,
  taskRefreshNonce,
  lastFetchedNonceRef,
  workItemsInvalidationNonce,
  lastFetchedInvalidationNonceRef,
  hardRefreshEpochRef,
  landingGitHubRefreshKeysRef,
  paginationGenerationRef,
  setPaginationLoading,
  setLoadingTargetPage,
  fetchWorkItemsNextPage,
  fetchWorkItemsAcrossRepos,
  countWorkItemsAcrossRepos,
  retryingSourceKeys,
  selectedReposKey
}: {
  taskResumeApplied: boolean
  taskSource: TaskProvider
  githubMode: 'items' | 'project'
  selectedRepos: Repo[]
  setRetryingSourceKeys: Dispatch<SetStateAction<ReadonlySet<string>>>
  setTasksRefreshing: Dispatch<SetStateAction<boolean>>
  setTasksFiltering: Dispatch<SetStateAction<boolean>>
  appliedTaskSearch: string
  githubResumeContextRef: MutableRefObject<string>
  githubResumeContextKey: string
  githubResumeConsumedRef: MutableRefObject<boolean>
  currentPageRef: MutableRefObject<number>
  pagesRef: MutableRefObject<GitHubPages>
  pendingGithubScrollRestoreRef: MutableRefObject<number | null>
  getCachedWorkItems: AppState['getCachedWorkItems']
  githubPerRepoPageLimit: number
  githubPageSize: number
  githubWorkItemMutationQueryKey: string
  setPages: Dispatch<SetStateAction<GitHubPages>>
  setCurrentPage: Dispatch<SetStateAction<number>>
  setCountedTotalPages: Dispatch<SetStateAction<number | null>>
  countedTotalPagesRef: MutableRefObject<number | null>
  setProvenPageLimit: Dispatch<SetStateAction<number | null>>
  setTasksError: Dispatch<SetStateAction<string | null>>
  setFailedCount: Dispatch<SetStateAction<number>>
  setGithubUnavailable: Dispatch<SetStateAction<boolean>>
  setTasksLoading: Dispatch<SetStateAction<boolean>>
  taskRefreshNonce: number
  lastFetchedNonceRef: MutableRefObject<number>
  workItemsInvalidationNonce: number
  lastFetchedInvalidationNonceRef: MutableRefObject<number>
  hardRefreshEpochRef: MutableRefObject<number>
  landingGitHubRefreshKeysRef: MutableRefObject<ReadonlySet<string>>
  paginationGenerationRef: MutableRefObject<number>
  setPaginationLoading: Dispatch<SetStateAction<boolean>>
  setLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  fetchWorkItemsNextPage: AppState['fetchWorkItemsNextPage']
  fetchWorkItemsAcrossRepos: AppState['fetchWorkItemsAcrossRepos']
  countWorkItemsAcrossRepos: AppState['countWorkItemsAcrossRepos']
  retryingSourceKeys: ReadonlySet<string>
  selectedReposKey: string
}): void {
  useEffect(() => {
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
      ? { items: liveTargetItems, cachedAt: Date.now() }
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
    const landingPages: GitHubPages = Array.from({ length: targetPage + 1 }, () => null)
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
          settleGitHubRestoredPage({
            cancelled,
            paginationGeneration: paginationGenerationRef.current,
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
          })
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
      ...(forcedFetch ? { requireComplete: true } : {})
    })
      .then(
        ({
          items,
          failedCount: failed,
          githubUnavailable: unavailable,
          requestFailureCount = 0
        }) => {
          settleGitHubListItemsSuccess({
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
          })
        }
      )
      .catch((err) => {
        settleGitHubListItemsFailure({
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
        })
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
    )
      .then(({ totalPages: countedPages }) => {
        settleGitHubListCount({
          cancelled,
          countedPages,
          countedTotalPagesRef,
          setCountedTotalPages
        })
      })
      .catch((err) => {
        console.error('Failed to count work items:', err)
      })

    return () => {
      cancelled = true
    }
    // Why: store selectors are stable (omit from deps); workItemsInvalidationNonce included so a preference flip re-dispatches.
    // selectedReposKey stands in for selectedRepos — the array gets a fresh
    // identity on every repos:changed event, and re-running this effect then
    // resets pagination mid-click (#11485). The key covers every repo field the
    // requests read.
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
}
