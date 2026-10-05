import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  isExternalReloadableEditorTab,
  ORCA_EDITOR_SAVE_FILE_EVENT,
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  requestEditorFileReload,
  requestEditorSaveQuiesce,
  type EditorSaveFileTarget
} from './editor-autosave'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { flushPendingEditorChange } from './editor-pending-flush'
import { reloadTabContentFromDisk } from './ExternalFileChangeBanner'

// Keep the draft until a successful read, and let newer edits or saves cancel the discard.
export async function requestEditorTabDiskReload(fileId: string): Promise<void> {
  const initial = useAppStore.getState().openFiles.find((file) => file.id === fileId)
  if (!initial || !isExternalReloadableEditorTab(initial)) {
    return
  }
  flushPendingEditorChange(fileId)
  const state = useAppStore.getState()
  const file = state.openFiles.find((file) => file.id === fileId)
  if (!file || !isExternalReloadableEditorTab(file)) {
    return
  }
  const draft = state.editorDrafts[fileId]
  let saveRequested = false
  const onSave = (event: Event): void => {
    if (event instanceof CustomEvent) {
      const detail: EditorSaveFileTarget | undefined = event.detail
      if (detail?.fileId === fileId) {
        saveRequested = true
      }
    }
  }
  const onSaveAll = (): void => {
    if (useAppStore.getState().openFiles.some((file) => file.id === fileId && file.isDirty)) {
      saveRequested = true
    }
  }
  // Save intent supersedes the read even when its bytes stay unchanged or its write fails.
  window.addEventListener(ORCA_EDITOR_SAVE_FILE_EVENT, onSave)
  window.addEventListener(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, onSave)
  window.addEventListener(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, onSaveAll)
  let finish = (): void => {}
  const resumeAutoSave = new Promise<void>((resolve) => {
    finish = () => {
      window.removeEventListener(ORCA_EDITOR_SAVE_FILE_EVENT, onSave)
      window.removeEventListener(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, onSave)
      window.removeEventListener(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, onSaveAll)
      resolve()
    }
  })
  await requestEditorSaveQuiesce({ fileId }, resumeAutoSave)
  let applied = false
  const claimed = requestEditorFileReload({
    onSettled: finish,
    fileId,
    beforeApply: () => {
      if (saveRequested) {
        return false
      }
      if (applied) {
        return true
      }
      flushPendingEditorChange(fileId)
      const current = useAppStore.getState()
      const live = current.openFiles.find((file) => file.id === fileId)
      if (
        !live ||
        live.filePath !== file.filePath ||
        live.lastKnownDiskSignature !== file.lastKnownDiskSignature ||
        current.editorDrafts[fileId] !== draft
      ) {
        return false
      }
      applied = true
      reloadTabContentFromDisk(live, () => {})
      return true
    },
    onError: (error) => {
      toast.error(translate('components.editor.reloadFailed', 'Could not reload from disk'), {
        description: error instanceof Error ? error.message : String(error)
      })
    }
  })
  if (!claimed) {
    finish()
  }
}
