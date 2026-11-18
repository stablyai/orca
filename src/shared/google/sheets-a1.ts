// Spreadsheet cell names (A1 notation) and cells shown as a table whose rows and columns are named,
// so an agent can write back to exactly the cell it read.

/** A → 1, AA → 27. */
export function columnNumber(letters: string): number {
  return [...letters.toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0)
}

/** 1 → A, 27 → AA. */
export function columnLetters(number: number): string {
  let letters = ''
  for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  }
  return letters
}

/** A tab name as Sheets wants it inside a range: always quoted, quotes doubled. */
export const quotedTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`

/** Google's answer range, e.g. 'Q4 plan'!B2:F40, as its tab and its first cell. */
export function splitA1(range: string): {
  tab?: string
  cells: string
  row: number
  column: number
} {
  const bang = range.lastIndexOf('!')
  const rawTab = bang !== -1 ? range.slice(0, bang) : undefined
  const tab = rawTab?.startsWith("'") ? rawTab.slice(1, -1).replace(/''/g, "'") : rawTab
  const cells = bang !== -1 ? range.slice(bang + 1) : range
  const start = /^([A-Za-z]*)(\d*)/.exec(cells)
  return {
    ...(tab !== undefined ? { tab } : {}),
    cells,
    row: Number(start?.[2] || 1),
    column: start?.[1] ? columnNumber(start[1]) : 1
  }
}

const cellText = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ ')

/** Rows under column letters, each row led by its number. */
export function sheetTable(values: string[][], origin: { row: number; column: number }): string {
  const width = Math.max(1, ...values.map((row) => row.length))
  const letters = Array.from({ length: width }, (_, index) => columnLetters(origin.column + index))
  return [
    `row | ${letters.join(' | ')}`,
    ...values.map(
      (row, index) =>
        `${origin.row + index} | ${Array.from({ length: width }, (_, column) => cellText(row[column] ?? '')).join(' | ')}`
    )
  ].join('\n')
}
