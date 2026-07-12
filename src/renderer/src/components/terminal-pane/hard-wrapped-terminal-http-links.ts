import type { IBufferLine } from '@xterm/xterm'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const HTTP_FRAGMENT_PATTERN = /^[^\s"'!*(){}|\\^<>`]*/
const VERTICAL_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
const NON_LAYOUT_SUFFIX_PATTERN = /[^\s│┃║╎╏┆┇┊┋|]/
const HARD_WRAP_CONTINUATION_SUFFIX_PATTERN = /[/?&=#%+:-]$/
const MAX_HARD_WRAPPED_HTTP_ROWS = 20
const MIN_HARD_WRAPPED_HTTP_ROWS = 3
const MIN_HARD_WRAP_FILL_RATIO = 0.8

function buildCandidateFromStart(
  buffer: { getLine(y: number): IBufferLine | undefined },
  startY: number,
  currentY: number
): WrappedLogicalLine | null {
  const startLine = buffer.getLine(startY)
  if (!startLine) {
    return null
  }
  const translatedStart = translateLineWithColumns(startLine)
  const schemeIndex = translatedStart.text.search(HTTP_SCHEME_PATTERN)
  if (
    schemeIndex === -1 ||
    !VERTICAL_LAYOUT_FRAME_PATTERN.test(translatedStart.text.slice(0, schemeIndex))
  ) {
    return null
  }

  const continuationPrefix = translatedStart.text.slice(0, schemeIndex)
  let text = ''
  let rightFrameIndex: number | null = null
  let previousRowCanContinue = true
  let sawFilledRow = false
  const rows: WrappedLogicalLine['rows'] = []

  for (let rowY = startY; rowY < startY + MAX_HARD_WRAPPED_HTTP_ROWS; rowY++) {
    if (rowY > startY && !previousRowCanContinue) {
      break
    }
    const line = buffer.getLine(rowY)
    if (!line) {
      break
    }
    const translated = rowY === startY ? translatedStart : translateLineWithColumns(line)
    if (rowY > startY && translated.text.slice(0, schemeIndex) !== continuationPrefix) {
      break
    }

    const fragment = translated.text.slice(schemeIndex).match(HTTP_FRAGMENT_PATTERN)?.[0] ?? ''
    if (!fragment || (rowY > startY && HTTP_SCHEME_PATTERN.test(fragment))) {
      break
    }
    const fragmentEnd = schemeIndex + fragment.length
    const layoutSuffix = translated.text.slice(fragmentEnd)
    const rightFrameOffset = layoutSuffix.search(VERTICAL_LAYOUT_FRAME_PATTERN)
    const currentRightFrameIndex = rightFrameOffset === -1 ? -1 : fragmentEnd + rightFrameOffset
    if (
      currentRightFrameIndex === -1 ||
      (rightFrameIndex !== null && currentRightFrameIndex !== rightFrameIndex) ||
      NON_LAYOUT_SUFFIX_PATTERN.test(layoutSuffix)
    ) {
      break
    }
    rightFrameIndex ??= currentRightFrameIndex

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

    const contentWidth = currentRightFrameIndex - schemeIndex
    const fillsRow = contentWidth > 0 && fragment.length / contentWidth >= MIN_HARD_WRAP_FILL_RATIO
    sawFilledRow ||= fillsRow
    previousRowCanContinue = HARD_WRAP_CONTINUATION_SUFFIX_PATTERN.test(fragment) || fillsRow
  }

  if (rows.length > 1 && (rows.length < MIN_HARD_WRAPPED_HTTP_ROWS || !sawFilledRow)) {
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
  const candidates: WrappedLogicalLine[] = []
  const minY = Math.max(0, currentY - MAX_HARD_WRAPPED_HTTP_ROWS + 1)
  for (let startY = currentY; startY >= minY; startY--) {
    const candidate = buildCandidateFromStart(buffer, startY, currentY)
    if (candidate) {
      candidates.push(candidate)
    }
  }
  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
