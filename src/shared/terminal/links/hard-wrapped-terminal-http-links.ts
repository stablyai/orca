import {
  TERMINAL_HTTP_URL_MAX_HARD_WRAPPED_ROWS,
  TERMINAL_HTTP_URL_MAX_LENGTH
} from './terminal-http-link-limits'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'
import type { TerminalLinkBuffer } from './terminal-link-buffer'

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const HTTP_SCHEME_START_PATTERN = /^https?:\/\//i
const HTTP_FRAGMENT_PATTERN = /^[^\s"'!*(){}|\\^<>`│┃║╎╏┆┇┊┋]*/
const VERTICAL_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
const CLOSING_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]\s*$/
const NON_LAYOUT_SUFFIX_PATTERN = /[^\s│┃║╎╏┆┇┊┋|]/
const HARD_WRAP_CONTINUATION_SUFFIX_PATTERN = /[/?&=#%+:-]$/
const LAYOUT_SUFFIX_CHAR_PATTERN = /[\s│┃║╎╏┆┇┊┋|]/
const MIN_HARD_WRAPPED_HTTP_ROWS = 3
const MIN_HARD_WRAP_FILL_RATIO = 0.8

type TranslatedLine = ReturnType<typeof translateLineWithColumns>

// Continuation rows end in frame + prefix + URL fragment + layout-only suffix with a right frame.
function canBeFramedContinuationRow(text: string): boolean {
  let contentEnd = text.length
  let hasRightFrame = false
  while (contentEnd > 0 && LAYOUT_SUFFIX_CHAR_PATTERN.test(text[contentEnd - 1]!)) {
    hasRightFrame ||= VERTICAL_LAYOUT_FRAME_PATTERN.test(text[contentEnd - 1]!)
    contentEnd--
  }
  return (
    hasRightFrame &&
    contentEnd > 0 &&
    Boolean(HTTP_FRAGMENT_PATTERN.exec(text[contentEnd - 1]!)?.[0]) &&
    VERTICAL_LAYOUT_FRAME_PATTERN.test(text.slice(0, contentEnd))
  )
}

function findFrameIndexBefore(text: string, beforeIndex: number): number {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    if (VERTICAL_LAYOUT_FRAME_PATTERN.test(text[index]!)) {
      return index
    }
  }
  return -1
}

function hasFrameAtColumn(translated: TranslatedLine, frameColumn: number): boolean {
  const frameIndex = translated.columns.indexOf(frameColumn)
  return frameIndex !== -1 && VERTICAL_LAYOUT_FRAME_PATTERN.test(translated.text[frameIndex] ?? '')
}

// Overlay rows share the frame column and inner padding; the uncovered gutter can differ.
function findOverlayFragmentStart(
  translated: TranslatedLine,
  frameColumn: number,
  outerFrameColumn: number | null,
  framedPrefix: string
): number {
  const frameIndex = translated.columns.indexOf(frameColumn)
  if (frameIndex === -1) {
    return -1
  }
  // Table cells left of the URL: blank ones continue its wrapped cell, filled ones start a new row.
  if (
    outerFrameColumn !== null &&
    hasFrameAtColumn(translated, outerFrameColumn) &&
    NON_LAYOUT_SUFFIX_PATTERN.test(translated.text.slice(0, frameIndex))
  ) {
    return -1
  }
  const prefixEnd = frameIndex + framedPrefix.length
  return translated.text.slice(frameIndex, prefixEnd) === framedPrefix ? prefixEnd : -1
}

