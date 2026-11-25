import type { PRInfo } from '../pull-request-types'

export const QUIET_PR_REFRESH_INTERVAL_MS = 5 * 60_000

export function prChecksDone(pr: PRInfo): boolean {
  return (
    pr.checksFinal === true || (pr.checksReadComplete === true && pr.checksSummary?.total === 0)
  )
}

export function isQuietPR(pr: PRInfo, currentHeadOid: string | null): boolean {
  return (
    (pr.state === 'open' || pr.state === 'draft') &&
    !!currentHeadOid &&
    pr.headSha === currentHeadOid &&
    pr.checksReadComplete === true &&
    prChecksDone(pr) &&
    (pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING') &&
    pr.autoMergeEnabled === false &&
    pr.mergeQueueRequired === false
  )
}
