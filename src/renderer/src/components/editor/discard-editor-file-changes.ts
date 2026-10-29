import { useAppStore } from '@/store'
import {
  editorBufferIdOfView,
  isLastEditorBufferView
} from '@/store/slices/editor/buffers/editor-buffer-views'
import { bumpEditorDiscardEpoch } from './editor-discard-epoch'
import { requestEditorSaveQuiesce } from './editor-autosave'
import { flushPendingEditorBuffer } from './editor-pending-flush'

/** Discard only the last view’s unsaved record; return an autosave hold release for use after tab cleanup. */
export async function discardEditorBuffer(fileId: string): Promise<() => void> {
  let release = (): void => {}
  if (!isLastEditorBufferView(useAppStore.getState(), fileId)) {
    return release
  }
  // Fence pending edits before flushing so intentional discards stay silent.
  bumpEditorDiscardEpoch(editorBufferIdOfView(useAppStore.getState(), fileId))
  try {
    flushPendingEditorBuffer(useAppStore.getState(), fileId)
  } catch (error) {
    console.warn('Pending edit flush failed before discard', error)
  }
  const state = useAppStore.getState()
  state.markFileDirty(fileId, false)
  // Leftover drafts make closeFile retain never-saved untitled placeholders on disk.
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
