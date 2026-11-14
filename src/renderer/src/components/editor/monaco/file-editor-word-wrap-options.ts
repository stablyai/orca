import type { editor } from 'monaco-editor'
import { resolveFileEditorWordWrap } from '../../../../../shared/editor/editor-typography'

export function buildFileEditorWordWrapOptions(
  editorWordWrap: boolean | undefined
): Pick<editor.IStandaloneEditorConstructionOptions, 'wordWrap'> {
  return { wordWrap: resolveFileEditorWordWrap(editorWordWrap) }
}
