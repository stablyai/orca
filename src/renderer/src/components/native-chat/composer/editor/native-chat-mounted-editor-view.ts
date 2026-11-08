import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import { getOverlayFocusOwners } from '@/lib/overlay-focus-ownership'

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

export function focusMountedNativeChatEditor(editor: Editor): void {
  const view = mountedEditorView(editor)
  if (!view || getOverlayFocusOwners(view.dom).length > 0) {
    return
  }
  // Focus the view so an inserted caret replaces the stale DOM selection.
  view.focus()
  if (!editor.isEditable) {
    view.dom.focus()
  }
}
