import type { Tab } from './tab-types'
import type { TabFolderGroup } from './tab-folder-types'

export const DEFAULT_TAB_FOLDER_GROUP_COLOR = '#3b82f6'

export const TAB_FOLDER_GROUP_COLORS = [
  '#3b82f6',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#9ca3af'
] as const

function dedupeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

export function findFolderGroupAndWorktree(
  folderGroupsByWorktree: Record<string, TabFolderGroup[]>,
  folderGroupId: string
): { folderGroup: TabFolderGroup; worktreeId: string } | null {
  for (const [worktreeId, groups] of Object.entries(folderGroupsByWorktree)) {
    const folderGroup = groups.find((candidate) => candidate.id === folderGroupId)
    if (folderGroup) {
      return { folderGroup, worktreeId }
    }
  }
  return null
}

export function updateFolderGroup(
  groups: TabFolderGroup[],
  updated: TabFolderGroup
): TabFolderGroup[] {
  return groups.map((group) => (group.id === updated.id ? updated : group))
}

export function nextTabFolderGroupName(existing: readonly TabFolderGroup[]): string {
  const used = new Set(existing.map((group) => group.name))
  if (!used.has('Folder')) {
    return 'Folder'
  }
  let index = 2
  while (used.has(`Folder ${index}`)) {
    index += 1
  }
  return `Folder ${index}`
}

export function nextTabFolderGroupColor(existing: readonly TabFolderGroup[]): string {
  return TAB_FOLDER_GROUP_COLORS[existing.length % TAB_FOLDER_GROUP_COLORS.length]
}

