import type { readClaudeBackgroundAgentTasks } from '../../claude-background-task-inventory'
import type { HookListenerState } from '../listener-state'

/** Lead verdicts cannot override positive process evidence; the id sets are replaced, never mutated, so snapshots stay valid. */
export function updateClaudeRunningNonAgentTask(
  state: HookListenerState,
  paneKey: string,
  inventory: Pick<
    ReturnType<typeof readClaudeBackgroundAgentTasks>,
    'hasRunningNonAgentTask' | 'runningNonAgentTaskIds' | 'allRunningNonAgentTasksListed'
  >
): void {
  if (inventory.hasRunningNonAgentTask) {
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
  } else {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
  if (inventory.allRunningNonAgentTasksListed) {
    state.claudeRunningNonAgentTaskIdsByPaneKey.set(
      paneKey,
      new Set(inventory.runningNonAgentTaskIds)
    )
  } else {
    state.claudeRunningNonAgentTaskIdsByPaneKey.delete(paneKey)
  }
}

/** A shell launched after a complete inventory holds the pane until its own notification. */
export function recordClaudeLaunchedNonAgentTask(
  state: HookListenerState,
  paneKey: string,
  taskId: string
): void {
  // Without a complete inventory, ids alone can never retire the pane, so only inventory holds it.
  const running = state.claudeRunningNonAgentTaskIdsByPaneKey.get(paneKey)
  if (running) {
    state.claudeRunningNonAgentTaskIdsByPaneKey.set(paneKey, new Set([...running, taskId]))
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
  }
}

/** A shell that ended (notified or stopped) stops holding the pane once no listed shell runs. */
export function retireClaudeNonAgentTask(
  state: HookListenerState,
  paneKey: string,
  taskId: string
): void {
  const running = state.claudeRunningNonAgentTaskIdsByPaneKey.get(paneKey)
  if (!running?.has(taskId)) {
    return
  }
  const rest = new Set(running)
  rest.delete(taskId)
  state.claudeRunningNonAgentTaskIdsByPaneKey.set(paneKey, rest)
  if (rest.size === 0) {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
}
