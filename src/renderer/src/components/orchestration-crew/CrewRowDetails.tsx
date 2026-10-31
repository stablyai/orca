import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import { isAgentStatusState } from '../../../../shared/agent-status-types'
import { mapAgentStatusStateToVisualStatus } from '@/lib/agent-status'
import StatusIndicator from '../sidebar/StatusIndicator'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'

export function CrewRowAvatar({
  row,
  tooltip = false
}: {
  row: OrchestrationCrewRow
  tooltip?: boolean
}) {
  const agent = isTuiAgent(row.agentKind) ? row.agentKind : null
  const label = agent ? getAgentLabel(agent) : formatAgentTypeLabel(row.agentKind)
  const description = row.hostLabel ? `${label} · ${row.hostLabel}` : label
  const icon = (
    <span
      aria-hidden={tooltip ? undefined : true}
      role={tooltip ? 'img' : undefined}
      aria-label={tooltip ? description : undefined}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
    >
      <AgentIcon agent={agent} />
    </span>
  )
  return tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>{icon}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {description}
      </TooltipContent>
    </Tooltip>
  ) : (
    icon
  )
}
export function CrewRowStatusDot({ row }: { row: OrchestrationCrewRow }) {
  return (
    <StatusIndicator
      aria-label={row.status}
      showTooltip={false}
      status={
        row.pendingQuestion
          ? 'permission'
          : isAgentStatusState(row.status)
            ? mapAgentStatusStateToVisualStatus(row.status)
            : 'inactive'
      }
    />
  )
}
export function CrewRowTime({ at }: { at?: string }) {
  if (!at) {
    return null
  }
  const date = new Date(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`)
  return Number.isFinite(date.getTime()) ? (
    <time dateTime={date.toISOString()} className="shrink-0 text-2xs text-muted-foreground">
      {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </time>
  ) : null
}

export function CrewRowDetails({ row }: { row: OrchestrationCrewRow }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 px-3 pb-3 text-xs">
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
