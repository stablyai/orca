import type { ParentPrChecksRow, ParentPrChecksSummary } from './parent-pr-checks-row-types'

export function summarizeParentPrChecksRows(
  rows: readonly ParentPrChecksRow[]
): ParentPrChecksSummary {
  return {
    attached: rows.length,
    knownReview: rows.filter((row) => row.reviewLabel !== null && row.status !== 'noReview').length,
    failing: rows.filter((row) => row.group === 'needsAttention' && row.status !== 'actionRequired')
      .length,
    actionRequired: rows.filter((row) => row.status === 'actionRequired').length,
    pending: rows.filter((row) => row.group === 'pending').length,
    passing: rows.filter((row) => row.group === 'passing').length,
    noPr: rows.filter((row) => row.status === 'noReview').length,
    unknown: rows.filter((row) =>
      [
        'notFetched',
        'loading',
        'linkedDetailsUnavailable',
        'refreshError',
        'unsupported',
        'unavailable'
      ].includes(row.status)
    ).length
  }
}
