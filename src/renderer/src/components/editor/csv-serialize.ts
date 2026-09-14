import type {
  SpreadsheetCell,
  SpreadsheetRow
} from '../../../../shared/spreadsheet/spreadsheet-data'

// Why: RFC 4180-compatible serialization paired with the existing parseCsv. A
// field only gets quoted when it contains the delimiter, a quote, CR, or LF so
// plain CSV round-trips without gratuitous quotes.
export function serializeCsvRows(rows: SpreadsheetRow[], delimiter: string): string {
  const escapeCell = (cell: SpreadsheetCell): string => {
    if (cell === null || cell === undefined) {
      return ''
    }
    let text: string
    if (typeof cell === 'string') {
      text = cell
    } else if (typeof cell === 'boolean') {
      text = cell ? 'TRUE' : 'FALSE'
    } else {
      text = String(cell)
    }
    const needsQuote =
      text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r')
    if (!needsQuote) {
      return text
    }
    return `"${text.split('"').join('""')}"`
  }

  return rows.map((row) => row.map(escapeCell).join(delimiter)).join('\r\n')
}
