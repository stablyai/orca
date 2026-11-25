import { resolveQualifiedIndexedFolderWorkspace } from '@/store/folder-workspaces/folder-workspace-record-index'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getFolderWorkspaceWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { dedupePaletteWorktrees } from './palette-repo-resolution'

/** Every git worktree plus folder workspace as one palette row list (Cmd+J and Tab Search share it). */
export function buildPaletteWorkspaces({
  worktreesByRepo,
  folderWorkspaces,
  repos,
  projectGroups
}: Pick<AppState, 'folderWorkspaces' | 'repos' | 'projectGroups'> & {
  worktreesByRepo: Record<string, Worktree[]>
}): Worktree[] {
  return dedupePaletteWorktrees([
    ...Object.values(worktreesByRepo).flat(),
    ...folderWorkspaces.map((folder) => {
      const result = resolveQualifiedIndexedFolderWorkspace(
        { folderWorkspaces, repos, projectGroups },
        folder.id
      )
      return getFolderWorkspaceWorktree(
        folder,
        result.kind === 'selected' && result.value.workspace === folder ? result.value : undefined
      )
    })
  ])
}
