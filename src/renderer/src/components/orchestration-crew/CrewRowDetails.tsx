import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 text-xs">
      <dt className="text-2xs text-muted-foreground">
        {t('components.orchestrationCrew.task', 'Task')}
      </dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">
        {row.task?.state === 'failed' ? (
          <span className="text-destructive">
            {t('components.orchestrationCrew.taskFailed', 'Failed')} ·{' '}
          </span>
        ) : null}
        {row.task?.title ?? t('components.orchestrationCrew.noTask', 'No shared task')}
      </dd>
      <dt className="text-2xs text-muted-foreground">
        {t('components.orchestrationCrew.reply', 'Reply')}
      </dt>
      <dd className="min-w-0 text-muted-foreground">
        {row.reply ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="truncate">{row.reply.preview}</p>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-96 whitespace-pre-wrap">
              {row.reply.preview}
            </TooltipContent>
          </Tooltip>
        ) : (
          t('components.orchestrationCrew.noReply', 'No reply yet')
        )}
      </dd>
    </dl>
  )
}
