import React, { useCallback, useRef } from 'react'
import { ChevronRight } from 'lucide-react'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import CommentMarkdown from './CommentMarkdown'
import {
  buildSummaryAgentGroups,
  getAgentDotState,
  selectSummaryGroupIconAgents,
  summarizeAgentIdentities,
  summarizeAgents
} from './worktree-card-agent-summary'

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]\n]*\]\([^)]+\)/

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

function lastEnteredDoneAt(agent: DashboardAgentRowData): number | null {
  const entry = agent.entry
  if (entry.state === 'done') {
    return entry.stateStartedAt
  }
  for (let i = (entry.stateHistory?.length ?? 0) - 1; i >= 0; i--) {
    if (entry.stateHistory[i].state === 'done') {
      return entry.stateHistory[i].startedAt
    }
  }
  return null
}

function getCompactAgentPrimary(agent: DashboardAgentRowData): string {
  const prompt = agent.entry.prompt?.trim() ?? ''
  return prompt || agentStateLabel(getAgentDotState(agent))
}

function getCompactAgentSecondary(agent: DashboardAgentRowData): string {
  if (agent.entry.interrupted === true) {
    return 'Interrupted by user'
  }
  if (agent.state === 'working') {
    const toolName = agent.entry.toolName?.trim() ?? ''
    const toolInput = agent.entry.toolInput?.trim() ?? ''
    if (toolName && toolInput) {
      return `${toolName}: ${toolInput}`
    }
    if (toolName) {
      return toolName
    }
  }
  return agent.entry.lastAssistantMessage?.trim() || formatAgentTypeLabel(agent.agentType)
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

type CompactAgentSummaryButtonProps = {
  agents: DashboardAgentRowData[]
  subjectLabel: string
  expanded: boolean
  onToggle: () => void
}

type CompactAgentExpansionProps = {
  expanded: boolean
  contentClassName?: string
  children: React.ReactNode
}

export function CompactAgentExpansion({
  expanded,
  contentClassName,
  children
}: CompactAgentExpansionProps): React.JSX.Element {
  const hasRenderedChildrenRef = useRef(expanded)
  if (expanded) {
    // Why: keep already-opened content mounted for the collapse transition
    // without paying an extra Effect-driven render on first expansion.
    hasRenderedChildrenRef.current = true
  }
  const shouldRenderChildren = expanded || hasRenderedChildrenRef.current

  return (
    <div
      className={cn(
        'compact-agent-expansion-grid',
        expanded && 'compact-agent-expansion-grid-expanded'
      )}
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <div className="min-h-0 overflow-hidden">
        {shouldRenderChildren && (
          <div
            className={cn(
              'compact-agent-expansion-content flex flex-col gap-0.5 pt-0.5',
              contentClassName
            )}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  )
}

export function CompactAgentSummaryButton({
  agents,
  subjectLabel,
  expanded,
  onToggle
}: CompactAgentSummaryButtonProps): React.JSX.Element {
  const summary = summarizeAgents(agents, subjectLabel)
  const groups = buildSummaryAgentGroups(agents)
  const visibleGroups = groups.slice(0, 3)
  const hiddenGroupAgentCount = groups
    .slice(visibleGroups.length)
    .reduce((count, group) => count + group.agents.length, 0)
  const agentIdentitySummary = summarizeAgentIdentities(agents)
  const stopPointerPropagation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
  }, [])
  const handleToggle = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.stopPropagation()
      onToggle()
    },
    [onToggle]
  )
  return (
    <button
      type="button"
      draggable={false}
      className={cn(
        'group/agent-summary flex h-6 w-full min-w-0 items-center gap-1 rounded-sm',
        'px-1 text-left text-[11px] leading-none text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring',
        // Why: collapsed it's a standalone pill; expanded it's the header of the
        // enclosing panel, so it drops its own border/fill to avoid double chrome.
        expanded
          ? 'hover:bg-sidebar-accent/60'
          : 'border border-sidebar-border/70 bg-sidebar-accent/35 hover:bg-sidebar-accent'
      )}
      aria-label={
        expanded ? `Collapse ${subjectLabel}` : `Expand ${summary}. ${agentIdentitySummary}`
      }
      aria-expanded={expanded}
      onClick={handleToggle}
      onKeyDown={stopActivationKeyPropagation}
      onMouseDown={stopPointerPropagation}
      onPointerDown={stopPointerPropagation}
      onDragStart={stopPointerPropagation}
    >
      {expanded ? (
        <span className="min-w-0 flex-1 truncate px-1 font-medium text-muted-foreground">
          {subjectLabel}
        </span>
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" aria-hidden>
            {visibleGroups.map((group) => {
              const iconAgents = selectSummaryGroupIconAgents(group.agents, 3)
              const hiddenIconCount = Math.max(0, group.agents.length - iconAgents.length)
              return (
                <span
                  key={group.state}
                  className="inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-sm bg-sidebar/70 px-1 py-0.5"
                >
                  <AgentStateDot state={group.state} size="sm" />
                  {/* Why: same-state agent identities read as one status cluster;
                      overlapping them saves width without merging different states. */}
                  <span className="inline-flex shrink-0 items-center -space-x-0.5 pl-0.5">
                    {iconAgents.map((agent) => (
                      <span
                        key={agent.paneKey}
                        className="inline-flex size-3.5 items-center justify-center rounded-full border border-sidebar-border/70 bg-sidebar"
                      >
                        <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={10} />
                      </span>
                    ))}
                  </span>
                  {hiddenIconCount > 0 && (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                      +{hiddenIconCount}
                    </span>
                  )}
                </span>
              )
            })}
          </span>
          {hiddenGroupAgentCount > 0 && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
              +{hiddenGroupAgentCount}
            </span>
          )}
        </>
      )}
      <ChevronRight
        className={cn('size-3 shrink-0 transition-transform duration-150', expanded && 'rotate-90')}
        aria-hidden
      />
    </button>
  )
}

