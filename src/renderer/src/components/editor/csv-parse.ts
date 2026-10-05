export { detectCsvDelimiter, CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS } from './csv-delimiter-detection'

export type CsvParseResult = { rows: string[][]; maxColumns: number }
export type CsvParseLimits = {
  maxCells?: number
  maxColumns?: number
  maxRecordLength?: number
  stripBom?: boolean
}

export function parseCsv(
  source: string,
  delimiter = ',',
  limits: CsvParseLimits = {}
): CsvParseResult {
  const rows: string[][] = []
  let row: string[] = []
  let start = limits.stripBom !== false && source.charCodeAt(0) === 0xfeff ? 1 : 0
  let recordStart = start
  let parts: string[] = []
  let fieldLength = 0
  let inQuotes = false
  let hasContent = false
  let maxColumns = 0
  let cells = 0
  const appendSpan = (end: number): void => {
    if (end > start) {
      parts.push(source.slice(start, end))
      fieldLength += end - start
    }
  }
  const pushField = (end: number): void => {
    if (row.length >= (limits.maxColumns ?? Infinity) || ++cells > (limits.maxCells ?? Infinity)) {
      throw new Error('CSV contains too many cells to preview safely.')
    }
    // Slice ordinary fields once; only escaped or interleaved quotes need a join.
    if (parts.length) {
      appendSpan(end)
      row.push(parts.join(''))
    } else {
      row.push(source.slice(start, end))
    }
    parts = []
    fieldLength = 0
    start = end + 1
  }
  const pushRow = (end: number, next: number): void => {
    if (end - recordStart > (limits.maxRecordLength ?? Infinity)) {
      throw new Error('CSV record is too large to preview safely.')
    }
    pushField(end)
    maxColumns = Math.max(maxColumns, row.length)
    rows.push(row)
    row = []
    hasContent = false
    start = next
    recordStart = next
  }
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (
      i - recordStart >= (limits.maxRecordLength ?? Infinity) &&
      (inQuotes || (ch !== '\r' && ch !== '\n'))
    ) {
      throw new Error('CSV record is too large to preview safely.')
    }
    if (inQuotes) {
      if (ch === '"') {
        appendSpan(i)
        if (source[i + 1] === '"') {
          parts.push('"')
          fieldLength += 1
          i += 1
        } else {
          inQuotes = false
        }
        start = i + 1
      }
      continue
    }
    if (ch === '"' && fieldLength + i - start === 0) {
      inQuotes = true
      hasContent = true
      start = i + 1
    } else if (ch === delimiter) {
      pushField(i)
      hasContent = true
    } else if (ch === '\r' || ch === '\n') {
      const end = i
      if (ch === '\r' && source[i + 1] === '\n') {
        i += 1
      }
      pushRow(end, i + 1)
    } else {
      hasContent = true
    }
  }
  if (hasContent || row.length) {
    pushRow(source.length, source.length)
  }
  return { rows, maxColumns }
}
