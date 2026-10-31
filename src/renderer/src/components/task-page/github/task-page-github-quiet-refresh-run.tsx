import type { TaskPageGitHubQuietRefreshInput } from './task-page-github-delivery-inputs'
import { admitTaskPageGitHubListInputs } from './task-page-github-work-item-mutation-pages'

import { beginGitHubTaskRead } from '@/store/github/request-coordination'

import { taskPageGitHubAuthorityKeysForObservation } from './task-page-github-work-item-mutation-keys'

import {
  getOrCreateQuietRevalidateState,
  beginTaskPageQuietRevalidateRun,
  finishTaskPageQuietRevalidateRun
} from '@/components/task-page/github/task-page-github-work-item-quiet-state'

import { getTaskPageGitHubConfirmedAuthorities } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import {
  clearTaskPageGitHubAuthorityAbsentFromLoadedItems,
  getTaskPageGitHubRevalidatableAuthorityItemKeys
} from '@/components/task-page/github/task-page-github-work-item-authority-refresh'

import {
  isTaskPageQuietRevalidateScopeCurrent,
  isTaskPageQuietRevalidateRunCurrent,
  processTaskPageQuietRevalidateSettle,
  getTaskPageQuietRevalidateBackoffAttempt
} from '@/components/task-page/github/task-page-github-work-item-quiet-revalidate'

import {
  createTaskPageGitHubProjectionContext,
  reapplyPendingTaskPageGitHubMutationsToCache,
  deliverTaskPageGitHubRead,
  taskPageGitHubObservedRowKey,
  reconcileTaskPagePagesAfterQuietRefresh
} from '@/components/task-page/github/task-page-github-work-item-mutation-pages'

import {
  LAG_WALL_BUDGET_MS,
  MAX_LAG_TRAILS,
  LAG_BACKOFF_MS
} from '@/components/task-page/github/task-page-github-work-item-quiet-adopt'

import { stripRepoQualifiers } from '../../../../../shared/task-query'

import { getTaskPageRepoSourceContext } from '../task-page-source-context'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import { taskPageToGitHubApiPage } from '../../../../../shared/work-items'

import { useAppStore } from '@/store/index'

