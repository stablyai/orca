import type { editor } from 'monaco-editor'

export function buildDiffEditorWordWrapOptions(
  diffWordWrap: boolean | undefined
): Pick<editor.IStandaloneDiffEditorConstructionOptions, 'wordWrap'> {
  return {
    wordWrap: diffWordWrap === true ? 'on' : 'off'
  }
}
