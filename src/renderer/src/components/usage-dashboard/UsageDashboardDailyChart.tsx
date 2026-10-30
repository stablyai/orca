import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { formatCost, formatTokens } from '../stats/usage-formatters'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { UsageDashboardDailyPoint } from './usage-dashboard-series'

type UsageDashboardDailyChartProps = {
  points: UsageDashboardDailyPoint[]
}

type ChartSegment = {
  key: 'input' | 'cached' | 'output'
  value: number
  className: string
}

/** Locale-formatted day label. Builds from numeric parts: `new Date('YYYY-MM-DD')` parses as UTC. */
function formatDayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(getIntlLocale(), { month: 'short', day: 'numeric' }).format(
    new Date(year, month - 1, date)
  )
}

function getPointTotal(point: UsageDashboardDailyPoint): number {
  return point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens
}

function getChartSegments(point: UsageDashboardDailyPoint): ChartSegment[] {
  return [
    {
      key: 'output',
      value: point.outputTokens,
      className: 'bg-emerald-500/80'
    },
    {
      key: 'cached',
      value: point.cacheReadTokens + point.cacheWriteTokens,
      className: 'bg-amber-500/70'
    },
    {
      key: 'input',
      value: point.inputTokens,
      className: 'bg-sky-500/80'
    }
  ]
}

/**
 * Stacked daily bars across the selected window. Segments are input, cached and output; reasoning
 * tokens only surface in the tooltip so they never inflate the stack (resolution 8). A day's
 * whole column is the tooltip trigger, values live in the tooltip plus the y-axis scale, and date
 * labels thin out so nothing renders clipped.
 */
export default function UsageDashboardDailyChart({
  points
}: UsageDashboardDailyChartProps): React.JSX.Element {
  let maxDailyTotal = 1
  for (const point of points) {
    maxDailyTotal = Math.max(maxDailyTotal, getPointTotal(point))
  }
  const hasAnyTokens = points.some((point) => getPointTotal(point) > 0)
  // At most seven date labels, spread evenly, so labels never collide in dense windows.
  const dateLabelStep = Math.max(1, Math.ceil(points.length / 7))
  const halfMax = maxDailyTotal / 2

  return (
    <section
      className="rounded-lg border border-border/60 bg-card/40 p-4"
      data-testid="usage-dashboard-daily-chart"
    >
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate(
            'auto.components.usageDashboard.UsageDashboardDailyChart.title',
            'Daily tokens'
          )}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.usageDashboard.UsageDashboardDailyChart.description',
            'Input, cached, and output tokens by day.'
          )}
        </p>
      </div>
      {hasAnyTokens ? (
        <>
          <div
            className="flex gap-2"
            aria-label={translate(
              'auto.components.usageDashboard.UsageDashboardDailyChart.gridAria',
              'Daily token usage'
            )}
          >
            {/* Y-axis scale replaces the per-column value labels, which collide in dense windows. */}
            <div className="flex h-44 shrink-0 flex-col justify-between pb-4 text-right text-[10px] leading-none text-muted-foreground">
              <span className="tabular-nums">{formatTokens(maxDailyTotal)}</span>
              <span className="tabular-nums">{formatTokens(halfMax)}</span>
              <span className="tabular-nums">0</span>
            </div>
            <div className="relative min-w-0 flex-1">
              <div className="pointer-events-none absolute inset-0 flex h-44 flex-col justify-between">
                <div className="border-t border-dashed border-border/50" />
                <div className="border-t border-dashed border-border/50" />
                <div className="border-t border-border" />
              </div>
              <div
                className="relative grid h-44 items-end gap-1"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, minmax(0, 1fr))`
                }}
              >
                {points.map((point, index) => {
                  const total = getPointTotal(point)
                  return (
                    <div
                      key={point.day}
                      data-chart-day={point.day}
                      className="flex h-full min-w-0 flex-col justify-end"
                    >
                      <div className="flex min-h-0 flex-1 items-end justify-center">
                        <TooltipProvider delayDuration={120}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              {total > 0 ? (
                                <div className="flex h-full w-full max-w-10 flex-col justify-end overflow-hidden rounded-t-sm">
                                  {getChartSegments(point).map(
                                    (segment) =>
                                      segment.value > 0 && (
                                        <div
                                          key={segment.key}
                                          data-chart-segment={segment.key}
                                          className={`${segment.className} transition-[height] motion-safe:duration-300 ease-out`}
                                          style={{
                                            height: `${(segment.value / maxDailyTotal) * 100}%`
                                          }}
                                        />
                                      )
                                  )}
                                </div>
                              ) : (
                                <div
                                  data-chart-segment="empty"
                                  className="h-0.5 w-full max-w-10 rounded-full bg-muted-foreground/25"
                                />
                              )}
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={8}>
                              <div className="space-y-0.5 text-xs">
                                <div className="font-medium">{point.day}</div>
                                <div>
                                  {translate(
                                    'auto.components.usageDashboard.UsageDashboardDailyChart.input',
                                    'Input'
                                  )}
                                  : {point.inputTokens.toLocaleString(getIntlLocale())}
                                </div>
                                <div>
                                  {translate(
                                    'auto.components.usageDashboard.UsageDashboardDailyChart.cached',
                                    'Cached'
                                  )}
                                  :{' '}
                                  {(point.cacheReadTokens + point.cacheWriteTokens).toLocaleString(
                                    getIntlLocale()
                                  )}
                                </div>
                                <div>
                                  {translate(
                                    'auto.components.usageDashboard.UsageDashboardDailyChart.output',
                                    'Output'
                                  )}
                                  : {point.outputTokens.toLocaleString(getIntlLocale())}
                                </div>
                                {point.reasoningTokens !== undefined ? (
                                  <div>
                                    {translate(
                                      'auto.components.usageDashboard.UsageDashboardDailyChart.reasoning',
                                      'Reasoning: {{tokens}} tokens',
                                      {
                                        tokens:
                                          point.reasoningTokens.toLocaleString(getIntlLocale())
                                      }
                                    )}
                                  </div>
                                ) : null}
                                {point.costUsd > 0 ? (
                                  <div>
                                    {translate(
                                      'auto.components.usageDashboard.UsageDashboardDailyChart.cost',
                                      'Est. cost: {{cost}}',
                                      { cost: formatCost(point.costUsd) }
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      {/* Reserved label row keeps every baseline aligned; text thins out by step. */}
                      <span className="h-4 pt-0.5 text-center text-[10px] leading-none text-muted-foreground">
                        {index % dateLabelStep === 0 ? formatDayLabel(point.day) : ''}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
            {[
              {
                key: 'input',
                label: translate(
                  'auto.components.usageDashboard.UsageDashboardDailyChart.input',
                  'Input'
                ),
                className: 'bg-sky-500/80'
              },
              {
                key: 'cached',
                label: translate(
                  'auto.components.usageDashboard.UsageDashboardDailyChart.cached',
                  'Cached'
                ),
                className: 'bg-amber-500/70'
              },
              {
                key: 'output',
                label: translate(
                  'auto.components.usageDashboard.UsageDashboardDailyChart.output',
                  'Output'
                ),
                className: 'bg-emerald-500/80'
              }
            ].map((item) => (
              <span key={item.key} className="inline-flex items-center gap-2">
                <span className={`size-2 rounded-full ${item.className}`} />
                {item.label}
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="rounded-md border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">
          {translate(
            'auto.components.usageDashboard.UsageDashboardDailyChart.empty',
            'No token usage in this period yet.'
          )}
        </p>
      )}
    </section>
  )
}
