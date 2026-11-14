import { projectPRCheckOwner } from '../../../../../shared/github/checks/complete-pr-check-owner'
import { useAppStore } from '@/store'
import { useGitHubItemTargetContext } from './github-work-item-target-context'
import {
  GitHubWorkItemTargetError,
  matchesGitHubWorkItemTarget
} from '../../../../../shared/github/work-items/work-item-target'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useGitHubTaskItems } from '@/hooks/useGitHubTaskItems'
import { useGitHubTaskRefresh } from './use-github-task-refresh'
import { addressedGitHubIssueItem } from '@/lib/work-items/github/github-task-target'
import {
  normalizeItemDialogTab,
  type ItemDialogTab
} from '@/components/github/github-work-item-identity'
import type { PRComment } from '../../../../../shared/github/comments/comment-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-items/work-item-types'
import type { GitHubWorkItemDetailsArgs } from './github-item-dialog-types'
import {
  invalidateWorkItemDetailsCacheByMatch,
  invalidateWorkItemDetailsCacheForKey,
  subscribeWorkItemDetailsCache,
  withWorkItemDetailsItem,
  workItemDetailsCache,
  optimisticWorkItemComments,
  settleWorkItemComment,
  EMPTY_VIEWED_PATHS
} from './work-item-details-cache'
import {
  loadOrdinaryWorkItemDetails,
  ensureWorkItemDetailsFetch,
  getAcceptedWorkItemDetails
} from './work-item-details-fetch-settle'
import { syncPRFileViewedState } from './pr-file-viewed-change'

