import { Bot, ExternalLink } from 'lucide-react'
import type { AgentChildRowModel } from '../../../../../../shared/agent-status/presentation/agent-child-row-model'
import {
  backgroundTaskRowMeta,
  backgroundTaskRowStopId
} from '../../../../../../shared/agent-status/presentation/background-tasks/background-task-roster'
import { AgentChildRowContent } from '@/components/agent/status/AgentChildRowContent'
import { agentChildRowName } from '@/components/agent/status/agent-child-row-text'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { CrewStripRowEnd } from '../../../orchestration-crew/CrewStripRow'
import { sayBackgroundTaskTranslated as say } from './background-task-words-text'

/** A subagent among a crew's workers, in their row shape: it has no address, so a click names it. */
export function NativeChatCrewSubagentRow(props: {
  row: AgentChildRowModel
  now: number
  supportsTaskStop: boolean
  stoppingTaskIds: ReadonlySet<string>
  onStop: (taskId: string) => void
  onShowAgent?: (providerId: string) => void
  currentAgentId?: string | null
  onName: (name: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { row, now } = props
  const meta = backgroundTaskRowMeta(row, now)
  const stopId = backgroundTaskRowStopId(row, props.supportsTaskStop)
  const shownId = row.kind === 'agent' && props.onShowAgent ? row.providerId : undefined
  const name = agentChildRowName(row)
  return (
    <li className="group/crew-row min-w-0">
      <div className="flex h-6 min-w-0 items-center gap-2 text-foreground">
        <button
          type="button"
          data-native-chat-agent-row={shownId}
          aria-current={props.currentAgentId === shownId && shownId ? 'true' : undefined}
          className="-mx-1 flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t(
            'components.native-chat.backgroundTasks.nameInMessage',
            'Add {{name}} to message',
            { name }
          )}
          // Keep focus in the composer the name lands in.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => props.onName(name)}
        >
          <AgentChildRowContent
            row={row}
            now={now}
            icon={<Bot aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
            badge={
              <Badge variant="referenceLabel" className="mx-1.5 align-[1px]">
                {t('components.native-chat.backgroundTasks.subagentBadge', 'Subagent')}
              </Badge>
            }
            leadClassName="font-medium text-foreground"
            trailClassName="text-muted-foreground"
            separator=" "
            dotTitle={null}
          />
        </button>
        <CrewStripRowEnd
          time={meta ? <span className="font-mono text-3xs tabular-nums">{meta}</span> : null}
        >
          {shownId !== undefined ? (
            <IconButtonWithTip
              label={t('components.native-chat.backgroundTasks.openAgent', 'Open {{value0}}', {
                value0: name
              })}
              onClick={() => props.onShowAgent?.(shownId)}
            >
              <ExternalLink />
            </IconButtonWithTip>
          ) : null}
          {stopId !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={say('stopTask', { value0: name })}
              disabled={props.stoppingTaskIds.has(stopId)}
              onClick={() => props.onStop(stopId)}
            >
              {say('stop')}
            </Button>
          ) : null}
        </CrewStripRowEnd>
        {/* The space a worker row's › takes, so the time column lines up. */}
        <span aria-hidden className="size-6 shrink-0" />
      </div>
    </li>
  )
}

function IconButtonWithTip({
  label,
  children,
  onClick
}: {
  label: string
  children: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
