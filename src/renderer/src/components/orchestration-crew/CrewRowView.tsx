import { memo, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openOrchestrationCrewAgent } from '@/lib/open-agent-message-sender'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { CrewRowDetails, CrewRowTime as Time } from './CrewRowDetails'
import { CrewRowMenu } from './CrewRowMenu'
import { CrewAgentIcons, type CrewRowLook } from './CrewAgentIcons'

export function IconButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

// Memoized so one agent's status change re-renders only that row.
export const CrewRowView = memo(function CrewRowView({
  row,
  look,
  target,
  isVisible
}: {
  row: OrchestrationCrewRow
  look: CrewRowLook
  target: RuntimeClientTarget
  isVisible: boolean
}) {
  // A pending question already shows on the row's second line, so rows start collapsed.
  const [expanded, setExpanded] = useState(false)
  const open = () => {
    void openOrchestrationCrewAgent(row, target)
  }
  const toggle = () => setExpanded((value) => !value)
  return (
    <div className="mx-2 mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-lg border border-transparent px-2.5 py-2 hover:border-border/70 hover:bg-accent/50">
      <button
        type="button"
        className="row-span-2 grid min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <CrewAgentIcons look={look} hostLabel={row.hostLabel} />
        <span className="truncate text-[13px] font-medium">{row.task?.title ?? row.label}</span>
        <span
          className={cn(
            'col-start-2 truncate text-xs',
            row.pendingQuestion ? 'text-status-warning' : 'text-muted-foreground'
          )}
        >
          {row.pendingQuestion
            ? `${translate('components.orchestrationCrew.waitingPrefix', 'Waiting for you · ')}${row.pendingQuestion.preview}`
            : (row.latest?.preview ?? row.progress ?? '')}
        </span>
      </button>
      <div className="flex shrink-0 items-center">
        <IconButton
          label={translate(
            'components.orchestrationCrew.showDetails',
            "Show {{name}}'s task and latest message",
            { name: row.label }
          )}
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </IconButton>
        <IconButton
          label={translate('components.orchestrationCrew.open', 'Open {{name}}', {
            name: row.label
          })}
          onClick={open}
        >
          <ExternalLink />
        </IconButton>
        {isVisible ? <CrewRowMenu row={row} open={open} /> : null}
      </div>
      <Time className="justify-self-end pr-1" at={row.pendingQuestion?.at ?? row.latest?.at} />
      {!row.sendAddress ? (
        <p className="col-span-2 pt-1 text-xs text-muted-foreground">
          {translate('components.orchestrationCrew.sendingUnavailable', 'Sending unavailable')}
        </p>
      ) : null}
      {expanded ? (
        <div className="col-span-2 pt-2">
          <CrewRowDetails row={row} />
        </div>
      ) : null}
    </div>
  )
})
