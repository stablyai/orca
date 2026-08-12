import type { IBufferLine } from '@xterm/xterm'
import { TERMINAL_HTTP_URL_MAX_LENGTH } from './terminal-http-link-limits'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const HTTP_SCHEME_START_PATTERN = /^https?:\/\//i
const HTTP_STATUS_ROW_PATTERN = /^HTTP\/\d(?:\.\d)?:\d{3}(?:\s|$)/i
const VERTICAL_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
const EMPTY_LABEL_ROW_PATTERN = /^[^\s:][^:]*:$/
const LABEL_WITH_SPACING_ROW_PATTERN = /^[^\s:][^:]*:\s/

function maxEdgeWrappedHttpRows(lineLength: number): number {
  // Why: every continued row reaches the terminal edge, so even all-width-2
  // cells carry at least floor(columns / 2) characters per row; the URL length
  // limit then bounds the scan without truncating URLs on narrow terminals.
  // The +2 covers the start and tail rows, which may hold only a fragment.
  const minCharsPerFullRow = Math.max(1, Math.floor(lineLength / 2))
  return Math.ceil(TERMINAL_HTTP_URL_MAX_LENGTH / minCharsPerFullRow) + 2
}

type TrimmedTranslatedLine = {
  text: string
  sourceText: string
  columns: number[]
  lineLength: number
}

function trimRightTranslatedLine(line: IBufferLine): TrimmedTranslatedLine | null {
  const translated = translateLineWithColumns(line)
  let endIndex = translated.text.length
  while (endIndex > 0 && /\s/.test(translated.text[endIndex - 1])) {
    endIndex--
  }
  if (endIndex === 0) {
    return null
  }
  return {
    text: translated.text.slice(0, endIndex),
    sourceText: translated.text,
    columns: translated.columns.slice(0, endIndex + 1),
    lineLength: line.length
  }
}

function firstCellWidth(row: TrimmedTranslatedLine): number {
  const firstColumn = row.columns[0]
  if (firstColumn === undefined) {
    return 0
  }
  const nextColumn = row.columns.find((column) => column > firstColumn)
  return nextColumn === undefined ? 0 : nextColumn - firstColumn
}

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  )
}

function findHttpSchemeIndex(text: string): number {
  let searchStart = 0
  while (searchStart < text.length) {
    const relativeIndex = text.slice(searchStart).search(HTTP_SCHEME_PATTERN)
    if (relativeIndex === -1) {
      return -1
    }
    const schemeIndex = searchStart + relativeIndex
    if (schemeIndex === 0 || !isAsciiWordCode(text.charCodeAt(schemeIndex - 1))) {
      return schemeIndex
    }
    searchStart = schemeIndex + 1
  }
  return -1
}

function rowsCanContinueAtTerminalEdge(
  row: WrappedLogicalLine['rows'][number],
  nextRow: TrimmedTranslatedLine
): boolean {
  // Why: a cursor-positioned label is not URL continuation evidence even when
  // the preceding URL happens to end at the terminal edge (#8832).
  const nextColumnAfterText = nextRow.columns.at(-1)
  const nextRowReachesEdge =
    nextColumnAfterText !== undefined && nextColumnAfterText >= nextRow.lineLength
  const isLabelRow =
    LABEL_WITH_SPACING_ROW_PATTERN.test(nextRow.text) ||
    ((EMPTY_LABEL_ROW_PATTERN.test(nextRow.text) || HTTP_STATUS_ROW_PATTERN.test(nextRow.text)) &&
      !nextRowReachesEdge)
  if (isLabelRow || HTTP_SCHEME_START_PATTERN.test(nextRow.text)) {
    return false
  }
  const columnAfterText = row.columns.at(-1)
  if (columnAfterText === undefined || columnAfterText < row.lineLength - 1) {
    return false
  }
  return columnAfterText >= row.lineLength || firstCellWidth(nextRow) > 1
}

export function buildEdgeWrappedHttpLogicalLineCandidates(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine[] {
  // Why: cursor-positioned output lacks xterm wrap metadata, but an HTTP URL
  // may still continue when each earlier row reaches the terminal edge.
  const currentY = bufferLineNumber - 1
  const currentLine = buffer.getLine(currentY)
  if (!currentLine) {
    return []
  }
  const maxRows = maxEdgeWrappedHttpRows(currentLine.length)

  const candidates: WrappedLogicalLine[] = []
  const translatedLines = new Map<number, TrimmedTranslatedLine | null>()
  const getTranslatedLine = (rowY: number): TrimmedTranslatedLine | null => {
    if (translatedLines.has(rowY)) {
      return translatedLines.get(rowY) ?? null
    }
    const line = buffer.getLine(rowY)
    const translated = line ? trimRightTranslatedLine(line) : null
    translatedLines.set(rowY, translated)
    return translated
  }
  const minY = Math.max(0, currentY - maxRows + 1)
  for (let startY = currentY; startY >= minY; startY--) {
    const start = getTranslatedLine(startY)
    const schemeIndex = start ? findHttpSchemeIndex(start.text) : -1
    if (!start || schemeIndex === -1 || VERTICAL_LAYOUT_FRAME_PATTERN.test(start.text)) {
      continue
    }

    let text = ''
    const rows: WrappedLogicalLine['rows'] = []
    for (let rowY = startY; rowY < startY + maxRows; rowY++) {
      const line = buffer.getLine(rowY)
      const translated = getTranslatedLine(rowY)
      if (!line || !translated) {
        break
      }
      if (VERTICAL_LAYOUT_FRAME_PATTERN.test(translated.text)) {
        break
      }
      if (
        rows.length > 0 &&
        !line.isWrapped &&
        !rowsCanContinueAtTerminalEdge(rows.at(-1)!, translated)
      ) {
        break
      }
      const fragmentStartIndex = rowY === startY ? schemeIndex : 0
      const fragment = translated.text.slice(fragmentStartIndex)
      const whitespaceIndex = fragment.search(/\s/)
      const possibleUrlFragmentLength = whitespaceIndex === -1 ? fragment.length : whitespaceIndex
      if (text.length + possibleUrlFragmentLength > TERMINAL_HTTP_URL_MAX_LENGTH) {
        break
      }

      rows.push({
        y: rowY,
        text: fragment,
        sourceText: translated.sourceText,
        columns: translated.columns.slice(fragmentStartIndex),
        startIndex: text.length,
        isWrapped: line.isWrapped,
        lineLength: line.length
      })
      text += fragment
      if (rows.length > 1 && rowY >= currentY) {
        candidates.push({
          text,
          rows: [...rows],
          fingerprint: `edge-http:${rows.map((row) => `${row.y}:${row.sourceText}`).join('\0')}`
        })
      }
    }
  }

  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
