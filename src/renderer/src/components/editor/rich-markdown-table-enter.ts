import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { isInTable, moveCellForward, nextCell, selectionCell } from '@tiptap/pm/tables'

function moveToVerticalNeighbor(editor: Editor, direction: 1 | -1): boolean {
  const { state, view } = editor
  const $nextCell = nextCell(selectionCell(state), 'vert', direction)
  if (!$nextCell) {
    return false
  }

  view.dispatch(
    state.tr
      .setSelection(TextSelection.between($nextCell, moveCellForward($nextCell)))
      .scrollIntoView()
  )
  return true
}

/**
 * Table Enter: move to the cell below instead of inserting an in-cell
 * paragraph (GFM cannot keep multi-line table cells). On the last row,
 * insert a row and move into it. Returns true when consumed inside a table.
 */
export function handleRichMarkdownTableEnter(editor: Editor): boolean {
  if (!isInTable(editor.state)) {
    return false
  }

  if (moveToVerticalNeighbor(editor, 1)) {
    return true
  }

  // Why: last-row Enter grows the table rather than inserting an in-cell hard
  // break that GFM serialization cannot keep.
  if (!editor.can().addRowAfter()) {
    return true
  }

  editor.commands.addRowAfter()
  // Selection stays in the original row; step down into the new one.
  moveToVerticalNeighbor(editor, 1)
  return true
}
