import type { AppState } from '@/store/types'
import type { RunningAgentTargetState } from '@/lib/running-agent-targets'

export type SendTargetInputsState = Pick<
  AppState,
  | 'agentSendPopoverTargetMode'
  | 'agentStatusByPaneKey'
  | 'tabsByWorktree'
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

// Why: shared stable reference returned whenever the send-target popover isn't
// targeting this card. useShallow keeps the same result across unrelated
// pane-title / agent-status churn, so idle agent bodies stop re-rendering.
// Frozen so this shared singleton can never be mutated by a consumer.
export const EMPTY_SEND_TARGET_INPUTS: RunningAgentTargetState = Object.freeze({
  agentStatusByPaneKey: {},
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {}
})

// Why: the picker mode and freshness epoch are irrelevant to every card except
// its current target. Keep inactive bodies stable across both global writes.
export const EMPTY_SEND_TARGET_CONTROL_INPUTS: SendTargetControlInputs = Object.freeze({
  targetMode: null,
  agentStatusEpoch: 0
})

/**
 * Select the five maps `deriveRunningAgentSendTargets` needs — but only while
 * the send-target popover targets this worktree. When it doesn't, return a
 * stable empty constant so a useShallow-wrapped subscription stays referentially
 * equal across the (very hot) pane-title / agent-status writes and skips the
 * re-render that would otherwise fire on every mounted agent body app-wide.
 */
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
