// Capped backoff for "is this feature available here?" probes that failed (not answered "no").
// A probe that always rejects (missing handler, version skew) settles at one try a minute, and
// callers stop retrying entirely while nothing on screen is waiting for the answer.
const RETRY_STEPS_MS = [5_000, 10_000, 30_000, 60_000] as const

/** Delay before retry number `attempt` (0-based): 5s, 10s, 30s, then 60s from then on. */
export function availabilityRetryDelay(attempt: number): number {
  return RETRY_STEPS_MS[Math.min(Math.max(0, attempt), RETRY_STEPS_MS.length - 1)]!
}
