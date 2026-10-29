import { translate } from '@/i18n/i18n'
import { formatCost, formatTokens } from './usage-formatters'

export type UsageBreakdownRow = {
  key: string
  label: string
  tokens: number
  sessions: number
  eventsOrTurns: number
  hasInferredPricing?: boolean
  estimatedCostUsd?: number | null
}

type UsageBreakdownSectionProps = {
  title: string
  topLabel: string
  topValue: string | null | undefined
  rows: UsageBreakdownRow[]
  eventsOrTurns: 'events' | 'turns'
}

function sessionCountLabel(count: number): string {
  return count === 1
    ? translate('stats.usageBreakdown.sessions_one', '{{count}} session', { count })
    : translate('stats.usageBreakdown.sessions_other', '{{count}} sessions', { count })
}

function activityCountLabel(count: number, unit: 'events' | 'turns'): string {
  if (unit === 'turns') {
    return count === 1
      ? translate('stats.usageBreakdown.turns_one', '{{count}} turn', { count })
      : translate('stats.usageBreakdown.turns_other', '{{count}} turns', { count })
  }
  return count === 1
    ? translate('stats.usageBreakdown.events_one', '{{count}} event', { count })
    : translate('stats.usageBreakdown.events_other', '{{count}} events', { count })
}

function usageRowCounts(row: UsageBreakdownRow, unit: 'events' | 'turns'): string {
  return `${sessionCountLabel(row.sessions)} • ${activityCountLabel(row.eventsOrTurns, unit)}`
}

export function UsageBreakdownSection({
  title,
  topLabel,
  topValue,
  rows,
  eventsOrTurns
}: UsageBreakdownSectionProps): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">
          {topLabel}{' '}
          {topValue ?? translate('auto.components.stats.UsageBreakdownSection.7765a4c3e1', 'n/a')}
        </p>
      </div>
      <div className="space-y-3">
        {rows.slice(0, 5).map((row) => (
          <div key={row.key} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 break-words text-foreground">{row.label}</span>
              <span className="shrink-0 text-muted-foreground">{formatTokens(row.tokens)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {usageRowCounts(row, eventsOrTurns)}
              {row.hasInferredPricing
                ? ` ${translate('auto.components.stats.UsageBreakdownSection.247c93ca92', '• inferred pricing')}`
                : ''}
              {row.estimatedCostUsd !== null && row.estimatedCostUsd !== undefined
                ? ` • ${formatCost(row.estimatedCostUsd)}`
                : ''}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
