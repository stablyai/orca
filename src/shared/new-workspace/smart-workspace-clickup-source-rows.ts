import type { ClickUpTask } from '../clickup-types'

export type ClickUpSourceRow = { kind: 'clickup'; value: string; task: ClickUpTask }

export function buildClickUpSourceRows({
  clickUpAvailable,
  clickUpTasks,
  mode
}: {
  clickUpAvailable: boolean
  clickUpTasks: ClickUpTask[]
  mode: string
}): ClickUpSourceRow[] {
  if (!clickUpAvailable || (mode !== 'smart' && mode !== 'clickup')) {
    return []
  }
  // Why: ClickUp task ids are only unique inside a workspace, so the row value carries both.
  return clickUpTasks.map((task) => ({
    kind: 'clickup',
    value: `clickup-${task.workspaceId}-${task.id}`,
    task
  }))
}
