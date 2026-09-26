import type * as monaco from 'monaco-editor'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveDocumentTheme } from './document-theme'
import { DARK_EDITOR_THEMES, type EditorThemeItem } from './monaco-themes-dark'
import { LIGHT_EDITOR_THEMES } from './monaco-themes-light'

export { DARK_EDITOR_THEMES, LIGHT_EDITOR_THEMES, type EditorThemeItem }

export const DEFAULT_EDITOR_THEME_DARK = 'vs-dark'
export const DEFAULT_EDITOR_THEME_LIGHT = 'vs'

export const ALL_EDITOR_THEMES: EditorThemeItem[] = [...DARK_EDITOR_THEMES, ...LIGHT_EDITOR_THEMES]

/**
 * Checks whether the given theme ID is registered in the theme catalog.
 *
 * @param id - The theme identifier to check.
 * @param mode - Optional mode ('dark' | 'light') to restrict the search.
 * @returns True if the theme is recognized for the specified mode.
 */
export function isKnownEditorTheme(id: string, mode?: 'dark' | 'light'): boolean {
  if (mode) {
    return ALL_EDITOR_THEMES.some((t) => t.id === id && t.mode === mode)
  }
  return ALL_EDITOR_THEMES.some((t) => t.id === id)
}

export type MonacoThemeRegistry = {
  editor: {
    defineTheme: (name: string, themeData: monaco.editor.IStandaloneThemeData) => void
  }
}

/**
 * Registers all custom Monaco editor themes with the provided Monaco instance.
 *
 * @param monacoInstance - The Monaco theme registry instance to define themes on.
 */
export function registerMonacoThemes(monacoInstance: MonacoThemeRegistry): void {
  for (const theme of ALL_EDITOR_THEMES) {
    if (theme.data) {
      monacoInstance.editor.defineTheme(theme.id, theme.data)
    }
  }
}

/**
 * Resolves the active Monaco editor theme ID based on settings and color scheme mode.
 *
 * @param settings - The global settings object or partial settings containing theme preferences.
 * @param isDarkOrMatchMedia - Explicit boolean indicating dark mode, or a matchMedia function for testing.
 * @returns The resolved Monaco theme identifier.
 */
export function resolveEditorTheme(
  settings?: Partial<Pick<GlobalSettings, 'theme' | 'editorThemeDark' | 'editorThemeLight'>> | null,
  isDarkOrMatchMedia?: boolean | ((query: string) => Pick<MediaQueryList, 'matches'>)
): string {
  const isDark =
    typeof isDarkOrMatchMedia === 'boolean'
      ? isDarkOrMatchMedia
      : resolveDocumentTheme(
          settings?.theme ?? 'system',
          typeof isDarkOrMatchMedia === 'function' ? isDarkOrMatchMedia : undefined
        )
  if (isDark) {
    const configured = settings?.editorThemeDark
    return configured && isKnownEditorTheme(configured, 'dark')
      ? configured
      : DEFAULT_EDITOR_THEME_DARK
  }

  const configured = settings?.editorThemeLight
  return configured && isKnownEditorTheme(configured, 'light')
    ? configured
    : DEFAULT_EDITOR_THEME_LIGHT
}
