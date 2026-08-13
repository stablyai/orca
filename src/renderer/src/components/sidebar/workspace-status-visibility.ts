import type { Worktree, WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'

/**
 * The hide-list narrowed to statuses that still exist, or empty when the filter
 * cannot be applied safely. Every surface reads the filter through this so a
 * stale id can neither hide rows nor inflate the filter badge.
 *
 * Two ways it resolves to "no filter":
 * - No status catalog. `getWorkspaceStatus` would resolve every workspace to
 *   the built-in default, so hiding that default would sweep the whole list.
 * - Every live status hidden. Reachable by deleting a status the user had left
 *   visible; the click-time guard cannot see that coming, and an empty sidebar
 *   has no in-list way back.
 */
export function getEffectiveHiddenWorkspaceStatusIds(
  hiddenStatusIds: readonly WorkspaceStatus[] | undefined,
  statuses: readonly WorkspaceStatusDefinition[] | undefined
): WorkspaceStatus[] {
  if (!hiddenStatusIds?.length || !statuses?.length) {
    return []
  }
  const live = statuses.filter((status) => hiddenStatusIds.includes(status.id))
  return live.length === statuses.length ? [] : live.map((status) => status.id)
}

/**
 * Whether the sidebar status filter hides this workspace. Shared by the
 * worktree pipeline (computeVisibleWorktreeIds), the folder-workspace rows and
 * the Cmd+J palette, which each build their own list.
 */
export function isWorkspaceStatusHidden(
  workspace: Pick<Worktree, 'workspaceStatus'>,
  hiddenStatusIds: readonly WorkspaceStatus[] | undefined,
  statuses: readonly WorkspaceStatusDefinition[] | undefined
): boolean {
  const effectiveHiddenIds = getEffectiveHiddenWorkspaceStatusIds(hiddenStatusIds, statuses)
  if (effectiveHiddenIds.length === 0 || !statuses) {
    return false
  }
  return effectiveHiddenIds.includes(getWorkspaceStatus(workspace, statuses))
}
