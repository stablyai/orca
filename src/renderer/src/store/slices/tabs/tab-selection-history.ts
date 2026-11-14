import type { Tab } from '../../../../../shared/tab-types'

/** Pick the nearest neighbor in visual order (right first, then left). */
export function pickNeighbor(tabOrder: string[], closingTabId: string): string | null {
  const idx = tabOrder.indexOf(closingTabId)
  if (idx === -1) {
    return null
  }
  if (idx + 1 < tabOrder.length) {
    return tabOrder[idx + 1]
  }
  if (idx - 1 >= 0) {
    return tabOrder[idx - 1]
  }
  return null
}

/** Keep live MRU IDs once, preserving each last occurrence (tail is newest). */
export function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    const id = recent[i]
    if (!valid.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    reversed.push(id)
  }
  return reversed.toReversed()
}

/** Move tabId to MRU tail, returning a new array. */
export function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  const filtered = base.filter((id) => id !== tabId)
  filtered.push(tabId)
  return filtered
}

/** Prefer previous MRU tab on close; newly hydrated groups may know only the current tab, so fall back to visual neighbor. */
export function pickNextActiveTab(
  tabOrder: string[],
  recentTabIds: string[] | undefined,
  closingTabId: string,
  tabs?: readonly Pick<Tab, 'id'>[]
): string | null {
  if (tabs) {
    const realIds = new Set(tabs.map((tab) => tab.id))
    tabOrder = tabOrder.filter((id) => realIds.has(id))
  }
  const sanitized = sanitizeRecentTabIds(recentTabIds, tabOrder)
  for (let i = sanitized.length - 1; i >= 0; i--) {
    if (sanitized[i] !== closingTabId) {
      return sanitized[i]
    }
  }
  return pickNeighbor(tabOrder, closingTabId)
}
