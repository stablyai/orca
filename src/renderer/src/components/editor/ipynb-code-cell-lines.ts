export const IPYNB_CODE_CELL_PREVIEW_SCAN_CODE_UNITS = 64 * 1024
export const IPYNB_CODE_CELL_PREVIEW_MAX_LINES = 200
export const IPYNB_CODE_CELL_PREVIEW_LINE_MAX_CODE_UNITS = 8 * 1024

const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

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

  // A trailing newline still opens an empty last line, as it does in the Monaco model.
  lines.push(sliceIpynbCodeCellPreviewLine(source, lineStart, scanLength))
  return lines
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
