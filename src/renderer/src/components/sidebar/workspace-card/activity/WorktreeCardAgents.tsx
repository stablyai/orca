import type { BranchContext } from './worktree-agent-branch-context'
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store/index'
import { agentAttentionTurnAt } from '@/attention/agent-attention-acknowledgement'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useNow } from '@/lib/window-activity/use-now'
import { useAgentPresentation, useWorktreeAgentRow } from './useWorktreeAgentRows'
import { useHostRootKeys } from './use-worktree-agent-host-roots'
import { KeyedSummary, CompactHeaderAgentList } from './worktree-card-agent-keyed-summary'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { useWorktreeAgentDisplay } from './use-worktree-agent-display'
import { cn } from '@/lib/class-names'
import { useFocusedAgentPaneKey } from './focused-agent-row-highlight'
import { CompactAgentExpansion } from './worktree-card-compact-agents'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import { revealCompactAgentCard } from '../../worktree-list/navigation/worktree-sidebar-reveal'
import { useWorktreeAgentExpansionState } from './worktree-card-agents-expansion-state'
import { useTranslate } from '@/i18n/use-translate'
import { useWorktreeAgentSendTargets } from './use-worktree-agent-send-targets'
import { useWorktreeAgentActivation } from './use-worktree-agent-activation'
import { opensClaudeParentConversation } from '@/lib/agent-session/navigation/claude-agent-row-view'
import { IdleChildAgentGroupRow } from './worktree-card-idle-child-agents'
import type { AgentChildren } from '@/store/slices/agent-status/projection/agent-row-display-model'
import type { DashboardAgentRow as AgentRow } from '@/components/dashboard/rows/dashboard-agent-row'

const stopBubble = (event: React.SyntheticEvent) => event.stopPropagation()
type Props = {
  worktreeId: string
  /** The card's host; local and remote copies can share a workspace ID, so activation must name it. */
  executionHostId?: ExecutionHostId
  className?: string
  renderHeader?: (summary: React.ReactNode) => React.ReactElement
}

export default React.memo(function WorktreeCardAgents({
  worktreeId,
  executionHostId,
  className,
  renderHeader
}: Props) {
  const allRoots = useAgentPresentation(
    `roots\0${worktreeId}`,
    useCallback((p) => p.display.roots(worktreeId), [worktreeId])
  )
  const roots = useHostRootKeys(worktreeId, executionHostId, allRoots)
  return roots.length ? (
    <WorktreeCardAgentsBody
      worktreeId={worktreeId}
      executionHostId={executionHostId}
      roots={roots}
      hostFiltered={roots !== allRoots}
      className={className}
      renderHeader={renderHeader}
    />
  ) : (
    (renderHeader?.(null) ?? null)
  )
})

