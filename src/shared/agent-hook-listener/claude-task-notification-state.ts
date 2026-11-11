import { movePaneScopedMapEntries, movePaneScopedSetEntries } from './pane-scoped-cache-entries'
import type { ClaudeTaskTranscriptObservation } from '../claude-task-notification-transcript'
import type { HookListenerState } from './listener-state'

export function createClaudeTaskNotificationState() {
  return {
    observationsByPaneKey: new Map<string, Map<string, ClaudeTaskTranscriptObservation>>(),
    unidentifiedRunningNonAgentTaskPaneKeys: new Set<string>()
  }
}

export type ClaudeTaskNotificationState = ReturnType<typeof createClaudeTaskNotificationState>

export function clearClaudeTaskNotificationPane(state: HookListenerState, paneKey: string): void {
  state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  state.claudeTaskNotificationState.observationsByPaneKey.delete(paneKey)
  state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.delete(paneKey)
}

export function moveClaudeTaskNotificationPane(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): void {
  movePaneScopedSetEntries(state.claudeRunningNonAgentTaskPaneKeys, fromPaneKey, toPaneKey)
  movePaneScopedMapEntries(
    state.claudeTaskNotificationState.observationsByPaneKey,
    fromPaneKey,
    toPaneKey
  )
  movePaneScopedSetEntries(
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys,
    fromPaneKey,
    toPaneKey
  )
}

export function clearAllClaudeTaskNotificationPanes(state: HookListenerState): void {
  state.claudeRunningNonAgentTaskPaneKeys.clear()
  state.claudeTaskNotificationState.observationsByPaneKey.clear()
  state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.clear()
}

export function applyClaudeRemoteTaskEvidence(
  state: HookListenerState,
  paneKey: string,
  hasRunningTask: boolean
): void {
  if (hasRunningTask) {
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.add(paneKey)
  } else {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
  state.claudeTaskNotificationState.observationsByPaneKey.delete(paneKey)
}
