import { parseXlsxCellReference } from './xlsx-cell-reference'
import type { XlsxCellStyle, XlsxCellStyles } from './xlsx-cell-styles'
import {
  formatXlsxNumericValue,
  parseXlsxNumberFormatCode,
  type XlsxNumericFormat
} from './xlsx-number-format'
import type { XlsxNumberFormats } from './xlsx-number-formats'
import { formatXlsxSerialDate } from './xlsx-serial-date'
import { decodeXlsxXmlText, forEachXlsxXmlElement, readXlsxXmlTextRuns } from './xlsx-xml-elements'

export type XlsxWorksheetGrid = {
  rows: string[][]
  /**
   * Visual style per cell, positionally matching `rows`. Empty when the workbook
   * declares no fills, font colours or bold, so an unstyled sheet costs nothing.
   */
  styles: (XlsxCellStyle | undefined)[][]
  /** Author-set row heights in pixels, by row index. */
  rowHeights: (number | undefined)[]
  /**
   * Raw numeric cell values, keyed `row:column`. Collected only when the sheet
   * carries a sparkline, which needs the numbers behind the formatted text.
   */
  numericValues: Map<string, number>
  /** Cell formulas that declare a sparkline, keyed `row:column`. */
  sparklineFormulas: Map<string, string>
  maxColumns: number
  /** True when the sheet has more rows than `maxRows` allowed through. */
  truncated: boolean
}

export type XlsxWorksheetContext = {
  sharedStrings: string[]
  numberFormats: XlsxNumberFormats
  cellStyles: XlsxCellStyles
  use1904DateSystem: boolean
  maxRows: number
  /** True when the sheet's XML mentions a sparkline, so formulas are collected. */
  collectSparklines?: boolean
  /**
   * Locale for number formatting. A format code implies the viewer's group and
   * decimal separators, not the file's.
   */
  locale: string
}

const BOOLEAN_CELL_TEXT = { true: 'TRUE', false: 'FALSE' } as const

/**
 * Flattens a worksheet part into the dense string grid the viewer renders.
 *
 * Sheets are sparse on disk — blank rows and cells are simply absent — so gaps
 * are padded back in to keep every value under the column it belongs to.
 */
export function parseXlsxWorksheetGrid(
  xml: string,
  context: XlsxWorksheetContext
): XlsxWorksheetGrid {
  const rows: string[][] = []
  const styles: (XlsxCellStyle | undefined)[][] = []
  const rowHeights: (number | undefined)[] = []
  const numericValues = new Map<string, number>()
  const sparklineFormulas = new Map<string, string>()
  const collectSparklines = context.collectSparklines === true
  const collectStyles = context.cellStyles.hasVisualStyles
  let maxColumns = 0
  let truncated = false

  forEachXlsxXmlElement(xml, 'row', (rowElement) => {
    const declaredRowIndex = Number.parseInt(rowElement.attributes.r ?? '', 10)
    const rowIndex =
      Number.isInteger(declaredRowIndex) && declaredRowIndex > 0
        ? declaredRowIndex - 1
        : rows.length
    // Why: skip the row but keep scanning rather than stopping. Rows normally
    // arrive in ascending order, but a hand-written sheet can list them out of
    // order, and stopping would discard every later row after one high `r`.
    if (rowIndex >= context.maxRows) {
      truncated = true
      return true
    }
    while (rows.length < rowIndex) {
      rows.push([])
    }

    const row = readRowCells(rowElement.inner, context, collectStyles, {
      collectSparklines,
      rowIndex,
      numericValues,
      sparklineFormulas
    })
    // Why: a row element can repeat or arrive out of order in a hand-written
    // sheet; merging into the slot keeps the last writer's values instead of
    // pushing a duplicate row.
    rows[rowIndex] = mergeRowCells(rows[rowIndex], row.cells)
    if (collectStyles) {
      styles[rowIndex] = row.styles
    }
    const rowHeightPx = readRowHeight(rowElement.attributes)
    if (rowHeightPx !== undefined) {
      rowHeights[rowIndex] = rowHeightPx
    }
    if (rows[rowIndex]!.length > maxColumns) {
      maxColumns = rows[rowIndex]!.length
    }
    return true
  })

  return {
    rows: padRows(rows, maxColumns),
    styles: collectStyles ? padStyleRows(styles, rows.length) : [],
    rowHeights,
    numericValues,
    sparklineFormulas,
    maxColumns,
    truncated
  }
}

type XlsxWorksheetRow = { cells: string[]; styles: (XlsxCellStyle | undefined)[] }

type XlsxSparklineCollector = {
  collectSparklines: boolean
  rowIndex: number
  numericValues: Map<string, number>
  sparklineFormulas: Map<string, string>
}

