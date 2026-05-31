import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useNow } from '@/components/dashboard/useNow'
import { deriveRunningAgentSendTargets } from '@/lib/running-agent-targets'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { cn } from '@/lib/utils'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { dismissStaleAgentRowByKey } from '../terminal-pane/stale-agent-row'
import { useFocusedAgentPaneKey } from './focused-agent-row-highlight'
import {
  CompactAgentExpansion,
  CompactAgentRow,
  CompactAgentSummaryButton
} from './worktree-card-compact-agents'
import { DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE } from '../../../../shared/constants'
import { revealElementInScrollContainer } from './worktree-sidebar-reveal'

export const SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT =
  'orca-suppress-worktree-list-scroll-adjustment'

const dispatchSuppressScrollAdjustment = () => {
  window.dispatchEvent(new CustomEvent(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT))
}

function revealCompactAgentCard(agentListRoot: HTMLElement | null): void {
  const sidebarElement = agentListRoot?.closest('[data-worktree-sidebar]')
  const worktreeOptionElement = agentListRoot?.closest('[role="option"]')
  if (!(sidebarElement instanceof HTMLElement) || !worktreeOptionElement) {
    return
  }
  revealElementInScrollContainer(sidebarElement, worktreeOptionElement, 'auto')
}

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

type AgentLineageModel = {
  rootAgents: DashboardAgentRowData[]
  childrenByParentPaneKey: Map<string, DashboardAgentRowData[]>
}

function buildAgentLineageModel(agents: DashboardAgentRowData[]): AgentLineageModel {
  const agentPaneKeys = new Set(agents.map((agent) => agent.paneKey))
  const childrenByParentPaneKey = new Map<string, DashboardAgentRowData[]>()
  const childPaneKeys = new Set<string>()

  for (const agent of agents) {
    const parentPaneKey = agent.entry.orchestration?.parentPaneKey
    if (!parentPaneKey || !agentPaneKeys.has(parentPaneKey)) {
      continue
    }
    childPaneKeys.add(agent.paneKey)
    const siblings = childrenByParentPaneKey.get(parentPaneKey)
    if (siblings) {
      siblings.push(agent)
    } else {
      childrenByParentPaneKey.set(parentPaneKey, [agent])
    }
  }

  const rootAgents = agents.filter((agent) => !childPaneKeys.has(agent.paneKey))
  if (rootAgents.length === 0 && agents.length > 0) {
    // Why: malformed orchestration metadata can theoretically form a cycle.
    // Keep every row visible instead of recursing forever or hiding the list.
    return { rootAgents: agents, childrenByParentPaneKey: new Map() }
  }

  const reachablePaneKeys = new Set<string>()
  const markReachable = (
    agent: DashboardAgentRowData,
    ancestorPaneKeys: ReadonlySet<string> = new Set()
  ): void => {
    if (reachablePaneKeys.has(agent.paneKey) || ancestorPaneKeys.has(agent.paneKey)) {
      return
    }
    reachablePaneKeys.add(agent.paneKey)
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(agent.paneKey)
    for (const childAgent of childrenByParentPaneKey.get(agent.paneKey) ?? []) {
      markReachable(childAgent, descendantAncestorPaneKeys)
    }
  }
  for (const rootAgent of rootAgents) {
    markReachable(rootAgent)
  }

  for (const agent of agents) {
    if (reachablePaneKeys.has(agent.paneKey)) {
      continue
    }
    // Why: a partial cycle alongside a valid root has no true root, so it
    // would otherwise disappear. Render malformed participants as flat rows
    // and drop their child edges, matching the dashboard lineage fallback.
    rootAgents.push(agent)
    childrenByParentPaneKey.delete(agent.paneKey)
  }

  return { rootAgents, childrenByParentPaneKey }
}

