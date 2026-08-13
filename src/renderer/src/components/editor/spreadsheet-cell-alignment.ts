export type SpreadsheetCellAlignment = 'left' | 'right' | 'center'

// Why: mirror how a spreadsheet aligns a value by its kind — numbers and dates
// right, so digits and separators line up down a column; booleans and error
// codes centered; everything else left. Alignment is the main cue that tells a
// reader which columns are numeric, and it has to be derived from the rendered
// text because the grid only ever receives strings.
// Why: the rendered text is all the grid gets, so a formatted number has to be
// recognised through its separators. A number format such as `#,##0.00` emits
// grouped thousands (`1.234,50`), and a currency one wraps them in a symbol; both
// are numbers a spreadsheet right-aligns, and matching only ungrouped digits
// left-aligned every currency column.
const GROUP_SEPARATORS = '.,\\s\\u00a0\\u202f'
const CURRENCY_SYMBOLS = '\\p{Sc}'
const NUMERIC_PATTERN = new RegExp(
  `^[+-]?(?:${CURRENCY_SYMBOLS}\\s?)?` +
    `(?:\\d{1,3}(?:[${GROUP_SEPARATORS}]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?|[.,]\\d+)` +
    `(?:[eE][+-]?\\d+)?(?:\\s?(?:%|${CURRENCY_SYMBOLS}))?$`,
  'u'
)
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
