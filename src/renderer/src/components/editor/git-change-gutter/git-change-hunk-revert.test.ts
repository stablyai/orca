import { describe, expect, it } from 'vitest'
import { buildGitChangeHunkRevertEdit } from './git-change-hunk-revert'
import type { GitChangeHunk } from './git-change-hunks'

function bufferOf(lines: string[]) {
  return {
    lineCount: lines.length,
    eol: '\n',
    getLineMaxColumn: (lineNumber: number) => lines[lineNumber - 1].length + 1
  }
}

function hunk(
  kind: GitChangeHunk['kind'],
  startLine: number,
  endLine: number,
  originalStartLine: number,
  originalLineCount: number
): GitChangeHunk {
  return { kind, startLine, endLine, originalStartLine, originalLineCount }
}

describe('buildGitChangeHunkRevertEdit', () => {
  it('replaces modified lines with the baseline lines', () => {
    expect(
      buildGitChangeHunkRevertEdit(
        hunk('modified', 2, 3, 2, 1),
        ['b'],
        bufferOf(['a', 'xx', 'yyy', 'c'])
      )
    ).toEqual({
      range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 4 },
      text: 'b'
    })
  })

  it('removes added lines together with the following line break', () => {
    expect(
      buildGitChangeHunkRevertEdit(hunk('added', 2, 3, 2, 0), [], bufferOf(['a', 'b', 'c', 'd']))
    ).toEqual({
      range: { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 },
      text: ''
    })
  })

  it('removes added lines at the end of the file together with the preceding line break', () => {
    expect(
      buildGitChangeHunkRevertEdit(hunk('added', 2, 3, 2, 0), [], bufferOf(['abc', 'b', 'cc']))
    ).toEqual({
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 3, endColumn: 3 },
      text: ''
    })
  })

  it('reinserts deleted lines after the line they followed', () => {
    expect(
      buildGitChangeHunkRevertEdit(hunk('deleted', 1, 1, 2, 2), ['b', 'c'], bufferOf(['abc', 'd']))
    ).toEqual({
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 4 },
      text: '\nb\nc'
    })
  })

  it('reinserts lines deleted from the top of the file', () => {
    expect(
      buildGitChangeHunkRevertEdit(hunk('deleted', 0, 0, 1, 1), ['a'], bufferOf(['b', 'c']))
    ).toEqual({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'a\n'
    })
  })
})
