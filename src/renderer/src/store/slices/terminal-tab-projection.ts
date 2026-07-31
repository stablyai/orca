import type { AppState } from '../types'
import type { Tab, TabGroup, TerminalTab } from '../../../../shared/types'
import {
  layoutExactlyCoversGroups,
  type TerminalTabProjectionState as ProjectionState
} from './terminal-tab-projection-invariant'
export { hasTerminalTabProjectionInvariant } from './terminal-tab-projection-invariant'

type ProjectionPatch = Partial<
  Pick<
    AppState,
    'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree' | 'layoutByWorktree'
  >
>

export type EnsureTerminalTabProjectionSkipReason =
  | 'missing-backing-tab'
  | 'duplicate-backing-tab'
  | 'duplicate-unified-id'
  | 'ambiguous-active-aliases'
  | 'ambiguous-group-topology'
  | 'group-id-collision'

export type EnsureTerminalTabProjectionResult =
  | { status: 'unchanged'; tabId: string; groupId: string }
  | {
      status: 'repaired'
      tabId: string
      groupId: string
      removedProjectionCount: number
      removedOrderOccurrenceCount: number
    }
  | { status: 'skipped'; tabId: string; reason: EnsureTerminalTabProjectionSkipReason }

export type EnsureTerminalTabProjectionOutcome = {
  result: EnsureTerminalTabProjectionResult
  patch: ProjectionPatch
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function dedupeKeepingLast(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index]
    if (!seen.has(value)) {
      seen.add(value)
      reversed.push(value)
    }
  }
  return reversed.toReversed()
}

function buildTerminalProjection(
  backingTab: TerminalTab,
  worktreeId: string,
  groupId: string
): Tab {
  return {
    id: backingTab.id,
    entityId: backingTab.id,
    groupId,
    worktreeId,
    contentType: 'terminal',
    label: backingTab.title,
    ...(backingTab.generatedTitle?.trim()
      ? { generatedLabel: backingTab.generatedTitle.trim() }
      : {}),
    ...(backingTab.quickCommandLabel?.trim()
      ? { quickCommandLabel: backingTab.quickCommandLabel.trim() }
      : {}),
    customLabel: backingTab.customTitle,
    color: backingTab.color,
    sortOrder: backingTab.sortOrder,
    createdAt: backingTab.createdAt,
    ...(backingTab.isPinned !== undefined ? { isPinned: backingTab.isPinned } : {}),
    ...(backingTab.viewMode !== undefined ? { viewMode: backingTab.viewMode } : {})
  }
}

function countTargetOrderOccurrences(
  groups: readonly TabGroup[],
  targetIds: ReadonlySet<string>
): number {
  let count = 0
  for (const group of groups) {
    for (const tabId of group.tabOrder) {
      if (targetIds.has(tabId)) {
        count += 1
      }
    }
  }
  return count
}

