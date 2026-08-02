export const MAX_RENDERED_DIFF_LINES_PER_SIDE = 120_000
export const MAX_RENDERED_DIFF_COMBINED_CHARACTERS = 6_000_000

export type LargeDiffRenderLimitReason = 'line-count' | 'character-count'

export type DiffLineCounts = {
  original: number
  modified: number
}

export type DiffLineCountMinimums = {
  original: boolean
  modified: boolean
}

export type LargeDiffRenderLimit =
  | {
      limited: false
      lineCounts: DiffLineCounts
      characterCount: number
    }
  | {
      limited: true
      reason: LargeDiffRenderLimitReason
      lineCounts: DiffLineCounts | null
      lineCountsAreMinimum?: DiffLineCountMinimums
      characterCount: number
      limits: {
        maxLinesPerSide: number
        maxCombinedCharacters: number
      }
    }

export function countLinesEmptyAsZero(content: string): number {
  if (content.length === 0) {
    return 0
  }

  let lineCount = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1
    }
  }
  return lineCount
}

type BoundedLineCount = {
  count: number
  exceeded: boolean
}

export function countLinesEmptyAsZeroUpToLimit(
  content: string,
  maxLines: number
): BoundedLineCount {
  if (content.length === 0) {
    return { count: 0, exceeded: false }
  }

  let lineCount = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) {
      continue
    }
    lineCount += 1
    if (lineCount > maxLines) {
      return { count: lineCount, exceeded: true }
    }
  }
  return { count: lineCount, exceeded: false }
}

export function countLinesLikeSplit(content: string): number {
  let lineCount = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1
    }
  }
  return lineCount
}

type LargeDiffRenderLimitInput = {
  originalContent: string
  modifiedContent: string
}

type LargeDiffRenderLimitCountsInput = {
  originalLineCount: number
  modifiedLineCount: number
  originalCharacterCount: number
  modifiedCharacterCount: number
}

export function getLargeDiffRenderLimitFromCounts({
  originalLineCount,
  modifiedLineCount,
  originalCharacterCount,
  modifiedCharacterCount
}: LargeDiffRenderLimitCountsInput): LargeDiffRenderLimit {
  const lineCounts = {
    original: originalLineCount,
    modified: modifiedLineCount
  }
  const characterCount = originalCharacterCount + modifiedCharacterCount
  const limits = {
    maxLinesPerSide: MAX_RENDERED_DIFF_LINES_PER_SIDE,
    maxCombinedCharacters: MAX_RENDERED_DIFF_COMBINED_CHARACTERS
  }

  if (
    lineCounts.original > MAX_RENDERED_DIFF_LINES_PER_SIDE ||
    lineCounts.modified > MAX_RENDERED_DIFF_LINES_PER_SIDE
  ) {
    return {
      limited: true,
      reason: 'line-count',
      lineCounts,
      characterCount,
      limits
    }
  }

  if (characterCount > MAX_RENDERED_DIFF_COMBINED_CHARACTERS) {
    return {
      limited: true,
      reason: 'character-count',
      lineCounts,
      characterCount,
      limits
    }
  }

  return {
    limited: false,
    lineCounts,
    characterCount
  }
}

export function getLargeDiffRenderLimit({
  originalContent,
  modifiedContent
}: LargeDiffRenderLimitInput): LargeDiffRenderLimit {
  const characterCount = originalContent.length + modifiedContent.length
  const limits = {
    maxLinesPerSide: MAX_RENDERED_DIFF_LINES_PER_SIDE,
    maxCombinedCharacters: MAX_RENDERED_DIFF_COMBINED_CHARACTERS
  }

  if (characterCount > MAX_RENDERED_DIFF_COMBINED_CHARACTERS) {
    return {
      limited: true,
      reason: 'character-count',
      lineCounts: null,
      characterCount,
      limits
    }
  }

  const originalLineCount = countLinesEmptyAsZeroUpToLimit(
    originalContent,
    MAX_RENDERED_DIFF_LINES_PER_SIDE
  )
  const modifiedLineCount = countLinesEmptyAsZeroUpToLimit(
    modifiedContent,
    MAX_RENDERED_DIFF_LINES_PER_SIDE
  )

  if (originalLineCount.exceeded || modifiedLineCount.exceeded) {
    return {
      limited: true,
      reason: 'line-count',
      lineCounts: {
        original: originalLineCount.count,
        modified: modifiedLineCount.count
      },
      lineCountsAreMinimum: {
        original: originalLineCount.exceeded,
        modified: modifiedLineCount.exceeded
      },
      characterCount,
      limits
    }
  }

  return {
    limited: false,
    lineCounts: {
      original: originalLineCount.count,
      modified: modifiedLineCount.count
    },
    characterCount
  }
}
