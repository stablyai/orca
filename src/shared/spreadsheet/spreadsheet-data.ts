/**
 * Normalized in-memory grid model for spreadsheet files (.csv/.tsv/.xlsx).
 * A worksheet is a header row followed by data rows; cells are plain
 * primitives so the model is agnostic to how the source was parsed (text
 * delimiters for CSV, the OOXML zip for XLSX).
 */
export type SpreadsheetCell = string | number | boolean | null

export type SpreadsheetRow = SpreadsheetCell[]

export type SpreadsheetWorksheet = {
  name: string
  /** rows[0] is the header row when the sheet has content. */
  rows: SpreadsheetRow[]
}

export type SpreadsheetData = {
  worksheets: SpreadsheetWorksheet[]
  activeSheetIndex: number
}

export function emptySpreadsheetData(name = 'Sheet1'): SpreadsheetData {
  return { worksheets: [{ name, rows: [] }], activeSheetIndex: 0 }
}
