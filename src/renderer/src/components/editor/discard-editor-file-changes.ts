import { useAppStore } from '@/store'
import { isLastEditorBufferView } from '@/store/slices/editor/buffers/editor-buffer-views'
import { requestEditorSaveQuiesce } from './editor-autosave'

/** Drops the unsaved edits `fileId` shows, unless another view still holds its record. */
export async function discardEditorBuffer(fileId: string): Promise<void> {
  if (!isLastEditorBufferView(useAppStore.getState(), fileId)) {
    return
  }
  // Why: "Don't Save" must win over any pending autosave write for the same tab.
  try {
    await requestEditorSaveQuiesce({ fileId })
  } catch (error) {
    console.warn('Autosave quiesce failed before discard', error)
  }
  const state = useAppStore.getState()
  state.markFileDirty(fileId, false)
  // Why: a leftover draft makes closeFile keep a never-saved untitled placeholder on disk.
  state.clearEditorDraft(fileId)
}

/** "Don't Save": cancel pending saves, drop unsaved edits, then close the tab. */
export async function discardEditorFileChangesAndClose(fileId: string): Promise<void> {
  await discardEditorBuffer(fileId)
  useAppStore.getState().closeFile(fileId)
}
