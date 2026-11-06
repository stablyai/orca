import type { TerminalThemeOption } from '@/lib/terminal-theme'
import { normalizeSettingsFormOptionQuery } from '../../form-controls/settings-form-option-filter'

export function filterTerminalThemeOptions(
  themeOptions: readonly TerminalThemeOption[],
  query: string
): TerminalThemeOption[] {
  const normalizedQuery = normalizeSettingsFormOptionQuery(query)
  if (normalizedQuery === null) {
    return []
  }
  if (!normalizedQuery) {
    return [...themeOptions]
  }
  return themeOptions.filter((theme) =>
    `${theme.label} ${theme.sourceLabel ?? ''} `.toLowerCase().includes(normalizedQuery)
  )
}
