import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../worktree/types'
import { getWorkspaceStatus } from './workspace-statuses'

type StatusRow = Pick<Worktree, 'workspaceStatus'>

/**
 * The status lane a row is listed in: a nested workspace follows its top shown ancestor, so moving
 * the parent moves the whole family. Rows without a shown root (no parent, a hidden or unknown
 * parent, a cycle) are placed by their own status. Children's stored statuses are never written.
 */
export function getPlacedWorkspaceStatus(
  row: StatusRow,
  displayRoot: StatusRow | undefined,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  return getWorkspaceStatus(displayRoot ?? row, statuses)
}
