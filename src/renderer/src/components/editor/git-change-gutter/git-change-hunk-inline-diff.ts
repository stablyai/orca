import { diffWordsWithSpace } from 'diff'
import type { IRange } from 'monaco-editor'

export type GitChangeOriginalSegment = { text: string; removed: boolean }

export type GitChangeInlineDiff = {
  /** The baseline text, split so the parts the buffer no longer has can be emphasised. */
  originalSegments: GitChangeOriginalSegment[]
  /** Buffer ranges holding text the baseline does not have. */
  insertedRanges: IRange[]
}

// Why: word-level emphasis on a large rewrite is noise and costs a quadratic diff.
const MAX_INLINE_DIFF_CHARACTERS = 20_000
const MAX_INLINE_EDIT_LENGTH = 1000

export function computeGitChangeInlineDiff(
  originalLines: readonly string[],
  bufferLines: readonly string[],
  bufferStartLine: number
): GitChangeInlineDiff {
  const originalText = originalLines.join('\n')
  const bufferText = bufferLines.join('\n')
  const unemphasised: GitChangeInlineDiff = {
    originalSegments: [{ text: originalText, removed: false }],
    insertedRanges: []
  }
  if (
    originalLines.length === 0 ||
    bufferLines.length === 0 ||
    originalText.length + bufferText.length > MAX_INLINE_DIFF_CHARACTERS
  ) {
    return unemphasised
  }
  const parts = diffWordsWithSpace(originalText, bufferText, {
    maxEditLength: MAX_INLINE_EDIT_LENGTH
  })
  if (!parts) {
    return unemphasised
  }

  const originalSegments: GitChangeOriginalSegment[] = []
  const insertedRanges: IRange[] = []
  let lineNumber = bufferStartLine
  let column = 1
  for (const part of parts) {
    if (part.removed) {
      originalSegments.push({ text: part.value, removed: true })
      continue
    }
    if (!part.added) {
      originalSegments.push({ text: part.value, removed: false })
    }
    const startLineNumber = lineNumber
    const startColumn = column
    const lastBreak = part.value.lastIndexOf('\n')
    if (lastBreak === -1) {
      column += part.value.length
    } else {
      lineNumber += part.value.split('\n').length - 1
      column = part.value.length - lastBreak
    }
    if (part.added) {
      insertedRanges.push({
        startLineNumber,
        startColumn,
        endLineNumber: lineNumber,
        endColumn: column
      })
    }
  }
  return { originalSegments, insertedRanges }
}
