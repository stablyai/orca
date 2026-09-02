import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { deriveRunningAgentSendTargets } from '@/lib/running-agent-targets'

// Why: selectors that opt out of a slice must return one stable reference, or every store tick looks like a change.
const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = {}
const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: AppState['terminalLayoutsByTabId'] = {}
const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
const EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID: AppState['runtimePaneTitlesByTabId'] = {}

// The agent send picker forces its target workspace visible, but only while a running
// agent there can actually receive the message.
export function useAgentSendTargetWorktreeId(): string | null {
  const agentSendPopoverTargetMode = useAppStore((s) => s.agentSendPopoverTargetMode)
  // Why: eligibility only matters while the picker is open; when closed, don't subscribe to wake-time layout churn.
  const agentTargetStatusByPaneKey = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.agentStatusByPaneKey : EMPTY_AGENT_STATUS_BY_PANE_KEY
  )
  const agentTargetStatusEpoch = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.agentStatusEpoch : 0
  )
  const agentTargetTabsByWorktree = useAppStore((s) =>
    agentSendPopoverTargetMode ? s.tabsByWorktree : EMPTY_TABS_BY_WORKTREE
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
  return useMemo(() => {
    void agentTargetStatusEpoch
    if (!agentSendPopoverTargetMode) {
      return null
    }
    const targets = deriveRunningAgentSendTargets(
      {
        agentStatusByPaneKey: agentTargetStatusByPaneKey,
        tabsByWorktree: agentTargetTabsByWorktree,
        terminalLayoutsByTabId: agentTargetTerminalLayoutsByTabId,
        ptyIdsByTabId: agentTargetPtyIdsByTabId,
        runtimePaneTitlesByTabId: agentTargetRuntimePaneTitlesByTabId
      },
      agentSendPopoverTargetMode.worktreeId
    )
    return targets.some((target) => target.status === 'eligible')
      ? agentSendPopoverTargetMode.worktreeId
      : null
  }, [
    // Why: eligibility can flip when the stale-boundary scheduler bumps this epoch without replacing the status map.
    agentTargetStatusEpoch,
    agentSendPopoverTargetMode,
    agentTargetStatusByPaneKey,
    agentTargetTabsByWorktree,
    agentTargetTerminalLayoutsByTabId,
    agentTargetPtyIdsByTabId,
    agentTargetRuntimePaneTitlesByTabId
  ])
}
