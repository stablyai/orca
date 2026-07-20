import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { editor } from 'monaco-editor'
import { applyDiffEditorLineNumberOptions } from './diff-editor-line-number-options'
import { applyDiffEditorWordWrapOptions } from './diff-editor-word-wrap-options'

type DiffEditorOptionOverrides = {
  bindDiffEditorOptionOverrides: (diffEditor: editor.IStandaloneDiffEditor) => void
  disposeDiffEditorOptionOverrides: () => void
}

export function useDiffEditorOptionOverrides(
  diffEditorRef: RefObject<editor.IStandaloneDiffEditor | null>,
  sideBySide: boolean,
  diffWordWrap: boolean | undefined
): DiffEditorOptionOverrides {
  const optionsSubRef = useRef<{ dispose: () => void } | null>(null)

  const disposeDiffEditorOptionOverrides = useCallback(() => {
    optionsSubRef.current?.dispose()
    optionsSubRef.current = null
  }, [])

  const bindDiffEditorOptionOverrides = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor) => {
      disposeDiffEditorOptionOverrides()
      const lineNumberOptions = applyDiffEditorLineNumberOptions(diffEditor, sideBySide)
      const wordWrapOptions = applyDiffEditorWordWrapOptions(diffEditor, diffWordWrap)
      optionsSubRef.current = {
        dispose: () => {
          lineNumberOptions.dispose()
          wordWrapOptions.dispose()
        }
      }
    },
    [diffWordWrap, disposeDiffEditorOptionOverrides, sideBySide]
  )

  useEffect(() => {
    const diffEditor = diffEditorRef.current
    if (!diffEditor) {
      return
    }
    bindDiffEditorOptionOverrides(diffEditor)
    return disposeDiffEditorOptionOverrides
  }, [bindDiffEditorOptionOverrides, diffEditorRef, disposeDiffEditorOptionOverrides])

  return { bindDiffEditorOptionOverrides, disposeDiffEditorOptionOverrides }
}
