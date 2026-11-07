import { CSV_MAX_COLUMNS } from './csv-byte-index'
import { CSV_MAX_COLUMN_WIDTH, CSV_MIN_COLUMN_WIDTH } from './csv-column-width-limits'
import { readFileViewPreference, writeFileViewPreference } from '../file-view-preference-storage'
import type { CsvTableMutation } from './csv-text-document'

export const CSV_COLUMN_WIDTHS_STORAGE_KEY = 'orca.csv.column-widths.v1'
export type CsvColumnWidths = Record<number, number>

export function readCsvColumnWidths(fileKey: string): CsvColumnWidths {
  const stored = readFileViewPreference(CSV_COLUMN_WIDTHS_STORAGE_KEY, fileKey)
  const result: CsvColumnWidths = {}
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return result
  }
  for (const [key, width] of Object.entries(stored)) {
    const index = Number(key)
    if (
      Number.isInteger(index) &&
      String(index) === key &&
      index >= 0 &&
      index < CSV_MAX_COLUMNS &&
      typeof width === 'number' &&
      Number.isFinite(width) &&
      width >= CSV_MIN_COLUMN_WIDTH &&
      width <= CSV_MAX_COLUMN_WIDTH
    ) {
      result[index] = width
    }
  }
  return result
}

export function writeCsvColumnWidths(fileKey: string, widths: CsvColumnWidths): void {
  writeFileViewPreference(CSV_COLUMN_WIDTHS_STORAGE_KEY, fileKey, widths)
}

export function remapCsvColumnWidths(
  widths: CsvColumnWidths,
  count: number,
  mutation: CsvTableMutation
): CsvColumnWidths {
  const columns = Array.from({ length: count }, (_, index) => index)
  if (mutation.kind === 'insert-column') {
    columns.splice(mutation.at, 0, -1)
  } else if (mutation.kind === 'delete-columns') {
    const deleted = new Set(mutation.columns)
    return Object.fromEntries(
      columns
        .filter((column) => !deleted.has(column))
        .flatMap((column, index) => (widths[column] === undefined ? [] : [[index, widths[column]]]))
    )
  } else if (mutation.kind === 'move-column') {
    columns.splice(mutation.to, 0, columns.splice(mutation.from, 1)[0]!)
  } else {
    return widths
  }
  return Object.fromEntries(
    columns.flatMap((column, index) =>
      widths[column] === undefined ? [] : [[index, widths[column]]]
    )
  )
}
