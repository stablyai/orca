import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getWorktreeMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import { workspacePresentationFor } from '@/store/workspace-source-state'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'

export function selectMarkdownDocumentWorktreePath(
  state: Pick<AppState, 'worktreesByRepo'> &
    Partial<Pick<AppState, 'workspacePresentations'>> & {
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
  const rows = getWorktreeMapFromState(state)
  const direct = rows.get(worktreeId)?.path
  if (direct) {
    return direct
  }
  const presentation = workspacePresentationFor(state, worktreeId)
  // The binding proves the locator; metadata keeps the genuine source's literal root.
  return presentation && rows.has(presentation.displayWorkspaceId)
    ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null)
    : null
}
