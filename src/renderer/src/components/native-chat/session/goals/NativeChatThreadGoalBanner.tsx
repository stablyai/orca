import { useState } from 'react'
import { ChevronDown, ChevronUp, Goal, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/lib/window-activity/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { NativeChatComposerTabStrip } from '../../composer/controls/NativeChatComposerTabStrip'
import type { AgentSessionGoalDisplay } from '../../../../../../shared/agent-session/thread-goals/agent-session-goal-check-display'
import {
  agentSessionThreadGoalElapsedSeconds,
  agentSessionThreadGoalOfferedStatusChange
} from '../../../../../../shared/agent-session/thread-goals/agent-session-thread-goal'
import type { AgentSessionThreadGoalChange } from '../../../../../../shared/agent-session/thread-goals/agent-session-thread-goal-wire'
import { formatAgentSessionThreadGoalElapsed } from '../../../../../../shared/agent-session/view/agent-session-thread-goal-presentation'
import { nativeChatThreadGoalStatusLabel } from './native-chat-thread-goal-presentation'

function GoalAction(props: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
  expanded?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={props.label}
          aria-expanded={props.expanded}
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
  goal: AgentSessionGoalDisplay
  objectiveContent?: React.ReactNode
  pending: boolean
  /** False where only the agent's own `/goal` changes the goal, which has no pause. */
  hostChanges: boolean
  /** The agent's own `/goal` resumes a paused goal. */
  agentResumes?: boolean
  /** The composer cannot admit another message or the session is working. */
  sendUnavailable: boolean
  /** The host may take no turn now: Resume, and a clear that enters a turn, are held. */
  startsHeld?: boolean
  isVisible: boolean
  /** The session's running turn, or null when idle; goal time accrues only while one runs. */
  runningTurn: { startedAt: number | null } | null
  onChange: (change: AgentSessionThreadGoalChange) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const { goal, onChange } = props
  const [expanded, setExpanded] = useState(false)
  const { runningTurn } = props
  const now = useNow(1_000, props.isVisible && goal.status === 'active' && runningTurn !== null)
  const label = nativeChatThreadGoalStatusLabel(goal.status, runningTurn !== null, t)
  const statusChange = agentSessionThreadGoalOfferedStatusChange(goal.status, {
    hostChanges: props.hostChanges,
    agentResumes: props.agentResumes === true
  })
  // An agent-owned change is a message that must enter a fresh turn, like a composer send.
  const agentCommandUnavailable =
    !props.hostChanges && (props.sendUnavailable || props.startsHeld === true)
  if (label === null) {
    return null
  }
  const elapsed = formatAgentSessionThreadGoalElapsed(
    agentSessionThreadGoalElapsedSeconds(goal, now, runningTurn)
  )
  const expandLabel = expanded
    ? t('components.native-chat.goal.collapse', 'Hide full goal')
    : t('components.native-chat.goal.expand', 'Show full goal')
  return (
    <NativeChatComposerTabStrip layout="stack" data-native-chat-thread-goal={goal.status}>
      <div className="flex items-start gap-2 py-1 pr-1 pl-3">
        <Goal aria-hidden className="mt-1 size-3.5 shrink-0" />
        <p className={cn('min-w-0 flex-1 py-0.5', expanded ? 'break-words' : 'truncate')}>
          <span className="font-semibold text-foreground">{label}</span>{' '}
          <span>{props.objectiveContent ?? goal.objective}</span>
          <span className="tabular-nums">{` • ${elapsed}`}</span>
        </p>
        {goal.checks ? (
          <span className="shrink-0 py-0.5 tabular-nums">
            {t('components.native-chat.goal.checks', '{{count}} checks', {
              count: goal.checks,
              defaultValue_one: '{{count}} check'
            })}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center">
          <GoalAction
            label={t('components.native-chat.goal.clear', 'Clear goal')}
            disabled={agentCommandUnavailable}
            onClick={() => onChange({ kind: 'clear' })}
          >
            <Trash2 className="size-3.5" />
          </GoalAction>
          {statusChange === 'paused' ? (
            <GoalAction
              label={t('components.native-chat.goal.pause', 'Pause goal')}
              disabled={false}
              onClick={() => onChange({ kind: 'status', status: 'paused' })}
            >
              <Pause className="size-3.5" />
            </GoalAction>
          ) : statusChange === 'active' ? (
            <GoalAction
              label={t('components.native-chat.goal.resume', 'Resume goal')}
              disabled={props.startsHeld === true || agentCommandUnavailable}
              onClick={() => onChange({ kind: 'status', status: 'active' })}
            >
              <Play className="size-3.5" />
            </GoalAction>
          ) : null}
          <GoalAction
            label={expandLabel}
            disabled={false}
            expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </GoalAction>
        </div>
      </div>
      {expanded && goal.lastCheck ? (
        <div className="max-h-40 overflow-y-auto px-3 pt-1 pb-2 whitespace-pre-wrap break-words text-sm text-foreground scrollbar-sleek">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">
            {t('components.native-chat.goal.last-check', 'Last goal check')}
          </p>
          {goal.lastCheck}
        </div>
      ) : null}
    </NativeChatComposerTabStrip>
  )
}
