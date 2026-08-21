import type { editor } from 'monaco-editor'

export function buildFileEditorWordWrapOptions(
  editorWordWrap: boolean | undefined
): Pick<editor.IStandaloneEditorConstructionOptions, 'wordWrap'> {
  // Why: profiles saved before this preference existed must retain MCode's previous wrapped default.
  return { wordWrap: editorWordWrap === false ? 'off' : 'on' }
}
