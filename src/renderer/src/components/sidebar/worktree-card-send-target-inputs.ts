import type { AppState } from '@/store/types'
import type { RunningAgentTargetState } from '@/lib/running-agent-targets'

export type SendTargetInputsState = Pick<
  AppState,
  | 'agentSendPopoverTargetMode'
  | 'agentStatusByPaneKey'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
>

export type SendTargetControlInputsState = Pick<
  AppState,
  'agentSendPopoverTargetMode' | 'agentStatusEpoch'
>

export type SendTargetControlInputs = {
  targetMode: AppState['agentSendPopoverTargetMode']
  agentStatusEpoch: number
}

// Share an inactive-card sentinel so pane-title/status churn cannot wake every idle agent body.
export const EMPTY_SEND_TARGET_INPUTS: RunningAgentTargetState = Object.freeze({
  agentStatusByPaneKey: {},
  tabsByWorktree: {},
  unifiedTabsByWorktree: {},
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {}
})

// Inactive cards ignore picker-mode and freshness-epoch changes.
export const EMPTY_SEND_TARGET_CONTROL_INPUTS: SendTargetControlInputs = Object.freeze({
  targetMode: null,
  agentStatusEpoch: 0
})

/** Select live send-target maps only for the targeted card; all others reuse the empty sentinel. */
export function selectSendTargetInputs(
  s: SendTargetInputsState,
  worktreeId: string
): RunningAgentTargetState {
  if (s.agentSendPopoverTargetMode?.worktreeId !== worktreeId) {
    return EMPTY_SEND_TARGET_INPUTS
  }
  return {
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    tabsByWorktree: s.tabsByWorktree,
    unifiedTabsByWorktree: s.unifiedTabsByWorktree,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    ptyIdsByTabId: s.ptyIdsByTabId,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId
  }
}

export function selectSendTargetControlInputs(
  s: SendTargetControlInputsState,
  worktreeId: string
): SendTargetControlInputs {
  const targetMode = s.agentSendPopoverTargetMode
  if (targetMode?.worktreeId !== worktreeId) {
    return EMPTY_SEND_TARGET_CONTROL_INPUTS
  }
  return { targetMode, agentStatusEpoch: s.agentStatusEpoch }
}
