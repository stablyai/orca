export type EditorEndOfLine = 'auto' | 'lf' | 'crlf'
export type EditorLineEnding = '\n' | '\r\n'

export const DEFAULT_EDITOR_END_OF_LINE: EditorEndOfLine = 'auto'

export function normalizeEditorEndOfLine(value: unknown): EditorEndOfLine {
  return value === 'lf' || value === 'crlf' ? value : DEFAULT_EDITOR_END_OF_LINE
}

/**
 * The ending a model with no line breaks yet should adopt; null keeps the editor's default.
 * Auto follows the OS of the host that owns the file, not the OS this window runs on.
 */
export function resolveNewModelLineEnding(args: {
  setting: unknown
  hostPlatform: NodeJS.Platform | null
  language: string
}): EditorLineEnding | null {
  // Why: the editor's built-in [shellscript] default is LF and outranks the global choice.
  if (args.language === 'shellscript') {
    return null
  }
  const setting = normalizeEditorEndOfLine(args.setting)
  if (setting !== 'auto') {
    return setting === 'crlf' ? '\r\n' : '\n'
  }
  if (!args.hostPlatform) {
    return null
  }
  return args.hostPlatform === 'win32' ? '\r\n' : '\n'
}
