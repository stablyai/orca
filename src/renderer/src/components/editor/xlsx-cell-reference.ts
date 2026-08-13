export type XlsxCellReference = {
  /** Zero-based column index: `A` is 0. */
  columnIndex: number
  /** Zero-based row index: row `1` is 0. */
  rowIndex: number
}

const UPPERCASE_A = 65
const ALPHABET_LENGTH = 26
// Why: Excel's own grid limits. A reference past them is corrupt data, and
// accepting it would let a single bogus `r="A99999999999"` allocate a row array
// large enough to hang the renderer.
const MAX_COLUMN_COUNT = 16_384
const MAX_ROW_COUNT = 1_048_576

/** Parses an A1-style cell reference such as `AB12`. Returns null when invalid. */
export function parseXlsxCellReference(reference: string): XlsxCellReference | null {
  let letterEnd = 0
  while (letterEnd < reference.length && isUppercaseLetter(reference.charCodeAt(letterEnd))) {
    letterEnd += 1
  }
  if (letterEnd === 0 || letterEnd === reference.length) {
    return null
  }

  const columnIndex = columnIndexFromXlsxLetters(reference.slice(0, letterEnd))
  if (columnIndex === null) {
    return null
  }

  let rowNumber = 0
  for (let index = letterEnd; index < reference.length; index += 1) {
    const digit = reference.charCodeAt(index) - 48
    if (digit < 0 || digit > 9) {
      return null
    }
    rowNumber = rowNumber * 10 + digit
    if (rowNumber > MAX_ROW_COUNT) {
      return null
    }
  }
  if (rowNumber === 0) {
    return null
  }

  return { columnIndex, rowIndex: rowNumber - 1 }
}

/** Converts spreadsheet column letters to a zero-based index (`AA` is 26). */
export function columnIndexFromXlsxLetters(letters: string): number | null {
  if (letters.length === 0) {
    return null
  }

  let index = 0
  for (let position = 0; position < letters.length; position += 1) {
    const codeUnit = letters.charCodeAt(position)
    if (!isUppercaseLetter(codeUnit)) {
      return null
    }
    index = index * ALPHABET_LENGTH + (codeUnit - UPPERCASE_A + 1)
    if (index > MAX_COLUMN_COUNT) {
      return null
    }
  }

  return index - 1
}

/**
 * Expands an A1 reference or `A1:B9` range into the cells it covers.
 *
 * Sheet-qualified and absolute forms are accepted, since a formula may write
 * either; the sheet name is dropped because a sparkline's own sheet is the only
 * one the viewer resolves against.
 */
export function expandXlsxCellRange(reference: string): XlsxCellReference[] {
  // Why: a sparkline plots a handful of cells. A range wider than this is a
  // whole-column reference the author did not mean to chart into one cell.
  return expandOneRange(reference, MAX_SPARKLINE_RANGE_CELLS) ?? []
}

/**
 * Expands a space-separated range list, as a `sqref` attribute writes it
 * (`B27:C44 H27:H44`), into every cell it covers.
 *
 * Returns nothing when the list as a whole exceeds `maxCells`, so one rule over
 * a whole column cannot allocate an entry per cell of the sheet.
 */
export function expandXlsxCellRangeList(references: string, maxCells: number): XlsxCellReference[] {
  const cells: XlsxCellReference[] = []
  for (const reference of references.trim().split(/\s+/)) {
    if (reference === '') {
      continue
    }
    // Why: a range the viewer cannot read is dropped on its own rather than
    // taking its siblings with it — one malformed entry in a `sqref` list should
    // not un-highlight the ranges either side of it. Exceeding the budget is
    // different: that abandons the whole rule, because painting an arbitrary
    // prefix of it would be worse than painting none.
    const expanded = expandOneRange(reference, maxCells - cells.length)
    if (expanded === null) {
      return []
    }
    cells.push(...expanded)
  }
  return cells
}

/**
 * Expands one range, or returns an empty list when the reference is unreadable
 * and `null` when it would not fit in `maxCells`.
 */
function expandOneRange(reference: string, maxCells: number): XlsxCellReference[] | null {
  const withoutSheet = reference.includes('!')
    ? reference.slice(reference.lastIndexOf('!') + 1)
    : reference
  const [start, end] = withoutSheet.replaceAll('$', '').trim().toUpperCase().split(':')
  const from = start === undefined ? null : parseXlsxCellReference(start)
  if (from === null) {
    return []
  }
  const to = end === undefined ? from : parseXlsxCellReference(end)
  if (to === null) {
    return []
  }

  const cells: XlsxCellReference[] = []
  const rowStart = Math.min(from.rowIndex, to.rowIndex)
  const rowEnd = Math.max(from.rowIndex, to.rowIndex)
  const columnStart = Math.min(from.columnIndex, to.columnIndex)
  const columnEnd = Math.max(from.columnIndex, to.columnIndex)
  if ((rowEnd - rowStart + 1) * (columnEnd - columnStart + 1) > maxCells) {
    return null
  }
  for (let rowIndex = rowStart; rowIndex <= rowEnd; rowIndex += 1) {
    for (let columnIndex = columnStart; columnIndex <= columnEnd; columnIndex += 1) {
      cells.push({ rowIndex, columnIndex })
    }
  }
  return cells
}

const MAX_SPARKLINE_RANGE_CELLS = 1000

/** Renders a zero-based column index as spreadsheet letters (26 becomes `AA`). */
export function xlsxColumnLettersFromIndex(columnIndex: number): string {
  if (!Number.isInteger(columnIndex) || columnIndex < 0) {
    return ''
  }

  let letters = ''
  let remaining = columnIndex
  while (remaining >= 0) {
    letters = String.fromCharCode(UPPERCASE_A + (remaining % ALPHABET_LENGTH)) + letters
    remaining = Math.floor(remaining / ALPHABET_LENGTH) - 1
  }
  return letters
}

function isUppercaseLetter(codeUnit: number): boolean {
  return codeUnit >= UPPERCASE_A && codeUnit <= UPPERCASE_A + ALPHABET_LENGTH - 1
}
