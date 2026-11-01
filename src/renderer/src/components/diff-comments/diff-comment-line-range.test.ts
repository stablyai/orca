import { describe, expect, it } from 'vitest'
import {
  clampFocusLineToCommentable,
  getSelectionAnchorFocus,
  toDiffCommentLineTarget
} from './diff-comment-line-range'

// Match PR patch lines: two hunks separated by an uncommentable gap.
const HUNK_LINES = new Set([10, 11, 12, 13, 14, 15, 16, 40, 41, 42])

describe('toDiffCommentLineTarget', () => {
  it('drops startLine for a single line so the wire shape matches a plain click', () => {
    expect(toDiffCommentLineTarget({ startLine: 12, endLine: 12 })).toEqual({
      lineNumber: 12,
      startLine: undefined
    })
  })
})

describe('clampFocusLineToCommentable', () => {
  it('stops at the last line of the hunk instead of jumping the gap', () => {
    expect(clampFocusLineToCommentable(12, 41, HUNK_LINES)).toBe(16)
  })

  it('clamps upward drags at the top of the hunk', () => {
    expect(clampFocusLineToCommentable(14, 2, HUNK_LINES)).toBe(10)
  })
})

describe('getSelectionAnchorFocus', () => {
  it('excludes a trailing line the selection only touches at column 1', () => {
    expect(
      getSelectionAnchorFocus({
        startLineNumber: 4,
        startColumn: 3,
        endLineNumber: 7,
        endColumn: 1,
        selectionStartLineNumber: 4,
        positionLineNumber: 7
      })
    ).toEqual({ anchorLine: 4, focusLine: 6 })
  })

  it('drops the column-1 trailing line from an upward selection anchor', () => {
    expect(
      getSelectionAnchorFocus({
        startLineNumber: 12,
        startColumn: 2,
        endLineNumber: 41,
        endColumn: 1,
        selectionStartLineNumber: 41,
        positionLineNumber: 12
      })
    ).toEqual({ anchorLine: 40, focusLine: 12 })
  })
})
