export const IPYNB_CODE_CELL_EDITOR_HEIGHT_SCAN_CODE_UNITS = 64 * 1024
export const IPYNB_CODE_CELL_PREVIEW_SCAN_CODE_UNITS = 64 * 1024
export const IPYNB_CODE_CELL_PREVIEW_MAX_LINES = 200
export const IPYNB_CODE_CELL_PREVIEW_LINE_MAX_CODE_UNITS = 8 * 1024

const IPYNB_CODE_CELL_EDITOR_MIN_HEIGHT_PX = 96
const IPYNB_CODE_CELL_EDITOR_MAX_HEIGHT_PX = 520
const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

export function getIpynbCodeCellEditorHeight(source: string, fontSize: number): number {
  const rowHeight = Math.max(1, fontSize + 8)
  const capRows = Math.ceil(IPYNB_CODE_CELL_EDITOR_MAX_HEIGHT_PX / rowHeight)
  const rowCount = countIpynbCodeCellRowsForHeight(source, capRows)
  return Math.min(
    IPYNB_CODE_CELL_EDITOR_MAX_HEIGHT_PX,
    Math.max(IPYNB_CODE_CELL_EDITOR_MIN_HEIGHT_PX, rowCount * rowHeight)
  )
}

export function getIpynbCodeCellPreviewLines(source: string): string[] {
  if (source.length === 0) {
    return ['']
  }

  const lines: string[] = []
  const scanLength = Math.min(source.length, IPYNB_CODE_CELL_PREVIEW_SCAN_CODE_UNITS)
  let lineStart = 0

  for (let index = 0; index < scanLength; index += 1) {
    if (source.charCodeAt(index) !== LINE_FEED_CODE_UNIT) {
      continue
    }
    lines.push(sliceIpynbCodeCellPreviewLine(source, lineStart, index))
    if (lines.length >= IPYNB_CODE_CELL_PREVIEW_MAX_LINES) {
      return lines
    }
    lineStart = index + 1
  }

  if (lineStart < scanLength) {
    lines.push(sliceIpynbCodeCellPreviewLine(source, lineStart, scanLength))
  }

  return lines.length > 0 ? lines : ['']
}

function countIpynbCodeCellRowsForHeight(source: string, capRows: number): number {
  if (source.length === 0) {
    return 3
  }

  const scanLength = Math.min(source.length, IPYNB_CODE_CELL_EDITOR_HEIGHT_SCAN_CODE_UNITS)
  let rowCount = 2
  for (let index = 0; index < scanLength; index += 1) {
    if (source.charCodeAt(index) !== LINE_FEED_CODE_UNIT) {
      continue
    }
    rowCount += 1
    if (rowCount >= capRows) {
      return rowCount
    }
  }
  return Math.max(3, rowCount)
}

function sliceIpynbCodeCellPreviewLine(source: string, lineStart: number, lineEnd: number): string {
  // Why: inactive notebook cells are colorized as one joined string; bound each
  // preview line so a single pasted line cannot monopolize the renderer.
  const normalizedLineEnd =
    lineEnd > lineStart && source.charCodeAt(lineEnd - 1) === CARRIAGE_RETURN_CODE_UNIT
      ? lineEnd - 1
      : lineEnd
  return source.slice(
    lineStart,
    Math.min(normalizedLineEnd, lineStart + IPYNB_CODE_CELL_PREVIEW_LINE_MAX_CODE_UNITS)
  )
}
