// The one group that owns each tab when stored groups and tab-bar entries disagree.

import type { TabGroup } from '../tab-types'

/**
 * A tab belongs to the stored group its tab-bar entry names; failing that, to the first group
 * listing it. Keeps one tab from showing in several groups.
 */
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
