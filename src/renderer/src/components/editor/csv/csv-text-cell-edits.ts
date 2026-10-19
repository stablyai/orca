import { measureUtf8ByteLength } from '../../../../../shared/utf8-byte-limits'
import { assertCsvTableEditBytes } from './csv-table-edit-budget'
import { CSV_RECORD_BYTES } from './csv-byte-index'
import { csvRecordTokens } from './csv-source-record'
import { serializeCsvRecord } from './csv-serialization'
import type { CsvCellEdit, CsvTextDocument } from './csv-text-document'

export function editCsvTextCells(
  document: CsvTextDocument,
  edits: CsvCellEdit[],
  preservePendingDraft = false
): string {
  const changed = new Map<number, string[]>()
  for (const edit of edits) {
    if (
      !Number.isInteger(edit.row) ||
      edit.row < 0 ||
      edit.row >= document.rows.length ||
      !Number.isInteger(edit.column) ||
      edit.column < 0 ||
      edit.column >= document.columnCount
    ) {
      throw new Error('The selected CSV row or column no longer exists.')
    }
    if (!changed.has(edit.row)) {
      changed.set(edit.row, [...document.rows[edit.row]!])
    }
    const row = changed.get(edit.row)!
    while (row.length <= edit.column) {
      row.push('')
    }
    row[edit.column] = edit.value
  }
  const entries = [...changed.entries()]
    .filter(([index, values]) => {
      const original = document.rows[index]!
      return (
        values.length !== original.length ||
        values.some((value, column) => value !== original[column])
      )
    })
    .sort(([a], [b]) => a - b)
  let cells = document.cellCount
  let bytes = entries.reduce(
    (bytes, [index]) =>
      bytes -
      measureUtf8ByteLength(
        document.source.slice(document.starts[index], document.contentEnds[index])
      ).byteLength,
    document.byteLength
  )
  let previousEnd = 0
  const parts: string[] = []
  for (const [index, values] of entries) {
    const original = document.rows[index]!
    const record = serializeCsvRecord(
      values,
      document.delimiter,
      original,
      csvRecordTokens(document, index)
    )
    cells += values.length - original.length
    bytes += measureUtf8ByteLength(record).byteLength
    if (!preservePendingDraft) {
      if (cells > 1024 * 1024 + 1) {
        throw new Error('CSV contains too many cells to preview safely.')
      }
      if (measureUtf8ByteLength(record, { stopAfterBytes: CSV_RECORD_BYTES }).exceededLimit) {
        throw new Error('CSV record is too large to preview safely.')
      }
      assertCsvTableEditBytes(bytes)
    }
    parts.push(document.source.slice(previousEnd, document.starts[index]), record)
    previousEnd = document.contentEnds[index]!
  }
  if (!parts.length) {
    return document.source
  }
  parts.push(document.source.slice(previousEnd))
  return parts.join('')
}
