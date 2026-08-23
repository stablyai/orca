import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { AppState } from '../types'
import {
  restoreTransferLocalProjections,
  restoreTransferRecordKeys,
  restoreTransferSelectors,
  type TransferRollbackPatch
} from './terminal-window-transfer-projection-rollback'

type Entity = { id: string }

function restoreItems<T extends Entity>(
  before: readonly T[],
  after: readonly T[],
  current: readonly T[],
  belongsToTransfer: (item: T) => boolean
): T[] {
  let next = current as T[]
  for (const [index, item] of before.entries()) {
    if (
      !belongsToTransfer(item) ||
      after.some(({ id }) => id === item.id) ||
      next.some(({ id }) => id === item.id)
    ) {
      continue
    }
    if (next === current) {
      next = [...current]
    }
    next.splice(Math.min(index, next.length), 0, item)
  }
  return next
}

export function transferredTerminalWorktreeIds(
  state: AppState,
  tabId: string,
  ...additionalStates: AppState[]
): Set<string> {
  const worktreeIds = new Set<string>()
  for (const candidate of [state, ...additionalStates]) {
    for (const [worktreeId, tabs] of Object.entries(candidate.tabsByWorktree)) {
      if (tabs.some(({ id }) => id === tabId)) {
        worktreeIds.add(worktreeId)
      }
    }
    for (const [worktreeId, tabs] of Object.entries(candidate.unifiedTabsByWorktree)) {
      if (
        tabs.some(({ entityId, contentType }) => entityId === tabId && contentType === 'terminal')
      ) {
        worktreeIds.add(worktreeId)
      }
    }
    for (const [worktreeId, groups] of Object.entries(candidate.groupsByWorktree)) {
      if (groups.some(({ tabOrder }) => tabOrder.includes(tabId))) {
        worktreeIds.add(worktreeId)
      }
    }
    for (const [worktreeId, tabOrder] of Object.entries(candidate.tabBarOrderByWorktree)) {
      if (tabOrder.includes(tabId)) {
        worktreeIds.add(worktreeId)
      }
    }
  }
  return worktreeIds
}

function restoreWorkspaceTabs(
  patch: TransferRollbackPatch,
  before: AppState,
  after: AppState,
  current: AppState,
  tabId: string,
  worktreeIds: ReadonlySet<string>
): Set<string> {
  let tabsByWorktree = current.tabsByWorktree
  let unifiedTabsByWorktree = current.unifiedTabsByWorktree
  const unifiedIds = new Set<string>([tabId])
  for (const worktreeId of worktreeIds) {
    const beforeTabs = before.tabsByWorktree[worktreeId] ?? []
    const nextTabs = restoreItems(
      beforeTabs,
      after.tabsByWorktree[worktreeId] ?? [],
      tabsByWorktree[worktreeId] ?? [],
      ({ id }) => id === tabId
    )
    if (nextTabs !== tabsByWorktree[worktreeId]) {
      tabsByWorktree = { ...tabsByWorktree, [worktreeId]: nextTabs }
    }
    const beforeUnified = before.unifiedTabsByWorktree[worktreeId] ?? []
    for (const tab of beforeUnified) {
      if (tab.contentType === 'terminal' && tab.entityId === tabId) {
        unifiedIds.add(tab.id)
      }
    }
    const nextUnified = restoreItems(
      beforeUnified,
      after.unifiedTabsByWorktree[worktreeId] ?? [],
      unifiedTabsByWorktree[worktreeId] ?? [],
      ({ entityId, contentType }: Tab) => entityId === tabId && contentType === 'terminal'
    )
    if (nextUnified !== unifiedTabsByWorktree[worktreeId]) {
      unifiedTabsByWorktree = { ...unifiedTabsByWorktree, [worktreeId]: nextUnified }
    }
  }
  if (tabsByWorktree !== current.tabsByWorktree) {
    patch.tabsByWorktree = tabsByWorktree
  }
  if (unifiedTabsByWorktree !== current.unifiedTabsByWorktree) {
    patch.unifiedTabsByWorktree = unifiedTabsByWorktree
  }
  return unifiedIds
}

function restoreIds(
  current: readonly string[],
  before: readonly string[],
  ids: Set<string>
): string[] {
  let next = current as string[]
  for (const id of ids) {
    if (!before.includes(id) || next.includes(id)) {
      continue
    }
    if (next === current) {
      next = [...current]
    }
    const index = before.indexOf(id)
    next.splice(Math.min(index, next.length), 0, id)
  }
  return next
}

function restoreTabBarOrder(
  patch: TransferRollbackPatch,
  before: AppState,
  after: AppState,
  current: AppState,
  tabId: string,
  worktreeIds: ReadonlySet<string>
): void {
  let nextByWorktree = current.tabBarOrderByWorktree
  for (const worktreeId of worktreeIds) {
    if ((after.tabBarOrderByWorktree[worktreeId] ?? []).includes(tabId)) {
      continue
    }
    const currentOrder = nextByWorktree[worktreeId] ?? []
    const nextOrder = restoreIds(
      currentOrder,
      before.tabBarOrderByWorktree[worktreeId] ?? [],
      new Set([tabId])
    )
    if (nextOrder !== currentOrder) {
      nextByWorktree = { ...nextByWorktree, [worktreeId]: nextOrder }
    }
  }
  if (nextByWorktree !== current.tabBarOrderByWorktree) {
    patch.tabBarOrderByWorktree = nextByWorktree
  }
}

