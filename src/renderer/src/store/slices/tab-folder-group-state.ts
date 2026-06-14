import { dedupeTabOrder } from './tab-group-state'
import type { Tab, TabFolderGroup } from '../../../../shared/types'

export const DEFAULT_TAB_FOLDER_GROUP_COLOR = 'var(--color-blue-500)'

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
      const tabOrder = dedupeTabOrder([
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
  return changed ? nextTabs : (tabs as Tab[])
}
