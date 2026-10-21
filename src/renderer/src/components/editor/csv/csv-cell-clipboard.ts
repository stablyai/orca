import {
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  assertClipboardTextWithinLimit,
  assertClipboardTextWriteWithinLimit
} from '../../../../../shared/clipboard-text'
import { CSV_MAX_COLUMNS, CSV_RECORD_BYTES } from './csv-byte-index'
import { measureUtf8ByteLength } from '../../../../../shared/utf8-byte-limits'
import { parseCsv } from './csv-parse'
import { serializeCsvRecord } from './csv-serialization'
import { csvSelectionBounds, type CsvCellSelection } from './csv-cell-selection'
import { csvSourceRow } from './csv-inspection'
import type { CsvCellEdit } from './csv-text-document'

const CLIPBOARD_CELLS = 1024 * 1024

export function copyCsvSelection(
  selection: CsvCellSelection,
  rows: readonly string[][],
  inspectionRows: readonly number[] | null
): string {
  const bounds = csvSelectionBounds(selection)
  const records: string[] = []
  let cells = 0
  let bytes = 0
  for (let row = bounds.firstRow; row <= bounds.lastRow; row += 1) {
    const source = rows[csvSourceRow(row, inspectionRows)]
    if (!source) {
      throw new Error('The selected CSV row no longer exists.')
    }
    const values: string[] = []
    for (let column = bounds.firstColumn; column <= bounds.lastColumn; column += 1) {
      if (++cells > CLIPBOARD_CELLS) {
        throw new Error('Select fewer cells to copy at once.')
      }
      values.push(source[column] ?? '')
    }
    const record = serializeCsvRecord(values, '\t')
    bytes +=
      measureUtf8ByteLength(record, { stopAfterBytes: CLIPBOARD_TEXT_WRITE_MAX_BYTES }).byteLength +
      (records.length ? 1 : 0)
    if (bytes > CLIPBOARD_TEXT_WRITE_MAX_BYTES) {
      throw new Error('Selected cells are too large to copy safely.')
    }
    records.push(record)
  }
  return assertClipboardTextWriteWithinLimit(records.join('\n'))
}

export function pasteCsvSelection(
  text: string,
  selection: CsvCellSelection,
  rows: readonly string[][],
  columnCount: number,
  inspectionRows: readonly number[] | null
): CsvCellEdit[] {
  assertClipboardTextWithinLimit(text)
  const pasted =
    text === ''
      ? [['']]
      : parseCsv(text, '\t', {
          maxCells: CLIPBOARD_CELLS,
          maxColumns: CSV_MAX_COLUMNS,
          maxRecordLength: CSV_RECORD_BYTES,
          stripBom: false
        }).rows
  const bounds = csvSelectionBounds(selection)
  const fill = pasted.length === 1 && pasted[0]?.length === 1
  const height = fill ? bounds.lastRow - bounds.firstRow + 1 : pasted.length
  const width = fill
    ? bounds.lastColumn - bounds.firstColumn + 1
    : pasted.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const viewRowCount = inspectionRows ? inspectionRows.length + 1 : rows.length
  if (bounds.firstRow + height > viewRowCount || bounds.firstColumn + width > columnCount) {
    throw new Error('Paste exceeds the table. Add rows or columns first.')
  }
  if (height * width > CLIPBOARD_CELLS) {
    throw new Error('Select fewer cells to paste at once.')
  }
  const edits: CsvCellEdit[] = []
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      edits.push({
        row: csvSourceRow(bounds.firstRow + row, inspectionRows),
        column: bounds.firstColumn + column,
        value: fill ? pasted[0]![0]! : (pasted[row]?.[column] ?? '')
      })
    }
  }
  return edits
}
