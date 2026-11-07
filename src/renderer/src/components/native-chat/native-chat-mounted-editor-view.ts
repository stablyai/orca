import { promptText } from './native-chat-prompt-document'
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

export function isNativeChatEditorCaretOnVisualEdge(
  editor: Editor,
  edge: 'start' | 'end'
): boolean {
  const { selection, doc } = editor.state
  if (!selection.empty) {
    return false
  }
  const before = promptText(doc, 0, selection.from)
  const after = promptText(doc, selection.from)
  // An empty composer has one line: no layout read on the path every recall starts from.
  if (before === '' && after === '') {
    return true
  }
  const beyond = edge === 'start' ? before : after
  // Why both: the text check covers other paragraphs, the view covers soft wraps.
  return !beyond.includes('\n') && editor.view.endOfTextblock(edge === 'start' ? 'up' : 'down')
}
