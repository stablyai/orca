import { useAppStore } from '@/store/index'
import {
  editorBufferIdOfView,
  editorBufferSiblingViewIds,
  isLastEditorBufferView
} from '@/store/slices/editor/buffers/editor-buffer-views'
import { discardEditorGenerations } from './editor-discard-epoch'
import { requestEditorSaveQuiesce } from '../../autosave/editor-autosave'
import { flushPendingEditorBuffer } from './editor-pending-flush'
import { pruneClosedOpenFileFromAllPartitions } from '@/lib/workspace/persistence/prune-closed-open-file'

/** Discard only the last view’s unsaved record; return an autosave hold release for use after tab cleanup. */
export async function discardEditorBuffer(fileId: string): Promise<() => void> {
  let release = (): void => {}
  if (!isLastEditorBufferView(useAppStore.getState(), fileId)) {
    return release
  }
  // Fence pending edits before flushing so intentional discards stay silent.
  const before = useAppStore.getState()
  discardEditorGenerations(
    editorBufferIdOfView(before, fileId),
    editorBufferSiblingViewIds(before, fileId)
  )
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
export async function discardEditorFileChangesAndClose(
  fileId: string,
  tabId?: string
): Promise<void> {
  // Capture before the close clears openFiles; superseded host partitions holding this file's
  // row would otherwise re-materialize the tab (with its draft) at the next hydration (#42761).
  const closing = useAppStore.getState().openFiles.find((file) => file.id === fileId)
  const release = await discardEditorBuffer(fileId)
  try {
    if (tabId) {
      useAppStore.getState().closeUnifiedTab(tabId)
    } else {
      useAppStore.getState().closeFile(fileId)
    }
  } finally {
    release()
  }
  if (closing) {
    void pruneClosedOpenFileFromAllPartitions(window.api.session, {
      worktreeId: closing.worktreeId,
      filePath: closing.filePath
    })
  }
}

