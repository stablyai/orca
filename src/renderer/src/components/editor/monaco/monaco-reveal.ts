import type React from 'react'
import type { editor } from 'monaco-editor'
import { computeMonacoRevealRange } from './monaco-reveal-range'

export const MAX_REVEAL_CONTENT_WAIT_FRAMES = 120

/** Share mount/live reveal behavior: select and center the match, then briefly highlight it. */
export function performReveal(
  ed: editor.IStandaloneCodeEditor,
  line: number,
  column: number,
  matchLength: number,
  clearTransientRevealHighlight: () => void,
  revealDecorationRef: React.RefObject<editor.IEditorDecorationsCollection | null>,
  revealHighlightTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>
): void {
  const model = ed.getModel()
  if (!model) {
    ed.focus()
    return
  }

  const range = computeMonacoRevealRange({
    line,
    column,
    matchLength,
    maxLine: model.getLineCount(),
    lineMaxColumn: model.getLineMaxColumn(Math.min(Math.max(1, line), model.getLineCount()))
  })
  const shouldHighlight = matchLength > 0

  ed.setPosition({ lineNumber: range.startLineNumber, column: range.startColumn })
  if (shouldHighlight) {
    ed.setSelection(range)
    ed.revealRangeInCenter(range)
  } else {
    ed.setSelection({
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.startLineNumber,
      endColumn: range.startColumn
    })
    ed.revealPositionInCenter({ lineNumber: range.startLineNumber, column: range.startColumn })
  }

  clearTransientRevealHighlight()
  if (shouldHighlight) {
    revealDecorationRef.current = ed.createDecorationsCollection([
      {
        range,
        options: {
          inlineClassName: 'monaco-search-result-highlight',
          stickiness: 1
        }
      }
    ])
    revealHighlightTimerRef.current = setTimeout(() => {
      revealDecorationRef.current?.clear()
      revealDecorationRef.current = null
      revealHighlightTimerRef.current = null
    }, 1200)
  }

  ed.focus()
}
