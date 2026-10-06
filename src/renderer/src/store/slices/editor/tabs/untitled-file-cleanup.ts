import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { findWorktreeById } from '../../worktree-helpers'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'
import {
  deleteRuntimePath,
  deleteRuntimeRelativePath,
  isMissingRuntimePathError,
  statRuntimePath
} from '@/runtime/runtime-file-client'

export function deleteUntouchedUntitledFile(state: AppState, file: OpenFile): Promise<boolean> {
  const worktree = findWorktreeById(state.worktreesByRepo, file.worktreeId)
  const owningRuntimeEnvironmentId = file.runtimeEnvironmentId?.trim()
  let context: ReturnType<typeof getEditorFileOperationContext>
  try {
    context = getEditorFileOperationContext(state, file, worktree?.path ?? null)
  } catch {
    return Promise.resolve(false)
  }
  // Why: agents, external editors, and paired clients can fill the file without this window seeing it, so delete only a still-empty placeholder.
  return statRuntimePath(context, file.filePath)
    .then(async (stat) => {
      if (stat.size !== 0) {
        return false
      }
      const deletedRemotely = await deleteRuntimeRelativePath(context, file.relativePath)
      if (!deletedRemotely && !owningRuntimeEnvironmentId) {
        await deleteRuntimePath(context, file.filePath)
      }
      return true
    })
    .catch((error: unknown) => {
      // A missing path was already removed. Callers treat false as "kept", which
      // would offer Cmd+Shift+T for a file that is gone.
      return isMissingRuntimePathError(error)
    })
}

const EMPTY_DISK_SIGNATURE = getDiskBaselineSignature('')

export function shouldDeleteUntouchedUntitledFile(
  file: OpenFile | undefined,
  hasDraft: boolean
): boolean {
  return (
    file?.isUntitled === true &&
    !file.isDirty &&
    !hasDraft &&
    file.deleteUntouchedOnClose !== false &&
    // Why: a save or reload that left content on disk makes it a real note; the size check still catches writes this window never saw.
    (file.lastKnownDiskSignature === undefined ||
      file.lastKnownDiskSignature === EMPTY_DISK_SIGNATURE)
  )
}
