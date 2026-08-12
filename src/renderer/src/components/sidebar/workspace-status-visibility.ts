import type { Worktree, WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'

/**
 * Whether the sidebar status filter hides this workspace. Shared by the
 * worktree pipeline (computeVisibleWorktreeIds) and the folder-workspace rows,
 * which never pass through it.
 *
 * Fail-open on an empty status catalog: `getWorkspaceStatus` would resolve
 * every workspace to the built-in default, so hiding that default would sweep
 * the whole list instead of the statuses the user actually unchecked.
 */
export function isWorkspaceStatusHidden(
  workspace: Pick<Worktree, 'workspaceStatus'>,
  hiddenStatusIds: readonly WorkspaceStatus[] | undefined,
  statuses: readonly WorkspaceStatusDefinition[] | undefined
): boolean {
  if (!hiddenStatusIds?.length || !statuses?.length) {
    return false
  }
  return hiddenStatusIds.includes(getWorkspaceStatus(workspace, statuses))
}
