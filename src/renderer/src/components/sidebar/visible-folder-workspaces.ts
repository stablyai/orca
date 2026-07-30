import type { FolderWorkspace, ProjectGroup, TerminalTab } from '../../../../shared/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { getFolderWorkspaceExecutionHostIdForRows } from './worktree-list-host-filtering'

/** Filters folder rows by host and sleeping state using their synthetic activity key. */
export function computeVisibleFolderWorkspaces(
  folderWorkspaces: readonly FolderWorkspace[],
  opts: {
    projectGroupById: ReadonlyMap<string, ProjectGroup>
    visibleHostIdSet: ReadonlySet<ExecutionHostId> | null
    defaultHostId: ExecutionHostId
    showSleepingWorkspaces: boolean
    tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
    ptyIdsByTabId: Record<string, string[]> | null
    browserTabsByWorktree?: Record<string, { id: string }[]> | null
    worktreeIdsWithLiveAgent: ReadonlySet<string>
  }
): readonly FolderWorkspace[] {
  // Why: mirror the git-worktree pipeline, which drops archived rows before any
  // other filter (see the isArchived filter in computeVisibleWorktreeIds).
  let visible = folderWorkspaces.filter((folderWorkspace) => !folderWorkspace.isArchived)
  if (opts.visibleHostIdSet) {
    const visibleHostIdSet = opts.visibleHostIdSet
    visible = visible.filter((folderWorkspace) => {
      const hostId = getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace,
        projectGroup: opts.projectGroupById.get(folderWorkspace.projectGroupId),
        defaultHostId: opts.defaultHostId
      })
      return visibleHostIdSet.has(hostId)
    })
  }
  if (!opts.showSleepingWorkspaces) {
    visible = visible.filter(
      (folderWorkspace) =>
        !isInactiveWorkspace(
          folderWorkspaceKey(folderWorkspace.id),
          opts.tabsByWorktree,
          opts.ptyIdsByTabId,
          opts.browserTabsByWorktree,
          opts.worktreeIdsWithLiveAgent
        )
    )
  }
  return visible
}
