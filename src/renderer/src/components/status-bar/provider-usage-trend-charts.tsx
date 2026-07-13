import React, { useState } from 'react'
import { i18n, translate } from '@/i18n/i18n'
import {
  buildMonotoneLinePath,
  getHourTooltipStats,
  getTimeTrendsLineOpacity,
  type ProviderUsageDayTrend,
  type ProviderUsageHourOfDayModel,
  type UsageTrendsBucket
} from './provider-usage-trends-model'
import {
  ChartTooltip,
  MARGIN_LEFT,
  MARGIN_RIGHT,
  MARGIN_TOP,
  plotHeight,
  plotWidth,
  useChartDims,
  valueY,
  YAxis,
  type ChartDims
} from './provider-usage-trend-chart-frame'

const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21]
// Why: UsageScope pads the 24h domain by 0.4h so the 00/23 lines are not
// clipped at the plot boundary.
const HOUR_DOMAIN_PADDING = 0.4
function getDayBarWidth(bucketCount: number): number {
  return bucketCount <= 7 ? 16 : bucketCount <= 30 ? 5 : 13
}

function hourX(hour: number, dims: ChartDims): number {
  return (
    MARGIN_LEFT + ((hour + HOUR_DOMAIN_PADDING) / (23 + HOUR_DOMAIN_PADDING * 2)) * plotWidth(dims)
  )
}

