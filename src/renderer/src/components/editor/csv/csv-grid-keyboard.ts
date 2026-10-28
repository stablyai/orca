import type { KeyboardEvent } from 'react'
import type { CsvCellSelection } from './csv-cell-selection'

export function csvGridKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  {
    selection,
    columns,
    count,
    copy,
    paste,
    save,
    edit,
    clear,
    cancel,
    select,
    selectAll
  }: {
    selection: CsvCellSelection | null
    columns: number
    count: number
    copy: () => Promise<void>
    paste: () => Promise<void>
    save: () => Promise<void>
    edit: (row: number, column: number) => void
    clear: () => void
    cancel: () => void
    select: (row: number, column: number, extend: boolean) => boolean
    selectAll: (selection: CsvCellSelection) => void
  }
): void {
  if (
    event.target !== event.currentTarget ||
    event.nativeEvent.isComposing ||
    event.defaultPrevented
  ) {
    return
  }
  const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
  if (modifier && ['c', 'v', 's', 'a'].includes(event.key.toLowerCase())) {
    event.preventDefault()
    if (event.key.toLowerCase() === 'c') {
      void copy()
    }
    if (event.key.toLowerCase() === 'v') {
      void paste()
    }
    if (event.key.toLowerCase() === 's') {
      void save()
    }
    if (event.key.toLowerCase() === 'a' && columns) {
      selectAll({
        anchor: { row: 0, column: 0 },
        focus: { row: count, column: columns - 1 }
      })
    }
    return
  }
  const active = selection?.focus ?? { row: 0, column: 0 }
  if (event.key === 'Enter' || event.key === 'F2') {
    event.preventDefault()
    edit(active.row, active.column)
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    clear()
  } else if (event.key === 'Escape') {
    cancel()
  } else if (
    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)
  ) {
    event.preventDefault()
    let row = active.row
    let column = active.column
    if (event.key === 'ArrowUp') {
      row -= 1
    }
    if (event.key === 'ArrowDown') {
      row += 1
    }
    if (event.key === 'ArrowLeft') {
      column -= 1
    }
    if (event.key === 'ArrowRight') {
      column += 1
    }
    if (event.key === 'Home') {
      column = 0
      if (modifier) {
        row = 0
      }
    }
    if (event.key === 'End') {
      column = columns - 1
      if (modifier) {
        row = count
      }
    }
    if (event.key === 'Tab') {
      column += event.shiftKey ? -1 : 1
      if (column >= columns) {
        column = 0
        row += 1
      }
      if (column < 0) {
        column = columns - 1
        row -= 1
      }
    }
    select(
      Math.max(0, Math.min(count, row)),
      Math.max(0, Math.min(columns - 1, column)),
      event.shiftKey && event.key !== 'Tab'
    )
  }
}
