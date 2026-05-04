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

  // Why: @monaco-editor/react re-applies the parent options object on every
  // component re-render, which clobbers our per-pane lineNumbers override
  // (the parent options carry lineNumbers: 'on'). Subscribe to each inner
  // editor's onDidChangeConfiguration so we can re-assert the policy on
  // every option update without racing against Monaco's internal handling.
  const originalOptionsSub = originalEditor.onDidChangeConfiguration(reapplyIfNeeded)
  const modifiedOptionsSub = modifiedEditor.onDidChangeConfiguration(reapplyIfNeeded)

  return {
    dispose: () => {
      originalOptionsSub.dispose()
      modifiedOptionsSub.dispose()
    }
  }
}
