import type { Editor } from '@tiptap/react'
import { completeRichMarkdownSelection } from './drag-selection-guard'

export function flushPendingProseMirrorSelection(editor: Editor): void {
  let view: Editor['view']
  try {
    view = editor.view
    // External controls use the model once another owner has taken native focus.
    if (!view.hasFocus()) {
      return
    }
  } catch {
    return
  }
  completeRichMarkdownSelection(view)
}
