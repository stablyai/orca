import type { IBufferLine } from '@xterm/xterm'
import type { WrappedLogicalLine } from './wrapped-terminal-link-ranges'

type TerminalBufferLineWithColumns = IBufferLine & {
  translateToString(
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
    outColumns?: number[]
  ): string
}

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const MAX_HARD_WRAPPED_HTTP_ROWS = 20

function translateLineWithColumns(line: IBufferLine): { text: string; columns: number[] } {
  const columns: number[] = []
  const text = (line as TerminalBufferLineWithColumns).translateToString(
    false,
    0,
    undefined,
    columns
  )
  return {
    text,
    columns:
      columns.length === text.length + 1
        ? columns
        : Array.from({ length: text.length + 1 }, (_value, index) => index)
  }
}

function isVerticalLayoutFrameCharacter(character: string): boolean {
  return '│┃║╎╏┆┇┊┋|'.includes(character)
}

function hasOnlyHardWrappedLayoutSuffix(text: string, startIndex: number): boolean {
  for (const character of text.slice(startIndex)) {
    if (!/\s/.test(character) && !isVerticalLayoutFrameCharacter(character)) {
      return false
    }
  }
  return true
}

function hardWrappedHttpFragmentEnd(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (
      /\s/.test(text[index]) ||
      code === 0x22 ||
      code === 0x27 ||
      code === 0x21 ||
      code === 0x2a ||
      code === 0x28 ||
      code === 0x29 ||
      code === 0x7b ||
      code === 0x7d ||
      code === 0x7c ||
      code === 0x5c ||
      code === 0x5e ||
      code === 0x3c ||
      code === 0x3e ||
      code === 0x60
    ) {
      return index
    }
  }
  return text.length
}

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
  if (schemeIndex === -1) {
    return null
  }

  const continuationColumn = schemeIndex
  const continuationPrefix = translatedStart.text.slice(0, continuationColumn)
  let text = ''
  const rows: WrappedLogicalLine['rows'] = []
  for (let rowY = startY; rowY < startY + MAX_HARD_WRAPPED_HTTP_ROWS; rowY++) {
    const line = buffer.getLine(rowY)
    if (!line) {
      break
    }
    const translated = rowY === startY ? translatedStart : translateLineWithColumns(line)
    if (rowY > startY && translated.text.slice(0, continuationColumn) !== continuationPrefix) {
      break
    }
    const fragmentStart = continuationColumn
    const fragmentEnd = hardWrappedHttpFragmentEnd(translated.text, fragmentStart)
    if (fragmentEnd <= fragmentStart) {
      break
    }
    const fragment = translated.text.slice(fragmentStart, fragmentEnd)
    if (rowY > startY && HTTP_SCHEME_PATTERN.test(fragment)) {
      break
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
    if (!hasOnlyHardWrappedLayoutSuffix(translated.text, fragmentEnd)) {
      break
    }
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
