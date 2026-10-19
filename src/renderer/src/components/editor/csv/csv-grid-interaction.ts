import type { ClipboardEvent, KeyboardEvent } from 'react'
import type { CsvCellPosition, CsvCellSelection } from './csv-cell-selection'

export type CsvCellEditSession = {
  position: CsvCellPosition
  value: string
  sourceRow: number
  source: string
  wasDirty: boolean
}

export type CsvGridInteraction = {
  selection: CsvCellSelection | null
  focusVersion: number
  ownerId: string
  editing: { position: CsvCellPosition; value: string } | null
  select: (row: number, column: number, extend: boolean) => boolean
  edit: (row: number, column: number) => void
  change: (value: string) => void
  commit: () => boolean
  cancel: () => void
  save: () => void
  keyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  copy: (event: ClipboardEvent<HTMLDivElement>) => void
  paste: (event: ClipboardEvent<HTMLDivElement>) => void
}
