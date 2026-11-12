import { useMemo, useState } from 'react'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { cn } from '@/lib/class-names'
import type { TeammateUsage } from '../../../../shared/cloud-workspaces/team-presence-wire'
import { formatSandboxHours, sandboxHours } from '../cloud-workspaces/cloud-workspace-format'
import { calendarDate, layoutHeatmap, type HeatmapCell } from './teammate-heatmap'

// Intl formatter caches key on option identity, so these must be module constants.
const MONTH: Intl.DateTimeFormatOptions = { month: 'short' }
const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }

// One neutral ramp from the foreground color: reads in light and dark and never borrows a status color.
const LEVEL_CLASS = [
  'bg-muted',
  'bg-foreground/20',
  'bg-foreground/40',
  'bg-foreground/65',
  'bg-foreground/90'
] as const

function levelLabel(level: number, t: Translate): string {
  switch (level) {
    case 0:
      return t('auto.components.teammates.levelNone', 'No usage')
    case 1:
      return t('auto.components.teammates.levelLight', 'Light usage')
    case 2:
      return t('auto.components.teammates.levelModerate', 'Moderate usage')
    case 3:
      return t('auto.components.teammates.levelBusy', 'Busy day')
    default:
      return t('auto.components.teammates.levelPeak', 'One of their busiest days')
  }
}

function cellCaption(
  cell: HeatmapCell,
  usage: TeammateUsage,
  t: Translate,
  locale: string
): string {
  const day = uiDateTimeFormat(DAY, locale).format(calendarDate(cell.date))
  const own = usage.own
  if (!own) {
    return `${day} · ${levelLabel(cell.level, t)}`
  }
  const ms = own.computeMs[cell.index] ?? 0
  if (ms > 0) {
    const hours = t('auto.components.teammates.daySandboxHours', '{{hours}} sandbox hours', {
      count: sandboxHours(ms),
      hours: formatSandboxHours(ms, locale),
      defaultValue_one: '{{hours}} sandbox hour'
    })
    return `${day} · ${hours}`
  }
  return `${day} · ${
    cell.level > 0
      ? t('auto.components.teammates.dayAgentUsage', 'Agent usage')
      : t('auto.components.teammates.levelNone', 'No usage')
  }`
}

/** Daily usage over the last 26 weeks, one square per day; hover or focus a day for its detail. */
export function TeammateUsageHeatmap({
  usage,
  self,
  name
}: {
  usage: TeammateUsage
  self: boolean
  name: string
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const layout = useMemo(() => layoutHeatmap(usage.start, usage.levels), [usage])
  const [hovered, setHovered] = useState<HeatmapCell | null>(null)
  const summary = self
    ? t(
        'auto.components.teammates.heatmapSummarySelf',
        'You used Orca Cloud on {{active}} of the last {{days}} days',
        { active: usage.activeDays, days: usage.levels.length }
      )
    : t(
        'auto.components.teammates.heatmapSummary',
        '{{name}} used Orca Cloud on {{active}} of the last {{days}} days',
        { name, active: usage.activeDays, days: usage.levels.length }
      )
  const caption = hovered
    ? cellCaption(hovered, usage, t, locale)
    : usage.activeDays === 0
      ? t('auto.components.teammates.heatmapEmpty', 'No Orca Cloud usage in the last 26 weeks.')
      : self
        ? t(
            'auto.components.teammates.heatmapHintSelfHover',
            'Hover a day to see your sandbox hours.'
          )
        : t(
            'auto.components.teammates.heatmapHint',
            'Each day compared with their busiest day. Amounts stay private.'
          )
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1" onMouseLeave={() => setHovered(null)}>
          <div aria-hidden className="relative h-3.5 text-3xs text-muted-foreground">
            {layout.months.map((m) => (
              <span
                key={`${m.year}-${m.month}`}
                className="absolute top-0"
                // Each week column is 12px plus a 4px gap.
                style={{ left: m.week * 16 }}
              >
                {uiDateTimeFormat(MONTH, locale).format(new Date(m.year, m.month, 1))}
              </span>
            ))}
          </div>
          <div role="img" aria-label={summary} className="flex gap-1">
            {layout.weeks.map((days, week) => (
              <div key={week} className="flex flex-col gap-1">
                {days.map((cell, weekday) =>
                  cell ? (
                    <span
                      key={cell.date}
                      data-level={cell.level}
                      onMouseEnter={() => setHovered(cell)}
                      className={cn(
                        'size-3 rounded-[2px]',
                        LEVEL_CLASS[cell.level] ?? LEVEL_CLASS[0],
                        hovered?.date === cell.date &&
                          'ring-1 ring-foreground ring-offset-1 ring-offset-background'
                      )}
                    />
                  ) : (
                    <span key={`pad-${weekday}`} className="size-3" />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <p className="min-w-0 truncate" aria-hidden={hovered === null ? undefined : true}>
          {caption}
        </p>
        <span aria-hidden className="flex shrink-0 items-center gap-1">
          {t('auto.components.teammates.legendLess', 'Less')}
          {LEVEL_CLASS.map((cls) => (
            <span key={cls} className={cn('size-3 rounded-[2px]', cls)} />
          ))}
          {t('auto.components.teammates.legendMore', 'More')}
        </span>
      </div>
    </div>
  )
}
