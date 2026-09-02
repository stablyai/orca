import type { IBufferLine } from '@xterm/xterm'
import {
  TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS,
  TERMINAL_HTTP_URL_MAX_LENGTH
} from './terminal-http-link-limits'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const HTTP_SCHEME_START_PATTERN = /^https?:\/\//i
const HTTP_FRAGMENT_PATTERN = /^[^\s"'!*(){}|\\^<>`│┃║╎╏┆┇┊┋]*/
const VERTICAL_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
const NON_LAYOUT_SUFFIX_PATTERN = /[^\s│┃║╎╏┆┇┊┋|]/
const HARD_WRAP_CONTINUATION_SUFFIX_PATTERN = /[/?&=#%+:-]$/
const MIN_HARD_WRAPPED_HTTP_ROWS = 3
const MIN_HARD_WRAP_FILL_RATIO = 0.8

type TranslatedLine = ReturnType<typeof translateLineWithColumns>

function buildCandidateFromStart(
  buffer: { getLine(y: number): IBufferLine | undefined },
  startY: number,
  currentY: number,
  translatedLines: Map<number, TranslatedLine>
): WrappedLogicalLine | null {
  const startLine = buffer.getLine(startY)
  if (!startLine) {
    return null
  }
  const cachedStart = translatedLines.get(startY)
  const startText = cachedStart?.text ?? startLine.translateToString(false)
  const schemeIndex = startText.search(HTTP_SCHEME_PATTERN)
  if (schemeIndex === -1 || !VERTICAL_LAYOUT_FRAME_PATTERN.test(startText.slice(0, schemeIndex))) {
    return null
  }
  const translatedStart = cachedStart ?? translateLineWithColumns(startLine)
  translatedLines.set(startY, translatedStart)
  const schemeColumn = translatedStart.columns[schemeIndex]
  if (schemeColumn === undefined) {
    return null
  }

  const continuationPrefix = translatedStart.text.slice(0, schemeIndex)
  let text = ''
  let rightFrameColumn: number | null = null
  let previousRowCanContinue = true
  let startRowFilled = false
  const rows: WrappedLogicalLine['rows'] = []

  for (let rowY = startY; rowY < startY + TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS; rowY++) {
    if (rowY > startY && !previousRowCanContinue) {
      break
    }
    const line = buffer.getLine(rowY)
    if (!line) {
      break
    }
    const translated =
      rowY === startY
        ? translatedStart
        : (translatedLines.get(rowY) ?? translateLineWithColumns(line))
    translatedLines.set(rowY, translated)
    if (rowY > startY && translated.text.slice(0, schemeIndex) !== continuationPrefix) {
      break
    }

    const fragment = translated.text.slice(schemeIndex).match(HTTP_FRAGMENT_PATTERN)?.[0] ?? ''
    if (!fragment || (rowY > startY && HTTP_SCHEME_START_PATTERN.test(fragment))) {
      break
    }
    const fragmentEnd = schemeIndex + fragment.length
    const layoutSuffix = translated.text.slice(fragmentEnd)
    const rightFrameOffset = layoutSuffix.search(VERTICAL_LAYOUT_FRAME_PATTERN)
    const currentRightFrameIndex = rightFrameOffset === -1 ? -1 : fragmentEnd + rightFrameOffset
    const currentRightFrameColumn = translated.columns[currentRightFrameIndex]
    if (
      currentRightFrameIndex === -1 ||
      currentRightFrameColumn === undefined ||
      (rightFrameColumn !== null && currentRightFrameColumn !== rightFrameColumn) ||
      NON_LAYOUT_SUFFIX_PATTERN.test(layoutSuffix)
    ) {
      break
    }
    rightFrameColumn ??= currentRightFrameColumn

    if (text.length + fragment.length > TERMINAL_HTTP_URL_MAX_LENGTH) {
      return null
    }

    rows.push({
      y: rowY,
      text: fragment,
      sourceText: translated.text,
      columns: translated.columns.slice(schemeIndex, fragmentEnd + 1),
      startIndex: text.length,
      isWrapped: line.isWrapped,
      lineLength: line.length
    })
    text += fragment

    const contentWidth = currentRightFrameColumn - schemeColumn
    const fragmentWidth = translated.columns[fragmentEnd]! - schemeColumn
    const fillsRow = contentWidth > 0 && fragmentWidth / contentWidth >= MIN_HARD_WRAP_FILL_RATIO
    if (rowY === startY) {
      startRowFilled = fillsRow
    }
    previousRowCanContinue = HARD_WRAP_CONTINUATION_SUFFIX_PATTERN.test(fragment) || fillsRow
  }

  if (rows.length > 1 && (rows.length < MIN_HARD_WRAPPED_HTTP_ROWS || !startRowFilled)) {
    // Why: a short complete URL can legitimately end in `/`; one adjacent
    // framed token is not enough evidence that the URL continued onto it.
    rows.splice(1)
    text = rows[0]?.text ?? ''
  }
  if (rows.at(-1)?.y === undefined || rows.at(-1)!.y < currentY) {
    return null
  }
  return {
    text,
    rows,
    fingerprint: `hard-http:${rows.map((row) => `${row.y}:${row.sourceText}`).join('\0')}`
  }
}

export function buildHardWrappedHttpLogicalLineCandidates(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const currentY = bufferLineNumber - 1
  const currentLine = buffer.getLine(currentY)
  if (!currentLine || !VERTICAL_LAYOUT_FRAME_PATTERN.test(currentLine.translateToString(false))) {
    // Why: cursor-positioned hard wraps require a stable vertical frame; most
    // terminal clicks can avoid the bounded backward scan entirely.
    return []
  }
  const candidates: WrappedLogicalLine[] = []
  const translatedLines = new Map<number, TranslatedLine>()
  const minY = Math.max(0, currentY - TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS + 1)
  for (let startY = currentY; startY >= minY; startY--) {
    const candidate = buildCandidateFromStart(buffer, startY, currentY, translatedLines)
    if (candidate) {
      candidates.push(candidate)
    }
  }
  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
