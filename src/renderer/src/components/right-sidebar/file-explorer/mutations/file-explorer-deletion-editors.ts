import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getEditorFileOperationContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import type { FileExplorerOperationRoute } from '../navigation/file-explorer-operation-owner'
import { isPathEqualOrDescendant } from '../navigation/file-explorer-paths'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'

export type FileExplorerDeletionEditor = Pick<
  OpenFile,
  | 'id'
  | 'filePath'
  | 'worktreeId'
  | 'isDirty'
  | 'runtimeEnvironmentId'
  | 'externalSshTargetId'
  | 'operationProvenance'
>

export function getFileExplorerDeletionEditors(
  state: AppState,
  openFiles: FileExplorerDeletionEditor[],
  deletedPath: string,
  route: FileExplorerOperationRoute
): FileExplorerDeletionEditor[] {
  return openFiles.filter((file) => {
    if (!isPathEqualOrDescendant(file.filePath, deletedPath)) {
      return false
    }
    try {
      const owner = getEditorFileOperationContext(state, file, null)
      // Identical paths on different hosts must not trigger another editor's save or close.
      return (
        runtimeTargetEnvironmentId(owner.target) === runtimeTargetEnvironmentId(route.target) &&
        owner.expectedExecutionHostId === route.expectedExecutionHostId &&
        owner.connectionId === route.connectionId
      )
    } catch {
      // Unverifiable editor ownership cannot authorize a save or close.
      return false
    }
  })
}
