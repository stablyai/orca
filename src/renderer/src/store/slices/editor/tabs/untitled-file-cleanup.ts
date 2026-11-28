import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { mayShareEditorBackingFile } from '../file-ids/editor-file-ids'
import { findFirstIndexedWorktree } from '../../../../lib/workspace/ownership/worktree-runtime-owner-index'
import { getEditorFileOperationContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import { deleteRuntimeRelativePathIfUnchanged } from '@/runtime/files/mutations/runtime-file-mutation-client'
import { selectWorktreesByRepo } from '../../../workspaces/catalog/workspace-record-fields'

/** The bytes an untouched placeholder held when it was created; anything else is not ours to delete. */
const EMPTY_DISK_PRECONDITION = {
  expectedSignature: getDiskBaselineSignature(''),
  requireLosslessUtf8: true
}

export function deleteUntouchedUntitledFile(
  getState: () => AppState,
  file: OpenFile,
  rememberClosedEditorTabForReopen: (file: OpenFile) => void
): void {
  const hasRetainedView = () =>
    getState().openFiles.some((candidate) => mayShareEditorBackingFile(candidate, file))
  if (hasRetainedView()) {
    return
  }
  const state = getState()
  const worktree = findFirstIndexedWorktree(selectWorktreesByRepo(state), file.worktreeId)
  let context: ReturnType<typeof getEditorFileOperationContext>
  try {
    context = getEditorFileOperationContext(state, file, worktree?.path ?? null)
  } catch {
    return
  }
  // Delete only still-empty placeholders; agents/external editors/paired clients may write unseen content.
  // The host checks emptiness and unlinks in one request: a write landing between a separate stat and
  // delete would otherwise be lost, and the closed tab would already be out of the reopen history.
  void deleteRuntimeRelativePathIfUnchanged(context, file.relativePath, EMPTY_DISK_PRECONDITION)
    .then((result) => {
      if (result === null) {
        // An older host cannot check and delete in one step; keeping an empty placeholder beats
        // deleting a file that may have been written since the check.
        return
      }
      if (!result.ok && result.diskConflict === 'changed' && !hasRetainedView()) {
        rememberClosedEditorTabForReopen(file)
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
