import { useState } from 'react'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { OrcaBillingUsageHistory } from '../../../../shared/orca-billing'
import {
  usageBarPercent,
  usageChartMaxHours,
  usageDayLabel,
  usageDayLine
} from './plan-billing-usage-history'

const HEIGHT_PX = 112

/**
 * Sandbox hours per day for the last 30 days: one series, so no legend (the heading names it).
 * Hover or arrow keys show a day's hours; a visually hidden table carries every value.
 */
export function UsageHistoryChart({
  days
}: {
  days: OrcaBillingUsageHistory['days']
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [active, setActive] = useState<number | null>(null)
  const maxHours = usageChartMaxHours(days)
  const ticks = [maxHours, maxHours / 2, 0]
  const activeDay = active === null ? null : days[active]
  const last = days.length - 1

  const move = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const from = active ?? last
    const to =
      event.key === 'ArrowLeft'
        ? Math.max(0, from - 1)
        : event.key === 'ArrowRight'
          ? Math.min(last, from + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (to !== null) {
      event.preventDefault()
      setActive(to)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        {/* Y axis: hours, top / middle / zero. */}
        <div
          aria-hidden
          className="relative w-6 shrink-0 text-right text-[10px] leading-none tabular-nums text-muted-foreground"
          style={{ height: HEIGHT_PX }}
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${100 - (tick / maxHours) * 100}%` }}
            >
              {tick}
            </span>
          ))}
        </div>
        <div
          role="group"
          tabIndex={0}
          aria-label={t(
            'auto.components.billing.usage.chartLabel',
            'Sandbox hours per day, last 30 days. Use the arrow keys to read each day.'
          )}
          onKeyDown={move}
          onFocus={() => setActive((current) => current ?? last)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          className="relative min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ height: HEIGHT_PX }}
        >
          {/* Hairline grid: top and middle; the baseline is drawn solid below. */}
          {ticks.slice(0, 2).map((tick) => (
            <div
              key={tick}
              aria-hidden
              className="absolute inset-x-0 border-t border-border/60"
              style={{ top: `${100 - (tick / maxHours) * 100}%` }}
            />
          ))}
          <div aria-hidden className="absolute inset-x-0 bottom-0 border-t border-border" />
          <div aria-hidden className="absolute inset-0 flex items-end gap-[2px]">
            {days.map((day, index) => (
              // The whole column is the hit target, not just the (often tiny) bar.
              <div
                key={day.start}
                className="flex h-full min-w-0 flex-1 items-end justify-center"
                onPointerEnter={() => setActive(index)}
              >
                <div
                  className={cn(
                    'w-full max-w-6 rounded-t-[4px]',
                    index === active ? 'bg-chart-4 dark:bg-chart-1' : 'bg-chart-3 dark:bg-chart-2'
                  )}
                  style={{
                    height: `${usageBarPercent(day.seconds, maxHours)}%`
                  }}
                />
              </div>
            ))}
          </div>
          {activeDay && active !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute -top-1 z-10 -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-sm"
              style={
                active > days.length / 2
                  ? { right: `${((last - active) / days.length) * 100}%` }
                  : { left: `${(active / days.length) * 100}%` }
              }
            >
              {usageDayLine(activeDay, locale, t)}
            </div>
          ) : null}
        </div>
      </div>
      <div
        aria-hidden
        className="flex justify-between pl-8 text-[10px] leading-none text-muted-foreground"
      >
        <span>{usageDayLabel(days[0]?.start ?? 0, locale)}</span>
        <span>{t('auto.components.billing.usage.today', 'Today')}</span>
      </div>
      {/* Screen readers: the active day as it changes, and every day in a table. */}
      <p role="status" className="sr-only">
        {activeDay ? usageDayLine(activeDay, locale, t) : ''}
      </p>
      <table className="sr-only">
        <caption>
          {t('auto.components.billing.usage.tableCaption', 'Sandbox hours per day')}
        </caption>
        <tbody>
          {days.map((day) => (
            <tr key={day.start}>
              <td>{usageDayLine(day, locale, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