export function buildCellKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`
}

function readRowCells(
  rowXml: string,
  context: XlsxWorksheetContext,
  collectStyles: boolean,
  collector: XlsxSparklineCollector
): XlsxWorksheetRow {
  const cells: string[] = []
  const styles: (XlsxCellStyle | undefined)[] = []
  let nextColumnIndex = 0

  forEachXlsxXmlElement(rowXml, 'c', (cellElement) => {
    const reference = cellElement.attributes.r
    const parsed = reference === undefined ? null : parseXlsxCellReference(reference)
    const columnIndex = parsed?.columnIndex ?? nextColumnIndex
    nextColumnIndex = columnIndex + 1
    while (cells.length < columnIndex) {
      cells.push('')
    }
    cells[columnIndex] = readCellText(cellElement.attributes, cellElement.inner, context)
    if (collector.collectSparklines) {
      collectSparklineData(cellElement.inner, columnIndex, collector)
    }
    if (collectStyles) {
      styles[columnIndex] = context.cellStyles.getStyle(readStyleIndex(cellElement.attributes.s))
    }
  })

  return { cells, styles }
}

// Why: `ht` is in points, the unit Excel's row-height dialog shows, and CSS
// wants pixels — 96dpi over 72pt. Only a customHeight is the author's choice;
// Excel writes `ht` on every row of some files just to record the default.
const POINTS_TO_PIXELS = 96 / 72
const MIN_ROW_HEIGHT_PX = 12
const MAX_ROW_HEIGHT_PX = 400

function readRowHeight(attributes: Record<string, string>): number | undefined {
  if (attributes.customHeight !== '1' && attributes.customHeight !== 'true') {
    return undefined
  }
  const points = Number.parseFloat(attributes.ht ?? '')
  if (!Number.isFinite(points)) {
    return undefined
  }
  return Math.round(
    Math.min(MAX_ROW_HEIGHT_PX, Math.max(MIN_ROW_HEIGHT_PX, points * POINTS_TO_PIXELS))
  )
}

// Why: a sparkline needs the numbers behind the formatted text, and the formula
// that describes it — neither survives in the rendered cell string.
function collectSparklineData(
  cellXml: string,
  columnIndex: number,
  collector: XlsxSparklineCollector
): void {
  const key = buildCellKey(collector.rowIndex, columnIndex)
  const rawValue = readFirstElementText(cellXml, 'v')
  const numeric = rawValue === null ? Number.NaN : Number(rawValue)
  if (Number.isFinite(numeric)) {
    collector.numericValues.set(key, numeric)
  }
  const formula = readFirstElementText(cellXml, 'f')
  if (formula !== null && formula.includes('SPARKLINE(')) {
    collector.sparklineFormulas.set(key, formula)
  }
}

function readStyleIndex(styleIndexAttribute: string | undefined): number | undefined {
  const styleIndex = Number.parseInt(styleIndexAttribute ?? '', 10)
  return Number.isInteger(styleIndex) ? styleIndex : undefined
}

function readCellText(
  attributes: Record<string, string>,
  cellXml: string,
  context: XlsxWorksheetContext
): string {
  const cellType = attributes.t ?? 'n'
  if (cellType === 'inlineStr') {
    return readXlsxXmlTextRuns(cellXml)
  }

  const rawValue = readFirstElementText(cellXml, 'v')
  if (rawValue === null) {
    return ''
  }

  switch (cellType) {
    case 's': {
      const sharedStringIndex = Number.parseInt(rawValue, 10)
      return context.sharedStrings[sharedStringIndex] ?? ''
    }
    case 'b': {
      return rawValue === '0' ? BOOLEAN_CELL_TEXT.false : BOOLEAN_CELL_TEXT.true
    }
    // Why: `str` is a cached formula result and `e` a cached error code; both are
    // already display text, and `d` holds an ISO 8601 date written verbatim.
    case 'str':
    case 'e':
    case 'd': {
      return rawValue
    }
    default: {
      return formatNumericCellText(rawValue, attributes.s, context)
    }
  }
}

function formatNumericCellText(
  rawValue: string,
  styleIndexAttribute: string | undefined,
  context: XlsxWorksheetContext
): string {
  const styleIndex = readStyleIndex(styleIndexAttribute)
  const serial = Number(rawValue)
  if (!Number.isFinite(serial)) {
    return rawValue
  }
  if (context.numberFormats.isDateStyle(styleIndex)) {
    return (
      formatXlsxSerialDate(serial, { use1904DateSystem: context.use1904DateSystem }) ?? rawValue
    )
  }
  const numericFormat = getNumericFormat(context, styleIndex)
  if (numericFormat === null) {
    return rawValue
  }
  return formatXlsxNumericValue(serial, numericFormat, context.locale).text
}

// Why: parsing a format code is pure and a sheet reuses a handful of styles
// across every cell, so the parsed form is cached per style index.
const numericFormatCache = new WeakMap<XlsxNumberFormats, Map<number, XlsxNumericFormat | null>>()

function getNumericFormat(
  context: XlsxWorksheetContext,
  styleIndex: number | undefined
): XlsxNumericFormat | null {
  if (styleIndex === undefined) {
    return null
  }
  let cache = numericFormatCache.get(context.numberFormats)
  if (cache === undefined) {
    cache = new Map()
    numericFormatCache.set(context.numberFormats, cache)
  }
  if (!cache.has(styleIndex)) {
    const formatCode = context.numberFormats.getFormatCode(styleIndex)
    cache.set(styleIndex, formatCode === undefined ? null : parseXlsxNumberFormatCode(formatCode))
  }
  return cache.get(styleIndex) ?? null
}

function readFirstElementText(xml: string, tagName: string): string | null {
  let text: string | null = null
  forEachXlsxXmlElement(xml, tagName, (element) => {
    text = decodeXlsxXmlText(element.inner)
    return false
  })
  return text
}

function mergeRowCells(existing: string[] | undefined, cells: string[]): string[] {
  if (existing === undefined || existing.length === 0) {
    return cells
  }
  const merged = [...existing]
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]
    if (cell !== undefined && cell !== '') {
      merged[index] = cell
    }
  }
  return merged.map((cell) => cell ?? '')
}

// Why: keep the style matrix the same height as the row matrix so a lookup by
// row index never lands on a hole.
function padStyleRows(
  styles: (XlsxCellStyle | undefined)[][],
  rowCount: number
): (XlsxCellStyle | undefined)[][] {
  const padded = styles.slice(0, rowCount)
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    padded[rowIndex] ??= []
  }
  return padded as (XlsxCellStyle | undefined)[][]
}

function padRows(rows: string[][], maxColumns: number): string[][] {
  for (const row of rows) {
    while (row.length < maxColumns) {
      row.push('')
    }
  }
  return rows
}
