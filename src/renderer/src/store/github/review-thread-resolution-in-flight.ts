import type { GitHubSlice } from './slice-types'

type InFlightState = Pick<GitHubSlice, 'reviewThreadResolutionsInFlight'>

export function reviewThreadInFlightKey(commentsCacheKey: string, threadId: string): string {
  return `${commentsCacheKey}\u0000${threadId}`
}

/** Thread node IDs are globally unique, so UI callers without a cache key can match on threadId. */
export function isReviewThreadResolutionInFlight(state: InFlightState, threadId: string): boolean {
  return Object.values(state.reviewThreadResolutionsInFlight).includes(threadId)
}

export function withReviewThreadInFlight(
  state: InFlightState,
  key: string,
  threadId: string | null
): InFlightState {
  const next = { ...state.reviewThreadResolutionsInFlight }
  if (threadId === null) {
    delete next[key]
  } else {
    next[key] = threadId
  }
  return { reviewThreadResolutionsInFlight: next }
}
