import { describe, expect, it } from 'vitest'
import type { editor as monacoEditor } from 'monaco-editor'
import {
  getDiffCommentPopoverLeft,
  getDiffCommentPopoverTop,
  resolveDiffCommentPopoverTop
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

describe('resolveDiffCommentPopoverTop', () => {
  it('keeps the below-line position when the popover fits below the viewport', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 100,
      lineHeight: 20,
      popoverHeight: 150,
      viewportHeight: 400
    })

    expect(top).toBe(100)
  })

  it('flips the popover above the line when it would overflow the bottom', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 380,
      lineHeight: 20,
      popoverHeight: 150,
      viewportHeight: 400
    })

    // above = belowTop - lineHeight - popoverHeight = 380 - 20 - 150
    expect(top).toBe(210)
  })

  it('clamps inside the viewport when the popover fits neither below nor above', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 395,
      lineHeight: 20,
      popoverHeight: 380,
      viewportHeight: 400
    })

    // maxTop = viewportHeight - popoverHeight - margin = 400 - 380 - 8
    expect(top).toBe(12)
  })

  it('falls back to the top margin when the popover is taller than the viewport', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 300,
      lineHeight: 20,
      popoverHeight: 420,
      viewportHeight: 400
    })

    expect(top).toBe(8)
  })

  it('keeps the below position before geometry is measured', () => {
    expect(
      resolveDiffCommentPopoverTop({
        belowTop: 120,
        lineHeight: 20,
        popoverHeight: 0,
        viewportHeight: 400
      })
    ).toBe(120)
    expect(
      resolveDiffCommentPopoverTop({
        belowTop: 120,
        lineHeight: 20,
        popoverHeight: 150,
        viewportHeight: 0
      })
    ).toBe(120)
  })

  it('honors a custom margin when deciding whether the popover fits below', () => {
    const top = resolveDiffCommentPopoverTop({
      belowTop: 300,
      lineHeight: 20,
      popoverHeight: 80,
      viewportHeight: 400,
      margin: 40
    })

    // 300 + 80 + 40 = 420 > 400, so it flips above: 300 - 20 - 80
    expect(top).toBe(200)
  })
})
