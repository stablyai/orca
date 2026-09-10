import type { AgentSessionBackgroundTaskState } from './agent-session-wire'

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
  if (left.tasks === right.tasks) {
    return true
  }
  if (!left.tasks || !right.tasks || left.tasks.length !== right.tasks.length) {
    return false
  }
  return left.tasks.every(
    (task, index) =>
      task.id === right.tasks?.[index]?.id &&
      task.kind === right.tasks[index]?.kind &&
      task.description === right.tasks[index]?.description
  )
}
