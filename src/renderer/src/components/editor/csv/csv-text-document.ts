import { measureUtf8ByteLength } from '../../../../../shared/utf8-byte-limits'
import { parseCsv } from './csv-parse'
import { CSV_MAX_COLUMNS, CSV_RECORD_BYTES } from './csv-byte-index'
import { assertCsvTableEditBytes } from './csv-table-edit-budget'
import { editCsvTextCells } from './csv-text-cell-edits'
import { csvRecordTokens } from './csv-source-record'
import { serializeCsvRecord } from './csv-serialization'

export type CsvTextDocument = {
  source: string
  delimiter: string
  rows: string[][]
  columnCount: number
  byteLength: number
  cellCount: number
  starts: Uint32Array
  contentEnds: Uint32Array
  ends: Uint32Array
  lineEnding: string
  bom: string
}

export type CsvCellEdit = { row: number; column: number; value: string }
export type CsvTableMutation =
  | { kind: 'cells'; edits: CsvCellEdit[] }
  | { kind: 'insert-rows'; at: number; rows: string[][] }
  | { kind: 'delete-rows'; rows: number[] }
  | { kind: 'insert-column'; at: number; label: string }
  | { kind: 'delete-columns'; columns: number[] }
  | { kind: 'move-column'; from: number; to: number }

export function parseCsvTextDocument(source: string, delimiter: string): CsvTextDocument {
  const starts: number[] = []
  const contentEnds: number[] = []
  const ends: number[] = []
  const parsed = parseCsv(source, delimiter, {
    maxCells: 1024 * 1024 + 1,
    maxColumns: CSV_MAX_COLUMNS,
    maxRecordLength: CSV_RECORD_BYTES,
    onRecord: (start, contentEnd, end) => {
      starts.push(start)
      contentEnds.push(contentEnd)
      ends.push(end)
    }
  })
  const terminated = ends.findIndex((end, index) => end > contentEnds[index]!)
  return {
    source,
    delimiter,
    rows: parsed.rows,
    columnCount: parsed.maxColumns,
    byteLength: measureUtf8ByteLength(source).byteLength,
    cellCount: parsed.rows.reduce((count, row) => count + row.length, 0),
    starts: Uint32Array.from(starts),
    contentEnds: Uint32Array.from(contentEnds),
    ends: Uint32Array.from(ends),
    lineEnding: terminated === -1 ? '\n' : source.slice(contentEnds[terminated], ends[terminated]),
    bom: source.startsWith('\ufeff') ? '\ufeff' : ''
  }
}

function checkedIndex(index: number, count: number, inserting = false): void {
  if (!Number.isInteger(index) || index < 0 || index >= count + (inserting ? 1 : 0)) {
    throw new Error('The selected CSV row or column no longer exists.')
  }
}

