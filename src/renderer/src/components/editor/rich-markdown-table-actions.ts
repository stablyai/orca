import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { CellSelection, selectionCell } from '@tiptap/pm/tables'

export type RichMarkdownTableAction =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'delete-row'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'delete-column'
  | 'delete-table'

export type RichMarkdownTableActionTarget =
  | { cellPosition: number }
  | { clientX: number; clientY: number }

type TableContext = {
  columnCount: number
  hasHeaderRow: boolean
  rowCount: number
  selectedCellPositions: Set<number>
  tablePosition: number
}

function cellPositionAtDocumentPosition(editor: Editor, position: number): number | null {
  const $position = editor.state.doc.resolve(position)
  for (let depth = $position.depth; depth > 0; depth -= 1) {
    const role = $position.node(depth).type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') {
      return $position.before(depth)
    }
  }
  return null
}

export function richMarkdownTableCellPositionAtElement(
  editor: Editor,
  cell: HTMLTableCellElement
): number | null {
  try {
    return cellPositionAtDocumentPosition(editor, editor.view.posAtDOM(cell, 0))
  } catch {
    return null
  }
}

function cellPositionAtTarget(
  editor: Editor,
  target: RichMarkdownTableActionTarget
): number | null {
  if ('cellPosition' in target) {
    return cellPositionAtDocumentPosition(editor, target.cellPosition + 1)
  }
  try {
    const position = editor.view.posAtCoords({ left: target.clientX, top: target.clientY })?.pos
    return position === undefined ? null : cellPositionAtDocumentPosition(editor, position)
  } catch {
    return null
  }
}

function normalizeMultiCellSelection(editor: Editor): CellSelection | null {
  const { selection } = editor.state
  if (selection instanceof CellSelection) {
    return selection
  }
  if (selection.empty) {
    return null
  }
  const anchor = cellPositionAtDocumentPosition(editor, selection.from)
  const head = cellPositionAtDocumentPosition(editor, selection.to)
  if (anchor === null || head === null || anchor === head) {
    return null
  }
  try {
    return CellSelection.create(editor.state.doc, anchor, head)
  } catch {
    return null
  }
}

function retargetTableSelection(
  editor: Editor,
  target: RichMarkdownTableActionTarget | undefined
): number | null {
  const existingMultiCellSelection = normalizeMultiCellSelection(editor)
  if (existingMultiCellSelection && !(editor.state.selection instanceof CellSelection)) {
    editor.view.dispatch(editor.state.tr.setSelection(existingMultiCellSelection))
  }
  if (!target) {
    return editor.isActive('table') ? selectionCell(editor.state).pos : null
  }

  const cellPosition = cellPositionAtTarget(editor, target)
  if (cellPosition === null) {
    return null
  }
  const selection = editor.state.selection
  let selectedTarget = false
  if (selection instanceof CellSelection) {
    selection.forEachCell((_cell, position) => {
      selectedTarget ||= position === cellPosition
    })
  }
  if (!selectedTarget) {
    const caret = TextSelection.near(editor.state.doc.resolve(cellPosition + 1))
    editor.view.dispatch(editor.state.tr.setSelection(caret))
  }
  return cellPosition
}

function tableContext(editor: Editor, targetCellPosition: number): TableContext | null {
  const $cell = editor.state.doc.resolve(targetCellPosition)
  if (
    $cell.nodeAfter?.type.spec.tableRole !== 'cell' &&
    $cell.nodeAfter?.type.spec.tableRole !== 'header_cell'
  ) {
    return null
  }
  let table: ReturnType<typeof $cell.node> | null = null
  let tablePosition = 0
  for (let depth = $cell.depth; depth > 0; depth -= 1) {
    const node = $cell.node(depth)
    if (node.type.spec.tableRole === 'table') {
      table = node
      tablePosition = $cell.before(depth)
      break
    }
  }
  if (!table) {
    return null
  }
  const selectedCellPositions = new Set<number>()
  const selection = editor.state.selection
  if (selection instanceof CellSelection) {
    selection.forEachCell((_cell, position) => selectedCellPositions.add(position))
  } else {
    selectedCellPositions.add(targetCellPosition)
  }
  return {
    columnCount: table.firstChild?.childCount ?? 0,
    hasHeaderRow: table.firstChild?.firstChild?.type.spec.tableRole === 'header_cell',
    rowCount: table.childCount,
    selectedCellPositions,
    tablePosition
  }
}

function selectedTableCoverage(
  editor: Editor,
  context: TableContext
): {
  columns: Set<number>
  rows: Set<number>
  includesHeader: boolean
} {
  const table = editor.state.doc.nodeAt(context.tablePosition)
  const columns = new Set<number>()
  const rows = new Set<number>()
  let includesHeader = false
  table?.forEach((row, rowOffset, rowIndex) => {
    row.forEach((cell, cellOffset, columnIndex) => {
      const position = context.tablePosition + 2 + rowOffset + cellOffset
      if (!context.selectedCellPositions.has(position)) {
        return
      }
      rows.add(rowIndex)
      columns.add(columnIndex)
      includesHeader ||= cell.type.spec.tableRole === 'header_cell'
    })
  })
  return { columns, rows, includesHeader }
}

export function runRichMarkdownTableAction(
  editor: Editor,
  action: RichMarkdownTableAction,
  target?: RichMarkdownTableActionTarget
): boolean {
  if (!editor.isEditable) {
    return false
  }
  const targetCellPosition = retargetTableSelection(editor, target)
  if (targetCellPosition === null) {
    return false
  }
  const context = tableContext(editor, targetCellPosition)
  if (!context) {
    return false
  }
  const coverage = selectedTableCoverage(editor, context)
  const chain = editor.chain().focus()

  switch (action) {
    case 'insert-row-above':
      if (context.hasHeaderRow && coverage.includesHeader) {
        return false
      }
      return chain.addRowBefore().run()
    case 'insert-row-below':
      return chain.addRowAfter().run()
    case 'delete-row':
      if (coverage.rows.size >= context.rowCount) {
        return chain.deleteTable().run()
      }
      if (context.hasHeaderRow && coverage.includesHeader) {
        return false
      }
      return chain.deleteRow().run()
    case 'insert-column-left':
      return chain.addColumnBefore().run()
    case 'insert-column-right':
      return chain.addColumnAfter().run()
    case 'delete-column':
      if (coverage.columns.size >= context.columnCount) {
        return chain.deleteTable().run()
      }
      return chain.deleteColumn().run()
    case 'delete-table':
      return chain.deleteTable().run()
  }
}
