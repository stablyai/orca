import type { ProviderRateLimits } from './rate-limit-types'

// Decide the Kiro provider limits to store after a fetch, given the previous
// value. The goal is that a transient failure never blanks the status bar:
//
//  - ok            -> use the fresh limits.
//  - unavailable   -> the CLI is genuinely gone; clear to the unavailable shape.
//  - error, and we had a prior good monthly -> keep the prior window/credits but
//    mark status 'error' so the UI shows the last value with a stale indicator
//    (matches how Claude keeps its window on a transient refresh failure).
//  - error, no prior data -> surface the error as-is.
export function reconcileKiroProvider(
  previous: ProviderRateLimits | null,
  next: ProviderRateLimits
): ProviderRateLimits {
  if (next.status === 'ok' || next.status === 'unavailable') {
    return next
  }
  // status === 'error'
  if (previous && previous.monthly) {
    return {
      ...previous,
      status: 'error',
      error: next.error,
      updatedAt: previous.updatedAt
    }
  }
  return next
}
