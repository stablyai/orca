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

  // Monaco 0.55 shares diff line-number options; override inner editors to remove the duplicate inline gutter.
  reapplyIfNeeded()

  // The React wrapper reapplies parent options on render; reassert per-pane policy after configuration changes overwrite it.
  const originalOptionsSub = originalEditor.onDidChangeConfiguration(reapplyIfNeeded)
  const modifiedOptionsSub = modifiedEditor.onDidChangeConfiguration(reapplyIfNeeded)

  return {
    dispose: () => {
      originalOptionsSub.dispose()
      modifiedOptionsSub.dispose()
    }
  }
}
