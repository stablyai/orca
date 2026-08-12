import type { GlobalSettings } from '../../../shared/types'
import { MONACO_MONOKAI_THEME_NAME } from './monaco-monokai-theme'

export type EditorColorThemePreference = GlobalSettings['editorColorTheme']
export type EditorColorThemeValue = NonNullable<EditorColorThemePreference>

export const EDITOR_COLOR_THEME_VALUES: readonly EditorColorThemeValue[] = [
  'auto',
  'vs',
  'vs-dark',
  MONACO_MONOKAI_THEME_NAME
]

/**
 * Resolves the Monaco theme name to hand to `<Editor theme={...}>`.
 * 'auto' keeps following the app's light/dark resolution (`isDark`); any
 * other preference is an explicit override that ignores `isDark` entirely,
 * matching how `terminalThemeDark`/`terminalThemeLight` are explicit
 * overrides of the terminal palette.
 */
export function resolveMonacoThemeName(
  preference: EditorColorThemePreference | undefined,
  isDark: boolean
): string {
  if (!preference || preference === 'auto') {
    return isDark ? 'vs-dark' : 'vs'
  }
  return preference
}
