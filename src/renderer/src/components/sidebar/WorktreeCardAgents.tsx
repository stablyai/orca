import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateTerminalTabOnOwner } from '@/lib/terminal-tab-owner-activation'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useNow } from '@/hooks/use-now'
import { deriveRunningAgentSendTargets } from '@/lib/running-agent-targets'
import {
  selectSendTargetControlInputs,
  selectSendTargetInputs
} from './worktree-card-send-target-inputs'
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
import { buildAgentRowLineageTree } from '@/components/dashboard/agent-row-lineage-model'
import { DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE } from '../../../../shared/constants'
import { revealElementInScrollContainer } from './worktree-sidebar-reveal'
import { useWorktreeAgentExpansionState } from './worktree-card-agents-expansion-state'
import { translate } from '@/i18n/i18n'
import { agentSendDisabledReasonLabel } from '@/lib/agent-send-disabled-reason-label'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { activateRetainedAgentRow } from './activate-retained-agent-row'
import { selectAgentRowsUnread } from './worktree-card-agent-ack-inputs'

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
  agents?: DashboardAgentRowData[]
  className?: string
}

const WorktreeCardAgents = React.memo(function WorktreeCardAgents({
  worktreeId,
  agents: precomputedAgents,
  className
}: Props) {
  useUiLanguageRevision()
  const selectedAgents = useWorktreeAgentRows(worktreeId, precomputedAgents === undefined)
  const agents = precomputedAgents ?? selectedAgents
  if (agents.length === 0) {
    return null
  }
  // Only non-empty bodies mount the 30s clock, avoiding timer cost for idle worktrees.
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
  const languageRevision = useUiLanguageRevision()
  const agentActivityDisplayMode =
    useAppStore((s) => s.agentActivityDisplayMode) ?? DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const { targetMode: agentSendPopoverTargetMode, agentStatusEpoch } = useAppStore(
    useShallow((s) => selectSendTargetControlInputs(s, worktreeId))
  )
  // Use a stable empty selector outside our send popover so unrelated title/status churn cannot wake idle cards.
  const sendTargetInputs = useAppStore(useShallow((s) => selectSendTargetInputs(s, worktreeId)))
  const sendPromptToSidebarAgentTarget = useAppStore((s) => s.sendPromptToSidebarAgentTarget)
  const focusedAgentPaneKey = useFocusedAgentPaneKey(worktreeId)
  const compactAgentListRootRef = useRef<HTMLDivElement | null>(null)

  // Project global acknowledgement state onto this card’s rows to avoid rerenders from other worktrees.
  const agentRowsUnread = useAppStore(useShallow((s) => selectAgentRowsUnread(s, agents)))
  const unvisitedByPaneKey = useMemo(() => {
    const out: Record<string, boolean> = {}
    for (const [index, agent] of agents.entries()) {
      out[agent.paneKey] = agentRowsUnread[index] ?? false
    }
    return out
  }, [agents, agentRowsUnread])

  const handleDismissAgent = useCallback(
    (paneKey: string) => {
      dropAgentStatus(paneKey)
      dismissRetainedAgent(paneKey)
    },
    [dropAgentStatus, dismissRetainedAgent]
  )

  const isAgentSendTargetModeActive = agentSendPopoverTargetMode !== null
  const sendTargetsByPaneKey = useMemo(() => {
    void agentStatusEpoch
    void languageRevision
    if (!isAgentSendTargetModeActive) {
      return new Map<
        string,
        { status: 'eligible' | 'disabled' | 'sending'; disabledReason?: string }
      >()
    }

    return new Map(
      deriveRunningAgentSendTargets(sendTargetInputs, worktreeId).map((target) => [
        target.paneKey,
        agentSendPopoverTargetMode?.status === 'sending' &&
        agentSendPopoverTargetMode.sendingPaneKey === target.paneKey
          ? {
              status: 'sending' as const,
              disabledReason: translate(
                'auto.components.sidebar.WorktreeCardAgents.sendingTarget',
                'Sending...'
              )
            }
          : target.disabledReason
            ? {
                status: target.status,
                disabledReason: agentSendDisabledReasonLabel(target.disabledReason)
              }
            : { status: target.status }
      ])
    )
  }, [
    // Freshness timers advance this epoch without replacing the status map.
    agentStatusEpoch,
    languageRevision,
    agentSendPopoverTargetMode?.sendingPaneKey,
    agentSendPopoverTargetMode?.status,
    isAgentSendTargetModeActive,
    sendTargetInputs,
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
        // Legacy/malformed pane keys cannot resolve after replay; discard stale rows rather than guessing.
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
      // Use shared activation for cross-repo reveal and navigation history.
      activateAndRevealWorktree(worktreeId)
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        activateTabAndFocusPane(tabId, parsed.leafId, {
          ackPaneKeyOnSuccess: paneKey,
          flashFocusedPane: true,
          scrollToBottomIfOutputSinceLastView: true
        })
        activateTerminalTabOnOwner(worktreeId, tabId, parsed.leafId)
      } else if (!activateStructuredAgentSessionTab({ worktreeId, tabId })) {
        const liveEntry = useAppStore.getState().agentStatusByPaneKey[paneKey]
        if (liveEntry?.worktreeId === worktreeId) {
          // Live worker status can precede tab hydration; retain the row and activate its owning terminal.
          activateTerminalTabOnOwner(worktreeId, tabId, parsed.leafId)
          return
        }
        dismissStaleAgentRowByKey(paneKey)
      }
    },
    [worktreeId]
  )
  const handleActivateRetainedAgent = useCallback(
    (tabId: string, paneKey: string) => activateRetainedAgentRow(worktreeId, tabId, paneKey),
    [worktreeId]
  )

  const now = useNow(30_000)
  const { rootRows: rootAgents, childrenByParentPaneKey } = useMemo(
    () => buildAgentRowLineageTree(agents),
    [agents]
  )
  const hasLineage = childrenByParentPaneKey.size > 0
  // Persist disclosure outside component state so virtualizer/sibling-triggered remounts cannot reset it.
  const {
    collapsedLineageParents,
    compactRootListExpanded,
    toggleLineageParent: toggleLineageParentState,
    toggleCompactRootList
  } = useWorktreeAgentExpansionState(worktreeId)

  // Reveal only user expansion; restoring cached expansion on remount must not scroll again.
  const previousCompactExpandedRef = useRef(compactRootListExpanded)
  useLayoutEffect(() => {
    const wasExpanded = previousCompactExpandedRef.current
    previousCompactExpandedRef.current = compactRootListExpanded
    if (!wasExpanded && compactRootListExpanded && agentActivityDisplayMode === 'compact') {
      dispatchSuppressScrollAdjustment()
      // Defer reveal one frame to avoid synchronous sidebar layout during the opening animation.
      const handle = requestAnimationFrame(() => {
        revealCompactAgentCard(compactAgentListRootRef.current)
      })
      return () => cancelAnimationFrame(handle)
    }
    return undefined
  }, [agentActivityDisplayMode, compactRootListExpanded])
  const toggleLineageParent = useCallback(
    (paneKey: string) => {
      dispatchSuppressScrollAdjustment()
      toggleLineageParentState(paneKey)
    },
    [toggleLineageParentState]
  )

  const stopBubble = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])

  const renderAgentBranch = (
    agent: DashboardAgentRowData,
    ancestorPaneKeys: ReadonlySet<string> = new Set()
  ): React.ReactNode => {
    if (ancestorPaneKeys.has(agent.paneKey)) {
      // External lineage metadata may cycle; reject repeated ancestors before recursion.
      return null
    }
    const childAgents = childrenByParentPaneKey.get(agent.paneKey) ?? []
    const hasChildAgents = childAgents.length > 0
    const expanded = !collapsedLineageParents.has(agent.paneKey)
    const sendTarget = isAgentSendTargetModeActive
      ? (sendTargetsByPaneKey.get(agent.paneKey) ?? {
          status: 'disabled' as const,
          disabledReason: translate(
            'auto.components.sidebar.WorktreeCardAgents.agentUnavailable',
            'Agent is not available'
          )
        })
      : undefined
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(agent.paneKey)
    return (
      <React.Fragment key={agent.paneKey}>
        <DashboardAgentRow
          agent={agent}
          onDismiss={handleDismissAgent}
          onActivate={
            agent.rowSource === 'retained' ? handleActivateRetainedAgent : handleActivateAgentTab
          }
          now={now}
          // Keep rows bold until visiting the tab auto-acknowledges attention.
          isUnvisited={unvisitedByPaneKey[agent.paneKey] ?? false}
          // Use the smaller dot so dense inline rows do not read it as a second identity icon.
          stateDotSize="sm"
          // Row clicks already navigate to the agent, so a second expand glyph is redundant.
          hideExpand
          childAgentCount={hasChildAgents ? childAgents.length : undefined}
          childAgentsExpanded={expanded}
          onToggleChildAgents={
            hasChildAgents ? () => toggleLineageParent(agent.paneKey) : undefined
          }
          isFocusedPane={agent.paneKey === focusedAgentPaneKey}
          sendTargetStatus={sendTarget?.status}
          sendTargetDisabledReason={sendTarget?.disabledReason}
          onSendTargetClick={isAgentSendTargetModeActive ? handleSendTargetClick : undefined}
          // Chevron/indent already show hierarchy; fixed-offset connectors misalign into floating fragments.
          hideLineageConnectors
        />
        {hasChildAgents && expanded ? (
          <div className="worktree-agent-lineage-children">
            {childAgents.map((childAgent) =>
              renderAgentBranch(childAgent, descendantAncestorPaneKeys)
            )}
          </div>
        ) : null}
      </React.Fragment>
    )
  }

  const renderCompactAgentBranch = (
    agent: DashboardAgentRowData,
    ancestorPaneKeys: ReadonlySet<string> = new Set(),
    cacheTimerActive = true
  ): React.ReactNode => {
    if (ancestorPaneKeys.has(agent.paneKey)) {
      return null
    }
    const childAgents = childrenByParentPaneKey.get(agent.paneKey) ?? []
    const hasChildAgents = childAgents.length > 0
    const expanded = !collapsedLineageParents.has(agent.paneKey)
    const sendTarget = isAgentSendTargetModeActive
      ? (sendTargetsByPaneKey.get(agent.paneKey) ?? {
          status: 'disabled' as const,
          disabledReason: translate(
            'auto.components.sidebar.WorktreeCardAgents.agentUnavailable',
            'Agent is not available'
          )
        })
      : undefined
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(agent.paneKey)
    return (
      <div key={agent.paneKey} className="min-w-0">
        <CompactAgentRow
          agent={agent}
          now={now}
          isUnvisited={unvisitedByPaneKey[agent.paneKey] ?? false}
          onActivate={
            agent.rowSource === 'retained' ? handleActivateRetainedAgent : handleActivateAgentTab
          }
          sendTargetStatus={sendTarget?.status}
          sendTargetDisabledReason={sendTarget?.disabledReason}
          onSendTargetClick={isAgentSendTargetModeActive ? handleSendTargetClick : undefined}
          childAgentCount={hasChildAgents ? childAgents.length : undefined}
          childAgentsExpanded={expanded}
          onToggleChildAgents={
            hasChildAgents ? () => toggleLineageParent(agent.paneKey) : undefined
          }
          isFocusedPane={agent.paneKey === focusedAgentPaneKey}
          cacheTimerActive={cacheTimerActive}
        />
        {hasChildAgents ? (
          <CompactAgentExpansion expanded={expanded}>
            <div className="worktree-agent-lineage-children flex flex-col gap-0.5">
              {childAgents.map((childAgent) =>
                renderCompactAgentBranch(
                  childAgent,
                  descendantAncestorPaneKeys,
                  cacheTimerActive && expanded
                )
              )}
            </div>
          </CompactAgentExpansion>
        ) : null}
      </div>
    )
  }

  if (agentActivityDisplayMode === 'compact') {
    const summaryAgents = hasLineage ? rootAgents : agents
    // Collapse compact multi-agent lists except when their rows are the send-target picker.
    const shouldUseSummaryRow = summaryAgents.length > 1 && !isAgentSendTargetModeActive
    const subjectLabel = translate('sidebar.agentSummary.agentCount', '{{count}} agents', {
      count: hasLineage ? rootAgents.length : agents.length,
      defaultValue_one: '{{count}} agent'
    })

    return (
      <div
        ref={compactAgentListRootRef}
        className={cn('flex flex-col mt-1 gap-0.5', className)}
        onClick={stopBubble}
        onDoubleClick={stopBubble}
        onMouseDown={stopBubble}
        onPointerDown={stopBubble}
        role={hasLineage ? 'tree' : 'group'}
        aria-label={translate('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
        data-compact-agent-list="true"
      >
        {agents.length === 0 ? null : shouldUseSummaryRow ? (
          <div
            className={cn(
              'compact-agent-summary-panel',
              compactRootListExpanded && 'compact-agent-summary-panel-expanded'
            )}
          >
            <CompactAgentSummaryButton
              agents={summaryAgents}
              subjectLabel={subjectLabel}
              expanded={compactRootListExpanded}
              onToggle={() => {
                dispatchSuppressScrollAdjustment()
                toggleCompactRootList()
              }}
            />
            <CompactAgentExpansion expanded={compactRootListExpanded}>
              {rootAgents.map((rootAgent) =>
                renderCompactAgentBranch(rootAgent, new Set(), compactRootListExpanded)
              )}
            </CompactAgentExpansion>
          </div>
        ) : (
          rootAgents.map((rootAgent) => renderCompactAgentBranch(rootAgent))
        )}
      </div>
    )
  }

  return (
    // Gutter clicks must not bubble into card activation or metadata editing.
    <div
      className={cn('flex flex-col mt-1', className)}
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
      role={hasLineage ? 'tree' : 'group'}
      aria-label={translate('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
    >
      {rootAgents.map((rootAgent) => renderAgentBranch(rootAgent))}
    </div>
  )
})

export default WorktreeCardAgents
