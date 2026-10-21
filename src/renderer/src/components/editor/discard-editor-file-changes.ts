import { useAppStore } from '@/store'
import {
  editorBufferIdOfView,
  isLastEditorBufferView
} from '@/store/slices/editor/buffers/editor-buffer-views'
import { bumpEditorDiscardEpoch } from './editor-discard-epoch'
import { requestEditorSaveQuiesce } from './editor-autosave'
import { flushPendingEditorBuffer } from './editor-pending-flush'

/**
 * Drops the unsaved edits `fileId` shows, unless another view still holds its record. Resolves to
 * the release of the autosave hold it keeps until the caller is done with the tab.
 */
export async function discardEditorBuffer(fileId: string): Promise<() => void> {
  let release = (): void => {}
  if (!isLastEditorBufferView(useAppStore.getState(), fileId)) {
    return release
  }
  // Why: flush first so a debounced rich edit can't re-dirty the tab after it is cleared.
  try {
    flushPendingEditorBuffer(useAppStore.getState(), fileId)
  } catch (error) {
    console.warn('Pending edit flush failed before discard', error)
  }
  const state = useAppStore.getState()
  // Why: before draining; dirty state can be republished later, the epoch can't.
  bumpEditorDiscardEpoch(editorBufferIdOfView(state, fileId))
  state.markFileDirty(fileId, false)
  // Why: a leftover draft makes closeFile keep a never-saved untitled placeholder on disk.
  state.clearEditorDraft(fileId)
  try {
    release = await requestEditorSaveQuiesce({ fileId, discard: true })
  } catch (error) {
    console.warn('Autosave settle failed before discard', error)
  }
  return release
}

/** "Don't Save": drop unsaved edits, let saves already writing finish, then close the tab. */
export async function discardEditorFileChangesAndClose(fileId: string): Promise<void> {
  const release = await discardEditorBuffer(fileId)
  try {
    useAppStore.getState().closeFile(fileId)
  } finally {
    release()
  }
}
