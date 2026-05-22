import { colorClassicIconTheme } from './color-classic'
import { defaultIconTheme } from './default'
import { materialIconTheme, materialLightIconTheme } from './material'
import { resolveIcon } from './resolve'
import { mergeIconThemeCatalogs } from './shared'
import type { IconNode, IconTheme } from './types'

export type {
  IconNode,
  IconTheme,
  IconThemeFileRule,
  IconThemeFolderRule,
  FolderIconState
} from './types'

export { resolveIcon } from './resolve'
export { parseVscodeIconTheme } from './vscode-icon-theme'
export type { VscodeIconThemeShape, SvgIconRegistry, ParseVscodeOptions } from './vscode-icon-theme'

const BUILTIN_THEMES: IconTheme[] = [
  defaultIconTheme,
  colorClassicIconTheme,
  materialIconTheme,
  ...(materialLightIconTheme ? [materialLightIconTheme] : [])
]

export const ICON_THEME_CATALOG = mergeIconThemeCatalogs(BUILTIN_THEMES)

export const DEFAULT_ICON_THEME_ID = 'default'

export function getIconTheme(id: string): IconTheme | undefined {
  return ICON_THEME_CATALOG[id]
}

export function getIconThemes(): IconTheme[] {
  return Object.values(ICON_THEME_CATALOG)
}

/**
 * Resolve an icon using `id`, falling back to the `default` theme if `id`
 * does not match a known catalog entry. Centralizes the "unknown theme id"
 * recovery rule so callers (hooks, previews) don't have to repeat it.
 */
export function resolveIconWithFallback(
  id: string,
  filePath: string,
  isDirectory: boolean,
  isOpen: boolean
): IconNode {
  const theme = ICON_THEME_CATALOG[id] ?? defaultIconTheme
  return resolveIcon(theme, filePath, isDirectory, isOpen)
}
