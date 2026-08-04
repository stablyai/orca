import React, { useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import { getAgentDotState } from './worktree-card-agent-summary'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { formatAgentToolPreview } from '@/lib/agent-row-tool-preview'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { lastEnteredDoneAt } from '@/components/dashboard/agent-finished-timestamp'
import CacheTimer, { usePromptCacheCountdownForPane } from './CacheTimer'
import { agentChildDisclosureLabel } from '@/components/agent-child-disclosure-label'
import { formatCodexSubagentDisplayLabel } from '@/components/codex-subagent-display-label'

function formatShortTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

function getCompactAgentPrimary(agent: DashboardAgentRowData, primarySource: string): string {
  const label = primarySource || agentStateLabel(getAgentDotState(agent))
  return agent.subagentSession?.provider === 'codex'
    ? formatCodexSubagentDisplayLabel(label)
    : label
}

function getCompactAgentSecondary(agent: DashboardAgentRowData, hasChildAgents: boolean): string {
  if (agent.entry.interrupted === true) {
    return 'Interrupted by user'
  }
  if (hasChildAgents) {
    return ''
  }
  const toolPreview = formatAgentToolPreview(agent.entry, agent.state)
  if (toolPreview) {
    return toolPreview
  }
  const lastAssistantMessage = agent.entry.lastAssistantMessage?.trim()
  if (lastAssistantMessage) {
    return lastAssistantMessage
  }
  // Why: child rows without descriptions use their role as primary text; repeating its formatted label adds no information.
  if (agent.rowSource === 'subagent') {
    const agentType = agent.agentType.trim()
    if (agentType === 'default' || agent.entry.prompt?.trim() === agentType) {
      return ''
    }
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
  reserveDisclosureGutter?: boolean
  isFocusedPane?: boolean
  isCurrentAgent?: boolean
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
  reserveDisclosureGutter = false,
  isFocusedPane = false,
  isCurrentAgent = false,
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
  const primarySource = conversationName ?? getAgentRowPrimaryText(agent.entry)
  const primary = getCompactAgentPrimary(agent, primarySource)
  const isLineageChild = agent.lineage?.depth === 1
  const secondary = getCompactAgentSecondary(agent, hasChildDisclosure)
  const model = agent.entry.model?.trim() ?? ''
  const isHighlighted = isFocusedPane || isCurrentAgent
  const shortTime = getCompactAgentTime(agent, now)
  const cacheTimer = usePromptCacheCountdownForPane(agent.paneKey, cacheTimerActive)

  const handleActivate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // Why: subagents have no pane, so the caller receives their explicit parent fallback.
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
          aria-label={agentChildDisclosureLabel(childAgentsExpanded, childAgentCount)}
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
      ) : reserveDisclosureGutter ? (
        <span className="size-4 shrink-0" aria-hidden />
      ) : null}
      <AgentStateDot state={dotState} size="sm" />
      {!hideIcon && (
        <span className="inline-flex shrink-0" title={formatAgentTypeLabel(agent.agentType)}>
          <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={13} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">
        {/* Why: the selected-row fill washes out dimmed prompt and secondary text. */}
        <span className={isHighlighted ? 'text-foreground' : 'text-muted-foreground/90'}>
          {primary}
        </span>
        {secondary && (
          <span className={isHighlighted ? 'text-foreground/70' : 'text-muted-foreground/65'}>
            {' '}
            - {secondary}
          </span>
        )}
      </span>
      {model && (
        <span
          className={cn(
            'min-w-0 max-w-24 truncate font-mono text-[10px]',
            isHighlighted ? 'text-foreground/70' : 'text-muted-foreground/70'
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
            isHighlighted ? 'text-foreground/70' : 'text-muted-foreground/70'
          )}
        >
          +{childAgentCount}
        </span>
      )}
      {cacheTimer && <CacheTimer startedAt={cacheTimer.startedAt} ttlMs={cacheTimer.ttlMs} />}
      {shortTime && (
        <span
          className={cn(
            'shrink-0 text-[10px] tabular-nums',
            // Why: the muted timestamp drops out against the selected-row fill.
            isHighlighted ? 'text-foreground/70' : 'text-muted-foreground/60'
          )}
        >
          {shortTime}
        </span>
      )}
    </>
  )

  return (
    <div
      draggable={false}
      className={cn(
        'compact-agent-row group/compact-agent-row min-w-0 overflow-hidden cursor-pointer rounded-sm px-1 text-[11px] leading-none',
        'text-muted-foreground worktree-agent-row-hover',
        hasChildDisclosure && 'worktree-agent-lineage-parent-row',
        isLineageChild && 'worktree-agent-lineage-child-row',
        'flex h-6 items-center gap-1',
        isHighlighted && 'bg-worktree-sidebar-accent',
        sendTargetStatus === 'sending' && 'cursor-progress opacity-75',
        sendTargetStatus === 'disabled' && 'cursor-default opacity-60'
      )}
      onClickCapture={handleSendTargetClickCapture}
      onClick={handleActivate}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
      data-focused-agent-pane={isFocusedPane ? 'true' : undefined}
      data-current={isCurrentAgent ? 'true' : undefined}
      data-agent-send-target={sendTargetStatus}
      data-subagent-id={agent.subagentSession?.id}
      role={agent.lineage ? 'treeitem' : undefined}
      aria-level={agent.lineage ? agent.lineage.depth + 1 : undefined}
      aria-expanded={hasChildDisclosure ? childAgentsExpanded : undefined}
      aria-selected={agent.lineage ? isCurrentAgent : undefined}
      title={
        sendTargetDisabledReason ??
        `${primarySource || primary}${secondary ? ` - ${secondary}` : ''}`
      }
    >
      {rowBody}
    </div>
  )
})
