import type { Tab } from '../../../../shared/tab-types'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'
import type { TabBarItem } from './tab-bar-item-model'

export type TabStripEntry =
  | { type: 'folder'; folder: TabFolderGroup; members: TabBarItem[] }
  | { type: 'tab'; item: TabBarItem }

export function projectTabStripEntries(
  items: readonly TabBarItem[],
  folders: readonly TabFolderGroup[],
  unifiedTabs: readonly Tab[],
  splitGroupId: string
): TabStripEntry[] {
  const foldersInSplit = folders.filter((folder) => folder.splitGroupId === splitGroupId)
  if (foldersInSplit.length === 0) {
    return items.map((item) => ({ type: 'tab', item }))
  }

  const folderByTabId = new Map<string, TabFolderGroup>()
  const unifiedById = new Map(unifiedTabs.map((tab) => [tab.id, tab]))
  for (const folder of foldersInSplit) {
    for (const tabId of folder.tabOrder) {
      folderByTabId.set(tabId, folder)
    }
  }
  for (const tab of unifiedTabs) {
    if (tab.groupId !== splitGroupId || !tab.folderGroupId || folderByTabId.has(tab.id)) {
      continue
    }
    const folder = foldersInSplit.find((candidate) => candidate.id === tab.folderGroupId)
    if (folder) {
      folderByTabId.set(tab.id, folder)
    }
  }

  const itemByUnifiedId = new Map(items.map((item) => [item.unifiedTabId, item]))
  const emittedFolders = new Set<string>()
  const entries: TabStripEntry[] = []

  for (const item of items) {
    const unifiedTab = unifiedById.get(item.unifiedTabId)
    const folder =
      folderByTabId.get(item.unifiedTabId) ??
      (unifiedTab?.folderGroupId
        ? foldersInSplit.find((candidate) => candidate.id === unifiedTab.folderGroupId)
        : undefined)
    if (!folder) {
      entries.push({ type: 'tab', item })
      continue
    }
    if (emittedFolders.has(folder.id)) {
      continue
    }
    emittedFolders.add(folder.id)
    const members = folder.tabOrder
      .map((tabId) => itemByUnifiedId.get(tabId))
      .filter((member): member is TabBarItem => member !== undefined)
    for (const member of items) {
      if (folderByTabId.get(member.unifiedTabId)?.id !== folder.id) {
        continue
      }
      if (!members.some((existing) => existing.unifiedTabId === member.unifiedTabId)) {
        members.push(member)
      }
    }
    entries.push({ type: 'folder', folder, members })
    if (!folder.collapsed) {
      for (const member of members) {
        entries.push({ type: 'tab', item: member })
      }
    }
  }

  return entries
}

export function visibleSortableIdsFromStripEntries(entries: readonly TabStripEntry[]): string[] {
  return entries.flatMap((entry) => (entry.type === 'tab' ? [entry.item.id] : []))
}

export function tabStripEntriesLayoutKey(entries: readonly TabStripEntry[]): string {
  return entries
    .map((entry) =>
      entry.type === 'folder'
        ? `folder:${entry.folder.id}:${entry.folder.collapsed ? 'c' : 'e'}:${entry.members.map((member) => member.id).join(',')}`
        : `tab:${entry.item.id}`
    )
    .join('\u001f')
}
