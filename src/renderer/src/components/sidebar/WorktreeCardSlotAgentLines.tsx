import React, { useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { viewClaudeAgentFromRow } from '@/lib/claude-agent-row-view'
import { agentVerdictStatusLine } from '@/lib/agent-verdict-status-line'
import { cn } from '@/lib/utils'
import { getAgentRowPrimaryText } from '../../../../shared/agent-status/presentation/agent-row-primary-text'
import { activateRetainedAgentRow } from './workspace-card/activity/activate-retained-agent-row'
import { useFocusedAgentPaneKey } from './workspace-card/activity/focused-agent-row-highlight'
import { useWorktreeAgentActivation } from './workspace-card/activity/use-worktree-agent-activation'
import { formatSummaryStateLabel } from './workspace-card/activity/worktree-card-agent-summary'
import { getCompactAgentSecondary } from './workspace-card/activity/worktree-card-compact-agent-row'
import { slotForLine, type SlotLineSignal } from './worktree-card-slot-signal'
import type { AgentDotState } from '@/components/AgentStateDot'
import { WorktreeCardSlot } from './WorktreeCardSlot'

export type SlotAgentLine = {
  agent: DashboardAgentRow
  dotState: AgentDotState
  signal: SlotLineSignal
}

function lineText(agent: DashboardAgentRow, conversationName: string | null, now: number): string {
  const secondary = getCompactAgentSecondary(agent, now)
  const request = conversationName ?? getAgentRowPrimaryText(agent.entry)
  // The slot already says Failed/Interrupted; keep only the error detail, else the request.
  const verdictLine = agentVerdictStatusLine(agent.entry)
  if (verdictLine && secondary === verdictLine) {
    const separator = verdictLine.indexOf(': ')
    return separator > 0 ? verdictLine.slice(separator + 2) : request || secondary
  }
  // The type label is only the fallback; the user's request says more.
  if (secondary && secondary !== formatAgentTypeLabel(agent.agentType)) {
    return secondary
  }
  return request || secondary
}

const SlotAgentLineRow = React.memo(function SlotAgentLineRow({
  line,
  now,
  offline,
  focused,
  onActivate
}: {
  line: SlotAgentLine
  now: number
  offline: boolean
  focused: boolean
  onActivate: (agent: DashboardAgentRow) => void
}): React.JSX.Element {
  const { agent, signal } = line
  const conversationName = useAgentRowConversationName(agent)
  const detail = lineText(agent, conversationName, now)
  const text = offline
    ? translate('sidebar.cardSlot.lastSeen', 'Last seen {{state}}', {
        state: formatSummaryStateLabel(line.dotState)
      }) + (detail ? ` · ${detail}` : '')
    : detail
  const quiet = offline || signal.kind === 'seen' || signal.kind === 'idle'
  const agentLabel = formatAgentTypeLabel(agent.agentType)
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      onActivate(agent)
    },
    [agent, onActivate]
  )

  return (
    <button
      type="button"
      draggable={false}
      className={cn(
        'worktree-agent-row-hover flex h-[19px] w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-2xs leading-none outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
        focused && 'bg-worktree-sidebar-accent'
      )}
      onClick={handleClick}
      title={`${agentLabel} · ${text}`}
      data-worktree-card-slot-line={signal.kind}
      data-focused-agent-pane={focused ? 'true' : undefined}
    >
      <span className="inline-flex shrink-0" aria-label={agentLabel}>
        <AgentTypeIcon agentType={agent.agentType} size={13} />
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          signal.kind === 'unread' && !offline
            ? 'text-foreground'
            : quiet
              ? 'text-muted-foreground/70'
              : 'text-muted-foreground'
        )}
      >
        {text}
      </span>
      <WorktreeCardSlot signal={slotForLine(signal)} now={now} stale={offline} />
    </button>
  )
})

/** Expanded agents' header: the label sits in the icon column and the chevron in the slot column. */
export function SlotAgentLinesHeader({
  label,
  onCollapse
}: {
  label: string
  onCollapse: () => void
}): React.JSX.Element {
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      onCollapse()
    },
    [onCollapse]
  )
  return (
    <button
      type="button"
      draggable={false}
      className="worktree-agent-row-hover mt-[3px] flex h-[19px] w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-2xs leading-none font-medium text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
      aria-expanded={true}
      aria-label={translate(
        'auto.components.sidebar.worktree.card.compact.agents.0c1debfe84',
        'Collapse {{value0}}',
        { value0: label }
      )}
      onClick={handleClick}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronDown className="size-3 shrink-0" aria-hidden />
    </button>
  )
}

function stopPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

/** Experimental 2.0 agent lines: icon, what it's doing or said, and the line's own slot. */
export function WorktreeCardSlotAgentLines({
  worktreeId,
  lines,
  now,
  offline
}: {
  worktreeId: string
  lines: readonly SlotAgentLine[]
  now: number
  offline: boolean
}): React.JSX.Element | null {
  const focusedPaneKey = useFocusedAgentPaneKey(worktreeId)
  const activateAgentTab = useWorktreeAgentActivation(worktreeId)
  const handleActivate = useCallback(
    (agent: DashboardAgentRow) => {
      const paneKey = agent.activationPaneKey ?? agent.paneKey
      if (agent.rowSource === 'retained') {
        activateRetainedAgentRow(worktreeId, agent.tab.id, paneKey)
      } else {
        activateAgentTab(agent.tab.id, paneKey)
      }
      void viewClaudeAgentFromRow(agent)
    },
    [activateAgentTab, worktreeId]
  )
  const stopBubble = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  if (lines.length === 0) {
    return null
  }
  return (
    <div
      className="mt-px flex flex-col gap-px"
      role="group"
      aria-label={translate('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
      onDoubleClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
    >
      {lines.map((line) => (
        <SlotAgentLineRow
          key={line.agent.paneKey}
          line={line}
          now={now}
          offline={offline}
          focused={line.agent.paneKey === focusedPaneKey}
          onActivate={handleActivate}
        />
      ))}
    </div>
  )
}