export function mutateCsvTextDocument(
  document: CsvTextDocument,
  mutation: CsvTableMutation
): string {
  if (mutation.kind === 'cells') {
    return editCsvTextCells(document, mutation.edits)
  }
  let rows = [...document.rows]
  let sourceRows = rows.map((_, index) => index)
  let columns = Array.from({ length: document.columnCount }, (_, index) => index)
  if (mutation.kind === 'insert-rows') {
    checkedIndex(mutation.at, rows.length, true)
    if (mutation.rows.some((row) => row.length > CSV_MAX_COLUMNS)) {
      throw new Error('CSV exceeds the 4,096 column limit.')
    }
    rows = [...rows.slice(0, mutation.at), ...mutation.rows, ...rows.slice(mutation.at)]
    sourceRows = [
      ...sourceRows.slice(0, mutation.at),
      ...mutation.rows.map(() => -1),
      ...sourceRows.slice(mutation.at)
    ]
  } else if (mutation.kind === 'delete-rows') {
    for (const row of new Set(mutation.rows)) {
      checkedIndex(row, rows.length)
    }
    const deleted = new Set(mutation.rows)
    rows = rows.filter((_, index) => !deleted.has(index))
    sourceRows = sourceRows.filter((index) => !deleted.has(index))
  } else {
    if (mutation.kind === 'insert-column') {
      checkedIndex(mutation.at, columns.length, true)
      if (columns.length >= CSV_MAX_COLUMNS) {
        throw new Error('CSV exceeds the 4,096 column limit.')
      }
      columns.splice(mutation.at, 0, -1)
    } else if (mutation.kind === 'delete-columns') {
      for (const column of new Set(mutation.columns)) {
        checkedIndex(column, columns.length)
      }
      const deleted = new Set(mutation.columns)
      columns = columns.filter((column) => !deleted.has(column))
    } else {
      checkedIndex(mutation.from, columns.length)
      checkedIndex(mutation.to, columns.length)
      const column = columns.splice(mutation.from, 1)[0]!
      columns.splice(mutation.to, 0, column)
    }
    for (let index = 0; index < rows.length; index += 1) {
      const original = rows[index]!
      rows[index] = columns.map((column) =>
        column < 0
          ? index === 0 && mutation.kind === 'insert-column'
            ? mutation.label
            : ''
          : (original[column] ?? '')
      )
    }
    if (!rows.length && mutation.kind === 'insert-column') {
      rows.push([mutation.label])
      sourceRows.push(-1)
    }
    if (!columns.length) {
      return document.bom
    }
  }
  const finalTerminated = Boolean(document.ends.at(-1)! > document.contentEnds.at(-1)!)
  const parts = [document.bom]
  let bytes = document.bom ? 3 : 0
  for (let index = 0; index < rows.length; index += 1) {
    const sourceRow = sourceRows[index]!
    const hasFollowing = index < rows.length - 1
    const originalEnding =
      sourceRow < 0
        ? ''
        : document.source.slice(document.contentEnds[sourceRow], document.ends[sourceRow])
    if (
      sourceRow >= 0 &&
      mutation.kind !== 'insert-column' &&
      mutation.kind !== 'delete-columns' &&
      mutation.kind !== 'move-column'
    ) {
      const original = document.source.slice(
        document.starts[sourceRow],
        document.contentEnds[sourceRow]
      )
      // A newly following row must not fall inside an unterminated quoted field.
      parts.push(
        (!originalEnding && hasFollowing) || (!hasFollowing && !finalTerminated && original === '')
          ? serializeCsvRecord(
              rows[index]!,
              document.delimiter,
              document.rows[sourceRow],
              csvRecordTokens(document, sourceRow)
            )
          : original
      )
    } else {
      const tokens = sourceRow < 0 ? [] : csvRecordTokens(document, sourceRow)
      const values = sourceRow < 0 ? [] : document.rows[sourceRow]!
      parts.push(
        serializeCsvRecord(
          rows[index]!,
          document.delimiter,
          columns.map((column) => values[column] ?? ''),
          columns.map((column) => tokens[column] ?? '')
        )
      )
    }
    const ending = hasFollowing || finalTerminated ? originalEnding || document.lineEnding : ''
    bytes += measureUtf8ByteLength(parts.at(-1)!).byteLength + ending.length
    assertCsvTableEditBytes(bytes)
    parts.push(ending)
  }
  const result = parts.join('')
  parseCsv(result, document.delimiter, {
    maxCells: 1024 * 1024 + 1,
    maxColumns: CSV_MAX_COLUMNS,
    maxRecordLength: CSV_RECORD_BYTES,
    retainRows: false,
    onRecord: (start, contentEnd) => {
      if (
        measureUtf8ByteLength(result.slice(start, contentEnd), { stopAfterBytes: CSV_RECORD_BYTES })
          .exceededLimit
      ) {
        throw new Error('CSV record exceeds the 1 MB limit.')
      }
    }
  })
  return result
}
