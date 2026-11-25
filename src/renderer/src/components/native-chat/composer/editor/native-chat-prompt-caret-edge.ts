import { mountedEditorView } from './native-chat-mounted-editor-view'
import type { Editor } from '@tiptap/react'
import { promptText } from './native-chat-prompt-document'

export function nativeChatCaretOnVisualEdge(editor: Editor, edge: 'start' | 'end'): boolean {
  const { selection, doc } = editor.state
  if (!selection.empty) {
    return false
  }
  const before = promptText(doc, 0, selection.from)
  const after = promptText(doc, selection.from)
  // An empty composer has one line, so it needs no layout read.
  if (before === '' && after === '') {
    return true
  }
  const beyond = edge === 'start' ? before : after
  // The text check covers other paragraphs; the view covers soft wraps.
  return (
    !beyond.includes('\n') &&
    mountedEditorView(editor)?.endOfTextblock(edge === 'start' ? 'up' : 'down') === true
  )
}
