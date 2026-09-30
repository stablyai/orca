import React, { useCallback, useEffect, useRef } from 'react'
import { DashboardAgentChildDisclosure } from '@/components/dashboard/DashboardAgentChildDisclosure'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentChildRowContent } from '@/components/AgentChildRowContent'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { getAgentDotState } from './worktree-card-agent-summary'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { formatAgentToolPreview } from '@/lib/agent-row-tool-preview'
import { agentNoUpdateLabel } from '@/lib/agent-row-decay-state'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import CacheTimer, { usePromptCacheCountdownForPane } from './CacheTimer'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { agentVerdictDisplayMark } from '../../../../shared/agent-main-agent-verdict'

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
  lastAssistantMessageOverride?: string
): string {
  const verdictMark = agentVerdictDisplayMark(agent.entry)
  if (verdictMark === 'interrupted') {
    return 'Interrupted by user'
  }
  if (verdictMark === 'failed') {
    return 'Failed'
  }
  // Why: the only honest thing to say about a pane Orca still holds but no longer hears
  // from is how long the silence has run; the user supplies the meaning.
  if (agent.state === 'unverifiable') {
    return agentNoUpdateLabel(agent.entry, now)
  }
  // Why: the lead turn is over in monitoring, so its last tool line is stale; name the state instead.
  if (agent.state === 'working' && agent.entry.workingMode === 'monitoring') {
    return agentStateLabel('monitoring')
  }
  const toolPreview = formatAgentToolPreview(agent.entry, agent.state)
  if (toolPreview) {
    return toolPreview
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
  // Why: send-popover target mode temporarily turns compact sidebar rows into
  // the picker surface, matching the full DashboardAgentRow behavior.
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
  const hasChildDisclosure =
    typeof childAgentCount === 'number' &&
    childAgentCount > 0 &&
    typeof onToggleChildAgents === 'function'
  // Why: subagent child rows carry the child's NAME (e.g. "pr-reviewer") in
  // agentType, which is not an iconable agent and would render the unknown
  // "?" glyph. Nesting under the parent already conveys identity.
  const hideIcon = hideIdentityIcon || agent.rowSource === 'subagent'
  const dotState = getAgentDotState(agent)
  const conversationName = useAgentRowConversationName(agent)
  const primary = getCompactAgentPrimary(agent, conversationName)
  const isLineageChild = agent.lineage?.depth === 1
  // Keep a live row's last assistant line stable while status/tool payloads
  // briefly omit the hook-only field between updates. Committed in an effect so a
  // discarded concurrent render can't pin an uncommitted message and no extra render
  // pass runs per streaming ping; a zero stateStartedAt has no per-turn identity, so
  // those rows never cache.
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
  const secondary = getCompactAgentSecondary(agent, now, stableMessage)
  // Why: sidebar truncation must preserve the passive-vs-active distinction.
  const leadingText = dotState === 'monitoring' ? secondary : primary
  const trailingText =
    dotState === 'monitoring' ? (primary === secondary ? '' : primary) : secondary
  const rowTitle = `${leadingText}${trailingText ? ` - ${trailingText}` : ''}`
  const model = agent.entry.model?.trim() ?? ''
  const shortTime = getCompactAgentTime(agent, now)
  const cacheTimer = usePromptCacheCountdownForPane(agent.paneKey, cacheTimerActive)

  const handleActivate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // Why: subagent child rows have no pane of their own; they focus the
      // parent pane whose session spawned them.
      onActivate(agent.tab.id, agent.activationPaneKey ?? agent.paneKey)
    },
    [agent.activationPaneKey, agent.paneKey, agent.tab.id, onActivate]
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
        isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/60'
      )}
    >
      {shortTime}
    </span>
  ) : null

  // Why: the selected-row fill is strong enough to wash out the dimmed prompt/secondary text, so
  // lift the lead toward full foreground when focused; an unvisited row stays bold either way.
  const leadClassName = cn(
    isUnvisited ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground/90',
    isFocusedPane && !isUnvisited && 'text-foreground'
  )

  const rowBody = (
    <>
      {agent.childRow ? (
        // Why: a child row reads through the piece the chat strip renders, so both say the same.
        <AgentChildRowContent
          row={agent.childRow}
          now={now}
          leadClassName={leadClassName}
          trailClassName={isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/65'}
          separator=" - "
          dotTitle={sendTargetDisabledReason ? null : undefined}
          tooltipSide="right"
          lineTitle={!sendTargetDisabledReason}
        />
      ) : (
        <>
          {/* Why: the row's actionable disabled reason must win on every hit area. */}
          <AgentStateDot
            state={dotState}
            size="sm"
            title={sendTargetDisabledReason ? null : undefined}
            tooltipSide="right"
          />
          {!hideIcon && (
            <span className="inline-flex shrink-0" title={formatAgentTypeLabel(agent.agentType)}>
              <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={13} />
            </span>
          )}
          <span
            className="min-w-0 flex-1 truncate"
            title={sendTargetDisabledReason ? undefined : rowTitle}
          >
            <span className={leadClassName}>{leadingText}</span>
            {trailingText && (
              <span className={isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/65'}>
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
            isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/70'
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
            isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/70'
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
        isFocusedPane && 'bg-worktree-sidebar-accent',
        sendTargetStatus === 'sending' && 'cursor-progress opacity-75',
        sendTargetStatus === 'disabled' && 'cursor-default opacity-60'
      )}
      onClickCapture={handleSendTargetClickCapture}
      onClick={handleActivate}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
      data-focused-agent-pane={isFocusedPane ? 'true' : undefined}
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
