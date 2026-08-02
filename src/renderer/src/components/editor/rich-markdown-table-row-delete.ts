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

/**
 * Structural Backspace inside tables:
 * 1. Fully empty row → delete row (or the table if it was the last row)
 * 2. Empty cell in a row that still has content → step to the previous cell
 * 3. Otherwise fall through to the default content delete
 */
export function handleRichMarkdownTableBackspace(editor: Editor): boolean {
  const { state } = editor
  if (!state.selection.empty || !isInTable(state)) {
    return false
  }

  // selectionCell resolves *before* the cell: nodeAfter is the cell, parent the
  // row, node(-1) the table.
  const $cell = selectionCell(state)
  const cell = $cell.nodeAfter
  if (!cell || !isEmptyCell(cell)) {
    return false
  }

  // $cell.pos + 2 is the start of the cell's first textblock. A caret past it
  // sits in a second empty paragraph, which should join rather than drop a row.
  if (state.selection.from !== $cell.pos + 2) {
    return false
  }

  if (!isEmptyRow($cell.parent)) {
    // Step back a cell instead of joining across the cell boundary into the
    // previous cell's text. Consume either way so ProseMirror never merges the
    // table into whatever precedes it.
    editor.commands.goToPreviousCell()
    return true
  }

  // Why: prosemirror-tables deleteRow refuses when only one row remains;
  // deleteTable is the correct last-row exit.
  if ($cell.node(-1).childCount <= 1) {
    return editor.commands.deleteTable()
  }

  // Why: GFM re-synthesizes an empty header on serialize, so deleting the
  // header row would vanish from the editor but return on the next reload.
  if (isHeaderRow($cell.parent)) {
    return true
  }

  return editor.commands.deleteRow()
}
