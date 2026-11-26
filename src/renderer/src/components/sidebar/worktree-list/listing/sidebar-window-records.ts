import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspaces/folder-workspace-host-id'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

function folderKey(id: string, hostId: string | null | undefined): string {
  return `${parseExecutionHostId(hostId)?.id ?? ''}\0${id}`
}

/** Main owns list order; the window's records own what each card displays. */
export function indexSidebarWindowRecords(
  worktrees: readonly Worktree[],
  folders: readonly FolderWorkspace[],
  groups: readonly ProjectGroup[]
) {
  const byWorktree = new Map(worktrees.map((row) => [getWorktreeHostIdentity(row), row]))
  const byFolder = new Map(
    folders.map((row) => [folderKey(row.id, getFolderWorkspaceHostId(row, groups)), row])
  )
  const worktree = (row: Worktree): Worktree => byWorktree.get(getWorktreeHostIdentity(row)) ?? row
  const folder = (row: FolderWorkspace): FolderWorkspace =>
    byFolder.get(folderKey(row.id, getFolderWorkspaceHostId(row, groups))) ?? row
  return {
    worktree,
    folder,
    sectionRow: (row: HostSectionRow): HostSectionRow => {
      if (row.type === 'item') {
        const next = worktree(row.worktree)
        return next === row.worktree ? row : { ...row, worktree: next }
      }
      if (row.type === 'folder-workspace') {
        const next = folder(row.folderWorkspace)
        return next === row.folderWorkspace ? row : { ...row, folderWorkspace: next }
      }
      return row
    }
  }
}
