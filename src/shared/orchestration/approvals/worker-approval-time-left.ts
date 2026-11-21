/** Seconds left before the agent decides on its own, as m:ss; null once past or unknown. */
export function workerApprovalTimeLeft(expiresAt: string | undefined, now: number): string | null {
  const left = expiresAt ? Math.ceil((Date.parse(expiresAt) - now) / 1_000) : Number.NaN
  if (!Number.isFinite(left) || left <= 0) {
    return null
  }
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}
