import type { editor, IRange } from 'monaco-editor'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'

export type ChangedLineRange = {
  startLineNumber: number
  endLineNumber: number
}

const MAX_EXACT_LINE_DIFF_CELLS = 750_000

export function buildChangedLineRanges(
  originalContent: string,
  modifiedContent: string
): ChangedLineRange[] {
  if (originalContent === modifiedContent) {
    return []
  }

  const originalLines = splitLines(originalContent)
  const modifiedLines = splitLines(modifiedContent)
  if (modifiedLines.length === 0) {
    return []
  }

  if (originalLines.length * modifiedLines.length > MAX_EXACT_LINE_DIFF_CELLS) {
    return buildSingleChangedRange(originalLines, modifiedLines)
  }

  return buildExactChangedLineRanges(originalLines, modifiedLines)
}

export function buildChangedLineDecorations(
  diffContent: GitDiffResult | undefined,
  modifiedContent: string
): editor.IModelDeltaDecoration[] {
  if (!diffContent || diffContent.kind !== 'text' || diffContent.largeDiffRenderLimit?.limited) {
    return []
  }

  return buildChangedLineRanges(diffContent.originalContent, modifiedContent).map((range) => ({
    range: makeWholeLineRange(range.startLineNumber, range.endLineNumber),
    options: {
      isWholeLine: true,
      className: 'orca-editor-changed-line',
      linesDecorationsClassName: 'orca-editor-changed-line-gutter'
    }
  }))
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return []
  }
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function buildSingleChangedRange(
  originalLines: readonly string[],
  modifiedLines: readonly string[]
): ChangedLineRange[] {
  let prefix = 0
  while (
    prefix < originalLines.length &&
    prefix < modifiedLines.length &&
    originalLines[prefix] === modifiedLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix + prefix < originalLines.length &&
    suffix + prefix < modifiedLines.length &&
    originalLines[originalLines.length - 1 - suffix] ===
      modifiedLines[modifiedLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const startLineNumber = prefix + 1
  const endLineNumber = modifiedLines.length - suffix
  return startLineNumber <= endLineNumber ? [{ startLineNumber, endLineNumber }] : []
}

function buildExactChangedLineRanges(
  originalLines: readonly string[],
  modifiedLines: readonly string[]
): ChangedLineRange[] {
  const columnCount = modifiedLines.length + 1
  const table = new Uint32Array((originalLines.length + 1) * columnCount)

  for (let i = originalLines.length - 1; i >= 0; i -= 1) {
    for (let j = modifiedLines.length - 1; j >= 0; j -= 1) {
      const offset = i * columnCount + j
      table[offset] =
        originalLines[i] === modifiedLines[j]
          ? table[(i + 1) * columnCount + j + 1] + 1
          : Math.max(table[(i + 1) * columnCount + j], table[offset + 1])
    }
  }

  const changedLines: number[] = []
  let i = 0
  let j = 0
  while (i < originalLines.length || j < modifiedLines.length) {
    if (
      i < originalLines.length &&
      j < modifiedLines.length &&
      originalLines[i] === modifiedLines[j]
    ) {
      i += 1
      j += 1
      continue
    }

    const shouldTakeModifiedLine =
      j < modifiedLines.length &&
      (i >= originalLines.length ||
        table[i * columnCount + j + 1] >= table[(i + 1) * columnCount + j])
    if (shouldTakeModifiedLine) {
      changedLines.push(j + 1)
      j += 1
      continue
    }

    i += 1
  }

  return mergeChangedLines(changedLines)
}

function mergeChangedLines(lines: readonly number[]): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = []
  for (const line of lines) {
    const last = ranges.at(-1)
    if (last && line <= last.endLineNumber + 1) {
      last.endLineNumber = line
    } else {
      ranges.push({ startLineNumber: line, endLineNumber: line })
    }
  }
  return ranges
}

function makeWholeLineRange(startLineNumber: number, endLineNumber: number): IRange {
  return {
    startLineNumber,
    startColumn: 1,
    endLineNumber,
    endColumn: 1
  }
}
