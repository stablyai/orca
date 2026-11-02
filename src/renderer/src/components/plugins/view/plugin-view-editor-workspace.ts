import { toWorktreeRelativePath } from '../../../../../shared/terminal-links'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import { getFolderWorkspaceWorktreeHostId } from '../../../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type WorkspaceRow = { id: string; path: string; hostId?: string; isArchived?: boolean }

export type PluginEditorWorkspace = {
  worktreeId: string
  relativePath: string
  filePath: string
  /** Set when no workspace held the file, so its folder was added as this project. */
  addedRepoId?: string
}

/** Folder workspaces as rows keyed like the tabs they hold, on their own host. */
export function folderWorkspaceRows(
  folderWorkspaces:
    | readonly Pick<
        FolderWorkspace,
        'id' | 'folderPath' | 'executionHostId' | 'connectionId' | 'isArchived'
      >[]
    | undefined
): WorkspaceRow[] {
  return (folderWorkspaces ?? []).map((workspace) => ({
    id: folderWorkspaceKey(workspace.id),
    path: workspace.folderPath,
    hostId: getFolderWorkspaceWorktreeHostId(workspace),
    isArchived: workspace.isArchived
  }))
}

/** The deepest local workspace whose folder holds one of `paths` (the same file, spelled as given
 *  and as its real path, since `/tmp` and `/private/tmp` name one folder on macOS). */
export function findWorkspaceShowingFile(
  workspaces: readonly WorkspaceRow[],
  paths: readonly string[],
  activeWorktreeId: string | null
): PluginEditorWorkspace | null {
  let best: (PluginEditorWorkspace & { depth: number; active: boolean }) | null = null
  for (const worktree of workspaces) {
    const local = worktree.hostId === undefined || worktree.hostId === LOCAL_EXECUTION_HOST_ID
    if (!local || worktree.isArchived) {
      continue
    }
    for (const filePath of paths) {
      const relativePath = toWorktreeRelativePath(filePath, worktree.path)
      if (!relativePath) {
        continue
      }
      const depth = worktree.path.length
      const active = worktree.id === activeWorktreeId
      // Prefer the deepest folder, then the workspace already on screen.
      if (!best || depth > best.depth || (depth === best.depth && active && !best.active)) {
        best = { worktreeId: worktree.id, relativePath, filePath, depth, active }
      }
    }
  }
  return (
    best && {
      worktreeId: best.worktreeId,
      relativePath: best.relativePath,
      filePath: best.filePath
    }
  )
}

/**
 * The workspace to open `paths[0]` in, made active: one that shows the file, else its folder added
 * as a folder workspace on this machine. Null when Orca could not add the folder.
 */
export async function showWorkspaceForFile(
  paths: readonly string[],
  fallbackFolder: string
): Promise<PluginEditorWorkspace | null> {
  const find = (): PluginEditorWorkspace | null => {
    const state = useAppStore.getState()
    const rows = [
      ...Object.values(selectWorktreesByRepo(state) ?? {}).flat(),
      ...folderWorkspaceRows(selectFolderWorkspaces(state))
    ]
    return findWorkspaceShowingFile(rows, paths, state.activeWorktreeId)
  }
  let found = find()
  let addedRepoId: string | undefined
  if (!found) {
    const state = useAppStore.getState()
    // Why local: plugin open resolves paths on the Orca that runs it, which is this one.
    const repo = await state.addRepoPath(fallbackFolder, 'folder', { runtimeEnvironmentId: null })
    if (!repo) {
      return null
    }
    await useAppStore.getState().fetchWorktrees(repo.id)
    addedRepoId = repo.id
    found = find()
  }
  if (!found) {
    return null
  }
  const state = useAppStore.getState()
  if (state.activeWorktreeId !== found.worktreeId || state.activeView !== 'terminal') {
    // The editor tab is the surface, so activation must not start a terminal of its own.
    activateAndRevealWorkspace(found.worktreeId, {
      providesInitialSurface: true,
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  }
  return addedRepoId ? { ...found, addedRepoId } : found
}
