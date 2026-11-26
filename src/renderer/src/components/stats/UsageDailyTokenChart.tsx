import { useState } from 'react'
import { Toggle } from '../ui/toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { useIntlLocale } from '@/i18n/use-translate'
import { formatTokens } from './usage-formatters'

type UsageDailyTokenSeries<T> = {
  key: string
  label: string
  className: string
  value: (entry: T) => number
  // Defaults to `value`; lets a segment drawn as a part still report its provider total.
  tooltipValue?: (entry: T) => number
}

type UsageDailyTokenChartProps<T extends { day: string }> = {
  title: string
  description: string
  tokensLabel: string
  daily: T[]
  // Listed in legend order.
  series: UsageDailyTokenSeries<T>[]
  // Where the first series sits in each bar; keeps each provider's established stack order.
  firstSeriesAt: 'bottom' | 'top'
  // Provider-reported day total, shown while every series is visible.
  total: (entry: T) => number
}

export function UsageDailyTokenChart<T extends { day: string }>({
  title,
  description,
  tokensLabel,
  daily,
  series,
  firstSeriesAt,
  total
}: UsageDailyTokenChartProps<T>): React.JSX.Element {
  const intlLocale = useIntlLocale()
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set())
  const visibleSeries = series.filter((item) => !hiddenKeys.has(item.key))
  const getStackHeight = (entry: T): number =>
    visibleSeries.reduce((sum, item) => sum + item.value(entry), 0)
  const getDayTotal = (entry: T): number =>
    hiddenKeys.size === 0 ? total(entry) : getStackHeight(entry)

  const shownDays = daily.slice(-10)
  const maxDailyTotal = Math.max(1, ...shownDays.map(getStackHeight))

  const toggleSeries = (key: string): void => {
    setHiddenKeys((current) => {
      const next = new Set(current)
      if (!next.delete(key)) {
        next.add(key)
      }
      return next
    })
  }

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid h-56 grid-cols-10 items-end gap-3">
        {shownDays.map((entry) => (
          <div key={entry.day} className="flex h-full min-w-0 flex-col justify-end gap-2">
            <span className="text-center text-[11px] text-muted-foreground">
              {formatTokens(getDayTotal(entry), intlLocale)}
            </span>
            <div className="flex min-h-0 flex-1 items-end justify-center">
              <div className="flex h-full w-full max-w-12 overflow-hidden rounded-t-sm bg-muted/60">
                <div
                  className={`flex h-full w-full ${firstSeriesAt === 'bottom' ? 'flex-col-reverse' : 'flex-col justify-end'}`}
                >
                  {visibleSeries.map((item) => {
                    const value = item.value(entry)
                    const tooltipValue = item.tooltipValue?.(entry) ?? value
                    return value > 0 ? (
                      <TooltipProvider key={item.key}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div
                              className={item.className}
                              style={{ height: `${(value / maxDailyTotal) * 100}%` }}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={8}>
                            <div className="text-xs">
                              <div>{entry.day}</div>
                              <div>
                                {item.label}: {tooltipValue.toLocaleString(intlLocale)}{' '}
                                {tokensLabel}
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : null
                  })}
                </div>
              </div>
            </div>
            <span className="text-center text-[11px] text-muted-foreground">
              {entry.day.slice(5)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {series.map((item) => {
          const isHidden = hiddenKeys.has(item.key)
          return (
            <Toggle
              key={item.key}
              variant="chip"
              size="xs"
              pressed={!isHidden}
              // Keep at least one type shown so the chart never collapses to empty 0 bars.
              disabled={!isHidden && visibleSeries.length === 1}
              onPressedChange={() => toggleSeries(item.key)}
            >
              <span
                className={`size-2 rounded-full ${item.className} ${isHidden ? 'opacity-30' : ''}`}
              />
              {item.label}
            </Toggle>
          )
        })}
      </div>
    </section>
  )
}
