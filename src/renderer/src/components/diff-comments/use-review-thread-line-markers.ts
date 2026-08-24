import { useEffect } from 'react'
import type { editor as monacoEditor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import { translate } from '@/i18n/i18n'

/** Marks commented lines in the gutter while review threads are hidden, so they stay discoverable. */
export function useReviewThreadLineMarkers(
  editor: monacoEditor.ICodeEditor | null,
  lines: readonly number[]
): void {
  useEffect(() => {
    if (!editor || lines.length === 0) {
      return
    }
    const collection = editor.createDecorationsCollection(
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          linesDecorationsClassName: 'orca-review-thread-line-marker',
          hoverMessage: {
            value: translate(
              'auto.components.diff.comments.reviewThreads.hiddenMarker',
              'Review comment hidden — use "Show comments" to reveal it.'
            )
          }
        }
      }))
    )
    return () => {
      collection.clear()
    }
  }, [editor, lines])
}
