export type CsvCellPosition = { row: number; column: number }
export type CsvCellSelection = { anchor: CsvCellPosition; focus: CsvCellPosition }

export function remapCsvSelectionAfterColumnMove(
  selection: CsvCellSelection | null,
  from: number,
  to: number
): CsvCellSelection | null {
  if (!selection) {
    return null
  }
  const moved = (column: number): number => {
    if (column === from) {
      return to
    }
    if (from < to && column > from && column <= to) {
      return column - 1
    }
    if (from > to && column >= to && column < from) {
      return column + 1
    }
    return column
  }
  return {
    anchor: { ...selection.anchor, column: moved(selection.anchor.column) },
    focus: { ...selection.focus, column: moved(selection.focus.column) }
  }
}

export function csvSelectionBounds(selection: CsvCellSelection) {
  return {
    firstRow: Math.min(selection.anchor.row, selection.focus.row),
    lastRow: Math.max(selection.anchor.row, selection.focus.row),
    firstColumn: Math.min(selection.anchor.column, selection.focus.column),
    lastColumn: Math.max(selection.anchor.column, selection.focus.column)
  }
}

export function csvCellIsSelected(
  selection: CsvCellSelection | null,
  row: number,
  column: number
): boolean {
  if (!selection) {
    return false
  }
  const bounds = csvSelectionBounds(selection)
  return (
    row >= bounds.firstRow &&
    row <= bounds.lastRow &&
    column >= bounds.firstColumn &&
    column <= bounds.lastColumn
  )
}

export function moveCsvSelection(
  selection: CsvCellSelection | null,
  row: number,
  column: number,
  extend: boolean
): CsvCellSelection {
  const focus = { row, column }
  return { anchor: extend && selection ? selection.anchor : focus, focus }
}
