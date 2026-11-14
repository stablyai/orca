import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { EditorSaveResult } from '../save/queue/editor-save-disk-precondition'

type EditorSaveNow = (file: OpenFile) => Promise<EditorSaveResult>

let saveNow: EditorSaveNow | null = null

/** Registered by the autosave controller, the only owner of the save queue. */
export function registerEditorSaveNow(handler: EditorSaveNow): () => void {
  saveNow = handler
  return () => {
    if (saveNow === handler) {
      saveNow = null
    }
  }
}

/** Saves through the same queue as Ctrl+S, so it works without the file's editor mounted. */
export function saveEditorFileNow(file: OpenFile): Promise<EditorSaveResult> {
  return saveNow ? saveNow(file) : Promise.resolve('failed')
}
