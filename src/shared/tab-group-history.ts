export function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  const filtered = base.filter((id) => id !== tabId)
  filtered.push(tabId)
  return filtered
}
