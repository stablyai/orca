import { recomputeOn } from '@/lib/recompute-on'
import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { deriveRunningAgentSendTargets } from '@/lib/agent-session/messaging/running-agent-targets'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { buildAgentRowLineageTree } from '@/components/dashboard/agent-row-lineage-model'
import { translate } from '@/i18n/i18n'
import { agentSendDisabledReasonLabel } from '@/lib/agent-session/messaging/agent-send-disabled-reason-label'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  selectSendTargetControlInputs,
  selectSendTargetInputs
} from './worktree-card-send-target-inputs'
import { useWorktreeAgentActivation } from './use-worktree-agent-activation'
import { useWorktreeAgentDisplay } from './use-worktree-agent-display'
import { useFocusedAgentPaneKey } from './focused-agent-row-highlight'
import { useWorktreeAgentExpansionState } from './worktree-card-agents-expansion-state'
import { activateRetainedAgentRow } from './activate-retained-agent-row'
import { selectAgentRowsUnread } from './worktree-card-agent-ack-inputs'
import { lineageAncestorPaneKeys } from './worktree-card-agent-lineage-disclosure'
import { buildCollapsedChildAgentSignalStates } from './worktree-card-idle-child-agents'

export type AgentSendTarget = {
  status: 'eligible' | 'disabled' | 'sending'
  disabledReason?: string
}

export const SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT =
  'orca-suppress-worktree-list-scroll-adjustment'

export function dispatchSuppressScrollAdjustment(): void {
  window.dispatchEvent(new CustomEvent(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT))
}

/** Everything a worktree card's agent list needs besides presentation: lineage, unread, picking, focus, disclosure. */
export function useWorktreeAgentListModel(worktreeId: string, agents: DashboardAgentRowData[]) {
  const languageRevision = useUiLanguageRevision()
  const { agentActivityDisplayMode, showAgentModels } = useWorktreeAgentDisplay()
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const dismissRetainedAgent = useAppStore((s) => s.dismissRetainedAgent)
  const { targetMode: agentSendPopoverTargetMode, agentStatusEpoch } = useAppStore(
    useShallow((s) => selectSendTargetControlInputs(s, worktreeId))
  )
  const sendTargetInputs = useAppStore(useShallow((s) => selectSendTargetInputs(s, worktreeId)))
  const sendPromptToSidebarAgentTarget = useAppStore((s) => s.sendPromptToSidebarAgentTarget)
  const focusedAgentPaneKey = useFocusedAgentPaneKey(worktreeId)

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
  const sendTargetsByPaneKey = useMemo(
    () =>
      recomputeOn([agentStatusEpoch, languageRevision], () => {
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
      }),
    [
      // Freshness timers advance this epoch without replacing the status map.
      agentStatusEpoch,
      languageRevision,
      agentSendPopoverTargetMode?.sendingPaneKey,
      agentSendPopoverTargetMode?.status,
      isAgentSendTargetModeActive,
      sendTargetInputs,
      worktreeId
    ]
  )

  const handleSendTargetClick = useCallback(
    (paneKey: string) => {
      void sendPromptToSidebarAgentTarget(paneKey)
    },
    [sendPromptToSidebarAgentTarget]
  )

  const handleActivateAgentTab = useWorktreeAgentActivation(worktreeId)
  const handleActivateRetainedAgent = useCallback(
    (tabId: string, paneKey: string) => activateRetainedAgentRow(worktreeId, tabId, paneKey),
    [worktreeId]
  )

  const lineageTree = useMemo(() => buildAgentRowLineageTree(agents), [agents])
  const { rootRows: rootAgents, childrenByParentPaneKey } = lineageTree
  const hasLineage = childrenByParentPaneKey.size > 0
  const collapsedChildAgentSignalStates = useMemo(
    () => buildCollapsedChildAgentSignalStates(childrenByParentPaneKey),
    [childrenByParentPaneKey]
  )
  // Persist disclosure outside component state so virtualizer/sibling-triggered remounts cannot reset it.
  const {
    expandedLineageParents,
    expandedIdleChildGroups,
    compactRootListExpanded,
    toggleLineageParent: toggleLineageParentState,
    toggleIdleChildGroup: toggleIdleChildGroupState,
    toggleCompactRootList
  } = useWorktreeAgentExpansionState(worktreeId)
  const toggleLineageParent = useCallback(
    (paneKey: string) => {
      dispatchSuppressScrollAdjustment()
      toggleLineageParentState(paneKey)
    },
    [toggleLineageParentState]
  )
  const toggleIdleChildGroup = useCallback(
    (parentPaneKey: string) => {
      dispatchSuppressScrollAdjustment()
      toggleIdleChildGroupState(parentPaneKey)
    },
    [toggleIdleChildGroupState]
  )

  const sendTargetFor = (paneKey: string): AgentSendTarget | undefined =>
    isAgentSendTargetModeActive
      ? (sendTargetsByPaneKey.get(paneKey) ?? {
          status: 'disabled' as const,
          disabledReason: translate(
            'auto.components.sidebar.WorktreeCardAgents.agentUnavailable',
            'Agent is not available'
          )
        })
      : undefined
  // Picker rows are the send targets, so every lineage level stays open while picking.
  const isLineageExpanded = (paneKey: string): boolean =>
    isAgentSendTargetModeActive || expandedLineageParents.has(paneKey)
  const focusedAncestorPaneKeys = useMemo(
    () => lineageAncestorPaneKeys(childrenByParentPaneKey, focusedAgentPaneKey),
    [childrenByParentPaneKey, focusedAgentPaneKey]
  )
  // A collapsed parent stands in for its hidden focused descendant.
  const isFocusedOrHidesFocus = (paneKey: string, expanded: boolean): boolean =>
    paneKey === focusedAgentPaneKey || (!expanded && focusedAncestorPaneKeys.has(paneKey))

  return {
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
  }
}

export type WorktreeAgentListModel = ReturnType<typeof useWorktreeAgentListModel>
