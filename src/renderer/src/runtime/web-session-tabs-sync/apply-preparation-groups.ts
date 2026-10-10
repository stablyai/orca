import type { TabGroup } from '../../../../shared/tab-types'
import type { prepareWebSessionTabsSnapshotUnified } from './apply-preparation-unified'
import { toWebTerminalSurfaceTabId } from '../web-runtime-session'
import {
  isWebSessionBrowserPlacementGroupReserved,
  peekWebSessionBrowserPlacementGroup
} from '../web-session-browser-placement'
import { peekWebSessionTerminalPlacementGroup } from '../web-session-terminal-placement'
import { reconcileClientOwnedTabPlacement } from '../web-session-client-owned-tab-placement'
import { buildMirroredHostGroups, retainClientPlacedMirroredTabs } from './layout-groups'
import { sanitizeRecentTabIds, pushRecentTabId } from './state-equality-core'

export function prepareWebSessionTabsSnapshotGroups(
  base: ReturnType<typeof prepareWebSessionTabsSnapshotUnified>
) {
  const {
    state,
    snapshot,
    environmentId,
    worktreeId,
    now,
    options,
    terminalSurfaceTabs,
    mirroredBrowserTabs,
    mirroredEditorTabs,
    mirroredUnifiedIds,
    mirroredUnifiedTabs,
    nextUnifiedTabs,
    validUnifiedTabIds,
    nextActiveUnifiedTabId,
    retainedUnifiedTabs,
    targetGroupId,
    hostToLocalTabId,
    provisionalHandoffHostTabIds,
    existingTabIndex,
    honorSnapshotActiveFocus,
    intentUnifiedTabId,
    reservedEmptyPreviewFallbackTabId
  } = base
  const currentGroups = state.groupsByWorktree[worktreeId] ?? []
  const clientGroupIdByLocalTabId = new Map(
    mirroredBrowserTabs.flatMap((entry) =>
      entry.clientGroupId ? [[entry.unifiedTab.id, entry.clientGroupId]] : []
    )
  )
  // Why: once this worktree has client groups, placement is client-owned — snapshots may only
  // append never-seen tabs, drop vanished ones, and honor explicit focus intent. Host order,
  // host actives, and host layout apply only on first adoption (no client groups yet).
  const clientOwnedPlacement = (() => {
    // Why: a preserveLocalLayout owner keeps the local layout authoritative, so placement
    // is client-owned even before any local group record exists — first adoption on an
    // empty worktree must repair a rendered-leaf-without-record or materialize a rendered
    // group instead of publishing the tab into a group no local leaf will ever show.
    if (!nextUnifiedTabs || (currentGroups.length === 0 && !options?.preserveLocalLayout)) {
      return null
    }
    // Why: an entity-identical replacement (provisional terminal → mirrored surface, local
    // editor → host editor tab) is a rename — its position and focus must carry over.
    const rekeyedTabIds = new Map<string, string>()
    for (const [provisionalTabId, hostTabId] of provisionalHandoffHostTabIds) {
      const mirroredId = toWebTerminalSurfaceTabId(hostTabId)
      if (mirroredId !== provisionalTabId) {
        rekeyedTabIds.set(provisionalTabId, mirroredId)
      }
    }
    for (const entry of mirroredEditorTabs) {
      const existing = existingTabIndex.getEditorUnifiedTab(entry.file.id, entry.hostTabId)
      if (existing && existing.id !== entry.unifiedTab.id) {
        rekeyedTabIds.set(existing.id, entry.unifiedTab.id)
      }
    }
    const knownGroupTabIds = new Set(
      currentGroups.flatMap((group) =>
        group.tabOrder.map((tabId) => rekeyedTabIds.get(tabId) ?? tabId)
      )
    )
    // Why: a pending record is this client's own create intent — authoritative even when the
    // provisional tab was provisionally adopted elsewhere or the target group record lags its leaf.
    // The entry's own clientGroupId comes first, so a group the user moved the row into after the
    // create was recorded wins over the group the create asked for.
    const placementMoves = mirroredBrowserTabs.flatMap((entry) => {
      const recordedGroupId = peekWebSessionBrowserPlacementGroup({
        environmentId,
        worktreeId,
        remotePageId: entry.remotePageId
      })
      if (!recordedGroupId) {
        return []
      }
      return [{ tabId: entry.unifiedTab.id, groupId: entry.clientGroupId ?? recordedGroupId }]
    })
    for (const parentTabId of new Set(terminalSurfaceTabs.map((tab) => tab.parentTabId))) {
      const recordedGroupId = peekWebSessionTerminalPlacementGroup({
        environmentId,
        worktreeId,
        hostTabId: parentTabId
      })
      if (recordedGroupId) {
        placementMoves.push({
          tabId: toWebTerminalSurfaceTabId(parentTabId),
          groupId: recordedGroupId
        })
      }
    }
    const adoptedTabs = mirroredUnifiedTabs
      .filter((tab) => !knownGroupTabIds.has(tab.id))
      .map((tab) => ({
        tabId: tab.id,
        groupId: clientGroupIdByLocalTabId.get(tab.id) ?? tab.groupId
      }))
    return reconcileClientOwnedTabPlacement({
      currentGroups,
      worktreeId,
      validUnifiedTabIds,
      adoptedTabs,
      placementMoves,
      rekeyedTabIds,
      intentTabId: honorSnapshotActiveFocus ? (intentUnifiedTabId ?? null) : null,
      reservedEmptyGroupFallbackTabId: reservedEmptyPreviewFallbackTabId,
      currentActiveGroupId: state.activeGroupIdByWorktree[worktreeId] ?? null,
      currentLayout: state.layoutByWorktree[worktreeId] ?? null,
      isGroupReserved: (groupId) =>
        isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId })
    })
  })()
  const nextGroups = (() => {
    if (clientOwnedPlacement) {
      return clientOwnedPlacement.groups
    }
    if (!nextUnifiedTabs || nextUnifiedTabs.length === 0) {
      return null
    }
    if (snapshot.tabGroups && snapshot.tabGroups.length > 0) {
      return buildMirroredHostGroups({
        currentGroups,
        hostGroups: snapshot.tabGroups,
        hostToLocalTabId,
        mirroredUnifiedIds,
        nextActiveUnifiedTabId,
        now,
        validUnifiedTabIds,
        environmentId,
        worktreeId,
        clientGroupIdByLocalTabId
      })
    }
    const strippedGroups = retainClientPlacedMirroredTabs({
      groups: currentGroups,
      mirroredUnifiedIds,
      validUnifiedTabIds,
      clientGroupIdByLocalTabId,
      nextActiveUnifiedTabId
    })
    const target = strippedGroups.find((group) => group.id === targetGroupId) ?? {
      id: targetGroupId,
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const targetOrder = [
      ...target.tabOrder.filter((tabId) => validUnifiedTabIds.has(tabId)),
      ...mirroredUnifiedTabs
        .filter((tab) => !clientGroupIdByLocalTabId.has(tab.id))
        .map((tab) => tab.id)
    ]
    const targetActiveTabId =
      nextActiveUnifiedTabId && targetOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : target.activeTabId && targetOrder.includes(target.activeTabId)
          ? target.activeTabId
          : (targetOrder[0] ?? null)
    const updatedTarget: TabGroup = {
      ...target,
      worktreeId,
      tabOrder: targetOrder,
      activeTabId: targetActiveTabId,
      recentTabIds: targetActiveTabId
        ? pushRecentTabId(sanitizeRecentTabIds(target.recentTabIds, targetOrder), targetActiveTabId)
        : []
    }
    const merged = strippedGroups.some((group) => group.id === targetGroupId)
      ? strippedGroups.map((group) => (group.id === targetGroupId ? updatedTarget : group))
      : [...strippedGroups, updatedTarget]
    return merged.filter(
      (group) =>
        group.id === targetGroupId ||
        group.tabOrder.length > 0 ||
        isWebSessionBrowserPlacementGroupReserved({
          worktreeId,
          groupId: group.id
        })
    )
  })()

  const nextTabBarOrder = (() => {
    const current = state.tabBarOrderByWorktree[worktreeId] ?? []
    const validTabBarIds = new Set([
      ...retainedUnifiedTabs.map((tab) => tab.id),
      ...mirroredUnifiedTabs.map((tab) => tab.id)
    ])
    const hostTabBarOrder =
      snapshot.tabGroups?.flatMap((group) =>
        group.tabOrder
          .map((tabId) => hostToLocalTabId.get(tabId))
          .filter((tabId): tabId is string => tabId !== undefined && validTabBarIds.has(tabId))
      ) ?? []
    const next: string[] = []
    const seen = new Set<string>()
    const push = (tabId: string): void => {
      if (validTabBarIds.has(tabId) && !seen.has(tabId)) {
        seen.add(tabId)
        next.push(tabId)
      }
    }
    // Why: snapshots can arrive after the client staged local browser tabs, so preserve visible order and only append new host tabs.
    for (const tabId of current) {
      push(tabId)
    }
    const hostOrMirroredOrder =
      hostTabBarOrder.length > 0 ? hostTabBarOrder : mirroredUnifiedTabs.map((tab) => tab.id)
    for (const tabId of hostOrMirroredOrder) {
      push(tabId)
    }
    return next
  })()
  return {
    ...base,
    currentGroups,
    clientGroupIdByLocalTabId,
    clientOwnedPlacement,
    nextGroups,
    nextTabBarOrder
  }
}
