import type { Editor } from '@tiptap/react'

/**
 * Table Tab: move between cells; Tab past the last cell inserts a row.
 * Returns true when the key should be consumed (always inside a table).
 */
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

  // Why: match TipTap Table shortcuts — last-cell Tab grows the table instead
  // of letting focus escape the editor.
  if (editor.can().addRowAfter()) {
    editor.chain().addRowAfter().goToNextCell().run()
  }

  return true
}
