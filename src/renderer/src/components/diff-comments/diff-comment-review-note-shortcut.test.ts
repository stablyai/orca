// @vitest-environment happy-dom
import * as monaco from 'monaco-editor'
import { describe, expect, it } from 'vitest'
import type { editor as MonacoEditor } from 'monaco-editor'
import { getDiffCommentShortcutTarget } from './diff-comment-review-note-shortcut'

function makeEditor({
  positionLine = 4,
  selection = null,
  lineCount = 10
}: {
  positionLine?: number
  selection?: monaco.Selection | null
  lineCount?: number
} = {}): MonacoEditor.ICodeEditor {
  return {
    getModel: () => ({ getLineCount: () => lineCount }),
    getOption: () => 20,
    getPosition: () => ({ lineNumber: positionLine, column: 1 }),
    getScrollTop: () => 10,
    getSelection: () => selection,
    getTopForLineNumber: (lineNumber: number) => lineNumber * 20
  } as unknown as MonacoEditor.ICodeEditor
}

describe('getDiffCommentShortcutTarget', () => {
  it('anchors a cursor shortcut below the current commentable line', () => {
    expect(getDiffCommentShortcutTarget(makeEditor(), new Set([4]))).toEqual({
      lineNumber: 4,
      startLine: undefined,
      top: 90
    })
  })

  it('uses the selected line range and excludes a trailing column-one line', () => {
    const editor = makeEditor({ selection: new monaco.Selection(2, 1, 4, 1) })

    expect(getDiffCommentShortcutTarget(editor, new Set([2, 3]))).toEqual({
      lineNumber: 3,
      startLine: 2,
      top: 70
    })
  })

  it('leaves the shortcut unhandled outside commentable lines', () => {
    const editor = makeEditor({ selection: new monaco.Selection(2, 1, 4, 1) })

    expect(getDiffCommentShortcutTarget(editor, new Set([2]))).toBeNull()
    expect(getDiffCommentShortcutTarget(makeEditor({ positionLine: 11 }), null)).toBeNull()
  })
})
