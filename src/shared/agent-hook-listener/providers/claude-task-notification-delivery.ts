import type { readClaudeBackgroundAgentTasks } from '../../claude-background-task-inventory'
import {
  forgetStoppedClaudeShellTask,
  oweClaudeShellTaskNotifications,
  readClaudeBackgroundTaskLaunch,
  recordClaudeBackgroundTaskLaunch,
  settleClaudeTaskNotification
} from '../../claude-owed-task-notifications'
import { readClaudeTaskNotification } from '../../claude-task-notification-text'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

/** Fold one MAIN-agent event into the pane's record of launched background tasks. A sub-agent's
 *  own launches are excluded by the caller: their notifications wake that sub-agent, not the pane. */
export function trackClaudeTaskNotificationDelivery(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  inventory: ReturnType<typeof readClaudeBackgroundAgentTasks>
): void {
  const tasks = state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey)
  if (eventName === 'PostToolUse') {
    const toolName = readString(hookPayload, 'tool_name')
    const response = hookPayload['tool_response']
    const launch = readClaudeBackgroundTaskLaunch(toolName, response)
    if (launch) {
      const launched = tasks ?? new Map()
      state.claudeLaunchedBackgroundTasksByPaneKey.set(paneKey, launched)
      recordClaudeBackgroundTaskLaunch(launched, launch)
    } else if (tasks && toolName === 'TaskStop' && typeof response === 'object' && response) {
      const stoppedId = readString({ ...response }, 'task_id')
      if (stoppedId) {
        forgetStoppedClaudeShellTask(tasks, stoppedId)
      }
    }
    return
  }
  if (!tasks) {
    return
  }
  if (eventName === 'UserPromptSubmit') {
    const notification = readClaudeTaskNotification(readString(hookPayload, 'prompt') ?? '')
    if (notification?.status) {
      settleClaudeTaskNotification(tasks, notification.taskId)
    }
  } else if ((eventName === 'Stop' || eventName === 'StopFailure') && inventory.present) {
    oweClaudeShellTaskNotifications(tasks, new Set(inventory.runningNonAgentTaskIds), Date.now())
  }
}