export function runTaskPageGitHubQuietRefresh(model: TaskPageGitHubQuietRefreshInput) {
  const {
    fetchWorkItemsAcrossRepos,
    selectedRepos,
    taskSource,
    githubMode,
    appliedTaskSearch,
    quietRefreshNonce,
    setQuietRefreshNonce,
    githubPerRepoPageLimit,
    githubPageSize,
    pages,
    setPages,
    currentPage,
    pagesRef,
    currentPageRef,
    hardRefreshEpochRef,
    fetchWorkItemsNextPage,
    githubWorkItemMutationQueryKey,
    quietRevalidateMountedRef,
    quietRevalidateOwnerRef,
    quietRevalidateScopeRef
  } = model
  if (quietRefreshNonce === 0) {
    return
  }
  if (taskSource !== 'github' || githubMode !== 'items' || selectedRepos.length === 0) {
    return
  }
  const context = createTaskPageGitHubProjectionContext(
    selectedRepos,
    model.appliedTaskQuery,
    githubWorkItemMutationQueryKey,
    model.githubViewerLogin
  )
  const authorityKeys = (item: GitHubWorkItem) =>
    taskPageGitHubAuthorityKeysForObservation(item, context.ownerOf?.(item))
  const quietState = getOrCreateQuietRevalidateState(githubWorkItemMutationQueryKey)
  const loadedItemKeys = new Set(
    pagesRef.current.flatMap((page) => (page ?? []).flatMap(authorityKeys))
  )
  clearTaskPageGitHubAuthorityAbsentFromLoadedItems(loadedItemKeys, context.owns)
  if (getTaskPageGitHubConfirmedAuthorities().length === 0) {
    return
  }
  const quietRunGeneration = beginTaskPageQuietRevalidateRun(
    quietState,
    quietRevalidateOwnerRef.current
  )
  if (quietRunGeneration === null) {
    return
  }
  quietState.fetchStartedAtGeneration = quietState.dirtyGeneration
  const scopeGeneration = quietRevalidateScopeRef.current.generation
  const hardRefreshEpoch = hardRefreshEpochRef.current
  const isCurrentQueryScope = (): boolean =>
    isTaskPageQuietRevalidateScopeCurrent(
      quietRevalidateScopeRef.current,
      githubWorkItemMutationQueryKey + model.selectedReposKey,
      scopeGeneration
    )
  const isCurrentScope = (): boolean =>
    isTaskPageQuietRevalidateRunCurrent(
      quietRevalidateScopeRef.current,
      githubWorkItemMutationQueryKey + model.selectedReposKey,
      scopeGeneration,
      hardRefreshEpoch,
      hardRefreshEpochRef.current
    )
  const q = stripRepoQualifiers(appliedTaskSearch.trim())
  const authorityItemKeys = getTaskPageGitHubRevalidatableAuthorityItemKeys(
    githubWorkItemMutationQueryKey
  )
  const authorityPage = pages.findIndex((page) =>
    page?.some((item) => authorityKeys(item).some((key) => authorityItemKeys.has(key)))
  )
  const quietPage = authorityPage !== -1 ? authorityPage : currentPage
  const visiblePage = currentPage > quietPage ? currentPage : undefined
  const pageItemKeys = (page: number): Set<string> =>
    new Set((pages[page] ?? []).flatMap(authorityKeys))
  const authorityPageItemKeys = pageItemKeys(quietPage)
  const visiblePageItemKeys = visiblePage === undefined ? undefined : pageItemKeys(visiblePage)
  const revalidatedItemKeys = new Set([...authorityPageItemKeys, ...(visiblePageItemKeys ?? [])])
  const repoArgs = selectedRepos.map((r) => ({
    repoId: r.id,
    path: r.path,
    executionHostId: r.executionHostId,
    sourceContext: getTaskPageRepoSourceContext(r, 'github')
  }))
  const read = beginGitHubTaskRead(repoArgs, undefined, { repos: selectedRepos })
  let cancelled = false
  const fetchQuietPage = (page: number): Promise<GitHubWorkItem[]> =>
    page === 0
      ? fetchWorkItemsAcrossRepos(repoArgs, githubPerRepoPageLimit, githubPageSize, q, {
          taskRead: read,
          force: true,
          noCache: true,
          requireComplete: true,
          allowStaleFallback: false
        }).then((result) => {
          if (result.failedCount > 0 || result.githubUnavailable) {
            throw new Error('GitHub quiet revalidate did not receive a fresh complete result.')
          }
          return result.items
        })
      : fetchWorkItemsNextPage(
          repoArgs,
          githubPerRepoPageLimit,
          githubPageSize,
          q,
          taskPageToGitHubApiPage(page),
          {
            taskRead: read,
            noCache: true,
            requireComplete: true
          }
        ).then((result) => {
          if (result.failedCount > 0 || result.errorTypes.length > 0) {
            throw new Error('GitHub quiet revalidate did not receive a complete page result.')
          }
          return result.items
        })
  const quietFetch = Promise.all([
    fetchQuietPage(quietPage),
    ...(visiblePage === undefined ? [] : [fetchQuietPage(visiblePage)])
  ]).then(([authorityItems, visibleItems]) => ({
    authorityItems,
    visibleItems
  }))
  let networkRetryDelay: number | null = null
  void quietFetch
    .then(async ({ authorityItems, visibleItems }) => {
      // Skip unmounted/stale renderer writes but settle shared quietState so trailing work cannot be stranded.
      if (cancelled || !quietRevalidateMountedRef.current || !isCurrentScope()) {
        return
      }
      let fetchedVisiblePage = visiblePage
      let fetchedVisibleItems = visibleItems
      let fetchedVisiblePageItemKeys = visiblePageItemKeys
      const latestVisiblePage =
        currentPageRef.current > quietPage ? currentPageRef.current : undefined
      if (latestVisiblePage !== undefined && latestVisiblePage !== fetchedVisiblePage) {
        fetchedVisiblePage = latestVisiblePage
        const latestVisiblePageItemKeys = new Set(
          (pagesRef.current[latestVisiblePage] ?? []).flatMap(authorityKeys)
        )
        fetchedVisiblePageItemKeys = latestVisiblePageItemKeys
        fetchedVisibleItems = await fetchQuietPage(latestVisiblePage)
        for (const itemKey of latestVisiblePageItemKeys) {
          revalidatedItemKeys.add(itemKey)
        }
        if (cancelled || !quietRevalidateMountedRef.current || !isCurrentScope()) {
          return
        }
      }
      const currentItems = pagesRef.current.flatMap((page) => page ?? [])
      authorityItems = read.apply(authorityItems, currentItems)
      if (visibleItems) {
        visibleItems = read.apply(visibleItems, currentItems)
      }
      if (fetchedVisibleItems) {
        fetchedVisibleItems = read.apply(fetchedVisibleItems, currentItems)
      }
      const liveVisiblePage =
        currentPageRef.current > quietPage ? currentPageRef.current : undefined
      const liveVisibleItems =
        liveVisiblePage === undefined
          ? undefined
          : liveVisiblePage === fetchedVisiblePage
            ? fetchedVisibleItems
            : (pagesRef.current[liveVisiblePage] ?? [])
      const liveVisiblePageItemKeys =
        liveVisiblePage === undefined
          ? undefined
          : new Set((pagesRef.current[liveVisiblePage] ?? []).flatMap(authorityKeys))
      quietState.networkFailureAttempts = 0
      const revalidatedItems = [
        ...authorityItems,
        ...(visibleItems ?? []),
        ...(fetchedVisiblePage === visiblePage ? [] : (fetchedVisibleItems ?? []))
      ]
      admitTaskPageGitHubListInputs(revalidatedItems, context)
      reapplyPendingTaskPageGitHubMutationsToCache({
        items: revalidatedItems,
        context,
        patchWorkItems: useAppStore.getState().patchWorkItems
      })
      const settle = processTaskPageQuietRevalidateSettle({
        queryKey: githubWorkItemMutationQueryKey,
        networkItems: revalidatedItems,
        patchWorkItems: useAppStore.getState().patchWorkItems,
        revalidatedItemKeys
      })
      const networkItemKeys = new Set(authorityItems.flatMap(authorityKeys))
      const visibleNetworkItemKeys = new Set((liveVisibleItems ?? []).flatMap(authorityKeys))
      const fetchedVisibleNetworkItemKeys = new Set(
        (fetchedVisibleItems ?? []).flatMap(authorityKeys)
      )
      const membershipChanged =
        networkItemKeys.size !== authorityPageItemKeys.size ||
        [...networkItemKeys].some((key) => !authorityPageItemKeys.has(key)) ||
        (fetchedVisiblePageItemKeys !== undefined &&
          (fetchedVisibleNetworkItemKeys.size !== fetchedVisiblePageItemKeys.size ||
            [...fetchedVisibleNetworkItemKeys].some(
              (key) => !fetchedVisiblePageItemKeys.has(key)
            ))) ||
        (liveVisiblePageItemKeys !== undefined &&
          (visibleNetworkItemKeys.size !== liveVisiblePageItemKeys.size ||
            [...visibleNetworkItemKeys].some((key) => !liveVisiblePageItemKeys.has(key))))
      const reconciledPages = reconcileTaskPagePagesAfterQuietRefresh({
        pages: pagesRef.current,
        queryKey: githubWorkItemMutationQueryKey,
        context,
        authorityPage: quietPage,
        authorityItems,
        membershipChanged,
        ...(liveVisiblePage === undefined || liveVisibleItems === undefined
          ? {}
          : {
              visiblePage: liveVisiblePage,
              visibleItems: liveVisibleItems
            })
      })
      pagesRef.current = reconciledPages
      const authorityRows = new Set(authorityItems.map(taskPageGitHubObservedRowKey))
      const visibleKeys = new Set(liveVisibleItems?.map(taskPageGitHubObservedRowKey))
      deliverTaskPageGitHubRead(
        read,
        [...authorityItems, ...(liveVisibleItems ?? [])],
        setPages,
        pagesRef,
        context,
        (current, rows, materialize) => {
          const next = [...current]
          const lastPage = liveVisiblePage ?? quietPage
          while (next.length <= lastPage) {
            next.push(null)
          }
          next[quietPage] = materialize(
            rows.filter((row) => authorityRows.has(taskPageGitHubObservedRowKey(row))),
            current[quietPage] ?? []
          )
          if (liveVisiblePage !== undefined && liveVisibleItems !== undefined) {
            if (membershipChanged) {
              for (let page = quietPage + 1; page < liveVisiblePage; page++) {
                next[page] = null
              }
            }
            next[liveVisiblePage] = materialize(
              rows.filter((row) => visibleKeys.has(taskPageGitHubObservedRowKey(row))),
              current[liveVisiblePage] ?? []
            )
          }
          if (membershipChanged) {
            next.length = lastPage + 1
          }
          return next
        }
      )
      const attempts = getTaskPageQuietRevalidateBackoffAttempt(quietState.lagSkipAttempts.values())
      const wallExceeded =
        quietState.lastConfirmAt > 0 && Date.now() - quietState.lastConfirmAt > LAG_WALL_BUDGET_MS
      // Always revalidate new queued mutations; attempt/time budgets bound lag retries only.
      const currentLoadedKeys = new Set(
        pagesRef.current.flatMap((page) => (page ?? []).flatMap(authorityKeys))
      )
      const hasQueuedWork =
        quietState.trailingQueued ||
        [...getTaskPageGitHubRevalidatableAuthorityItemKeys(githubWorkItemMutationQueryKey)].some(
          (key) => !revalidatedItemKeys.has(key) && currentLoadedKeys.has(key)
        )
      quietState.trailingQueued = false
      const lagTrail = settle.needTrailing && attempts < MAX_LAG_TRAILS && !wallExceeded
      if ((hasQueuedWork || lagTrail) && quietRevalidateMountedRef.current) {
        const delay = hasQueuedWork
          ? 0
          : (LAG_BACKOFF_MS[Math.min(attempts, LAG_BACKOFF_MS.length - 1)] ?? 500)
        window.setTimeout(() => {
          if (quietRevalidateMountedRef.current && isCurrentScope()) {
            setQuietRefreshNonce((current) => current + 1)
          }
        }, delay)
      }
    })
    .catch((err) => {
      // Quiet revalidate soft-fails; keep optimistic/sticky state.
      console.error('Quiet GitHub work-item revalidate failed:', err)
      if (quietRevalidateMountedRef.current && isCurrentScope()) {
        quietState.networkFailureAttempts += 1
        if (quietState.networkFailureAttempts <= 2) {
          networkRetryDelay =
            LAG_BACKOFF_MS[quietState.networkFailureAttempts - 1] ?? LAG_BACKOFF_MS[0]
        }
      }
    })
    .finally(() => {
      read.finish()
      if (
        !finishTaskPageQuietRevalidateRun(
          quietState,
          quietRevalidateOwnerRef.current,
          quietRunGeneration
        )
      ) {
        return
      }
      // Drain shared trailing work despite nonce changes; update the renderer only while this query remains mounted/current.
      if (quietState.trailingQueued && quietRevalidateMountedRef.current && isCurrentQueryScope()) {
        quietState.trailingQueued = false
        setQuietRefreshNonce((current) => current + 1)
      } else if (
        networkRetryDelay !== null &&
        quietRevalidateMountedRef.current &&
        isCurrentScope()
      ) {
        window.setTimeout(() => {
          if (quietRevalidateMountedRef.current && isCurrentScope()) {
            setQuietRefreshNonce((current) => current + 1)
          }
        }, networkRetryDelay)
      }
    })
  return () => {
    cancelled = true
    read.dispose()
  }
}
