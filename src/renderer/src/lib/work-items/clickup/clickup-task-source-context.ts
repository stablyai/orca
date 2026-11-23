import type { ClickUpTask, ClickUpWorkspace } from '../../../../../shared/clickup/clickup-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../../shared/work-items/task-source-context'

/** Pins a ClickUp task's source context to the Workspace the task lives in. */
export function bindClickUpTaskSourceContext(args: {
  task: Pick<ClickUpTask, 'workspaceId'>
  workspaces: readonly ClickUpWorkspace[]
  sourceContext: TaskSourceContext | null
}): TaskSourceContext | null {
  if (args.sourceContext?.provider !== 'clickup') {
    return null
  }
  const workspaceName =
    args.workspaces.find((workspace) => workspace.id === args.task.workspaceId)?.name ?? null
  return normalizeTaskSourceContext({
    ...args.sourceContext,
    providerIdentity: {
      provider: 'clickup',
      workspaceId: args.task.workspaceId,
      workspaceName
    },
    accountLabel: workspaceName
  })
}
