import React, { useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { CompactAgentExpansion } from './worktree-card-compact-agents'
import { SUMMARY_STATE_ORDER, getAgentDotState } from './worktree-card-agent-summary'
import type { AgentDotState } from '@/components/AgentStateDot'

// A lone idle child costs the same row as its group, so only fold two or more.
const MIN_IDLE_CHILDREN_TO_GROUP = 2

export function partitionIdleChildAgents(childAgents: DashboardAgentRowData[]): {
  activeChildren: DashboardAgentRowData[]
  idleChildren: DashboardAgentRowData[]
} {
  const idleChildren = childAgents.filter((agent) => getAgentDotState(agent) === 'idle')
  if (idleChildren.length < MIN_IDLE_CHILDREN_TO_GROUP) {
    return { activeChildren: childAgents, idleChildren: [] }
  }
  return {
    activeChildren: childAgents.filter((agent) => getAgentDotState(agent) !== 'idle'),
    idleChildren
  }
}

const QUIET_CHILD_STATES: ReadonlySet<AgentDotState> = new Set(['idle', 'done', 'unverifiable'])

const SUMMARY_STATE_RANK = new Map(SUMMARY_STATE_ORDER.map((state, rank) => [state, rank]))

/** Each parent's most urgent non-quiet descendant state, so a collapsed parent still signals live sub-agent work. */
export function buildCollapsedChildAgentSignalStates(
  childrenByParentPaneKey: ReadonlyMap<string, readonly DashboardAgentRowData[]>
): ReadonlyMap<string, AgentDotState> {
  // One bottom-up pass; per-parent subtree walks were quadratic on deep chains.
  const bestRankByPaneKey = new Map<string, number>()
  const visiting = new Set<string>()
  const bestDescendantRank = (paneKey: string): number => {
    const cached = bestRankByPaneKey.get(paneKey)
    if (cached !== undefined) {
      return cached
    }
    // Lineage metadata may cycle; a pane never counts its own subtree twice.
    if (visiting.has(paneKey)) {
      return Infinity
    }
    visiting.add(paneKey)
    let best = Infinity
    for (const child of childrenByParentPaneKey.get(paneKey) ?? []) {
      const childRank = SUMMARY_STATE_RANK.get(getAgentDotState(child)) ?? Infinity
      best = Math.min(best, childRank, bestDescendantRank(child.paneKey))
    }
    visiting.delete(paneKey)
    bestRankByPaneKey.set(paneKey, best)
    return best
  }
  const signalStates = new Map<string, AgentDotState>()
  for (const parentPaneKey of childrenByParentPaneKey.keys()) {
    const top = SUMMARY_STATE_ORDER[bestDescendantRank(parentPaneKey)]
    if (top && !QUIET_CHILD_STATES.has(top)) {
      signalStates.set(parentPaneKey, top)
    }
  }
  return signalStates
}

type IdleChildAgentGroupRowProps = {
  count: number
  expanded: boolean
  onToggle: () => void
  // Full-mode child rows use a wider inset; match it so the dots share one column.
  layout: 'compact' | 'full'
  // Sits among treeitem siblings, so it joins the tree at their level.
  ariaLevel: number
}

export function IdleChildAgentGroupRow({
  count,
  expanded,
  onToggle,
  layout,
  ariaLevel
}: IdleChildAgentGroupRowProps): React.JSX.Element {
  const label = translate('sidebar.agentSummary.idleChildCount', '{{count}} idle', { count })
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.stopPropagation()
      onToggle()
    },
    [onToggle]
  )
  const stopPropagation = useCallback((e: React.SyntheticEvent) => {
    e.stopPropagation()
  }, [])
  const stopActivationKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
    }
  }, [])
  return (
    <button
      type="button"
      draggable={false}
      className={cn(
        'worktree-agent-row-hover',
        'flex h-6 min-w-0 items-center gap-1 rounded-sm text-left text-[11px] leading-none',
        layout === 'full' ? '-ml-1 w-[calc(100%+0.25rem)] pl-1 pr-2' : 'w-full px-1',
        // Group header is meta, not an agent: use the trail tone so it doesn't read as a row name.
        'text-muted-foreground/65 tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'
      )}
      data-idle-child-agent-group=""
      role="treeitem"
      aria-level={ariaLevel}
      aria-expanded={expanded}
      aria-label={
        expanded
          ? translate('sidebar.agentSummary.hideIdleChildren', 'Hide {{count}} idle child agents', {
              count
            })
          : translate('sidebar.agentSummary.showIdleChildren', 'Show {{count}} idle child agents', {
              count
            })
      }
      onClick={handleClick}
      onKeyDown={stopActivationKey}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
      onDragStart={stopPropagation}
    >
      <span className="inline-flex shrink-0 opacity-60">
        <AgentStateDot state="idle" size="sm" title={null} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronDown
        className={cn(
          'size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150',
          expanded && 'rotate-180'
        )}
        aria-hidden
      />
    </button>
  )
}

type ChildAgentsWithIdleGroupProps = {
  childAgents: DashboardAgentRowData[]
  flat: boolean
  idleExpanded: boolean
  onToggleIdle: () => void
  layout: 'compact' | 'full'
  ariaLevel: number
  renderChild: (childAgent: DashboardAgentRowData, idleGroupExpanded: boolean) => React.ReactNode
}

/** Idle children fold behind one row so held-but-idle subagents don't crowd live work. */
export function ChildAgentsWithIdleGroup({
  childAgents,
  flat,
  idleExpanded,
  onToggleIdle,
  layout,
  ariaLevel,
  renderChild
}: ChildAgentsWithIdleGroupProps): React.JSX.Element {
  const { activeChildren, idleChildren } = flat
    ? { activeChildren: childAgents, idleChildren: [] }
    : partitionIdleChildAgents(childAgents)
  return (
    <>
      {activeChildren.map((childAgent) => renderChild(childAgent, true))}
      {idleChildren.length > 0 ? (
        <>
          <IdleChildAgentGroupRow
            count={idleChildren.length}
            expanded={idleExpanded}
            onToggle={onToggleIdle}
            layout={layout}
            ariaLevel={ariaLevel}
          />
          {layout === 'compact' ? (
            <CompactAgentExpansion expanded={idleExpanded}>
              {idleChildren.map((childAgent) => renderChild(childAgent, idleExpanded))}
            </CompactAgentExpansion>
          ) : idleExpanded ? (
            idleChildren.map((childAgent) => renderChild(childAgent, true))
          ) : null}
        </>
      ) : null}
    </>
  )
}
