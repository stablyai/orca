export type SettingsSearchEntry = {
  title: string
  description?: string
  keywords?: string[]
}

export function normalizeSettingsSearchQuery(query: string): string {
  return query.trim().toLowerCase()
}

export function matchesSettingsSearch(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): boolean {
  const normalizedQuery = normalizeSettingsSearchQuery(query)
  if (!normalizedQuery) {
    return true
  }

  const values = Array.isArray(entries) ? entries : [entries]
  return values.some((entry) => {
    const haystack = [entry.title, entry.description ?? '', ...(entry.keywords ?? [])]
    return haystack.some((value) => value.toLowerCase().includes(normalizedQuery))
  })
}
