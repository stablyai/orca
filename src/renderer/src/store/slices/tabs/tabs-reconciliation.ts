import { structuredLaunchSlotIds } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { isLiveSurfaceContentType } from '../../../../../shared/tab-types'
import type { AppState } from '../../types'
import type { Tab } from '../../../../../shared/tab-types'
import { dedupeTabOrder } from '../../../../../shared/workspace-layout/tab-order'
import { ensureGroup, sanitizeRecentTabIds, updateGroup } from '../tab-group-state'
import { pruneTabGroupLayoutForGroups } from '../tabs-hydration'
import {
  buildOrphanTerminalCleanupPatch,
  getOrphanTerminalIds,
  terminalTabHasReconnectablePty
} from '../terminal-orphan-helpers'
import {
  EMPTY_LIVE_EDITOR_IDS,
  writeBatchedWorkspaceRecordEntry,
  type WorktreeTabModelReconciliationBatch
} from './tabs-reconciliation-batch'

export type WorktreeTabModelReconciliation = {
  patch: Partial<AppState>
  renderableTabCount: number
  activeRenderableTabId: string | null
}

/** Pure single-workspace patch; optional batch reuses map drafts/openFiles index without changing projected values. */
export function projectWorktreeTabModelReconciliation(
  state: AppState,
  worktreeId: string,
  batch?: WorktreeTabModelReconciliationBatch
): WorktreeTabModelReconciliation {
  const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const runtimeTerminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const unifiedTerminalEntityIds = new Set(
    unifiedTabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
  )
  const legacyRuntimeTerminalTabs = runtimeTerminalTabs.filter((tab) => {
    if (unifiedTerminalEntityIds.has(tab.id)) {
      return false
    }
    // Reconnect or unverified host-loss evidence keeps legacy tabs live until replacement binds or user closes them.
    return (
      terminalTabHasReconnectablePty(state, tab.id, tab.ptyId) ||
      state.unverifiedPtyLossTabIds[tab.id] === true
    )
  })
  const orphanTerminalIds = getOrphanTerminalIds(state, worktreeId)
  const ensuredGroupState =
    legacyRuntimeTerminalTabs.length > 0
      ? ensureGroup(
          state.groupsByWorktree,
          state.activeGroupIdByWorktree,
          worktreeId,
          state.activeGroupIdByWorktree[worktreeId]
        )
      : null
  const reconciliationGroup = ensuredGroupState?.group ?? groups[0] ?? null
  const restoredLegacyTabs =
    reconciliationGroup == null
      ? []
      : legacyRuntimeTerminalTabs
          .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
          .map((tab) => ({
            id: tab.id,
            entityId: tab.id,
            groupId: reconciliationGroup.id,
            worktreeId,
            contentType: 'terminal' as const,
            label: tab.title,
            ...(tab.quickCommandLabel?.trim()
              ? { quickCommandLabel: tab.quickCommandLabel.trim() }
              : {}),
            ...(tab.generatedTitle?.trim() ? { generatedLabel: tab.generatedTitle.trim() } : {}),
            ...(tab.aiVaultTitle ? { aiVaultTitle: tab.aiVaultTitle } : {}),
            customLabel: tab.customTitle,
            color: tab.color,
            sortOrder: tab.sortOrder,
            createdAt: tab.createdAt
          }))
  const reconciledUnifiedTabs =
    restoredLegacyTabs.length > 0 ? [...unifiedTabs, ...restoredLegacyTabs] : unifiedTabs
  const rememberedLegacyActiveTabId = state.activeTabIdByWorktree[worktreeId]
  const restoredLegacyTabIds = new Set(restoredLegacyTabs.map((tab) => tab.id))
  const legacyFallbackActiveTabId =
    rememberedLegacyActiveTabId && restoredLegacyTabIds.has(rememberedLegacyActiveTabId)
      ? rememberedLegacyActiveTabId
      : (restoredLegacyTabs[0]?.id ?? null)
  const reconciledGroups =
    restoredLegacyTabs.length > 0 && reconciliationGroup
      ? updateGroup(ensuredGroupState!.groupsByWorktree[worktreeId] ?? [], {
          ...reconciliationGroup,
          // Why: restore runtime tabs into the active/root group so reattach cannot spawn a duplicate.
          activeTabId: reconciliationGroup.activeTabId ?? legacyFallbackActiveTabId,
          tabOrder: dedupeTabOrder([
            ...reconciliationGroup.tabOrder,
            ...restoredLegacyTabs.map((tab) => tab.id)
          ])
        })
      : groups
  const liveTerminalIds = new Set(
    runtimeTerminalTabs.filter((tab) => !orphanTerminalIds.has(tab.id)).map((tab) => tab.id)
  )
  // Batch index avoids O(workspaces × openFiles) rescanning.
  const liveEditorIds: ReadonlySet<string> = batch
    ? (batch.liveEditorIdsByWorktree.get(worktreeId) ?? EMPTY_LIVE_EDITOR_IDS)
    : new Set(
        state.openFiles.filter((file) => file.worktreeId === worktreeId).map((file) => file.id)
      )
  const liveBrowserIds = new Set(
    (state.browserTabsByWorktree[worktreeId] ?? []).map((browserTab) => browserTab.id)
  )

  const isRenderableTab = (tab: Tab): boolean => {
    if (tab.contentType === 'terminal') {
      return liveTerminalIds.has(tab.entityId)
    }
    if (tab.contentType === 'browser') {
      return liveBrowserIds.has(tab.entityId)
    }
    if (isLiveSurfaceContentType(tab.contentType) || tab.contentType === 'agent-session') {
      return true
    }
    return liveEditorIds.has(tab.entityId)
  }

  const renderableTabs = reconciledUnifiedTabs.filter(isRenderableTab)
  // No filtering must preserve tab-array identity even if orphan/layout state changed.
  const validTabs =
    renderableTabs.length === reconciledUnifiedTabs.length ? reconciledUnifiedTabs : renderableTabs
  const validTabIds = new Set(validTabs.map((tab) => tab.id))
  const nextGroupsWithEmpty = reconciledGroups.map((group) => {
    const slots = structuredLaunchSlotIds(worktreeId, group.id)
    const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId) || slots.has(tabId))
    const realOrder = tabOrder.filter((id) => validTabIds.has(id))
    const activeTabId =
      group.activeTabId && validTabIds.has(group.activeTabId)
        ? group.activeTabId
        : (realOrder[0] ?? null)
    const tabOrderUnchanged =
      tabOrder.length === group.tabOrder.length &&
      tabOrder.every((tabId, index) => tabId === group.tabOrder[index])
    const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, realOrder)
    const recentUnchanged =
      recentTabIds.length === (group.recentTabIds ?? []).length &&
      recentTabIds.every((id, index) => id === (group.recentTabIds ?? [])[index])
    return tabOrderUnchanged && activeTabId === group.activeTabId && recentUnchanged
      ? group
      : { ...group, tabOrder, activeTabId, recentTabIds }
  })
  const prunedGroups =
    validTabs.length > 0
      ? nextGroupsWithEmpty.filter(
          // Preserve intentional empty panes; only collapse groups emptied by stale-tab cleanup.
          (group, index) =>
            group.tabOrder.length > 0 || reconciledGroups[index].tabOrder.length === 0
        )
      : nextGroupsWithEmpty
  const groupsChanged =
    prunedGroups.length !== groups.length ||
    prunedGroups.some((group, index) => group !== groups[index])
  const nextGroups = groupsChanged ? prunedGroups : groups
  const currentActiveGroupId =
    state.activeGroupIdByWorktree[worktreeId] ??
    ensuredGroupState?.activeGroupIdByWorktree[worktreeId]
  const activeGroupStillExists = nextGroups.some((group) => group.id === currentActiveGroupId)
  const nextActiveGroupId = activeGroupStillExists
    ? currentActiveGroupId
    : (nextGroups.find((group) => group.activeTabId !== null)?.id ??
      nextGroups[0]?.id ??
      currentActiveGroupId)
  const tabsChanged = validTabs !== unifiedTabs
  const activeGroupChanged = nextActiveGroupId !== currentActiveGroupId
  const baseNextLayout =
    restoredLegacyTabs.length > 0 && reconciliationGroup
      ? (state.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: reconciliationGroup.id })
      : state.layoutByWorktree[worktreeId]
  const validGroupIds = new Set(nextGroups.map((group) => group.id))
  const prunedNextLayout =
    baseNextLayout && validGroupIds.size > 0
      ? pruneTabGroupLayoutForGroups(baseNextLayout, validGroupIds)
      : baseNextLayout
  const nextLayout =
    prunedNextLayout ?? (nextGroups[0] ? { type: 'leaf', groupId: nextGroups[0].id } : undefined)
  const currentLayout = state.layoutByWorktree[worktreeId]
  const layoutChanged = nextLayout !== currentLayout
  let patch: Partial<AppState> = {}

  if (
    tabsChanged ||
    groupsChanged ||
    activeGroupChanged ||
    layoutChanged ||
    orphanTerminalIds.size > 0
  ) {
    const droppedTerminalEntityIds = unifiedTabs.flatMap((tab) =>
      tab.contentType === 'terminal' && !validTabIds.has(tab.id) ? [tab.entityId] : []
    )
    let nextUnreadTerminalTabs = state.unreadTerminalTabs
    if (droppedTerminalEntityIds.length > 0) {
      // A batch that already owns this map published it in an earlier patch, so
      // draining further entries in place needs no second patch entry.
      const owned = batch?.ownedStateKeys.has('unreadTerminalTabs') === true
      const copy = owned ? state.unreadTerminalTabs : { ...state.unreadTerminalTabs }
      let changed = false
      for (const entityId of droppedTerminalEntityIds) {
        if (copy[entityId]) {
          delete copy[entityId]
          changed = true
        }
      }
      if (changed) {
        nextUnreadTerminalTabs = copy
        batch?.ownedStateKeys.add('unreadTerminalTabs')
      }
    }
    patch = {
      unifiedTabsByWorktree: writeBatchedWorkspaceRecordEntry(
        state.unifiedTabsByWorktree,
        'unifiedTabsByWorktree',
        worktreeId,
        validTabs,
        batch
      ),
      groupsByWorktree: writeBatchedWorkspaceRecordEntry(
        state.groupsByWorktree,
        'groupsByWorktree',
        worktreeId,
        nextGroups,
        batch
      ),
      activeGroupIdByWorktree: writeBatchedWorkspaceRecordEntry(
        state.activeGroupIdByWorktree,
        'activeGroupIdByWorktree',
        worktreeId,
        nextActiveGroupId,
        batch
      ),
      ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
        ? { unreadTerminalTabs: nextUnreadTerminalTabs }
        : {}),
      ...(nextLayout && layoutChanged
        ? {
            // Why: restored runtime terminals need a concrete leaf before activation.
            layoutByWorktree: writeBatchedWorkspaceRecordEntry(
              state.layoutByWorktree,
              'layoutByWorktree',
              worktreeId,
              nextLayout,
              batch
            )
          }
        : {}),
      ...(orphanTerminalIds.size > 0
        ? buildOrphanTerminalCleanupPatch(state, worktreeId, orphanTerminalIds)
        : {})
    }
  }

  return {
    patch,
    renderableTabCount: validTabs.length,
    activeRenderableTabId:
      nextGroups.find((group) => group.id === nextActiveGroupId)?.activeTabId ??
      nextGroups.find((group) => group.activeTabId !== null)?.activeTabId ??
      null
  }
}
