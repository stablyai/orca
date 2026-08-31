import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import { getPaletteHostBadge } from './palette-host-badge'

/**
 * Folder workspaces are a store collection of their own, so every Cmd+J index built
 * by walking `worktrees` misses their tabs entirely. Adapting them to the worktree
 * shape lets a single sort interleave both workspace kinds instead of appending
 * folder rows after every worktree row.
 */
export function collectPaletteTabIndexWorkspaces(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[]
): Worktree[] {
  return [...worktrees, ...folderWorkspaces.map(folderWorkspaceToWorktree)]
}

export function isPaletteFolderWorkspace(workspace: Pick<Worktree, 'id'>): boolean {
  return parseWorkspaceKey(workspace.id)?.type === 'folder'
}

/**
 * Worktree-only view of the combined list, for the indexes that have no folder path yet.
 * Returns the input untouched when it holds no folder workspace, so consumers memoizing on
 * identity don't re-run for a user who has none.
 */
export function excludePaletteFolderWorkspaces(
  workspaces: readonly Worktree[]
): readonly Worktree[] {
  return workspaces.some(isPaletteFolderWorkspace)
    ? workspaces.filter((workspace) => !isPaletteFolderWorkspace(workspace))
    : workspaces
}

/**
 * Host label per folder workspace, keyed by host identity. A folder workspace hangs off
 * a project group rather than a repo, so its rows have no repo badge — on a remote host
 * the label is the only thing on the row that says where the tab actually runs.
 */
export function collectFolderWorkspaceHostLabels(
  folderWorkspaces: readonly FolderWorkspace[],
  hostOptions: readonly SidebarHostOption[],
  alwaysShowHostLabel: boolean
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const folderWorkspace of folderWorkspaces) {
    const badge = getPaletteHostBadge(folderWorkspace, hostOptions, alwaysShowHostLabel)
    if (badge) {
      labels.set(getWorktreeHostIdentity(folderWorkspaceToWorktree(folderWorkspace)), badge.label)
    }
  }
  return labels
}
