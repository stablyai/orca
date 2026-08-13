import { CLASSIC_EDITOR_THEMES } from './catalog-classic'
import { POPULAR_DARK_CORE_EDITOR_THEMES } from './catalog-popular-dark-core'
import { POPULAR_DARK_EXTENDED_EDITOR_THEMES } from './catalog-popular-dark-extended'
import { POPULAR_LIGHT_EDITOR_THEMES } from './catalog-popular-light'
import type { EditorThemeCatalogEntry } from './types'

export type { EditorThemeCatalogEntry } from './types'

/** Editor theme catalog — one entry per terminal theme of the same name (see
 *  lib/terminal-themes), so picking "Monokai" (etc.) reads as one coherent
 *  theme across terminal and editor. Grouped in the same files as the terminal
 *  catalog; spread rather than merged at runtime so the ids stay literal types
 *  (GlobalSettings['editorColorTheme'] must list every one of them). */
export const EDITOR_THEME_CATALOG = {
  ...POPULAR_DARK_CORE_EDITOR_THEMES,
  ...POPULAR_DARK_EXTENDED_EDITOR_THEMES,
  ...POPULAR_LIGHT_EDITOR_THEMES,
  ...CLASSIC_EDITOR_THEMES
} satisfies Record<string, EditorThemeCatalogEntry>

export type EditorThemeCatalogId = keyof typeof EDITOR_THEME_CATALOG
