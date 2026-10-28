import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { WorkspaceViewCatalogState } from '@/lib/workspace-view-catalog'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export function useWorkspaceViewCatalogState(enabled = true): WorkspaceViewCatalogState | null {
  return useAppStore(
    useShallow((state) =>
      enabled
        ? {
            unifiedTabsByWorktree: state.unifiedTabsByWorktree,
            groupsByWorktree: state.groupsByWorktree,
            worktreesByRepo: selectWorktreesByRepo(state),
            folderWorkspaces: selectFolderWorkspaces(state),
            projectGroups: state.projectGroups,
            repos: state.repos,
            openFiles: state.openFiles,
            activeWorktreeId: state.activeWorktreeId,
            activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
            settings: state.settings,
            restoredRuntimeHostIdByWorkspaceSessionKey:
              state.restoredRuntimeHostIdByWorkspaceSessionKey
          }
        : null
    )
  )
}