const WorktreeCardAgentsBody = React.memo(function WorktreeCardAgentsBody({
  worktreeId,
  agents,
  className
}: BodyProps) {
  const agentActivityDisplayMode =
    useAppStore((s) => s.agentActivityDisplayMode) ?? DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const agentSendPopoverTargetMode = useAppStore((s) => s.agentSendPopoverTargetMode)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const sendPromptToSidebarAgentTarget = useAppStore((s) => s.sendPromptToSidebarAgentTarget)
  const focusedAgentPaneKey = useFocusedAgentPaneKey(worktreeId)
  const compactAgentListRootRef = useRef<HTMLDivElement | null>(null)

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

  const isAgentSendTargetModeActive = agentSendPopoverTargetMode?.worktreeId === worktreeId
  const sendTargetsByPaneKey = useMemo(() => {
    void agentStatusEpoch
    if (!isAgentSendTargetModeActive) {
      return new Map<
        string,
        { status: 'eligible' | 'disabled' | 'sending'; disabledReason?: string }
      >()
    }

    return new Map(
      deriveRunningAgentSendTargets(
        { agentStatusByPaneKey, tabsByWorktree, terminalLayoutsByTabId },
        worktreeId
      ).map((target) => [
        target.paneKey,
        agentSendPopoverTargetMode?.status === 'sending' &&
        agentSendPopoverTargetMode.sendingPaneKey === target.paneKey
          ? { status: 'sending' as const, disabledReason: 'Sending...' }
          : target.disabledReason
            ? { status: target.status, disabledReason: target.disabledReason }
            : { status: target.status }
      ])
    )
  }, [
    // Why: stale-boundary timers bump this epoch without replacing the status
    // map, so target eligibility must derive again when freshness flips.
    agentStatusEpoch,
    agentSendPopoverTargetMode?.sendingPaneKey,
    agentSendPopoverTargetMode?.status,
    agentStatusByPaneKey,
    isAgentSendTargetModeActive,
    tabsByWorktree,
    terminalLayoutsByTabId,
    worktreeId
  ])

  const handleSendTargetClick = useCallback(
    (paneKey: string) => {
      void sendPromptToSidebarAgentTarget(paneKey)
    },
    [sendPromptToSidebarAgentTarget]
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
        activateTabAndFocusPane(tabId, parsed.leafId, {
          ackPaneKeyOnSuccess: paneKey,
          flashFocusedPane: true,
          scrollToBottomIfOutputSinceLastView: true
        })
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
  const { rootAgents, childrenByParentPaneKey } = useMemo(
    () => buildAgentLineageModel(agents),
    [agents]
  )
  const hasLineage = childrenByParentPaneKey.size > 0
  const [expandedLineageParents, setExpandedLineageParents] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [compactRootListExpanded, setCompactRootListExpanded] = useState(false)

  useLayoutEffect(() => {
    if (compactRootListExpanded && agentActivityDisplayMode === 'compact') {
      dispatchSuppressScrollAdjustment()
      // Why: keep any needed reveal scroll in the expansion commit; a delayed
      // store reveal paints the tall card once, then scrolls it on the next turn.
      revealCompactAgentCard(compactAgentListRootRef.current)
    }
  }, [agentActivityDisplayMode, compactRootListExpanded])
  const toggleLineageParent = useCallback((paneKey: string) => {
    dispatchSuppressScrollAdjustment()
    setExpandedLineageParents((current) => {
      const next = new Set(current)
      if (next.has(paneKey)) {
        next.delete(paneKey)
      } else {
        next.add(paneKey)
      }
      return next
    })
  }, [])

  const stopBubble = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  // Why: when any root row has a disclosure chevron, leaf siblings reserve a
  // matching leading spacer so the state-dot column stays aligned across the
  // card. Without this, parent rows shift right by the chevron's width while
  // leaf rows hug the gutter — visible misalignment when the user sweeps the
  // leading column.
  const anyRootHasChildren = rootAgents.some(
    (agent) => (childrenByParentPaneKey.get(agent.paneKey) ?? []).length > 0
  )

  const renderAgentBranch = (
    agent: DashboardAgentRowData,
    ancestorPaneKeys: ReadonlySet<string> = new Set()
  ): React.ReactNode => {
    if (ancestorPaneKeys.has(agent.paneKey)) {
      // Why: orchestration metadata is external state and can be malformed.
      // Bail out of repeated ancestors instead of recursing forever.
      return null
    }
    const childAgents = childrenByParentPaneKey.get(agent.paneKey) ?? []
    const hasChildAgents = childAgents.length > 0
    const expanded = expandedLineageParents.has(agent.paneKey)
    const sendTarget = isAgentSendTargetModeActive
      ? (sendTargetsByPaneKey.get(agent.paneKey) ?? {
          status: 'disabled' as const,
          disabledReason: 'Agent is not available'
        })
      : undefined
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(agent.paneKey)
    return (
      <React.Fragment key={agent.paneKey}>
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
          // Why: fold orchestration children under the parent row's leading
          // chevron so a parent reads as a tree node, not as a separate
          // disclosure stripe below it. Variant B in the mockups.
          childAgentCount={hasChildAgents ? childAgents.length : undefined}
          childAgentsExpanded={expanded}
          onToggleChildAgents={
            hasChildAgents ? () => toggleLineageParent(agent.paneKey) : undefined
          }
          // Why: keep leaf rows aligned with parent rows in the same card —
          // see anyRootHasChildren above.
          reserveDisclosureGutter={anyRootHasChildren && !hasChildAgents}
          isFocusedPane={agent.paneKey === focusedAgentPaneKey}
          sendTargetStatus={sendTarget?.status}
          sendTargetDisabledReason={sendTarget?.disabledReason}
          onSendTargetClick={isAgentSendTargetModeActive ? handleSendTargetClick : undefined}
          // Why: the disclosure variant uses chevron + indentation to show
          // hierarchy. The legacy L-connector / vertical-trunk decorations
          // are pinned to a fixed left offset that doesn't match the
          // chevron-shifted column and read as floating fragments.
          hideLineageConnectors
        />
        {hasChildAgents && expanded
          ? childAgents.map((childAgent) =>
              renderAgentBranch(childAgent, descendantAncestorPaneKeys)
            )
          : null}
      </React.Fragment>
    )
  }

  const renderCompactAgentBranch = (
    agent: DashboardAgentRowData,
    ancestorPaneKeys: ReadonlySet<string> = new Set()
  ): React.ReactNode => {
    if (ancestorPaneKeys.has(agent.paneKey)) {
      return null
    }
    const childAgents = childrenByParentPaneKey.get(agent.paneKey) ?? []
    const hasChildAgents = childAgents.length > 0
    const expanded = expandedLineageParents.has(agent.paneKey)
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(agent.paneKey)
    return (
      <React.Fragment key={agent.paneKey}>
        <CompactAgentRow
          agent={agent}
          now={now}
          onActivate={handleActivateAgentTab}
          childAgentCount={hasChildAgents ? childAgents.length : undefined}
          childAgentsExpanded={expanded}
          onToggleChildAgents={
            hasChildAgents ? () => toggleLineageParent(agent.paneKey) : undefined
          }
          reserveDisclosureGutter={anyRootHasChildren && !hasChildAgents}
          isFocusedPane={agent.paneKey === focusedAgentPaneKey}
        />
        {hasChildAgents ? (
          <CompactAgentExpansion expanded={expanded}>
            {childAgents.map((childAgent) =>
              renderCompactAgentBranch(childAgent, descendantAncestorPaneKeys)
            )}
          </CompactAgentExpansion>
        ) : null}
      </React.Fragment>
    )
  }

  if (agentActivityDisplayMode === 'compact') {
    const summaryAgents = hasLineage ? rootAgents : agents
    // Why: compact worktree cards keep multiple active agents to a single
    // predictable status line, even when there are only two agents.
    const shouldUseSummaryRow = summaryAgents.length > 1
    const subjectLabel = hasLineage
      ? `${rootAgents.length} ${rootAgents.length === 1 ? 'parent' : 'parents'}`
      : `${agents.length} agents`

    return (
      <div
        ref={compactAgentListRootRef}
        className={cn('flex flex-col mt-1 gap-0.5', className)}
        onClick={stopBubble}
        onDoubleClick={stopBubble}
        onMouseDown={stopBubble}
        onPointerDown={stopBubble}
        role={hasLineage ? 'tree' : 'group'}
        aria-label="Agents"
      >
        {shouldUseSummaryRow && (
          <CompactAgentSummaryButton
            agents={summaryAgents}
            subjectLabel={subjectLabel}
            expanded={compactRootListExpanded}
            onToggle={() => {
              dispatchSuppressScrollAdjustment()
              setCompactRootListExpanded((expanded) => !expanded)
            }}
          />
        )}
        {!shouldUseSummaryRow ? (
          rootAgents.map((rootAgent) => renderCompactAgentBranch(rootAgent))
        ) : shouldUseSummaryRow ? (
          <CompactAgentExpansion expanded={compactRootListExpanded}>
            {rootAgents.map((rootAgent) => renderCompactAgentBranch(rootAgent))}
          </CompactAgentExpansion>
        ) : null}
      </div>
    )
  }

  return (
    // Why: swallow bubbling so clicks on the gutter around the agent rows
    // don't reach WorktreeCard's activate / edit-meta handlers.
    <div
      className={cn('flex flex-col mt-1', className)}
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
      role={hasLineage ? 'tree' : 'group'}
      aria-label="Agents"
    >
      {rootAgents.map((rootAgent) => renderAgentBranch(rootAgent))}
    </div>
  )
})

export default WorktreeCardAgents
