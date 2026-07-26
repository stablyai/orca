import React, { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DashboardAgentChildDisclosure } from './DashboardAgentChildDisclosure'
import { DashboardAgentRowMessage } from './DashboardAgentRowMessage'
import { DashboardAgentRowTrailingControls } from './DashboardAgentRowTrailingControls'
import { DashboardAgentRowToolStep } from './DashboardAgentRowToolStep'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { useAgentRowConversationName } from './use-agent-row-conversation-name'

// Why: narrow the dashboard's rollup states to shared dot states, defaulting unknowns to 'idle' so a row never crashes.
function asDotState(state: AgentStatusState | 'idle'): AgentDotState {
  switch (state) {
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return state
  }
  return 'idle'
}

function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Why: use stateStartedAt (not updatedAt, which drifts on within-state pings) for the true done-transition time.
function lastEnteredDoneAt(agent: DashboardAgentRowData): number | null {
  // Why: idle subagents are alive-but-idle (persist between turns); don't label them as done.
  if (agent.rowSource === 'subagent' && agent.state === 'idle') {
    return null
  }
  const entry = agent.entry
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  for (let i = entry.stateHistory.length - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}

function stateDotTooltipLabel(agent: DashboardAgentRowData, dotState: AgentDotState): string {
  if (agent.entry.interrupted === true) {
    return 'Interrupted by user'
  }
  return agentStateLabel(dotState)
}

type Props = {
  agent: DashboardAgentRowData
  onDismiss: (paneKey: string) => void
  /** Navigate to this agent's tab; paneKey lets the caller mark-visit the exact clicked row. */
  onActivate: (tabId: string, paneKey: string) => void
  /** Why: injected from a parent so one shared tick re-renders every row's "Xm ago" (see useNow.ts), not a per-row interval. */
  now: number
  /** Why: bold prompt rides on the card's unvisited signal (shared with the workspace name), not per-agent state. */
  isUnvisited?: boolean
  /** Why: inline variant passes 'sm' so the dot isn't mistaken for the adjacent ~12px agent icon. */
  stateDotSize?: 'sm' | 'md'
  /** Why: inline-in-card variant drops the redundant chevron and identity glyph in its tighter layout. */
  hideIdentityIcon?: boolean
  hideExpand?: boolean
  /** Reuse the row's hover tint to show the focused terminal pane's agent. */
  isFocusedPane?: boolean
  // Why: inline-card orchestration rows fold children under a leading chevron.
  childAgentCount?: number
  childAgentsExpanded?: boolean
  onToggleChildAgents?: () => void
  // Why: leaf siblings reserve the chevron gutter so state dots align.
  reserveDisclosureGutter?: boolean
  // Why: chevron indentation replaces fixed-offset lineage connector art.
  hideLineageConnectors?: boolean
  // Why: send-popover target mode makes row clicks send/no-op instead of navigating.
  sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
  sendTargetDisabledReason?: string
  onSendTargetClick?: (paneKey: string) => void
}

const DashboardAgentRow = React.memo(function DashboardAgentRow({
  agent,
  onDismiss,
  onActivate,
  now,
  isUnvisited = false,
  stateDotSize = 'md',
  hideIdentityIcon = false,
  hideExpand = false,
  isFocusedPane = false,
  childAgentCount,
  childAgentsExpanded = false,
  onToggleChildAgents,
  reserveDisclosureGutter = false,
  hideLineageConnectors = false,
  sendTargetStatus,
  sendTargetDisabledReason,
  onSendTargetClick
}: Props) {
  const hasChildDisclosure =
    typeof childAgentCount === 'number' &&
    childAgentCount > 0 &&
    typeof onToggleChildAgents === 'function'
  const [expanded, setExpanded] = useState(false)
  const handleToggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev)
  }, [])
  // Why: stop propagation so the surrounding card's click handler can't override our tab activation.
  const handleActivate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // Why: subagent rows have no pane of their own, so focus the spawning parent's pane.
      onActivate(agent.tab.id, agent.activationPaneKey ?? agent.paneKey)
    },
    [onActivate, agent.tab.id, agent.activationPaneKey, agent.paneKey]
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
  const startedAt = agent.startedAt > 0 ? agent.startedAt : null
  const doneAt = lastEnteredDoneAt(agent)
  const conversationName = useAgentRowConversationName(agent)
  const prompt = conversationName ?? getAgentRowPrimaryText(agent.entry)
  // Why: prompt is '' when unknown, so fall back to the state label to keep the row labeled.
  const displayLabel = prompt || agentStateLabel(asDotState(agent.state))
  const model = agent.entry.model?.trim() ?? ''
  // Why: gate tool fields on 'working' — a stale tool line on a done row reads as still-running.
  const isWorking = agent.state === 'working'
  const toolName = isWorking ? (agent.entry.toolName?.trim() ?? '') : ''
  const toolInput = isWorking ? (agent.entry.toolInput?.trim() ?? '') : ''
  const lastAssistantMessage = agent.entry.lastAssistantMessage?.trim() ?? ''
  const isInterrupted = agent.entry.interrupted === true
  const lineage = agent.lineage
  const isLineageChild = lineage?.depth === 1
  const lineageChildCount = lineage?.childCount ?? 0
  const participatesInLineage = isLineageChild || lineageChildCount > 0
  const identityTitle =
    lineageChildCount > 0
      ? `${formatAgentTypeLabel(agent.agentType)} - dispatched ${lineageChildCount} ${
          lineageChildCount === 1 ? 'agent' : 'agents'
        }`
      : [formatAgentTypeLabel(agent.agentType), model].filter(Boolean).join(' · ')
  // Why: interrupted is a terminal outcome, so surface it in the leading state dot.
  const dotState: AgentDotState = isInterrupted ? 'interrupted' : asDotState(agent.state)
  const dotTooltipLabel = stateDotTooltipLabel(agent, dotState)

  // Why: always show the chevron so the row's right edge doesn't flicker as content grows/shrinks.

  const startedTimeAgo = startedAt !== null ? formatTimeAgo(startedAt, now) : null
  const doneTimeAgo = doneAt !== null ? formatTimeAgo(doneAt, now) : null
  const relativeTimestamp = doneTimeAgo ?? startedTimeAgo
  const tsParts: string[] = []
  if (startedTimeAgo !== null) {
    tsParts.push(`started ${startedTimeAgo}`)
  }
  if (doneTimeAgo !== null) {
    tsParts.push(`done ${doneTimeAgo}`)
  }

  const titleParts = sendTargetDisabledReason ? [sendTargetDisabledReason, ...tsParts] : tsParts

  return (
    // Why: no role="button" — nested interactive children (buttons, tooltip triggers) would violate ARIA nesting rules.
    <div
      onClickCapture={handleSendTargetClickCapture}
      onClick={handleActivate}
      className={cn(
        // Why: named group scopes the X-reveal to this row, not every row in the card.
        'group/agent-row relative flex flex-col -ml-2 py-1',
        isLineageChild ? 'pl-5 pr-2' : 'px-2',
        // Why: hover wash stays softer than the enclosing card's highlight.
        'cursor-pointer rounded-sm worktree-agent-row-hover',
        hasChildDisclosure && 'worktree-agent-lineage-parent-row',
        isLineageChild && 'worktree-agent-lineage-child-row',
        sendTargetStatus === 'sending' && 'cursor-progress opacity-75',
        sendTargetStatus === 'disabled' && 'cursor-default opacity-60'
      )}
      data-focused-agent-pane={isFocusedPane ? 'true' : undefined}
      data-agent-send-target={sendTargetStatus}
      title={titleParts.length > 0 ? titleParts.join(' • ') : undefined}
      role={participatesInLineage ? 'treeitem' : undefined}
      aria-level={participatesInLineage ? (lineage?.depth ?? 0) + 1 : undefined}
    >
      {lineageChildCount > 0 && !hideLineageConnectors ? (
        <span
          aria-hidden
          data-agent-lineage-parent-connector
          className="pointer-events-none absolute bottom-[-0.75rem] left-[13px] top-[1.05rem] border-l-[1.5px] border-muted-foreground/45 dark:border-muted-foreground/35"
        />
      ) : null}
      {isLineageChild && !hideLineageConnectors ? (
        <span
          aria-hidden
          data-agent-lineage-connector={lineage?.isLastSibling === false ? 'branch' : 'last'}
          className="pointer-events-none absolute bottom-[-1px] left-[13px] top-[-1px] w-3"
        >
          <span
            className={cn(
              'absolute left-0 border-l-[1.5px] border-muted-foreground/45 dark:border-muted-foreground/35',
              lineage?.isFirstSibling ? 'top-[-0.9rem]' : 'top-[-1px]',
              lineage?.isLastSibling
                ? lineage?.isFirstSibling
                  ? 'h-[1.6rem]'
                  : 'h-[calc(0.7rem+1px)]'
                : 'bottom-[-1px]'
            )}
          />
          <span className="absolute left-0 top-[0.7rem] w-1.5 border-t-[1.5px] border-muted-foreground/45 dark:border-muted-foreground/35" />
        </span>
      ) : null}
      <div className="flex items-center gap-1.5">
        <DashboardAgentChildDisclosure
          childAgentCount={childAgentCount}
          childAgentsExpanded={childAgentsExpanded}
          onToggleChildAgents={onToggleChildAgents}
          reserveDisclosureGutter={reserveDisclosureGutter}
        />
        {/* Why: state dot sits in the leading gutter so the eye can scan one column for row state. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex shrink-0 items-center justify-center"
              aria-label={dotTooltipLabel}
            >
              <AgentStateDot state={dotState} size={stateDotSize} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {dotTooltipLabel}
          </TooltipContent>
        </Tooltip>
        {/* Why: subagent rows skip the icon — agentType holds a child name, not an iconable agent, so it would render the unknown "?" glyph. */}
        {!hideIdentityIcon && agent.rowSource !== 'subagent' && (
          <span className="inline-flex shrink-0" title={identityTitle}>
            <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={14} />
          </span>
        )}
        {/* Why: interpolate-size:allow-keywords is the only way to animate height to/from auto without measuring in JS; falls back to an instant swap where unsupported. */}
        <span
          className={cn(
            'block min-w-0 flex-1 overflow-hidden text-[11px] leading-snug',
            'transition-[height] duration-200 ease-out [interpolate-size:allow-keywords]',
            expanded ? 'h-auto whitespace-pre-wrap break-words' : 'h-[1lh] truncate',
            isUnvisited ? 'font-semibold text-foreground' : 'font-normal text-muted-foreground',
            // Why: the selected-row fill washes out muted text — keep it readable.
            isFocusedPane && !isUnvisited && 'text-foreground/90'
          )}
          title={displayLabel}
        >
          {displayLabel}
        </span>
        {model && (
          <span
            className="max-w-24 shrink-0 truncate font-mono text-[10px] text-muted-foreground/70"
            title={model}
          >
            {model}
          </span>
        )}
        {/* Why: "+N" badge shows the hidden child count when collapsed; redundant once children are expanded below. */}
        {hasChildDisclosure && !childAgentsExpanded && (
          <span
            className="shrink-0 text-[10px] font-normal leading-none text-muted-foreground/70 tabular-nums"
            aria-hidden
          >
            +{childAgentCount}
          </span>
        )}
        <DashboardAgentRowTrailingControls
          paneKey={agent.paneKey}
          relativeTimestamp={relativeTimestamp}
          expanded={expanded}
          hideExpand={hideExpand}
          hideDismiss={agent.rowSource === 'subagent'}
          sendTargetStatus={sendTargetStatus}
          onDismiss={onDismiss}
          onToggleExpanded={handleToggleExpanded}
          onSendTargetClick={onSendTargetClick}
        />
      </div>
      <DashboardAgentRowToolStep
        expanded={expanded}
        isWorking={isWorking}
        toolName={toolName}
        toolInput={toolInput}
      />
      <DashboardAgentRowMessage
        expanded={expanded}
        isInterrupted={isInterrupted}
        lastAssistantMessage={lastAssistantMessage}
      />
    </div>
  )
})

export default DashboardAgentRow
