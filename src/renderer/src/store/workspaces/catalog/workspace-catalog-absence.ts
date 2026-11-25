import type { AppState } from '../../types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { getFolderWorkspaceHostId } from '../../../../../shared/folder-workspaces/folder-workspace-host-id'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { isHostCatalogIdentityCurrent } from '../../host-catalog/host-catalog-fence'
import { worktreeCatalogConfirmsAbsence } from '../../slices/worktrees/listing/worktree-catalog-absence'
import { selectFolderWorkspaces } from './workspace-record-fields'
import {
  getRuntimeTargetHostId,
  ipcOrRuntimeTargetForHostId
} from '../../../runtime/rpc/targets/runtime-client-target'

export function workspaceCatalogConfirmsAbsence(
  state: AppState,
  workspaceId: string,
  hostId: ExecutionHostId
): boolean {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type !== 'folder') {
    return worktreeCatalogConfirmsAbsence(state, scope?.worktreeId ?? workspaceId, hostId)
  }

  const target = ipcOrRuntimeTargetForHostId(hostId)
  const catalog = target && state.folderWorkspaceCatalogByHost[getRuntimeTargetHostId(target)]
  return Boolean(
    catalog &&
    isHostCatalogIdentityCurrent(state, catalog) &&
    !selectFolderWorkspaces(state).some(
      (folder) =>
        folder.id === scope.folderWorkspaceId &&
        getFolderWorkspaceHostId(folder, state.projectGroups) === hostId
    )
  )
}
