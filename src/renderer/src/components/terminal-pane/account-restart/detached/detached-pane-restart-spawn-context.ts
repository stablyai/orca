import {
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'

export function getWorkspacePath(state: AppState, worktreeId: string): string | null {
  const parsed = parseWorkspaceKey(worktreeId)
  return parsed?.type === 'folder'
    ? (selectFolderWorkspaces(state).find((workspace) => workspace.id === parsed.folderWorkspaceId)
        ?.folderPath ?? null)
    : (getIndexedWorktreeMap(selectWorktreesByRepo(state)).get(worktreeId)?.path ?? null)
}

export function buildPaneIdentityEnv(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string
): Record<string, string> {
  const parsed = parseWorkspaceKey(worktreeId)
  const folderWorkspace =
    parsed?.type === 'folder'
      ? selectFolderWorkspaces(state).find((workspace) => workspace.id === parsed.folderWorkspaceId)
      : null
  return {
    ORCA_WORKSPACE_ID: worktreeId,
    ...(folderWorkspace
      ? {
          ORCA_PROJECT_GROUP_ID: folderWorkspace.projectGroupId,
          ORCA_WORKSPACE_ROOT: folderWorkspace.folderPath
        }
      : {}),
    ORCA_PANE_KEY: makePaneKey(tabId, leafId),
    ORCA_TAB_ID: tabId,
    ORCA_WORKTREE_ID: worktreeId
  }
}
