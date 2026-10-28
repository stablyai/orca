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

/** Move down or append a row on Enter; GFM cannot preserve additional in-cell paragraphs. */
export function handleRichMarkdownTableEnter(editor: Editor): boolean {
  if (!isInTable(editor.state)) {
    return false
  }

  if (moveToVerticalNeighbor(editor, 1)) {
    return true
  }

  if (!editor.can().addRowAfter()) {
    return true
  }

  editor.commands.addRowAfter()
  moveToVerticalNeighbor(editor, 1)
  return true
}
