import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import {
  CellSelection,
  isInTable,
  moveCellForward,
  nextCell,
  selectionCell
} from '@tiptap/pm/tables'

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

// Tiptap HardBreak binds exactly Shift-Enter and Mod-Enter; a multi-cell selection cannot take a break.
function leavesEnterToHardBreak(event: KeyboardEvent, mod: boolean, editor: Editor): boolean {
  if (event.altKey || editor.state.selection instanceof CellSelection) {
    return false
  }
  return event.shiftKey ? !event.ctrlKey && !event.metaKey : mod
}

/** Move down or append a row on Enter; GFM cannot preserve additional in-cell paragraphs. */
export function handleRichMarkdownTableEnter(
  editor: Editor,
  event?: KeyboardEvent,
  mod = false
): boolean {
  if (!isInTable(editor.state) || (event && leavesEnterToHardBreak(event, mod, editor))) {
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
