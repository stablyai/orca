import { defaultDarkTheme } from './default-dark'
import { defaultLightTheme } from './default-light'
import { highContrastDarkTheme } from './high-contrast-dark'
import { oneDarkTheme } from './one-dark'
import { mergeFileExplorerColorThemeCatalogs } from './shared'
import { solarizedLightTheme } from './solarized-light'
import type { FileExplorerColorKey, FileExplorerColorMap, FileExplorerColorTheme } from './types'

export type {
  FileExplorerColorKey,
  FileExplorerColorMap,
  FileExplorerColorTheme,
  FileExplorerColorOverrides
} from './types'

export const FILE_EXPLORER_COLOR_THEME_CATALOG = mergeFileExplorerColorThemeCatalogs([
  defaultDarkTheme,
  defaultLightTheme,
  highContrastDarkTheme,
  oneDarkTheme,
  solarizedLightTheme
])

export const DEFAULT_FILE_EXPLORER_COLOR_THEME_DARK = 'default-dark'
export const DEFAULT_FILE_EXPLORER_COLOR_THEME_LIGHT = 'default-light'

export function getFileExplorerColorTheme(id: string): FileExplorerColorTheme | undefined {
  return FILE_EXPLORER_COLOR_THEME_CATALOG[id]
}

export function getFileExplorerColorThemeNames(mode?: 'dark' | 'light'): FileExplorerColorTheme[] {
  const themes = Object.values(FILE_EXPLORER_COLOR_THEME_CATALOG)
  return mode ? themes.filter((t) => t.mode === mode) : themes
}

/**
 * The full set of color keys a complete theme must supply. Tests use this to
 * guarantee no built-in theme ships with a missing field, and the settings
 * "Color Overrides" UI iterates over it.
 */
export const FILE_EXPLORER_COLOR_KEYS = [
  'background',
  'hoverBackground',
  'selectedBackground',
  'selectedInactiveBackground',
  'flashBackground',
  'flashRing',
  'textColor',
  'selectedTextColor',
  'mutedTextColor',
  'gitIgnoredColor',
  'fileIconColor',
  'folderIconColor',
  'gitModifiedColor',
  'gitAddedColor',
  'gitDeletedColor',
  'gitUntrackedColor',
  'gitConflictColor',
  'dropTargetBorderColor'
] as const satisfies readonly FileExplorerColorKey[]

/**
 * Strip identity fields from a theme to get only the color map. Used when
 * applying CSS variables or layering overrides.
 */
export function toColorMap(theme: FileExplorerColorTheme): FileExplorerColorMap {
  const { id: _id, name: _name, mode: _mode, ...colors } = theme
  return colors
}
