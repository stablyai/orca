import { isClipboardTextByteLengthOverLimit } from '../../../../../shared/clipboard-text'

export const SETTINGS_FORM_OPTION_QUERY_MAX_BYTES = 2 * 1024

export function isSettingsFormOptionQueryTooLarge(
  query: string,
  maxBytes = SETTINGS_FORM_OPTION_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function normalizeSettingsFormOptionQuery(query: string): string | null {
  if (isSettingsFormOptionQueryTooLarge(query)) {
    return null
  }
  const trimmed = query.trim()
  return trimmed.toLowerCase()
}

/** Keeps options whose label, keywords or group heading contain every query term; drops empty groups. */
export function filterSearchableSelectGroups<
  TOption extends { label: string; keywords?: readonly string[] },
  TGroup extends { heading?: string; options: readonly TOption[] }
>(groups: readonly TGroup[], query: string): TGroup[] {
  const normalizedQuery = normalizeSettingsFormOptionQuery(query)
  if (normalizedQuery === null) {
    return []
  }
  const terms = normalizedQuery.split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return groups.filter((group) => group.options.length > 0)
  }
  return groups.flatMap((group) => {
    const options = group.options.filter((option) => {
      const text =
        `${option.label} ${option.keywords?.join(' ') ?? ''} ${group.heading ?? ''}`.toLowerCase()
      return terms.every((term) => text.includes(term))
    })
    return options.length > 0 ? [{ ...group, options }] : []
  })
}
