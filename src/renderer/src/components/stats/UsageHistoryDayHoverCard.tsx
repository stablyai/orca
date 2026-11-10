import type { UsageHistoryProvider } from '../../../../shared/usage-history-types'
import type { UsageHistoryTotals } from '../../../../shared/usage-history-aggregation'
import { HoverCardContent } from '../ui/hover-card'
import { USAGE_PROVIDER_COLORS, type UsageHistoryChartPoint } from './usage-history-chart-model'
import { formatUsageCost, formatUsageTokens } from './usage-overview-model'
import { formatUsageDayLabel } from './usage-formatters'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'

export function UsageHistoryDayHoverCard({
  boundary,
  id,
  day,
  usage,
  series,
  dayIndex,
  metric,
  offset
}: {
  boundary: HTMLElement | null
  id: string
  day: string
  usage: UsageHistoryTotals | null
  series: { provider: UsageHistoryProvider; points: UsageHistoryChartPoint[] }[]
  dayIndex: number
  metric: 'tokens' | 'cost'
  offset: number
}) {
  const t = useTranslate()
  const locale = useIntlLocale()
  const amount =
    metric === 'tokens' ? (usage?.totalTokens ?? 0) : usage ? usage.apiEquivalentCostUsd : 0
  return (
    <HoverCardContent
      id={id}
      role="tooltip"
      side="right"
      align="start"
      alignOffset={offset}
      sideOffset={8}
      collisionBoundary={boundary ?? undefined}
      collisionPadding={12}
      className="pointer-events-none max-w-[calc(100vw-2rem)]"
      data-testid="usage-history-readout"
    >
      <div className="space-y-3 text-xs">
        <div className="flex items-center justify-between gap-3 border-b pb-2">
          <span className="font-medium">{formatUsageDayLabel(day, true, locale)}</span>
          <span className="tabular-nums">
            {metric === 'tokens'
              ? formatUsageTokens(amount ?? 0, locale)
              : formatUsageCost(amount, t, locale)}
            {metric === 'cost' && usage?.hasPartialCost ? ' *' : ''}
          </span>
        </div>
        <div className="space-y-2">
          {series.map(({ provider, points }) => {
            const point = points[dayIndex]
            return (
              <div key={provider} className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: USAGE_PROVIDER_COLORS[provider].color }}
                  />
                  {getAgentLabel(provider)}
                </span>
                <span className="tabular-nums">
                  {point?.amount === null
                    ? t('stats.usage.daily.unpriced', 'Price unavailable')
                    : metric === 'tokens'
                      ? (point?.amount ?? 0).toLocaleString(locale)
                      : formatUsageCost(point?.amount ?? 0, t, locale)}
                  {metric === 'cost' && point?.usage?.hasPartialCost ? ' *' : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </HoverCardContent>
  )
}
