import React, { useCallback, useEffect, useRef } from 'react'
import { ChevronRight, PencilLine } from 'lucide-react'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { getAgentDotState } from './worktree-card-agent-summary'
import { translate } from '@/i18n/i18n'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { formatAgentToolPreview } from '@/lib/agent-row-tool-preview'
import { agentNoUpdateLabel } from '@/lib/agent-row-decay-state'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import CacheTimer, { usePromptCacheCountdownForPane } from './CacheTimer'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { useAgentUnsentDraft } from '@/lib/agent-unsent-draft'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CompactAgentRowHover } from './worktree-card-compact-agent-hover'

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
  if (agent.entry.interrupted === true) {
    return 'Interrupted by user'
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

function stopActivationKeyPropagation(e: React.KeyboardEvent): void {
  // Why: the surrounding worktree list handles Enter/Space as row activation.
  // Focused nested buttons need those keys to stay local.
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation()
  }
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
  disclosureInGutter?: boolean
  isFocusedPane?: boolean
  hideIdentityIcon?: boolean
  cacheTimerActive?: boolean
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
  disclosureInGutter = false,
  isFocusedPane = false,
  hideIdentityIcon = false,
  cacheTimerActive = true
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
  const assistantMessage = stableMessage ?? currentMessage
  const secondary = getCompactAgentSecondary(agent, now, stableMessage)
  // Why: sidebar truncation must preserve the passive-vs-active distinction.
  const leadingText = dotState === 'monitoring' ? secondary : primary
  const trailingText =
    dotState === 'monitoring' ? (primary === secondary ? '' : primary) : secondary
  // Why: the card lists the children a session spawned; the row only had room for a count.
  const hoverSubagents = (agent.entry.subagents ?? []).map((subagent) => ({
    id: subagent.id,
    name: subagent.description?.trim() || subagent.agentType?.trim() || subagent.id,
    dotState: subagent.state
  }))
  const model = agent.entry.model?.trim() ?? ''
  const shortTime = getCompactAgentTime(agent, now)
  const cacheTimer = usePromptCacheCountdownForPane(agent.paneKey, cacheTimerActive)
  const hasUnsentDraft = useAgentUnsentDraft(agent.paneKey)

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
  const handleToggleChildren = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.stopPropagation()
      onToggleChildAgents?.()
    },
    [onToggleChildAgents]
  )

  const rowBody = (
    <>
      {hasChildDisclosure ? (
        <button
          type="button"
          className="compact-agent-child-disclosure-button flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
          aria-label={translate(
            'auto.components.sidebar.worktree.card.compact.agents.a128d7006b',
            '{{value0}} {{value1}} child {{value2}}',
            {
              value0: childAgentsExpanded ? 'Hide' : 'Show',
              value1: childAgentCount,
              value2: childAgentCount === 1 ? 'agent' : 'agents'
            }
          )}
          aria-expanded={childAgentsExpanded}
          onClick={handleToggleChildren}
          onKeyDown={stopActivationKeyPropagation}
        >
          <ChevronRight
            className={cn(
              'size-3 transition-transform duration-150',
              childAgentsExpanded && 'rotate-90'
            )}
            aria-hidden
          />
        </button>
      ) : null}
      {/* Why: the row's actionable disabled reason must win on every hit area, and the
          hover card already names the state for every row that has one. */}
      <AgentStateDot
        state={dotState}
        size="sm"
        title={sendTargetStatus && !sendTargetDisabledReason ? undefined : null}
        tooltipSide="right"
      />
      {!hideIcon && (
        <span className="inline-flex shrink-0">
          <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={13} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">
        {/* Why: the selected-row fill is strong enough to wash out the dimmed
            prompt/secondary text, so lift both toward full foreground when focused. */}
        <span className={isFocusedPane ? 'text-foreground' : 'text-muted-foreground/90'}>
          {leadingText}
        </span>
        {trailingText && (
          <span className={isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/65'}>
            {' '}
            - {trailingText}
          </span>
        )}
      </span>
      {model && (
        <span
          className={cn(
            'min-w-0 max-w-24 truncate font-mono text-[10px]',
            isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/70'
          )}
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
      {/* Why: a written-but-unsent message is easy to forget once the row scrolls
          away; it is a reminder, not an alert, so it stays muted. */}
      {hasUnsentDraft && !sendTargetStatus && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              className={cn(
                'inline-flex shrink-0 items-center',
                isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/70'
              )}
              aria-label={translate(
                'auto.components.sidebar.worktree.card.compact.agents.unsentDraft',
                'Message typed but not sent'
              )}
              data-agent-unsent-draft="true"
            >
              <PencilLine className="size-2.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.sidebar.worktree.card.compact.agents.unsentDraft',
              'Message typed but not sent'
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {cacheTimer && <CacheTimer startedAt={cacheTimer.startedAt} ttlMs={cacheTimer.ttlMs} />}
      {shortTime && (
        <span
          className={cn(
            'shrink-0 text-[10px] tabular-nums',
            // Why: the muted timestamp drops out against the selected-row fill.
            isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/60'
          )}
        >
          {shortTime}
        </span>
      )}
    </>
  )

  const row = (
    <div
      draggable={false}
      className={cn(
        'compact-agent-row group/compact-agent-row min-w-0 overflow-hidden cursor-pointer rounded-sm px-1 text-[11px] leading-none',
        'text-muted-foreground worktree-agent-row-hover',
        hasChildDisclosure && 'worktree-agent-lineage-parent-row',
        // Why: hang the chevron in the card gutter so the state dot keeps the column of chevron-less rows.
        hasChildDisclosure && disclosureInGutter && '-ml-5',
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

  // Why: send-target mode turns the row into a picker whose disabled reason is the
  // only thing worth surfacing, so the preview card stays out of that flow.
  if (sendTargetStatus) {
    return row
  }

  return (
    <CompactAgentRowHover
      agentType={agent.agentType}
      dotState={dotState}
      primary={primary}
      secondary={secondary}
      secondaryIsAssistantMessage={assistantMessage.length > 0 && secondary === assistantMessage}
      model={model}
      shortTime={shortTime}
      hideIdentityIcon={agent.rowSource === 'subagent'}
      subagents={hoverSubagents}
    >
      {row}
    </CompactAgentRowHover>
  )
})
