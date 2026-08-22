import { getConnectionIdForFile } from '@/lib/connection-context'
import { getOpenFilesForExternalFileChange, type EditorPathMutationTarget } from './editor-autosave'
import { markFileChangedOnDisk } from './editor-changed-on-disk-mark'
import { hasRecentSelfWrite } from './editor-self-write-registry'
import type { AppStoreApi, EditorSaveQueue } from './editor-save-queue'

type EditorExternalChangeTabResetOptions = {
  store: AppStoreApi
  clearAutoSaveTimer: EditorSaveQueue['clearAutoSaveTimer']
  bumpSaveGeneration: EditorSaveQueue['bumpSaveGeneration']
}

export function createEditorExternalChangeTabReset({
  store,
  clearAutoSaveTimer,
  bumpSaveGeneration
}: EditorExternalChangeTabResetOptions): (event: Event) => void {
  return (event: Event): void => {
    const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
    if (!detail) {
      return
    }

    const state = store.getState()
    const matchingFiles = getOpenFilesForExternalFileChange(state.openFiles, detail)
    if (matchingFiles.length === 0) {
      return
    }

    // Why: keep dirty drafts on external writes (data-loss half of #7265); mark changed-on-disk as backstop for tabs turned dirty during the notify debounce.
    const reloadingFiles = matchingFiles.filter((file) => !file.isDirty)
    for (const file of matchingFiles) {
      if (file.isDirty) {
        // Why: skip Orca's own-save echo, which routes here bypassing the watch hook's echo verification.
        if (!hasRecentSelfWrite(file.filePath, file.runtimeEnvironmentId)) {
          markFileChangedOnDisk(state, file, {
            connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
            origin: 'live'
          })
        }
        continue
      }
      clearAutoSaveTimer(file.id)
      bumpSaveGeneration(file.id)
      state.markFileDirty(file.id, false)
      // Why: about to reload fresh disk content, so a stale changed-on-disk mark is resolved.
      if (file.externalMutation === 'changed') {
        state.setExternalMutation(file.id, null)
      }
    }
    state.clearEditorDrafts(reloadingFiles.map((file) => file.id))
  }
}
