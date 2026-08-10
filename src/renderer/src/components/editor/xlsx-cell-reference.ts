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
