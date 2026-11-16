import { textmateScopeForMonacoToken } from '@/lib/editor/appearance/plugin-monaco-token-rules'
import { registerCustomTheme, type ThemesType } from '@pierre/diffs'
import { bundledThemes } from 'shiki'
import type { PluginMonacoTheme } from '@/lib/editor/appearance/plugin-monaco-theme'
import { PIERRE_DIFF_THEMES } from './pierre-diff-options'

const registered = new Set<string>()

export function resolvePierreDiffTheme(theme: PluginMonacoTheme | null): ThemesType {
  if (!theme) {
    return PIERRE_DIFF_THEMES
  }
  if (!registered.has(theme.name)) {
    registered.add(theme.name)
    registerCustomTheme(theme.name, async () => {
      const base = await bundledThemes[theme.data.base === 'vs-dark' ? 'dark-plus' : 'light-plus']()
      return {
        ...base.default,
        name: theme.name,
        colors: { ...base.default.colors, ...theme.data.colors },
        tokenColors: [
          ...(base.default.tokenColors ?? []),
          ...theme.data.rules.map((rule) => ({
            scope: textmateScopeForMonacoToken(rule.token),
            settings: { foreground: rule.foreground, fontStyle: rule.fontStyle }
          }))
        ]
      }
    })
  }
  return { dark: theme.name, light: theme.name }
}

export function buildPierreDiffSelectionStyle(
  theme: PluginMonacoTheme | null,
  type: 'light' | 'dark'
) {
  const selection =
    theme?.data.colors['editor.selectionBackground'] ?? (type === 'dark' ? '#264f78' : '#add6ff')
  return {
    '--orca-diff-selection-bg': selection,
    '--orca-diff-inactive-selection-bg':
      theme?.data.colors['editor.inactiveSelectionBackground'] ?? selection
  }
}
