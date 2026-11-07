import type { editor } from 'monaco-editor'

// Pin includeStrings: Monaco validates a missing value as 'inUntrustedWorkspace' (false when trusted), not true.
export function buildEditorUnicodeHighlightOptions(
  language: string
): editor.IUnicodeHighlightOptions {
  return { ambiguousCharacters: language !== 'markdown', includeStrings: true }
}
