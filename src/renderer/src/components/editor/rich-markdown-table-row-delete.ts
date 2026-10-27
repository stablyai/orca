import type { Editor } from '@tiptap/react'
import type { Node as PmNode } from '@tiptap/pm/model'
import { isInTable, selectionCell } from '@tiptap/pm/tables'

/** Why: textContent alone is empty for image/embed-only cells, which do have content. */
function isEmptyCell(cell: PmNode): boolean {
  for (let index = 0; index < cell.childCount; index += 1) {
    const child = cell.child(index)
    if (!child.isTextblock || child.content.size > 0) {
      return false
    }
  }
  return true
}

function isHeaderRow(row: PmNode): boolean {
  return row.firstChild?.type.spec.tableRole === 'header_cell'
}

function isEmptyRow(row: PmNode): boolean {
  for (let index = 0; index < row.childCount; index += 1) {
    if (!isEmptyCell(row.child(index))) {
      return false
    }
  }
  return row.childCount > 0
}

/** Backspace removes empty rows/tables or moves to a previous cell; other content uses default deletion. */
export function handleRichMarkdownTableBackspace(editor: Editor): boolean {
  const { state } = editor
  if (!state.selection.empty || !isInTable(state)) {
    return false
  }

  // selectionCell resolves before the cell; its parent is the row and node(-1) is the table.
  const $cell = selectionCell(state)
  const cell = $cell.nodeAfter
  if (!cell || !isEmptyCell(cell)) {
    return false
  }

  // Only the first textblock’s start can drop a row; later empty paragraphs should join normally.
  if (state.selection.from !== $cell.pos + 2) {
    return false
  }

  if (!isEmptyRow($cell.parent)) {
    // Consume even at the first cell so ProseMirror cannot merge the table into preceding content.
    editor.commands.goToPreviousCell()
    return true
  }

  // deleteRow refuses the last row, so exit via deleteTable.
  if ($cell.node(-1).childCount <= 1) {
    return editor.commands.deleteTable()
  }

  // Keep empty headers because GFM would regenerate a deleted header on reload.
  if (isHeaderRow($cell.parent)) {
    return true
  }

  return editor.commands.deleteRow()
}
