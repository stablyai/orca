import type { IBufferLine } from '@xterm/xterm'
import { TERMINAL_HTTP_URL_MAX_LENGTH } from './terminal-http-link-limits'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const HTTP_SCHEME_START_PATTERN = /^https?:\/\//i
const HTTP_STATUS_ROW_PATTERN = /^HTTP\/\d(?:\.\d)?:\d{3}(?:\s|$)/i
const VERTICAL_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
const EMPTY_LABEL_ROW_PATTERN = /^[^\s:][^:]*:$/
const LABEL_WITH_SPACING_ROW_PATTERN = /^[^\s:][^:]*:\s/

function maxEdgeWrappedHttpRows(lineLength: number, padding: number): number {
  // Width-2 cells give at least floor(columns / 2) characters per continued row; add two fragment rows to bound scanning by URL length.
  const symmetricWidth = lineLength - padding * 2
  // A symmetric content area must fit at least "http://" to contain a start row.
  const contentWidth = symmetricWidth >= 7 ? symmetricWidth : lineLength - padding
  const minCharsPerFullRow = Math.max(1, Math.floor(contentWidth / 2))
  return Math.ceil(TERMINAL_HTTP_URL_MAX_LENGTH / minCharsPerFullRow) + 2
}

type TrimmedTranslatedLine = {
  text: string
  sourceText: string
  columns: number[]
  lineLength: number
  padding: number
  hasWrittenRightPadding: boolean
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
    lineLength: line.length,
    padding: translated.text.match(/^ */)?.[0].length ?? 0,
    hasWrittenRightPadding:
      typeof line.getCell !== 'function' || line.getCell(line.length - 1)?.getChars() === ' '
  }
}

function firstCellWidth(row: TrimmedTranslatedLine, padding: number): number {
  const firstColumn = row.columns[padding]
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
  let searchStart = text.search(/\S+\s*$/)
  if (searchStart === -1) {
    return -1
  }
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
  row: TrimmedTranslatedLine,
  nextRow: TrimmedTranslatedLine,
  padding: number,
  rightPadding: number
): boolean {
  if (rightPadding > 0 && !row.hasWrittenRightPadding) {
    return false
  }
  // A cursor-positioned label is not continuation evidence even after an edge-ending URL.
  const nextColumnAfterText = nextRow.columns.at(-1)
  const nextRowText = nextRow.text.slice(padding)
  const nextRowReachesEdge =
    nextColumnAfterText !== undefined && nextColumnAfterText >= nextRow.lineLength - rightPadding
  const isLabelRow =
    LABEL_WITH_SPACING_ROW_PATTERN.test(nextRowText) ||
    ((EMPTY_LABEL_ROW_PATTERN.test(nextRowText) || HTTP_STATUS_ROW_PATTERN.test(nextRowText)) &&
      !nextRowReachesEdge)
  if (isLabelRow || HTTP_SCHEME_START_PATTERN.test(nextRowText) || nextRow.padding !== padding) {
    return false
  }
  const columnAfterText = row.columns.at(-1)
  const rightEdge = row.lineLength - rightPadding
  if (
    columnAfterText === undefined ||
    columnAfterText < rightEdge - 1 ||
    columnAfterText > rightEdge
  ) {
    return false
  }
  return columnAfterText >= rightEdge || firstCellWidth(nextRow, padding) > 1
}

export function buildEdgeWrappedHttpLogicalLineCandidates(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine[] {
  // Without xterm wrap metadata, accept cursor-positioned continuation only when preceding rows reach the edge.
  const currentY = bufferLineNumber - 1
  const currentLine = buffer.getLine(currentY)
  if (!currentLine) {
    return []
  }
  const currentPadding = currentLine.translateToString(false).match(/^ */)?.[0].length ?? 0
  if (currentPadding === currentLine.length) {
    return []
  }
  const maxRows = maxEdgeWrappedHttpRows(currentLine.length, currentPadding)

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
    const startText = buffer.getLine(startY)?.translateToString(false)
    const schemeIndex = startText ? findHttpSchemeIndex(startText) : -1
    if (!startText || schemeIndex === -1 || VERTICAL_LAYOUT_FRAME_PATTERN.test(startText)) {
      continue
    }
    const start = getTranslatedLine(startY)
    if (!start) {
      continue
    }
    const rightPadding = start.columns.at(-1) === start.lineLength ? 0 : start.padding
    const continuationPadding = getTranslatedLine(startY + 1)?.padding ?? start.padding
    if (
      continuationPadding !== 0 &&
      (continuationPadding < start.padding ||
        continuationPadding > (start.columns[schemeIndex] ?? start.padding))
    ) {
      continue
    }

    let text = ''
    let exceedsLengthLimit = false
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
        !rowsCanContinueAtTerminalEdge(
          getTranslatedLine(rowY - 1)!,
          translated,
          continuationPadding,
          rightPadding
        )
      ) {
        break
      }
      const fragmentStartIndex =
        rowY === startY ? schemeIndex : line.isWrapped ? 0 : continuationPadding
      const fragment = translated.text.slice(fragmentStartIndex)
      const whitespaceIndex = fragment.search(/\s/)
      const possibleUrlFragmentLength = whitespaceIndex === -1 ? fragment.length : whitespaceIndex
      if (text.length + possibleUrlFragmentLength > TERMINAL_HTTP_URL_MAX_LENGTH) {
        exceedsLengthLimit = true
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
      if (whitespaceIndex !== -1) {
        break
      }
    }
    if (!exceedsLengthLimit && rows.length > 1 && rows.at(-1)!.y >= currentY) {
      candidates.push({
        text,
        rows,
        fingerprint: `edge-http:${rows.map((row) => `${row.y}:${row.sourceText}`).join('\0')}`
      })
    }
  }

  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
