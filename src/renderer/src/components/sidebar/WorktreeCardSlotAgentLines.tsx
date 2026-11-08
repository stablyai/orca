import React, { useCallback } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { translate } from '@/i18n/i18n'
import { viewClaudeAgentFromRow } from '@/lib/agent-session/navigation/claude-agent-row-view'
import { useWorktreeAgentListModel } from './workspace-card/activity/use-worktree-agent-list-model'
import { ChildAgentsWithIdleGroup } from './workspace-card/activity/worktree-card-idle-child-agents'
import type { SlotAgentSignals } from './worktree-card-slot-agent-signals'
import { SlotAgentLineRow } from './worktree-card-slot-agent-line-row'

function stopPropagation(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

/** Experimental 2.0 agent lines: lead agents, their subagents on demand, and the shared picking/unread/focus model. */
export function WorktreeCardSlotAgentLines({
  worktreeId,
  agents,
  signals,
  now,
  offline,
  cacheTimersActive
}: {
  worktreeId: string
  agents: DashboardAgentRow[]
  signals: SlotAgentSignals
  now: number
  offline: boolean
  /** False while the list is folded away, so hidden rows don't run countdowns. */
  cacheTimersActive: boolean
}): React.JSX.Element | null {
  const model = useWorktreeAgentListModel(worktreeId, agents)
  const {
    showAgentModels,
    isAgentSendTargetModeActive,
    sendTargetFor,
    handleSendTargetClick,
    handleActivateAgentTab,
    handleActivateRetainedAgent,
    handleDismissAgent,
    hasLineage,
    expandedIdleChildGroups,
    toggleLineageParent,
    toggleIdleChildGroup,
    isLineageExpanded,
    isFocusedOrHidesFocus
  } = model
  const handleActivate = useCallback(
    (agent: DashboardAgentRow) => {
      // Subagents have no pane of their own; they open their spawning parent.
      const paneKey = agent.activationPaneKey ?? agent.paneKey
      if (agent.rowSource === 'retained') {
        handleActivateRetainedAgent(agent.tab.id, paneKey)
      } else {
        handleActivateAgentTab(agent.tab.id, paneKey)
      }
      void viewClaudeAgentFromRow(agent)
    },
    [handleActivateAgentTab, handleActivateRetainedAgent]
  )

  const renderBranch = (
    agent: DashboardAgentRow,
    ancestors: ReadonlySet<string>,
    timersActive: boolean
  ): React.ReactNode => {
    const line = signals.lineByPaneKey.get(agent.paneKey)
    // External lineage metadata may cycle; reject repeated ancestors before recursion.
    if (!line || ancestors.has(agent.paneKey)) {
      return null
    }
    const childAgents = signals.childrenByParentPaneKey.get(agent.paneKey) ?? []
    const hasChildren = childAgents.length > 0
    const expanded = hasChildren && isLineageExpanded(agent.paneKey)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(agent.paneKey)
    const depth = agent.lineage?.depth ?? 0
    return (
      <React.Fragment key={agent.paneKey}>
        <SlotAgentLineRow
          line={line}
          displaySignal={
            hasChildren && !expanded
              ? (signals.rolledByPaneKey.get(agent.paneKey) ?? line.signal)
              : line.signal
          }
          now={now}
          offline={offline}
          focused={isFocusedOrHidesFocus(agent.paneKey, !hasChildren || expanded)}
          showModel={showAgentModels}
          cacheTimerActive={timersActive}
          treeLevel={hasLineage ? depth + 1 : undefined}
          childCount={hasChildren ? childAgents.length : undefined}
          childrenExpanded={expanded}
          // Picking forces every level open, so a toggle would silently flip stored state.
          onToggleChildren={
            hasChildren && !isAgentSendTargetModeActive
              ? () => toggleLineageParent(agent.paneKey)
              : undefined
          }
          sendTarget={sendTargetFor(agent.paneKey)}
          onSendTarget={handleSendTargetClick}
          onActivate={handleActivate}
          // Subagents have no dismissible store entry, and picking reuses the slot.
          onDismiss={
            agent.rowSource === 'subagent' || isAgentSendTargetModeActive
              ? undefined
              : handleDismissAgent
          }
        />
        {expanded ? (
          <div
            role="group"
            className="ml-2.5 flex flex-col gap-0.5 border-l border-worktree-sidebar-border/70 pl-2"
          >
            <ChildAgentsWithIdleGroup
              childAgents={childAgents}
              // Picking shows every child flat; folding would hide send targets.
              flat={isAgentSendTargetModeActive}
              idleExpanded={expandedIdleChildGroups.has(agent.paneKey)}
              onToggleIdle={() => toggleIdleChildGroup(agent.paneKey)}
              layout="slot"
              ariaLevel={depth + 2}
              renderChild={(child, idleGroupExpanded) =>
                renderBranch(child, nextAncestors, timersActive && idleGroupExpanded)
              }
            />
          </div>
        ) : null}
      </React.Fragment>
    )
  }

  if (signals.rootLines.length === 0) {
    return null
  }
  return (
    <div
      className="mt-1 flex flex-col gap-1 pl-[var(--worktree-card-text-inset,24px)]"
      role={hasLineage ? 'tree' : 'group'}
      aria-label={translate('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
      onDoubleClick={stopPropagation}
      onMouseDown={stopPropagation}
      onPointerDown={stopPropagation}
    >
      {signals.rootLines.map((line) => renderBranch(line.agent, new Set(), cacheTimersActive))}
    </div>
  )
}
