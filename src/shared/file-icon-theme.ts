export const FILE_ICON_THEME_IDS = ['orca', 'orca-color'] as const

export type FileIconThemeId = (typeof FILE_ICON_THEME_IDS)[number]

export const DEFAULT_FILE_ICON_THEME_ID: FileIconThemeId = 'orca'

export function normalizeFileIconThemeId(value: unknown): FileIconThemeId {
  return value === 'orca-color' ? 'orca-color' : DEFAULT_FILE_ICON_THEME_ID
}
