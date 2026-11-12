import * as z from 'zod'
import { Identifier } from '../rpc-contract/structured-agent-session-identifiers'

export const AgentSessionForegroundTaskSchema = z
  .object({
    toolUseId: Identifier('Invalid tool call id'),
    turnId: Identifier('Invalid turn id'),
    generation: Identifier('Invalid acquisition generation'),
    taskId: Identifier('Invalid task id').optional()
  })
  .strict()

/** Captured by the executing host; a later process or turn cannot inherit this action. */
export type AgentSessionForegroundTask = z.infer<typeof AgentSessionForegroundTaskSchema>
export type AgentSessionBackgroundResult = { backgrounded: true }

export function agentSessionForegroundTaskKey(task: AgentSessionForegroundTask): string {
  return JSON.stringify([task.generation, task.turnId, task.toolUseId])
}

export function agentSessionForegroundTasksEqual(
  left: readonly AgentSessionForegroundTask[] | undefined,
  right: readonly AgentSessionForegroundTask[] | undefined
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right || left.length !== right.length) {
    return false
  }
  return left.every((task, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      task.toolUseId === other.toolUseId &&
      task.turnId === other.turnId &&
      task.generation === other.generation &&
      task.taskId === other.taskId
    )
  })
}
