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
    // Same-record siblings match by path themselves; no separate expansion is needed.
    const matchingFiles = getOpenFilesForExternalFileChange(state.openFiles, detail, state)
    if (matchingFiles.length === 0) {
      return
    }

    // Preserve dirty model drafts, including clean sibling views; mark conflicts if typing began during notification debounce.
    const modelDirty = new Set(
      matchingFiles.filter((file) => isEditorModelDirty(state, file)).map((file) => file.id)
    )
    const reloadingFiles = matchingFiles.filter((file) => !modelDirty.has(file.id))
    for (const file of matchingFiles) {
      if (modelDirty.has(file.id)) {
        if (!file.isDirty) {
          continue
        }
        // Controller notifications bypass watcher verification; filter the app’s own save echoes here.
        if (!hasRecentSelfWrite(file.filePath, file.runtimeEnvironmentId)) {
          markFileChangedOnDisk(state, file, {
            connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
            origin: 'live'
          })
        }
        continue
      }
      // Clear dirty state to cancel autosave timers and make queued requests no-op.
      state.markFileDirty(file.id, false)
      if (file.externalMutation === 'changed') {
        state.setExternalMutation(file.id, null)
      }
    }
    state.clearEditorDrafts(reloadingFiles.map((file) => file.id))
  }
}
