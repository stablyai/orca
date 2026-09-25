export type FileIconTheme = 'classic' | 'material'

export const DEFAULT_FILE_ICON_THEME: FileIconTheme = 'classic'

/** Treat persisted or IPC-provided unknown values as Classic for forward-compatible settings. */
export function normalizeFileIconTheme(value: unknown): FileIconTheme {
  return value === 'material' ? 'material' : DEFAULT_FILE_ICON_THEME
}
