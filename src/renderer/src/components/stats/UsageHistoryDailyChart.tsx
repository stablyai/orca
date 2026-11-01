import { useMemo, useState, type KeyboardEvent } from 'react'
import { area as svgArea, curveMonotoneX, line as svgLine } from 'd3-shape'
import type { UsageHistoryRange, UsageHistoryRow } from '../../../../shared/usage-history-types'
import { SettingsSegmentedControl } from '../settings/SettingsFormControls'
import { usageHistoryChartDays } from './usage-history-model'
import {
  USAGE_PROVIDER_COLORS,
  usageHistoryProviderSeries,
  usageHistoryLineSegments,
  type UsageHistoryChartPoint
} from './usage-history-chart-model'
import { formatUsageCost, formatUsageTokens } from './usage-overview-model'
import { formatUsageDayLabel } from './usage-formatters'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'

export function UsageHistoryDailyChart({
  rows,
  range,
  selectedDay,
  onDay,
  today
}: {
  rows: readonly UsageHistoryRow[]
  range: UsageHistoryRange
  selectedDay: string | null
  onDay: (day: string) => void
  today?: string
}): React.JSX.Element {
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens')
  const [hoveredDay, setHoveredDay] = useState<string | null>(null)
  const [focusedDay, setFocusedDay] = useState<string | null>(null)
  const activeDay = hoveredDay ?? focusedDay
  const days = useMemo(
    () => usageHistoryChartDays(rows, range, selectedDay, undefined, today),
    [rows, range, selectedDay, today]
  )
  const series = useMemo(() => usageHistoryProviderSeries(days, metric), [days, metric])
  const largest = series.reduce(
    (max, line) => line.points.reduce((value, point) => Math.max(value, point.amount ?? 0), max),
    0
  )
  const magnitude = 10 ** Math.floor(Math.log10(largest || 1))
  const max = Math.ceil((largest || 1) / magnitude) * magnitude
  const x = (index: number) => ((index + 0.5) / days.length) * 1000
  const y = (amount: number) => 192 - (amount / max) * 184
  const lineCurve = svgLine<UsageHistoryChartPoint>()
    .x((point) => x(point.index))
    .y((point) => y(point.amount ?? 0))
    .curve(curveMonotoneX)
  const areaCurve = svgArea<UsageHistoryChartPoint>()
    .x((point) => x(point.index))
    .y0(192)
    .y1((point) => y(point.amount ?? 0))
    .curve(curveMonotoneX)
  const hoveredIndex = days.findIndex((day) => day.day === activeDay)
  const activeIndex = Math.max(
    0,
    hoveredIndex !== -1 ? hoveredIndex : days.findLastIndex((day) => day.usage !== null)
  )
  const active = days[activeIndex]
  const partialCost =
    metric === 'cost' &&
    days.some(
      (day) => day.usage && (day.usage.apiEquivalentCostUsd === null || day.usage.hasPartialCost)
    )
  const formatAmount = (amount: number | null) =>
    metric === 'tokens'
      ? amount === null
        ? '—'
        : formatUsageTokens(amount)
      : formatUsageCost(amount)
  const tickIndices = [
    ...new Set([
      0,
      Math.floor((days.length - 1) / 3),
      Math.floor(((days.length - 1) * 2) / 3),
      days.length - 1
    ])
  ]
  const onDayKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll('button') ?? [])
    const index = buttons.indexOf(event.currentTarget)
    const next =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : null
    if (next !== null) {
      event.preventDefault()
      setHoveredDay(null)
      buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus()
    }
  }
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="usage-history-daily"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-foreground">
          {translate('stats.usage.daily.title', 'Daily usage')}
        </h4>
        <SettingsSegmentedControl<'tokens' | 'cost'>
          value={metric}
          onChange={setMetric}
          ariaLabel={translate('stats.usage.daily.metric', 'Chart metric')}
          options={[
            { value: 'tokens', label: translate('stats.usage.tokens', 'Tokens') },
            { value: 'cost', label: translate('stats.usage.daily.cost', 'API estimate') }
          ]}
          size="sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'stats.usage.daily.description',
          'Select a day to inspect its usage. Days without recorded usage are shown at zero.'
        )}
      </p>
      <div
        className="flex flex-wrap gap-x-5 gap-y-2 text-xs"
        aria-label={translate('stats.usage.daily.providers', 'Provider series')}
      >
        {series.map(({ provider }) => (
          <span key={provider} className="inline-flex items-center gap-2">
            <svg width="20" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="20"
                y2="4"
                stroke={USAGE_PROVIDER_COLORS[provider].color}
                strokeWidth="2"
              />
            </svg>
            {getAgentLabel(provider)}
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <div
          className="flex h-52 w-12 shrink-0 flex-col justify-between py-2 text-right text-2xs tabular-nums text-muted-foreground"
          aria-hidden="true"
        >
          {[max, max / 2, 0].map((value) => (
            <span key={value}>{formatAmount(value)}</span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative h-52"
            data-testid="usage-history-plot"
            onMouseLeave={() => setHoveredDay(null)}
          >
            <svg
              className="h-full w-full overflow-visible"
              viewBox="0 0 1000 200"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {[8, 100, 192].map((height) => (
                <line
                  key={height}
                  x1="0"
                  x2="1000"
                  y1={height}
                  y2={height}
                  className="stroke-border"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {series.map(({ provider, points }) => (
                <g key={provider} data-provider-series={provider}>
                  {usageHistoryLineSegments(points).map((segment) => {
                    const first = segment[0]
                    if (!first) {
                      return null
                    }
                    const color = USAGE_PROVIDER_COLORS[provider].color
                    return (
                      <g key={first.index}>
                        {segment.length > 1 ? (
                          <>
                            <path d={areaCurve(segment) ?? undefined} fill={color} opacity="0.07" />
                            <path
                              d={lineCurve(segment) ?? undefined}
                              fill="none"
                              stroke={color}
                              strokeWidth="2"
                              vectorEffect="non-scaling-stroke"
                              strokeLinejoin="round"
                              strokeLinecap="round"
                            />
                          </>
                        ) : null}
                        {segment
                          .filter((point) => point.index === hoveredIndex)
                          .map((point) => (
                            <ellipse
                              key={point.index}
                              cx={x(point.index)}
                              cy={y(point.amount ?? 0)}
                              rx={3}
                              ry={3}
                              fill={color}
                            />
                          ))}
                      </g>
                    )
                  })}
                </g>
              ))}
              {hoveredIndex !== -1 ? (
                <line
                  x1={x(activeIndex)}
                  x2={x(activeIndex)}
                  y1="8"
                  y2="192"
                  className="stroke-muted-foreground"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>
            <div className="absolute inset-0 flex">
              {days.map(({ day, usage }) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => onDay(day)}
                  onMouseEnter={() => setHoveredDay(day)}
                  onFocus={(event) => {
                    if (event.currentTarget.matches(':focus-visible')) {
                      setHoveredDay(null)
                      setFocusedDay(day)
                    }
                  }}
                  onBlur={() => setFocusedDay(null)}
                  onKeyDown={onDayKey}
                  aria-pressed={selectedDay === day}
                  aria-label={
                    metric === 'tokens'
                      ? translate('stats.usage.daily.inspect', '{{day}}: {{tokens}} tokens', {
                          day,
                          tokens: (usage?.totalTokens ?? 0).toLocaleString(getIntlLocale())
                        })
                      : translate(
                          'stats.usage.daily.inspectCost',
                          '{{day}}: {{cost}} API-equivalent estimate',
                          {
                            day,
                            cost: `${formatUsageCost(usage ? usage.apiEquivalentCostUsd : 0)}${usage?.hasPartialCost ? ' *' : ''}`
                          }
                        )
                  }
                  className="min-w-0 flex-1 rounded-sm outline-none hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              ))}
            </div>
          </div>
          <div
            className="mt-2 flex justify-between gap-1 text-2xs text-muted-foreground"
            aria-hidden="true"
          >
            {tickIndices.map((index) =>
              days[index] ? (
                <span key={index}>{formatUsageDayLabel(days[index].day, range === 'all')}</span>
              ) : null
            )}
          </div>
        </div>
      </div>
      {active ? (
        <div
          className="space-y-2 rounded-md bg-muted/40 p-3 text-xs"
          data-testid="usage-history-readout"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{formatUsageDayLabel(active.day, true)}</span>
            <span className="tabular-nums">
              {formatAmount(
                metric === 'tokens'
                  ? (active.usage?.totalTokens ?? 0)
                  : active.usage
                    ? active.usage.apiEquivalentCostUsd
                    : 0
              )}
              {metric === 'cost' && active.usage?.hasPartialCost ? ' *' : ''}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-x-5 gap-y-2 @sm:grid-cols-2 @3xl:grid-cols-4">
            {series.map(({ provider, points }) => {
              const point = points[activeIndex]
              return (
                <span key={provider} className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: USAGE_PROVIDER_COLORS[provider].color }}
                    />
                    {getAgentLabel(provider)}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {point?.amount === null
                      ? translate('stats.usage.daily.unpriced', 'Price unavailable')
                      : `${metric === 'tokens' ? (point?.amount ?? 0).toLocaleString(getIntlLocale()) : formatUsageCost(point?.amount ?? 0)}${metric === 'cost' && point?.usage?.hasPartialCost ? ' *' : ''}`}
                  </span>
                </span>
              )
            })}
          </div>
        </div>
      ) : null}
      {partialCost ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'stats.usage.daily.partialCost',
            'Some usage has no recorded price. The chart shows the priced portion; * marks a partial estimate. This is not a billing statement.'
          )}
        </p>
      ) : null}
    </section>
  )
}
