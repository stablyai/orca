import {
  agentSessionBackgroundTasksEqual,
  type AgentSessionBackgroundTaskState
} from './agent-session-wire'

/** Structural equality so a republished roster never churns transcript identity. */
export function backgroundTaskStatesEqual(
  left: AgentSessionBackgroundTaskState | null | undefined,
  right: AgentSessionBackgroundTaskState | null | undefined
): boolean {
  if (left === right) {
    return true
  }
  if (
    !left ||
    !right ||
    left.state !== right.state ||
    left.supportsTaskStop !== right.supportsTaskStop ||
    left.supportsStopAll !== right.supportsStopAll
  ) {
    return false
  }
  return (
    agentSessionBackgroundTasksEqual(left.tasks, right.tasks) &&
    agentSessionBackgroundTasksEqual(left.settledTasks, right.settledTasks)
  )
}
