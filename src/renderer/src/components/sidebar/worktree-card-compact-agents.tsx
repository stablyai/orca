import React, { useCallback, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { cn } from '@/lib/utils'
import {
  buildSummaryAgentGroups,
  selectSummaryGroupIconAgents,
  summarizeAgentIdentities,
  summarizeAgents
} from './worktree-card-agent-summary'
import { translate } from '@/i18n/i18n'
import { ClaudeAgentSummaryViewIndicator } from '@/components/ClaudeAgentViewIndicator'
import { useFocusedAgentPaneKey } from './focused-agent-row-highlight'

export { CompactAgentRow } from './worktree-card-compact-agent-row'

function stopActivationKeyPropagation(e: React.KeyboardEvent): void {
  // Keep nested button Enter/Space local instead of activating the surrounding workspace row.
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
    // Retain opened content for collapse animation without an extra effect-driven expansion render.
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
      {/* Why: clip only the height animation; a gutter-hung chevron overflows horizontally. */}
      <div className="min-h-0 min-w-0 overflow-x-visible overflow-y-clip">
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
  const focusedPaneKey = useFocusedAgentPaneKey(agents[0]?.tab.worktreeId ?? '')
  const focusedAgent = agents.find((agent) => agent.paneKey === focusedPaneKey)
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
        'compact-agent-summary-button group/agent-summary flex h-6 w-full min-w-0 items-center gap-1 rounded-sm',
        'px-1 text-left text-[11px] leading-none text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
        // The sidebar accent reverses brightness across themes; use the matching hover token mix.
        'hover:bg-worktree-sidebar-accent/55 dark:hover:bg-worktree-sidebar-foreground/[0.035]',
        // Only the collapsed pill needs a resting surface; expanded summaries are tree headers.
        expanded
          ? 'compact-agent-summary-button-expanded'
          : 'border border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35'
      )}
      aria-label={
        expanded
          ? translate(
              'auto.components.sidebar.worktree.card.compact.agents.0c1debfe84',
              'Collapse {{value0}}',
              { value0: subjectLabel }
            )
          : translate(
              'auto.components.sidebar.worktree.card.compact.agents.289a1d2ca7',
              'Expand {{value0}}. {{value1}}',
              { value0: summary, value1: agentIdentitySummary }
            )
      }
      aria-expanded={expanded}
      onClick={handleToggle}
      onKeyDown={stopActivationKeyPropagation}
      onMouseDown={stopPointerPropagation}
      onPointerDown={stopPointerPropagation}
      onDragStart={stopPointerPropagation}
    >
      {!expanded && focusedAgent && <ClaudeAgentSummaryViewIndicator agent={focusedAgent} />}
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
                  className="inline-flex min-w-0 shrink-0 items-center gap-0.5 rounded-sm bg-worktree-sidebar/70 px-1 py-0.5"
                >
                  <AgentStateDot state={group.state} size="sm" tooltipSide="right" />
                  {/* Overlap identities only within the same status cluster to save width. */}
                  <span className="inline-flex shrink-0 items-center -space-x-0.5 pl-0.5">
                    {iconAgents.map((agent) => (
                      <span
                        key={agent.paneKey}
                        className="inline-flex size-4 items-center justify-center rounded-full border border-worktree-sidebar-border/70 bg-worktree-sidebar"
                      >
                        <AgentTypeIcon agentType={agent.agentType} size={13} />
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
      <ChevronDown
        className={cn(
          'size-3 shrink-0 transition-transform duration-150',
          !expanded && '-rotate-90'
        )}
        aria-hidden
      />
    </button>
  )
}