export function ensureTerminalTabProjection(
  state: ProjectionState,
  worktreeId: string,
  tabId: string,
  targetGroupId: string | undefined,
  createGroupId: () => string
): EnsureTerminalTabProjectionOutcome {
  const backingMatches = (state.tabsByWorktree[worktreeId] ?? []).filter((tab) => tab.id === tabId)
  if (backingMatches.length === 0) {
    return { result: { status: 'skipped', tabId, reason: 'missing-backing-tab' }, patch: {} }
  }
  if (backingMatches.length > 1) {
    return { result: { status: 'skipped', tabId, reason: 'duplicate-backing-tab' }, patch: {} }
  }

  const backingTab = backingMatches[0]
  const currentTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const targetProjections = currentTabs.filter(
    (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
  )
  const targetProjectionSet = new Set(targetProjections)
  const unifiedIdCounts = new Map<string, number>()
  for (const tab of currentTabs) {
    unifiedIdCounts.set(tab.id, (unifiedIdCounts.get(tab.id) ?? 0) + 1)
  }
  if (
    targetProjections.some((tab) => (unifiedIdCounts.get(tab.id) ?? 0) > 1) ||
    (targetProjections.length === 0 && currentTabs.some((tab) => tab.id === tabId))
  ) {
    return { result: { status: 'skipped', tabId, reason: 'duplicate-unified-id' }, patch: {} }
  }

  const currentGroups = state.groupsByWorktree[worktreeId] ?? []
  if (new Set(currentGroups.map((group) => group.id)).size !== currentGroups.length) {
    return { result: { status: 'skipped', tabId, reason: 'ambiguous-group-topology' }, patch: {} }
  }
  const activelySelectedTargets = targetProjections.filter((tab) =>
    currentGroups.some((group) => group.id === tab.groupId && group.activeTabId === tab.id)
  )
  if (new Set(activelySelectedTargets.map((tab) => tab.groupId)).size > 1) {
    return { result: { status: 'skipped', tabId, reason: 'ambiguous-active-aliases' }, patch: {} }
  }

  const canonicalProjection =
    activelySelectedTargets[0] ??
    targetProjections.find((tab) => tab.id === tabId) ??
    targetProjections[0] ??
    null

  let nextGroups = currentGroups
  let nextLayout = state.layoutByWorktree[worktreeId]
  let groupsCreated = false
  if (currentGroups.length === 0) {
    if (currentTabs.some((tab) => !targetProjectionSet.has(tab))) {
      return { result: { status: 'skipped', tabId, reason: 'ambiguous-group-topology' }, patch: {} }
    }
    const groupId = createGroupId()
    if (currentTabs.some((tab) => tab.groupId === groupId)) {
      return { result: { status: 'skipped', tabId, reason: 'group-id-collision' }, patch: {} }
    }
    nextGroups = [{ id: groupId, worktreeId, activeTabId: null, tabOrder: [] }]
    nextLayout = { type: 'leaf', groupId }
    groupsCreated = true
  } else if (currentGroups.length === 1) {
    if (!layoutExactlyCoversGroups(nextLayout, currentGroups)) {
      nextLayout = { type: 'leaf', groupId: currentGroups[0].id }
    }
  } else if (!layoutExactlyCoversGroups(nextLayout, currentGroups)) {
    return { result: { status: 'skipped', tabId, reason: 'ambiguous-group-topology' }, patch: {} }
  }

  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const chosenGroup =
    (canonicalProjection
      ? nextGroups.find((group) => group.id === canonicalProjection.groupId)
      : undefined) ??
    (targetGroupId ? nextGroups.find((group) => group.id === targetGroupId) : undefined) ??
    nextGroups.find((group) => group.id === activeGroupId) ??
    nextGroups[0]
  if (!chosenGroup) {
    return { result: { status: 'skipped', tabId, reason: 'ambiguous-group-topology' }, patch: {} }
  }

  const canonicalTab = canonicalProjection
    ? canonicalProjection.groupId === chosenGroup.id
      ? canonicalProjection
      : { ...canonicalProjection, groupId: chosenGroup.id }
    : buildTerminalProjection(backingTab, worktreeId, chosenGroup.id)
  const targetIds = new Set(targetProjections.map((tab) => tab.id))
  targetIds.add(canonicalTab.id)
  const priorOrderOccurrenceCount = countTargetOrderOccurrences(currentGroups, targetIds)

  const firstProjectionIndex = currentTabs.findIndex((tab) => targetProjectionSet.has(tab))
  const tabsWithoutTarget = currentTabs.filter((tab) => !targetProjectionSet.has(tab))
  const tabInsertIndex =
    firstProjectionIndex < 0
      ? tabsWithoutTarget.length
      : currentTabs.slice(0, firstProjectionIndex).filter((tab) => !targetProjectionSet.has(tab))
          .length
  const projectedTabs = tabsWithoutTarget.toSpliced(tabInsertIndex, 0, canonicalTab)
  const tabsChanged =
    projectedTabs.length !== currentTabs.length ||
    projectedTabs.some((tab, index) => tab !== currentTabs[index])

  let groupsChanged = groupsCreated
  const projectedGroups = nextGroups.map((group) => {
    const firstTargetIndex = group.tabOrder.findIndex((id) => targetIds.has(id))
    const orderWithoutTarget = group.tabOrder.filter((id) => !targetIds.has(id))
    const nextOrder =
      group.id === chosenGroup.id
        ? orderWithoutTarget.toSpliced(
            firstTargetIndex < 0
              ? orderWithoutTarget.length
              : group.tabOrder.slice(0, firstTargetIndex).filter((id) => !targetIds.has(id)).length,
            0,
            canonicalTab.id
          )
        : orderWithoutTarget
    const nextActiveTabId = targetIds.has(group.activeTabId ?? '')
      ? group.id === chosenGroup.id
        ? canonicalTab.id
        : (nextOrder[0] ?? null)
      : group.activeTabId === null &&
          group.id === chosenGroup.id &&
          (group.tabOrder.length === 0 || state.activeTabIdByWorktree[worktreeId] === tabId)
        ? canonicalTab.id
        : group.activeTabId
    const mappedRecent = (group.recentTabIds ?? [])
      .map((id) => (targetIds.has(id) && group.id === chosenGroup.id ? canonicalTab.id : id))
      .filter((id) => !targetIds.has(id) || id === canonicalTab.id)
      .filter((id) => nextOrder.includes(id))
    const nextRecent = dedupeKeepingLast(mappedRecent)
    const recentUnchanged =
      group.recentTabIds === undefined
        ? nextRecent.length === 0
        : arraysEqual(group.recentTabIds, nextRecent)
    if (
      arraysEqual(group.tabOrder, nextOrder) &&
      group.activeTabId === nextActiveTabId &&
      recentUnchanged
    ) {
      return group
    }
    groupsChanged = true
    return {
      ...group,
      activeTabId: nextActiveTabId,
      tabOrder: nextOrder,
      ...(group.recentTabIds !== undefined || nextRecent.length > 0
        ? { recentTabIds: nextRecent }
        : {})
    }
  })

  const currentLayout = state.layoutByWorktree[worktreeId]
  const layoutChanged = nextLayout !== currentLayout
  const nextActiveGroupId = nextGroups.some((group) => group.id === activeGroupId)
    ? activeGroupId
    : chosenGroup.id
  const activeGroupChanged = nextActiveGroupId !== activeGroupId
  const patch: ProjectionPatch = {
    ...(tabsChanged
      ? {
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: projectedTabs
          }
        }
      : {}),
    ...(groupsChanged
      ? {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: projectedGroups
          }
        }
      : {}),
    ...(activeGroupChanged
      ? {
          activeGroupIdByWorktree: {
            ...state.activeGroupIdByWorktree,
            [worktreeId]: nextActiveGroupId
          }
        }
      : {}),
    ...(layoutChanged && nextLayout
      ? {
          layoutByWorktree: {
            ...state.layoutByWorktree,
            [worktreeId]: nextLayout
          }
        }
      : {})
  }

  if (Object.keys(patch).length === 0) {
    return {
      result: { status: 'unchanged', tabId, groupId: chosenGroup.id },
      patch
    }
  }
  return {
    result: {
      status: 'repaired',
      tabId,
      groupId: chosenGroup.id,
      removedProjectionCount: Math.max(0, targetProjections.length - 1),
      removedOrderOccurrenceCount: Math.max(0, priorOrderOccurrenceCount - 1)
    },
    patch
  }
}
