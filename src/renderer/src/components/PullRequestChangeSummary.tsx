import type { JSX } from 'react'
import { getIntlLocale, translate } from '@/i18n/i18n'

type PullRequestChangeSummaryProps = {
  readonly additions?: number
  readonly deletions?: number
}

export function PullRequestChangeSummary({
  additions,
  deletions
}: PullRequestChangeSummaryProps): JSX.Element | null {
  const hasAdditions = typeof additions === 'number'
  const hasDeletions = typeof deletions === 'number'
  if (!hasAdditions && !hasDeletions) {
    return null
  }

  const accessibleLabel =
    hasAdditions && hasDeletions
      ? translate(
          'auto.components.right.sidebar.source.control.branch.line.total.chip.daa8e8e59b',
          '{{value0}} lines added, {{value1}} lines deleted',
          { value0: additions, value1: deletions }
        )
      : hasAdditions
        ? translate(
            'auto.components.right.sidebar.source.control.branch.line.total.chip.8a9b97b666',
            '{{value0}} lines added',
            { value0: additions }
          )
        : translate(
            'auto.components.right.sidebar.source.control.branch.line.total.chip.52c366d88d',
            '{{value0}} lines deleted',
            { value0: deletions }
          )
  const locale = getIntlLocale()

  return (
    <span
      role="group"
      data-pull-request-change-summary
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums"
      aria-label={accessibleLabel}
    >
      {hasAdditions ? (
        <span className="text-[color:var(--git-decoration-added)]" aria-hidden="true">
          +{additions.toLocaleString(locale)}
        </span>
      ) : null}
      {hasDeletions ? (
        <span className="text-[color:var(--git-decoration-deleted)]" aria-hidden="true">
          -{deletions.toLocaleString(locale)}
        </span>
      ) : null}
    </span>
  )
}
