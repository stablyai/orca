import type { RuntimeMobileSessionTabGroup } from '../../../../shared/runtime-types'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import {
  getActiveTabNavOrder,
  getGroupVisibleTabOrder,
  type VisibleTabRef
} from '../../components/tab-bar/group-tab-order'
import type { MobileSessionWorktreeInputs } from './types'
import { isEditorSurfaceTab } from './mobile-session-surfaces'

export function getEditorUnifiedTabsForWorktree(
  inputs: Pick<MobileSessionWorktreeInputs, 'unifiedTabs'>
): Tab[] {
  return inputs.unifiedTabs.filter(isEditorSurfaceTab)
}

export function applyUnifiedEditorTabIdsToLegacyOrder(
  order: readonly VisibleTabRef[],
  inputs: Pick<MobileSessionWorktreeInputs, 'unifiedTabs'>
): VisibleTabRef[] {
  const unifiedEditorTabs = getEditorUnifiedTabsForWorktree(inputs)
  if (unifiedEditorTabs.length === 0) {
    return [...order]
  }
  const firstUnifiedTabByFileId = new Map<string, string>()
  for (const tab of unifiedEditorTabs) {
    if (!firstUnifiedTabByFileId.has(tab.entityId)) {
      firstUnifiedTabByFileId.set(tab.entityId, tab.id)
    }
  }
  return order.map((item) => {
    if (item.type !== 'editor' || item.tabId) {
      return item
    }
    const tabId = firstUnifiedTabByFileId.get(item.id)
    return tabId ? { ...item, tabId } : item
  })
}

export function appendFallbackEditorTabsToGroups(
  tabGroups: RuntimeMobileSessionTabGroup[] | undefined,
  sourceGroups: readonly TabGroup[],
  activeGroupId: string | null,
  fallbackTabs: readonly { tabId: string; groupId: string | null }[],
  activeTabId: string | null
): RuntimeMobileSessionTabGroup[] | undefined {
  if (fallbackTabs.length === 0) {
    return tabGroups
  }
  const result = [...(tabGroups ?? [])]
  const sourceGroupsById = new Map(sourceGroups.map((group) => [group.id, group]))
  const groupIndexById = new Map(result.map((group, index) => [group.id, index]))
  const firstTargetGroupId =
    result[0]?.id ??
    (activeGroupId && sourceGroupsById.has(activeGroupId) ? activeGroupId : null) ??
    sourceGroups[0]?.id ??
    null
  const fallbackTabIdSet = new Set(fallbackTabs.map((tab) => tab.tabId))

  for (const fallback of fallbackTabs) {
    const targetGroupId =
      fallback.groupId ??
      (activeGroupId && (groupIndexById.has(activeGroupId) || sourceGroupsById.has(activeGroupId))
        ? activeGroupId
        : firstTargetGroupId)
    if (!targetGroupId) {
      continue
    }
    let targetIndex = groupIndexById.get(targetGroupId)
    if (targetIndex === undefined) {
      const sourceGroup = sourceGroupsById.get(targetGroupId)
      const group: RuntimeMobileSessionTabGroup = {
        id: targetGroupId,
        activeTabId: sourceGroup?.activeTabId ?? null,
        tabOrder: [],
        recentTabIds: sourceGroup?.recentTabIds ?? []
      }
      targetIndex = result.length
      groupIndexById.set(targetGroupId, targetIndex)
      result.push(group)
    }
    const group = result[targetIndex]!
    if (!group.tabOrder.includes(fallback.tabId)) {
      result[targetIndex] = { ...group, tabOrder: [...group.tabOrder, fallback.tabId] }
    }
  }
  if (result.length === 0) {
    return tabGroups
  }
  const activeFallbackTabId = activeTabId && fallbackTabIdSet.has(activeTabId) ? activeTabId : null
  return result.map((group) => {
    const tabOrder = [...group.tabOrder]
    const tabOrderSet = new Set(tabOrder)
    const activeFallbackTabIdForGroup =
      activeFallbackTabId && tabOrderSet.has(activeFallbackTabId) ? activeFallbackTabId : null
    const activeTabIdForGroup =
      activeFallbackTabIdForGroup ??
      (group.activeTabId && tabOrderSet.has(group.activeTabId) ? group.activeTabId : null)
    const recentTabIds = (group.recentTabIds ?? []).filter((tabId) => tabOrderSet.has(tabId))
    if (
      activeFallbackTabId &&
      tabOrderSet.has(activeFallbackTabId) &&
      !recentTabIds.includes(activeFallbackTabId)
    ) {
      recentTabIds.push(activeFallbackTabId)
    }
    return { ...group, activeTabId: activeTabIdForGroup, tabOrder, recentTabIds }
  })
}

