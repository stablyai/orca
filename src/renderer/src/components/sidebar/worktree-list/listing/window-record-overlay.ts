import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspaces/folder-workspace-host-id'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { SidebarListModelArgs } from './sidebar-list-model'

const EMPTY_WORKTREE_BY_IDENTITY: ReadonlyMap<string, Worktree> = new Map()
const EMPTY_FOLDER_BY_KEY: ReadonlyMap<string, FolderWorkspace> = new Map()

function folderRecordKey(id: string, hostId: string | null | undefined): string {
  return `${parseExecutionHostId(hostId)?.id ?? ''}\0${id}`
}

// Main's rows answer for the list; the window's own records answer for what a card shows.
export function windowRecordOf(
  records: ReadonlyMap<string, Worktree>,
  worktree: Worktree
): Worktree {
  return records.get(getWorktreeHostIdentity(worktree)) ?? worktree
}

export function windowFolderRecordOf(
  records: ReadonlyMap<string, FolderWorkspace>,
  folder: FolderWorkspace
): FolderWorkspace {
  return records.get(folderRecordKey(folder.id, folder.executionHostId)) ?? folder
}

export function indexWorktreesByIdentity(
  worktrees: readonly Worktree[]
): ReadonlyMap<string, Worktree> {
  if (worktrees.length === 0) {
    return EMPTY_WORKTREE_BY_IDENTITY
  }
  const map = new Map<string, Worktree>()
  for (let i = 0; i < worktrees.length; i += 1) {
    const worktree = worktrees[i]
    map.set(getWorktreeHostIdentity(worktree), worktree)
  }
  return map
}

export function indexFoldersByKey(
  folders: readonly FolderWorkspace[],
  projectGroups: SidebarListModelArgs['projectGroups']
): ReadonlyMap<string, FolderWorkspace> {
  if (folders.length === 0) {
    return EMPTY_FOLDER_BY_KEY
  }
  const map = new Map<string, FolderWorkspace>()
  for (let i = 0; i < folders.length; i += 1) {
    const folder = folders[i]
    map.set(folderRecordKey(folder.id, getFolderWorkspaceHostId(folder, projectGroups)), folder)
  }
  return map
}

export function overlayWindowSectionRows(
  rows: HostSectionRow[],
  worktreeByIdentity: ReadonlyMap<string, Worktree>,
  folderByKey: ReadonlyMap<string, FolderWorkspace>
): HostSectionRow[] {
  if (rows.length === 0 || (worktreeByIdentity.size === 0 && folderByKey.size === 0)) {
    return rows
  }
  let next: HostSectionRow[] | undefined
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    let updated: HostSectionRow = row
    if (row.type === 'item') {
      const worktree = windowRecordOf(worktreeByIdentity, row.worktree)
      if (worktree !== row.worktree) {
        updated = { ...row, worktree }
      }
    } else if (row.type === 'folder-workspace') {
      const folderWorkspace = windowFolderRecordOf(folderByKey, row.folderWorkspace)
      if (folderWorkspace !== row.folderWorkspace) {
        updated = { ...row, folderWorkspace }
      }
    }
    if (updated !== row && !next) {
      next = rows.slice(0, i)
    }
    if (next) {
      next.push(updated)
    }
  }
  return next ?? rows
}
