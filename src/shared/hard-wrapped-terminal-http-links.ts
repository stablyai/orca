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
const NON_LAYOUT_SUFFIX_PATTERN = /[^\s│┃║╎╏┆┇┊┋|]/
const HARD_WRAP_CONTINUATION_SUFFIX_PATTERN = /[/?&=#%+:-]$/
const LAYOUT_SUFFIX_CHAR_PATTERN = /[\s│┃║╎╏┆┇┊┋|]/
const MIN_HARD_WRAPPED_HTTP_ROWS = 3
const MIN_HARD_WRAP_FILL_RATIO = 0.8
// Why: a two-row URL in the left table column has no blank sibling cell to
// prove the continuation, so its start row must end at the cell border instead.
const MIN_HARD_WRAP_BORDER_FILL_RATIO = 0.95

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

type FramedFragmentStart = { startIndex: number; blankCellContinuation: boolean }

// Overlay rows share the frame column and inner padding; the uncovered gutter can differ.
function findOverlayFragmentStart(
  translated: TranslatedLine,
  frameColumn: number,
  outerFrameColumn: number | null,
  framedPrefix: string
): FramedFragmentStart | null {
  const frameIndex = translated.columns.indexOf(frameColumn)
  if (frameIndex === -1) {
    return null
  }
  const prefixEnd = frameIndex + framedPrefix.length
  if (translated.text.slice(frameIndex, prefixEnd) !== framedPrefix) {
    return null
  }
  const outerFrameIndex =
    outerFrameColumn === null || !hasFrameAtColumn(translated, outerFrameColumn)
      ? -1
      : translated.columns.indexOf(outerFrameColumn)
  if (outerFrameIndex === -1) {
    return { startIndex: prefixEnd, blankCellContinuation: false }
  }
  // Why: a wrapped table cell leaves its sibling cells blank, so a blank gutter
  // continues the same URL, while a labelled gutter is an adjacent table cell.
  const gutter = translated.text.slice(outerFrameIndex + 1, frameIndex)
  return NON_LAYOUT_SUFFIX_PATTERN.test(gutter)
    ? null
    : { startIndex: prefixEnd, blankCellContinuation: true }
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
  let startRowFillRatio = 0
  let blankCellContinuationRows = 0
  let blankTrailingCellRows = 0
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
        ? { startIndex: schemeIndex, blankCellContinuation: false }
        : findOverlayFragmentStart(translated, frameColumn, outerFrameColumn, framedPrefix)
    if (!fragmentStart) {
      break
    }
    const fragmentStartColumn = translated.columns[fragmentStart.startIndex]
    if (fragmentStartColumn === undefined) {
      break
    }

    const fragment =
      translated.text.slice(fragmentStart.startIndex).match(HTTP_FRAGMENT_PATTERN)?.[0] ?? ''
    if (!fragment || (rowY > startY && HTTP_SCHEME_START_PATTERN.test(fragment))) {
      break
    }
    const fragmentEnd = fragmentStart.startIndex + fragment.length
    const layoutSuffix = translated.text.slice(fragmentEnd)
    const rightFrameOffset = layoutSuffix.search(VERTICAL_LAYOUT_FRAME_PATTERN)
    const currentRightFrameIndex = rightFrameOffset === -1 ? -1 : fragmentEnd + rightFrameOffset
    const currentRightFrameColumn = translated.columns[currentRightFrameIndex]
    // Why: a URL that fills one cell of a multi-column table is followed by the
    // sibling cells, so only the padding inside its own cell must be blank.
    const cellSuffix =
      rightFrameOffset === -1 ? layoutSuffix : layoutSuffix.slice(0, rightFrameOffset)
    if (
      currentRightFrameIndex === -1 ||
      currentRightFrameColumn === undefined ||
      (rightFrameColumn !== null && currentRightFrameColumn !== rightFrameColumn) ||
      NON_LAYOUT_SUFFIX_PATTERN.test(cellSuffix)
    ) {
      break
    }
    rightFrameColumn ??= currentRightFrameColumn

    // Why: a wrapped cell leaves the cells right of it blank, which marks a
    // continuation row even when the left prefix is unchanged (first column).
    const trailingCells = translated.text.slice(currentRightFrameIndex + 1)
    const rowHasBlankTrailingCells =
      VERTICAL_LAYOUT_FRAME_PATTERN.test(trailingCells) &&
      !NON_LAYOUT_SUFFIX_PATTERN.test(trailingCells)

    if (text.length + fragment.length > TERMINAL_HTTP_URL_MAX_LENGTH) {
      return null
    }

    rows.push({
      y: rowY,
      text: fragment,
      sourceText: translated.text,
      columns: translated.columns.slice(fragmentStart.startIndex, fragmentEnd + 1),
      startIndex: text.length,
      isWrapped: line.isWrapped,
      lineLength: line.length
    })
    text += fragment
    if (fragmentStart.blankCellContinuation) {
      blankCellContinuationRows++
    }
    if (rowY > startY && rowHasBlankTrailingCells) {
      blankTrailingCellRows++
    }

    const contentWidth = currentRightFrameColumn - fragmentStartColumn
    const fragmentWidth = translated.columns[fragmentEnd]! - fragmentStartColumn
    const fillRatio = contentWidth > 0 ? fragmentWidth / contentWidth : 0
    const fillsRow = fillRatio >= MIN_HARD_WRAP_FILL_RATIO
    if (rowY === startY) {
      startRowFilled = fillsRow
      startRowFillRatio = fillRatio
    }
    previousRowCanContinue = HARD_WRAP_CONTINUATION_SUFFIX_PATTERN.test(fragment) || fillsRow
  }

  // Why: a URL wrapped inside one table cell blanks its sibling cells, which is
  // stronger evidence than the row count for a URL wrapped onto a second row.
  const hasRowCountEvidence =
    rows.length >= MIN_HARD_WRAPPED_HTTP_ROWS ||
    (blankCellContinuationRows > 0 && blankCellContinuationRows === rows.length - 1) ||
    (startRowFillRatio >= MIN_HARD_WRAP_BORDER_FILL_RATIO &&
      blankTrailingCellRows === rows.length - 1)
  if (rows.length > 1 && (!startRowFilled || !hasRowCountEvidence)) {
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
