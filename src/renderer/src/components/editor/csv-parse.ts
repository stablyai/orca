export type CsvParseResult = {
  rows: string[][]
  maxColumns: number
}

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
  const lines = text.split(/\r?\n/)
  let firstLine = ''
  for (const line of lines) {
    if (line.trim().length > 0) {
      firstLine = line
      break
    }
  }
  const tabs = (firstLine.match(/\t/g) ?? []).length
  const commas = (firstLine.match(/,/g) ?? []).length
  return tabs > commas ? '\t' : ','
}
