import type { readClaudeBackgroundAgentTasks } from '../../claude-background-task-inventory'
import { foldClaudeBackgroundTasksIntoRoster } from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import {
  getOrCreateClaudeSubagentRoster,
  updateClaudeRunningNonAgentTask
} from './claude-roster-state'
import {
  reconcileClaudeIdlePromptTasks,
  recordClaudeStopTranscriptObservations
} from './claude-task-notification-reconciliation'
import type { ClaudeTaskNotificationTranscriptEvidence } from '../../claude-task-notification-transcript'

type ClaudeBackgroundTaskInventory = ReturnType<typeof readClaudeBackgroundAgentTasks>

export function readClaudeTurnBoundaryEvidence(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  eventAgentId: unknown,
  hookPayload: Record<string, unknown>,
  transcriptEvidence: ClaudeTaskNotificationTranscriptEvidence | undefined
): { isTurnBoundary: boolean; reconciledIdlePrompt: boolean } {
  const isTurnBoundary = eventName === 'Stop' || eventName === 'StopFailure'
  const reconciledIdlePrompt =
    eventName === 'Notification' &&
    eventAgentId === undefined &&
    hookPayload['notification_type'] === 'idle_prompt'
      ? reconcileClaudeIdlePromptTasks(state, paneKey, hookPayload, transcriptEvidence?.current)
      : false
  return { isTurnBoundary, reconciledIdlePrompt }
}

export function recordClaudeStopTaskInventory(
  state: HookListenerState,
  paneKey: string,
  inventory: ClaudeBackgroundTaskInventory,
  isLeadTurnBoundary: boolean,
  transcriptEvidence: ClaudeTaskNotificationTranscriptEvidence | undefined
): void {
  if (!isLeadTurnBoundary || !inventory.present) {
    return
  }
  // Teammate rows can report running while idle, so retain only trustworthy background inventory evidence.
  foldClaudeBackgroundTasksIntoRoster(
    getOrCreateClaudeSubagentRoster(state, paneKey),
    inventory.tasks,
    Date.now(),
    { inventoryComplete: !inventory.truncated }
  )
  recordClaudeStopTranscriptObservations(
    state,
    paneKey,
    inventory.tasks,
    inventory.runningNonAgentTaskIds,
    inventory.hasUnidentifiedRunningNonAgentTask,
    !inventory.truncated,
    transcriptEvidence?.position
  )
}

export function updateClaudeUnidentifiedRunningTaskEvidence(
  state: HookListenerState,
  paneKey: string,
  inventory: Pick<ClaudeBackgroundTaskInventory, 'hasUnidentifiedRunningNonAgentTask' | 'truncated'>
): void {
  if (inventory.hasUnidentifiedRunningNonAgentTask) {
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.add(paneKey)
  } else if (!inventory.truncated) {
    state.claudeTaskNotificationState.unidentifiedRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
}

export function updateClaudeBackgroundStatus(
  state: HookListenerState,
  paneKey: string,
  inventory: ClaudeBackgroundTaskInventory,
  sessionCrons: unknown,
  eventAgentId: unknown,
  isTurnBoundary: boolean
): void {
  if (inventory.present && eventAgentId === undefined) {
    updateClaudeRunningNonAgentTask(state, paneKey, inventory.hasRunningNonAgentTask)
    updateClaudeUnidentifiedRunningTaskEvidence(state, paneKey, inventory)
  }
  if (Array.isArray(sessionCrons) && eventAgentId === undefined) {
    if (sessionCrons.length > 0) {
      state.claudeActiveSessionCronPaneKeys.add(paneKey)
    } else {
      state.claudeActiveSessionCronPaneKeys.delete(paneKey)
    }
  } else if (eventAgentId === undefined && isTurnBoundary && inventory.present) {
    // Older Claude can omit the cron inventory while still reporting background tasks.
    state.claudeActiveSessionCronPaneKeys.delete(paneKey)
  }
}

export function resolveClaudeReportedStateName(
  eventName: unknown,
  isTurnBoundary: boolean,
  isManualCompactCompletion: boolean,
  isAskUserQuestion: boolean,
  reconciledIdlePrompt: boolean
): 'working' | 'waiting' | 'done' | null {
  if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure' ||
    (eventName === 'PreToolUse' && !isAskUserQuestion)
  ) {
    return 'working'
  }
  if (eventName === 'PermissionRequest' || eventName === 'Elicitation' || isAskUserQuestion) {
    return 'waiting'
  }
  return isTurnBoundary || reconciledIdlePrompt || isManualCompactCompletion ? 'done' : null
}

export function resolveClaudeTaskWakeupTurn(
  eventName: unknown,
  isTaskWakeup: boolean,
  isTurnBoundary: boolean,
  isManualCompactCompletion: boolean,
  reconciledIdlePrompt: boolean,
  previousTaskWakeupTurn: boolean
): boolean {
  return eventName === 'UserPromptSubmit'
    ? isTaskWakeup
    : !isTurnBoundary &&
        !isManualCompactCompletion &&
        !reconciledIdlePrompt &&
        previousTaskWakeupTurn
}