function roundedTopBarPath(x: number, y: number, width: number, height: number): string {
  const radius = Math.min(2, width / 2, height)
  const bottom = y + height
  return [
    `M${x},${bottom}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + width - radius},${y}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `L${x + width},${bottom}`,
    'Z'
  ].join('')
}

// Why: dates follow the active UI locale (i18n.language), not the OS locale,
// so axis/tooltip labels match the rest of the localized interface.
function formatBucketLabel(
  kind: 'day' | 'month',
  key: string,
  style: 'axis7d' | 'axis' | 'tooltip'
): string {
  const date = new Date(kind === 'month' ? `${key}-15T12:00:00` : `${key}T12:00:00`)
  if (kind === 'month') {
    return style === 'tooltip'
      ? date.toLocaleDateString(i18n.language, { month: 'short', year: 'numeric' })
      : date.toLocaleDateString(i18n.language, { month: 'short' })
  }
  if (style === 'axis7d') {
    return date.toLocaleDateString(i18n.language, { weekday: 'narrow' })
  }
  if (style === 'axis') {
    return date.toLocaleDateString(i18n.language, { month: 'numeric', day: 'numeric' })
  }
  return date.toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })
}

export function TimeTrendsChart({
  model
}: {
  model: ProviderUsageHourOfDayModel
}): React.JSX.Element {
  const [hoveredHour, setHoveredHour] = useState<number | null>(null)
  const { ref, dims } = useChartDims()
  const maxValue = Math.max(1, model.maxTokens * 1.15)
  const lineOpacity = getTimeTrendsLineOpacity(model.columns.length)
  const latestDayIndex = model.columns.length - 1

  const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    if (x < MARGIN_LEFT || x > dims.width - MARGIN_RIGHT) {
      setHoveredHour(null)
      return
    }
    const step = plotWidth(dims) / (23 + HOUR_DOMAIN_PADDING * 2)
    const hour = Math.round((x - MARGIN_LEFT) / step - HOUR_DOMAIN_PADDING)
    setHoveredHour(Math.min(23, Math.max(0, hour)))
  }

  const stats = hoveredHour === null ? null : getHourTooltipStats(model, hoveredHour)

  return (
    <div ref={ref} className="relative h-full w-full">
      <svg
        width={dims.width}
        height={dims.height}
        role="img"
        aria-label={translate(
          'auto.components.status.bar.ProviderUsageTrendsChart.e439b699d2',
          'Hourly usage rhythm, one line per day'
        )}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredHour(null)}
      >
        {HOUR_TICKS.map((hour) => (
          <g key={hour}>
            <line
              x1={hourX(hour, dims)}
              x2={hourX(hour, dims)}
              y1={MARGIN_TOP}
              y2={MARGIN_TOP + plotHeight(dims)}
              className="stroke-border/50"
              strokeWidth={1}
            />
            <text
              x={hourX(hour, dims)}
              y={dims.height - 4}
              textAnchor="middle"
              className="fill-muted-foreground font-mono text-[8px]"
            >
              {String(hour).padStart(2, '0')}
            </text>
          </g>
        ))}
        <YAxis maxValue={maxValue} dims={dims} />
        {hoveredHour !== null ? (
          <line
            x1={hourX(hoveredHour, dims)}
            x2={hourX(hoveredHour, dims)}
            y1={MARGIN_TOP}
            y2={MARGIN_TOP + plotHeight(dims)}
            className="stroke-muted-foreground/50"
            strokeWidth={1}
          />
        ) : null}
        {model.columns.map((column, dayIndex) => {
          const isLatestDay = dayIndex === latestDayIndex
          // Why: flat zero-days would just thicken the baseline; the selected
          // range end stays visible even when empty so its emphasis line exists.
          if (!isLatestDay && column.every((value) => value === 0)) {
            return null
          }
          return (
            <path
              key={model.dayKeys[dayIndex]}
              d={buildMonotoneLinePath(
                column,
                (hour) => hourX(hour, dims),
                (value) => valueY(value, maxValue, dims)
              )}
              fill="none"
              stroke="var(--chart-3)"
              strokeWidth={isLatestDay ? 2 : 1}
              strokeOpacity={isLatestDay ? 1 : lineOpacity}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )
        })}
      </svg>
      {hoveredHour !== null && stats ? (
        <ChartTooltip
          header={`${String(hoveredHour).padStart(2, '0')}:00–${String((hoveredHour + 1) % 24).padStart(2, '0')}:00`}
          rows={[
            {
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsChart.bdc3231af0',
                'Latest day'
              ),
              value: stats.latest,
              emphasized: true
            },
            {
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsChart.51b34e464e',
                'Avg (active days)'
              ),
              value: stats.average
            },
            {
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsChart.c38468a96a',
                'Peak'
              ),
              value: stats.peak
            }
          ]}
        />
      ) : null}
    </div>
  )
}

export function DayTrendsChart({
  trend,
  extraRows
}: {
  trend: ProviderUsageDayTrend
  extraRows: {
    label: string
    key: keyof Pick<
      UsageTrendsBucket,
      'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningOutputTokens'
    >
  }[]
}): React.JSX.Element {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const { ref, dims } = useChartDims()
  const maxValue = Math.max(1, trend.maxTotalTokens * 1.15)
  const band = plotWidth(dims) / Math.max(1, trend.buckets.length)
  const barWidth = Math.min(getDayBarWidth(trend.buckets.length), band - 2)
  const bucketCenter = (index: number): number => MARGIN_LEFT + (index + 0.5) * band

  const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - bounds.left
    let nearest: number | null = null
    let nearestDistance = Infinity
    for (const [index, bucket] of trend.buckets.entries()) {
      if (bucket.totalTokens <= 0) {
        continue
      }
      const distance = Math.abs(x - bucketCenter(index))
      if (distance < nearestDistance) {
        nearest = index
        nearestDistance = distance
      }
    }
    // Why: gaps between thin bars should not trigger a tooltip; snap only
    // within half a bar plus a small grace zone (ported from UsageScope).
    setHoveredIndex(nearest !== null && nearestDistance <= barWidth / 2 + 4 ? nearest : null)
  }

  const hovered = hoveredIndex === null ? null : trend.buckets[hoveredIndex]
  const axisEvery = trend.kind === 'day' && trend.buckets.length > 10 ? 7 : 1

  return (
    <div ref={ref} className="relative h-full w-full">
      <svg
        width={dims.width}
        height={dims.height}
        role="img"
        aria-label={translate(
          'auto.components.status.bar.ProviderUsageTrendsChart.ca43656c36',
          'Daily token totals'
        )}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <YAxis maxValue={maxValue} dims={dims} />
        {trend.buckets.map((bucket, index) =>
          index % axisEvery === 0 ? (
            <text
              key={`label-${bucket.key}`}
              x={bucketCenter(index)}
              y={dims.height - 4}
              textAnchor="middle"
              className="fill-muted-foreground font-mono text-[8px]"
            >
              {formatBucketLabel(
                trend.kind,
                bucket.key,
                trend.kind === 'day' && trend.buckets.length <= 7 ? 'axis7d' : 'axis'
              )}
            </text>
          ) : null
        )}
        {trend.buckets.map((bucket, index) => {
          if (bucket.totalTokens <= 0) {
            return null
          }
          const height = Math.max(1, (bucket.totalTokens / maxValue) * plotHeight(dims))
          return (
            <path
              key={bucket.key}
              d={roundedTopBarPath(
                bucketCenter(index) - barWidth / 2,
                MARGIN_TOP + plotHeight(dims) - height,
                barWidth,
                height
              )}
              fill="var(--chart-3)"
              fillOpacity={hoveredIndex === null || hoveredIndex === index ? 0.85 : 0.4}
            />
          )
        })}
      </svg>
      {hovered ? (
        <ChartTooltip
          header={formatBucketLabel(trend.kind, hovered.key, 'tooltip')}
          rows={[
            {
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsChart.c3c18e7ce7',
                'Total'
              ),
              value: hovered.totalTokens,
              emphasized: true
            },
            {
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsChart.339ca0bf28',
                'Input'
              ),
              value: hovered.inputTokens
            },
            {
              label: translate(
                'auto.components.status.bar.ProviderUsageTrendsChart.e415aa4570',
                'Output'
              ),
              value: hovered.outputTokens
            },
            ...extraRows.map((row) => ({ label: row.label, value: hovered[row.key] }))
          ]}
        />
      ) : null}
    </div>
  )
}
