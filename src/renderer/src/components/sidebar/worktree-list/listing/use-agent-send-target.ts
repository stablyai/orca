import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { selectStatusByRevision } from '@/store/slices/agent-status/status-ownership/agent-status-revisions'
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { AppState } from '@/store/types'
import { deriveRunningAgentSendTargets } from '@/lib/agent-session/messaging/running-agent-targets'
import { recomputeOn } from '@/lib/recompute-on'
import { selectSendApprovalGuardEnvironmentIds } from '@/runtime/hosts/capabilities/send-approval-guard-hosts'

// Why: selectors that opt out of a slice must return one stable reference, or every store tick looks like a change.
const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = acceptedAgentStatuses()
const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_UNIFIED_TABS_BY_WORKTREE: AppState['unifiedTabsByWorktree'] = {}
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: AppState['terminalLayoutsByTabId'] = {}
const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
const EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID: AppState['runtimePaneTitlesByTabId'] = {}
const NO_GUARDED_HOSTS: ReadonlySet<string> = new Set()

// Force the picker’s target workspace visible only while a running agent there can receive the message.
export function useAgentSendTargetWorktreeId(): string | null {
  const agentSendPopoverTargetMode = useAppStore((s) => s.agentSendPopoverTargetMode)
  const selectActivity = useMemo(
    () =>
      agentSendPopoverTargetMode
        ? selectStatusByRevision('activityDetailsRevision')
        : () => EMPTY_AGENT_STATUS_BY_PANE_KEY,
    [agentSendPopoverTargetMode]
  )
  // Why: eligibility only matters while the picker is open; when closed, don't subscribe to wake-time layout churn.
  const agentTargetStatusByPaneKey = useAppStore(selectActivity)
  const agentTargetStatusEpoch = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.agentStatusEpoch : 0
  )
  const agentTargetTabsByWorktree = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.tabsByWorktree : EMPTY_TABS_BY_WORKTREE
  )
  const agentTargetUnifiedTabsByWorktree = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.unifiedTabsByWorktree : EMPTY_UNIFIED_TABS_BY_WORKTREE
  )
  const agentTargetTerminalLayoutsByTabId = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.terminalLayoutsByTabId : EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID
  )
  const agentTargetPtyIdsByTabId = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.ptyIdsByTabId : EMPTY_PTY_IDS_BY_TAB_ID
  )
  const agentTargetRuntimePaneTitlesByTabId = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.runtimePaneTitlesByTabId : EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID
  )
  const agentTargetGuardedHosts = useAppStoreWithHostStatuses((_s, statuses) =>
    agentSendPopoverTargetMode ? selectSendApprovalGuardEnvironmentIds(statuses) : NO_GUARDED_HOSTS
  )
  return useMemo(
    () =>
      recomputeOn([agentTargetStatusEpoch], () => {
        if (!agentSendPopoverTargetMode) {
          return null
        }
        const targets = deriveRunningAgentSendTargets(
          {
            agentStatusByPaneKey: agentTargetStatusByPaneKey,
            tabsByWorktree: agentTargetTabsByWorktree,
            unifiedTabsByWorktree: agentTargetUnifiedTabsByWorktree,
            terminalLayoutsByTabId: agentTargetTerminalLayoutsByTabId,
            ptyIdsByTabId: agentTargetPtyIdsByTabId,
            runtimePaneTitlesByTabId: agentTargetRuntimePaneTitlesByTabId,
            sendApprovalGuardEnvironmentIds: agentTargetGuardedHosts
          },
          agentSendPopoverTargetMode.worktreeId
        )
        return targets.some((target) => target.status === 'eligible')
          ? agentSendPopoverTargetMode.worktreeId
          : null
      }),
    [
      // Why: eligibility can flip when the stale-boundary scheduler bumps this epoch without replacing the status map.
      agentTargetStatusEpoch,
      agentSendPopoverTargetMode,
      agentTargetStatusByPaneKey,
      agentTargetTabsByWorktree,
      agentTargetUnifiedTabsByWorktree,
      agentTargetTerminalLayoutsByTabId,
      agentTargetPtyIdsByTabId,
      agentTargetRuntimePaneTitlesByTabId,
      agentTargetGuardedHosts
    ]
  )
}
