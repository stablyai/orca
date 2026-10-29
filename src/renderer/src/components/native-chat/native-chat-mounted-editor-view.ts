import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'

/** The editor's view once mounted; null before mount or after destroy, when tiptap's view throws. */
export function mountedEditorView(editor: Editor): EditorView | null {
  if (editor.isDestroyed) {
    return null
  }
  try {
    const { view } = editor
    // Unmounted, tiptap hands back a stand-in whose DOM access throws.
    return view.dom ? view : null
  } catch {
    return null
  }
}
