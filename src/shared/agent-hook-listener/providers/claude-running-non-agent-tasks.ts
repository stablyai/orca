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
  const previous = state.claudeRunningNonAgentTaskIdsByPaneKey.get(paneKey)
  const running = inventory.allRunningNonAgentTasksListed
    ? new Set(inventory.runningNonAgentTaskIds)
    : undefined
  // Why: ids are unique per launch, so ended outlives inventories; one a complete inventory drops has ended too.
  const dropped = running ? [...(previous?.running ?? [])].filter((id) => !running.has(id)) : []
  state.claudeRunningNonAgentTaskIdsByPaneKey.set(paneKey, {
    running,
    ended:
      dropped.length > 0
        ? new Set([...(previous?.ended ?? []), ...dropped])
        : (previous?.ended ?? new Set())
  })
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
  if (ids?.running && !ids.ended.has(taskId)) {
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
  if (ids?.ended.has(taskId)) {
    return
  }
  const running = ids?.running && new Set(ids.running)
  const wasRunning = running?.delete(taskId) === true
  state.claudeRunningNonAgentTaskIdsByPaneKey.set(paneKey, {
    running,
    ended: new Set([...(ids?.ended ?? []), taskId])
  })
  if (wasRunning && running?.size === 0) {
    state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
  }
}
