import type { PRRefreshErrorType } from '../../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

/** What one Retry click actually did; a skipped or superseded click reports nothing. */
export type ChecksPanelManualRefreshResult =
  | { kind: 'skipped' }
  | { kind: 'failed'; errorType?: PRRefreshErrorType }
  | { kind: 'read' }

export function manualRefreshResult(
  outcome: string,
  current: boolean,
  errorType: PRRefreshErrorType | undefined
): ChecksPanelManualRefreshResult {
  if (!current) {
    return { kind: 'skipped' }
  }
  if (outcome === 'error') {
    return errorType ? { kind: 'failed', errorType } : { kind: 'failed' }
  }
  return outcome === 'pr' || outcome === 'no-pr' || outcome === 'review' || outcome === 'no-review'
    ? { kind: 'read' }
    : { kind: 'skipped' }
}

/** Report only what this click did: a latched, superseded or skipped click records nothing. */
export async function reportedManualRefresh(
  run: () => Promise<void>,
  lastResult: { current: ChecksPanelManualRefreshResult }
): Promise<ChecksPanelManualRefreshResult> {
  lastResult.current = { kind: 'skipped' }
  await run()
  return lastResult.current
}

/** Retry keeps the positive evidence's number as a hosted-review hint when nothing is usable. */
export function manualRetryPRHint(
  linkedPR: number | null,
  fallbackPRNumber: number | null,
  lookup: { state: string; reviewNumber?: number | null }
): { fallbackPRNumber: number | null; fallbackPRSource?: 'hosted-review' } {
  const hint = lookup.state === 'positive_unresolved' ? (lookup.reviewNumber ?? null) : null
  return linkedPR === null && fallbackPRNumber === null && hint !== null
    ? { fallbackPRNumber: hint, fallbackPRSource: 'hosted-review' }
    : { fallbackPRNumber }
}
