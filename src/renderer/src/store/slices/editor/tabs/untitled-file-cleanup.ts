import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { mayShareEditorBackingFile } from '../file-ids/editor-file-ids'
import { findFirstIndexedWorktree } from '../../../../lib/workspace/ownership/worktree-runtime-owner-index'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import {
  deleteRuntimePath,
  deleteRuntimeRelativePath
} from '@/runtime/files/mutations/runtime-file-mutation-client'
import { statRuntimePath } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

export function deleteUntouchedUntitledFile(getState: () => AppState, file: OpenFile): void {
  const hasRetainedView = () =>
    getState().openFiles.some((candidate) => mayShareEditorBackingFile(candidate, file))
  if (hasRetainedView()) {
    return
  }
  const state = getState()
  const worktree = findFirstIndexedWorktree(selectWorktreesByRepo(state), file.worktreeId)
  const owningRuntimeEnvironmentId = file.runtimeEnvironmentId?.trim()
  let context: ReturnType<typeof getEditorFileOperationContext>
  try {
    context = getEditorFileOperationContext(state, file, worktree?.path ?? null)
  } catch {
    return
  }
  // Delete only still-empty placeholders; agents/external editors/paired clients may write unseen content.
  void statRuntimePath(context, file.filePath)
    .then(async (stat) => {
      if (stat.size !== 0 || hasRetainedView()) {
        return
      }
      const deletedRemotely = await deleteRuntimeRelativePath(context, file.relativePath)
      if (!deletedRemotely && !owningRuntimeEnvironmentId && !hasRetainedView()) {
        await deleteRuntimePath(context, file.filePath)
      }
    })
    .catch(() => {})
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
    // Saved/reloaded content makes real notes; disk size also catches writes this window missed.
    (file.lastKnownDiskSignature === undefined ||
      file.lastKnownDiskSignature === EMPTY_DISK_SIGNATURE)
  )
}
