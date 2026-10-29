import React, { useCallback, useEffect, useRef } from 'react'
import { DashboardAgentChildDisclosure } from '@/components/dashboard/DashboardAgentChildDisclosure'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentChildRowContent } from '@/components/AgentChildRowContent'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { viewClaudeAgentFromRow } from '@/lib/claude-agent-row-view'
import { useClaudeAgentRowView } from '@/components/dashboard/use-claude-agent-row-view'
import { getAgentDotState } from './worktree-card-agent-summary'
import { getAgentRowPrimaryText } from '../../../../shared/agent-row-primary-text'
import { formatAgentToolPreview } from '@/lib/agent-row-tool-preview'
import { agentNoUpdateLabel } from '../../../../shared/agent-row-decay-state'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import CacheTimer, { usePromptCacheCountdownForPane } from './CacheTimer'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { agentVerdictStatusLine } from '@/lib/agent-verdict-status-line'
import { agentRowStoppingLabel } from '@/lib/agent-row-stopping-label'
import { getCompactAgentLineOrder } from './worktree-card-compact-agent-line-order'
import {
  programStatusAttentionLine,
  type ProgramStatusPresentation
} from '../../../../shared/program-status/presentation'
import { resolveRowProgramStatus } from '@/lib/program-status/agent-row-presentation'

function getCompactAgentPrimary(
  agent: DashboardAgentRowData,
  conversationName: string | null
): string {
  const prompt = conversationName ?? getAgentRowPrimaryText(agent.entry)
  return prompt || agentStateLabel(getAgentDotState(agent))
}

export function getCompactAgentSecondary(
  agent: DashboardAgentRowData,
  now: number,
  lastAssistantMessageOverride?: string,
  presentation: ProgramStatusPresentation = resolveRowProgramStatus(agent).presentation
): string {
  // Program-reported blocks need user attention before other row details.
  if (presentation.attention) {
    return programStatusAttentionLine(presentation.attention)
  }
  const verdictLine = agentVerdictStatusLine(agent.entry)
  if (verdictLine) {
    return verdictLine
  }
  // Silence proves only time without updates; do not infer what the pane is doing.
  if (agent.state === 'unverifiable') {
    return agentNoUpdateLabel(agent.entry, now)
  }
  const stoppingLabel = agentRowStoppingLabel(agent.entry, agent.state)
  if (stoppingLabel) {
    return stoppingLabel
  }
  // Why: the lead turn is over in monitoring, so its last tool line is stale; name the state instead.
  if (agent.state === 'working' && agent.entry.workingMode === 'monitoring') {
    return agentStateLabel('monitoring')
  }
  const toolPreview = formatAgentToolPreview(agent.entry, agent.state)
  if (toolPreview) {
    return toolPreview
  }
  if (presentation.message) {
    return presentation.message
  }
  const lastAssistantMessage =
    lastAssistantMessageOverride ?? agent.entry.lastAssistantMessage?.trim()
  if (lastAssistantMessage) {
    return lastAssistantMessage
  }
  // Why: child rows without descriptions use their role as primary text; repeating its formatted label adds no information.
  if (agent.rowSource === 'subagent' && agent.entry.prompt?.trim() === agent.agentType.trim()) {
    return ''
  }
  return formatAgentTypeLabel(agent.agentType)
}

function getCompactAgentTime(agent: DashboardAgentRowData, now: number): string | null {
  const doneAt = lastEnteredDoneAt(agent)
  if (doneAt !== null) {
    return formatShortTimeAgo(doneAt, now)
  }
  const startedAt = agent.startedAt > 0 ? agent.startedAt : agent.entry.stateStartedAt
  return startedAt > 0 ? formatShortTimeAgo(startedAt, now) : null
}

