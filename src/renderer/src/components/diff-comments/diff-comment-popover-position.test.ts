import { describe, expect, it } from 'vitest'
import type { editor as monacoEditor } from 'monaco-editor'
import { getDiffCommentPopoverTop } from './diff-comment-popover-position'

function makeEditor({
  lineCount = 10,
  scrollTop = 15,
  topForLine = (lineNumber: number) => lineNumber * 20
}: {
  lineCount?: number
  scrollTop?: number
  topForLine?: (lineNumber: number) => number
} = {}): Parameters<typeof getDiffCommentPopoverTop>[0] {
  return {
    getModel: () => ({ getLineCount: () => lineCount }) as monacoEditor.ITextModel,
    getScrollTop: () => scrollTop,
    getTopForLineNumber: topForLine
  }
}

describe('getDiffCommentPopoverTop', () => {
  it('positions the popover below the anchor line', () => {
    const top = getDiffCommentPopoverTop(makeEditor(), 3, 20)

    expect(top).toBe(65)
  })

  it('uses a fallback line height when Monaco does not return a positive number', () => {
    const top = getDiffCommentPopoverTop(makeEditor(), 3, 0)

    expect(top).toBe(64)
  })

  it('returns null when the editor has no model', () => {
    const editor = {
      ...makeEditor(),
      getModel: () => null
    }

    expect(getDiffCommentPopoverTop(editor, 3, 20)).toBeNull()
  })

  it('returns null for out-of-range line numbers', () => {
    expect(getDiffCommentPopoverTop(makeEditor({ lineCount: 2 }), 3, 20)).toBeNull()
    expect(getDiffCommentPopoverTop(makeEditor({ lineCount: 2 }), 0, 20)).toBeNull()
  })
})
