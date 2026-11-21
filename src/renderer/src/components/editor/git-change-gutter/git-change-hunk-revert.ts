import type { IRange } from 'monaco-editor'
import type { GitChangeHunk } from './git-change-hunks'

export type GitChangeHunkRevertEdit = { range: IRange; text: string }

type BufferShape = {
  lineCount: number
  eol: string
  getLineMaxColumn: (lineNumber: number) => number
}

function range(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number
): IRange {
  return { startLineNumber, startColumn, endLineNumber, endColumn }
}

/** The single edit that puts a hunk's baseline lines back, leaving every other line untouched. */
export function buildGitChangeHunkRevertEdit(
  hunk: GitChangeHunk,
  originalLines: readonly string[],
  buffer: BufferShape
): GitChangeHunkRevertEdit {
  const { startLine, endLine } = hunk
  const text = originalLines.join(buffer.eol)

  if (hunk.kind === 'deleted') {
    return startLine === 0
      ? { range: range(1, 1, 1, 1), text: text + buffer.eol }
      : {
          range: range(
            startLine,
            buffer.getLineMaxColumn(startLine),
            startLine,
            buffer.getLineMaxColumn(startLine)
          ),
          text: buffer.eol + text
        }
  }

  if (hunk.kind === 'modified') {
    return { range: range(startLine, 1, endLine, buffer.getLineMaxColumn(endLine)), text }
  }

  // Removing added lines must also take one line break: the one after, or the one before at end of file.
  if (endLine < buffer.lineCount) {
    return { range: range(startLine, 1, endLine + 1, 1), text: '' }
  }
  if (startLine > 1) {
    return {
      range: range(
        startLine - 1,
        buffer.getLineMaxColumn(startLine - 1),
        endLine,
        buffer.getLineMaxColumn(endLine)
      ),
      text: ''
    }
  }
  return { range: range(1, 1, endLine, buffer.getLineMaxColumn(endLine)), text: '' }
}
