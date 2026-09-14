import ExcelJS from 'exceljs'
import type {
  SpreadsheetCell,
  SpreadsheetData,
  SpreadsheetRow,
  SpreadsheetWorksheet
} from './spreadsheet-data'

/**
 * XLSX <-> SpreadsheetData conversion backed by exceljs.
 *
 * Only the cell grid (and worksheet names) round-trip: formatting, formulas
 * and other workbook chrome are intentionally dropped. Formula cells are read
 * as their cached result so editing never ships a half-resolved formula.
 */

export class SpreadsheetParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'SpreadsheetParseError'
  }
}

function normalizeCellValue(value: unknown): SpreadsheetCell {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // Rich text: exceljs exposes the runs, not a flat `.text`.
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((run) => {
          const text = (run as { text?: unknown } | null)?.text
          return typeof text === 'string' ? text : ''
        })
        .join('')
    }
    // Error cells (`#DIV/0!`, ...) carry `.error`, not `.text`.
    if (typeof obj.error === 'string') {
      return obj.error
    }
    // Hyperlink cells and shared strings expose `.text`.
    if (typeof obj.text === 'string') {
      return obj.text
    }
    // Formula cells: prefer the cached result so the grid shows a value.
    const result = obj.result
    if (result !== undefined) {
      return normalizeCellValue(result)
    }
  }
  return String(value)
}

export async function parseXlsxWorkbook(data: SpreadsheetDataOrSource): Promise<SpreadsheetData> {
  const bytes = toBytes(data)
  const workbook = new ExcelJS.Workbook()
  try {
    // Why: exceljs types the load input as a resizable Buffer; cast the
    // decoded blob (a plain Buffer/Uint8Array) so the generic aligns.
    await workbook.xlsx.load(bytes as never)
  } catch (error) {
    throw new SpreadsheetParseError('Not a readable .xlsx file.', error)
  }
  const worksheets: SpreadsheetWorksheet[] = workbook.worksheets.map((sheet) => {
    const rows: SpreadsheetRow[] = []
    // Why: eachRow() skips blank rows, which would shift every row below a gap;
    // walk the full row range so empty rows survive the round-trip.
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const cells: SpreadsheetCell[] = []
      sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell, colNumber) => {
        while (cells.length < colNumber - 1) {
          cells.push(null)
        }
        cells.push(normalizeCellValue(cell.value))
      })
      rows.push(cells)
    }
    return { name: sheet.name, rows }
  })
  return { worksheets, activeSheetIndex: 0 }
}

export async function serializeXlsxWorkbook(data: SpreadsheetData): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  for (const sheet of data.worksheets) {
    const worksheet = workbook.addWorksheet(sheet.name)
    for (const row of sheet.rows) {
      worksheet.addRow([...row])
    }
  }
  const buffer = await workbook.xlsx.writeBuffer()
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return bytesToBase64(bytes)
}

type SpreadsheetDataOrSource = ArrayBuffer | Uint8Array | string

// Why: this shared module also runs in the renderer (browser), where the
// global `Buffer` is undefined. `atob`/`btoa` exist in both Node >= 16 and
// browsers, so base64 round-trips without importing a polyfill.
function toBytes(source: SpreadsheetDataOrSource): Uint8Array {
  if (typeof source === 'string') {
    return base64ToBytes(source)
  }
  if (source instanceof Uint8Array) {
    return source
  }
  return new Uint8Array(source)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
