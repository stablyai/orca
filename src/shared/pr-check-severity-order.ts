import type { PRCheckDetail } from './types'

// Why: `neutral`/`skipped` carry no signal, so they sink below `success` — otherwise a
// wall of skipped jobs buries the passing checks a reviewer actually reads.
const CHECK_SEVERITY_RANK: Record<string, number> = {
  failure: 0,
  timed_out: 0,
  action_required: 0,
  cancelled: 1,
  pending: 2,
  success: 3,
  neutral: 4,
  skipped: 5
}

// Why: an unrecognized conclusion sinks to the bottom instead of masquerading as `neutral`.
const UNKNOWN_CHECK_RANK = 6

export function getCheckSeverityRank(conclusion: string | null | undefined): number {
  return CHECK_SEVERITY_RANK[conclusion ?? 'pending'] ?? UNKNOWN_CHECK_RANK
}

export function sortChecksBySeverity<T extends Pick<PRCheckDetail, 'conclusion'>>(
  checks: readonly T[]
): T[] {
  return [...checks].sort(
    (a, b) => getCheckSeverityRank(a.conclusion) - getCheckSeverityRank(b.conclusion)
  )
}
