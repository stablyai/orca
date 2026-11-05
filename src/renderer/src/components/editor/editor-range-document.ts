import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import type { RuntimeFileReadArgs } from '@/runtime/runtime-file-client-types'
import { openRuntimeRangeDocument } from '@/runtime/runtime-range-document'
import { isEditorModelDirty } from './save/queue/editor-save-disk-precondition'

export const EDITOR_RANGE_DIRTY_MESSAGE =
  'Save or discard unsaved changes before reading file ranges, then reload explicitly.'

export function isEditorRangeDocumentDirty(
  state: AppState,
  fileId: string,
  fallback?: OpenFile
): boolean {
  const file = state.openFiles.find((tab) => tab.id === fileId) ?? fallback
  return file !== undefined && isEditorModelDirty(state, file)
}

/** Ranges describe saved file bytes; a shared editor draft invalidates that file-backed view. */
export async function openEditorRangeDocument(
  args: RuntimeFileReadArgs,
  fileId: string,
  fallback?: OpenFile
) {
  const assertClean = () => {
    if (isEditorRangeDocumentDirty(useAppStore.getState(), fileId, fallback)) {
      throw Object.assign(new Error(EDITOR_RANGE_DIRTY_MESSAGE), { code: 'range_document_dirty' })
    }
  }
  const document = await openRuntimeRangeDocument(args, assertClean)
  try {
    assertClean()
  } catch (error) {
    document.dispose()
    throw error
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (
      state.openFiles === previous.openFiles &&
      state.editorBufferIdOf === previous.editorBufferIdOf &&
      state.editorBufferViews === previous.editorBufferViews
    )
      return
    if (isEditorRangeDocumentDirty(state, fileId, fallback)) document.invalidate()
  })
  const dispose = document.onDispose
  document.onDispose = () => {
    unsubscribe()
    dispose?.()
  }
  return document
}
