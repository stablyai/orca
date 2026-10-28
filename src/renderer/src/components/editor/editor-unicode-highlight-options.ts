import type { editor } from 'monaco-editor'

export function buildEditorUnicodeHighlightOptions(
  language: string
): editor.IUnicodeHighlightOptions {
  return {
    ambiguousCharacters: language !== 'markdown',
    nonBasicASCII: language === 'markdown' ? false : 'inUntrustedWorkspace',
    invisibleCharacters: true
  }
}
