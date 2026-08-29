import type { PRCheckDetail } from './github/check-types'

// Why: `neutral`/`skipped` carry no signal, so they sink below `success` — otherwise a
// wall of skipped jobs buries the passing checks a reviewer actually reads.
// A Map, not an object: conclusions arrive from provider payloads, and an object
// would resolve `constructor`/`toString` off the prototype into a non-number rank.
const CHECK_SEVERITY_RANK = new Map<string, number>([
  ['failure', 0],
  ['timed_out', 0],
  ['action_required', 0],
  ['cancelled', 1],
  ['pending', 2],
  ['success', 3],
  ['neutral', 4],
  ['skipped', 5]
])

// Why: an unrecognized conclusion sinks to the bottom instead of masquerading as `neutral`.
const UNKNOWN_CHECK_RANK = 6

export function getCheckSeverityRank(conclusion: string | null | undefined): number {
  return CHECK_SEVERITY_RANK.get(conclusion ?? 'pending') ?? UNKNOWN_CHECK_RANK
}

export function sortChecksBySeverity<T extends Pick<PRCheckDetail, 'conclusion'>>(
  checks: readonly T[]
): T[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort(
      (a, b) =>
        getCheckSeverityRank(a.check.conclusion) - getCheckSeverityRank(b.check.conclusion) ||
        a.index - b.index
    )
    .map(({ check }) => check)
}