type CompactAgentRowProps = {
  agent: DashboardAgentRowData
  now: number
  onActivate: (tabId: string, paneKey: string) => void
  // Send-target mode temporarily turns compact rows into the picker, matching full agent rows.
  sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
  sendTargetDisabledReason?: string
  onSendTargetClick?: (paneKey: string) => void
  childAgentCount?: number
  childAgentsExpanded?: boolean
  onToggleChildAgents?: () => void
  isFocusedPane?: boolean
  hideIdentityIcon?: boolean
  cacheTimerActive?: boolean
  isUnvisited?: boolean
}

export const CompactAgentRow = React.memo(function CompactAgentRow({
  agent,
  now,
  onActivate,
  sendTargetStatus,
  sendTargetDisabledReason,
  onSendTargetClick,
  childAgentCount,
  childAgentsExpanded = false,
  onToggleChildAgents,
  isFocusedPane = false,
  hideIdentityIcon = false,
  cacheTimerActive = true,
  isUnvisited = false
}: CompactAgentRowProps) {
  const view = useClaudeAgentRowView(agent)
  const highlighted = view ? view.current && view.focused : isFocusedPane
  const hasChildDisclosure =
    typeof childAgentCount === 'number' &&
    childAgentCount > 0 &&
    typeof onToggleChildAgents === 'function'
  // Child agentType contains its name, not a provider; nesting conveys identity without a misleading letter icon.
  const hideIcon = hideIdentityIcon || agent.rowSource === 'subagent'
  const { presentation, dotStateOverride } = resolveRowProgramStatus(agent)
  const dotState = dotStateOverride ?? getAgentDotState(agent)
  const conversationName = useAgentRowConversationName(agent)
  const primary = getCompactAgentPrimary(agent, conversationName)
  const isLineageChild = agent.lineage?.depth === 1
  // Hold assistant text per positive turn clock; commit in an effect so discarded renders cannot cache messages.
  const turn = agent.entry.stateStartedAt
  const currentMessage = agent.entry.lastAssistantMessage?.trim() ?? ''
  const turnHoldable = agent.state === 'working' && turn > 0
  const heldMessageRef = useRef<{ turn: number; message: string } | null>(null)
  useEffect(() => {
    if (turnHoldable && currentMessage) {
      heldMessageRef.current = { turn, message: currentMessage }
    } else if (!turnHoldable) {
      heldMessageRef.current = null
    }
  }, [turnHoldable, turn, currentMessage])
  const held = heldMessageRef.current
  const stableMessage =
    turnHoldable && !currentMessage && held?.turn === turn ? held.message : undefined
  const secondary = getCompactAgentSecondary(agent, now, stableMessage, presentation)
  const { leadingText, trailingText } = getCompactAgentLineOrder(
    agent,
    dotState,
    primary,
    secondary
  )
  const rowTitle = `${leadingText}${trailingText ? ` - ${trailingText}` : ''}`
  const model = agent.entry.model?.trim() ?? ''
  const shortTime = getCompactAgentTime(agent, now)
  const cacheTimer = usePromptCacheCountdownForPane(agent.paneKey, cacheTimerActive)

  const handleActivate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // Child agents activate their spawning parent pane because they have no pane of their own.
      onActivate(agent.tab.id, agent.activationPaneKey ?? agent.paneKey)
      void viewClaudeAgentFromRow(agent)
    },
    [agent, onActivate]
  )
  const handleSendTargetClickCapture = useCallback(
    (e: React.MouseEvent) => {
      if (!sendTargetStatus) {
        return
      }
      const target = e.target
      if (
        target instanceof Element &&
        target.closest('button, a, input, textarea, select, [role="button"]')
      ) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (sendTargetStatus === 'eligible') {
        onSendTargetClick?.(agent.paneKey)
      }
    },
    [agent.paneKey, onSendTargetClick, sendTargetStatus]
  )
  const timestamp = shortTime ? (
    <span
      className={cn(
        'shrink-0 text-[10px] tabular-nums',
        highlighted ? 'text-foreground/70' : 'text-muted-foreground/60'
      )}
    >
      {shortTime}
    </span>
  ) : null

  // Focused fills wash out muted text; brighten the lead while preserving unread emphasis.
  const leadClassName = cn(
    isUnvisited ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground/90',
    highlighted && !isUnvisited && 'text-foreground'
  )

  const rowBody = (
    <>
      {agent.childRow ? (
        // Share chat-strip child content so both surfaces report the same state.
        <AgentChildRowContent
          row={agent.childRow}
          now={now}
          leadClassName={leadClassName}
          trailClassName={highlighted ? 'text-foreground/70' : 'text-muted-foreground/65'}
          separator=" - "
          dotTitle={sendTargetDisabledReason ? null : undefined}
          tooltipSide="right"
          lineTitle={!sendTargetDisabledReason}
        />
      ) : (
        <>
          {/* Show the actionable disabled reason over every hit area. */}
          <AgentStateDot
            state={dotState}
            size="sm"
            title={sendTargetDisabledReason ? null : undefined}
            tooltipSide="right"
            progress={presentation.progress}
          />
          {!hideIcon && (
            <span className="inline-flex shrink-0" title={formatAgentTypeLabel(agent.agentType)}>
              <AgentTypeIcon agentType={agent.agentType} size={13} />
            </span>
          )}
          <span
            className="min-w-0 flex-1 truncate"
            title={sendTargetDisabledReason ? undefined : rowTitle}
          >
            <span className={leadClassName}>{leadingText}</span>
            {trailingText && (
              <span className={highlighted ? 'text-foreground/70' : 'text-muted-foreground/65'}>
                {' '}
                - {trailingText}
              </span>
            )}
          </span>
        </>
      )}
      {model && (
        <span
          className={cn(
            'min-w-0 max-w-24 truncate font-mono text-[10px]',
            highlighted ? 'text-foreground/70' : 'text-muted-foreground/70'
          )}
          title={model}
        >
          {model}
        </span>
      )}
      {hasChildDisclosure && !childAgentsExpanded && (
        <span
          className={cn(
            'shrink-0 text-[10px] tabular-nums',
            highlighted ? 'text-foreground/70' : 'text-muted-foreground/70'
          )}
        >
          +{childAgentCount}
        </span>
      )}
      {cacheTimer && <CacheTimer startedAt={cacheTimer.startedAt} ttlMs={cacheTimer.ttlMs} />}
      {hasChildDisclosure ? (
        <DashboardAgentChildDisclosure
          childAgentCount={childAgentCount}
          childAgentsExpanded={childAgentsExpanded}
          onToggleChildAgents={onToggleChildAgents}
          timestamp={timestamp}
        />
      ) : (
        timestamp
      )}
    </>
  )

  return (
    <div
      draggable={false}
      className={cn(
        'compact-agent-row agent-disclosure-row group/compact-agent-row min-w-0 cursor-pointer rounded-sm px-1 text-[11px] leading-none',
        'text-muted-foreground worktree-agent-row-hover',
        hasChildDisclosure && 'worktree-agent-lineage-parent-row',
        isLineageChild && 'worktree-agent-lineage-child-row',
        'flex h-6 items-center gap-1',
        highlighted && 'bg-worktree-sidebar-accent',
        sendTargetStatus === 'sending' && 'cursor-progress opacity-75',
        sendTargetStatus === 'disabled' && 'cursor-default opacity-60'
      )}
      onClickCapture={handleSendTargetClickCapture}
      onClick={handleActivate}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
      data-focused-agent-pane={highlighted ? 'true' : undefined}
      data-current={view?.current ? 'true' : undefined}
      aria-current={view?.current ? 'true' : undefined}
      data-agent-send-target={sendTargetStatus}
      role={agent.lineage ? 'treeitem' : undefined}
      aria-level={agent.lineage ? agent.lineage.depth + 1 : undefined}
      aria-expanded={hasChildDisclosure ? childAgentsExpanded : undefined}
      title={sendTargetDisabledReason}
    >
      {rowBody}
    </div>
  )
})
