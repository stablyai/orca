import React, { useCallback, useLayoutEffect, useRef } from 'react'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useNow } from '@/hooks/use-now'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'
import { cn } from '@/lib/class-names'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/rows/dashboard-agent-row'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { CompactAgentExpansion, CompactAgentSummaryButton } from './worktree-card-compact-agents'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import { revealCompactAgentCard } from '../../worktree-list/navigation/worktree-sidebar-reveal'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { opensClaudeParentConversation } from '@/lib/agent-session/navigation/claude-agent-row-view'
import { ChildAgentsWithIdleGroup } from './worktree-card-idle-child-agents'
import { useWorktreeAgentListModel } from './use-worktree-agent-list-model'

type Props = {
  worktreeId: string
  /** The card's host; local and remote copies can share a workspace ID, so activation must name it. */
  executionHostId?: ExecutionHostId
  agents?: DashboardAgentRowData[]
  className?: string
}

const WorktreeCardAgents = React.memo(function WorktreeCardAgents({
  worktreeId,
  executionHostId,
  agents: precomputedAgents,
  className
}: Props) {
  useUiLanguageRevision()
  const selectedAgents = useWorktreeAgentRows(
    worktreeId,
    precomputedAgents === undefined,
    executionHostId
  )
  const agents = precomputedAgents ?? selectedAgents
  if (agents.length === 0) {
    return null
  }
  // Only non-empty bodies mount the 30s clock, avoiding timer cost for idle worktrees.
  return (
    <WorktreeCardAgentsBody
      worktreeId={worktreeId}
      executionHostId={executionHostId}
      agents={agents}
      className={className}
    />
  )
})

type BodyProps = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  agents: DashboardAgentRowData[]
  className?: string
}

