import { parseXlsxCellFormats } from './xlsx-cell-formats'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/**
 * The subset of `xl/styles.xml` the viewer needs: whether a cell's style
 * renders its stored number as a date or time.
 *
 * Why only dates: every other numeric format (currency, percent, thousands
 * separators) still reads as the number it stores, so showing the raw value
 * loses nothing. A date serial like `45658` is meaningless on its own, so date
 * styles are the one format the viewer has to interpret.
 */
export type XlsxNumberFormats = {
  isDateStyle(styleIndex: number | undefined): boolean
  /** The format code a style applies, or undefined for General. */
  getFormatCode(styleIndex: number | undefined): string | undefined
}

// Built-in date and time formats from the SpreadsheetML spec (18.8.30). Excel
// never writes these into `<numFmts>`, so they have to be recognized by id.
const BUILTIN_DATE_NUMBER_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58
])

export function parseXlsxNumberFormats(stylesXml: string): XlsxNumberFormats {
  const dateNumberFormatIds = new Set(BUILTIN_DATE_NUMBER_FORMAT_IDS)

  // Why: scope the scan to `<numFmts>`. A `<numFmt>` can also appear inside
  // `<dxfs>` differential formatting, where it applies to one conditional-format
  // rule — letting those through would rewrite the id for every cell format.
  forEachXlsxXmlElement(stylesXml, 'numFmts', (numberFormatsBlock) => {
    forEachXlsxXmlElement(numberFormatsBlock.inner, 'numFmt', (element) => {
      const numberFormatId = Number.parseInt(element.attributes.numFmtId ?? '', 10)
      const formatCode = element.attributes.formatCode
      if (!Number.isInteger(numberFormatId) || formatCode === undefined) {
        return
      }
      if (isXlsxDateFormatCode(formatCode)) {
        dateNumberFormatIds.add(numberFormatId)
      } else {
        // Why: a custom format may reuse a built-in id with a non-date code.
        dateNumberFormatIds.delete(numberFormatId)
      }
    })
    return false
  })

  const styleNumberFormatIds = parseXlsxCellFormats(stylesXml).map(
    (cellFormat) => cellFormat.numberFormatId
  )
  const formatCodesById = parseFormatCodesById(stylesXml)
  return {
    getFormatCode: (styleIndex) => {
      if (styleIndex === undefined) {
        return undefined
      }
      const numberFormatId = styleNumberFormatIds[styleIndex]
      return numberFormatId === undefined
        ? undefined
        : (formatCodesById.get(numberFormatId) ?? BUILTIN_FORMAT_CODES[numberFormatId])
    },
    isDateStyle: (styleIndex) => {
      if (styleIndex === undefined) {
        return false
      }
      const numberFormatId = styleNumberFormatIds[styleIndex]
      return numberFormatId !== undefined && dateNumberFormatIds.has(numberFormatId)
    }
  }
}

// Why: strip the parts of a format code that can contain a stray `d`/`m`/`y`
// without being a date token — quoted literals (`0.00" days"`), backslash
// escapes (`0\d`), colour and locale sections (`[Red]`, `[$-409]`), and the
// currency/text placeholders. Whatever is left only has date tokens if the
// format really is a date.
const FORMAT_CODE_LITERALS_PATTERN = /"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g
const DATE_FORMAT_TOKEN_PATTERN = /[ymdhs]/i
// Why: `[h]:mm:ss` and `[mm]:ss` are elapsed durations, not clock times — the
// bracketed unit tells Excel not to wrap at 24h. Rendering serial 1.5 as a date
// would be wrong (it means 36 hours), so those cells keep their stored number.
const ELAPSED_TIME_SECTION_PATTERN = /\[(?:h+|m+|s+)\]/i

// Why: Excel never writes the built-in codes into `<numFmts>`, so a cell using
// one carries only its id. These are the numeric built-ins worth rendering; the
// date ids are handled by the date path instead.
const BUILTIN_FORMAT_CODES: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  48: '##0.0E+0'
}

function parseFormatCodesById(stylesXml: string): Map<number, string> {
  const formatCodes = new Map<number, string>()

  forEachXlsxXmlElement(stylesXml, 'numFmts', (numberFormatsBlock) => {
    forEachXlsxXmlElement(numberFormatsBlock.inner, 'numFmt', (element) => {
      const numberFormatId = Number.parseInt(element.attributes.numFmtId ?? '', 10)
      const formatCode = element.attributes.formatCode
      if (Number.isInteger(numberFormatId) && formatCode !== undefined) {
        formatCodes.set(numberFormatId, formatCode)
      }
    })
    return false
  })

  return formatCodes
}

export function isXlsxDateFormatCode(formatCode: string): boolean {
  if (ELAPSED_TIME_SECTION_PATTERN.test(formatCode)) {
    return false
  }
  return DATE_FORMAT_TOKEN_PATTERN.test(formatCode.replace(FORMAT_CODE_LITERALS_PATTERN, ''))
}