function WorktreeCardAgentsBody({
  worktreeId,
  executionHostId,
  roots,
  hostFiltered,
  className,
  renderHeader
}: Props & { roots: readonly string[]; hostFiltered: boolean }) {
  const t = useTranslate()
  const display = useWorktreeAgentDisplay()
  const expansion = useWorktreeAgentExpansionState(worktreeId, executionHostId)
  const focusedPaneKey = useFocusedAgentPaneKey(worktreeId)
  const onActivate = useWorktreeAgentActivation(worktreeId, executionHostId)
  const onDismiss = useAppStore((s) => s.dropAgentStatus)
  const send = useAppStore((s) => s.sendPromptToSidebarAgentTarget)
  const targets = useWorktreeAgentSendTargets(worktreeId)
  const onSend = useCallback((key: string) => void send(key), [send])
  const { toggleLineageParent: toggleLineage, toggleIdleChildGroup: toggleIdle } = expansion
  const now = useNow(30_000)
  const context = useMemo(
    () => ({
      worktreeId,
      agentActivityDisplayMode: display.agentActivityDisplayMode,
      showAgentModels: display.showAgentModels,
      expansion,
      focusedPaneKey,
      onActivate,
      onDismiss,
      targets,
      onSend,
      toggleLineage,
      toggleIdle,
      now
    }),
    [
      worktreeId,
      display.agentActivityDisplayMode,
      display.showAgentModels,
      expansion,
      focusedPaneKey,
      onActivate,
      onDismiss,
      targets,
      onSend,
      toggleLineage,
      toggleIdle,
      now
    ]
  )
  const compact = display.agentActivityDisplayMode === 'compact',
    summary = compact && roots.length > 1 && !targets
  const rootRef = useRef<HTMLDivElement | null>(null),
    previousExpanded = useRef(expansion.compactRootListExpanded)
  useLayoutEffect(() => {
    const wasExpanded = previousExpanded.current
    previousExpanded.current = expansion.compactRootListExpanded
    if (!wasExpanded && expansion.compactRootListExpanded && compact) {
      // Defer reveal one frame to avoid synchronous sidebar layout during the opening animation.
      const handle = requestAnimationFrame(() => revealCompactAgentCard(rootRef.current))
      return () => cancelAnimationFrame(handle)
    }
    return undefined
  }, [compact, expansion.compactRootListExpanded])
  if (renderHeader) {
    const open = expansion.compactRootListExpanded || Boolean(targets)
    return (
      <CompactHeaderAgentList
        {...{ worktreeId, roots, hostFiltered, className, renderHeader }}
        expanded={open}
        onToggle={expansion.toggleCompactRootList}
        rootRef={rootRef}
      >
        <AgentBranches keysToRender={roots} context={context} timerActive={open} root />
      </CompactHeaderAgentList>
    )
  }

  return (
    <div
      ref={rootRef}
      className={cn(compact ? 'flex flex-col mt-1 gap-0.5' : 'flex flex-col mt-1', className)}
      onClick={stopBubble}
      onDoubleClick={stopBubble}
      onMouseDown={stopBubble}
      onPointerDown={stopBubble}
      role="tree"
      aria-label={t('auto.components.sidebar.WorktreeCardAgents.1b0a156717', 'Agents')}
      data-compact-agent-list={compact || undefined}
    >
      {summary ? (
        <div
          className={cn(
            'compact-agent-summary-panel',
            expansion.compactRootListExpanded && 'compact-agent-summary-panel-expanded'
          )}
        >
          <KeyedSummary
            worktreeId={worktreeId}
            roots={roots}
            hostFiltered={hostFiltered}
            expanded={expansion.compactRootListExpanded}
            onToggle={expansion.toggleCompactRootList}
          />
          <CompactAgentExpansion expanded={expansion.compactRootListExpanded}>
            <AgentBranches
              keysToRender={roots}
              context={context}
              timerActive={expansion.compactRootListExpanded}
              root
            />
          </CompactAgentExpansion>
        </div>
      ) : (
        <AgentBranches keysToRender={roots} context={context} timerActive root />
      )}
    </div>
  )
}
const AgentBranches = React.memo(function AgentBranches({
  keysToRender,
  context,
  timerActive,
  root = false
}: {
  keysToRender: readonly string[]
  context: BranchContext
  timerActive: boolean
  root?: boolean
}) {
  return (
    <>
      {keysToRender.map((key) => (
        <AgentBranch
          key={key}
          paneKey={key}
          context={context}
          timerActive={timerActive}
          root={root}
        />
      ))}
    </>
  )
})
const AgentBranch = React.memo(function AgentBranch({
  paneKey,
  context,
  timerActive,
  root
}: {
  paneKey: string
  context: BranchContext
  timerActive: boolean
  root: boolean
}) {
  const row = useWorktreeAgentRow(paneKey)
  const children = useAgentPresentation(
    `children\0${paneKey}`,
    useCallback((p) => p.display.children(paneKey), [paneKey])
  )
  const focusedDescendant = useAgentPresentation(
    `children\0${paneKey}`,
    useCallback(
      (p) => {
        const seen = new Set<string>()
        for (
          let key = context.focusedPaneKey;
          key && !seen.has(key);
          key = p.row(key)?.lineage?.parentPaneKey ?? null
        ) {
          if (key === paneKey) {
            return true
          }
          seen.add(key)
        }
        return false
      },
      [context.focusedPaneKey, paneKey]
    )
  )
  const acknowledgedAt = useAppStore((s) => s.acknowledgedAgentsByPaneKey[paneKey] ?? 0)
  const t = useTranslate()
  if (!row) {
    return null
  }
  const compact = context.agentActivityDisplayMode === 'compact',
    expanded = Boolean(context.targets) || context.expansion.expandedLineageParents.has(paneKey)
  const hasChildren = children.keys.length > 0,
    idleExpanded = context.expansion.expandedIdleChildGroups.has(paneKey)
  const target = context.targets
    ? (context.targets.get(paneKey) ?? {
        status: 'disabled' as const,
        disabledReason: t(
          'auto.components.sidebar.WorktreeCardAgents.agentUnavailable',
          'Agent is not available'
        )
      })
    : undefined
  const common = {
    agent: row,
    showModel: context.showAgentModels,
    now: context.now,
    isUnvisited: row.rowSource === 'live' && acknowledgedAt < agentAttentionTurnAt(row.entry),
    onActivate: context.onActivate,
    childAgentCount: hasChildren ? children.keys.length : undefined,
    childAgentsExpanded: expanded,
    collapsedChildAgentsState: hasChildren && !expanded ? children.signal : undefined,
    onToggleChildAgents:
      hasChildren && !context.targets ? () => context.toggleLineage(paneKey) : undefined,
    isFocusedPane: paneKey === context.focusedPaneKey || (!expanded && focusedDescendant),
    sendTargetStatus: target?.status,
    sendTargetDisabledReason: target?.disabledReason,
    onSendTargetClick: context.targets ? context.onSend : undefined
  }
  const childList = (
    <AgentBranchChildren
      row={row}
      childState={children}
      context={context}
      timerActive={timerActive && expanded}
      idleExpanded={idleExpanded}
    />
  )
  return (
    <div className={compact ? cn('min-w-0', root && 'ms-2') : undefined}>
      {compact ? (
        <CompactAgentRow
          {...common}
          parentConversationDescription={
            opensClaudeParentConversation(row)
              ? t('auto.lib.claudeAgentRowView.openParentConversation', 'Open parent conversation')
              : undefined
          }
          cacheTimerActive={timerActive}
        />
      ) : (
        <DashboardAgentRow
          {...common}
          onDismiss={context.onDismiss}
          stateDotSize="sm"
          hideExpand
          hideLineageConnectors
        />
      )}
      {hasChildren ? (
        compact ? (
          <CompactAgentExpansion expanded={expanded}>
            <div className="worktree-agent-lineage-children flex flex-col gap-0.5">{childList}</div>
          </CompactAgentExpansion>
        ) : expanded ? (
          <div className="worktree-agent-lineage-children">{childList}</div>
        ) : null
      ) : null}
    </div>
  )
})
const AgentBranchChildren = React.memo(
  function AgentBranchChildren({
    row,
    childState: children,
    context,
    timerActive,
    idleExpanded
  }: {
    row: AgentRow
    childState: AgentChildren
    context: BranchContext
    timerActive: boolean
    idleExpanded: boolean
  }) {
    const compact = context.agentActivityDisplayMode === 'compact',
      active = context.targets ? children.keys : children.active,
      idle = context.targets ? [] : children.idle
    return (
      <>
        <AgentBranches keysToRender={active} context={context} timerActive={timerActive} />
        {idle.length > 0 ? (
          <>
            <IdleChildAgentGroupRow
              count={idle.length}
              expanded={idleExpanded}
              onToggle={() => context.toggleIdle(row.paneKey)}
              layout={compact ? 'compact' : 'full'}
              ariaLevel={(row.lineage?.depth ?? 0) + 2}
            />
            {compact ? (
              <CompactAgentExpansion expanded={idleExpanded}>
                <AgentBranches
                  keysToRender={idle}
                  context={context}
                  timerActive={timerActive && idleExpanded}
                />
              </CompactAgentExpansion>
            ) : idleExpanded ? (
              <AgentBranches keysToRender={idle} context={context} timerActive={timerActive} />
            ) : null}
          </>
        ) : null}
      </>
    )
  },
  (before, after) =>
    before.row.paneKey === after.row.paneKey &&
    before.row.lineage === after.row.lineage &&
    before.childState === after.childState &&
    before.context === after.context &&
    before.timerActive === after.timerActive &&
    before.idleExpanded === after.idleExpanded
)
