// Choose post-close selection while the old order is available: most recent survivor, then closed-tab neighbour. Empty-group collapse selects its split sibling, matching the window.

import { pickNextActiveTabAfterClose } from '../workspace-session-terminal-tab-close'
import { findSiblingGroupId, removeGroupLayoutLeaf } from './tab-group-layout-tree'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import type { LayoutViewRecord } from './workspace-layout-views'

export function followTabClosesInView(
  record: LayoutViewRecord,
  before: WorkspaceLayoutModel,
  after: WorkspaceLayoutModel
): LayoutViewRecord {
  let groups = record.groups
  for (const [key, byGroup] of Object.entries(record.groups)) {
    for (const [groupId, selection] of Object.entries(byGroup)) {
      const shown = selection.activeTabId
      const was = before.workspaces[key]?.groups.find((group) => group.id === groupId)
      const now = after.workspaces[key]?.groups.find((group) => group.id === groupId)
      if (!shown || !was || !now || now.tabOrder.includes(shown)) {
        continue
      }
      const remainingIds = new Set(now.tabOrder)
      const remaining = was.tabOrder.filter((id) => remainingIds.has(id))
      const closing = new Set(was.tabOrder.filter((id) => !remainingIds.has(id)))
      const activeTabId =
        pickNextActiveTabAfterClose(
          { tabOrder: was.tabOrder, recentTabIds: selection.recentTabIds },
          closing,
          remaining,
          new Set(remaining)
        ) ??
        now.tabOrder[0] ??
        null
      const recentTabIds = selection.recentTabIds?.filter((id) => remainingIds.has(id))
      groups = {
        ...groups,
        [key]: {
          ...groups[key],
          [groupId]: { activeTabId, ...(recentTabIds ? { recentTabIds } : {}) }
        }
      }
    }
  }
  const activeGroupIdByWorktree = followGroupClosesInView(record, before, after)
  if (groups === record.groups && activeGroupIdByWorktree === record.activeGroupIdByWorktree) {
    return record
  }
  return { ...record, groups, activeGroupIdByWorktree }
}

/** As collapseGroupLayout, once per emptied group: its sibling, else the first group left. */
function followGroupClosesInView(
  record: LayoutViewRecord,
  before: WorkspaceLayoutModel,
  after: WorkspaceLayoutModel
): LayoutViewRecord['activeGroupIdByWorktree'] {
  let activeGroups = record.activeGroupIdByWorktree
  for (const [key, was] of Object.entries(before.workspaces)) {
    const now = after.workspaces[key]?.groups ?? []
    let layout = was.groupLayout ?? null
    // The window collapses only a split it still has another group beside.
    if (now.length === 0) {
      continue
    }
    for (const group of was.groups) {
      if (layout === null || now.some((candidate) => candidate.id === group.id)) {
        continue
      }
      const sibling = findSiblingGroupId(layout, group.id)
      layout = removeGroupLayoutLeaf(layout, group.id)
      const current = activeGroups?.[key]
      const next = sibling ?? now[0]?.id ?? current
      if (next !== undefined && next !== current) {
        activeGroups = { ...activeGroups, [key]: next }
      }
    }
  }
  return activeGroups
}
