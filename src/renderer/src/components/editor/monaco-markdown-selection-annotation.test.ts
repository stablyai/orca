import { describe, expect, it } from 'vitest'
import type { IRange } from 'monaco-editor'
import { getMonacoMarkdownSelectionAnnotationTarget } from './monaco-markdown-selection-annotation'

function selection(overrides: Partial<IRange> = {}): IRange {
  return {
    startLineNumber: 2,
    startColumn: 3,
    endLineNumber: 4,
    endColumn: 8,
    ...overrides
  }
}

function editorForSelectedText(selectedText: string, lineCount = 8) {
  return {
    getModel: () => ({
      getLineCount: () => lineCount,
      getValueInRange: () => selectedText
    }),
    getScrollTop: () => 10,
    getTopForLineNumber: (lineNumber: number) => lineNumber * 20
  }
}

describe('getMonacoMarkdownSelectionAnnotationTarget', () => {
  it('maps selected source text to markdown note coordinates', () => {
    expect(
      getMonacoMarkdownSelectionAnnotationTarget(editorForSelectedText(' chosen '), selection(), 32)
    ).toEqual({
      lineNumber: 4,
      startLine: 2,
      selectedText: 'chosen',
      top: 89,
      left: 32
    })
  })

  it('anchors full-line selections to the last selected text line', () => {
    expect(
      getMonacoMarkdownSelectionAnnotationTarget(
        editorForSelectedText('line two\n'),
        selection({ startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 })
      )
    ).toEqual({
      lineNumber: 2,
      selectedText: 'line two',
      top: 49,
      left: undefined
    })
  })

  it('ignores empty selections and whitespace-only selected text', () => {
    expect(
      getMonacoMarkdownSelectionAnnotationTarget(
        editorForSelectedText('chosen'),
        selection({ endLineNumber: 2, endColumn: 3 })
      )
    ).toBeNull()
    expect(
      getMonacoMarkdownSelectionAnnotationTarget(editorForSelectedText('   '), selection())
    ).toBeNull()
  })
})
