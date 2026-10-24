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
    const matchingFiles = getOpenFilesForExternalFileChange(state.openFiles, detail, state)
    if (matchingFiles.length === 0) {
      return
    }

    // Why: keep dirty drafts on external writes (data-loss half of #7265); mark changed-on-disk as backstop for tabs turned dirty during the notify debounce.
    // Why model-level: a clean tab of a model another tab is editing shows that unsaved text.
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