function buildCandidateFromStart(
  buffer: TerminalLinkBuffer,
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
  const frameIndex = findFrameIndexBefore(translatedStart.text, schemeIndex)
  if (frameIndex === -1) {
    return null
  }
  const frameColumn = translatedStart.columns[frameIndex]
  if (frameColumn === undefined) {
    return null
  }
  const outerFrameIndex = findFrameIndexBefore(translatedStart.text, frameIndex)
  const outerFrameColumn =
    outerFrameIndex === -1 ? null : (translatedStart.columns[outerFrameIndex] ?? null)
  const rowPrefix = translatedStart.text.slice(0, schemeIndex)
  const framedPrefix = translatedStart.text.slice(frameIndex, schemeIndex)
  let text = ''
  let rightFrameColumn: number | null = null
  let previousRowCanContinue = true
  let startRowFilled = false
  let isWrappedTableCell = false
  let continuationLeftCells: string | null = null
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
    const fragmentStart =
      rowY === startY || translated.text.slice(0, schemeIndex) === rowPrefix
        ? schemeIndex
        : findOverlayFragmentStart(translated, frameColumn, outerFrameColumn, framedPrefix)
    if (fragmentStart === -1) {
      break
    }
    const fragmentStartColumn = translated.columns[fragmentStart]
    if (fragmentStartColumn === undefined) {
      break
    }
    const leftCells = translated.text.slice(0, fragmentStart - framedPrefix.length)
    const isTableRow = outerFrameColumn !== null && hasFrameAtColumn(translated, outerFrameColumn)
    // A wrapped table cell shows the same cells to its left on every continuation row; a change starts a new row.
    if (rowY > startY + 1 && isTableRow && leftCells !== continuationLeftCells) {
      break
    }

    const fragment = translated.text.slice(fragmentStart).match(HTTP_FRAGMENT_PATTERN)?.[0] ?? ''
    if (!fragment || (rowY > startY && HTTP_SCHEME_START_PATTERN.test(fragment))) {
      break
    }
    const fragmentEnd = fragmentStart + fragment.length
    const layoutSuffix = translated.text.slice(fragmentEnd)
    const rightFrameOffset = layoutSuffix.search(VERTICAL_LAYOUT_FRAME_PATTERN)
    const currentRightFrameIndex = rightFrameOffset === -1 ? -1 : fragmentEnd + rightFrameOffset
    const currentRightFrameColumn = translated.columns[currentRightFrameIndex]
    // Cells right of the URL may be filled on its first row only; below it they start a new table row.
    const rowSuffix = rowY === startY ? layoutSuffix.slice(0, rightFrameOffset) : layoutSuffix
    if (
      currentRightFrameIndex === -1 ||
      currentRightFrameColumn === undefined ||
      (rightFrameColumn !== null && currentRightFrameColumn !== rightFrameColumn) ||
      NON_LAYOUT_SUFFIX_PATTERN.test(rowSuffix)
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
      columns: translated.columns.slice(fragmentStart, fragmentEnd + 1),
      startIndex: text.length,
      isWrapped: line.isWrapped,
      lineLength: line.length
    })
    text += fragment

    const contentWidth = currentRightFrameColumn - fragmentStartColumn
    const fragmentWidth = translated.columns[fragmentEnd]! - fragmentStartColumn
    const fillsRow = contentWidth > 0 && fragmentWidth / contentWidth >= MIN_HARD_WRAP_FILL_RATIO
    if (rowY === startY) {
      const rightCells = translated.text.slice(currentRightFrameIndex + 1)
      startRowFilled = fillsRow
      // Only framed cells count; screen text around an overlay is not a table row.
      isWrappedTableCell =
        (isTableRow && NON_LAYOUT_SUFFIX_PATTERN.test(leftCells)) ||
        (CLOSING_LAYOUT_FRAME_PATTERN.test(rightCells) &&
          NON_LAYOUT_SUFFIX_PATTERN.test(rightCells))
    } else {
      continuationLeftCells = leftCells
      isWrappedTableCell &&=
        (outerFrameColumn === null || isTableRow) && !NON_LAYOUT_SUFFIX_PATTERN.test(leftCells)
    }
    previousRowCanContinue = HARD_WRAP_CONTINUATION_SUFFIX_PATTERN.test(fragment) || fillsRow
  }

  // A wrapped table cell blanks its row's other cells, which proves continuation without a third row.
  if (
    rows.length > 1 &&
    (!startRowFilled || (rows.length < MIN_HARD_WRAPPED_HTTP_ROWS && !isWrappedTableCell))
  ) {
    // A complete URL may end in /; one adjacent framed token alone cannot prove continuation.
    rows.splice(1)
    text = rows[0]?.text ?? ''
  }
  // oxlint-disable-next-line unicorn/prefer-at -- the phone's terminal WebView (Chrome 74) has no Array#at
  const lastRow: WrappedLogicalLine['rows'][number] | undefined = rows[rows.length - 1]
  if (lastRow?.y === undefined || lastRow.y < currentY) {
    return null
  }
  return {
    text,
    rows,
    fingerprint: `hard-http:${rows.map((row) => `${row.y}:${row.sourceText}`).join('\0')}`
  }
}

export function buildHardWrappedHttpLogicalLineCandidates(
  buffer: TerminalLinkBuffer,
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const currentY = bufferLineNumber - 1
  const currentLine = buffer.getLine(currentY)
  if (!currentLine || !VERTICAL_LAYOUT_FRAME_PATTERN.test(currentLine.translateToString(false))) {
    // Skip backward scanning without the stable vertical frame required for cursor-positioned hard wraps.
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
    // Earlier starts must continue through this row; stop at borders, prose, and blank rows.
    const rowText =
      translatedLines.get(startY)?.text ?? buffer.getLine(startY)?.translateToString(false)
    if (rowText === undefined || !canBeFramedContinuationRow(rowText)) {
      break
    }
  }
  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
