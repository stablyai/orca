import type { AgentGroupSummary } from '@/store/slices/agent-status/agent-row-display-index'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import React, { useCallback, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { cn } from '@/lib/class-names'
import {
  buildSummaryAgentGroups,
  formatAllAgentsInState,
  formatStateCount,
  formatSummaryStateLabel,
  selectSummaryGroupIconAgents,
  summarizeAgentIdentities,
  summarizeAgents
} from './worktree-card-agent-summary'
import { useTranslate } from '@/i18n/use-translate'

import './worktree-card-compact-agent-row'

function stopActivationKeyPropagation(e: React.KeyboardEvent): void {
  // Keep nested button Enter/Space local instead of activating the surrounding workspace row.
  if (e.key === 'Enter' || e.key === ' ') {
    e.stopPropagation()
  }
}

type CompactAgentSummaryButtonProps = {
  agents?: DashboardAgentRowData[]
  groups?: readonly AgentGroupSummary[]
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

const EMPTY_AGENTS: NonNullable<CompactAgentSummaryButtonProps['agents']> = []

export function CompactAgentSummaryButton({
  agents = EMPTY_AGENTS,
  groups: precomputedGroups,
  subjectLabel,
  expanded,
  onToggle
}: CompactAgentSummaryButtonProps): React.JSX.Element {
  const t = useTranslate()
  const groups: readonly AgentGroupSummary[] =
    precomputedGroups ??
    buildSummaryAgentGroups(agents).map((group) => ({
      state: group.state,
      count: group.agents.length,
      icons: selectSummaryGroupIconAgents(group.agents, 3),
      identities: []
    }))
  const summary = !precomputedGroups
    ? summarizeAgents(agents, subjectLabel, t)
    : groups.length === 1
      ? formatAllAgentsInState(groups[0].state, groups[0].count, t)
      : t('sidebar.agentSummary.mixedStates', '{{subject}}: {{states}}', {
          subject: subjectLabel,
          states: groups.map((group) => formatStateCount(group.state, group.count, t)).join(', ')
        })
  const visibleGroups = groups.slice(0, 3)
  const hiddenGroupAgentCount = groups
    .slice(visibleGroups.length)
    .reduce((count, group) => count + group.count, 0)
  const agentIdentitySummary = !precomputedGroups
    ? summarizeAgentIdentities(agents, t)
    : groups
        .flatMap((group) =>
          group.identities.flatMap((identity) =>
            Array.from({ length: identity.count }, () =>
              t('sidebar.agentSummary.agentIdentityState', '{{agent}} {{status}}', {
                agent: formatAgentTypeLabel(identity.agentType),
                status: formatSummaryStateLabel(group.state, t)
              })
            )
          )
        )
        .join('; ')
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
          ? t(
              'auto.components.sidebar.worktree.card.compact.agents.0c1debfe84',
              'Collapse {{value0}}',
              { value0: subjectLabel }
            )
          : t(
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
      {expanded ? (
        <span className="min-w-0 flex-1 truncate px-1 font-medium text-muted-foreground">
          {subjectLabel}
        </span>
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden" aria-hidden>
            {visibleGroups.map((group) => {
              const iconAgents = group.icons
              const hiddenIconCount = Math.max(0, group.count - iconAgents.length)
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
