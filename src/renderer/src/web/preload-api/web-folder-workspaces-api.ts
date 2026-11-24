import type { PreloadApi } from '../../../../preload/api-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../../../shared/folder-workspaces/folder-workspace-path-status'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'

/**
 * Folder workspaces are owned by the local orcad runtime in Tauri, just as they
 * are owned by the paired runtime in the browser client.
 */
export function createWebFolderWorkspacesApi(): NonNullable<
  Partial<PreloadApi>['folderWorkspaces']
> {
  return {
    list: async () => {
      // Why destructure: the field belongs to the runtime RPC envelope, not the
      // store record, so it reads through the envelope instead of the catalog selectors.
      const { folderWorkspaces } = await callRuntimeResult<{
        folderWorkspaces: FolderWorkspace[]
      }>('folderWorkspace.list')
      return folderWorkspaces
    },
    getPathStatus: async (args: FolderWorkspacePathStatusRequest) =>
      (
        await callRuntimeResult<{ status: FolderWorkspacePathStatus }>(
          'folderWorkspace.getPathStatus',
          args
        )
      ).status,
    create: (args) => callRuntimeResult('folderWorkspace.create', args),
    update: async (args) =>
      (
        await callRuntimeResult<{ folderWorkspace: FolderWorkspace | null }>(
          'folderWorkspace.update',
          args
        )
      ).folderWorkspace,
    delete: (args) => callRuntimeResult<boolean>('folderWorkspace.delete', args)
  }
}
