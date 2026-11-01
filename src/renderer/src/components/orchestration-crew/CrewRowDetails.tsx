import { Badge } from '@/components/ui/badge'
import { formatTimeAgo } from '@/components/right-sidebar/ai-vault-session-time'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'

export function CrewRowTime({ at, className }: { at?: string; className?: string }) {
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
      {formatTimeAgo(date.getTime())}
    </time>
  ) : null
}

export function CrewRowDetails({ row }: { row: OrchestrationCrewRow }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
      <dt className="text-muted-foreground">
        {translate('components.orchestrationCrew.task', 'Task')}
      </dt>
      <dd>
        {row.task ? (
          <>
            <Badge variant="outline" className="mr-1">
              {row.task.state}
            </Badge>
            {row.task.title}
          </>
        ) : (
          translate('components.orchestrationCrew.noTask', 'No shared task')
        )}
      </dd>
      {row.progress ? (
        <>
          <dt className="text-muted-foreground">
            {translate('components.orchestrationCrew.progress', 'Progress')}
          </dt>
          <dd>{row.progress}</dd>
        </>
      ) : null}
      {row.pendingQuestion ? (
        <>
          <dt className="text-status-warning">
            {translate('components.orchestrationCrew.asksYou', 'Asks you')}
          </dt>
          <dd className="whitespace-pre-wrap break-words">{row.pendingQuestion.preview}</dd>
        </>
      ) : row.latest ? (
        <>
          <dt className="text-muted-foreground">
            {translate('components.orchestrationCrew.latest', 'Latest')}
          </dt>
          <dd className="min-w-0">
            <span className="text-2xs text-muted-foreground">
              {row.latest.direction === 'to'
                ? translate('components.orchestrationCrew.to', 'To')
                : translate('components.orchestrationCrew.from', 'From')}{' '}
              {row.label} · <CrewRowTime at={row.latest.at} />
            </span>
            <blockquote className="mt-1 whitespace-pre-wrap break-words border-l border-border pl-2">
              {row.latest.preview}
            </blockquote>
          </dd>
        </>
      ) : null}
    </dl>
  )
}
