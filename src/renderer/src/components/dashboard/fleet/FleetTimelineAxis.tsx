import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { fleetTimelineGridClass } from './fleet-timeline-grid'
import type { FleetTimelineTick } from './fleet-timeline-ticks'

const LABEL_CLASS = 'text-2xs font-semibold tracking-wider text-muted-foreground uppercase'

function tickLabel(minutesAgo: number, t: Translate): string {
  if (minutesAgo === 0) {
    return t('dashboard.fleet.timeline.now', 'now')
  }
  if (minutesAgo < 60) {
    return t('dashboard.fleet.timeline.minutesAgo', '{{count}}m ago', { count: minutesAgo })
  }
  if (minutesAgo < 1440) {
    return t('dashboard.fleet.timeline.hoursAgo', '{{count}}h ago', { count: minutesAgo / 60 })
  }
  return t('dashboard.fleet.timeline.daysAgo', '{{count}}d ago', { count: minutesAgo / 1440 })
}

function tickAlignClass(percent: number): string {
  if (percent >= 99) {
    return '-translate-x-full'
  }
  return percent <= 1 ? '' : '-translate-x-1/2'
}

export function FleetTimelineAxis({
  ticks,
  className
}: {
  ticks: readonly FleetTimelineTick[]
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={cn(fleetTimelineGridClass, 'h-8', className)}>
      <span className={LABEL_CLASS}>{t('dashboard.fleet.timeline.agent', 'Agent')}</span>
      <div className="relative h-full @max-[40rem]:hidden">
        {ticks.map((tick) => (
          <span
            key={tick.minutesAgo}
            className={cn(
              'absolute top-1/2 -translate-y-1/2 text-2xs whitespace-nowrap tabular-nums text-muted-foreground',
              tickAlignClass(tick.percent)
            )}
            style={{ left: `${tick.percent}%` }}
          >
            {tickLabel(tick.minutesAgo, t)}
          </span>
        ))}
      </div>
      <span className={cn(LABEL_CLASS, 'text-right')}>
        {t('dashboard.fleet.timeline.elapsed', 'Elapsed')}
      </span>
    </div>
  )
}
