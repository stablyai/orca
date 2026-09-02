import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { findWorktreeById } from '../../worktree-helpers'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { deleteRuntimePath, deleteRuntimeRelativePath } from '@/runtime/runtime-file-client'

export function deleteUntouchedUntitledFile(state: AppState, file: OpenFile): void {
  const worktree = findWorktreeById(state.worktreesByRepo, file.worktreeId)
  const owningRuntimeEnvironmentId = file.runtimeEnvironmentId?.trim()
  let context: ReturnType<typeof getEditorFileOperationContext>
  try {
    context = getEditorFileOperationContext(state, file, worktree?.path ?? null)
  } catch {
    return
  }
  void deleteRuntimeRelativePath(context, file.relativePath)
    .then((deletedRemotely) => {
      if (!deletedRemotely && !owningRuntimeEnvironmentId) {
        return deleteRuntimePath(context, file.filePath)
      }
      return undefined
    })
    .catch(() => {})
}

export function shouldDeleteUntouchedUntitledFile(
  file: OpenFile | undefined,
  hasDraft: boolean
): boolean {
  return (
    file?.isUntitled === true && !file.isDirty && !hasDraft && file.deleteUntouchedOnClose !== false
  )
}
