import type { GitHubPRCheckSummary, PRCheckDetail } from '../../../shared/types'

function getCheckConclusion(check: PRCheckDetail): NonNullable<PRCheckDetail['conclusion']> {
  return check.conclusion ?? 'pending'
}

function isPendingCheck(check: PRCheckDetail): boolean {
  return (
    check.status === 'queued' ||
    check.status === 'in_progress' ||
    getCheckConclusion(check) === 'pending'
  )
}

export function deriveTaskPagePRCheckSummary(checks: PRCheckDetail[]): GitHubPRCheckSummary {
  if (checks.length === 0) {
    return { state: 'none', total: 0, passed: 0, failed: 0, pending: 0 }
  }

  let passed = 0
  let failed = 0
  let pending = 0

  for (const check of checks) {
    const conclusion = getCheckConclusion(check)
    if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
      passed += 1
    } else if (
      conclusion === 'failure' ||
      conclusion === 'timed_out' ||
      conclusion === 'cancelled'
    ) {
      failed += 1
    } else if (isPendingCheck(check)) {
      pending += 1
    } else {
      passed += 1
    }
  }

  return {
    state: failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success',
    total: checks.length,
    passed,
    failed,
    pending
  }
}
