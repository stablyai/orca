import type { AppStoreApi } from '../queue/editor-save-queue-contract'
import { editorBufferViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import { flushEditorViewsForSave } from '../flush/editor-pending-flush'

export async function adoptEditorSaveText(
  store: AppStoreApi,
  recordId: string,
  before: string,
  after: string,
  beforeAdopt?: () => void
): Promise<string> {
  if (after === before) {
    return after
  }
  const open = new Set(store.getState().openFiles.map((tab) => tab.id))
  const survivor = editorBufferViewIds(store.getState(), recordId).find((id) => open.has(id))
  if (survivor !== undefined) {
    // Flush view-held typing before deciding whether the formatter's input is still current.
    await flushEditorViewsForSave(store.getState, survivor)
    beforeAdopt?.()
    if (store.getState().editorDrafts[survivor] === before) {
      store.getState().setEditorDraft(survivor, after)
    }
  }
  return after
}
