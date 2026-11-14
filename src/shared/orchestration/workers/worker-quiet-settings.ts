// Keep the product default out of saved settings so unchosen profiles follow future changes.
const DEFAULT_WORKER_QUIET_MINUTES = 0
export const MAX_WORKER_QUIET_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / (8 * 60_000))

export function isWorkerQuietMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_WORKER_QUIET_MINUTES
  )
}

export function resolveWorkerQuietMinutes(
  settings: { orchestrationQuietWorkerMinutes?: unknown } | null | undefined,
  productDefault = DEFAULT_WORKER_QUIET_MINUTES
): number {
  const value = settings?.orchestrationQuietWorkerMinutes
  return isWorkerQuietMinutes(value) ? value : productDefault
}
