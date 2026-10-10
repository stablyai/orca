import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import type { AutomationHostCatalogEntry } from './automation-host-catalog-types'
import { orderAutomationHostCatalogEntries } from './automation-host-catalog-order'

export type AutomationHostPickerGroup = {
  authorityKey: string
  authorityLabel: string
  entries: AutomationHostCatalogEntry[]
}

/**
 * Groups by authority while preserving the one deterministic catalog order, so
 * the picker and the All-hosts list never disagree about position.
 */
export function groupAutomationHostEntriesByAuthority(
  entries: readonly AutomationHostCatalogEntry[]
): AutomationHostPickerGroup[] {
  const ordered = orderAutomationHostCatalogEntries(entries)
  const groups: AutomationHostPickerGroup[] = []
  const byKey = new Map<string, AutomationHostPickerGroup>()

  for (const entry of ordered) {
    const authorityKey = automationAuthorityCatalogKey(entry.stableRef.authority)
    let group = byKey.get(authorityKey)
    if (!group) {
      group = { authorityKey, authorityLabel: entry.authorityLabel, entries: [] }
      byKey.set(authorityKey, group)
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}
