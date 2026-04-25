import type { editor } from 'monaco-editor'

type DiffEditorLineNumberOptions = {
  original: editor.LineNumbersType
  modified: editor.LineNumbersType
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
): void {
  const lineNumberOptions = buildDiffEditorLineNumberOptions(sideBySide)
  // Why: Monaco 0.55 exposes only shared diff options for line numbers, so we
  // update the inner editors directly to collapse the duplicate gutter inline.
  diffEditor.getOriginalEditor().updateOptions({ lineNumbers: lineNumberOptions.original })
  diffEditor.getModifiedEditor().updateOptions({ lineNumbers: lineNumberOptions.modified })
}
