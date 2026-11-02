import type { HookListenerState } from './listener-state'

/** Keep claim-bearing caches aligned with clearPaneCacheState: stored rows and latches can assert state; prompt/tool/transcript caches only render it. */
export function paneHasStateClaims(state: HookListenerState, paneKey: string): boolean {
  return (
    state.lastStatusByPaneKey.has(paneKey) ||
    state.claudeSubagentRosterByPaneKey.has(paneKey) ||
    state.claudeLeadStateByPaneKey.has(paneKey) ||
    state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
    state.claudeActiveSessionCronPaneKeys.has(paneKey) ||
    state.claudeLaunchedBackgroundTasksByPaneKey.has(paneKey) ||
    state.claudeSessionOwnerByPaneKey.has(paneKey) ||
    state.codexSubagentRosterByPaneKey.has(paneKey) ||
    state.codexLeadStateByPaneKey.has(paneKey)
  )
}
