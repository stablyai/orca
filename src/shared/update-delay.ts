const DAY_MS = 24 * 60 * 60 * 1000

export const UPDATE_DELAY_DAY_OPTIONS: readonly number[] = [0, 1, 3, 7, 14, 30]
const MAX_UPDATE_DELAY_DAYS = 90

/** Settings may come from older/hand-edited profiles; anything invalid means no delay. */
export function normalizeUpdateDelayDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.min(Math.round(value), MAX_UPDATE_DELAY_DAYS)
}

export function isDelayedUpdatePending(
  delayedUpdate: { availableAt: string },
  now: number
): boolean {
  return Date.parse(delayedUpdate.availableAt) > now
}

export function updateDelayDaysToMs(days: number): number {
  return normalizeUpdateDelayDays(days) * DAY_MS
}
