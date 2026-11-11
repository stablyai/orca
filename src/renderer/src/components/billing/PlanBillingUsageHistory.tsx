import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { formatHours } from './plan-billing-format'
import {
  topMemberRows,
  topWorkspaceRows,
  usageWindowTotalLine,
  yourUsageLine,
  type UsageBreakdownRow
} from './plan-billing-usage-history'
import { UsageHistoryChart } from './UsageHistoryChart'
import type { PlanBillingUsageState } from './use-plan-billing-usage-history'

/** "Last 30 days": the team's daily hours; owners and admins also see the top workspaces and members. */
export function PlanBillingUsageHistory({
  state,
  onRetry
}: {
  state: PlanBillingUsageState
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('auto.components.billing.usage.title', 'Last 30 days')
  if (state.status === 'failed') {
    return (
      <section className="space-y-3">
        <SettingsGroupHeader title={title} className="px-0" />
        <InlineError
          title={t('auto.components.billing.usage.loadFailed', 'Couldn’t load your usage history')}
          retryLabel={t('auto.components.billing.plans.retry', 'Try again')}
          onRetry={onRetry}
        />
      </section>
    )
  }
  if (state.status === 'loading') {
    return (
      <section
        className="space-y-3"
        role="status"
        aria-busy
        aria-label={t('auto.components.billing.usage.loading', 'Loading your usage history…')}
      >
        <SettingsGroupHeader title={title} className="px-0" />
        <Skeleton shape="card" className="h-[136px] w-full" />
      </section>
    )
  }
  const { history, names } = state
  const workspaces = topWorkspaceRows(history, names, t)
  const members = topMemberRows(history, names, t)
  const empty = history.totalSeconds <= 0
  return (
    <section className="space-y-3">
      <SettingsGroupHeader
        title={title}
        className="px-0"
        action={
          empty ? null : (
            <span className="text-xs text-muted-foreground tabular-nums">
              {usageWindowTotalLine(history.totalSeconds, t)}
            </span>
          )
        }
      />
      {empty ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          {t(
            'auto.components.billing.usage.empty',
            'No sandbox hours yet. Usage shows here once your team runs cloud workspaces.'
          )}
        </p>
      ) : (
        <>
          <UsageHistoryChart days={history.days} />
          {workspaces && members ? (
            <div className="grid gap-x-6 gap-y-4 pt-1 sm:grid-cols-2">
              <BreakdownList
                title={t('auto.components.billing.usage.topWorkspaces', 'Top workspaces')}
                rows={workspaces}
              />
              <BreakdownList
                title={t('auto.components.billing.usage.topMembers', 'Top members')}
                rows={members}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground tabular-nums">
              {yourUsageLine(history, t)}
            </p>
          )}
        </>
      )}
    </section>
  )
}

function BreakdownList({
  title,
  rows
}: {
  title: string
  rows: UsageBreakdownRow[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <h4 className="font-medium">{title}</h4>
        <span className="text-muted-foreground">
          {t('auto.components.billing.usage.hoursColumn', 'Sandbox hours')}
        </span>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className={row.other ? 'truncate text-muted-foreground' : 'truncate'}>
                {row.label}
              </span>
              <span className="shrink-0 tabular-nums">{formatHours(row.seconds)}</span>
            </div>
            {/* Share of the team's hours: decoration; the number beside it carries the value. */}
            <div aria-hidden className="h-1 w-full rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-chart-3 dark:bg-chart-2"
                style={{ width: `${Math.max(1, row.share)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
