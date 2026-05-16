import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useNow } from '@/components/dashboard/useNow'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { cn } from '@/lib/utils'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { dismissStaleAgentRowByKey } from '../terminal-pane/stale-agent-row'

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
      const parsed = parsePaneKey(paneKey)
      if (!parsed) {
        // Why: malformed or legacy numeric keys cannot be resolved safely after
        // pane replay/remount, so drop the stale row instead of guessing.
        console.warn('[WorktreeCardAgents] malformed paneKey, skipping pane focus', paneKey)
        dismissStaleAgentRowByKey(paneKey)
        return
      }
      if (parsed.tabId !== tabId) {
        console.warn('[WorktreeCardAgents] paneKey tabId mismatch, dismissing row', {
          tabId,
          paneKey
        })
        dismissStaleAgentRowByKey(paneKey)
        return
      }
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
        activateTabAndFocusPane(tabId, parsed.leafId, { ackPaneKeyOnSuccess: paneKey })
      } else {
        dismissStaleAgentRowByKey(paneKey)
      }
    },
    [worktreeId]
  )

  // Why: own one 30s tick per non-empty inline list. Cards with zero agents
  // never mount this component (see WorktreeCardAgents), so idle worktrees
  // don't pay any timer cost.
  const now = useNow(30_000)

  const stopBubble = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  return (
    // Why: swallow bubbling so clicks on the gutter around the agent rows
    // don't reach WorktreeCard's activate / edit-meta handlers.
    <div
      className={cn('flex flex-col mt-1 divide-y divide-border/30', className)}
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      role="group"
      aria-label="Agents"
    >
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
  )
})

export default WorktreeCardAgents
