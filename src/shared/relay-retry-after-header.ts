// Relay director Retry-After: delta-seconds or HTTP-date. Null means the server
// asked for no pacing, so the caller keeps its own backoff.
export function parseRelayRetryAfterMs(
  value: string | null | undefined,
  maxMs: number,
  nowMs = Date.now()
): number | null {
  if (!value) {
    return null
  }
  const seconds = Number(value)
  const delayMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - nowMs
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return null
  }
  return Math.min(maxMs, Math.ceil(delayMs))
}
