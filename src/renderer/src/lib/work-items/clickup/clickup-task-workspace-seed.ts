import { buildClickUpWorkspaceSource } from '../../../../../shared/new-workspace/workspace-source'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName
} from '../../../../../shared/workspace/naming/workspace-name'

export function getClickUpTaskWorkspaceSeed(
  task: Pick<ClickUpTask, 'id' | 'name' | 'url' | 'customId'>
): string {
  const source = buildClickUpWorkspaceSource(task)
  return getLinkedWorkItemWorkspaceName(source)?.seedName ?? getLinkedWorkItemSuggestedName(source)
}
