import type { ClickUpTask } from '../clickup/clickup-types'
import { isClickUpTaskUrl } from '../clickup/clickup-task-reference'
import type { SmartNameMode, SmartWorkspaceSourceRow } from './smart-workspace-source-results'

function toClickUpSourceRow(task: ClickUpTask): SmartWorkspaceSourceRow {
  return { kind: 'clickup', value: `clickup-${task.workspaceId}-${task.id}`, task }
}

/** A pasted task URL is not a workspace name yet; create waits until it resolves to a task. */
export function isBlockingClickUpUrlIntent(mode: SmartNameMode, value: string): boolean {
  return (mode === 'smart' || mode === 'clickup') && isClickUpTaskUrl(value)
}

/** Rows owned by ClickUp, or null when ClickUp neither resolves a pasted URL nor owns the tab. */
export function buildClickUpSourceRows({
  mode,
  intent,
  task,
  tasks,
  resultLimit
}: {
  mode: SmartNameMode
  intent: boolean
  task: ClickUpTask | null
  tasks: readonly ClickUpTask[]
  resultLimit: number
}): SmartWorkspaceSourceRow[] | null {
  // Why: a pasted task URL names exactly one task, so every other source is noise.
  if (intent) {
    return task ? [toClickUpSourceRow(task)] : []
  }
  return mode === 'clickup' ? tasks.slice(0, resultLimit).map(toClickUpSourceRow) : null
}