export function useGitHubWorkItemDetails({
  workItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  initialTab,
  projectOrigin,
  onReviewRequestsChange,
  onRefreshAccepted
}: GitHubWorkItemDetailsArgs) {
  const [tab, setTab] = useState<ItemDialogTab>(() => normalizeItemDialogTab(workItem, initialTab))

  const {
    binding,
    resource,
    detailsCacheKey,
    canUseDetailsRepoContext,
    operationTarget,
    expectedGhAccount,
    ...refresh
  } = useGitHubTaskRefresh({
    workItem,
    repoPath,
    effectiveRepoId,
    sourceContext,
    projectOrigin,
    onAccepted: onRefreshAccepted
  })

  // Why: reset during render so an item switch never paints the previous item's tab.
  const tabResetKey =
    workItem && effectiveRepoId && detailsCacheKey && canUseDetailsRepoContext
      ? `${detailsCacheKey}\0${initialTab ?? ''}`
      : null
  const [resolvedTabKey, setResolvedTabKey] = useState(tabResetKey)
  if (resolvedTabKey !== tabResetKey) {
    setResolvedTabKey(tabResetKey)
    if (workItem && tabResetKey) {
      setTab(normalizeItemDialogTab(workItem, initialTab))
    }
  }

  // Retain pre-fetch comments so the arriving detail payload cannot overwrite them.
  // Preserve optimistic comments on reopen because gh’s cache may still omit them.

  const cachedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(
      () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined),
      [detailsCacheKey]
    )
  )

  // Depend on stable cache-entry identity rather than a freshly built optimistic array.
  const rawDetails = useMemo<GitHubWorkItemDetails | null>(() => {
    return getAcceptedWorkItemDetails({
      cachedEntry,
      resource,
      workItem,
      opt: detailsCacheKey ? (optimisticWorkItemComments.get(detailsCacheKey) ?? []) : []
    })
  }, [cachedEntry, workItem, detailsCacheKey, resource])

  const cache = useAppStore((s) => s.githubTaskCache)
  // The opened row and the loaded item both show the current record's facts; main's item lacks the row's repo.
  const taskItems = useMemo(
    () =>
      workItem
        ? [
            workItem,
            ...(rawDetails
              ? [projectPRCheckOwner(rawDetails.item, { ...workItem, ...rawDetails.item })]
              : [])
          ]
        : [],
    [workItem, rawDetails]
  )
  const projectedItems = useGitHubTaskItems(taskItems)
  const projectedWorkItem = workItem ? (projectedItems[0] ?? workItem) : null
  const details = useMemo(
    () =>
      rawDetails && projectedItems[1] && projectedItems[1] !== taskItems[1]
        ? withWorkItemDetailsItem(rawDetails, projectedItems[1])
        : rawDetails,
    [rawDetails, projectedItems, taskItems]
  )

  const invalidOpenedItem =
    !!workItem && (!resource || !matchesGitHubWorkItemTarget(workItem, resource))
  const rejectedCache =
    !!cachedEntry?.details &&
    !!resource &&
    !matchesGitHubWorkItemTarget(cachedEntry.details.item, resource)
  const loading = !!cachedEntry?.pending && !details
  const error =
    invalidOpenedItem || rejectedCache
      ? resource
        ? new GitHubWorkItemTargetError(resource).message
        : 'Unable to identify this GitHub item. Open it again from Tasks.'
      : cachedEntry?.error && !details
        ? cachedEntry.error
        : null
  const detailsLoaded = Boolean(details)

  // Invalidation keeps shown details without changing fetch dependencies; a tick starts the one owed read.
  const [refetchTick, setRefetchTick] = useState(0)
  useEffect(() => {
    if (
      workItem &&
      detailsCacheKey &&
      (!cachedEntry || (cachedEntry.rereadOwed && !cachedEntry.pending))
    ) {
      setRefetchTick((n) => n + 1)
    }
  }, [workItem, detailsCacheKey, cachedEntry])

  useEffect(() => {
    if (!workItem || !effectiveRepoId || !detailsCacheKey || !canUseDetailsRepoContext) {
      return
    }
    if (invalidOpenedItem) {
      return
    }
    ensureWorkItemDetailsFetch(
      detailsCacheKey,
      () =>
        loadOrdinaryWorkItemDetails(
          {
            repoPath: repoPath ?? '',
            repoId: effectiveRepoId,
            sourceContext,
            ownerRepo: resource?.repository,
            target: operationTarget,
            expectedGhAccount,
            item: workItem
          },
          cache,
          binding
        ),
      { target: resource, isCurrent: () => !binding || cache.current(binding) }
    )
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    detailsCacheKey,
    resource,
    operationTarget,
    expectedGhAccount,
    rejectedCache,
    invalidOpenedItem,
    refetchTick,
    binding,
    cache
  ])

  const addressedWorkItem = useMemo(
    () => (projectedWorkItem ? addressedGitHubIssueItem(projectedWorkItem, details?.item) : null),
    [projectedWorkItem, details?.item]
  )
  const displayWorkItem = useMemo<GitHubWorkItem | null>(() => {
    if (!workItem || !details?.item) {
      return projectedWorkItem
    }
    return projectPRCheckOwner(details.item, {
      ...projectedWorkItem,
      ...details.item,
      repoId: workItem.repoId,
      type: workItem.type,
      number: workItem.number,
      url: workItem.url,
      ...(resource?.type === 'pr' ? { prRepo: resource.repository } : {})
    })
  }, [details?.item, workItem, projectedWorkItem, resource])

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

  const pendingViewedPaths = cachedEntry?.viewed?.paths ?? EMPTY_VIEWED_PATHS
  const appendOptimisticComment = useCallback(
    (comment: PRComment) => {
      useAppStore.getState().recordFeatureInteraction('github-tasks')
      if (detailsCacheKey) {
        settleWorkItemComment(detailsCacheKey, comment)
      }
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

  const targetContext = useGitHubItemTargetContext({
    resource,
    effectiveRepoId,
    sourceContext
  })

  const handlePRFileViewedChange = useCallback(
    async (path: string, viewed: boolean): Promise<boolean> => {
      return syncPRFileViewedState({
        canUseDetailsRepoContext,
        pullRequestId: details?.pullRequestId,
        workItem: displayWorkItem,
        effectiveRepoId,
        detailsCacheKey,
        repoPath,
        sourceContext,
        projectOrigin,
        expectedGhAccount,
        target: operationTarget,
        path,
        viewed
      })
    },
    [
      canUseDetailsRepoContext,
      details?.pullRequestId,
      detailsCacheKey,
      projectOrigin,
      operationTarget,
      expectedGhAccount,
      repoPath,
      sourceContext,
      displayWorkItem,
      effectiveRepoId
    ]
  )

  const isIssuePage = workItem?.type === 'issue'

  return {
    targetContext,
    ...refresh,
    tab,
    setTab,
    canUseDetailsRepoContext,
    detailsCacheKey,
    details,
    loading,
    error,
    detailsLoaded,
    displayWorkItem,
    addressedWorkItem,
    appendOptimisticComment,
    invalidateCurrentDetailsCache,
    handlePRFileViewedChange,
    pendingViewedPaths,
    isIssuePage
  }
}
