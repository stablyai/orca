import type { PRCheckDetail } from './github/check-types'

// Neutral/skipped carry no signal and must sink below success. Map provider values to avoid prototype-name ranks
// (e.g. constructor/toString resolving as functions on plain objects).
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
  if (checks.length < 2) {
    return checks.slice()
  }
  return checks
    .map((check, index) => ({ check, index, rank: getCheckSeverityRank(check.conclusion) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ check }) => check)
}
