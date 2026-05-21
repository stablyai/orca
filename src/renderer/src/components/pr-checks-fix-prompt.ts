import type { PRCheckDetail } from '../../../shared/types'

function getCheckConclusion(check: PRCheckDetail): NonNullable<PRCheckDetail['conclusion']> {
  return check.conclusion ?? 'pending'
}

function getCheckStatusLabel(check: PRCheckDetail): string {
  const conclusion = getCheckConclusion(check)
  if (conclusion === 'success') {
    return 'Successful'
  }
  if (conclusion === 'failure') {
    return 'Failed'
  }
  if (conclusion === 'cancelled') {
    return 'Cancelled'
  }
  if (conclusion === 'timed_out') {
    return 'Timed out'
  }
  if (conclusion === 'neutral') {
    return 'Neutral'
  }
  if (conclusion === 'skipped') {
    return 'Skipped'
  }
  if (check.status === 'queued') {
    return 'Queued'
  }
  if (check.status === 'in_progress') {
    return 'In progress'
  }
  return 'Pending'
}

export function getBrokenChecks(checks: PRCheckDetail[]): PRCheckDetail[] {
  return checks.filter((check) =>
    ['failure', 'cancelled', 'timed_out'].includes(getCheckConclusion(check))
  )
}

export function buildFixBrokenChecksPrompt({
  prNumber,
  prTitle,
  prUrl,
  checks
}: {
  prNumber: number
  prTitle: string
  prUrl: string
  checks: PRCheckDetail[]
}): string {
  const brokenChecks = getBrokenChecks(checks)
  const checkLines =
    brokenChecks.length > 0
      ? brokenChecks.map((check) => {
          const details = [
            getCheckStatusLabel(check),
            check.checkRunId ? `check run ${check.checkRunId}` : null,
            check.workflowRunId ? `workflow run ${check.workflowRunId}` : null,
            check.url ? `details: ${check.url}` : null
          ]
            .filter(Boolean)
            .join(', ')
          return `- ${check.name}${details ? ` (${details})` : ''}`
        })
      : ['- No failing check is currently listed; refresh PR checks first, then inspect CI.']

  return [
    `Fix the broken checks for PR #${prNumber}: ${prTitle}`,
    `PR: ${prUrl}`,
    '',
    'Broken checks:',
    ...checkLines,
    '',
    'Focus only on making the failing checks pass. Inspect the CI output first, make the smallest correct code or test changes, and do not work on unrelated cleanup.'
  ].join('\n')
}
