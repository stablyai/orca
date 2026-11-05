import type { TabGroup } from '../tab-types'

/** Prefer the tab-bar entry’s stored group, else its first listed group; one tab must not appear in several groups. */
export function resolveTabGroupOwners(
  tabs: readonly { id: string; groupId?: string }[],
  groups: readonly TabGroup[],
  tabIdAliasesByGroup?: Map<string, Map<string, string>>
): Map<string, string> {
  const persistedGroupIds = new Set(groups.map((group) => group.id))
  const knownTabIds = new Set(tabs.map((tab) => tab.id))
  const tabOwners = new Map<string, string>()
  for (const { id, groupId } of tabs) {
    if (groupId !== undefined && persistedGroupIds.has(groupId)) {
      tabOwners.set(id, groupId)
    }
  }
  for (const group of groups) {
    const tabIdAliases = tabIdAliasesByGroup?.get(group.id)
    for (const persistedTabId of group.tabOrder) {
      const tabId = tabIdAliases?.get(persistedTabId) ?? persistedTabId
      if (knownTabIds.has(tabId) && !tabOwners.has(tabId)) {
        tabOwners.set(tabId, group.id)
      }
    }
  }
  return tabOwners
}

/** Each side-only id placed after the id it follows in the side's group, else at the start. */
export function withWindowOnlyIds(
  tabOrder: readonly string[],
  windowOrder: readonly string[],
  windowOnly: ReadonlySet<string>
): string[] {
  type Entry = { id: string; next?: Entry }
  let first: Entry | undefined
  let tail: Entry | undefined
  const byId = new Map<string, Entry>()
  for (const id of tabOrder) {
    const entry: Entry = { id }
    if (tail) {
      tail.next = entry
    } else {
      first = entry
    }
    tail = entry
    if (!byId.has(id)) {
      byId.set(id, entry)
    }
  }
  let previous: Entry | undefined
  for (const id of windowOrder) {
    const known = byId.get(id)
    if (known) {
      previous = known
    } else if (windowOnly.has(id)) {
      const entry: Entry = { id, next: previous ? previous.next : first }
      if (previous) {
        previous.next = entry
      } else {
        first = entry
      }
      byId.set(id, entry)
      previous = entry
    }
  }
  const order: string[] = []
  for (let entry = first; entry; entry = entry.next) {
    order.push(entry.id)
  }
  return order
}
