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
}

// Built-in date and time formats from the SpreadsheetML spec (18.8.30). Excel
// never writes these into `<numFmts>`, so they have to be recognized by id.
const BUILTIN_DATE_NUMBER_FORMAT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58
])

const GENERAL_NUMBER_FORMAT_ID = 0

export function parseXlsxNumberFormats(stylesXml: string): XlsxNumberFormats {
  const dateNumberFormatIds = new Set(BUILTIN_DATE_NUMBER_FORMAT_IDS)

  forEachXlsxXmlElement(stylesXml, 'numFmt', (element) => {
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

  const styleNumberFormatIds = parseCellFormatNumberFormatIds(stylesXml)
  return {
    isDateStyle: (styleIndex) => {
      if (styleIndex === undefined) {
        return false
      }
      const numberFormatId = styleNumberFormatIds[styleIndex]
      return numberFormatId !== undefined && dateNumberFormatIds.has(numberFormatId)
    }
  }
}

// Why: a cell's `s` attribute indexes `<cellXfs>`, not `<cellStyleXfs>`, and
// both use `<xf>` children — so the scan has to be scoped to the cellXfs block.
function parseCellFormatNumberFormatIds(stylesXml: string): number[] {
  const numberFormatIds: number[] = []

  forEachXlsxXmlElement(stylesXml, 'cellXfs', (cellFormats) => {
    forEachXlsxXmlElement(cellFormats.inner, 'xf', (cellFormat) => {
      const numberFormatId = Number.parseInt(cellFormat.attributes.numFmtId ?? '', 10)
      numberFormatIds.push(
        Number.isInteger(numberFormatId) ? numberFormatId : GENERAL_NUMBER_FORMAT_ID
      )
    })
    return false
  })

  return numberFormatIds
}

// Why: strip the parts of a format code that can contain a stray `d`/`m`/`y`
// without being a date token — quoted literals (`0.00" days"`), backslash
// escapes (`0\d`), colour and locale sections (`[Red]`, `[$-409]`), and the
// currency/text placeholders. Whatever is left only has date tokens if the
// format really is a date.
const FORMAT_CODE_LITERALS_PATTERN = /"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g
const DATE_FORMAT_TOKEN_PATTERN = /[ymdhs]/i

export function isXlsxDateFormatCode(formatCode: string): boolean {
  return DATE_FORMAT_TOKEN_PATTERN.test(formatCode.replace(FORMAT_CODE_LITERALS_PATTERN, ''))
}
