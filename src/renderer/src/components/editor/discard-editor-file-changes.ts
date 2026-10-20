import { useAppStore } from '@/store'
import { hasOtherSavingEditorView } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import { requestEditorSaveQuiesce } from './editor-autosave'

/** "Don't Save": cancel pending saves, drop unsaved edits, then close the tab. */
export async function discardEditorFileChangesAndClose(
  fileId: string,
  closing?: ReadonlySet<string>
): Promise<void> {
  // Why: another tab of the file still shows these edits, so this tab only closes.
  if (hasOtherSavingEditorView(useAppStore.getState(), fileId, closing)) {
    useAppStore.getState().closeFile(fileId)
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
  state.closeFile(fileId)
}
