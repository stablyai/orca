import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
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

function sessionCountLabel(count: number, t: Translate = translate): string {
  return t('stats.usageBreakdown.sessions', '{{count}} sessions', {
    count,
    defaultValue_one: '{{count}} session'
  })
}

function activityCountLabel(
  count: number,
  unit: 'events' | 'turns',
  t: Translate = translate
): string {
  if (unit === 'turns') {
    return t('stats.usageBreakdown.turns', '{{count}} turns', {
      count,
      defaultValue_one: '{{count}} turn'
    })
  }
  return t('stats.usageBreakdown.events', '{{count}} events', {
    count,
    defaultValue_one: '{{count}} event'
  })
}

function usageRowCounts(row: UsageBreakdownRow, unit: 'events' | 'turns', t?: Translate): string {
  return `${sessionCountLabel(row.sessions, t)} • ${activityCountLabel(row.eventsOrTurns, unit, t)}`
}

export function UsageBreakdownSection({
  title,
  topLabel,
  topValue,
  rows,
  eventsOrTurns
}: UsageBreakdownSectionProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">
          {topLabel}{' '}
          {topValue ?? t('auto.components.stats.UsageBreakdownSection.7765a4c3e1', 'n/a')}
        </p>
      </div>
      <div className="space-y-3">
        {rows.slice(0, 5).map((row) => (
          <div key={row.key} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 break-words text-foreground">{row.label}</span>
              <span className="shrink-0 text-muted-foreground">
                {formatTokens(row.tokens, intlLocale)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {usageRowCounts(row, eventsOrTurns, t)}
              {row.hasInferredPricing
                ? ` ${t('auto.components.stats.UsageBreakdownSection.247c93ca92', '• inferred pricing')}`
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
