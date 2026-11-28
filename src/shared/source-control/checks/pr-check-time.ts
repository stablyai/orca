import type { PRCheckDetail } from '../../github/checks/check-types'

// GitHub reports an unset time as the zero date; anything before the epoch is that sentinel, not a run.
export function normalizeCheckTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms > 0 ? value : undefined
}

/** Spread-ready run times for a check row; a missing or sentinel time is left off. */
export function checkRunTimes(
  startedAt: unknown,
  completedAt: unknown
): Pick<PRCheckDetail, 'startedAt' | 'completedAt'> {
  const started = normalizeCheckTimestamp(startedAt)
  const completed = normalizeCheckTimestamp(completedAt)
  return {
    ...(started ? { startedAt: started } : {}),
    ...(completed ? { completedAt: completed } : {})
  }
}

// A commit status has no run of its own: its one timestamp is when the result was posted.
export function commitStatusTimes(
  status: PRCheckDetail['status'],
  createdAt: unknown
): Pick<PRCheckDetail, 'startedAt' | 'completedAt'> {
  return status === 'completed' ? checkRunTimes(null, createdAt) : {}
}