const WorktreeCardAgentsBody = React.memo(function WorktreeCardAgentsBody({
  worktreeId,
  executionHostId,
  agents,
  className
}: BodyProps) {
  const t = useTranslate()
  const {
    agentActivityDisplayMode,
    showAgentModels,
    unvisitedByPaneKey,
    handleDismissAgent,
    isAgentSendTargetModeActive,
    sendTargetFor,
    handleSendTargetClick,
    handleActivateAgentTab,
    handleActivateRetainedAgent,
    rootAgents,
    childrenByParentPaneKey,
    hasLineage,
    collapsedChildAgentSignalStates,
    expandedIdleChildGroups,
    compactRootListExpanded,
    toggleCompactRootList,
    toggleLineageParent,
    toggleIdleChildGroup,
    isLineageExpanded,
    isFocusedOrHidesFocus
  } = useWorktreeAgentListModel(worktreeId, agents, executionHostId)
  const compactAgentListRootRef = useRef<HTMLDivElement | null>(null)
  const now = useNow(30_000)

  // Reveal only user expansion; restoring cached expansion on remount must not scroll again.
  const previousCompactExpandedRef = useRef(compactRootListExpanded)
  useLayoutEffect(() => {
    const wasExpanded = previousCompactExpandedRef.current
    previousCompactExpandedRef.current = compactRootListExpanded
    if (!wasExpanded && compactRootListExpanded && agentActivityDisplayMode === 'compact') {
      // Defer reveal one frame to avoid synchronous sidebar layout during the opening animation.
      const handle = requestAnimationFrame(() => {
        revealCompactAgentCard(compactAgentListRootRef.current)
      })
      return () => cancelAnimationFrame(handle)
    }
    return undefined
  }, [agentActivityDisplayMode, compactRootListExpanded])

  const renderChildAgents = (
    parent: DashboardAgentRowData,
    childAgents: DashboardAgentRowData[],
    renderChild: (childAgent: DashboardAgentRowData, idleGroupExpanded: boolean) => React.ReactNode
  ): React.ReactNode => (
    <ChildAgentsWithIdleGroup
      childAgents={childAgents}
      // Picking shows every child flat; folding would hide send targets.
      flat={isAgentSendTargetModeActive}
      idleExpanded={expandedIdleChildGroups.has(parent.paneKey)}
      onToggleIdle={() => toggleIdleChildGroup(parent.paneKey)}
      layout={agentActivityDisplayMode === 'compact' ? 'compact' : 'full'}
      ariaLevel={(parent.lineage?.depth ?? 0) + 2}
      renderChild={renderChild}
    />
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
    const expanded = isLineageExpanded(agent.paneKey)
    // Picker mode forces children open; a toggle there would silently flip stored state.
    const canToggle = hasChildAgents && !isAgentSendTargetModeActive
    const sendTarget = sendTargetFor(agent.paneKey)
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(agent.paneKey)
    return (
      <React.Fragment key={agent.paneKey}>
        <DashboardAgentRow
          agent={agent}
          showModel={showAgentModels}
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
          collapsedChildAgentsState={
            hasChildAgents && !expanded
              ? collapsedChildAgentSignalStates.get(agent.paneKey)
              : undefined
          }
          onToggleChildAgents={canToggle ? () => toggleLineageParent(agent.paneKey) : undefined}
          isFocusedPane={isFocusedOrHidesFocus(agent.paneKey, expanded)}
          sendTargetStatus={sendTarget?.status}
          sendTargetDisabledReason={sendTarget?.disabledReason}
          onSendTargetClick={isAgentSendTargetModeActive ? handleSendTargetClick : undefined}
          // Chevron/indent already show hierarchy; fixed-offset connectors misalign into floating fragments.
          hideLineageConnectors
        />
        {hasChildAgents && expanded ? (
          <div className="worktree-agent-lineage-children">
            {renderChildAgents(agent, childAgents, (childAgent) =>
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
    const expanded = isLineageExpanded(agent.paneKey)
    // Picker mode forces children open; a toggle there would silently flip stored state.
    const canToggle = hasChildAgents && !isAgentSendTargetModeActive
    const sendTarget = sendTargetFor(agent.paneKey)
    const descendantAncestorPaneKeys = new Set(ancestorPaneKeys)
    descendantAncestorPaneKeys.add(agent.paneKey)
    return (
      <div key={agent.paneKey} className={cn('min-w-0', ancestorPaneKeys.size === 0 && 'ms-2')}>
        <CompactAgentRow
          agent={agent}
          showModel={showAgentModels}
          now={now}
          parentConversationDescription={
            opensClaudeParentConversation(agent)
              ? t('auto.lib.claudeAgentRowView.openParentConversation', 'Open parent conversation')
              : undefined
          }
          isUnvisited={unvisitedByPaneKey[agent.paneKey] ?? false}
          onActivate={
            agent.rowSource === 'retained' ? handleActivateRetainedAgent : handleActivateAgentTab
          }
          sendTargetStatus={sendTarget?.status}
          sendTargetDisabledReason={sendTarget?.disabledReason}
          onSendTargetClick={isAgentSendTargetModeActive ? handleSendTargetClick : undefined}
          childAgentCount={hasChildAgents ? childAgents.length : undefined}
          childAgentsExpanded={expanded}
          collapsedChildAgentsState={
            hasChildAgents && !expanded
              ? collapsedChildAgentSignalStates.get(agent.paneKey)
              : undefined
          }
          onToggleChildAgents={canToggle ? () => toggleLineageParent(agent.paneKey) : undefined}
          isFocusedPane={isFocusedOrHidesFocus(agent.paneKey, expanded)}
          cacheTimerActive={cacheTimerActive}
        />
        {hasChildAgents ? (
          <CompactAgentExpansion expanded={expanded}>
            <div className="worktree-agent-lineage-children flex flex-col gap-0.5">
              {renderChildAgents(agent, childAgents, (childAgent, idleGroupExpanded) =>
                renderCompactAgentBranch(
                  childAgent,
                  descendantAncestorPaneKeys,
                  cacheTimerActive && expanded && idleGroupExpanded
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
    const subjectLabel = t('sidebar.agentSummary.agentCount', '{{count}} agents', {
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
        aria-label={t('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
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
              onToggle={toggleCompactRootList}
              unreadByPaneKey={unvisitedByPaneKey}
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
      aria-label={t('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
    >
      {rootAgents.map((rootAgent) => renderAgentBranch(rootAgent))}
    </div>
  )
})

export default WorktreeCardAgents
