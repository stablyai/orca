import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { isMultiRepoWorkspace } from '@/store/slices/multi-repo-workspace/multi-repo-workspace-selectors'

/** A multi-repo parent owns worktrees, so its menu says "Delete", like its confirmation dialog. */
export function useIsMultiRepoParent(folderWorkspaceId: string | null): boolean {
  return useAppStore((state) =>
    folderWorkspaceId
      ? isMultiRepoWorkspace(
          selectFolderWorkspaces(state).find((workspace) => workspace.id === folderWorkspaceId)
        )
      : false
  )
}
