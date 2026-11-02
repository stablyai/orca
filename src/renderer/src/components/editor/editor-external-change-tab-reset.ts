import { getConnectionIdForFile } from '@/lib/connection-context'
import { getOpenFilesForExternalFileChange, type EditorPathMutationTarget } from './editor-autosave'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import { hasRecentSelfWrite } from './editor-self-write-registry'
import type { AppStoreApi } from './editor-save-queue'
import { isEditorModelDirty } from './editor-save-disk-precondition'

export function createEditorExternalChangeTabReset(store: AppStoreApi): (event: Event) => void {
  return (event: Event): void => {
    const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
    if (!detail) {
      return
    }

    const state = store.getState()
    // Why no sibling expansion: views of one file share a record, so each matches by path itself.
    const matchingFiles = getOpenFilesForExternalFileChange(state.openFiles, detail)
    if (matchingFiles.length === 0) {
      return
    }

    // Keep model-level dirty drafts on external writes (#7265); clean sibling tabs show the same unsaved model text.
    // Mark changed-on-disk too for tabs becoming dirty during notify debounce.
    const modelDirty = new Set(
      matchingFiles.filter((file) => isEditorModelDirty(state, file)).map((file) => file.id)
    )
    const reloadingFiles = matchingFiles.filter((file) => !modelDirty.has(file.id))
    for (const file of matchingFiles) {
      if (modelDirty.has(file.id)) {
        if (!file.isDirty) {
          continue
        }
        // Why: skip Orca's own-save echo, which routes here bypassing the watch hook's echo verification.
        if (!hasRecentSelfWrite(file.filePath, file.runtimeEnvironmentId)) {
          markFileChangedOnDisk(state, file, {
            connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
            origin: 'live'
          })
        }
        continue
      }
      // Why: going clean drops the autosave timer, and a queued save then finds nothing to write.
      state.markFileDirty(file.id, false)
      // Why: about to reload fresh disk content, so a stale changed-on-disk mark is resolved.
      if (file.externalMutation === 'changed') {
        state.setExternalMutation(file.id, null)
      }
    }
    state.clearEditorDrafts(reloadingFiles.map((file) => file.id))
  }
}
