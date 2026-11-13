import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { AppState } from '@/store/types'

export function selectMarkdownDocumentWorktreePath(
  state: Pick<AppState, 'worktreesByRepo'> & {
    folderWorkspaces?: readonly Pick<FolderWorkspace, 'id' | 'folderPath'>[]
  },
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return (
      state.folderWorkspaces?.find((workspace) => workspace.id === scope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  return getIndexedWorktreeMap(selectWorktreesByRepo(state)).get(worktreeId)?.path ?? null
}
