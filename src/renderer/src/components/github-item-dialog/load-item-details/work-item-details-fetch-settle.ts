import type { GitHubWorkItemDetails } from '../../../../../shared/github/work-item-types'
import {
  WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  workItemDetailsCacheGeneration
} from './work-item-details-cache'

export function settleWorkItemDetailsFetch(args: {
  detailsCacheKey: string
  inflight: Promise<GitHubWorkItemDetails | null>
  launchedAtGeneration: number
}): void {
  const { detailsCacheKey, inflight, launchedAtGeneration } = args
  void inflight
    .then((result) => {
      const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
      const prev = workItemDetailsCache.get(detailsCacheKey)
      if (invalidatedMidFlight && prev?.pending !== inflight) {
        // Why: entry was deliberately dropped (or later repopulated) — don't recreate or touch it.
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
      const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
      const prev = workItemDetailsCache.get(detailsCacheKey)
      if (invalidatedMidFlight && prev?.pending !== inflight) {
        return
      }
      // Why: stale-on-error — keep cached data, drop the pending promise so next open retries; show the error only when nothing is cached.
      touchWorkItemDetailsCache(detailsCacheKey, {
        details: prev?.details ?? null,
        fetchedAt: prev?.fetchedAt ?? 0,
        error: message
      })
    })
}
