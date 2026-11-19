import { Badge } from '@/components/ui/badge'
import { recomputeOn } from '@/lib/recompute-on'
import { formatUiNarrowDuration } from '@/i18n/relative-time-format'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/class-names'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration/orchestration-crew'

/** A compact age ("3m", "2h", "4d"), as the strip's other rows show elapsed time. */
function crewAge(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.justNow', 'Just now')
  }
  if (minutes < 60) {
    return formatUiNarrowDuration(minutes, 'minute')
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24
    ? formatUiNarrowDuration(hours, 'hour')
    : formatUiNarrowDuration(Math.floor(hours / 24), 'day')
}

export function CrewRowTime({ at, className }: { at?: string; className?: string }) {
  // Re-render on the sidebar's shared coarse tick so the age keeps advancing while the list is open.
  const now = useNow(30_000)
  if (!at) {
    return null
  }
  // Orchestration rows store SQLite UTC text ("YYYY-MM-DD HH:MM:SS") without a zone.
  const date = new Date(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`)
  return Number.isFinite(date.getTime()) ? (
    <time
      dateTime={date.toISOString()}
      className={cn('shrink-0 text-2xs text-muted-foreground', className)}
    >
      {recomputeOn([now], () => crewAge(date.getTime(), now))}
    </time>
  ) : null
}

export function CrewRowDetails({ row }: { row: OrchestrationCrewRow }) {
  const t = useTranslate()
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs [overflow-wrap:anywhere]">
      <dt className="text-muted-foreground">{t('components.orchestrationCrew.task', 'Task')}</dt>
      <dd className="min-w-0">
        {row.task ? (
          <>
            <Badge variant="outline" className="mr-1">
              {row.task.state}
            </Badge>
            {row.task.title}
          </>
        ) : (
          t('components.orchestrationCrew.noTask', 'No shared task')
        )}
      </dd>
      {row.latest ? (
        <>
          <dt className="text-muted-foreground">
            {t('components.orchestrationCrew.latest', 'Latest')}
          </dt>
          <dd className="min-w-0">
            <span className="text-2xs text-muted-foreground">
              {row.latest.direction === 'to'
                ? t('components.orchestrationCrew.to', 'To')
                : t('components.orchestrationCrew.from', 'From')}{' '}
              {row.label} · <CrewRowTime at={row.latest.at} />
            </span>
            <blockquote className="mt-1 whitespace-pre-wrap border-l border-border pl-2">
              {row.latest.preview}
            </blockquote>
          </dd>
        </>
      ) : null}
    </dl>
  )
}
