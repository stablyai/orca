import React, { useCallback, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { cn } from '@/lib/utils'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

function asDotState(state: AgentStatusState | 'idle'): AgentDotState {
  switch (state) {
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return state
    default:
      return 'idle'
  }
}

function getAgentDotState(agent: DashboardAgentRowData): AgentDotState {
  return agent.entry.interrupted === true ? 'interrupted' : asDotState(agent.state)
}

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

const SUMMARY_STATE_ORDER: AgentDotState[] = [
  'waiting',
  'blocked',
  'interrupted',
  'working',
  'done',
  'idle'
]

function stopActivationKeyPropagation(e: React.KeyboardEvent): void {
  // Why: the surrounding worktree list handles Enter/Space as row activation.
  // Focused nested buttons need those keys to stay local.
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation()
  }
}

function summarizeAgents(agents: DashboardAgentRowData[], subjectLabel: string): string {
  const counts = new Map<AgentDotState, number>()
  for (const agent of agents) {
    const dotState = getAgentDotState(agent)
    counts.set(dotState, (counts.get(dotState) ?? 0) + 1)
  }
  const parts = SUMMARY_STATE_ORDER.flatMap((state) => {
    const count = counts.get(state) ?? 0
    if (count === 0) {
      return []
    }
    const label =
      state === 'waiting'
        ? 'waiting'
        : state === 'blocked'
          ? 'blocked'
          : state === 'interrupted'
            ? 'interrupted'
            : state === 'working'
              ? 'working'
              : state === 'done'
                ? 'done'
                : 'idle'
    return `${count} ${label}`
  })
  return `${subjectLabel}: ${parts.join(', ')}`
}

function selectSummaryIconAgents(
  agents: DashboardAgentRowData[],
  maxCount: number
): DashboardAgentRowData[] {
  const groups = new Map<string, { agents: DashboardAgentRowData[]; firstIndex: number }>()
  agents.forEach((agent, index) => {
    const key = agent.agentType ?? 'unknown'
    const group = groups.get(key)
    if (group) {
      group.agents.push(agent)
    } else {
      groups.set(key, { agents: [agent], firstIndex: index })
    }
  })
  const sortedGroups = [...groups.values()].sort(
    (a, b) => b.agents.length - a.agents.length || a.firstIndex - b.firstIndex
  )
  const selected: DashboardAgentRowData[] = []
  for (const group of sortedGroups) {
    if (selected.length >= maxCount) {
      break
    }
    selected.push(group.agents[0])
  }
  // Why: once every visible agent kind is represented, duplicate slots should
  // reflect the largest groups instead of arbitrary list order.
  for (const group of sortedGroups) {
    for (const agent of group.agents.slice(1)) {
      if (selected.length >= maxCount) {
        return selected
      }
      selected.push(agent)
    }
  }
  return selected
}

type CompactAgentSummaryButtonProps = {
  agents: DashboardAgentRowData[]
  subjectLabel: string
  expanded: boolean
  onToggle: () => void
}

type CompactAgentExpansionProps = {
  expanded: boolean
  children: React.ReactNode
}

export function CompactAgentExpansion({
  expanded,
  children
}: CompactAgentExpansionProps): React.JSX.Element {
  const [hasRenderedChildren, setHasRenderedChildren] = useState(expanded)
  useEffect(() => {
    if (expanded) {
      setHasRenderedChildren(true)
    }
  }, [expanded])
  const shouldRenderChildren = expanded || hasRenderedChildren

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
          <div className="compact-agent-expansion-content flex flex-col gap-0.5 pt-0.5">
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
  const iconAgents = selectSummaryIconAgents(agents, 3)
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
        'group/agent-summary flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm border border-sidebar-border/70',
        'bg-sidebar-accent/35 px-1.5 text-left text-[11px] leading-none text-muted-foreground',
        'hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring'
      )}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${summary}`}
      aria-expanded={expanded}
      onClick={handleToggle}
      onKeyDown={stopActivationKeyPropagation}
      onMouseDown={stopPointerPropagation}
      onPointerDown={stopPointerPropagation}
      onDragStart={stopPointerPropagation}
    >
      <span className="flex shrink-0 items-center -space-x-1" aria-hidden>
        {iconAgents.map((agent) => (
          <span
            key={agent.paneKey}
            className="inline-flex size-4 items-center justify-center rounded-full border border-sidebar bg-sidebar"
            title={formatAgentTypeLabel(agent.agentType)}
          >
            <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={12} />
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
        +{agents.length}
      </span>
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
  const secondary = getCompactAgentSecondary(agent)
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

  return (
    <div
      draggable={false}
      className={cn(
        'group/compact-agent-row flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 text-[11px] leading-none',
        'text-muted-foreground worktree-agent-row-hover',
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
      {hasChildDisclosure ? (
        <button
          type="button"
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
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
        <span className="text-foreground/85">{primary}</span>
        {secondary && <span className="text-muted-foreground/75"> - {secondary}</span>}
      </span>
      {hasChildDisclosure && !childAgentsExpanded && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          +{childAgentCount}
        </span>
      )}
      {shortTime && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
          {shortTime}
        </span>
      )}
    </div>
  )
})
