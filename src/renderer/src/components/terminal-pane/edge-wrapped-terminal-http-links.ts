import type { IBufferLine } from '@xterm/xterm'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { TERMINAL_HTTP_URL_MAX_LENGTH } from './terminal-http-link-limits'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const HTTP_SCHEME_START_PATTERN = /^https?:\/\//i
const HTTP_STATUS_ROW_PATTERN = /^HTTP\/\d(?:\.\d)?:\d{3}(?:\s|$)/i
const VERTICAL_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
const EMPTY_LABEL_ROW_PATTERN = /^[^\s:][^:]*:$/
const LABEL_WITH_SPACING_ROW_PATTERN = /^[^\s:][^:]*:\s/
const HANGING_INDENT_REMAINDER_PATTERN = /^\s+\S/
const URL_WRAP_REMAINDER_PREFIX_PATTERN = /^[/?#&=%]/

function maxEdgeWrappedHttpRows(lineLength: number, padding: number): number {
  // Why: every continued row reaches the terminal edge, so even all-width-2
  // cells carry at least floor(columns / 2) characters per row; the URL length
  // limit then bounds the scan without truncating URLs on narrow terminals.
  // The +2 covers the start and tail rows, which may hold only a fragment.
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


function isNonUrlContinuationRow(
  nextRow: TrimmedTranslatedLine,
  padding: number,
  rightPadding: number
): boolean {
  const nextColumnAfterText = nextRow.columns.at(-1)
  const nextRowText = nextRow.text.slice(padding)
  const nextRowReachesEdge =
    nextColumnAfterText !== undefined && nextColumnAfterText >= nextRow.lineLength - rightPadding
  const trimmedNext = nextRowText.trimStart()
  const isLabelRow =
    LABEL_WITH_SPACING_ROW_PATTERN.test(nextRowText) ||
    ((EMPTY_LABEL_ROW_PATTERN.test(nextRowText) || HTTP_STATUS_ROW_PATTERN.test(nextRowText)) &&
      !nextRowReachesEdge)
  return (
    isLabelRow ||
    HTTP_SCHEME_START_PATTERN.test(trimmedNext) ||
    isWindowsAbsolutePathLike(trimmedNext)
  )
}

function urlFragmentFromTranslatedRow(
  translated: TrimmedTranslatedLine,
  startIndex: number,
  stripLeadingWhitespace: boolean
): { text: string; columns: number[] } {
  const rawFragment = translated.text.slice(startIndex)
  const indent = stripLeadingWhitespace ? rawFragment.length - rawFragment.trimStart().length : 0
  return {
    text: rawFragment.slice(indent),
    columns: translated.columns.slice(startIndex + indent)
  }
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
  // Why: a cursor-positioned label is not URL continuation evidence even when
  // the preceding URL happens to end at the terminal edge (#8832).
  if (isNonUrlContinuationRow(nextRow, padding, rightPadding)) {
    return false
  }
  // Why: PowerShell Format-List and word-wrap emit a hard newline, so the first
  // row often misses the terminal edge. Join a hanging indent, or a `/ ? & # % =`
  // remainder only when the previous URL looks cut off — a complete `.../` next
  // to `/usr/...` is a following path, not a wrap (#8832, #14291).
  const nextRemainder = nextRow.text.trimStart()
  if (
    HANGING_INDENT_REMAINDER_PATTERN.test(nextRow.text) ||
    (URL_WRAP_REMAINDER_PREFIX_PATTERN.test(nextRemainder) && !row.text.endsWith('/'))
  ) {
    return true
  }
  if (nextRow.padding !== padding) {
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
  // Why: cursor-positioned output lacks xterm wrap metadata. Join at the
  // terminal edge, and also join PowerShell hanging-indent / cut-off remainders.
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
      const fragment = urlFragmentFromTranslatedRow(translated, fragmentStartIndex, rowY > startY)
      if (!fragment.text) {
        break
      }
      const whitespaceIndex = fragment.text.search(/\s/)
      const possibleUrlFragmentLength =
        whitespaceIndex === -1 ? fragment.text.length : whitespaceIndex
      if (text.length + possibleUrlFragmentLength > TERMINAL_HTTP_URL_MAX_LENGTH) {
        exceedsLengthLimit = true
        break
      }

      rows.push({
        y: rowY,
        text: fragment.text,
        sourceText: translated.sourceText,
        columns: fragment.columns,
        startIndex: text.length,
        isWrapped: line.isWrapped,
        lineLength: line.length
      })
      text += fragment.text
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
