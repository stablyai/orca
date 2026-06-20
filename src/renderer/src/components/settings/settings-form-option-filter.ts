import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import type { TerminalThemeOption } from '@/lib/terminal-theme'

export const SETTINGS_FORM_OPTION_QUERY_MAX_BYTES = 2 * 1024

export function isSettingsFormOptionQueryTooLarge(
  query: string,
  maxBytes = SETTINGS_FORM_OPTION_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function normalizeSettingsFormOptionQuery(query: string): string | null {
  if (isSettingsFormOptionQueryTooLarge(query)) {
    return null
  }
  const trimmed = query.trim()
  return trimmed.toLowerCase()
}

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

export function filterFontSuggestions(suggestions: readonly string[], query: string): string[] {
  const normalizedQuery = normalizeSettingsFormOptionQuery(query)
  if (normalizedQuery === null) {
    return []
  }
  if (!normalizedQuery) {
    return [...suggestions]
  }

  const startsWith: string[] = []
  const includes: string[] = []
  for (const font of suggestions) {
    const normalizedFont = font.toLowerCase()
    if (normalizedFont.startsWith(normalizedQuery)) {
      startsWith.push(font)
    } else if (normalizedFont.includes(normalizedQuery)) {
      includes.push(font)
    }
  }
  return [...startsWith, ...includes]
}
