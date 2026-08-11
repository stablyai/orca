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
  borderId: number
  /** `horizontal` from `<alignment>`, when the author set one. */
  horizontalAlignment?: string
  /** `vertical` from `<alignment>`, when the author set one. */
  verticalAlignment?: string
  /** `indent` from `<alignment>`, in the spreadsheet's own indent units. */
  indent?: number
  wrapText?: boolean
}

const GENERAL_NUMBER_FORMAT_ID = 0
const DEFAULT_FONT_ID = 0
const DEFAULT_FILL_ID = 0
const DEFAULT_BORDER_ID = 0

// Why: scoped to `<cellXfs>`, never `<cellStyleXfs>`. Both hold `<xf>` children,
// but only cellXfs is what a cell's `s` attribute points into.
export function parseXlsxCellFormats(stylesXml: string): XlsxCellFormat[] {
  const cellFormats: XlsxCellFormat[] = []

  forEachXlsxXmlElement(stylesXml, 'cellXfs', (cellFormatsBlock) => {
    forEachXlsxXmlElement(cellFormatsBlock.inner, 'xf', (cellFormat) => {
      cellFormats.push({
        numberFormatId: readIdAttribute(cellFormat.attributes.numFmtId, GENERAL_NUMBER_FORMAT_ID),
        fontId: readIdAttribute(cellFormat.attributes.fontId, DEFAULT_FONT_ID),
        fillId: readIdAttribute(cellFormat.attributes.fillId, DEFAULT_FILL_ID),
        borderId: readIdAttribute(cellFormat.attributes.borderId, DEFAULT_BORDER_ID),
        ...readAlignment(cellFormat.inner)
      })
    })
    return false
  })

  return cellFormats
}

type XlsxAlignment = Pick<
  XlsxCellFormat,
  'horizontalAlignment' | 'verticalAlignment' | 'indent' | 'wrapText'
>

function readAlignment(cellFormatXml: string): XlsxAlignment {
  const alignment: XlsxAlignment = {}
  forEachXlsxXmlElement(cellFormatXml, 'alignment', (element) => {
    if (element.attributes.horizontal !== undefined) {
      alignment.horizontalAlignment = element.attributes.horizontal
    }
    if (element.attributes.vertical !== undefined) {
      alignment.verticalAlignment = element.attributes.vertical
    }
    const indent = Number.parseInt(element.attributes.indent ?? '', 10)
    if (Number.isInteger(indent) && indent > 0) {
      alignment.indent = indent
    }
    if (element.attributes.wrapText === '1' || element.attributes.wrapText === 'true') {
      alignment.wrapText = true
    }
    return false
  })
  return alignment
}

function readIdAttribute(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
