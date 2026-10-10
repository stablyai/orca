import type { editor } from 'monaco-editor'

export function buildDiffEditorWhitespaceOptions(
  diffShowWhitespace: boolean | undefined
): Pick<editor.IStandaloneDiffEditorConstructionOptions, 'ignoreTrimWhitespace'> {
  return {
    // Why: Monaco defaults this to true, which hides indentation-only diffs.
    ignoreTrimWhitespace: diffShowWhitespace !== true
  }
}
