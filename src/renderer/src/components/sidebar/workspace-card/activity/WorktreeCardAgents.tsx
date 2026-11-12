import type { BranchContext } from './worktree-agent-branch-context'
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { useNow } from '@/hooks/use-now'
import { deriveRunningAgentSendTargets } from '@/lib/agent-session/messaging/running-agent-targets'
import {
  selectSendTargetControlInputs,
  selectSendTargetInputs
} from './worktree-card-send-target-inputs'
import { useAgentPresentation, useWorktreeAgentRow } from './useWorktreeAgentRows'
import { useWorktreeAgentDisplay } from './use-worktree-agent-display'
import { cn } from '@/lib/class-names'
import { recomputeOn } from '@/lib/recompute-on'
import { useFocusedAgentPaneKey } from './focused-agent-row-highlight'
import { CompactAgentExpansion, CompactAgentSummaryButton } from './worktree-card-compact-agents'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import { revealCompactAgentCard } from '../../worktree-list/navigation/worktree-sidebar-reveal'
import { useWorktreeAgentExpansionState } from './worktree-card-agents-expansion-state'
import { useTranslate } from '@/i18n/use-translate'
import { agentSendDisabledReasonLabel } from '@/lib/agent-session/messaging/agent-send-disabled-reason-label'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useWorktreeAgentActivation } from './use-worktree-agent-activation'
import { opensClaudeParentConversation } from '@/lib/agent-session/navigation/claude-agent-row-view'
import { IdleChildAgentGroupRow } from './worktree-card-idle-child-agents'
import type { AgentChildren } from '@/store/slices/agent-status/agent-row-display-index'
import type { DashboardAgentRow as AgentRow } from '@/components/dashboard/useDashboardData'

export const SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT =
  'orca-suppress-worktree-list-scroll-adjustment'
const suppressScrollAdjustment = () =>
  window.dispatchEvent(new CustomEvent(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT))
const stopBubble = (event: React.SyntheticEvent) => event.stopPropagation()
type Props = { worktreeId: string; className?: string }

export default React.memo(function WorktreeCardAgents({ worktreeId, className }: Props) {
  const roots = useAgentPresentation(
    `roots\0${worktreeId}`,
    useCallback((p) => p.display.roots(worktreeId), [worktreeId])
  )
  return roots.length ? (
    <WorktreeCardAgentsBody worktreeId={worktreeId} roots={roots} className={className} />
  ) : null
})

function WorktreeCardAgentsBody({
  worktreeId,
  roots,
  className
}: Props & { roots: readonly string[] }) {
  const t = useTranslate(),
    languageRevision = useUiLanguageRevision()
  const display = useWorktreeAgentDisplay()
  const expansion = useWorktreeAgentExpansionState(worktreeId)
  const focusedPaneKey = useFocusedAgentPaneKey(worktreeId)
  const onActivate = useWorktreeAgentActivation(worktreeId)
  const onDismiss = useAppStore((s) => s.dropAgentStatus)
  const send = useAppStore((s) => s.sendPromptToSidebarAgentTarget)
  const control = useAppStore(useShallow((s) => selectSendTargetControlInputs(s, worktreeId)))
  const inputs = useAppStore(useShallow((s) => selectSendTargetInputs(s, worktreeId)))
  const targets = useMemo(
    () =>
      recomputeOn([languageRevision], () => {
        if (!control.targetMode) {
          return null
        }
        return new Map(
          deriveRunningAgentSendTargets(inputs, worktreeId).map((target) => [
            target.paneKey,
            control.targetMode?.status === 'sending' &&
            control.targetMode.sendingPaneKey === target.paneKey
              ? {
                  status: 'sending' as const,
                  disabledReason: t(
                    'auto.components.sidebar.WorktreeCardAgents.sendingTarget',
                    'Sending...'
                  )
                }
              : {
                  status: target.status,
                  ...(target.disabledReason
                    ? { disabledReason: agentSendDisabledReasonLabel(target.disabledReason) }
                    : {})
                }
          ])
        )
      }),
    [control, inputs, worktreeId, t, languageRevision]
  )
  const onSend = useCallback(
    (key: string) => {
      void send(key)
    },
    [send]
  )
  const { toggleLineageParent, toggleIdleChildGroup } = expansion
  const toggleLineage = useCallback(
    (key: string) => {
      suppressScrollAdjustment()
      toggleLineageParent(key)
    },
    [toggleLineageParent]
  )
  const toggleIdle = useCallback(
    (key: string) => {
      suppressScrollAdjustment()
      toggleIdleChildGroup(key)
    },
    [toggleIdleChildGroup]
  )
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
      suppressScrollAdjustment()
      const handle = requestAnimationFrame(() => revealCompactAgentCard(rootRef.current))
      return () => cancelAnimationFrame(handle)
    }
    return undefined
  }, [compact, expansion.compactRootListExpanded])
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
            count={roots.length}
            expanded={expansion.compactRootListExpanded}
            onToggle={expansion.toggleCompactRootList}
          />
          <CompactAgentExpansion expanded={expansion.compactRootListExpanded}>
            <AgentBranches
              keysToRender={roots}
              context={context}
              timerActive={expansion.compactRootListExpanded}
            />
          </CompactAgentExpansion>
        </div>
      ) : (
        <AgentBranches keysToRender={roots} context={context} timerActive />
      )}
    </div>
  )
}
const AgentBranches = React.memo(function AgentBranches({
  keysToRender,
  context,
  timerActive
}: {
  keysToRender: readonly string[]
  context: BranchContext
  timerActive: boolean
}) {
  return (
    <>
      {keysToRender.map((key) => (
        <AgentBranch key={key} paneKey={key} context={context} timerActive={timerActive} />
      ))}
    </>
  )
})
function KeyedSummary({
  worktreeId,
  count,
  expanded,
  onToggle
}: {
  worktreeId: string
  count: number
  expanded: boolean
  onToggle: () => void
}) {
  const t = useTranslate()
  const groups = useAgentPresentation(
    `groups\0${worktreeId}`,
    useCallback((p) => p.display.summary(worktreeId), [worktreeId])
  )
  return (
    <CompactAgentSummaryButton
      groups={groups}
      subjectLabel={t('sidebar.agentSummary.agentCount', '{{count}} agents', {
        count,
        defaultValue_one: '{{count}} agent'
      })}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
}
const AgentBranch = React.memo(function AgentBranch({
  paneKey,
  context,
  timerActive
}: {
  paneKey: string
  context: BranchContext
  timerActive: boolean
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
    isUnvisited: row.rowSource === 'live' && acknowledgedAt < row.entry.stateStartedAt,
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
    <div className={compact ? 'min-w-0' : undefined}>
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
