import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getWorktreeMapFromState } from '@/store/selectors'
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
  return getWorktreeMapFromState(state).get(worktreeId)?.path ?? null
}
