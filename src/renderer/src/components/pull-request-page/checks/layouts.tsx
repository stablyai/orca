import React from 'react'
import { CircleDashed, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHECK_COLOR } from '@/components/right-sidebar/checks-panel/check-presentation'
import { getCheckCountChips, type getCheckCounts } from '@/components/pr-check-counts'
import { getCheckDetailsKey } from '@/components/github/pr-check-presentation'
import { translate } from '@/i18n/i18n'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'

export function ChecksTabLayouts({
  loading,
  listLength,
  variant,
  compactHeader,
  actions,
  SummaryIcon,
  summaryColor,
  summaryLabel,
  counts,
  sorted,
  renderCheckRow,
  fixChecksAgentDialog
}: {
  loading: boolean
  listLength: number
  variant: 'compact' | 'page'
  compactHeader: React.JSX.Element
  actions: React.JSX.Element
  SummaryIcon: React.ComponentType<{ className?: string }>
  summaryColor: string
  summaryLabel: string
  counts: ReturnType<typeof getCheckCounts>
  sorted: PRCheckDetail[]
  renderCheckRow: (check: PRCheckDetail) => React.JSX.Element
  fixChecksAgentDialog: React.JSX.Element
}): React.JSX.Element {
  if (loading && listLength === 0) {
    return (
      <>
        {variant === 'compact' ? compactHeader : null}
        <div className="flex items-center justify-center py-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      </>
    )
  }
  if (listLength === 0) {
    if (variant === 'page') {
      return (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {translate('auto.components.PullRequestPage.45877f5089', 'No checks found')}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.PullRequestPage.3912daf310',
                  'This pull request has no reported checks yet.'
                )}
              </span>
            </div>
            {actions}
          </div>
        </div>
      )
    }
    return (
      <>
        {compactHeader}
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
          <CircleDashed className="size-4 text-muted-foreground/60" />
          <div className="text-[12px] text-muted-foreground">
            {translate('auto.components.PullRequestPage.a18d01cda3', 'No checks reported yet')}
          </div>
        </div>
      </>
    )
  }
  if (variant === 'page') {
    const countChips = getCheckCountChips(counts)
    return (
      <>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <SummaryIcon
              className={cn(
                'size-4 shrink-0',
                summaryColor,
                counts.pending > 0 && counts.failing === 0 && 'animate-spin'
              )}
            />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-[13px] font-medium text-foreground">
                {summaryLabel}
              </span>
              {countChips.length > 1 && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {countChips.map((chip, i) => (
                    <React.Fragment key={chip.tone}>
                      {i > 0 && <span className="opacity-40">·</span>}
                      <span className={CHECK_COLOR[chip.tone]}>{chip.label}</span>
                    </React.Fragment>
                  ))}
                </span>
              )}
            </div>
            {actions}
          </div>
          <div className="overflow-hidden rounded-lg border border-border/50 bg-card shadow-xs">
            {sorted.map((check, index) => (
              <div
                key={getCheckDetailsKey(check)}
                className={cn(index > 0 && 'border-t border-border/40')}
              >
                {renderCheckRow(check)}
              </div>
            ))}
          </div>
        </div>
        {fixChecksAgentDialog}
      </>
    )
  }
  return (
    <>
      {compactHeader}
      <div className="max-h-[280px] overflow-y-auto p-1 scrollbar-sleek">
        {sorted.map(renderCheckRow)}
      </div>
      {fixChecksAgentDialog}
    </>
  )
}
