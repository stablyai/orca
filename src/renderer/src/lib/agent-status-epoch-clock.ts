// Why: the freshness scheduler bumps `agentStatusEpoch` precisely when a status
// crosses the stale boundary with no map change, so `now` must be re-read on
// that bump — during render, or the first frame still paints the pre-expiry
// state. Sampling once per epoch keeps render deterministic (same epoch in,
// same value out) without a setState round-trip, and keeps every consumer of
// one epoch agreeing on the boundary.
export function createAgentStatusEpochClock(
  readNow: () => number = Date.now
): (agentStatusEpoch: number) => number {
  let sampledEpoch: number | null = null
  let sampledNow = 0

  return (agentStatusEpoch) => {
    if (sampledEpoch !== agentStatusEpoch) {
      sampledEpoch = agentStatusEpoch
      sampledNow = readNow()
    }
    return sampledNow
  }
}

/**
 * Wall clock sampled once per agent-status epoch. Call during render with the
 * live epoch; callers that opt out of epoch subscriptions must not call it at
 * all, so a sentinel epoch cannot evict the shared sample.
 */
export const getAgentStatusEpochNow = createAgentStatusEpochClock()
