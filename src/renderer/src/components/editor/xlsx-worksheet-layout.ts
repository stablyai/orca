import { parseXlsxCellReference } from './xlsx-cell-reference'
import { forEachXlsxXmlElement } from './xlsx-xml-elements'

/** A merged range, addressed by its top-left anchor. */
export type XlsxMergedRange = {
  rowIndex: number
  columnIndex: number
  rowSpan: number
  columnSpan: number
}

export type XlsxWorksheetLayout = {
  /**
   * Author-set column widths in pixels, by column index. Absent entries fall
   * back to sizing the column from its content.
   */
  columnWidths: (number | undefined)[]
  mergedRanges: XlsxMergedRange[]
}

// Why: `<col width>` is in units of the default font's "0" character, the width
// Excel's own column dialog reports. This is the conversion Excel documents:
// pixels = width * maxDigitWidth + padding, with 7px and 5px for Calibri 11.
const CHARACTER_WIDTH_PX = 7
const CELL_PADDING_PX = 5
// Why: Excel's own column limits. A file can declare a hidden column as width 0,
// which must not collapse into an unclickable sliver, and a corrupt width must
// not push one column past the viewport.
const MIN_DECLARED_COLUMN_PX = 16
const MAX_DECLARED_COLUMN_PX = 2000
const MAX_COLUMN_COUNT = 16_384

export function parseXlsxWorksheetLayout(xml: string): XlsxWorksheetLayout {
  return {
    columnWidths: parseColumnWidths(xml),
    mergedRanges: parseMergedRanges(xml)
  }
}

function parseColumnWidths(xml: string): (number | undefined)[] {
  const columnWidths: (number | undefined)[] = []

  forEachXlsxXmlElement(xml, 'cols', (colsBlock) => {
    forEachXlsxXmlElement(colsBlock.inner, 'col', (col) => {
      // Why: only a customWidth is the author's choice. Excel writes `<col>` for
      // other reasons too (a style span, an outline level), and adopting the
      // default width it repeats there would override content-based sizing with
      // a value the author never set.
      if (col.attributes.customWidth !== '1' && col.attributes.customWidth !== 'true') {
        return
      }
      const width = Number.parseFloat(col.attributes.width ?? '')
      const min = Number.parseInt(col.attributes.min ?? '', 10)
      const max = Number.parseInt(col.attributes.max ?? '', 10)
      if (!Number.isFinite(width) || !Number.isInteger(min) || min < 1) {
        return
      }
      const lastColumn = Math.min(Number.isInteger(max) && max >= min ? max : min, MAX_COLUMN_COUNT)
      const widthPx = clampColumnWidth(width * CHARACTER_WIDTH_PX + CELL_PADDING_PX)
      for (let column = min; column <= lastColumn; column += 1) {
        columnWidths[column - 1] = widthPx
      }
    })
    return false
  })

  return columnWidths
}

function clampColumnWidth(widthPx: number): number {
  return Math.round(Math.min(MAX_DECLARED_COLUMN_PX, Math.max(MIN_DECLARED_COLUMN_PX, widthPx)))
}

function parseMergedRanges(xml: string): XlsxMergedRange[] {
  const mergedRanges: XlsxMergedRange[] = []

  forEachXlsxXmlElement(xml, 'mergeCells', (mergeCellsBlock) => {
    forEachXlsxXmlElement(mergeCellsBlock.inner, 'mergeCell', (mergeCell) => {
      const range = parseMergeReference(mergeCell.attributes.ref)
      if (range !== null) {
        mergedRanges.push(range)
      }
    })
    return false
  })

  return mergedRanges
}

/** Parses an `A1:C3` merge reference into its anchor and span. */
export function parseMergeReference(reference: string | undefined): XlsxMergedRange | null {
  const [start, end] = (reference ?? '').split(':')
  if (start === undefined || end === undefined) {
    return null
  }
  const from = parseXlsxCellReference(start)
  const to = parseXlsxCellReference(end)
  if (from === null || to === null) {
    return null
  }

  const rowIndex = Math.min(from.rowIndex, to.rowIndex)
  const columnIndex = Math.min(from.columnIndex, to.columnIndex)
  return {
    rowIndex,
    columnIndex,
    rowSpan: Math.abs(to.rowIndex - from.rowIndex) + 1,
    columnSpan: Math.abs(to.columnIndex - from.columnIndex) + 1
  }
}
