import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TabDrop } from './tab-group-layout-owner-commands'

export function sideChatOnlyGroup(
  groups: readonly TabGroup[],
  sideChatTabIds: ReadonlySet<string>
): TabGroup | undefined {
  return groups.find(
    (group) => group.tabOrder.length > 0 && group.tabOrder.every((id) => sideChatTabIds.has(id))
  )
}

/** One ordinary tab move at a time; the next decision reads the owner's resulting layout. */
export function sideChatPanePlacement(
  tabs: readonly Tab[],
  groups: readonly TabGroup[],
  sideChatTabIds: ReadonlySet<string>,
  splitDirection: 'right' | 'down',
  movableTabIds: ReadonlySet<string> = sideChatTabIds
): TabDrop | null {
  const destination = sideChatOnlyGroup(groups, sideChatTabIds)
  const tab = tabs.find((tab) => movableTabIds.has(tab.id) && tab.groupId !== destination?.id)
  if (!tab) {
    return null
  }
  if (destination) {
    if (!destination.tabOrder.some((id) => movableTabIds.has(id))) {
      return null
    }
    return { kind: 'move', tabId: tab.id, groupId: destination.id, index: 0 }
  }
  const source = groups.find((group) => group.id === tab.groupId)
  return source && source.tabOrder.length > 1
    ? { kind: 'split', tabId: tab.id, groupId: source.id, direction: splitDirection }
    : null
}
