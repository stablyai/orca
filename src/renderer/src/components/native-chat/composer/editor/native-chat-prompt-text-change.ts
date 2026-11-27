import { Slice } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import type { NativeChatTextChange } from './native-chat-markdown-list-lines'
import { promptTextContent } from './native-chat-prompt-document-text'
import { promptTextPosition } from './native-chat-prompt-document'

/** Applies text edits as one undo step; edits sit on plain text, so pills in between stay. */
export function applyNativeChatPromptTextChange(
  editor: Editor,
  change: NativeChatTextChange
): void {
  const { doc } = editor.state
  const tr = editor.state.tr
  // Last edit first, so the offsets of the earlier ones still hold.
  for (const edit of change.edits.toSorted((a, b) => b.from - a.from)) {
    const from = promptTextPosition(doc, edit.from, 'before')
    const to = promptTextPosition(doc, edit.to, 'after')
    if (edit.text === '') {
      tr.delete(from, to)
    } else {
      const content = editor.schema.nodeFromJSON(promptTextContent(edit.text))
      tr.replaceRange(from, to, new Slice(content.content, 1, 1))
    }
  }
  const { from, to } = change.selection
  tr.setSelection(
    TextSelection.create(tr.doc, promptTextPosition(tr.doc, from), promptTextPosition(tr.doc, to))
  )
  editor.view.dispatch(tr.scrollIntoView())
}
