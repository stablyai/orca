import type { GlobalSettings } from '../../../shared/types'
import { EDITOR_THEME_CATALOG, type EditorThemeCatalogId } from './editor-themes'

export type EditorColorThemePreference = GlobalSettings['editorColorTheme']
export type EditorColorThemeValue = NonNullable<EditorColorThemePreference>

/** 'auto'/'vs'/'vs-dark' first (mirrors Monaco's own built-ins), then every
 *  catalog theme in declaration order. */
export const EDITOR_COLOR_THEME_VALUES: readonly EditorColorThemeValue[] = [
  'auto',
  'vs',
  'vs-dark',
  ...(Object.keys(EDITOR_THEME_CATALOG) as EditorThemeCatalogId[])
]

export type EditorColorThemeOption = {
  value: EditorColorThemeValue
  label: string
  group: 'auto' | 'builtin' | 'catalog'
  /** Swatch colors for the picker row; omitted for 'auto' (no fixed palette to preview). */
  swatch?: readonly string[]
}

/** Picker-facing option list: 'auto' first, then Monaco's own light/dark
 *  builtins, then every catalog theme with swatch colors for the picker row —
 *  mirrors getAvailableTerminalThemeOptions() in lib/terminal-theme.ts. */
export function getAvailableEditorColorThemeOptions(): EditorColorThemeOption[] {
  return [
    { value: 'auto', label: 'Follow App Theme', group: 'auto' },
    {
      value: 'vs',
      label: 'Light (Default)',
      group: 'builtin',
      swatch: ['#ffffff', '#0000ff', '#a31515', '#098658', '#001080']
    },
    {
      value: 'vs-dark',
      label: 'Dark (Default)',
      group: 'builtin',
      swatch: ['#1e1e1e', '#569cd6', '#ce9178', '#4ec9b0', '#9cdcfe']
    },
    ...Object.entries(EDITOR_THEME_CATALOG).map(([value, entry]) => ({
      value: value as EditorThemeCatalogId,
      label: entry.label,
      group: 'catalog' as const,
      swatch: [
        entry.palette.background,
        entry.palette.keyword,
        entry.palette.string,
        entry.palette.function,
        entry.palette.constant
      ]
    }))
  ]
}

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
