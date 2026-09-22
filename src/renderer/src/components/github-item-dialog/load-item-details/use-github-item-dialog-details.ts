import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { lookupGitHubWorkItemDetailsForSource } from '@/lib/github-work-item-source-lookup'
import { canUseGitHubRepoContext } from '@/lib/github-source-runtime-context'
import {
  normalizeItemDialogTab,
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

  // Why: the cache key must include issue source preference so toggling origin/upstream for the same issue number doesn't read the wrong repo's details.
  const issueSourcePreference = useAppStore((s) => {
    if (!repoPath && !effectiveRepoId) {
      return undefined
    }
    return s.repos.find((r) => (effectiveRepoId ? r.id === effectiveRepoId : r.path === repoPath))
      ?.issueSourcePreference
  })
  const canUseDetailsRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const detailsCacheKey = useMemo(() => {
    if (!workItem || !effectiveRepoId || !canUseDetailsRepoContext) {
      return null
    }
    return getWorkItemDetailsCacheKey({
      repoPath: repoPath ?? '',
      repoId: effectiveRepoId,
      issueSourcePreference,
      sourceCacheScope:
        sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null,
      type: workItem.type,
      number: workItem.number
    })
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    issueSourcePreference
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

  // Why: hold comments added before the detail fetch resolves so they merge into the result instead of being overwritten.
  const optimisticCommentsRef = useRef<PRComment[]>([])
  // Why: distinguish "reopen same item" from "switch item" — reopen must keep optimistic comments since gh's 60s cache omits the just-posted one.
  const prevItemIdRef = useRef<string | null>(null)

  // Why: subscribe to the module-level cache so reopening a cached item paints synchronously on first render.
  const cachedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(
      () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined),
      [detailsCacheKey]
    )
  )

  // Why: bumped on cold open (no cached details yet) so the details memo re-runs and surfaces the optimistic comment before the fetch lands.
  const [optimisticTick, setOptimisticTick] = useState(0)

  // Why: key off cachedEntry identity (stable), not the optimistic ref array (fresh each render), to avoid needless recompute.
  const details = useMemo<GitHubWorkItemDetails | null>(() => {
    const cachedDetails = cachedEntry?.details ?? null
    const opt = optimisticCommentsRef.current
    if (!cachedDetails) {
      // Why: on cold open, details may still be loading — surface optimistic comments via a minimal shell so a pre-fetch comment isn't invisible.
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
  }, [cachedEntry, workItem, optimisticTick])

  const loading = !!cachedEntry?.pending && !cachedEntry?.details
  const error = cachedEntry?.error && !cachedEntry?.details ? cachedEntry.error : null
  const detailsLoaded = Boolean(cachedEntry?.details)

  // Why: if a cross-window mutation invalidates the open drawer's entry (cachedEntry undefined, fetch deps unchanged), bump a tick to force the refetch.
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
    // Why: clear optimistic comments only on item switch — on reopen, gh's 60s cache omits the just-posted comment, so keep the ref to re-merge.
    if (workItem.id !== prevItemIdRef.current) {
      optimisticCommentsRef.current = []
    }
    prevItemIdRef.current = workItem.id

    const cached = workItemDetailsCache.get(detailsCacheKey)
    const now = Date.now()
    const hasFreshData = cached?.details && now - cached.fetchedAt <= WORK_ITEM_DETAILS_FRESH_MS

    if (hasFreshData) {
      return
    }

    // Why: dedupe concurrent opens for the same key — share one in-flight promise instead of racing two `gh` subprocesses.
    const inflight: Promise<GitHubWorkItemDetails | null> =
      cached?.pending ??
      lookupGitHubWorkItemDetailsForSource({
        repoPath: repoPath ?? '',
        repoId: effectiveRepoId,
        sourceContext,
        number: workItem.number,
        type: workItem.type
      })

    // Why: snapshot the invalidation generation; if it advances before resolve, a mid-flight mutation invalidated the entry — don't write back.
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
    // Why: PR details can carry fresher reviewer metadata than the list row; push it back so the Tasks review chip isn't stale.
    onReviewRequestsChange?.(
      { id: workItem.id, repoId: workItem.repoId },
      details.item.reviewRequests
    )
  }, [details?.item.reviewRequests, onReviewRequestsChange, workItem])

  const [pendingViewedPaths, setPendingViewedPaths] = useState<Set<string>>(() => new Set())

  const appendOptimisticComment = useCallback(
    (comment: PRComment) => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      // Why: skip refreshDetails() — gh's 60s cache would overwrite the optimistic comment; next open picks up the server version.
      optimisticCommentsRef.current.push(comment)
      // Why: write through the module cache so concurrent drawers re-render; mark fetchedAt stale (0) so next open refetches server fields.
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
      // Why: no cache write fires while details are still loading; bump local state so the memo re-runs and shows the optimistic comment.
      setOptimisticTick((n) => n + 1)
    },
    [detailsCacheKey]
  )

  const invalidateCurrentDetailsCache = useCallback((): void => {
    if (!workItem) {
      return
    }
    // Why: local repos invalidate all source-pref variants; runtime-only entries need their exact source-scoped key (no local path).
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
