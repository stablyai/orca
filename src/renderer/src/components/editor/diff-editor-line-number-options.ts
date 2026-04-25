import type { editor } from 'monaco-editor'

type DiffEditorLineNumberOptions = {
  original: editor.LineNumbersType
  modified: editor.LineNumbersType
}

type Disposable = {
  dispose: () => void
}

export function buildDiffEditorLineNumberOptions(sideBySide: boolean): DiffEditorLineNumberOptions {
  return {
    original: sideBySide ? 'on' : 'off',
    modified: 'on'
  }
}

export function applyDiffEditorLineNumberOptions(
  diffEditor: editor.IStandaloneDiffEditor,
  sideBySide: boolean
): Disposable {
  const lineNumberOptions = buildDiffEditorLineNumberOptions(sideBySide)
  const originalEditor = diffEditor.getOriginalEditor()
  const modifiedEditor = diffEditor.getModifiedEditor()

  const reapplyIfNeeded = (): void => {
    if (originalEditor.getRawOptions().lineNumbers !== lineNumberOptions.original) {
      originalEditor.updateOptions({ lineNumbers: lineNumberOptions.original })
    }
    if (modifiedEditor.getRawOptions().lineNumbers !== lineNumberOptions.modified) {
      modifiedEditor.updateOptions({ lineNumbers: lineNumberOptions.modified })
    }
  }

  // Why: Monaco 0.55 exposes only shared diff options for line numbers, so we
  // update the inner editors directly to collapse the duplicate gutter inline.
  reapplyIfNeeded()

  const originalOptionsSub = originalEditor.onDidChangeOptions(reapplyIfNeeded)
  const modifiedOptionsSub = modifiedEditor.onDidChangeOptions(reapplyIfNeeded)

  return {
    dispose: () => {
      originalOptionsSub.dispose()
      modifiedOptionsSub.dispose()
    }
  }
}
