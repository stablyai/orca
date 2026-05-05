import React, { useCallback, useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useNow } from '@/components/dashboard/useNow'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { cn } from '@/lib/utils'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'

type Props = {
  worktreeId: string
  /** Controls spacing from the card body above. Passed in so the parent can
   *  decide whether a divider is appropriate — e.g. suppressed when the card
   *  chrome already provides visual separation. */
  className?: string
}

/**
 * Inline agent list rendered directly inside WorktreeCard when the
 * 'inline-agents' card property is enabled. Gives persistent per-card
 * visibility of each agent's live state, prompt, and last message.
 *
 * Reuses useWorktreeAgentRows + DashboardAgentRow so row layout and the
 * derivation stay consistent with the inline agent activity on each card.
 */
const WorktreeCardAgents = React.memo(function WorktreeCardAgents({
  worktreeId,
  className
}: Props) {
  const agents = useWorktreeAgentRows(worktreeId)
  if (agents.length === 0) {
    return null
  }
  // Why: gate the 30s tick behind non-empty rows by mounting the inner body
  // only when there's something to show. The setInterval lives in the inner
  // component's useNow, so idle worktrees don't pay per-card timer cost.
  return <WorktreeCardAgentsBody worktreeId={worktreeId} agents={agents} className={className} />
})

type BodyProps = {
  worktreeId: string
  agents: DashboardAgentRowData[]
  className?: string
}

const WorktreeCardAgentsBody = React.memo(function WorktreeCardAgentsBody({
  worktreeId,
  agents,
  className
}: BodyProps) {
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const acknowledgeAgents = useAppStore((s) => s.acknowledgeAgents)

  // Why: per-worktree collapse is session-only UI state. Single-primitive
  // subscription so the card only re-renders when THIS worktree's collapsed
  // flag flips — not on any other worktree's toggle.
  const isCollapsed = useAppStore((s) => s.collapsedInlineAgentsByWorktreeId[worktreeId] === true)
  const toggleInlineAgentsCollapsed = useAppStore((s) => s.toggleInlineAgentsCollapsed)

  // Why: subscribe to the ack map reference (Object.is equality) and derive
  // per-agent unvisited flags locally. Keeps the inline list's bold/mute
  // behavior consistent with how acks flow elsewhere — rows bold on first
  // appearance and mute once the user has visited the agent's tab
  // (useAutoAckViewedAgent acks automatically on terminal focus). Without
  // this, all inline rows stayed muted regardless of attention state.
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  const unvisitedByPaneKey = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const a of agents) {
      const ackAt = acknowledgedAgentsByPaneKey[a.paneKey] ?? 0
      out[a.paneKey] = ackAt < a.entry.stateStartedAt
    }
    return out
  }, [agents, acknowledgedAgentsByPaneKey])

  const handleDismissAgent = useCallback(
    (paneKey: string) => {
      dropAgentStatus(paneKey)
      dismissRetainedAgent(paneKey)
    },
    [dropAgentStatus, dismissRetainedAgent]
  )

  const handleActivateAgentTab = useCallback(
    (tabId: string, paneKey: string) => {
      acknowledgeAgents([paneKey])
      // Why: route through activateAndRevealWorktree so cross-repo clicks also
      // set activeRepoId, record a nav-history entry, clear sidebar filters,
      // reveal the card, and stamp focus recency — per the design doc rule
      // "Every user-initiated worktree switch must route through
      // activateAndRevealWorktree". Bypassing it (direct setActiveWorktree +
      // markWorktreeVisited) silently skipped cross-repo activation and
      // back/forward history for clicks from inline agent rows.
      activateAndRevealWorktree(worktreeId)
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId)
      }
    },
    [worktreeId, setActiveTab, acknowledgeAgents]
  )

  const handleToggleCollapsed = useCallback(
    (e: React.MouseEvent) => {
      // Why: the header is inside WorktreeCard, whose outer click handler
      // activates the worktree. Stop propagation so expanding/collapsing the
      // list doesn't also navigate away — the user's intent is clearly the
      // toggle, not a worktree switch.
      e.stopPropagation()
      toggleInlineAgentsCollapsed(worktreeId)
    },
    [toggleInlineAgentsCollapsed, worktreeId]
  )

  // Why: own one 30s tick per non-empty inline list. Cards with zero agents
  // never mount this component (see WorktreeCardAgents), so idle worktrees
  // don't pay any timer cost.
  const now = useNow(30_000)

  return (
    <div
      className={cn('flex flex-col mt-1', className)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* Why: clickable header toggles the section open/closed. Using a real
          <button> keeps keyboard + a11y semantics correct (Enter/Space
          activate, proper focus ring, aria-expanded for screen readers). */}
      <button
        type="button"
        onClick={handleToggleCollapsed}
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand agent activity' : 'Collapse agent activity'}
        className="flex items-center gap-1 mb-0.5 px-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <ChevronDown
          className={cn('size-2.5 transition-transform duration-150', isCollapsed && '-rotate-90')}
        />
        <span>Agents ({agents.length})</span>
      </button>
      {!isCollapsed && (
        <div className="flex flex-col divide-y divide-border/30">
          {agents.map((agent) => (
            <div key={agent.paneKey} className="py-0.5">
              <DashboardAgentRow
                agent={agent}
                onDismiss={handleDismissAgent}
                onActivate={handleActivateAgentTab}
                now={now}
                // Why: bold an agent row until the user has visited its tab.
                // useAutoAckViewedAgent acks automatically when the user
                // focuses the agent's tab, which mutes the row in lockstep.
                isUnvisited={unvisitedByPaneKey[agent.paneKey] ?? false}
                // Why: inline rows pack tighter than a full-panel layout;
                // 'md' reads as a second ~12px glyph users confuse with the
                // agent identity icon right next to it. 'sm' keeps the two
                // distinguishable at a glance.
                stateDotSize="sm"
                // Why: in the per-card inline list clicking the row jumps
                // directly to the agent, so the expand chevron is redundant.
                // Keep the identity glyph (Claude/Gemini/…) so users can tell
                // agents apart at a glance within a worktree.
                hideExpand
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

export default WorktreeCardAgents
