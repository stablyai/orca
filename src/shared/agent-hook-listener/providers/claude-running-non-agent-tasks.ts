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
    // Why: ids are unique per launch, so ended can outlive inventories.
    state.claudeRunningNonAgentTaskIdsByPaneKey.set(paneKey, {
      running: new Set(inventory.runningNonAgentTaskIds),
      ended: state.claudeRunningNonAgentTaskIdsByPaneKey.get(paneKey)?.ended ?? new Set()
    })
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
  const ids = state.claudeRunningNonAgentTaskIdsByPaneKey.get(paneKey)
  // Why: async hooks can deliver a launch after its own end, even across inventories.
  if (ids && !ids.ended.has(taskId)) {
    state.claudeRunningNonAgentTaskIdsByPaneKey.set(paneKey, {
      ...ids,
      running: new Set([...ids.running, taskId])
    })
    state.claudeRunningNonAgentTaskPaneKeys.add(paneKey)
  }
}

/** A shell that ended (notified or stopped) stops holding the pane once no listed shell runs. */
export function retireClaudeNonAgentTask(
  state: HookListenerState,
  paneKey: string,
  taskId: string
): void {
  const ids = state.claudeRunningNonAgentTaskIdsByPaneKey.get(paneKey)
  if (!ids || ids.ended.has(taskId)) {
    return
  }
  const running = new Set(ids.running)
  const wasRunning = running.delete(taskId)
  state.claudeRunningNonAgentTaskIdsByPaneKey.set(paneKey, {
    running,
    ended: new Set([...ids.ended, taskId])
  })
  if (wasRunning && running.size === 0) {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
}
