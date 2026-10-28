import type { Editor } from '@tiptap/react'

/** Consume table Tab/Shift+Tab, appending a row after the last cell. */
export function handleRichMarkdownTableTab(editor: Editor, shiftKey: boolean): boolean {
  if (!editor.isActive('table')) {
    return false
  }

  if (shiftKey) {
    editor.commands.goToPreviousCell()
    return true
  }

  if (editor.commands.goToNextCell()) {
    return true
  }

  // Append rather than letting last-cell Tab escape the editor, matching Tiptap.
  if (editor.can().addRowAfter()) {
    editor.chain().addRowAfter().goToNextCell().run()
  }

  return true
}
