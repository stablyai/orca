import { useState } from 'react'
import { ChevronDown, ChevronUp, Goal, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { NativeChatComposerTabStrip } from './NativeChatComposerTabStrip'
import type { AgentJournalThreadGoal } from '../../../../shared/agent-session-journal-types'
import {
  agentSessionThreadGoalElapsedSeconds,
  agentSessionThreadGoalStatusChange
} from '../../../../shared/agent-session/agent-session-thread-goal'
import type { AgentSessionThreadGoalChange } from '../../../../shared/agent-session/agent-session-thread-goal-wire'
import {
  formatNativeChatThreadGoalElapsed,
  nativeChatThreadGoalStatusLabel
} from './native-chat-thread-goal-presentation'

function GoalAction(props: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={props.label}
          disabled={props.disabled}
          onClick={props.onClick}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {props.label}
      </TooltipContent>
    </Tooltip>
  )
}

export function NativeChatThreadGoalBanner(props: {
  goal: AgentJournalThreadGoal
  pending: boolean
  /** False where only the agent's own `/goal` changes the goal, which has no pause. */
  hostChanges: boolean
  /** The composer cannot admit another message or the session is working. */
  sendUnavailable: boolean
  /** The host may take no turn now: Resume, and a clear that enters a turn, are held. */
  startsHeld?: boolean
  isVisible: boolean
  /** The session's running turn, or null when idle; goal time accrues only while one runs. */
  runningTurn: { startedAt: number | null } | null
  onChange: (change: AgentSessionThreadGoalChange) => void
}): React.JSX.Element | null {
  const { goal, onChange } = props
  const [expanded, setExpanded] = useState(false)
  const { runningTurn } = props
  const now = useNow(1_000, props.isVisible && goal.status === 'active' && runningTurn !== null)
  const label = nativeChatThreadGoalStatusLabel(goal.status, runningTurn !== null)
  const statusChange = props.hostChanges ? agentSessionThreadGoalStatusChange(goal.status) : null
  if (label === null) {
    return null
  }
  const elapsed = formatNativeChatThreadGoalElapsed(
    agentSessionThreadGoalElapsedSeconds(goal, now, runningTurn)
  )
  const expandLabel = expanded
    ? translate('components.native-chat.goal.collapse', 'Hide full goal')
    : translate('components.native-chat.goal.expand', 'Show full goal')
  return (
    <NativeChatComposerTabStrip data-native-chat-thread-goal={goal.status}>
      <Goal aria-hidden className="mt-1 size-3.5 shrink-0" />
      <p className={cn('min-w-0 flex-1 py-0.5', expanded ? 'break-words' : 'truncate')}>
        <span className="font-semibold text-foreground">{label}</span> <span>{goal.objective}</span>
        <span className="tabular-nums">{` • ${elapsed}`}</span>
      </p>
      <div className="flex shrink-0 items-center">
        <GoalAction
          label={translate('components.native-chat.goal.clear', 'Clear goal')}
          // Claude's `/goal clear` must enter a fresh turn, like a composer send.
          disabled={!props.hostChanges && (props.sendUnavailable || props.startsHeld === true)}
          onClick={() => onChange({ kind: 'clear' })}
        >
          <Trash2 className="size-3.5" />
        </GoalAction>
        {statusChange === 'paused' ? (
          <GoalAction
            label={translate('components.native-chat.goal.pause', 'Pause goal')}
            disabled={false}
            onClick={() => onChange({ kind: 'status', status: 'paused' })}
          >
            <Pause className="size-3.5" />
          </GoalAction>
        ) : statusChange === 'active' ? (
          <GoalAction
            label={translate('components.native-chat.goal.resume', 'Resume goal')}
            disabled={props.startsHeld === true}
            onClick={() => onChange({ kind: 'status', status: 'active' })}
          >
            <Play className="size-3.5" />
          </GoalAction>
        ) : null}
        <GoalAction label={expandLabel} disabled={false} onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </GoalAction>
      </div>
    </NativeChatComposerTabStrip>
  )
}
