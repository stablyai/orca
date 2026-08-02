export const PR_COMMENT_CODE_CONTEXT_BLOCK_SCAN_CODE_UNITS = 512 * 1024
export const PR_COMMENT_CODE_CONTEXT_LINE_MAX_CODE_UNITS = 8 * 1024

const LINE_FEED_CODE_UNIT = 10
const CARRIAGE_RETURN_CODE_UNIT = 13

export type PrCommentCodeContextRange = {
  startLine: number
  endLine: number
}

export type PrCommentCodeContext = {
  selectedLines: string[]
  totalLines: number
  commentFrom: number
  commentTo: number
  from: number
  to: number
  blockRange: PrCommentCodeContextRange
  shouldUseBlockRange: boolean
  canExpandAbove: boolean
  canExpandBelow: boolean
  canExpandBlock: boolean
}

type PrCommentCodeContextInput = {
  source: string
  line: number
  startLine: number | null | undefined
  contextBefore: number
  contextAfter: number
  fallbackLines: number
  maxBlockLines: number
}

export function getPrCommentCodeContext({
  source,
  line,
  startLine,
  contextBefore,
  contextAfter,
  fallbackLines,
  maxBlockLines
}: PrCommentCodeContextInput): PrCommentCodeContext | null {
  const totalLines = countPrCommentCodeContextLines(source)
  const commentFrom = Math.max(1, Math.min(startLine ?? line, line))
  const commentTo = Math.min(totalLines, Math.max(startLine ?? line, line))
  const from = Math.max(1, commentFrom - contextBefore)
  const to = Math.min(totalLines, commentTo + contextAfter)
  const selectedLines = getPrCommentCodeContextLines(source, from, to)
  if (selectedLines.length === 0) {
    return null
  }

  const candidateBlockRange =
    source.length <= PR_COMMENT_CODE_CONTEXT_BLOCK_SCAN_CODE_UNITS
      ? findNearestBraceBlock(source, commentFrom)
      : null
  const candidateBlockLineCount = candidateBlockRange
    ? candidateBlockRange.endLine - candidateBlockRange.startLine + 1
    : 0
  const isWholeFileBlock =
    candidateBlockRange !== null &&
    candidateBlockRange.startLine <= 2 &&
    candidateBlockRange.endLine >= totalLines - 1
  const shouldUseBlockRange =
    candidateBlockRange !== null && !isWholeFileBlock && candidateBlockLineCount <= maxBlockLines
  const blockRange = shouldUseBlockRange
    ? candidateBlockRange
    : {
        startLine: Math.max(1, commentFrom - fallbackLines),
        endLine: Math.min(totalLines, commentTo + fallbackLines)
      }

  return {
    selectedLines,
    totalLines,
    commentFrom,
    commentTo,
    from,
    to,
    blockRange,
    shouldUseBlockRange,
    canExpandAbove: from > 1,
    canExpandBelow: to < totalLines,
    canExpandBlock: blockRange.startLine < from || blockRange.endLine > to
  }
}

function countPrCommentCodeContextLines(source: string): number {
  let lineCount = 1
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === LINE_FEED_CODE_UNIT) {
      lineCount += 1
    }
  }
  return lineCount
}

function getPrCommentCodeContextLines(source: string, from: number, to: number): string[] {
  const lines: string[] = []
  let lineNumber = 1
  let lineStart = 0

  for (let index = 0; index <= source.length; index += 1) {
    if (index < source.length && source.charCodeAt(index) !== LINE_FEED_CODE_UNIT) {
      continue
    }
    if (lineNumber >= from && lineNumber <= to) {
      lines.push(slicePrCommentCodeContextLine(source, lineStart, index))
    }
    if (lineNumber >= to) {
      break
    }
    lineStart = index + 1
    lineNumber += 1
  }

  return lines
}

function slicePrCommentCodeContextLine(source: string, lineStart: number, lineEnd: number): string {
  const normalizedLineEnd =
    lineEnd > lineStart && source.charCodeAt(lineEnd - 1) === CARRIAGE_RETURN_CODE_UNIT
      ? lineEnd - 1
      : lineEnd
  return source.slice(
    lineStart,
    Math.min(normalizedLineEnd, lineStart + PR_COMMENT_CODE_CONTEXT_LINE_MAX_CODE_UNITS)
  )
}

function findNearestBraceBlock(
  source: string,
  targetLine: number
): PrCommentCodeContextRange | null {
  const targetIndex = targetLine - 1
  const stack: number[] = []
  let containingRange: PrCommentCodeContextRange | null = null
  let followingRange: PrCommentCodeContextRange | null = null
  let lineNumber = 1
  let lineStart = 0

  for (let index = 0; index <= source.length; index += 1) {
    if (index < source.length && source.charCodeAt(index) !== LINE_FEED_CODE_UNIT) {
      continue
    }
    const lineEnd =
      index > lineStart && source.charCodeAt(index - 1) === CARRIAGE_RETURN_CODE_UNIT
        ? index - 1
        : index
    updateBraceBlockCandidatesForLine({
      source,
      lineStart,
      lineEnd,
      lineNumber,
      targetIndex,
      stack,
      setContainingRange: (range) => {
        containingRange = getShorterPrCommentCodeContextRange(containingRange, range)
      },
      setFollowingRange: (range) => {
        followingRange = getEarlierPrCommentCodeContextRange(followingRange, range)
      }
    })
    lineStart = index + 1
    lineNumber += 1
  }

  return containingRange ?? followingRange
}

function updateBraceBlockCandidatesForLine({
  source,
  lineStart,
  lineEnd,
  lineNumber,
  targetIndex,
  stack,
  setContainingRange,
  setFollowingRange
}: {
  source: string
  lineStart: number
  lineEnd: number
  lineNumber: number
  targetIndex: number
  stack: number[]
  setContainingRange: (range: PrCommentCodeContextRange) => void
  setFollowingRange: (range: PrCommentCodeContextRange) => void
}): void {
  for (let index = lineStart; index < lineEnd; index += 1) {
    const character = source[index]
    if (character === '{') {
      stack.push(lineNumber - 1)
      continue
    }
    if (character !== '}') {
      continue
    }
    const startLineIndex = stack.pop()
    if (startLineIndex === undefined || startLineIndex > lineNumber - 1) {
      continue
    }
    const range = { startLine: startLineIndex + 1, endLine: lineNumber }
    if (startLineIndex <= targetIndex && targetIndex <= lineNumber - 1) {
      setContainingRange(range)
    } else if (startLineIndex >= targetIndex && startLineIndex - targetIndex <= 8) {
      setFollowingRange(range)
    }
  }
}

function getShorterPrCommentCodeContextRange(
  current: PrCommentCodeContextRange | null,
  candidate: PrCommentCodeContextRange
): PrCommentCodeContextRange {
  if (!current) {
    return candidate
  }
  return candidate.endLine - candidate.startLine < current.endLine - current.startLine
    ? candidate
    : current
}

function getEarlierPrCommentCodeContextRange(
  current: PrCommentCodeContextRange | null,
  candidate: PrCommentCodeContextRange
): PrCommentCodeContextRange {
  if (!current) {
    return candidate
  }
  return candidate.startLine < current.startLine ? candidate : current
}
