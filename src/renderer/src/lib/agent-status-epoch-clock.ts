// Why: the freshness scheduler bumps `agentStatusEpoch` precisely when a status
// crosses the stale boundary with no map change, so `now` must be re-read on
// that bump — during render, or the first frame still paints the pre-expiry
// state. Sampling once per epoch keeps render deterministic (same epoch in,
// same value out) without a setState round-trip, and keeps every consumer of
// one epoch agreeing on the boundary.
export function createAgentStatusEpochClock(
  // Why call through, not `= Date.now`: binding the identifier captures the
  // native function at module load, so a suite's fake timers never apply.
  readNow: () => number = () => Date.now()
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

let sharedClock = createAgentStatusEpochClock()

/**
 * Wall clock sampled once per agent-status epoch. Call during render with the
 * live epoch; callers that opt out of epoch subscriptions must not call it at
 * all, so a sentinel epoch cannot evict the shared sample.
 *
 * Because an unchanged epoch reuses whichever timestamp first observed it, this
 * relies on the freshness scheduler bumping the epoch at every stale boundary —
 * a missed bump now leaves an expired agent rendering as live until the next
 * real bump, where before it self-corrected on the next mount.
 */
export const getAgentStatusEpochNow = (agentStatusEpoch: number): number =>
  sharedClock(agentStatusEpoch)

/**
 * Suites that reset the store (`setState(initialState, true)` rewinds the epoch
 * to 0) must also rewind the sample, or the next render at epoch 0 reuses the
 * previous test's timestamp.
 */
export function resetAgentStatusEpochClockForTests(): void {
  sharedClock = createAgentStatusEpochClock()
}
