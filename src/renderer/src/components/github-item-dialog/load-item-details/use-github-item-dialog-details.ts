import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { lookupGitHubWorkItemDetailsForSource } from '@/lib/github-work-item-source-lookup'
import { canUseGitHubRepoContext } from '@/lib/github-source-runtime-context'
import {
  normalizeItemDialogTab,
  parseOwnerRepoFromItemUrl,
  type ItemDialogTab
} from '@/components/github/github-work-item-identity'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'
import {
  WORK_ITEM_DETAILS_FRESH_MS,
  getWorkItemDetailsCacheKey,
  invalidateWorkItemDetailsCacheByMatch,
  invalidateWorkItemDetailsCacheForKey,
  subscribeWorkItemDetailsCache,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  workItemDetailsCacheGeneration
} from './work-item-details-cache'
import { settleWorkItemDetailsFetch } from './work-item-details-fetch-settle'
import { syncPRFileViewedState } from './pr-file-viewed-change'

export function useGitHubItemDialogDetails({
  workItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  initialTab,
  projectOrigin,
  onReviewRequestsChange
}: {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  initialTab?: ItemDialogTab
  projectOrigin?: GitHubItemDialogProjectOrigin
  onReviewRequestsChange?: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
}) {
  const [tab, setTab] = useState<ItemDialogTab>(() => normalizeItemDialogTab(workItem, initialTab))

  // Include source preference so origin/upstream switches cannot reuse details from the wrong repository.
  const issueSourcePreference = useAppStore((s) => {
    if (!repoPath && !effectiveRepoId) {
      return undefined
    }
    return s.repos.find((r) => (effectiveRepoId ? r.id === effectiveRepoId : r.path === repoPath))
      ?.issueSourcePreference
  })
  const canUseDetailsRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const issueRepository = useMemo(
    () =>
      workItem?.type === 'issue'
        ? (projectOrigin ?? parseOwnerRepoFromItemUrl(workItem.url))
        : null,
    [projectOrigin, workItem]
  )
  const detailsCacheKey = useMemo(() => {
    if (!workItem || !effectiveRepoId || !canUseDetailsRepoContext) {
      return null
    }
    return getWorkItemDetailsCacheKey({
      repoPath: repoPath ?? '',
      repoId: effectiveRepoId,
      issueSourcePreference,
      sourceContext,
      sourceCacheScope:
        sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null,
      type: workItem.type,
      number: workItem.number,
      ownerRepo: issueRepository
    })
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    issueSourcePreference,
    issueRepository
  ])

  // Why: reset during render so an item switch never paints the previous item's tab.
  const tabResetKey =
    workItem && effectiveRepoId && detailsCacheKey && canUseDetailsRepoContext
      ? `${workItem.id}\0${initialTab ?? ''}`
      : null
  const [resolvedTabKey, setResolvedTabKey] = useState(tabResetKey)
  if (resolvedTabKey !== tabResetKey) {
    setResolvedTabKey(tabResetKey)
    if (workItem && tabResetKey) {
      setTab(normalizeItemDialogTab(workItem, initialTab))
    }
  }

  // Retain pre-fetch comments so the arriving detail payload cannot overwrite them.
  const optimisticCommentsRef = useRef(new Map<string, PRComment[]>())
  // Preserve optimistic comments on reopen because gh’s cache may still omit them.
  const prevItemIdRef = useRef<string | null>(null)

  const cachedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(
      () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined),
      [detailsCacheKey]
    )
  )

  // Wake the details memo on cold-open comment writes before a cache entry exists.
  const [optimisticTick, setOptimisticTick] = useState(0)

  // Depend on stable cache-entry identity rather than a freshly built optimistic array.
  const details = useMemo<GitHubWorkItemDetails | null>(() => {
    const cachedDetails = cachedEntry?.details ?? null
    const opt = optimisticCommentsRef.current.get(detailsCacheKey ?? '') ?? []
    if (!cachedDetails) {
      // Show pre-fetch optimistic comments in a minimal shell while full details load.
      if (opt.length > 0 && workItem) {
        return { item: workItem, body: '', comments: [...opt] }
      }
      return null
    }
    if (opt.length === 0) {
      return cachedDetails
    }
    const ids = new Set(cachedDetails.comments.map((c) => c.id))
    const missing = opt.filter((c) => !ids.has(c.id))
    if (missing.length === 0) {
      return cachedDetails
    }
    return {
      ...cachedDetails,
      comments: [...cachedDetails.comments, ...missing]
    }
    // Why: optimisticTick forces this ref-reading memo to re-run on cold-open writes; lint can't see the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedEntry, workItem, detailsCacheKey, optimisticTick])

  const loading = !!cachedEntry?.pending && !cachedEntry?.details
  const error = cachedEntry?.error && !cachedEntry?.details ? cachedEntry.error : null
  const detailsLoaded = Boolean(cachedEntry?.details)

  // Invalidation can remove an open entry without changing fetch dependencies; a tick forces refetch.
  const [refetchTick, setRefetchTick] = useState(0)
  useEffect(() => {
    if (workItem && detailsCacheKey && !cachedEntry) {
      setRefetchTick((n) => n + 1)
    }
  }, [workItem, detailsCacheKey, cachedEntry])

  useEffect(() => {
    if (!workItem || !effectiveRepoId || !detailsCacheKey || !canUseDetailsRepoContext) {
      return
    }
    // Clear on item switches only; gh’s cache can still omit comments when reopening the same item.
    if (workItem.id !== prevItemIdRef.current) {
      optimisticCommentsRef.current.clear()
    }
    prevItemIdRef.current = workItem.id

    const cached = workItemDetailsCache.get(detailsCacheKey)
    const now = Date.now()
    const hasFreshData = cached?.details && now - cached.fetchedAt <= WORK_ITEM_DETAILS_FRESH_MS

    if (hasFreshData) {
      return
    }

    // Share concurrent fetches for this key instead of racing gh subprocesses.
    const inflight: Promise<GitHubWorkItemDetails | null> =
      cached?.pending ??
      lookupGitHubWorkItemDetailsForSource({
        repoPath: repoPath ?? '',
        repoId: effectiveRepoId,
        sourceContext,
        number: workItem.number,
        type: workItem.type,
        ownerRepo: issueRepository
      })

    // Snapshot invalidation generation so pre-mutation results cannot restore stale cache data.
    const launchedAtGeneration = workItemDetailsCacheGeneration

    if (!cached?.pending) {
      touchWorkItemDetailsCache(detailsCacheKey, {
        details: cached?.details ?? null,
        fetchedAt: cached?.fetchedAt ?? 0,
        pending: inflight,
        error: cached?.error
      })
    }

    settleWorkItemDetailsFetch({ detailsCacheKey, inflight, launchedAtGeneration })
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    detailsCacheKey,
    issueRepository,
    refetchTick
  ])

  const displayWorkItem = useMemo<GitHubWorkItem | null>(() => {
    if (!workItem) {
      return null
    }
    if (!details?.item) {
      return workItem
    }
    return { ...workItem, ...details.item, repoId: workItem.repoId }
  }, [details?.item, workItem])

  useEffect(() => {
    if (!workItem || details?.item.reviewRequests === undefined) {
      return
    }
    // Refresh list-side reviewer metadata from the fresher detail response.
    onReviewRequestsChange?.(
      { id: workItem.id, repoId: workItem.repoId },
      details.item.reviewRequests
    )
  }, [details?.item.reviewRequests, onReviewRequestsChange, workItem])

  const [pendingViewedPaths, setPendingViewedPaths] = useState<Set<string>>(() => new Set())

  const appendOptimisticComment = useCallback(
    (comment: PRComment) => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      // Do not refetch immediately: gh’s cache could overwrite the new optimistic comment.
      const optimisticKey = detailsCacheKey ?? ''
      const optimisticComments = optimisticCommentsRef.current.get(optimisticKey) ?? []
      optimisticCommentsRef.current.set(optimisticKey, [...optimisticComments, comment])
      // Notify concurrent drawers through the cache; mark stale so reopening fetches server fields.
      if (detailsCacheKey) {
        const prev = workItemDetailsCache.get(detailsCacheKey)
        if (prev?.details) {
          const ids = new Set(prev.details.comments.map((c) => c.id))
          if (!ids.has(comment.id)) {
            touchWorkItemDetailsCache(detailsCacheKey, {
              details: {
                ...prev.details,
                comments: [...prev.details.comments, comment]
              },
              fetchedAt: 0,
              error: undefined
            })
            return
          }
        }
      }
      // Without a cache entry to notify subscribers, wake the memo through local state.
      setOptimisticTick((n) => n + 1)
    },
    [detailsCacheKey]
  )

  const invalidateCurrentDetailsCache = useCallback((): void => {
    if (!workItem) {
      return
    }
    // Invalidate all source variants for local repos; runtime-only entries require their exact scoped key.
    if (repoPath) {
      invalidateWorkItemDetailsCacheByMatch({
        repoPath,
        repoId: effectiveRepoId ?? undefined,
        type: workItem.type,
        number: workItem.number
      })
      return
    }
    if (detailsCacheKey) {
      invalidateWorkItemDetailsCacheForKey(detailsCacheKey)
    }
  }, [detailsCacheKey, effectiveRepoId, repoPath, workItem])

  const handlePRFileViewedChange = useCallback(
    async (path: string, viewed: boolean): Promise<boolean> =>
      syncPRFileViewedState({
        canUseDetailsRepoContext,
        pullRequestId: details?.pullRequestId,
        workItem,
        detailsCacheKey,
        repoPath,
        sourceContext,
        projectOrigin,
        path,
        viewed,
        setPendingViewedPaths
      }),
    [
      canUseDetailsRepoContext,
      details?.pullRequestId,
      detailsCacheKey,
      projectOrigin,
      repoPath,
      sourceContext,
      workItem
    ]
  )

  const isIssuePage = workItem?.type === 'issue'

  return {
    tab,
    setTab,
    canUseDetailsRepoContext,
    detailsCacheKey,
    details,
    loading,
    error,
    detailsLoaded,
    displayWorkItem,
    appendOptimisticComment,
    invalidateCurrentDetailsCache,
    handlePRFileViewedChange,
    pendingViewedPaths,
    isIssuePage
  }
}
