import { parseXlsxCellReference } from './xlsx-cell-reference'
import type { XlsxNumberFormats } from './xlsx-number-formats'
import { formatXlsxSerialDate } from './xlsx-serial-date'
import { decodeXlsxXmlText, forEachXlsxXmlElement, readXlsxXmlTextRuns } from './xlsx-xml-elements'

export type XlsxWorksheetGrid = {
  rows: string[][]
  maxColumns: number
  /** True when the sheet has more rows than `maxRows` allowed through. */
  truncated: boolean
}

export type XlsxWorksheetContext = {
  sharedStrings: string[]
  numberFormats: XlsxNumberFormats
  use1904DateSystem: boolean
  maxRows: number
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
  let maxColumns = 0
  let truncated = false

  forEachXlsxXmlElement(xml, 'row', (rowElement) => {
    const declaredRowIndex = Number.parseInt(rowElement.attributes.r ?? '', 10)
    const rowIndex =
      Number.isInteger(declaredRowIndex) && declaredRowIndex > 0
        ? declaredRowIndex - 1
        : rows.length
    if (rowIndex >= context.maxRows) {
      truncated = true
      return false
    }
    while (rows.length < rowIndex) {
      rows.push([])
    }

    const cells = readRowCells(rowElement.inner, context)
    // Why: a row element can repeat or arrive out of order in a hand-written
    // sheet; merging into the slot keeps the last writer's values instead of
    // pushing a duplicate row.
    rows[rowIndex] = mergeRowCells(rows[rowIndex], cells)
    if (rows[rowIndex]!.length > maxColumns) {
      maxColumns = rows[rowIndex]!.length
    }
    return true
  })

  return { rows: padRows(rows, maxColumns), maxColumns, truncated }
}

function readRowCells(rowXml: string, context: XlsxWorksheetContext): string[] {
  const cells: string[] = []
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
  })

  return cells
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
  const styleIndex = Number.parseInt(styleIndexAttribute ?? '', 10)
  if (!context.numberFormats.isDateStyle(Number.isInteger(styleIndex) ? styleIndex : undefined)) {
    return rawValue
  }
  const serial = Number(rawValue)
  if (!Number.isFinite(serial)) {
    return rawValue
  }
  return formatXlsxSerialDate(serial, { use1904DateSystem: context.use1904DateSystem }) ?? rawValue
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

function padRows(rows: string[][], maxColumns: number): string[][] {
  for (const row of rows) {
    while (row.length < maxColumns) {
      row.push('')
    }
  }
  return rows
}
