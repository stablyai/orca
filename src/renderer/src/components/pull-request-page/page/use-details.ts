import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { lookupGitHubWorkItemDetailsForSource } from '@/lib/github-work-item-source-lookup'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import {
  WORK_ITEM_DETAILS_FRESH_MS,
  WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE,
  getWorkItemDetailsCacheKey,
  subscribeWorkItemDetailsCache,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  workItemDetailsCacheGeneration
} from '../cache/work-item-details'

export function usePullRequestDetails(args: {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  issueSourcePreference: string | undefined
  canUseDetailsRepoContext: boolean
}): {
  details: GitHubWorkItemDetails | null
  loading: boolean
  error: string | null
  detailsLoaded: boolean
  detailsCacheKey: string | null
  appendOptimisticComment: (comment: PRComment) => void
} {
  const {
    workItem,
    repoPath,
    effectiveRepoId,
    sourceContext,
    issueSourcePreference,
    canUseDetailsRepoContext
  } = args
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

  // Why: hold optimistically-added comments so they merge into the fetch result instead of being overwritten.
  const optimisticCommentsRef = useRef<PRComment[]>([])
  // Reopen must retain optimistic comments absent from gh’s 60s cache; item switches clear them.
  const prevItemIdRef = useRef<string | null>(null)

  // Subscribe for synchronous cache paints; replaced entry identity keeps Map.get a stable snapshot.
  const cachedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(
      () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined),
      [detailsCacheKey]
    )
  )

  // Cold opens need a local tick to reveal optimistic comments; warm cache writes notify subscribers.
  const [optimisticTick, setOptimisticTick] = useState(0)

  // Merge optimistic comments only when stable cached-entry identity or explicit cold-open state changes.
  const details = useMemo<GitHubWorkItemDetails | null>(() => {
    const cachedDetails = cachedEntry?.details ?? null
    const opt = optimisticCommentsRef.current
    if (!cachedDetails) {
      // Build a minimal shell while cold-loading so just-posted comments are visible immediately.
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
    // Why: optimisticTick isn't read in the body but is the rerender signal for cold-open writes (memo reads a ref); removing it breaks the optimistic shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedEntry, workItem, optimisticTick])

  const loading = !!cachedEntry?.pending && !cachedEntry?.details
  const error = cachedEntry?.error && !cachedEntry?.details ? cachedEntry.error : null
  const detailsLoaded = Boolean(cachedEntry?.details)

  // Cross-window invalidation can drop an open entry without changing fetch dependencies; trigger refetch explicitly.
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
    // Preserve optimistic comments on reopen while gh’s 60s cache still omits them; clear on actual item switches.
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

    // Share the pending promise across rapid reopen so gh subprocesses cannot race.
    const inflight: Promise<GitHubWorkItemDetails | null> =
      cached?.pending ??
      lookupGitHubWorkItemDetailsForSource({
        repoPath: repoPath ?? '',
        repoId: effectiveRepoId,
        sourceContext,
        number: workItem.number,
        type: workItem.type
      })

    // Why: snapshot the generation so a mid-flight invalidation (generation advance) blocks writing a stale result back.
    const launchedAtGeneration = workItemDetailsCacheGeneration.current

    if (!cached?.pending) {
      touchWorkItemDetailsCache(detailsCacheKey, {
        details: cached?.details ?? null,
        fetchedAt: cached?.fetchedAt ?? 0,
        pending: inflight,
        error: cached?.error
      })
    }

    inflight
      .then((result) => {
        const invalidatedMidFlight = workItemDetailsCacheGeneration.current !== launchedAtGeneration
        const prev = workItemDetailsCache.get(detailsCacheKey)
        if (invalidatedMidFlight && prev?.pending !== inflight) {
          // Why: entry was deliberately dropped (or later repopulated) — don't recreate or clobber it.
          return
        }
        // Why: null means unavailable/not found, not loaded empty content.
        if (result === null && prev?.details) {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: prev.details,
            fetchedAt: prev.fetchedAt,
            error: undefined
          })
        } else if (result === null) {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: null,
            fetchedAt: 0,
            error: WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE
          })
        } else {
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: result,
            fetchedAt: Date.now(),
            error: undefined
          })
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Failed to load details'
        const invalidatedMidFlight = workItemDetailsCacheGeneration.current !== launchedAtGeneration
        const prev = workItemDetailsCache.get(detailsCacheKey)
        if (invalidatedMidFlight && prev?.pending !== inflight) {
          return
        }
        // Keep cached details on error; drop pending state for retry and show errors only without retained data.
        touchWorkItemDetailsCache(detailsCacheKey, {
          details: prev?.details ?? null,
          fetchedAt: prev?.fetchedAt ?? 0,
          error: message
        })
      })
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    detailsCacheKey,
    refetchTick
  ])

  const appendOptimisticComment = useCallback(
    (comment: PRComment) => {
      // Why: skip refreshDetails() — gh api --cache 60s returns stale data that would overwrite the optimistic comment.
      optimisticCommentsRef.current.push(comment)
      // Notify through cache writes and expire fetchedAt so reopening refreshes server-side fields.
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
      // Cold-loading cache has no details to patch/notify; tick the optimistic shell instead.
      setOptimisticTick((n) => n + 1)
    },
    [detailsCacheKey]
  )

  return { details, loading, error, detailsLoaded, detailsCacheKey, appendOptimisticComment }
}
