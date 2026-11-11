import { diffArrays } from 'diff'

export type GitChangeHunk = {
  kind: 'added' | 'modified' | 'deleted'
  /** 1-based buffer lines. A deleted hunk has no lines: both name the line it follows (0 = top of file). */
  startLine: number
  endLine: number
  /** 1-based baseline range the hunk replaced. */
  originalStartLine: number
  originalLineCount: number
}

// Why: past this the file was rewritten wholesale, where per-line marks are noise.
const MAX_EDIT_LENGTH = 2000
const DIFF_TIMEOUT_MS = 100

/** Null when the diff is too large to be worth computing. */
export function computeGitChangeHunks(
  baselineLines: string[],
  bufferLines: string[]
): GitChangeHunk[] | null {
  const changes = diffArrays(baselineLines, bufferLines, {
    maxEditLength: MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS
  })
  if (!changes) {
    return null
  }

  const hunks: GitChangeHunk[] = []
  let originalLine = 1
  let bufferLine = 1
  let removedCount = 0
  let addedCount = 0
  const flush = (): void => {
    if (removedCount === 0 && addedCount === 0) {
      return
    }
    const startLine = bufferLine - addedCount
    hunks.push({
      kind: addedCount === 0 ? 'deleted' : removedCount === 0 ? 'added' : 'modified',
      startLine: addedCount === 0 ? startLine - 1 : startLine,
      endLine: bufferLine - 1,
      originalStartLine: originalLine - removedCount,
      originalLineCount: removedCount
    })
    removedCount = 0
    addedCount = 0
  }

  for (const change of changes) {
    const count = change.value.length
    if (change.removed) {
      removedCount += count
      originalLine += count
    } else if (change.added) {
      addedCount += count
      bufferLine += count
    } else {
      flush()
      originalLine += count
      bufferLine += count
    }
  }
  flush()
  return hunks
}
