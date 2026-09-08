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
  // Why: track last fetched item to distinguish reopen from switch — reopen must preserve optimistic comments since gh's 60s cache omits the just-posted one.
  const prevItemIdRef = useRef<string | null>(null)

  // Why: subscribe to the module cache so reopening a cached item paints synchronously; writes replace entry identity (delete+set), so Map.get is a stable snapshot.
  const cachedEntry = useSyncExternalStore(
    subscribeWorkItemDetailsCache,
    useCallback(
      () => (detailsCacheKey ? workItemDetailsCache.get(detailsCacheKey) : undefined),
      [detailsCacheKey]
    )
  )

  // Why: bumped on cold open (no cached details) so the details memo re-runs and surfaces the optimistic comment via the loading shell; cache-notify handles the warm case.
  const [optimisticTick, setOptimisticTick] = useState(0)

  // Why: merge optimistic comments into cached details; keyed off stable cachedEntry identity (not the per-render ref array) to avoid needless recompute.
  const details = useMemo<GitHubWorkItemDetails | null>(() => {
    const cachedDetails = cachedEntry?.details ?? null
    const opt = optimisticCommentsRef.current
    if (!cachedDetails) {
      // Why: on a cold open details may still be loading; surface optimistic comments via a minimal shell so a just-posted comment isn't held invisibly in the ref.
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

  // Why: if a cross-window mutation invalidates the open drawer's entry (cachedEntry undefined, fetch deps unchanged), bump a tick so it refetches.
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
    // Why: only clear optimistic comments on a genuine item switch; on reopen gh's 60s cache omits the just-posted comment, so preserve the ref for re-merge.
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

    // Why: dedupe concurrent opens on the same key so a rapid close→reopen shares one in-flight promise instead of racing two `gh` subprocesses.
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
        // Why: stale-on-error — keep cached data, drop the pending promise so next open retries; surface the error only when nothing is cached.
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
      // Why: write through the shared cache so subscribers re-render; fetchedAt=0 forces a background refresh next open for server-side fields.
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
      // Why: cache empty (still loading) so no write/notify above; bump local state so the memo re-runs and surfaces the optimistic comment.
      setOptimisticTick((n) => n + 1)
    },
    [detailsCacheKey]
  )

  return { details, loading, error, detailsLoaded, detailsCacheKey, appendOptimisticComment }
}
