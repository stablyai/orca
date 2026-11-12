// Keep the host's order and match whole search terms instead of scattered letters.
export function nativeChatModelSearchScore(
  value: string,
  search: string,
  keywords?: string[]
): number {
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase()
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => haystack.includes(term)) ? 1 : 0
}