export function sanitizeFolderGroupsForWorktree(
  tabs: readonly Tab[],
  folderGroups: readonly TabFolderGroup[]
): TabFolderGroup[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const groupById = new Map(folderGroups.map((group) => [group.id, group]))
  const assignedTabIdsByGroup = new Map<string, string[]>()

  for (const tab of tabs) {
    if (!tab.folderGroupId) {
      continue
    }
    const folderGroup = groupById.get(tab.folderGroupId)
    if (!folderGroup || tab.groupId !== folderGroup.splitGroupId) {
      continue
    }
    const current = assignedTabIdsByGroup.get(tab.folderGroupId) ?? []
    current.push(tab.id)
    assignedTabIdsByGroup.set(tab.folderGroupId, current)
  }

  return folderGroups
    .map((group) => {
      const assignedTabIds = assignedTabIdsByGroup.get(group.id) ?? []
      const assignedSet = new Set(assignedTabIds)
      const tabOrder = dedupeIds([
        ...group.tabOrder.filter((tabId) => {
          const tab = tabById.get(tabId)
          return (
            tab !== undefined &&
            tab.groupId === group.splitGroupId &&
            tab.folderGroupId === group.id
          )
        }),
        ...assignedTabIds
      ]).filter((tabId) => assignedSet.has(tabId))
      return { ...group, tabOrder }
    })
    .filter((group) => group.tabOrder.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
}

export function clearMissingFolderAssignments(
  tabs: readonly Tab[],
  folderGroups: readonly TabFolderGroup[]
): Tab[] {
  const folderGroupById = new Map(folderGroups.map((group) => [group.id, group]))
  let changed = false
  const nextTabs = tabs.map((tab) => {
    if (!tab.folderGroupId) {
      return tab
    }
    const folderGroup = folderGroupById.get(tab.folderGroupId)
    if (
      folderGroup &&
      tab.groupId === folderGroup.splitGroupId &&
      folderGroup.tabOrder.includes(tab.id)
    ) {
      return tab
    }
    changed = true
    return { ...tab, folderGroupId: null }
  })
  return changed ? nextTabs : [...tabs]
}

export function applyFolderMembershipAfterTabChange(
  tabs: readonly Tab[],
  folderGroups: readonly TabFolderGroup[]
): { tabs: Tab[]; folders: TabFolderGroup[] } {
  const folders = sanitizeFolderGroupsForWorktree(tabs, folderGroups)
  return {
    folders,
    tabs: clearMissingFolderAssignments(tabs, folders)
  }
}

export function syncFolderTabOrdersFromGroupOrder(
  folders: readonly TabFolderGroup[],
  tabOrder: readonly string[],
  splitGroupId: string
): TabFolderGroup[] {
  const indexById = new Map(tabOrder.map((tabId, index) => [tabId, index]))
  return folders.map((folder) => {
    // Why: a pane's tabOrder is not a membership filter for folders in other splits.
    if (folder.splitGroupId !== splitGroupId) {
      return folder
    }
    const members = folder.tabOrder.filter((tabId) => indexById.has(tabId))
    members.sort((left, right) => (indexById.get(left) ?? 0) - (indexById.get(right) ?? 0))
    if (
      members.length === folder.tabOrder.length &&
      members.every((id, i) => id === folder.tabOrder[i])
    ) {
      return folder
    }
    return { ...folder, tabOrder: members }
  })
}

export function assignTabsToFolderGroup(
  tabs: readonly Tab[],
  folderGroups: readonly TabFolderGroup[],
  folderGroupId: string,
  tabIds: readonly string[],
  opts?: { index?: number }
): { tabs: Tab[]; folders: TabFolderGroup[] } | null {
  const folder = folderGroups.find((candidate) => candidate.id === folderGroupId)
  if (!folder) {
    return null
  }
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const eligibleIds = dedupeIds(tabIds).filter((tabId) => {
    const tab = tabById.get(tabId)
    return tab?.groupId === folder.splitGroupId
  })
  if (eligibleIds.length === 0) {
    return null
  }

  const eligibleSet = new Set(eligibleIds)
  const nextFolders = folderGroups
    .map((candidate) => {
      if (candidate.id === folderGroupId) {
        const remaining = candidate.tabOrder.filter((tabId) => !eligibleSet.has(tabId))
        const insertAt = Math.max(0, Math.min(opts?.index ?? remaining.length, remaining.length))
        const tabOrder = [
          ...remaining.slice(0, insertAt),
          ...eligibleIds,
          ...remaining.slice(insertAt)
        ]
        return { ...candidate, tabOrder }
      }
      if (!candidate.tabOrder.some((tabId) => eligibleSet.has(tabId))) {
        return candidate
      }
      return {
        ...candidate,
        tabOrder: candidate.tabOrder.filter((tabId) => !eligibleSet.has(tabId))
      }
    })
    .filter((candidate) => candidate.tabOrder.length > 0)

  const nextTabs = tabs.map((tab) => {
    if (!eligibleSet.has(tab.id)) {
      return tab
    }
    return { ...tab, folderGroupId }
  })

  return applyFolderMembershipAfterTabChange(nextTabs, nextFolders)
}

export function removeTabFromFolderGroup(
  tabs: readonly Tab[],
  folderGroups: readonly TabFolderGroup[],
  tabId: string
): { tabs: Tab[]; folders: TabFolderGroup[] } | null {
  const tab = tabs.find((candidate) => candidate.id === tabId)
  if (!tab?.folderGroupId) {
    return null
  }
  const nextTabs = tabs.map((candidate) =>
    candidate.id === tabId ? { ...candidate, folderGroupId: null } : candidate
  )
  const nextFolders = folderGroups.map((folder) =>
    folder.id === tab.folderGroupId
      ? { ...folder, tabOrder: folder.tabOrder.filter((id) => id !== tabId) }
      : folder
  )
  return applyFolderMembershipAfterTabChange(nextTabs, nextFolders)
}

export function ungroupFolderGroup(
  tabs: readonly Tab[],
  folderGroups: readonly TabFolderGroup[],
  folderGroupId: string
): { tabs: Tab[]; folders: TabFolderGroup[] } | null {
  if (!folderGroups.some((folder) => folder.id === folderGroupId)) {
    return null
  }
  const nextTabs = tabs.map((tab) =>
    tab.folderGroupId === folderGroupId ? { ...tab, folderGroupId: null } : tab
  )
  return applyFolderMembershipAfterTabChange(
    nextTabs,
    folderGroups.filter((folder) => folder.id !== folderGroupId)
  )
}
