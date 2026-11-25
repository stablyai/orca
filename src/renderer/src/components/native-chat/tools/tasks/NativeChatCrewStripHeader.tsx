import type { AgentSessionBackgroundTask } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { CrewStripHeaderSegment } from './background-task-crew-header'
import { KIND_ICONS, kindIconTone } from './background-task-kind-icons'

/** The whole line on hover where a narrow strip shows only icons and numbers. */
export function NarrowHeaderTip(props: {
  text: string | null
  children: React.ReactElement
}): React.JSX.Element {
  if (props.text === null) {
    return props.children
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{props.children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {props.text}
      </TooltipContent>
    </Tooltip>
  )
}

/** The strip's one line once a crew joins it; narrow keeps the icons and numbers, the words on hover. */
export function CrewStripHeaderLine(props: {
  segments: readonly CrewStripHeaderSegment[]
  narrow: boolean
  dimmed: boolean
}): React.JSX.Element {
  return (
    <span className="min-w-0 truncate">
      {props.segments.map((segment, index) => (
        <span key={segment.key} className="inline-flex items-center align-middle">
          {index > 0 ? (
            <span className="whitespace-pre text-muted-foreground group-hover/task-header:text-accent-foreground">
              {' · '}
            </span>
          ) : null}
          {segment.key === 'needsYou' ? (
            <StatusIndicator status="permission" showTooltip={false} className="mr-1" />
          ) : (
            <CrewSegmentIcon kind={segment.key} dimmed={props.dimmed} />
          )}
          <span className="font-medium text-foreground group-hover/task-header:text-accent-foreground">
            {props.narrow ? segment.count : segment.text}
          </span>
        </span>
      ))}
    </span>
  )
}

function CrewSegmentIcon(props: {
  kind: AgentSessionBackgroundTask['kind']
  dimmed: boolean
}): React.JSX.Element {
  const Icon = KIND_ICONS[props.kind]
  return (
    <Icon
      aria-hidden="true"
      // Agents count the crew too, whose voice the turn doesn't own, so only other kinds dim.
      className={`mr-1 size-3 shrink-0 ${kindIconTone(props.kind, props.dimmed && props.kind !== 'agent')}`}
    />
  )
}
