export type CsvParseResult = {
  rows: string[][]
  maxColumns: number
}

export const CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS = 64 * 1024

const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

// Why: RFC 4180-compatible CSV parsing with quote handling and CRLF support.
// A hand-rolled parser avoids pulling a new dependency (papaparse) for what is
// a small, well-specified grammar. Inline state machine keeps the hot path
// allocation-light for large files.
export function parseCsv(source: string, delimiter: string = ','): CsvParseResult {
  // Why: strip a leading UTF-8 BOM (U+FEFF). Excel and other spreadsheet tools
  // prepend a BOM to exported CSVs; without this, the BOM contaminates the
  // first header cell and breaks column-name lookups for downstream consumers.
  if (source.charCodeAt(0) === 0xfeff) {
    source = source.slice(1)
  }

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let maxColumns = 0
  // Why: track whether the current record has produced any content — including
  // a quoted-but-empty field like `""`. Without this flag, the EOF flush
  // condition `field.length > 0 || row.length > 0` would drop a record whose
  // only field was a quoted empty string, since the field is empty and no
  // delimiter/newline ever pushed it onto the row.
  let recordHasContent = false

  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    if (row.length > maxColumns) {
      maxColumns = row.length
    }
    rows.push(row)
    row = []
    recordHasContent = false
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"' && field === '') {
      inQuotes = true
      // Why: entering quote mode means this record has real content even if
      // the quoted field ends up empty (e.g. the whole file is `""`).
      recordHasContent = true
      continue
    }
    if (ch === delimiter) {
      pushField()
      recordHasContent = true
      continue
    }
    if (ch === '\r') {
      if (source[i + 1] === '\n') {
        i += 1
      }
      pushRow()
      continue
    }
    if (ch === '\n') {
      pushRow()
      continue
    }
    field += ch
    recordHasContent = true
  }

  // Why: don't emit a trailing empty row for files that end with a newline —
  // that's just whitespace, not a record. But preserve an in-progress final
  // row that lacks a newline. `recordHasContent` covers the edge case where
  // the final record is a single quoted empty field (`""`) — the field is
  // empty and nothing has been pushed to `row`, but the record is real and
  // must not be dropped.
  if (field.length > 0 || row.length > 0 || recordHasContent) {
    pushRow()
  }

  return { rows, maxColumns }
}

export function detectCsvDelimiter(filePath: string, content: string): string {
  if (filePath.toLowerCase().endsWith('.tsv')) {
    return '\t'
  }
  // Why: sniff the first non-empty line for tab vs comma to handle CSVs that
  // were saved with a different extension. Semicolons/pipes are out of scope;
  // this tool is a viewer, not a general data importer.
  // Why: strip a leading UTF-8 BOM so it doesn't get counted as part of the
  // first cell's characters (and so BOM-prefixed TSVs still sniff correctly).
  let text = content
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }
  // Why: skip leading blank/whitespace-only lines before sniffing. A file that
  // starts with one or more empty lines would otherwise be classified as comma
  // (0 tabs vs 0 commas, tie goes to comma), misdetecting blank-leading TSVs.
  const firstLine = findFirstNonEmptyCsvSniffLine(text)
  const tabs = countDelimiterOutsideQuotes(firstLine, '\t')
  const commas = countDelimiterOutsideQuotes(firstLine, ',')
  return tabs > commas ? '\t' : ','
}

function findFirstNonEmptyCsvSniffLine(text: string): string {
  // Why: delimiter sniffing only needs one representative line; splitting a
  // pasted or dropped CSV can allocate one array entry per row before render.
  const scanLength = Math.min(text.length, CSV_DELIMITER_SNIFF_SCAN_CODE_UNITS)
  let lineStart = 0
  let lineHasContent = false

  for (let index = 0; index < scanLength; index += 1) {
    const codeUnit = text.charCodeAt(index)
    if (codeUnit === LINE_FEED_CODE_UNIT || codeUnit === CARRIAGE_RETURN_CODE_UNIT) {
      if (lineHasContent) {
        return text.slice(lineStart, index)
      }
      if (
        codeUnit === CARRIAGE_RETURN_CODE_UNIT &&
        index + 1 < scanLength &&
        text.charCodeAt(index + 1) === LINE_FEED_CODE_UNIT
      ) {
        index += 1
      }
      lineStart = index + 1
      lineHasContent = false
      continue
    }
    if (!lineHasContent && !isCsvSniffWhitespace(codeUnit)) {
      lineHasContent = true
    }
  }

  return lineHasContent ? text.slice(lineStart, scanLength) : ''
}

function isCsvSniffWhitespace(codeUnit: number): boolean {
  return (
    codeUnit === 0x09 ||
    codeUnit === 0x0b ||
    codeUnit === 0x0c ||
    codeUnit === 0x20 ||
    codeUnit === 0xa0
  )
}

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (!inQuotes && ch === delimiter) {
      count += 1
    }
  }
  return count
}
