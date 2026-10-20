import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  editorBufferFreshnessKeyOf,
  markEditorBufferNewer
} from '@/store/slices/editor/buffers/editor-buffer-read-freshness'

/** Supersedes every read of the changed files that started before the change, in any panel. */
export function supersedeEditorBufferReadsForExternalChange(
  matching: (openFiles: OpenFile[]) => OpenFile[]
): void {
  const state = useAppStore.getState()
  if (!state) {
    return
  }
  const recordIds = new Set(
    matching(state.openFiles).map((file) => editorBufferFreshnessKeyOf(state, file.id))
  )
  for (const recordId of recordIds) {
    markEditorBufferNewer(recordId)
  }
}