function getOrderedTabGroups(
  groups: readonly TabGroup[],
  layout: TabGroupLayoutNode | undefined
): TabGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const seen = new Set<string>()
  const ordered: TabGroup[] = []
  for (const groupId of collectTabGroupLayoutIds(layout)) {
    const group = byId.get(groupId)
    if (!group || seen.has(group.id)) {
      continue
    }
    seen.add(group.id)
    ordered.push(group)
  }
  for (const group of groups) {
    if (!seen.has(group.id)) {
      ordered.push(group)
    }
  }
  return ordered
}

function buildLegacyNavOrderView(
  inputs: MobileSessionWorktreeInputs
): Parameters<typeof getActiveTabNavOrder>[0] {
  const { worktreeId } = inputs
  return {
    activeGroupIdByWorktree: inputs.activeGroupId ? { [worktreeId]: inputs.activeGroupId } : {},
    groupsByWorktree: { [worktreeId]: inputs.groups },
    unifiedTabsByWorktree: { [worktreeId]: inputs.unifiedTabs },
    tabBarOrderByWorktree: inputs.tabBarOrder ? { [worktreeId]: inputs.tabBarOrder } : {},
    tabsByWorktree: { [worktreeId]: inputs.terminalTabs },
    openFiles: inputs.openFilesById ? [...inputs.openFilesById.values()] : [],
    browserTabsByWorktree: { [worktreeId]: inputs.browserWorkspaces }
  }
}

export function buildMobileSessionGroupProjection(
  inputs: MobileSessionWorktreeInputs,
  ids: { terminalIds: string[]; editorIds: string[]; browserIds: string[] }
): {
  order: VisibleTabRef[]
  tabGroups?: RuntimeMobileSessionTabGroup[]
  tabGroupLayout?: TabGroupLayoutNode | null
} {
  const groups = inputs.groups
  if (groups.length === 0) {
    return {
      order: applyUnifiedEditorTabIdsToLegacyOrder(
        getActiveTabNavOrder(buildLegacyNavOrderView(inputs), inputs.worktreeId, {
          editorIds: ids.editorIds
        }),
        inputs
      )
    }
  }

  const terminalIds = new Set(ids.terminalIds)
  const editorIds = new Set(ids.editorIds)
  const browserIds = new Set(ids.browserIds)
  const order: VisibleTabRef[] = []
  const tabGroups: RuntimeMobileSessionTabGroup[] = []
  for (const group of getOrderedTabGroups(groups, inputs.tabGroupLayout)) {
    const groupTabs = inputs.unifiedTabs.filter((tab) => tab.groupId === group.id)
    const visibleOrder = getGroupVisibleTabOrder(
      group,
      groupTabs,
      terminalIds,
      editorIds,
      browserIds,
      new Set(),
      true
    )
    if (visibleOrder.length === 0) {
      continue
    }
    const tabOrder = visibleOrder.map((item) => item.tabId ?? item.id)
    const tabOrderSet = new Set(tabOrder)
    for (const item of visibleOrder) {
      order.push(item)
    }
    tabGroups.push({
      id: group.id,
      activeTabId:
        group.activeTabId && tabOrderSet.has(group.activeTabId) ? group.activeTabId : null,
      tabOrder,
      recentTabIds: group.recentTabIds?.filter((tabId) => tabOrderSet.has(tabId)) ?? []
    })
  }
  const validGroupIds = new Set(tabGroups.map((group) => group.id))
  return {
    order,
    tabGroups,
    tabGroupLayout: pruneTabGroupLayout(inputs.tabGroupLayout, validGroupIds)
  }
}

export function collectTabGroupLayoutIds(layout: TabGroupLayoutNode | undefined): string[] {
  const result: string[] = []
  const visit = (node: TabGroupLayoutNode | undefined): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      result.push(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)
  return result
}

export function pruneTabGroupLayout(
  layout: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | null {
  if (!layout) {
    return null
  }
  if (layout.type === 'leaf') {
    return validGroupIds.has(layout.groupId) ? layout : null
  }
  const first = pruneTabGroupLayout(layout.first, validGroupIds)
  const second = pruneTabGroupLayout(layout.second, validGroupIds)
  if (first && second) {
    return { ...layout, first, second }
  }
  return first ?? second
}
