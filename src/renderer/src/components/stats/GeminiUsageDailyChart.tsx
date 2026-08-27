import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import type { GeminiUsageDailyPoint } from '../../../../shared/gemini-usage-types'
import { formatTokens } from './usage-formatters'
import { translate } from '@/i18n/i18n'

function getMaxDailyTotal(daily: GeminiUsageDailyPoint[]): number {
  let max = 1
  for (const entry of daily) {
    max = Math.max(max, entry.totalTokens)
  }
  return max
}

type GeminiUsageDailyChartProps = {
  daily: GeminiUsageDailyPoint[]
}

export function GeminiUsageDailyChart({ daily }: GeminiUsageDailyChartProps): React.JSX.Element {
  const visibleDaily = daily.slice(-10)
  const maxDailyTotal = getMaxDailyTotal(visibleDaily)

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">
          {translate('auto.components.stats.GeminiUsageDailyChart.dailyUsage', 'Daily usage')}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.stats.GeminiUsageDailyChart.dailyUsageSubtitle',
            'Token consumption over the last active days.'
          )}
        </p>
      </div>
      <div className="grid h-56 grid-cols-10 items-end gap-3">
        {visibleDaily.map((entry) => {
          const segments = [
            {
              key: 'input',
              label: translate('auto.components.stats.GeminiUsageDailyChart.input', 'Input'),
              value: entry.inputTokens,
              className: 'bg-sky-500/80'
            },
            {
              key: 'output',
              label: translate('auto.components.stats.GeminiUsageDailyChart.output', 'Output'),
              value: entry.outputTokens,
              className: 'bg-emerald-500/80'
            },
            {
              key: 'cached-input',
              label: translate(
                'auto.components.stats.GeminiUsageDailyChart.cachedInput',
                'Cached input'
              ),
              value: entry.cachedInputTokens,
              className: 'bg-amber-500/70'
            },
            {
              key: 'reasoning',
              label: translate(
                'auto.components.stats.GeminiUsageDailyChart.reasoning',
                'Reasoning'
              ),
              value: entry.reasoningOutputTokens,
              className: 'bg-fuchsia-500/70'
            }
          ]
          return (
            <div key={entry.day} className="flex h-full min-w-0 flex-col justify-end gap-2">
              <span className="text-center text-[11px] text-muted-foreground">
                {formatTokens(entry.totalTokens)}
              </span>
              <div className="flex min-h-0 flex-1 items-end justify-center">
                <div className="flex h-full w-full max-w-12 overflow-hidden rounded-t-sm bg-muted/60">
                  <div className="flex h-full w-full flex-col justify-end">
                    {segments.map((segment) =>
                      segment.value > 0 ? (
                        <TooltipProvider key={segment.key} delayDuration={120}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={segment.className}
                                style={{ height: `${(segment.value / maxDailyTotal) * 100}%` }}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top" sideOffset={8}>
                              <div className="text-xs">
                                <div>{entry.day}</div>
                                <div>
                                  {segment.label}: {segment.value.toLocaleString()}{' '}
                                  {translate(
                                    'auto.components.stats.GeminiUsageDailyChart.tokens',
                                    'tokens'
                                  )}
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : null
                    )}
                  </div>
                </div>
              </div>
              <span className="text-center text-[11px] text-muted-foreground">
                {entry.day.slice(5)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-sky-500/80" />
          {translate('auto.components.stats.GeminiUsageDailyChart.input', 'Input')}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-emerald-500/80" />
          {translate('auto.components.stats.GeminiUsageDailyChart.output', 'Output')}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-amber-500/70" />
          {translate('auto.components.stats.GeminiUsageDailyChart.cachedInput', 'Cached input')}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2 rounded-full bg-fuchsia-500/70" />
          {translate('auto.components.stats.GeminiUsageDailyChart.reasoning', 'Reasoning')}
        </span>
      </div>
    </section>
  )
}