function restoreGroup(
  before: TabGroup,
  after: TabGroup | undefined,
  current: TabGroup,
  memberIds: Set<string>
): TabGroup {
  const tabOrder = restoreIds(current.tabOrder, before.tabOrder, memberIds)
  const currentRecent = current.recentTabIds ?? []
  const recentTabIds = restoreIds(currentRecent, before.recentTabIds ?? [], memberIds)
  const activeTabId =
    before.activeTabId !== after?.activeTabId && current.activeTabId === after?.activeTabId
      ? before.activeTabId
      : current.activeTabId
  if (
    tabOrder === current.tabOrder &&
    recentTabIds === currentRecent &&
    activeTabId === current.activeTabId
  ) {
    return current
  }
  return { ...current, tabOrder, recentTabIds, activeTabId }
}

function layoutContains(root: TabGroupLayoutNode | undefined, groupId: string): boolean {
  if (!root) {
    return false
  }
  return root.type === 'leaf'
    ? root.groupId === groupId
    : layoutContains(root.first, groupId) || layoutContains(root.second, groupId)
}

function restoreGroupsAndLayout(
  patch: TransferRollbackPatch,
  before: AppState,
  after: AppState,
  current: AppState,
  worktreeIds: ReadonlySet<string>,
  memberIds: Set<string>
): Set<string> {
  let groupsByWorktree = current.groupsByWorktree
  let layoutByWorktree = current.layoutByWorktree
  const groupIds = new Set<string>()
  for (const worktreeId of worktreeIds) {
    const beforeGroups = before.groupsByWorktree[worktreeId] ?? []
    const sourceGroups = beforeGroups.filter(({ tabOrder }) =>
      tabOrder.some((id) => memberIds.has(id))
    )
    let currentGroups = current.groupsByWorktree[worktreeId] ?? []
    for (const sourceGroup of sourceGroups) {
      groupIds.add(sourceGroup.id)
      const index = currentGroups.findIndex(({ id }) => id === sourceGroup.id)
      if (index === -1) {
        currentGroups = [...currentGroups]
        currentGroups.splice(
          Math.min(beforeGroups.indexOf(sourceGroup), currentGroups.length),
          0,
          sourceGroup
        )
        continue
      }
      const restored = restoreGroup(
        sourceGroup,
        (after.groupsByWorktree[worktreeId] ?? []).find(({ id }) => id === sourceGroup.id),
        currentGroups[index],
        memberIds
      )
      if (restored !== currentGroups[index]) {
        currentGroups = [...currentGroups]
        currentGroups[index] = restored
      }
    }
    if (currentGroups !== current.groupsByWorktree[worktreeId]) {
      groupsByWorktree = { ...groupsByWorktree, [worktreeId]: currentGroups }
    }
    const beforeLayout = before.layoutByWorktree[worktreeId]
    let currentLayout = current.layoutByWorktree[worktreeId]
    if (!beforeLayout) {
      continue
    }
    if (Object.is(currentLayout, after.layoutByWorktree[worktreeId])) {
      currentLayout = beforeLayout
    } else {
      for (const { id } of sourceGroups) {
        if (layoutContains(currentLayout, id)) {
          continue
        }
        currentLayout = currentLayout
          ? {
              type: 'split',
              direction: 'horizontal',
              first: currentLayout,
              second: { type: 'leaf', groupId: id }
            }
          : { type: 'leaf', groupId: id }
      }
    }
    if (currentLayout !== current.layoutByWorktree[worktreeId]) {
      layoutByWorktree = { ...layoutByWorktree, [worktreeId]: currentLayout }
    }
  }
  if (groupsByWorktree !== current.groupsByWorktree) {
    patch.groupsByWorktree = groupsByWorktree
  }
  if (layoutByWorktree !== current.layoutByWorktree) {
    patch.layoutByWorktree = layoutByWorktree
  }
  return groupIds
}

export function buildTransferredTerminalRemovalRollbackPatch(
  before: AppState,
  after: AppState,
  current: AppState,
  tabId: string
): Partial<AppState> {
  const patch: TransferRollbackPatch = {}
  const worktreeIds = transferredTerminalWorktreeIds(before, tabId, after, current)
  const memberIds = restoreWorkspaceTabs(patch, before, after, current, tabId, worktreeIds)
  const groupIds = restoreGroupsAndLayout(patch, before, after, current, worktreeIds, memberIds)
  restoreTabBarOrder(patch, before, after, current, tabId, worktreeIds)
  restoreTransferLocalProjections(patch, before, after, current, tabId)
  restoreTransferRecordKeys(patch, before, after, current, 'recentQuickCommandIdByGroup', groupIds)
  restoreTransferSelectors(patch, before, after, current, worktreeIds)
  return patch as Partial<AppState>
}
