import type React from 'react'
import { CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { isCompletePRCheckOwner } from '../../../shared/github/complete-pr-check-owner'
import type { ProviderCheckSummary } from '../../../shared/github/pull-request-types'

export function PRCheckEmptyDetails({
  owner,
  dialog = false,
  variant,
  compactHeader,
  actions,
  SummaryIcon,
  summaryColor,
  summaryLabel
}: {
  dialog?: boolean
  owner?: { checksSummary?: ProviderCheckSummary }
  variant: 'page' | 'compact'
  compactHeader: React.JSX.Element
  actions: React.JSX.Element
  SummaryIcon: React.ComponentType<{ className?: string }>
  summaryColor: string
  summaryLabel: string
}): React.JSX.Element {
  const complete = owner && isCompletePRCheckOwner(owner)
  const noChecks = !complete || owner.checksSummary?.total === 0
  const detailLabel = noChecks
    ? dialog
      ? translate('auto.components.GitHubItemDialog.e52bed9264', 'No checks reported yet')
      : translate('auto.components.PullRequestPage.a18d01cda3', 'No checks reported yet')
    : translate('auto.components.prCheckCounts.noCheckDetails', 'No check details available')
  if (variant === 'compact') {
    return (
      <>
        {compactHeader}
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
          <CircleDashed className="size-4 text-muted-foreground/60" />
          <div className="text-[12px] text-muted-foreground">{detailLabel}</div>
        </div>
      </>
    )
  }
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <SummaryIcon className={cn('size-4 shrink-0', summaryColor)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">
            {noChecks
              ? dialog
                ? translate('auto.components.GitHubItemDialog.ecffebc251', 'No checks found')
                : translate('auto.components.PullRequestPage.45877f5089', 'No checks found')
              : summaryLabel}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {noChecks
              ? dialog
                ? translate(
                    'auto.components.GitHubItemDialog.90020cc1f3',
                    'This pull request has no reported checks yet.'
                  )
                : translate(
                    'auto.components.PullRequestPage.3912daf310',
                    'This pull request has no reported checks yet.'
                  )
              : detailLabel}
          </span>
        </div>
        {actions}
      </div>
    </div>
  )
}
