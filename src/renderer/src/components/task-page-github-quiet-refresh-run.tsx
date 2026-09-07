import type { TaskPageGitHubQuietRefreshPreludeModel } from './use-task-page-github-quiet-refresh'
import {
  getOrCreateQuietRevalidateState,
  taskPageGitHubItemKey,
  getTaskPageGitHubConfirmedAuthorityItemKeys
} from '@/components/task-page-github-work-item-mutation-registry'
import {
  clearTaskPageGitHubAuthorityAbsentFromLoadedItems,
  isTaskPageQuietRevalidateScopeCurrent,
  isTaskPageQuietRevalidateRunCurrent,
  getTaskPageGitHubRevalidatableAuthorityItemKeys,
  reapplyPendingTaskPageGitHubMutationsToCache,
  processTaskPageQuietRevalidateSettle,
  reconcileTaskPagePagesAfterQuietRefresh,
  getTaskPageQuietRevalidateBackoffAttempt,
  LAG_WALL_BUDGET_MS,
  MAX_LAG_TRAILS,
  LAG_BACKOFF_MS
} from '@/components/task-page-github-work-item-mutations'
import {
  beginTaskPageQuietRevalidateRun,
  finishTaskPageQuietRevalidateRun
} from '@/components/task-page-github-work-item-quiet-state'
import { stripRepoQualifiers } from '../../../shared/task-query'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { taskPageToGitHubApiPage } from '@/components/task-page-work-item-pagination'
import { useAppStore } from '@/store'
export function runTaskPageGitHubQuietRefresh(model: TaskPageGitHubQuietRefreshPreludeModel) {
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
  const quietState = getOrCreateQuietRevalidateState(githubWorkItemMutationQueryKey)
  const loadedItemKeys = new Set(
    pagesRef.current.flatMap((page) =>
      (page ?? []).map((item) => taskPageGitHubItemKey(item.repoId, item.id))
    )
  )
  clearTaskPageGitHubAuthorityAbsentFromLoadedItems(loadedItemKeys)
  if (getTaskPageGitHubConfirmedAuthorityItemKeys().size === 0) {
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
      githubWorkItemMutationQueryKey,
      scopeGeneration
    )
  const isCurrentScope = (): boolean =>
    isTaskPageQuietRevalidateRunCurrent(
      quietRevalidateScopeRef.current,
      githubWorkItemMutationQueryKey,
      scopeGeneration,
      hardRefreshEpoch,
      hardRefreshEpochRef.current
    )
  const q = stripRepoQualifiers(appliedTaskSearch.trim())
  const authorityItemKeys = getTaskPageGitHubRevalidatableAuthorityItemKeys(
    githubWorkItemMutationQueryKey
  )
  const authorityPage = pages.findIndex((page) =>
    page?.some((item) => authorityItemKeys.has(taskPageGitHubItemKey(item.repoId, item.id)))
  )
  const quietPage = authorityPage !== -1 ? authorityPage : currentPage
  const visiblePage = currentPage > quietPage ? currentPage : undefined
  const pageItemKeys = (page: number): Set<string> =>
    new Set((pages[page] ?? []).map((item) => taskPageGitHubItemKey(item.repoId, item.id)))
  const authorityPageItemKeys = pageItemKeys(quietPage)
  const visiblePageItemKeys = visiblePage === undefined ? undefined : pageItemKeys(visiblePage)
  const revalidatedItemKeys = new Set([...authorityPageItemKeys, ...(visiblePageItemKeys ?? [])])
  const repoArgs = selectedRepos.map((r) => ({
    repoId: r.id,
    path: r.path,
    executionHostId: r.executionHostId,
    sourceContext: getTaskPageRepoSourceContext(r, 'github')
  }))
  const sourceContextByRepoId = new Map(repoArgs.map((r) => [r.repoId, r.sourceContext] as const))
  const fetchQuietPage = (page: number): Promise<GitHubWorkItem[]> =>
    page === 0
      ? fetchWorkItemsAcrossRepos(repoArgs, githubPerRepoPageLimit, githubPageSize, q, {
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
      // Why: skip renderer state writes after unmount, but still let .finally
      // settle the shared quietState so a queued trailing is never stranded.
      if (!quietRevalidateMountedRef.current || !isCurrentScope()) {
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
          (pagesRef.current[latestVisiblePage] ?? []).map((item) =>
            taskPageGitHubItemKey(item.repoId, item.id)
          )
        )
        fetchedVisiblePageItemKeys = latestVisiblePageItemKeys
        fetchedVisibleItems = await fetchQuietPage(latestVisiblePage)
        for (const itemKey of latestVisiblePageItemKeys) {
          revalidatedItemKeys.add(itemKey)
        }
        if (!quietRevalidateMountedRef.current || !isCurrentScope()) {
          return
        }
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
          : new Set(
              (pagesRef.current[liveVisiblePage] ?? []).map((item) =>
                taskPageGitHubItemKey(item.repoId, item.id)
              )
            )
      quietState.networkFailureAttempts = 0
      const revalidatedItems = [
        ...authorityItems,
        ...(visibleItems ?? []),
        ...(fetchedVisiblePage === visiblePage ? [] : (fetchedVisibleItems ?? []))
      ]
      reapplyPendingTaskPageGitHubMutationsToCache({
        items: revalidatedItems,
        patchWorkItem: useAppStore.getState().patchWorkItem,
        sourceContextByRepoId
      })
      const settle = processTaskPageQuietRevalidateSettle({
        queryKey: githubWorkItemMutationQueryKey,
        networkItems: revalidatedItems,
        patchWorkItem: useAppStore.getState().patchWorkItem,
        sourceContextByRepoId,
        revalidatedItemKeys
      })
      const networkItemKeys = new Set(
        authorityItems.map((item) => taskPageGitHubItemKey(item.repoId, item.id))
      )
      const visibleNetworkItemKeys = new Set(
        (liveVisibleItems ?? []).map((item) => taskPageGitHubItemKey(item.repoId, item.id))
      )
      const fetchedVisibleNetworkItemKeys = new Set(
        (fetchedVisibleItems ?? []).map((item) => taskPageGitHubItemKey(item.repoId, item.id))
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
      setPages(reconciledPages)
      const attempts = getTaskPageQuietRevalidateBackoffAttempt(quietState.lagSkipAttempts.values())
      const wallExceeded =
        quietState.lastConfirmAt > 0 && Date.now() - quietState.lastConfirmAt > LAG_WALL_BUDGET_MS
      // Why: a new mutation confirmed while this fetch was in flight (queued) is
      // fresh work and must always revalidate — only lag *retries* (needTrailing)
      // are bounded by attempts/wall so a stuck server can't spin forever.
      const hasQueuedWork =
        quietState.trailingQueued ||
        [...getTaskPageGitHubRevalidatableAuthorityItemKeys(githubWorkItemMutationQueryKey)].some(
          (itemKey) =>
            !revalidatedItemKeys.has(itemKey) &&
            pages.some((page) =>
              page?.some((item) => taskPageGitHubItemKey(item.repoId, item.id) === itemKey)
            )
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
      if (
        !finishTaskPageQuietRevalidateRun(
          quietState,
          quietRevalidateOwnerRef.current,
          quietRunGeneration
        )
      ) {
        return
      }
      // Why: drain a trailing queued from the shared quietState — not the old
      // per-render cancelled flag, which stranded the retry when a new nonce
      // arrived mid-flight. Gate the renderer bump on mount only.
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
}