type CompactAgentRowProps = {
  agent: DashboardAgentRowData
  now: number
  onActivate: (tabId: string, paneKey: string) => void
  childAgentCount?: number
  childAgentsExpanded?: boolean
  onToggleChildAgents?: () => void
  reserveDisclosureGutter?: boolean
  isFocusedPane?: boolean
  hideIdentityIcon?: boolean
}

export const CompactAgentRow = React.memo(function CompactAgentRow({
  agent,
  now,
  onActivate,
  childAgentCount,
  childAgentsExpanded = false,
  onToggleChildAgents,
  reserveDisclosureGutter = false,
  isFocusedPane = false,
  hideIdentityIcon = false
}: CompactAgentRowProps) {
  const hasChildDisclosure =
    typeof childAgentCount === 'number' &&
    childAgentCount > 0 &&
    typeof onToggleChildAgents === 'function'
  const dotState = getAgentDotState(agent)
  const primary = getCompactAgentPrimary(agent)
  const assistantMessage = agent.entry.lastAssistantMessage?.trim() ?? ''
  const hasAssistantImage = MARKDOWN_IMAGE_PATTERN.test(assistantMessage)
  const isLineageChild = agent.lineage?.depth === 1
  const secondary = hasAssistantImage
    ? formatAgentTypeLabel(agent.agentType)
    : getCompactAgentSecondary(agent)
  const shortTime = getCompactAgentTime(agent, now)

  const handleActivate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onActivate(agent.tab.id, agent.paneKey)
    },
    [agent.paneKey, agent.tab.id, onActivate]
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
          className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-sidebar-border/80 bg-sidebar text-foreground/80 shadow-xs hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
          aria-label={`${childAgentsExpanded ? 'Hide' : 'Show'} ${childAgentCount} child ${
            childAgentCount === 1 ? 'agent' : 'agents'
          }`}
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
      {!hideIdentityIcon && (
        <span className="inline-flex shrink-0" title={formatAgentTypeLabel(agent.agentType)}>
          <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={13} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">
        {/* Why: the selected-row fill is strong enough to wash out the dimmed
            prompt/secondary text, so lift both toward full foreground when focused. */}
        <span className={isFocusedPane ? 'text-foreground' : 'text-foreground/85'}>{primary}</span>
        {secondary && (
          <span className={isFocusedPane ? 'text-foreground/70' : 'text-muted-foreground/75'}>
            {' '}
            - {secondary}
          </span>
        )}
      </span>
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

  return (
    <div
      draggable={false}
      className={cn(
        'group/compact-agent-row min-w-0 cursor-pointer rounded-sm px-1 text-[11px] leading-none',
        'text-muted-foreground worktree-agent-row-hover',
        hasChildDisclosure && 'worktree-agent-lineage-parent-row',
        isLineageChild && 'worktree-agent-lineage-child-row',
        hasAssistantImage ? 'flex flex-col py-0.5' : 'flex h-6 items-center gap-1',
        isFocusedPane && 'bg-sidebar-accent'
      )}
      onClick={handleActivate}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
      data-focused-agent-pane={isFocusedPane ? 'true' : undefined}
      role={agent.lineage ? 'treeitem' : undefined}
      aria-level={agent.lineage ? agent.lineage.depth + 1 : undefined}
      aria-expanded={hasChildDisclosure ? childAgentsExpanded : undefined}
      title={`${primary}${secondary ? ` - ${secondary}` : ''}`}
    >
      {hasAssistantImage ? (
        <>
          <div className="flex h-6 min-w-0 items-center gap-1">{rowBody}</div>
          <CommentMarkdown
            content={assistantMessage}
            className="ml-5 max-h-36 max-w-full overflow-hidden text-[10px] leading-snug text-muted-foreground/80 [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1"
          />
        </>
      ) : (
        rowBody
      )}
    </div>
  )
})
