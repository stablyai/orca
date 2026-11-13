/** Sliding-window burst budget for Activity portal readiness churn. */
export type ActivityPortalChurnBudget = {
  /** Records one churn event; returns whether the budget is spent afterwards. */
  record: () => boolean
  /** True while the window still holds a full burst. */
  isSpent: () => boolean
  clear: () => void
}

export function createActivityPortalChurnBudget(args: {
  limit: number
  windowMs: number
  now?: () => number
}): ActivityPortalChurnBudget {
  const { limit, windowMs, now = () => Date.now() } = args
  // Only the newest limit events can affect the verdict.
  let eventsAt: number[] = []

  const prune = (at: number): void => {
    // Discard stale spent budgets after clock rollback.
    eventsAt = eventsAt.filter((eventAt) => eventAt > at - windowMs && eventAt <= at)
  }

  return {
    record() {
      const at = now()
      prune(at)
      eventsAt.push(at)
      if (eventsAt.length > limit) {
        eventsAt.shift()
      }
      return eventsAt.length >= limit
    },
    isSpent() {
      prune(now())
      return eventsAt.length >= limit
    },
    clear() {
      eventsAt = []
    }
  }
}
