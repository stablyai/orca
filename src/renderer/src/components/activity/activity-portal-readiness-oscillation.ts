import { createActivityPortalChurnBudget } from './activity-portal-churn-budget'

export type ActivityPortalReadinessStatus = 'loading' | 'ready' | 'unavailable'

// Why: stop a subscription from repainting forever after frame coalescing breaks its sync cascade.
export const ACTIVITY_PORTAL_READINESS_MAX_FLIPS = 8
/** Separates render-cadence churn from deliberate thread selection. */
export const ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS = 500

export type ActivityPortalReadinessLatch = {
  next: (status: ActivityPortalReadinessStatus) => ActivityPortalReadinessStatus
}

/** Bounds non-ready flips across every identity hosted by one portal slot. */
export function createActivityPortalReadinessLatch(
  now: () => number = () => Date.now()
): ActivityPortalReadinessLatch {
  let lastStatus: ActivityPortalReadinessStatus | null = null
  const flipBudget = createActivityPortalChurnBudget({
    limit: ACTIVITY_PORTAL_READINESS_MAX_FLIPS,
    windowMs: ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS,
    now
  })

  return {
    next(status) {
      // Why: a slow terminal may become ready after exhausting the flip budget.
      if (status === 'ready') {
        lastStatus = status
        flipBudget.clear()
        return status
      }
      // Why: underlying flips must keep the latch engaged even while its output is stable.
      const flipped = lastStatus !== null && lastStatus !== status
      lastStatus = status
      const spent = flipped ? flipBudget.record() : flipBudget.isSpent()
      return spent ? 'unavailable' : status
    }
  }
}
