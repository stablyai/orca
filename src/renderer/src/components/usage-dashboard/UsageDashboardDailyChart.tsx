import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { formatCost, formatTokens } from '../stats/usage-formatters'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { UsageDashboardDailyPoint } from './usage-dashboard-series'

type UsageDashboardDailyChartProps = {
  points: UsageDashboardDailyPoint[]
}

type ChartSegment = {
  key: 'input' | 'cached' | 'output'
  label: string
  value: number
  className: string
}

function getPointTotal(point: UsageDashboardDailyPoint): number {
  return point.inputTokens + point.outputTokens + point.cacheReadTokens + point.cacheWriteTokens
}

/**
 * Stacked daily bars across the selected window. Segments are input, cached and output; reasoning
 * tokens only surface in the tooltip so they never inflate the stack (resolution 8).
 */
export default function UsageDashboardDailyChart({
  points
}: UsageDashboardDailyChartProps): React.JSX.Element {
  let maxDailyTotal = 1
  for (const point of points) {
    maxDailyTotal = Math.max(maxDailyTotal, getPointTotal(point))
  }
  const hasAnyTokens = points.some((point) => getPointTotal(point) > 0)

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
            className="grid h-44 items-end gap-1"
            style={{ gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, minmax(0, 1fr))` }}
            aria-label={translate(
              'auto.components.usageDashboard.UsageDashboardDailyChart.gridAria',
              'Daily token usage'
            )}
          >
            {points.map((point) => {
              const segments: ChartSegment[] = [
                {
                  key: 'output',
                  label: translate(
                    'auto.components.stats.ClaudeUsageDailyChart.7d2efeff5e',
                    'Output'
                  ),
                  value: point.outputTokens,
                  className: 'bg-chart-4'
                },
                {
                  key: 'cached',
                  label: translate(
                    'auto.components.usageDashboard.UsageDashboardDailyChart.cached',
                    'Cached'
                  ),
                  value: point.cacheReadTokens + point.cacheWriteTokens,
                  className: 'bg-chart-3'
                },
                {
                  key: 'input',
                  label: translate(
                    'auto.components.stats.ClaudeUsageDailyChart.d7fb787e6b',
                    'Input'
                  ),
                  value: point.inputTokens,
                  className: 'bg-chart-2'
                }
              ]
              return (
                <div
                  key={point.day}
                  data-chart-day={point.day}
                  className="flex h-full min-w-0 flex-col justify-end gap-1"
                >
                  <span className="text-center text-[10px] text-muted-foreground">
                    {formatTokens(getPointTotal(point))}
                  </span>
                  <div className="flex min-h-0 flex-1 items-end justify-center">
                    <div className="flex h-full w-full max-w-10 overflow-hidden rounded-t-sm bg-muted/60">
                      <div className="flex h-full w-full flex-col justify-end">
                        {segments.map((segment) =>
                          segment.value > 0 ? (
                            <TooltipProvider key={segment.key} delayDuration={120}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    data-chart-segment={segment.key}
                                    className={`${segment.className} transition-[height] motion-safe:duration-300 ease-out`}
                                    style={{
                                      height: `${(segment.value / maxDailyTotal) * 100}%`
                                    }}
                                  />
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={8}>
                                  <div className="space-y-0.5 text-xs">
                                    <div>{point.day}</div>
                                    <div>
                                      {segment.label}:{' '}
                                      {segment.value.toLocaleString(getIntlLocale())}{' '}
                                      {translate(
                                        'auto.components.stats.ClaudeUsageDailyChart.a7902d3c1d',
                                        'tokens'
                                      )}
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
                          ) : null
                        )}
                      </div>
                    </div>
                  </div>
                  <span className="text-center text-[10px] text-muted-foreground">
                    {point.day.slice(5)}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
            {[
              {
                key: 'input',
                label: translate('auto.components.stats.ClaudeUsageDailyChart.d7fb787e6b', 'Input'),
                className: 'bg-chart-2'
              },
              {
                key: 'cached',
                label: translate(
                  'auto.components.usageDashboard.UsageDashboardDailyChart.cached',
                  'Cached'
                ),
                className: 'bg-chart-3'
              },
              {
                key: 'output',
                label: translate(
                  'auto.components.stats.ClaudeUsageDailyChart.7d2efeff5e',
                  'Output'
                ),
                className: 'bg-chart-4'
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
