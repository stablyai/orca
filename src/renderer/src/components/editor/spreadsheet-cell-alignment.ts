export type SpreadsheetCellAlignment = 'left' | 'right' | 'center'

// Why: mirror how a spreadsheet aligns a value by its kind — numbers and dates
// right, so digits and separators line up down a column; booleans and error
// codes centered; everything else left. Alignment is the main cue that tells a
// reader which columns are numeric, and it has to be derived from the rendered
// text because the grid only ever receives strings.
const NUMERIC_PATTERN = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?%?$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/
const TIME_OF_DAY_PATTERN = /^\d{2}:\d{2}:\d{2}$/
const BOOLEAN_TEXTS = new Set(['TRUE', 'FALSE'])
const ERROR_CODE_PATTERN = /^#[A-Z0-9_/?!]+$/

export function getSpreadsheetCellAlignment(value: string): SpreadsheetCellAlignment {
  if (value === '') {
    return 'left'
  }
  if (BOOLEAN_TEXTS.has(value) || ERROR_CODE_PATTERN.test(value)) {
    return 'center'
  }
  if (
    NUMERIC_PATTERN.test(value) ||
    ISO_DATE_PATTERN.test(value) ||
    TIME_OF_DAY_PATTERN.test(value)
  ) {
    return 'right'
  }
  return 'left'
}

export const SPREADSHEET_ALIGNMENT_CLASSES: Record<SpreadsheetCellAlignment, string> = {
  left: 'justify-start text-left',
  right: 'justify-end text-right',
  center: 'justify-center text-center'
}

export function getSpreadsheetCellAlignmentClass(value: string): string {
  return SPREADSHEET_ALIGNMENT_CLASSES[getSpreadsheetCellAlignment(value)]
}
