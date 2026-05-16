import { describe, expect, it } from 'vitest'
import type { editor as monacoEditor } from 'monaco-editor'
import {
  getDiffCommentPopoverLeft,
  getDiffCommentPopoverTop
} from './diff-comment-popover-position'

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

function makeElementWithLeft(left: number): HTMLElement {
  return {
    getBoundingClientRect: () => ({ left }) as DOMRect
  } as HTMLElement
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

describe('getDiffCommentPopoverLeft', () => {
  it('aligns the popover to the editor content column inside its overlay parent', () => {
    const editor = {
      getDomNode: () => makeElementWithLeft(230),
      getLayoutInfo: () => ({ contentLeft: 72 }) as monacoEditor.EditorLayoutInfo
    }

    expect(getDiffCommentPopoverLeft(editor, makeElementWithLeft(100))).toBe(202)
  })

  it('returns null when the editor DOM node or overlay parent is unavailable', () => {
    const editor = {
      getDomNode: () => null,
      getLayoutInfo: () => ({ contentLeft: 72 }) as monacoEditor.EditorLayoutInfo
    }

    expect(getDiffCommentPopoverLeft(editor, makeElementWithLeft(100))).toBeNull()
    expect(
      getDiffCommentPopoverLeft({ ...editor, getDomNode: () => makeElementWithLeft(230) }, null)
    ).toBeNull()
  })
})
