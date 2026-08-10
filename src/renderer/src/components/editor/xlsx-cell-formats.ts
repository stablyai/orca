import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/**
 * One entry of `<cellXfs>`, which is what a cell's `s` attribute indexes.
 *
 * Why its own module: the number-format reader and the visual-style reader both
 * need this table, and walking `<cellXfs>` twice from two places is how the two
 * would drift apart over which block they scanned.
 */
export type XlsxCellFormat = {
  numberFormatId: number
  fontId: number
  fillId: number
}

const GENERAL_NUMBER_FORMAT_ID = 0
const DEFAULT_FONT_ID = 0
const DEFAULT_FILL_ID = 0

// Why: scoped to `<cellXfs>`, never `<cellStyleXfs>`. Both hold `<xf>` children,
// but only cellXfs is what a cell's `s` attribute points into.
export function parseXlsxCellFormats(stylesXml: string): XlsxCellFormat[] {
  const cellFormats: XlsxCellFormat[] = []

  forEachXlsxXmlElement(stylesXml, 'cellXfs', (cellFormatsBlock) => {
    forEachXlsxXmlElement(cellFormatsBlock.inner, 'xf', (cellFormat) => {
      cellFormats.push({
        numberFormatId: readIdAttribute(cellFormat.attributes.numFmtId, GENERAL_NUMBER_FORMAT_ID),
        fontId: readIdAttribute(cellFormat.attributes.fontId, DEFAULT_FONT_ID),
        fillId: readIdAttribute(cellFormat.attributes.fillId, DEFAULT_FILL_ID)
      })
    })
    return false
  })

  return cellFormats
}

function readIdAttribute(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
