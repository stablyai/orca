export type ActivityPortalReadinessStatus = 'loading' | 'ready' | 'unavailable'

// Why: stop a fixed subscription from repainting forever after frame coalescing breaks its sync cascade.
export const ACTIVITY_PORTAL_READINESS_MAX_FLIPS = 8

export type ActivityPortalReadinessLatch = {
  next: (status: ActivityPortalReadinessStatus) => ActivityPortalReadinessStatus
}

/** Bounds non-ready status flips for one readiness subscription. */
export function createActivityPortalReadinessLatch(): ActivityPortalReadinessLatch {
  let lastStatus: ActivityPortalReadinessStatus | null = null
  let flips = 0
  let latched = false

  return {
    next(status) {
      // Why: a slow terminal may become ready after exhausting the flip budget.
      if (status === 'ready') {
        lastStatus = status
        flips = 0
        latched = false
        return status
      }
      if (latched) {
        return 'unavailable'
      }
      if (lastStatus !== null && lastStatus !== status) {
        flips += 1
      }
      lastStatus = status
      if (flips >= ACTIVITY_PORTAL_READINESS_MAX_FLIPS) {
        latched = true
        return 'unavailable'
      }
      return status
    }
  }
}
